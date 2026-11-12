import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_SETTINGS, type TimesheetResponse } from '@jpw/shared';
import { buildApp } from '../app';
import { SettingsStore } from '../settings/store';
import { rangeDays, timesheetJql, todayInOffset } from '../jira/timesheet.service';

const BASE = 'https://jira.test.local';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const me = { accountId: 'me', displayName: 'Tôi' };
const other = { accountId: 'x', displayName: 'Người khác' };
const wl = (id: string, started: string, hours: number, author = me, comment?: string) => ({
  id,
  started: `${started}T08:00:00.000+0700`,
  timeSpentSeconds: hours * 3600,
  author,
  comment,
});
const issue = (key: string, extra: Record<string, unknown> = {}) => ({
  id: key,
  key,
  fields: {
    summary: `Việc ${key}`,
    issuetype: { id: '5', name: 'Sub-task', subtask: true },
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    parent: { key: 'PS-1' },
    customfield_10015: '2026-10-05T08:00:00.000+0700',
    duedate: '2026-10-09',
    ...extra,
  },
});

// Tuần 05/10 (T2) → 11/10 (CN)
const worklogs: Record<string, ReturnType<typeof wl>[]> = {
  'PS-10': [
    wl('1', '2026-10-05', 8, me, 'Phân tích'),
    wl('2', '2026-10-06', 4),
    wl('3', '2026-10-06', 2, other), // người khác → không tính vào timesheet của tôi
    wl('4', '2026-09-30', 8), // ngoài kỳ
  ],
  'PS-11': [wl('5', '2026-10-06', 3), wl('6', '2026-10-07', 10), wl('7', '2026-10-10', 2)],
  'PS-12': [wl('8', '2026-10-20', 8)], // JQL trả về nhưng không có log của tôi trong kỳ → ẩn
};
const searched: string[] = [];

function fakeJira(url: string): Response {
  const u = new URL(url);
  switch (u.pathname) {
    case '/rest/api/2/myself':
      return json({ ...me, emailAddress: 'me@x' });
    case '/rest/api/2/serverInfo':
      return json({ version: '1001', deploymentType: 'Cloud' });
    case '/rest/api/2/field':
      return json([
        { id: 'customfield_10015', name: 'Start date', custom: true, schema: { type: 'datetime' } },
      ]);
    case '/rest/api/2/search/jql': {
      searched.push(u.searchParams.get('jql')!);
      // 2 trang
      return u.searchParams.get('nextPageToken')
        ? json({ issues: [issue('PS-12')], isLast: true })
        : json({
            issues: [
              issue('PS-11', {
                timetracking: {
                  originalEstimateSeconds: 15 * 3600,
                  timeSpentSeconds: 15 * 3600,
                  remainingEstimateSeconds: 0,
                },
                duedate: '2026-10-10',
              }),
              issue('PS-10', {
                timetracking: { originalEstimateSeconds: 16 * 3600, timeSpentSeconds: 22 * 3600 },
              }),
            ],
            nextPageToken: 'p2',
          });
    }
  }
  const m = /^\/rest\/api\/2\/issue\/(PS-\d+)\/worklog$/.exec(u.pathname);
  if (m) {
    const all = worklogs[m[1]!] ?? [];
    // phân trang 2 worklog / trang
    const startAt = Number(u.searchParams.get('startAt') ?? 0);
    return json({ startAt, total: all.length, worklogs: all.slice(startAt, startAt + 2) });
  }
  return json({ errorMessages: ['not found'] }, 404);
}

