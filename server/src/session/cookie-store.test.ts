import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { SettingsStore } from '../settings/store';
import { CookieSessionStore } from './cookie-store';

const SECRET = 'x'.repeat(40);
const BASE = 'https://jira.test.local';
const data = {
  authHeader: 'Bearer secret-token',
  baseUrl: BASE,
  user: { name: 'jdoe', displayName: 'John' },
  deploymentType: 'Server' as const,
};

describe('CookieSessionStore', () => {
  it('mã hoá: cookie không lộ token, mở lại được bằng cùng secret', () => {
    const a = new CookieSessionStore(SECRET, 60);
    const token = a.cookieValue(a.create(data));
    expect(token).not.toContain('secret-token');
    expect(Buffer.from(token, 'base64url').toString('latin1')).not.toContain('secret-token');

    const b = new CookieSessionStore(SECRET, 60); // instance serverless khác
    expect(b.get(token)).toMatchObject({ authHeader: 'Bearer secret-token', user: { name: 'jdoe' } });
  });

  it('từ chối cookie sai secret, bị sửa hoặc hết hạn', () => {
    const a = new CookieSessionStore(SECRET, 60);
    const sess = a.create(data);
    const token = a.cookieValue(sess);
    expect(new CookieSessionStore('y'.repeat(40), 60).get(token)).toBeUndefined();
    const buf = Buffer.from(token, 'base64url');
    buf[buf.length - 1] ^= 1;
    expect(a.get(buf.toString('base64url'))).toBeUndefined();
    expect(a.get('rác')).toBeUndefined();

    sess.lastSeen = Date.now() - 61 * 60_000;
    expect(a.get(a.cookieValue(sess))).toBeUndefined();
  });

  it('bắt buộc secret đủ dài', () => {
    expect(() => new CookieSessionStore('short', 60)).toThrow();
  });
});

describe('App với cookie session (mô phỏng 2 instance serverless)', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    vi.unstubAllGlobals();
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const make = async () => {
    const app = await buildApp({
      allowedHosts: new Set(['jira.test.local']),
      settings: new SettingsStore(mkdtempSync(path.join(tmpdir(), 'jpw-'))),
      sessions: new CookieSessionStore(SECRET, 60),
    });
    apps.push(app);
    return app;
  };

  it('đăng nhập ở instance A, dùng tiếp ở instance B; issue gốc được đọc lại từ Jira', async () => {
    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname === '/rest/api/2/myself') return Promise.resolve(json({ name: 'jdoe', displayName: 'John' }));
      if (u.pathname === '/rest/api/2/serverInfo') return Promise.resolve(json({ version: '9', deploymentType: 'Server' }));
      if (u.pathname === '/rest/api/2/field') return Promise.resolve(json([]));
      const m = /^\/rest\/api\/2\/issue\/(ABC-\d+)$/.exec(u.pathname);
      if (m) {
        return Promise.resolve(
          json({
            id: '1',
            key: m[1],
            fields: {
              summary: `Issue ${m[1]}`,
              status: { name: 'To Do' },
              project: { id: '10', key: 'ABC', name: 'Alpha' },
              issuetype: { id: '7', name: 'Story', subtask: false },
            },
          }),
        );
      }
      return Promise.resolve(json({}, 404));
    });

    const a = await make();
    const b = await make();
    const login = await a.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 't', baseUrl: BASE } });
    let sid = login.cookies.find((c) => c.name === 'jpw_sid')!.value;

    const added = await a.inject({ method: 'POST', url: '/api/sources', cookies: { jpw_sid: sid }, payload: { key: 'ABC-1' } });
    sid = added.cookies.find((c) => c.name === 'jpw_sid')!.value;

    const me = await b.inject({ method: 'GET', url: '/api/auth/me', cookies: { jpw_sid: sid } });
    expect(me.statusCode).toBe(200);
    const list = await b.inject({ method: 'GET', url: '/api/sources', cookies: { jpw_sid: sid } });
    expect(list.json().sources).toMatchObject([{ key: 'ABC-1', issue: { summary: 'Issue ABC-1' } }]);
  });
});
