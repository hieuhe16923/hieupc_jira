import type { WorkSchedule } from './types';

// Mọi tính toán dùng "giờ tường" (wall-clock) — không phụ thuộc múi giờ của máy chạy.
// Chuỗi vào: "YYYY-MM-DD", "YYYY-MM-DD HH:mm", "YYYY-MM-DDTHH:mm[:ss]".

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const MINUTES_PER_DAY = 1440;
const MAX_RANGE_DAYS = 3660;

interface WallTime {
  /** Số ngày kể từ 1970-01-01 */
  day: number;
  /** Phút trong ngày */
  minute: number;
  dateOnly: boolean;
}

export function parseWallTime(value: string): WallTime | null {
  const m = DATETIME_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const year = Number(y);
  const month = Number(mo);
  const date = Number(d);
  const utc = Date.UTC(year, month - 1, date);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
    return null;
  }
  const hour = h === undefined ? 0 : Number(h);
  const minute = mi === undefined ? 0 : Number(mi);
  if (hour > 23 || minute > 59) return null;
  return { day: Math.floor(utc / 86_400_000), minute: hour * 60 + minute, dateOnly: h === undefined };
}

/**
 * Quy đổi thời điểm wall-clock ra số phút tuyệt đối để so sánh.
 * `endOfDay` = true: chuỗi chỉ có ngày được hiểu là cuối ngày (dùng cho To).
 */
export function wallTimeToMinutes(value: string, endOfDay = false): number | null {
  const wt = parseWallTime(value);
  if (!wt) return null;
  return wt.day * MINUTES_PER_DAY + (wt.dateOnly && endOfDay ? MINUTES_PER_DAY : wt.minute);
}

function hmToMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= MINUTES_PER_DAY ? v : null;
}

