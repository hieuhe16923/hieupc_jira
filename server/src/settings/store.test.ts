import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@jpw/shared';
import { SettingsStore, validateSettings } from './store';

describe('validateSettings', () => {
  it('khung giờ: chuẩn hoá, sắp xếp, bỏ khung sai / chồng lấn; rỗng → mặc định', () => {
    const s = validateSettings({
      ...DEFAULT_SETTINGS,
      workSchedule: {
        hoursPerDay: 7.5,
        windows: [
          { start: '13:30', end: '17:00' },
          { start: '8:00', end: '12:00' },
          { start: '11:00', end: '12:30' }, // chồng lấn
          { start: '18:00', end: '17:00' }, // end < start
          { start: '25:00', end: '26:00' }, // sai giờ
        ],
        workingWeekdays: [5, 1, 1, 9, 3],
        holidays: ['2026-12-31', 'x', '2026-01-01', '2026-12-31'],
      },
    });
    expect(s.workSchedule).toEqual({
      hoursPerDay: 7.5,
      windows: [
        { start: '08:00', end: '12:00' },
        { start: '13:30', end: '17:00' },
      ],
      workingWeekdays: [1, 3, 5],
      holidays: ['2026-01-01', '2026-12-31'],
    });
    const empty = validateSettings({
      ...DEFAULT_SETTINGS,
      workSchedule: { hoursPerDay: 0, windows: [], workingWeekdays: [], holidays: [] },
    });
    expect(empty.workSchedule).toEqual(DEFAULT_SETTINGS.workSchedule);
  });

  it('field map, template, offset, label/component', () => {
    const s = validateSettings({
      ...DEFAULT_SETTINGS,
      fields: {
        startDate: { name: ' Ngày bắt đầu ', id: 'customfield_10015' },
        epicLink: { name: '', id: 'bad id!' },
        role: { name: 'Role of Work' },
        sprint: { name: 'Sprint', id: 'customfield_10020' },
      },
      utcOffset: '+25:00',
      defaults: {
        ...DEFAULT_SETTINGS.defaults,
        labels: ['a b', 'a_b', ' ', 'SQ1'],
        components: ['Backend', 'Backend', ''],
        summaryTemplate: '[BE]',
      },
    });
    expect(s.fields).toEqual({
      startDate: { name: 'Ngày bắt đầu', id: 'customfield_10015' },
      epicLink: { name: 'Epic Link' },
      role: { name: 'Role of Work' },
      sprint: { name: 'Sprint', id: 'customfield_10020' },
    });
    expect(s.utcOffset).toBe('+07:00');
    expect(s.defaults.labels).toEqual(['a_b', 'SQ1']);
    expect(s.defaults.components).toEqual(['Backend']);
    expect(s.defaults.summaryTemplate).toBe('[BE] {summary}');
  });
});

describe('SettingsStore', () => {
  it('ghi file JSON, đọc lại, xoá id field map bằng chuỗi rỗng', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jpw-'));
    const store = new SettingsStore(dir);
    await store.update({
      fields: { role: { name: 'Role of Work', id: 'customfield_10500' } },
      utcOffset: '+08:00',
    });
    const fresh = new SettingsStore(dir);
    expect((await fresh.get()).fields.role).toEqual({ name: 'Role of Work', id: 'customfield_10500' });
    expect(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')).utcOffset).toBe('+08:00');
    const cleared = await fresh.update({ fields: { role: { name: 'Role of Work', id: '' } } });
    expect(cleared.fields.role).toEqual({ name: 'Role of Work' });
  });
});
