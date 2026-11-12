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

let status = 'To Do';
const posts: unknown[] = [];

function fakeJira(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  switch (u.pathname) {
    case '/rest/api/2/myself':
      return json({ name: 'jdoe', displayName: 'John' });
    case '/rest/api/2/serverInfo':
      return json({ version: '9', deploymentType: 'Server' });
    case '/rest/api/2/field':
      return json([]);
    case '/rest/api/2/issue/ABC-7/transitions':
      if (init?.method === 'POST') {
        posts.push(body);
        if (body.transition.id === '31' && !body.fields?.resolution) {
          return json({ errorMessages: [], errors: { resolution: 'Resolution is required' } }, 400);
        }
        status = body.transition.id === '21' ? 'In Progress' : 'Done';
        return new Response(null, { status: 204 });
      }
      expect(u.searchParams.get('expand')).toBe('transitions.fields');
      return json({
        transitions: [
          {
            id: '21',
            name: 'Start Progress',
            to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          },
          {
            id: '31',
            name: 'Done',
            to: { name: 'Done', statusCategory: { key: 'done' } },
            fields: {
              resolution: {
                name: 'Resolution',
                required: false,
                schema: { type: 'resolution' },
                allowedValues: [
                  { id: '1', name: 'Fixed' },
                  { id: '2', name: "Won't Do" },
                ],
              },
              customfield_1: { name: 'Ghi chú QA', required: false, schema: { type: 'string' } },
            },
          },
        ],
      });
    case '/rest/api/2/issue/ABC-7':
      return json({
        id: '7',
        key: 'ABC-7',
        fields: {
          summary: 'Việc 7',
          issuetype: { id: '5', name: 'Sub-task', subtask: true },
          status: { name: status, statusCategory: { key: status === 'Done' ? 'done' : 'indeterminate' } },
        },
      });
    case '/rest/api/2/issue/ABC-7/editmeta':
      return json({ fields: {} });
    default:
      return json({ errorMessages: ['not found'] }, 404);
  }
}

describe('Chuyển trạng thái', () => {
  let app: FastifyInstance;
  let cookies: Record<string, string>;

  beforeEach(async () => {
    status = 'To Do';
    posts.length = 0;
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

  it('liệt kê bước chuyển, chỉ hỏi field bắt buộc / resolution', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/issues/ABC-7/transitions', cookies });
    expect(res.json()).toMatchObject([
      {
        id: '21',
        name: 'Start Progress',
        to: { name: 'In Progress', category: 'indeterminate' },
        fields: [],
      },
      { id: '31', name: 'Done', to: { name: 'Done', category: 'done' }, fields: [{ id: 'resolution' }] },
    ]);
  });

  it('chuyển trạng thái, gửi resolution + comment, trả issue mới; lỗi Jira đổi id → tên field', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/issues/ABC-7/transitions',
      cookies,
      payload: { transitionId: '21' },
    });
    expect(ok.json().status.name).toBe('In Progress');
    expect(posts[0]).toEqual({ transition: { id: '21' } });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/issues/ABC-7/transitions',
      cookies,
      payload: { transitionId: '31' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toBe('Resolution: Resolution is required');

    const done = await app.inject({
      method: 'POST',
      url: '/api/issues/ABC-7/transitions',
      cookies,
      payload: { transitionId: '31', fields: { resolution: '1' }, comment: 'Xong' },
    });
    expect(done.json().status.name).toBe('Done');
    expect(posts.at(-1)).toEqual({
      transition: { id: '31' },
      fields: { resolution: { id: '1' } },
      update: { comment: [{ add: { body: 'Xong' } }] },
    });

    const gone = await app.inject({
      method: 'POST',
      url: '/api/issues/ABC-7/transitions',
      cookies,
      payload: { transitionId: '99' },
    });
    expect(gone.statusCode).toBe(409);
  });
});
