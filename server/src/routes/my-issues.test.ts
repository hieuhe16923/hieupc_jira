import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_SETTINGS, type MyIssue } from '@jpw/shared';
import { buildApp } from '../app';
import { buildMyIssuesJql, buildUpdateFields } from '../jira/my-issues.service';
import { SettingsStore } from '../settings/store';

const BASE = 'https://jira.test.local';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const calls: { method: string; path: string; body?: unknown; query: URLSearchParams }[] = [];
let linkedIssuesSupported = true;

interface Log {
  id: string;
  started: string;
  timeSpentSeconds: number;
  author: { name: string; displayName: string };
  comment?: string;
}
const initialLog = (): Log => ({
  id: '9',
  started: '2026-11-10T08:00:00.000+0700',
  timeSpentSeconds: 28800,
  author: { name: 'jdoe', displayName: 'John' },
  comment: 'Phân tích',
});
// Trạng thái Jira giả lập (reset mỗi test)
const state = { estimateSec: 57600, logs: [initialLog()], nextId: 10 };

const subIssue = () => {
  const spent = state.logs.reduce((t, l) => t + l.timeSpentSeconds, 0);
  return {
    id: '2',
    key: 'ABC-200',
    fields: {
      summary: 'Sub cũ',
      issuetype: { id: '5', name: 'Sub-task BE', subtask: true },
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      parent: { key: 'ABC-123' },
      labels: ['SQ1'],
      components: [{ id: '100', name: 'Backend' }],
      priority: { id: '3', name: 'Medium' },
      duedate: '2026-11-11',
      customfield_10015: '2026-11-10T08:00:00.000+0700',
      customfield_10200: { id: '201', value: 'BE' },
      timetracking: {
        originalEstimateSeconds: state.estimateSec,
        timeSpentSeconds: spent,
        remainingEstimateSeconds: Math.max(0, state.estimateSec - spent),
      },
      worklog: { total: state.logs.length, worklogs: state.logs },
    },
  };
};

const toSec = (d: string) =>
  [...d.matchAll(/(\d+)([dhm])/g)].reduce(
    (t, m) => t + Number(m[1]) * ({ d: 28800, h: 3600, m: 60 } as Record<string, number>)[m[2]!]!,
    0,
  );

function fakeJira(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method: init?.method ?? 'GET', path: u.pathname, body, query: u.searchParams });
  const wl = /^\/rest\/api\/2\/issue\/ABC-200\/worklog\/(\d+)$/.exec(u.pathname);
  if (wl) {
    const i = state.logs.findIndex((l) => l.id === wl[1]);
    if (i < 0) return json({ errorMessages: ['not found'] }, 404);
    if (init?.method === 'DELETE') {
      state.logs.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    Object.assign(state.logs[i]!, body);
    return json({ id: wl[1] });
  }
  switch (u.pathname) {
    case '/rest/api/2/myself':
      return json({ name: 'jdoe', displayName: 'John' });
    case '/rest/api/2/serverInfo':
      return json({ version: '9.12.0', deploymentType: 'Server' });
    case '/rest/api/2/field':
      return json([
        { id: 'customfield_10200', name: 'Role of Work', custom: true, schema: { type: 'option' } },
        { id: 'customfield_10015', name: 'Start date', custom: true, schema: { type: 'datetime' } },
      ]);
    case '/rest/api/2/issue/ABC-123':
      return json({
        id: '1',
        key: 'ABC-123',
        fields: {
          summary: 'Story',
          status: { name: 'To Do' },
          project: { id: '10', key: 'ABC', name: 'Alpha' },
          issuetype: { id: '7', name: 'Story', subtask: false },
        },
      });
    case '/rest/api/2/search':
      if (!linkedIssuesSupported && String(body.jql).includes('linkedIssues'))
        return json({ errorMessages: ['Unknown function linkedIssues'] }, 400);
      return json({ issues: [subIssue()], total: 1 });
    case '/rest/api/2/issue/ABC-200':
      if (init?.method === 'PUT') {
        const tt = body.fields?.timetracking;
        if (tt?.originalEstimate) state.estimateSec = toSec(tt.originalEstimate);
        return new Response(null, { status: 204 });
      }
      return json(subIssue());
    case '/rest/api/2/issue/ABC-200/worklog': {
      const id = String(state.nextId++);
      state.logs.push({ id, ...body, author: { name: 'jdoe', displayName: 'John' } });
      return json({ id }, 201);
    }
    case '/rest/api/2/issue/ABC-200/editmeta':
      return json({
        fields: {
          summary: { name: 'Summary', required: true, schema: { type: 'string' } },
          labels: { name: 'Labels', schema: { type: 'array', items: 'string' } },
          duedate: { name: 'Due date', schema: { type: 'date' } },
          timetracking: { name: 'Time tracking', schema: { type: 'timetracking' } },
          customfield_10015: { name: 'Start date', schema: { type: 'datetime' } },
          customfield_10200: {
            name: 'Role of Work',
            schema: { type: 'option' },
            allowedValues: [
              { id: '201', value: 'BE' },
              { id: '202', value: 'FE' },
            ],
          },
          customfield_99999: { name: 'Không quản lý', schema: { type: 'string' } },
        },
      });
    default:
      return json({ errorMessages: ['not found'] }, 404);
  }
}

