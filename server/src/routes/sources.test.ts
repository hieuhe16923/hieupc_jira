import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { SettingsStore } from '../settings/store';

const BASE = 'https://jira.test.local';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let summary = 'Story A';

function fakeJira(url: string): Response {
  const u = new URL(url);
  if (u.pathname === '/rest/api/2/myself') return json({ name: 'jdoe', displayName: 'John' });
  if (u.pathname === '/rest/api/2/serverInfo') return json({ version: '9', deploymentType: 'Server' });
  if (u.pathname === '/rest/api/2/field') return json([]);
  const m = /^\/rest\/api\/2\/issue\/(ABC-\d+)$/.exec(u.pathname);
  if (m && m[1] !== 'ABC-404') {
    return json({
      id: '1',
      key: m[1],
      fields: {
        summary: m[1] === 'ABC-1' ? summary : `Issue ${m[1]}`,
        status: { name: 'To Do' },
        project: { id: '10', key: 'ABC', name: 'Alpha' },
        issuetype: { id: '7', name: 'Story', subtask: false },
      },
    });
  }
  return json({ errorMessages: ['Issue does not exist'] }, 404);
}

describe('Issue gốc trong session', () => {
  let app: FastifyInstance;
  let cookies: Record<string, string>;
  const login = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 't', baseUrl: BASE },
    });
    return { jpw_sid: res.cookies.find((c) => c.name === 'jpw_sid')!.value };
  };

  beforeEach(async () => {
    summary = 'Story A';
    vi.stubGlobal('fetch', (input: string | URL | Request) => Promise.resolve(fakeJira(String(input))));
    app = await buildApp({
      allowedHosts: new Set(['jira.test.local']),
      settings: new SettingsStore(mkdtempSync(path.join(tmpdir(), 'jpw-'))),
    });
    cookies = await login();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  it('thêm, không trùng, làm mới, xoá; mất khi đăng xuất; mỗi phiên một danh sách', async () => {
    const add = (key: string, input?: string) =>
      app.inject({ method: 'POST', url: '/api/sources', cookies, payload: { key, input } });
    expect((await app.inject({ method: 'GET', url: '/api/sources', cookies })).json().sources).toEqual([]);

    await add('ABC-1', `${BASE}/browse/ABC-1`);
    const two = (await add('abc-2')).json().sources;
    expect(two.map((s: { key: string }) => s.key)).toEqual(['ABC-1', 'ABC-2']);
    expect(two[0]).toMatchObject({ input: `${BASE}/browse/ABC-1`, issue: { summary: 'Story A' } });

    // Xác nhận lại cùng key → cập nhật, không thêm dòng
    summary = 'Story A (sửa)';
    const again = (await add('ABC-1')).json().sources;
    expect(again).toHaveLength(2);
    expect(again[0].issue.summary).toBe('Story A (sửa)');

    summary = 'Story A v3';
    const refreshed = await app.inject({ method: 'POST', url: '/api/sources/ABC-1/refresh', cookies });
    expect(refreshed.json().sources[0].issue.summary).toBe('Story A v3');

    expect((await add('ABC-404')).statusCode).toBe(404);

    const del = await app.inject({ method: 'DELETE', url: '/api/sources/ABC-1', cookies });
    expect(del.json().sources.map((s: { key: string }) => s.key)).toEqual(['ABC-2']);

    // Phiên khác không thấy danh sách này
    const other = await login();
    expect((await app.inject({ method: 'GET', url: '/api/sources', cookies: other })).json().sources).toEqual(
      [],
    );

    await app.inject({ method: 'POST', url: '/api/auth/logout', cookies });
    expect((await app.inject({ method: 'GET', url: '/api/sources', cookies })).statusCode).toBe(401);
  });
});
