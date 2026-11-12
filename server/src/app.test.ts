import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { JiraClient } from './jira/client';
import { parseSprints } from './jira/issue.service';
import { SettingsStore } from './settings/store';

const BASE = 'https://jira.test.local';
const TOKEN = 'secret-pat-123';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Giả lập Jira REST */
function fakeJira(url: string, init?: RequestInit): Response {
  const auth = (init?.headers as Record<string, string>)?.Authorization;
  if (auth !== `Bearer ${TOKEN}`) return json({ errorMessages: ['Unauthorized'] }, 401);
  const u = new URL(url);
  switch (u.pathname) {
    case '/rest/api/2/myself':
      return json({
        key: 'jdoe',
        name: 'jdoe',
        displayName: 'John Doe',
        emailAddress: 'j@x',
        avatarUrls: { '48x48': 'a' },
      });
    case '/rest/api/2/serverInfo':
      return json({ version: '9.12.0', deploymentType: 'Server' });
    case '/rest/api/2/field':
      return json([
        {
          id: 'customfield_10100',
          name: 'Epic Link',
          custom: true,
          schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' },
        },
        {
          id: 'customfield_10101',
          name: 'Sprint',
          custom: true,
          schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' },
        },
        { id: 'customfield_10200', name: 'Role', custom: true, schema: { type: 'option' } },
      ]);
    case '/rest/api/2/issue/ABC-123':
      return json({
        id: '1',
        key: 'ABC-123',
        fields: {
          summary: 'Story gốc',
          status: { name: 'To Do', statusCategory: { key: 'new' } },
          project: { id: '10', key: 'ABC', name: 'Alpha' },
          issuetype: { id: '7', name: 'Story', subtask: false },
          customfield_10100: 'ABC-1',
          customfield_10101: [
            'com.atlassian.greenhopper.service.sprint.Sprint@1f[id=12,rapidViewId=3,state=ACTIVE,name=Sprint 5,startDate=x]',
          ],
          components: [{ id: '100', name: 'Backend' }],
          labels: ['api'],
          fixVersions: [],
        },
      });
    default:
      return json({ errorMessages: ['Issue does not exist'] }, 404);
  }
}

describe('API', () => {
  let app: FastifyInstance;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(fakeJira(String(input), init)),
  );

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    const dir = mkdtempSync(path.join(tmpdir(), 'jpw-'));
    app = await buildApp({ allowedHosts: new Set(['jira.test.local']), settings: new SettingsStore(dir) });
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  async function login(token = TOKEN) {
    return app.inject({ method: 'POST', url: '/api/auth/login', payload: { token, baseUrl: BASE } });
  }

  it('login thành công → cookie httpOnly, không trả token', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(TOKEN);
    const cookie = res.cookies.find((c) => c.name === 'jpw_sid');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    expect(res.json()).toMatchObject({
      user: { name: 'jdoe', displayName: 'John Doe' },
      serverVersion: '9.12.0',
    });
  });

  it('token sai → 401 tiếng Việt', async () => {
    const res = await login('wrong');
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/token/i);
  });

  it('chặn SSRF: base URL ngoài allowlist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: TOKEN, baseUrl: 'http://169.254.169.254' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HOST_NOT_ALLOWED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolve URL → issue gốc; logout → session hết hiệu lực', async () => {
    const sid = (await login()).cookies.find((c) => c.name === 'jpw_sid')!.value;
    const cookies = { jpw_sid: sid };

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies });
    expect(me.statusCode).toBe(200);

    const r = await app.inject({
      method: 'POST',
      url: '/api/context/resolve',
      cookies,
      payload: { input: `${BASE}/browse/abc-123` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().issue).toMatchObject({
      key: 'ABC-123',
      epicKey: 'ABC-1',
      sprints: [{ id: 12, name: 'Sprint 5', state: 'ACTIVE' }],
      components: [{ id: '100', name: 'Backend' }],
      isEpic: false,
    });

    const notFound = await app.inject({
      method: 'POST',
      url: '/api/context/resolve',
      cookies,
      payload: { input: 'ABC-999' },
    });
    expect(notFound.statusCode).toBe(404);

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/api/auth/me', cookies });
    expect(after.statusCode).toBe(401);
  });

  it('API cần đăng nhập', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/context/resolve',
      payload: { input: 'ABC-1' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('JiraClient', () => {
  it('chỉ cho path /rest/ và đúng host', () => {
    const c = new JiraClient(BASE, 'Bearer x', new Set(['jira.test.local']));
    expect(() => c.buildUrl('/secure/Dashboard.jspa')).toThrow();
    expect(() => c.buildUrl('/rest/../@evil.com/x')).not.toThrow();
    expect(c.buildUrl('/rest/../@evil.com/x').host).toBe('jira.test.local');
    expect(() => new JiraClient('https://evil.com', 'Bearer x', new Set(['jira.test.local']))).toThrow();
  });

  it('retry khi 429', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls++;
      return Promise.resolve(
        calls < 2 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : json({ ok: true }),
      );
    });
    const c = new JiraClient(BASE, 'Bearer x', new Set(['jira.test.local']));
    await expect(c.get('/rest/api/2/myself')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
    vi.unstubAllGlobals();
  });
});

describe('parseSprints', () => {
  it('chuỗi Server/DC và object Cloud', () => {
    expect(
      parseSprints([
        'com.atlassian.greenhopper.service.sprint.Sprint@a[id=5,rapidViewId=1,state=CLOSED,name=S1, part 2,startDate=2026]',
        { id: 9, name: 'S9', state: 'active' },
      ]),
    ).toEqual([
      { id: 5, name: 'S1, part 2', state: 'CLOSED' },
      { id: 9, name: 'S9', state: 'active' },
    ]);
  });
});
