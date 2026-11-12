import { describe, expect, it } from 'vitest';
import {
  estimateFromRange,
  formatJiraDuration,
  parseJiraDuration,
  toJiraDate,
  toJiraDateTime,
  workingMinutesBetween,
} from './work-hours';
import type { WorkSchedule } from './types';

const schedule: WorkSchedule = {
  hoursPerDay: 8,
  windows: [
    { start: '08:00', end: '12:00' },
    { start: '13:00', end: '17:00' },
  ],
  workingWeekdays: [1, 2, 3, 4, 5],
  holidays: [],
};

// 2026-11-10 là Thứ Ba; 14 = T7, 15 = CN, 16 = T2
describe('workingMinutesBetween', () => {
  it('trọn 1 ngày làm việc = 8h', () => {
    expect(workingMinutesBetween('2026-11-10 08:00', '2026-11-10 17:00', schedule)).toBe(480);
  });

  it('loại trừ giờ nghỉ trưa', () => {
    expect(workingMinutesBetween('2026-11-10 10:00', '2026-11-10 14:00', schedule)).toBe(180);
  });

  it('cắt phần ngoài khung giờ', () => {
    expect(workingMinutesBetween('2026-11-10 06:00', '2026-11-10 20:00', schedule)).toBe(480);
    expect(workingMinutesBetween('2026-11-10 12:15', '2026-11-10 12:45', schedule)).toBe(0);
  });

  it('nhiều ngày, bỏ T7/CN', () => {
    // T6 13:00 → T2 12:00 = 4h (T6) + 4h (T2)
    expect(workingMinutesBetween('2026-11-13 13:00', '2026-11-16 12:00', schedule)).toBe(480);
    // T2 → T6 cả tuần = 40h
    expect(workingMinutesBetween('2026-11-09 08:00', '2026-11-13 17:00', schedule)).toBe(2400);
  });

  it('bỏ ngày nghỉ lễ cấu hình', () => {
    const s = { ...schedule, holidays: ['2026-11-11'] };
    expect(workingMinutesBetween('2026-11-10 08:00', '2026-11-12 17:00', s)).toBe(960);
  });

  it('To chỉ có ngày → tính hết ngày', () => {
    expect(workingMinutesBetween('2026-11-10', '2026-11-11', schedule)).toBe(960);
  });

  it('khoảng ngược hoặc input sai → 0', () => {
    expect(workingMinutesBetween('2026-11-10 17:00', '2026-11-10 08:00', schedule)).toBe(0);
    expect(workingMinutesBetween('abc', '2026-11-10 08:00', schedule)).toBe(0);
    expect(workingMinutesBetween('2026-02-30 08:00', '2026-03-02 08:00', schedule)).toBe(0);
  });

  it('chỉ trong cuối tuần → 0', () => {
    expect(workingMinutesBetween('2026-11-14 08:00', '2026-11-15 17:00', schedule)).toBe(0);
  });
});

describe('formatJiraDuration / parseJiraDuration', () => {
  it('format', () => {
    expect(formatJiraDuration(0)).toBe('0m');
    expect(formatJiraDuration(480)).toBe('1d');
    expect(formatJiraDuration(720)).toBe('1d 4h');
    expect(formatJiraDuration(90)).toBe('1h 30m');
    expect(formatJiraDuration(2400)).toBe('5d');
    expect(formatJiraDuration(420, 7)).toBe('1d');
  });

  it('parse', () => {
    expect(parseJiraDuration('1d 4h')).toBe(720);
    expect(parseJiraDuration('1w')).toBe(2400);
    expect(parseJiraDuration('1.5h')).toBe(90);
    expect(parseJiraDuration('2h30m')).toBe(150);
    expect(parseJiraDuration('abc')).toBeNull();
    expect(parseJiraDuration('3x')).toBeNull();
    expect(parseJiraDuration('')).toBeNull();
  });
});

describe('estimateFromRange & định dạng ngày Jira', () => {
  it('estimate 1.5 ngày', () => {
    expect(estimateFromRange('2026-11-10 08:00', '2026-11-11 12:00', schedule)).toEqual({
      minutes: 720,
      jira: '1d 4h',
      hours: 12,
    });
  });

  it('toJiraDateTime / toJiraDate', () => {
    expect(toJiraDateTime('2026-11-10 08:30', '+07:00')).toBe('2026-11-10T08:30:00.000+0700');
    expect(toJiraDateTime('2026-11-10')).toBe('2026-11-10T00:00:00.000+0700');
    expect(toJiraDate('2026-11-10 08:30')).toBe('2026-11-10');
    expect(toJiraDateTime('x')).toBeNull();
  });
});
