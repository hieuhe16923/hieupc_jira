import { describe, expect, it } from 'vitest';
import { applySummaryTemplate, DEFAULT_SETTINGS, mergeSettings } from './settings';

describe('mergeSettings', () => {
  it('giữ default khi patch rỗng / sai kiểu', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, {})).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toEqual(DEFAULT_SETTINGS);
    const r = mergeSettings(DEFAULT_SETTINGS, { workSchedule: { hoursPerDay: 'x' } });
    expect(r.workSchedule.hoursPerDay).toBe(8);
  });

  it('merge sâu, thay mảng, nhận field id', () => {
    const r = mergeSettings(DEFAULT_SETTINGS, {
      fields: { role: { id: 'customfield_10500', name: 'Vai trò' } },
      workSchedule: { holidays: ['2026-09-02'] },
      unknownKey: 1,
    });
    expect(r.fields.role).toEqual({ id: 'customfield_10500', name: 'Vai trò' });
    expect(r.fields.startDate).toEqual({ name: 'Start date' });
    expect(r.workSchedule.holidays).toEqual(['2026-09-02']);
    expect(r.workSchedule.windows).toHaveLength(2);
    expect('unknownKey' in r).toBe(false);
  });
});

describe('applySummaryTemplate', () => {
  it('áp template', () => {
    expect(applySummaryTemplate('[BE] {summary}', 'API login')).toBe('[BE] API login');
    expect(applySummaryTemplate('[BE] {summary}', '[BE] API login')).toBe('[BE] API login');
    expect(applySummaryTemplate('{summary}', 'x')).toBe('x');
    expect(applySummaryTemplate('', 'x')).toBe('x');
  });
});
