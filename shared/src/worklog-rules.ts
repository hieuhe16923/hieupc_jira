import type { WorkSchedule, WorklogPlanItem } from './types';
import { dailyWorkingSegments, formatJiraDuration, parseWallTime } from './work-hours';

// Quy tắc: Estimate = tổng thời gian log work; mọi worklog nằm trong khoảng Start date → Due date.

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Lập kế hoạch log work: mỗi ngày làm việc trong [from, to] một worklog,
 * bắt đầu tại giờ làm việc đầu tiên của ngày, thời lượng = giờ làm việc của ngày đó.
 * Nếu `totalMinutes` (Estimate nhập tay) khác tổng giờ làm việc → chia lại theo tỉ lệ,
 * phần lẻ dồn vào ngày cuối để tổng luôn đúng bằng `totalMinutes`.
 */
export function planWorklogs(
  from: string,
  to: string,
  schedule: WorkSchedule,
  totalMinutes?: number,
): WorklogPlanItem[] {
  const segs = dailyWorkingSegments(from, to, schedule);
  const available = segs.reduce((s, x) => s + x.minutes, 0);
  if (!available) return [];
  const target = totalMinutes === undefined ? available : Math.max(0, Math.round(totalMinutes));
  if (!target) return [];

  let assigned = 0;
  const items = segs.map((s, i) => {
    const minutes = i === segs.length - 1 ? target - assigned : Math.floor((s.minutes * target) / available);
    assigned += minutes;
    return {
      date: s.date,
      start: `${s.date} ${pad(Math.floor(s.firstMinute / 60))}:${pad(s.firstMinute % 60)}`,
      minutes,
    };
  });
  return items.filter((x) => x.minutes > 0);
}

export interface WorklogCheckInput {
  /** Original estimate (phút); undefined = issue chưa có estimate */
  estimateMinutes?: number;
  /** Start date / Due date của issue (YYYY-MM-DD hoặc có giờ) */
  startDate?: string;
  dueDate?: string;
  worklogs: { date: string; minutes: number }[];
  hoursPerDay?: number;
}

/** Kiểm tra quy tắc log work, trả về danh sách vi phạm (rỗng = hợp lệ). */
export function checkWorklogRules(input: WorklogCheckInput): string[] {
  const hpd = input.hoursPerDay ?? 8;
  const fmt = (m: number) => formatJiraDuration(m, hpd);
  const issues: string[] = [];
  const total = input.worklogs.reduce((s, w) => s + w.minutes, 0);

  if (input.estimateMinutes === undefined) {
    if (total > 0) issues.push(`Chưa có Estimate nhưng đã log ${fmt(total)}`);
  } else if (total !== input.estimateMinutes) {
    issues.push(`Tổng log work ${fmt(total)} ≠ Estimate ${fmt(input.estimateMinutes)}`);
  }

  const day = (v?: string) => (v ? (parseWallTime(v)?.day ?? null) : null);
  const lo = day(input.startDate);
  const hi = day(input.dueDate);
  if (input.worklogs.length && (lo === null || hi === null)) {
    issues.push('Issue thiếu Start date hoặc Due date để đối chiếu ngày log work');
  }
  const outside = input.worklogs
    .filter((w) => {
      const d = day(w.date);
      return d !== null && ((lo !== null && d < lo) || (hi !== null && d > hi));
    })
    .map((w) => w.date.slice(0, 10));
  if (outside.length) {
    issues.push(`Log work ngoài khoảng Start date → Due date: ${[...new Set(outside)].join(', ')}`);
  }
  return issues;
}

export interface WorklogEntryCheck {
  /** Start date / Due date / Estimate hiện tại của issue và các worklog đã có */
  issue: {
    from?: string;
    to?: string;
    estimateMinutes?: number;
    worklogs: { id: string; minutes: number }[];
  };
  /** YYYY-MM-DD */
  date: string;
  minutes: number;
  /** Đang sửa worklog này → không cộng phần cũ */
  excludeId?: string;
  hoursPerDay?: number;
}

/**
 * Kiểm tra 1 worklog trước khi ghi (chặn): ngày log phải nằm trong Start date → Due date.
 * Vượt Estimate KHÔNG bị chặn — xem estimateAfterLog (Estimate được nâng = tổng log).
 */
export function validateWorklogEntry(input: WorklogEntryCheck): string[] {
  const errors: string[] = [];
  if (!(input.minutes > 0)) errors.push('Thời gian log phải > 0');

  const d = parseWallTime(input.date)?.day;
  const lo = input.issue.from ? parseWallTime(input.issue.from)?.day : undefined;
  const hi = input.issue.to ? parseWallTime(input.issue.to)?.day : undefined;
  if (d === undefined) errors.push(`Ngày log không hợp lệ: "${input.date}"`);
  else if (lo === undefined || hi === undefined) {
    errors.push('Issue chưa có Start date hoặc Due date → đặt From/To trước khi log work');
  } else if (d < lo || d > hi) {
    errors.push(
      `Ngày log ${input.date} nằm ngoài Start date → Due date (${input.issue.from!.slice(0, 10)} → ${input.issue.to!.slice(0, 10)})`,
    );
  }

  return errors;
}

/**
 * Estimate mới sau khi log: nếu tổng log > Estimate (hoặc chưa có Estimate) → Estimate = tổng log.
 * Trả về undefined nếu không cần đổi.
 */
export function estimateAfterLog(
  estimateMinutes: number | undefined,
  totalLogged: number,
): number | undefined {
  if (totalLogged <= 0) return undefined;
  if (estimateMinutes === undefined || totalLogged > estimateMinutes) return totalLogged;
  return undefined;
}

export interface WorklogDay {
  /** YYYY-MM-DD */
  date: string;
  /** 0 = CN … 6 = T7 */
  weekday: number;
  working: boolean;
  /** Giờ bắt đầu mặc định khi tạo worklog ngày này (HH:mm) */
  start: string;
  /** Giờ làm việc trong [from, to] của ngày (phút) – dùng cho "Điền theo giờ làm việc" */
  workMinutes: number;
}

const MAX_LOG_DAYS = 93;

/** Tất cả các ngày từ From đến To (kể cả T7/CN) để log theo ngày */
export function worklogDays(from: string, to: string, schedule: WorkSchedule): WorklogDay[] {
  const a = parseWallTime(from);
  const b = parseWallTime(to);
  if (!a || !b || b.day < a.day || b.day - a.day >= MAX_LOG_DAYS) return [];
  const segs = new Map(dailyWorkingSegments(from, to, schedule).map((s) => [s.date, s]));
  const holidays = new Set(schedule.holidays);
  const firstWindow = schedule.windows[0]?.start ?? '08:00';
  const out: WorklogDay[] = [];
  for (let day = a.day; day <= b.day; day++) {
    const date = new Date(day * 86_400_000).toISOString().slice(0, 10);
    const weekday = new Date(day * 86_400_000).getUTCDay();
    const seg = segs.get(date);
    out.push({
      date,
      weekday,
      working: schedule.workingWeekdays.includes(weekday) && !holidays.has(date),
      start: seg ? `${pad(Math.floor(seg.firstMinute / 60))}:${pad(seg.firstMinute % 60)}` : firstWindow,
      workMinutes: seg?.minutes ?? 0,
    });
  }
  return out;
}
