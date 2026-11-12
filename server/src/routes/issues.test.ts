import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CreateIssuesRequest } from '@jpw/shared';
import { buildApp } from '../app';
import { SettingsStore } from '../settings/store';

const BASE = 'https://jira.test.local';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const subtaskFields = [
  { fieldId: 'project', name: 'Project', required: true, schema: { type: 'project' } },
  { fieldId: 'issuetype', name: 'Issue Type', required: true, schema: { type: 'issuetype' } },
  { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
  { fieldId: 'parent', name: 'Parent', required: true, schema: { type: 'issuelink' } },
  { fieldId: 'assignee', name: 'Assignee', required: false, schema: { type: 'user' } },
  { fieldId: 'timetracking', name: 'Time tracking', required: false, schema: { type: 'timetracking' } },
  {
    fieldId: 'customfield_10200',
    name: 'Role',
    required: true,
    schema: { type: 'option' },
    allowedValues: [{ id: '1', value: 'BE' }],
  },
];
const taskFields = subtaskFields.filter((f) => f.fieldId !== 'parent' && f.fieldId !== 'customfield_10200');

const calls: { path: string; body?: unknown; query?: string }[] = [];

function fakeJira(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ path: u.pathname, body, query: u.search });
  if (/^\/rest\/api\/2\/issue\/ABC-\d+\/worklog$/.test(u.pathname)) {
    return (body as { started: string }).started.startsWith('2026-11-11')
      ? json({ errorMessages: ['Worklog bị khoá'] }, 400)
      : json({ id: '1' }, 201);
  }
  switch (u.pathname) {
    case '/rest/api/2/myself':
      return json({ name: 'jdoe', key: 'jdoe', displayName: 'John' });
    case '/rest/api/2/serverInfo':
      return json({ version: '9.12.0', deploymentType: 'Server' });
    case '/rest/api/2/field':
      return json([{ id: 'customfield_10200', name: 'Role', custom: true, schema: { type: 'option' } }]);
    case '/rest/api/2/issue/ABC-123':
      return json({
        id: '1',
        key: 'ABC-123',
        fields: {
          summary: 'Story',
          status: { name: 'To Do' },
          project: { id: '10', key: 'ABC', name: 'Alpha' },
          issuetype: { id: '7', name: 'Story', subtask: false },
          components: [],
          labels: [],
          fixVersions: [],
        },
      });
    case '/rest/api/2/issue/createmeta/ABC/issuetypes':
      return json({
        values: [
          { id: '5', name: 'Sub-task BE', subtask: true },
          { id: '3', name: 'Task', subtask: false },
        ],
        isLast: true,
      });
    case '/rest/api/2/issue/createmeta/ABC/issuetypes/5':
      return json({ values: subtaskFields, isLast: true });
    case '/rest/api/2/issue/createmeta/ABC/issuetypes/3':
      return json({ values: taskFields, isLast: true });
    case '/rest/api/2/issueLinkType':
      return json({ issueLinkTypes: [{ name: 'Relates', inward: 'relates to', outward: 'relates to' }] });
    case '/rest/api/2/issueLink':
      return new Response(null, { status: 201 });
    case '/rest/api/2/issue/bulk': {
      const updates = (body as { issueUpdates: { fields: { summary: string } }[] }).issueUpdates;
      const issues: { id: string; key: string }[] = [];
      const errors: unknown[] = [];
      updates.forEach((up, i) => {
        if (up.fields.summary.includes('FAIL')) {
          errors.push({
            status: 400,
            failedElementNumber: i,
            elementErrors: { errors: { customfield_10200: 'Option không hợp lệ' } },
          });
        } else issues.push({ id: String(100 + i), key: `ABC-${200 + i}` });
      });
      return json({ issues, errors }, issues.length ? 201 : 400);
    }
    default:
      return json({ errorMessages: ['not found'] }, 404);
  }
}

