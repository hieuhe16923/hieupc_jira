import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '@jpw/shared';
import type { JiraClient } from './client';
import { MetaService } from './meta.service';
import { TtlCache } from '../lib/cache';

const client = (fields: unknown[]) =>
  ({ baseUrl: 'https://x.atlassian.net', get: async () => fields }) as unknown as JiraClient;

describe('MetaService.detectFields – Role', () => {
  it('nhận field "Role of Work" theo mặc định', async () => {
    const r = await new MetaService(new TtlCache(60_000)).detectFields(
      client([{ id: 'customfield_10500', name: 'Role of Work', custom: true, schema: { type: 'option' } }]),
      DEFAULT_SETTINGS,
    );
    expect(r.role).toMatchObject({ id: 'customfield_10500', name: 'Role of Work' });
  });

  it('dự phòng tên "Role" khi không có "Role of Work"', async () => {
    const r = await new MetaService(new TtlCache(60_000)).detectFields(
      client([{ id: 'customfield_10200', name: 'role', custom: true, schema: { type: 'option' } }]),
      DEFAULT_SETTINGS,
    );
    expect(r.role?.id).toBe('customfield_10200');
  });

  it('id cấu hình trong Settings được ưu tiên', async () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      fields: { role: { name: 'X', id: 'customfield_1' } },
    });
    const r = await new MetaService(new TtlCache(60_000)).detectFields(
      client([
        { id: 'customfield_1', name: 'Vai trò', custom: true },
        { id: 'customfield_2', name: 'Role of Work', custom: true },
      ]),
      settings,
    );
    expect(r.role?.id).toBe('customfield_1');
  });
});

describe('MetaService.getProjectLabels', () => {
  it('Cloud: gom label qua nhiều trang, xếp theo số lần dùng rồi độ mới', async () => {
    const pages: Record<string, unknown> = {
      first: {
        issues: [{ fields: { labels: ['SQ1', 'SQ3'] } }, { fields: { labels: ['SQ2', 'SQ1'] } }],
        nextPageToken: 'p2',
      },
      p2: { issues: [{ fields: { labels: ['Pilot', 'SQ3', 'SQ1'] } }], isLast: true },
    };
    const calls: Record<string, unknown>[] = [];
    const c = {
      baseUrl: 'https://x.atlassian.net',
      get: async (_p: string, params: Record<string, unknown>) => {
        calls.push(params);
        return pages[String(params.nextPageToken ?? 'first')];
      },
    } as unknown as JiraClient;
    const svc = new MetaService(new TtlCache(60_000));
    expect(await svc.getProjectLabels(c, 'Cloud', 'PS0142025')).toEqual(['SQ1', 'SQ3', 'SQ2', 'Pilot']);
    expect(calls[0]!.jql).toBe('project = "PS0142025" AND labels is not EMPTY ORDER BY updated DESC');
    const s = await svc.suggestProjectLabels(c, 'Cloud', 'sq', 'PS0142025');
    expect(s.project).toEqual(['SQ1', 'SQ3', 'SQ2']);
    expect(calls).toHaveLength(3); // 2 trang + 1 autocomplete; danh sách project lấy từ cache
  });
});