describe('Công việc của tôi', () => {
  let app: FastifyInstance;
  let cookies: Record<string, string>;

  beforeEach(async () => {
    calls.length = 0;
    linkedIssuesSupported = true;
    Object.assign(state, { estimateSec: 57600, logs: [initialLog()], nextId: 10 });
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(fakeJira(String(input), init)),
    );
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

  it('GET /issues/mine: JQL assignee = tôi, map field, editmeta, kiểm quy tắc log work', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/issues/mine?source=ABC-123', cookies });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.jql).toBe(
      'assignee = currentUser() AND (parent = ABC-123 OR issue in linkedIssues("ABC-123")) ORDER BY created ASC',
    );
    const it0 = data.issues[0];
    expect(it0).toMatchObject({
      key: 'ABC-200',
      summary: 'Sub cũ',
      from: '2026-11-10 08:00',
      to: '2026-11-11',
      estimate: '2d',
      spentMinutes: 480,
      role: '201',
      components: ['100'],
      worklogs: [{ id: '9', date: '2026-11-10', minutes: 480 }],
      ruleIssues: ['Tổng log work 1d ≠ Estimate 2d'],
    });
    expect(it0.editMeta.map((m: { id: string }) => m.id).sort()).toEqual([
      'customfield_10015',
      'customfield_10200',
      'duedate',
      'labels',
      'summary',
      'timetracking',
    ]);
  });

  it('linkedIssues() lỗi → thử lại chỉ với parent', async () => {
    linkedIssuesSupported = false;
    const data = (
      await app.inject({ method: 'GET', url: '/api/issues/mine?source=ABC-123', cookies })
    ).json();
    expect(data.jql).toBe('assignee = currentUser() AND (parent = ABC-123) ORDER BY created ASC');
    expect(data.issues).toHaveLength(1);
    expect(data.warnings[0]).toMatch(/linkedIssues/);
  });

  it('POST /issues/update: chỉ gửi field thay đổi, field không có quyền bị chặn', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/update',
      cookies,
      payload: {
        items: [
          {
            key: 'ABC-200',
            changes: { summary: 'Sub mới', estimate: '1d', to: '2026-11-12', role: '202', labels: ['SQ 2'] },
          },
        ],
      },
    });
    expect(res.json().results[0]).toMatchObject({ key: 'ABC-200', ok: true });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({
      fields: {
        summary: 'Sub mới',
        labels: ['SQ_2'],
        duedate: '2026-11-12',
        timetracking: { originalEstimate: '1d', remainingEstimate: '0m' },
        customfield_10200: { id: '202' },
      },
    });

    calls.length = 0;
    const denied = await app.inject({
      method: 'POST',
      url: '/api/issues/update',
      cookies,
      payload: { items: [{ key: 'ABC-200', changes: { components: ['101'], priorityId: '1' } }] },
    });
    expect(denied.json().results[0]).toMatchObject({
      ok: false,
      errors: ['Không có quyền sửa "Components" trên ABC-200', 'Không có quyền sửa "Priority" trên ABC-200'],
    });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('log work: thêm trong khoảng; vượt Estimate → Estimate = tổng log; ngoài khoảng → chặn', async () => {
    // Estimate 2d, đã log 1d (10/11), khoảng 10/11 → 11/11
    const ok = await app.inject({
      method: 'POST',
      url: '/api/issues/ABC-200/worklogs',
      cookies,
      payload: { date: '2026-11-11', time: '08:00', duration: '4h', comment: 'Code API' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().estimateUpdated).toBeUndefined();
    expect(ok.json().issue.worklogs[0]).toMatchObject({
      id: '9',
      mine: true,
      comment: 'Phân tích',
      start: '2026-11-10 08:00',
    });
    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/worklog'))!;
    expect(post.body).toEqual({
      started: '2026-11-11T08:00:00.000+0700',
      timeSpentSeconds: 14400,
      comment: 'Code API',
    });
    expect(post.query.get('adjustEstimate')).toBe('auto');

    // 1d + 4h + 1d = 2d 4h > 2d → nâng Estimate
    calls.length = 0;
    const over = await app.inject({
      method: 'POST',
      url: '/api/issues/ABC-200/worklogs',
      cookies,
      payload: { date: '2026-11-11', time: '13:00', duration: '1d' },
    });
    expect(over.statusCode).toBe(200);
    expect(over.json().estimateUpdated).toEqual({ from: '2d', to: '2d 4h' });
    expect(over.json().issue).toMatchObject({ estimate: '2d 4h', ruleIssues: [] });
    expect(calls.find((c) => c.method === 'PUT' && c.path === '/rest/api/2/issue/ABC-200')!.body).toEqual({
      fields: { timetracking: { originalEstimate: '2d 4h', remainingEstimate: '0m' } },
    });

    calls.length = 0;
    const bad = await app.inject({
      method: 'POST',
      url: '/api/issues/ABC-200/worklogs',
      cookies,
      payload: { date: '2026-11-12', time: '08:00', duration: '1h' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toBe(
      'Ngày log 2026-11-12 nằm ngoài Start date → Due date (2026-11-10 → 2026-11-11)',
    );
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/worklog'))).toBe(false);
  });

  it('log work: sửa và xoá worklog của tôi', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/issues/ABC-200/worklogs/9',
      cookies,
      payload: { date: '2026-11-10', time: '13:00', duration: '2d' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().estimateUpdated).toBeUndefined(); // 2d = Estimate
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      started: '2026-11-10T13:00:00.000+0700',
      timeSpentSeconds: 57600,
    });
    const del = await app.inject({ method: 'DELETE', url: '/api/issues/ABC-200/worklogs/9', cookies });
    expect(del.statusCode).toBe(200);
    expect(del.json().issue.worklogs).toEqual([]);
    const missing = await app.inject({ method: 'DELETE', url: '/api/issues/ABC-200/worklogs/77', cookies });
    expect(missing.statusCode).toBe(404);
  });

  it('log theo ngày: sửa ngày đã có, tạo ngày mới, xoá ngày về 0, nâng Estimate khi vượt', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/issues/ABC-200/worklogs/daily',
      cookies,
      payload: {
        days: [
          { date: '2026-11-10', duration: '4h' },
          { date: '2026-11-11', duration: '8h' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: 1, updated: 1, deleted: 0, warnings: [] });
    expect(res.json().estimateUpdated).toBeUndefined();
    expect(state.logs.map((l) => [l.started.slice(0, 16), l.timeSpentSeconds / 3600])).toEqual([
      ['2026-11-10T08:00', 4],
      ['2026-11-11T08:00', 8],
    ]);

    const over = await app.inject({
      method: 'PUT',
      url: '/api/issues/ABC-200/worklogs/daily',
      cookies,
      payload: {
        days: [
          { date: '2026-11-10', duration: '' },
          { date: '2026-11-11', duration: '2d 1h' },
        ],
      },
    });
    expect(over.json()).toMatchObject({
      updated: 1,
      deleted: 1,
      estimateUpdated: { from: '2d', to: '2d 1h' },
    });
    expect(over.json().issue.worklogs.map((w: { minutes: number }) => w.minutes)).toEqual([1020]);

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/issues/ABC-200/worklogs/daily',
      cookies,
      payload: {
        days: [
          { date: '2026-11-12', duration: '1h' },
          { date: '2026-11-10', duration: 'abc' },
        ],
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toBe(
      '2026-11-12: nằm ngoài Start date → Due date. 2026-11-10: thời gian "abc" không hợp lệ',
    );
  });
});

describe('buildUpdateFields', () => {
  const issue: MyIssue = {
    key: 'ABC-1',
    url: '',
    summary: 'x',
    issueType: { id: '5', name: 'Sub', subtask: true },
    status: { name: 'To Do' },
    labels: [],
    components: [],
    display: { components: [] },
    from: '2026-11-10 08:00',
    to: '2026-11-10',
    estimateMinutes: 480,
    spentMinutes: 0,
    editMeta: [
      { id: 'duedate', name: 'Due date', required: false, hasDefaultValue: false, schema: { type: 'date' } },
      {
        id: 'customfield_10015',
        name: 'Start date',
        required: false,
        hasDefaultValue: false,
        schema: { type: 'datetime' },
      },
    ],
    worklogs: [],
    ruleIssues: [],
  };
  const ctx = {
    settings: DEFAULT_SETTINGS,
    fieldIds: {
      startDate: { id: 'customfield_10015', name: 'Start date', schemaType: 'datetime' },
      epicLink: null,
      role: null,
      sprint: null,
    },
    deploymentType: 'Cloud' as const,
  };

  it('From sau To → lỗi; xoá To → null', () => {
    expect(buildUpdateFields(issue, { from: '2026-11-12 08:00' }, ctx).errors).toEqual([
      'From phải trước To',
    ]);
    const r = buildUpdateFields(issue, { to: null, from: '2026-11-11 13:00' }, ctx);
    expect(r.errors).toEqual([]);
    expect(r.fields).toEqual({ duedate: null, customfield_10015: '2026-11-11T13:00:00.000+0700' });
  });

  it('JQL Epic trên Server/DC dùng Epic Link', () => {
    expect(
      buildMyIssuesJql('EP-1', {
        isEpic: true,
        epicLinkId: 'customfield_10100',
        deploymentType: 'Server',
        withLinks: false,
      }),
    ).toBe('assignee = currentUser() AND (parent = EP-1 OR cf[10100] = EP-1) ORDER BY created ASC');
  });
});