describe('POST /api/issues/create', () => {
  let app: FastifyInstance;
  let cookies: Record<string, string>;

  beforeEach(async () => {
    calls.length = 0;
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

  const sub = (rowId: string, summary: string, role = '1') => ({
    rowId,
    issueTypeId: '5',
    summary,
    labels: [],
    components: [],
    from: '2026-11-10 08:00',
    to: '2026-11-10 17:00',
    extra: { customfield_10200: role },
  });

  it('tạo 3 sub-task, map lỗi đúng dòng, dòng thiếu Role không gửi lên Jira', async () => {
    const payload: CreateIssuesRequest = {
      sourceKey: 'ABC-123',
      inherit: { sprint: true, fixVersions: true, components: true, labels: false },
      rows: [sub('a', 'Task 1'), sub('b', 'Task FAIL'), sub('c', 'Task 3'), sub('d', 'Thiếu role', '')],
    };
    const res = await app.inject({ method: 'POST', url: '/api/issues/create', cookies, payload });
    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results[0]).toMatchObject({ rowId: 'a', ok: true, key: 'ABC-200', url: `${BASE}/browse/ABC-200` });
    expect(results[1]).toMatchObject({ rowId: 'b', ok: false, errors: ['Role: Option không hợp lệ'] });
    expect(results[2]).toMatchObject({ rowId: 'c', ok: true, key: 'ABC-202' });
    expect(results[3]).toMatchObject({ rowId: 'd', ok: false, errors: ['Thiếu trường bắt buộc "Role"'] });

    const bulk = calls.find((c) => c.path === '/rest/api/2/issue/bulk')!.body as {
      issueUpdates: { fields: Record<string, unknown> }[];
    };
    expect(bulk.issueUpdates).toHaveLength(3);
    expect(bulk.issueUpdates[0]!.fields).toMatchObject({
      parent: { key: 'ABC-123' },
      assignee: { name: 'jdoe' },
      timetracking: { originalEstimate: '1d' },
    });
    expect(calls.some((c) => c.path === '/rest/api/2/issueLink')).toBe(false);
  });

  it('Task từ Story → tạo link relates to', async () => {
    const payload: CreateIssuesRequest = {
      sourceKey: 'ABC-123',
      inherit: { sprint: false, fixVersions: false, components: false, labels: false },
      rows: [{ ...sub('t', 'Task mới'), issueTypeId: '3', extra: {} }],
    };
    const res = await app.inject({ method: 'POST', url: '/api/issues/create', cookies, payload });
    expect(res.json().results[0]).toMatchObject({ ok: true, key: 'ABC-200' });
    const link = calls.find((c) => c.path === '/rest/api/2/issueLink');
    expect(link?.body).toEqual({
      type: { name: 'Relates' },
      inwardIssue: { key: 'ABC-200' },
      outwardIssue: { key: 'ABC-123' },
    });
  });

  it('preview không gọi bulk', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/preview',
      cookies,
      payload: { sourceKey: 'ABC-123', inherit: {}, rows: [sub('a', 'X')] },
    });
    expect(res.json().rows[0]).toMatchObject({ rowId: 'a', errors: [], estimate: '1d' });
    expect(calls.some((c) => c.path === '/rest/api/2/issue/bulk')).toBe(false);
  });

  it('chia batch ≤ 50', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => sub(`r${i}`, `T${i}`));
    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/create',
      cookies,
      payload: { sourceKey: 'ABC-123', inherit: {}, rows },
    });
    expect(res.json().results.filter((r: { ok: boolean }) => r.ok)).toHaveLength(120);
    const sizes = calls
      .filter((c) => c.path === '/rest/api/2/issue/bulk')
      .map((c) => (c.body as { issueUpdates: unknown[] }).issueUpdates.length);
    expect(sizes).toEqual([50, 50, 20]);
  });

  it('tự log work: mỗi ngày 1 worklog, tổng = Estimate, ngày lỗi thành cảnh báo', async () => {
    const payload: CreateIssuesRequest = {
      sourceKey: 'ABC-123',
      inherit: { sprint: false, fixVersions: false, components: false, labels: false },
      logWork: true,
      rows: [
        { ...sub('a', 'Có log'), from: '2026-11-10 08:00', to: '2026-11-12 17:00' },
        { ...sub('b', 'Thiếu From'), from: undefined },
      ],
    };
    const preview = await app.inject({ method: 'POST', url: '/api/issues/preview', cookies, payload });
    const rows = preview.json().rows;
    expect(rows[0].worklogs).toEqual([
      { date: '2026-11-10', start: '2026-11-10 08:00', minutes: 480 },
      { date: '2026-11-11', start: '2026-11-11 08:00', minutes: 480 },
      { date: '2026-11-12', start: '2026-11-12 08:00', minutes: 480 },
    ]);
    expect(rows[0].estimate).toBe('3d');
    expect(rows[1].errors).toContain('Tự log work cần nhập From và To');

    calls.length = 0;
    const res = await app.inject({ method: 'POST', url: '/api/issues/create', cookies, payload });
    const r = res.json().results[0];
    expect(r).toMatchObject({ ok: true, key: 'ABC-200', worklogsPlanned: 3, worklogsLogged: 2 });
    expect(r.warnings.find((w: string) => w.includes('log work'))).toMatch(
      /log work lỗi 1\/3 ngày.*2026-11-11/,
    );
    const wl = calls.filter((c) => c.path === '/rest/api/2/issue/ABC-200/worklog');
    expect(wl.map((c) => c.body)).toEqual([
      { started: '2026-11-10T08:00:00.000+0700', timeSpentSeconds: 28800 },
      { started: '2026-11-11T08:00:00.000+0700', timeSpentSeconds: 28800 },
      { started: '2026-11-12T08:00:00.000+0700', timeSpentSeconds: 28800 },
    ]);
    expect(wl[0]!.query).toBe('?adjustEstimate=auto');
  });

  it('không bật logWork → không gọi worklog', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/issues/create',
      cookies,
      payload: { sourceKey: 'ABC-123', inherit: {}, rows: [sub('a', 'X')] },
    });
    expect(calls.some((c) => c.path.endsWith('/worklog'))).toBe(false);
  });
});