function dayToIso(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

export function isWorkingDay(isoDate: string, schedule: WorkSchedule): boolean {
  const wt = parseWallTime(isoDate);
  if (!wt) return false;
  return isWorkingDayIndex(wt.day, schedule, new Set(schedule.holidays));
}

function isWorkingDayIndex(day: number, schedule: WorkSchedule, holidays: Set<string>): boolean {
  const weekday = new Date(day * 86_400_000).getUTCDay();
  return schedule.workingWeekdays.includes(weekday) && !holidays.has(dayToIso(day));
}

/**
 * Tổng số phút làm việc trong khoảng [from, to].
 * - Chỉ tính phần giao với các khung giờ làm việc.
 * - Bỏ ngày không làm việc (T7, CN theo cấu hình) và ngày nghỉ.
 * - `to` chỉ có ngày (không giờ) → tính hết ngày đó.
 */
export function workingMinutesBetween(from: string, to: string, schedule: WorkSchedule): number {
  const a = parseWallTime(from);
  const b = parseWallTime(to);
  if (!a || !b) return 0;
  const start = a.day * MINUTES_PER_DAY + a.minute;
  const end = b.day * MINUTES_PER_DAY + (b.dateOnly ? MINUTES_PER_DAY : b.minute);
  if (end <= start) return 0;
  if (b.day - a.day > MAX_RANGE_DAYS) return 0;

  const windows = schedule.windows
    .map((w) => [hmToMinutes(w.start), hmToMinutes(w.end)] as const)
    .filter((w): w is readonly [number, number] => w[0] !== null && w[1] !== null && w[1] > w[0]);
  const holidays = new Set(schedule.holidays);

  let total = 0;
  for (let day = a.day; day <= b.day; day++) {
    if (!isWorkingDayIndex(day, schedule, holidays)) continue;
    const base = day * MINUTES_PER_DAY;
    for (const [ws, we] of windows) {
      const lo = Math.max(start, base + ws);
      const hi = Math.min(end, base + we);
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

export interface DaySegment {
  /** YYYY-MM-DD */
  date: string;
  /** Phút trong ngày của thời điểm làm việc đầu tiên (trong khoảng [from, to]) */
  firstMinute: number;
  /** Số phút làm việc của ngày đó nằm trong [from, to] */
  minutes: number;
}

/** Giờ làm việc trong [from, to] tách theo từng ngày (chỉ ngày có giờ làm việc > 0). */
export function dailyWorkingSegments(from: string, to: string, schedule: WorkSchedule): DaySegment[] {
  const a = parseWallTime(from);
  const b = parseWallTime(to);
  if (!a || !b) return [];
  const start = a.day * MINUTES_PER_DAY + a.minute;
  const end = b.day * MINUTES_PER_DAY + (b.dateOnly ? MINUTES_PER_DAY : b.minute);
  if (end <= start || b.day - a.day > MAX_RANGE_DAYS) return [];

  const windows = schedule.windows
    .map((w) => [hmToMinutes(w.start), hmToMinutes(w.end)] as const)
    .filter((w): w is readonly [number, number] => w[0] !== null && w[1] !== null && w[1] > w[0])
    .sort((x, y) => x[0] - y[0]);
  const holidays = new Set(schedule.holidays);
  const out: DaySegment[] = [];
  for (let day = a.day; day <= b.day; day++) {
    if (!isWorkingDayIndex(day, schedule, holidays)) continue;
    const base = day * MINUTES_PER_DAY;
    let minutes = 0;
    let first: number | null = null;
    for (const [ws, we] of windows) {
      const lo = Math.max(start, base + ws);
      const hi = Math.min(end, base + we);
      if (hi > lo) {
        minutes += hi - lo;
        first ??= lo - base;
      }
    }
    if (minutes > 0) out.push({ date: dayToIso(day), firstMinute: first!, minutes });
  }
  return out;
}

/** Định dạng phút → chuỗi Jira "1d 4h 30m" (1d = hoursPerDay giờ). */
export function formatJiraDuration(totalMinutes: number, hoursPerDay = 8): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  if (minutes === 0) return '0m';
  const perDay = hoursPerDay * 60;
  const d = Math.floor(minutes / perDay);
  const h = Math.floor((minutes % perDay) / 60);
  const m = minutes % 60;
  return [d ? `${d}d` : '', h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ');
}

/** Parse chuỗi Jira "1w 2d 3h 30m" / "1.5h" → phút. Sai định dạng → null. */
export function parseJiraDuration(value: string, hoursPerDay = 8, daysPerWeek = 5): number | null {
  const s = value.trim().toLowerCase();
  if (!s) return null;
  const unit: Record<string, number> = {
    w: daysPerWeek * hoursPerDay * 60,
    d: hoursPerDay * 60,
    h: 60,
    m: 1,
  };
  const re = /(\d+(?:[.,]\d+)?)\s*([wdhm])/g;
  let total = 0;
  let consumed = '';
  for (const match of s.matchAll(re)) {
    total += parseFloat(match[1]!.replace(',', '.')) * unit[match[2]!]!;
    consumed += match[0];
  }
  if (!consumed || consumed.replace(/\s/g, '') !== s.replace(/\s/g, '')) return null;
  return Math.round(total);
}

export interface EstimateResult {
  minutes: number;
  /** Chuỗi gửi lên timetracking.originalEstimate */
  jira: string;
  hours: number;
}

export function estimateFromRange(from: string, to: string, schedule: WorkSchedule): EstimateResult {
  const minutes = workingMinutesBetween(from, to, schedule);
  return {
    minutes,
    jira: formatJiraDuration(minutes, schedule.hoursPerDay),
    hours: Math.round((minutes / 60) * 100) / 100,
  };
}

/** "2026-11-10 08:00" + "+07:00" → "2026-11-10T08:00:00.000+0700" (định dạng Jira chấp nhận) */
export function toJiraDateTime(value: string, utcOffset = '+07:00'): string | null {
  const wt = parseWallTime(value);
  if (!wt) return null;
  const date = dayToIso(wt.day);
  const hh = String(Math.floor(wt.minute / 60)).padStart(2, '0');
  const mm = String(wt.minute % 60).padStart(2, '0');
  return `${date}T${hh}:${mm}:00.000${utcOffset.replace(':', '')}`;
}

/** "2026-11-10 08:00" → "2026-11-10" */
export function toJiraDate(value: string): string | null {
  const wt = parseWallTime(value);
  return wt ? dayToIso(wt.day) : null;
}
