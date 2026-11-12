import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import {
  checkWorklogRules,
  estimateAfterLog,
  planWorklogs,
  validateWorklogEntry,
  worklogDays,
} from './worklog-rules';

const S = DEFAULT_SETTINGS.workSchedule; // 08–12, 13–17, T2–T6

describe('planWorklogs', () => {
  it('mỗi ngày làm việc 1 worklog, bỏ T7/CN, tổng = giờ làm việc', () => {
    // 2026-11-13 là thứ Sáu, 14–15 là T7/CN
    const plan = planWorklogs('2026-11-12 08:00', '2026-11-16 17:00', S);
    expect(plan).toEqual([
      { date: '2026-11-12', start: '2026-11-12 08:00', minutes: 480 },
      { date: '2026-11-13', start: '2026-11-13 08:00', minutes: 480 },
      { date: '2026-11-16', start: '2026-11-16 08:00', minutes: 480 },
    ]);
  });

  it('ngày đầu/cuối dở dang: bắt đầu tại From, chỉ tính phần trong khung giờ', () => {
    const plan = planWorklogs('2026-11-10 10:30', '2026-11-11 12:00', S);
    expect(plan).toEqual([
      { date: '2026-11-10', start: '2026-11-10 10:30', minutes: 330 }, // 1h30 + 4h
      { date: '2026-11-11', start: '2026-11-11 08:00', minutes: 240 },
    ]);
  });

  it('From trong giờ nghỉ trưa → bắt đầu 13:00', () => {
    expect(planWorklogs('2026-11-10 12:15', '2026-11-10 17:00', S)[0]).toMatchObject({
      start: '2026-11-10 13:00',
      minutes: 240,
    });
  });

  it('Estimate nhập tay khác → chia theo tỉ lệ, tổng đúng bằng Estimate', () => {
    const plan = planWorklogs('2026-11-10 08:00', '2026-11-12 17:00', S, 600); // 10h trên 3 ngày
    expect(plan.map((p) => p.minutes)).toEqual([200, 200, 200]);
    const odd = planWorklogs('2026-11-10 08:00', '2026-11-12 17:00', S, 601);
    expect(odd.reduce((s, p) => s + p.minutes, 0)).toBe(601);
  });

  it('không có giờ làm việc → rỗng', () => {
    expect(planWorklogs('2026-11-14 08:00', '2026-11-15 17:00', S)).toEqual([]);
    expect(planWorklogs('2026-11-10 08:00', '2026-11-10 17:00', S, 0)).toEqual([]);
  });
});

describe('checkWorklogRules', () => {
  const base = { startDate: '2026-11-10 08:00', dueDate: '2026-11-12', hoursPerDay: 8 };

  it('hợp lệ khi tổng = Estimate và ngày nằm trong khoảng', () => {
    expect(
      checkWorklogRules({
        ...base,
        estimateMinutes: 960,
        worklogs: [
          { date: '2026-11-10', minutes: 480 },
          { date: '2026-11-12', minutes: 480 },
        ],
      }),
    ).toEqual([]);
  });

  it('báo tổng ≠ Estimate và ngày ngoài khoảng', () => {
    const r = checkWorklogRules({
      ...base,
      estimateMinutes: 960,
      worklogs: [
        { date: '2026-11-09', minutes: 240 },
        { date: '2026-11-13', minutes: 480 },
      ],
    });
    expect(r).toEqual([
      'Tổng log work 1d 4h ≠ Estimate 2d',
      'Log work ngoài khoảng Start date → Due date: 2026-11-09, 2026-11-13',
    ]);
  });

  it('thiếu Estimate / Start date', () => {
    expect(
      checkWorklogRules({ worklogs: [{ date: '2026-11-10', minutes: 60 }], dueDate: '2026-11-10' }),
    ).toEqual([
      'Chưa có Estimate nhưng đã log 1h',
      'Issue thiếu Start date hoặc Due date để đối chiếu ngày log work',
    ]);
  });
});

describe('validateWorklogEntry', () => {
  const issue = {
    from: '2026-11-10 08:00',
    to: '2026-11-12',
    estimateMinutes: 960,
    worklogs: [{ id: 'a', minutes: 480 }],
  };

  it('hợp lệ trong khoảng, vượt Estimate không bị chặn', () => {
    expect(validateWorklogEntry({ issue, date: '2026-11-12', minutes: 480 })).toEqual([]);
    expect(validateWorklogEntry({ issue, date: '2026-11-11', minutes: 2000 })).toEqual([]);
  });

  it('chặn ngày ngoài khoảng và thời gian <= 0', () => {
    expect(validateWorklogEntry({ issue, date: '2026-11-13', minutes: 0 })).toEqual([
      'Thời gian log phải > 0',
      'Ngày log 2026-11-13 nằm ngoài Start date → Due date (2026-11-10 → 2026-11-12)',
    ]);
  });

  it('thiếu Start/Due', () => {
    expect(validateWorklogEntry({ issue: { worklogs: [] }, date: '2026-11-10', minutes: 60 })).toEqual([
      'Issue chưa có Start date hoặc Due date → đặt From/To trước khi log work',
    ]);
  });
});

describe('estimateAfterLog', () => {
  it('tổng log > Estimate hoặc chưa có Estimate → Estimate = tổng log', () => {
    expect(estimateAfterLog(960, 1200)).toBe(1200);
    expect(estimateAfterLog(undefined, 300)).toBe(300);
    expect(estimateAfterLog(960, 960)).toBeUndefined();
    expect(estimateAfterLog(960, 100)).toBeUndefined();
    expect(estimateAfterLog(undefined, 0)).toBeUndefined();
  });
});

describe('worklogDays', () => {
  it('liệt kê mọi ngày From → To, đánh dấu T7/CN, giờ bắt đầu theo From', () => {
    const days = worklogDays('2026-11-13 10:30', '2026-11-16', S);
    expect(days).toEqual([
      { date: '2026-11-13', weekday: 5, working: true, start: '10:30', workMinutes: 330 },
      { date: '2026-11-14', weekday: 6, working: false, start: '08:00', workMinutes: 0 },
      { date: '2026-11-15', weekday: 0, working: false, start: '08:00', workMinutes: 0 },
      { date: '2026-11-16', weekday: 1, working: true, start: '08:00', workMinutes: 480 },
    ]);
    expect(worklogDays('2026-11-16', '2026-11-13', S)).toEqual([]);
  });
});
