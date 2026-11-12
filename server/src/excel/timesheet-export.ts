import ExcelJS from 'exceljs';
import type { TimesheetResponse } from '@jpw/shared';

const WEEKDAY = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
const WEEKEND_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
const SHORT_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8CBAD' } };
const OVER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } };
const WARN_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };

const hours = (m: number) => Math.round((m / 60) * 100) / 100;
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER_FILL;
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 30;
}

/** Xuất timesheet: Tổng hợp, Timesheet (issue × ngày, đơn vị giờ), Chi tiết (từng worklog) */
export async function buildTimesheetXlsx(data: TimesheetResponse): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Jira Personal Workbench';
  wb.created = new Date();
  const shortSet = new Set(data.shortDays.map((d) => d.date));
  const overSet = new Set(data.overDays.map((d) => d.date));

  // ---------- Tổng hợp ----------
  const sum = wb.addWorksheet('Tổng hợp');
  sum.getColumn(1).width = 34;
  sum.getColumn(2).width = 60;
  const rows: [string, string | number][] = [
    ['Kỳ', `${data.from} → ${data.to}`],
    ['Tổng giờ đã log', hours(data.totalMinutes)],
    ['Giờ chuẩn (ngày làm việc đã qua × giờ/ngày)', hours(data.expectedMinutes)],
    ['Chênh lệch (giờ)', hours(data.totalMinutes - data.expectedMinutes)],
    ['Số issue', data.issues.length],
    [
      'Ngày thiếu giờ',
      data.shortDays.map((d) => `${ddmm(d.date)} (${hours(d.minutes)}h)`).join(', ') || 'Không có',
    ],
    [
      'Ngày vượt giờ',
      data.overDays.map((d) => `${ddmm(d.date)} (${hours(d.minutes)}h)`).join(', ') || 'Không có',
    ],
    [
      'Issue vi phạm quy tắc log work',
      data.issues
        .filter((i) => i.ruleIssues.length)
        .map((i) => i.key)
        .join(', ') || 'Không có',
    ],
    ['JQL', data.jql],
  ];
  sum.addRow(['Mục', 'Giá trị']);
  styleHeader(sum.getRow(1));
  rows.forEach((r) => sum.addRow(r));
  sum.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

  // ---------- Timesheet ----------
  const ws = wb.addWorksheet('Timesheet', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  const fixed = ['Issue', 'Summary', 'Loại', 'Trạng thái', 'Estimate', 'Đã log (mọi người)', 'Còn lại'];
  const header = [
    ...fixed,
    ...data.days.map((d) => `${WEEKDAY[d.weekday]}\n${ddmm(d.date)}`),
    'Tổng kỳ (giờ)',
    'Cảnh báo',
  ];
  ws.addRow(header);
  styleHeader(ws.getRow(1));
  const widths = [16, 42, 14, 14, 10, 12, 10, ...data.days.map(() => 7), 11, 50];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const dayCol = (idx: number) => fixed.length + idx + 1;

  for (const i of data.issues) {
    const row = ws.addRow([
      { text: i.key, hyperlink: i.url },
      i.summary,
      i.issueType.name,
      i.status.name,
      i.estimate ?? '',
      i.spentMinutes ? hours(i.spentMinutes) : 0,
      i.remaining ?? '',
      ...data.days.map((d) => (i.byDay[d.date] ? hours(i.byDay[d.date]!) : null)),
      hours(i.minutes),
      i.ruleIssues.join('; '),
    ]);
    row.getCell(1).font = { color: { argb: 'FF0563C1' }, underline: true };
    if (i.ruleIssues.length) row.getCell(header.length).fill = WARN_FILL;
  }

  const total = ws.addRow([
    'TỔNG',
    '',
    '',
    '',
    '',
    '',
    '',
    ...data.days.map((d) => hours(d.minutes)),
    hours(data.totalMinutes),
    '',
  ]);
  total.font = { bold: true };
  data.days.forEach((d, idx) => {
    const col = dayCol(idx);
    if (!d.working) {
      for (let r = 2; r <= ws.rowCount; r++) ws.getCell(r, col).fill = WEEKEND_FILL;
    }
    if (shortSet.has(d.date)) total.getCell(col).fill = SHORT_FILL;
    else if (overSet.has(d.date)) total.getCell(col).fill = OVER_FILL;
  });
  for (let c = fixed.length + 1; c <= fixed.length + data.days.length + 1; c++) {
    ws.getColumn(c).numFmt = '0.##';
    ws.getColumn(c).alignment = { horizontal: 'center' };
  }

  // ---------- Chi tiết ----------
  const det = wb.addWorksheet('Chi tiết', { views: [{ state: 'frozen', ySplit: 1 }] });
  det.addRow(['Ngày', 'Giờ bắt đầu', 'Issue', 'Summary', 'Số giờ', 'Ghi chú']);
  styleHeader(det.getRow(1));
  [12, 12, 16, 50, 10, 60].forEach((w, i) => (det.getColumn(i + 1).width = w));
  const detail = data.issues
    .flatMap((i) => i.worklogs.map((w) => ({ i, w })))
    .sort((a, b) => a.w.start.localeCompare(b.w.start));
  for (const { i, w } of detail) {
    det.addRow([
      w.date,
      w.start.slice(11, 16),
      { text: i.key, hyperlink: i.url },
      i.summary,
      hours(w.minutes),
      w.comment ?? '',
    ]);
  }
  det.getColumn(5).numFmt = '0.##';

  wb.views = [
    { x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 1, visibility: 'visible' },
  ];
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