describe('Timesheet', () => {
  let app: FastifyInstance;
  let cookies: Record<string, string>;

  beforeEach(async () => {
    searched.length = 0;
    vi.stubGlobal('fetch', (input: string | URL | Request) => Promise.resolve(fakeJira(String(input))));
    app = await buildApp({
      allowedHosts: new Set(['jira.test.local']),
      settings: new SettingsStore(mkdtempSync(path.join(tmpdir(), 'jpw-'))),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 't', baseUrl: BASE },
    });
    cookies = { jpw_sid: res.cookies.find((c) => c.name === 'jpw_sid')!.value };
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  it('chỉ tính log của tôi trong kỳ, tổng theo issue/ngày, ngày thiếu/vượt giờ, quy tắc log work', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/worklog/timesheet?from=2026-10-05&to=2026-10-11',
      cookies,
    });
    expect(res.statusCode).toBe(200);
    const t = res.json<TimesheetResponse>();
    expect(searched[0]).toBe(timesheetJql('2026-10-05', '2026-10-11'));
    expect(t.issues.map((i) => i.key)).toEqual(['PS-10', 'PS-11']); // PS-12 ẩn, sắp theo key
    expect(t.issues[0]).toMatchObject({
      byDay: { '2026-10-05': 480, '2026-10-06': 240 },
      minutes: 720,
      estimate: '2d',
      spentMinutes: 1320,
    });
    expect(t.issues[0]!.worklogs.map((w) => w.id)).toEqual(['1', '2']);
    expect(t.issues[0]!.ruleIssues).toEqual([
      'Tổng log work 2d 6h ≠ Estimate 2d',
      'Log work ngoài khoảng Start date → Due date: 2026-09-30',
    ]);
    expect(t.issues[1]).toMatchObject({ minutes: 900, ruleIssues: [] });
    expect(t.days.map((d) => d.minutes / 60)).toEqual([8, 7, 10, 0, 0, 2, 0]);
    expect(t.days.map((d) => d.working)).toEqual([true, true, true, true, true, false, false]);
    expect(t.totalMinutes).toBe(27 * 60);
    expect(t.expectedMinutes).toBe(5 * 8 * 60);
    expect(t.shortDays).toEqual([
      { date: '2026-10-06', minutes: 420 },
      { date: '2026-10-08', minutes: 0 },
      { date: '2026-10-09', minutes: 0 },
    ]);
    expect(t.overDays).toEqual([{ date: '2026-10-07', minutes: 600 }]);
  });

  it('xuất Excel: 3 sheet, tổng khớp, có chi tiết từng worklog', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/worklog/timesheet.xlsx?from=2026-10-05&to=2026-10-11',
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('timesheet-2026-10-05_2026-10-11.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Tổng hợp', 'Timesheet', 'Chi tiết']);
    const ws = wb.getWorksheet('Timesheet')!;
    expect(ws.getCell('A2').text).toBe('PS-10');
    expect(ws.getCell('H2').value).toBe(8); // 05/10
    const total = ws.getRow(4);
    expect(total.getCell(1).value).toBe('TỔNG');
    expect(total.getCell(7 + 7 + 1).value).toBe(27);
    expect(wb.getWorksheet('Chi tiết')!.rowCount).toBe(1 + 5);
    expect(wb.getWorksheet('Tổng hợp')!.getCell('B3').value).toBe(27);
  });

  it('kiểm tra khoảng ngày', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: '/api/worklog/timesheet?from=2026-10-10&to=2026-10-01',
      cookies,
    });
    expect(bad.statusCode).toBe(400);
    const long = await app.inject({
      method: 'GET',
      url: '/api/worklog/timesheet?from=2026-01-01&to=2026-12-31',
      cookies,
    });
    expect(long.json().message).toMatch(/tối đa 93 ngày/);
  });
});

describe('helpers', () => {
  it('todayInOffset theo múi giờ', () => {
    const now = new Date('2026-11-10T18:30:00Z');
    expect(todayInOffset('+07:00', now)).toBe('2026-11-11');
    expect(todayInOffset('+00:00', now)).toBe('2026-11-10');
  });

  it('rangeDays: ngày nghỉ trong Settings không tính là ngày làm việc', () => {
    const s = {
      ...DEFAULT_SETTINGS,
      workSchedule: { ...DEFAULT_SETTINGS.workSchedule, holidays: ['2026-10-06'] },
    };
    expect(rangeDays('2026-10-05', '2026-10-07', s).map((d) => d.working)).toEqual([true, false, true]);
  });
});
