import {
  checkWorklogRules,
  formatJiraDuration,
  parseWallTime,
  type DeploymentType,
  type DetectFieldsResponse,
  type JiraUser,
  type Settings,
  type TimesheetDay,
  type TimesheetIssue,
  type TimesheetResponse,
} from '@jpw/shared';
import type { JiraClient } from './client';
import { AppError } from './errors';
import { mapIssueType } from './issue.service';
import { mapWorklogs, toWall } from './my-issues.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- dữ liệu thô từ Jira REST */
type RawIssue = { id: string; key: string; fields: Record<string, any> };

export const MAX_TIMESHEET_DAYS = 93;
const MAX_ISSUES = 500;
const PAGE = 100;

export interface TimesheetContext {
  settings: Settings;
  fieldIds: DetectFieldsResponse;
  deploymentType: DeploymentType;
  user: JiraUser;
  /** Hôm nay (YYYY-MM-DD) — để không tính "thiếu giờ" cho ngày tương lai */
  today: string;
}

/** Hôm nay theo múi giờ trong Settings (VD "+07:00") */
export function todayInOffset(utcOffset: string, now = new Date()): string {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(utcOffset);
  const offsetMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(now.getTime() + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** Danh sách ngày [from, to] kèm cờ ngày làm việc */
export function rangeDays(from: string, to: string, settings: Settings): TimesheetDay[] {
  const a = parseWallTime(from);
  const b = parseWallTime(to);
  if (!a || !b || b.day < a.day)
    throw new AppError(400, 'BAD_RANGE', 'Khoảng ngày không hợp lệ (Từ phải trước hoặc bằng Đến).');
  if (b.day - a.day + 1 > MAX_TIMESHEET_DAYS) {
    throw new AppError(400, 'RANGE_TOO_LONG', `Khoảng ngày tối đa ${MAX_TIMESHEET_DAYS} ngày.`);
  }
  const holidays = new Set(settings.workSchedule.holidays);
  const out: TimesheetDay[] = [];
  for (let d = a.day; d <= b.day; d++) {
    const date = new Date(d * 86_400_000).toISOString().slice(0, 10);
    const weekday = new Date(d * 86_400_000).getUTCDay();
    out.push({
      date,
      weekday,
      working: settings.workSchedule.workingWeekdays.includes(weekday) && !holidays.has(date),
      minutes: 0,
    });
  }
  return out;
}

export function timesheetJql(from: string, to: string): string {
  return `worklogAuthor = currentUser() AND worklogDate >= "${from}" AND worklogDate <= "${to}" ORDER BY updated DESC`;
}

export class TimesheetService {
  async build(
    client: JiraClient,
    from: string,
    to: string,
    ctx: TimesheetContext,
  ): Promise<TimesheetResponse> {
    const days = rangeDays(from, to, ctx.settings);
    const hpd = ctx.settings.workSchedule.hoursPerDay;
    const jql = timesheetJql(from, to);
    const warnings: string[] = [];
    const found = await this.search(client, jql, ctx);
    if (found.more)
      warnings.push(`Có hơn ${MAX_ISSUES} issue — chỉ hiển thị ${MAX_ISSUES} issue cập nhật gần nhất`);

    const issues = await mapLimit(found.issues, 6, (raw) => this.issueRow(client, raw, from, to, ctx));
    const shown = issues
      .filter((i) => i.minutes > 0)
      .sort((x, y) => x.key.localeCompare(y.key, 'en', { numeric: true }));

    const byDate = new Map(days.map((d) => [d.date, d]));
    for (const i of shown) for (const [date, m] of Object.entries(i.byDay)) byDate.get(date)!.minutes += m;

    const perDay = hpd * 60;
    // Chỉ tính các ngày đã qua (hôm nay chưa hết ngày → không báo thiếu)
    const past = days.filter((d) => d.date < ctx.today);
    const shortDays = past
      .filter((d) => d.working && d.minutes < perDay)
      .map(({ date, minutes }) => ({ date, minutes }));
    const overDays = days.filter((d) => d.minutes > perDay).map(({ date, minutes }) => ({ date, minutes }));
    const totalMinutes = days.reduce((s, d) => s + d.minutes, 0);

    return {
      from,
      to,
      jql,
      days,
      issues: shown,
      totalMinutes,
      expectedMinutes: past.filter((d) => d.working).length * perDay,
      shortDays,
      overDays,
      hoursPerDay: hpd,
      warnings,
    };
  }

  private fields(ctx: TimesheetContext): string[] {
    return [
      'summary',
      'issuetype',
      'status',
      'parent',
      'timetracking',
      'duedate',
      ctx.fieldIds.startDate?.id,
    ].filter((x): x is string => Boolean(x));
  }

  private async search(
    client: JiraClient,
    jql: string,
    ctx: TimesheetContext,
  ): Promise<{ issues: RawIssue[]; more: boolean }> {
    const fields = this.fields(ctx);
    const issues: RawIssue[] = [];
    if (ctx.deploymentType === 'Cloud') {
      let token: string | undefined;
      let more = false;
      do {
        const res = await client.get<{ issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean }>(
          '/rest/api/2/search/jql',
          { jql, fields: fields.join(','), maxResults: PAGE, nextPageToken: token },
        );
        issues.push(...(res.issues ?? []));
        token = res.nextPageToken;
        more = Boolean(token) && !res.isLast;
      } while (more && issues.length < MAX_ISSUES);
      return { issues: issues.slice(0, MAX_ISSUES), more };
    }
    let total = 0;
    for (let startAt = 0; startAt < MAX_ISSUES; startAt += PAGE) {
      const res = await client.post<{ issues?: RawIssue[]; total?: number }>('/rest/api/2/search', {
        jql,
        fields,
        startAt,
        maxResults: PAGE,
      });
      issues.push(...(res.issues ?? []));
      total = res.total ?? issues.length;
      if (!res.issues?.length || issues.length >= total) break;
    }
    return { issues: issues.slice(0, MAX_ISSUES), more: total > MAX_ISSUES };
  }

  /** Toàn bộ worklog của issue (có phân trang) */
  private async worklogs(client: JiraClient, key: string): Promise<any[]> {
    const all: any[] = [];
    for (let startAt = 0, page = 0; page < 20; page++) {
      const res = await client.get<{ worklogs?: any[]; total?: number; maxResults?: number }>(
        `/rest/api/2/issue/${encodeURIComponent(key)}/worklog`,
        { startAt, maxResults: 1000 },
      );
      const list = res.worklogs ?? [];
      all.push(...list);
      startAt += list.length;
      if (!list.length || res.total === undefined || startAt >= res.total) break;
    }
    return all;
  }

  private async issueRow(
    client: JiraClient,
    raw: RawIssue,
    from: string,
    to: string,
    ctx: TimesheetContext,
  ): Promise<TimesheetIssue> {
    const f = raw.fields;
    const hpd = ctx.settings.workSchedule.hoursPerDay;
    const all = mapWorklogs(await this.worklogs(client, raw.key), ctx.user);
    const mine = all.filter((w) => w.mine && w.date >= from && w.date <= to);
    const byDay: Record<string, number> = {};
    for (const w of mine) byDay[w.date] = (byDay[w.date] ?? 0) + w.minutes;
    const tt = f.timetracking ?? {};
    const estimateMinutes =
      tt.originalEstimateSeconds !== undefined ? Math.round(tt.originalEstimateSeconds / 60) : undefined;
    const startDate = ctx.fieldIds.startDate ? toWall(f[ctx.fieldIds.startDate.id]) : undefined;
    const due = toWall(f.duedate);
    return {
      key: raw.key,
      url: `${client.baseUrl}/browse/${raw.key}`,
      summary: f.summary ?? '',
      issueType: mapIssueType(f.issuetype),
      status: { name: f.status?.name ?? '', category: f.status?.statusCategory?.key },
      parentKey: f.parent?.key,
      from: startDate,
      to: due,
      estimate: estimateMinutes !== undefined ? formatJiraDuration(estimateMinutes, hpd) : undefined,
      estimateMinutes,
      spentMinutes: Math.round(
        Number(tt.timeSpentSeconds ?? all.reduce((s, w) => s + w.minutes * 60, 0)) / 60,
      ),
      remaining:
        tt.remainingEstimateSeconds !== undefined
          ? formatJiraDuration(Math.round(tt.remainingEstimateSeconds / 60), hpd)
          : undefined,
      byDay,
      minutes: mine.reduce((s, w) => s + w.minutes, 0),
      worklogs: mine,
      ruleIssues: checkWorklogRules({
        estimateMinutes,
        startDate,
        dueDate: due,
        worklogs: all,
        hoursPerDay: hpd,
      }),
    };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}
