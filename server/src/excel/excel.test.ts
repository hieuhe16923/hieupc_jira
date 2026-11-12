import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type SourceIssue } from '@jpw/shared';
import { cellText, normalizeDateTime, parseIssuesWorkbook, type RawExcelRow } from './parse';
import { collectParentKeys, resolveImportRows, type ParentInfo } from './resolve';
import { buildTemplate, type ImportLists } from './template';

const lists: ImportLists = {
  issueTypes: [
    { id: '10003', name: 'Sub-task Dev', subtask: true },
    { id: '10002', name: 'Task', subtask: false },
    { id: '10000', name: 'Epic', subtask: false },
  ],
  components: [
    { id: '100', name: 'Backend' },
    { id: '101', name: 'Frontend' },
  ],
  priorities: [
    { id: '2', name: 'High' },
    { id: '3', name: 'Medium' },
  ],
  roles: new Map([
    [
      '10003',
      [
        { id: '201', name: 'BE' },
        { id: '202', name: 'FE' },
      ],
    ],
  ]),
  roleFieldName: 'Role of Work',
  labels: ['SQ1', 'Pilot'],
};

const story: SourceIssue = {
  id: '1',
  key: 'PS-1',
  url: '',
  summary: 'Story',
  status: { name: 'To Do' },
  project: { id: '10', key: 'PS', name: 'PS' },
  issueType: { id: '7', name: 'Story', subtask: false },
  isEpic: false,
  sprints: [],
  components: [],
  labels: [],
  fixVersions: [],
};

async function workbook(rows: unknown[][], sheet = 'Issues'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

const HEADER = [
  'Issue Type',
  'Parent Key',
  'Summary',
  'Description',
  'Labels',
  'Components',
  'Role of Work',
  'Priority',
  'From (yyyy-mm-dd hh:mm)',
  'To (yyyy-mm-dd hh:mm)',
  'Estimate',
];

describe('buildTemplate', () => {
  it('3 sheet Issues / Lists / Guide, dropdown lấy từ Lists, Guide có 2 ví dụ', async () => {
    const buf = await buildTemplate({
      lists,
      sourceKey: 'PS-1',
      sourceSummary: 'Story',
      projectKey: 'PS',
      exampleSubtask: 'Sub-task Dev',
      exampleTask: 'Task',
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Issues', 'Lists', 'Guide']);

    const ws = wb.getWorksheet('Issues')!;
    expect(ws.getRow(1).values).toEqual([undefined, ...HEADER]);
    expect(ws.getCell('A2').dataValidation).toMatchObject({ type: 'list', formulae: ['Lists!$A$2:$A$4'] });
    expect(ws.getCell('G500').dataValidation).toMatchObject({ type: 'list', formulae: ['Lists!$C$2:$C$3'] });
    expect(ws.getCell('F2').dataValidation).toMatchObject({ type: 'list', formulae: ['Lists!$B$2:$B$3'] });
    expect(ws.getCell('F2').dataValidation.showErrorMessage).toBeFalsy(); // nhiều giá trị "a, b" được phép

    const l = wb.getWorksheet('Lists')!;
    expect([l.getCell('A2').value, l.getCell('A3').value, l.getCell('A4').value]).toEqual([
      'Sub-task Dev',
      'Task',
      'Epic',
    ]);
    expect([l.getCell('B2').value, l.getCell('D3').value, l.getCell('E2').value]).toEqual([
      'Backend',
      'Medium',
      'SQ1',
    ]);

    // Ví dụ trong Guide đọc lại được bằng parser
    const g = wb.getWorksheet('Guide')!;
    const texts: string[] = [];
    g.eachRow((row) => texts.push(cellText(row.getCell(3).value)));
    expect(texts).toContain('Xây dựng API đăng nhập');
    expect(texts).toContain('Viết tài liệu hướng dẫn');
  });
});

describe('normalizeDateTime', () => {
  it('nhận nhiều định dạng', () => {
    expect(normalizeDateTime('2026-11-10 08:00')).toBe('2026-11-10 08:00');
    expect(normalizeDateTime('2026-11-10')).toBe('2026-11-10');
    expect(normalizeDateTime('10/11/2026 13:30')).toBe('2026-11-10 13:30');
    expect(normalizeDateTime(new Date(Date.UTC(2026, 10, 10, 8, 0)))).toBe('2026-11-10 08:00');
    expect(normalizeDateTime(46336.375)).toBe('2026-11-10 09:00'); // serial Excel
    expect(normalizeDateTime('31/02/2026')).toBeNull();
    expect(normalizeDateTime('mai')).toBeNull();
    expect(normalizeDateTime(null)).toBe('');
  });
});

describe('parseIssuesWorkbook', () => {
  it('đọc dòng dữ liệu, bỏ dòng trống, nhận tên cột khác (alias), ô Date/số/richText', async () => {
    const buf = await workbook([
      ['Loại', 'Summary', 'Components', 'From', 'To', 'Estimate', 'Cột lạ'],
      [
        'Sub-task Dev',
        { richText: [{ text: 'API ' }, { text: 'login' }] },
        'Backend',
        new Date(Date.UTC(2026, 10, 10, 8)),
        '11/11/2026',
        6,
        'x',
      ],
      [],
      ['Task', 'Tài liệu', '', '2026-11-12', 'ngày mai', '1d 4h'],
    ]);
    const p = await parseIssuesWorkbook(buf);
    expect(p.fatal).toEqual([]);
    expect(p.unknownColumns).toEqual(['Cột lạ']);
    expect(p.rows).toEqual([
      {
        line: 2,
        values: {
          issueType: 'Sub-task Dev',
          summary: 'API login',
          components: 'Backend',
          from: '2026-11-10 08:00',
          to: '2026-11-11',
          estimate: '6h',
        },
        extra: { 'Cột lạ': 'x' },
      },
      {
        line: 4,
        values: {
          issueType: 'Task',
          summary: 'Tài liệu',
          from: '2026-11-12',
          to: '!ngày mai',
          estimate: '1d 4h',
        },
      },
    ]);
  });

  it('thiếu cột bắt buộc / file hỏng / quá 500 dòng → lỗi chặn', async () => {
    expect((await parseIssuesWorkbook(await workbook([['Summary'], ['x']]))).fatal[0]).toMatch(
      /thiếu cột bắt buộc: "Issue Type"/,
    );
    expect((await parseIssuesWorkbook(Buffer.from('not excel'))).fatal[0]).toMatch(/Không đọc được file/);
    const many = [['Issue Type', 'Summary'], ...Array.from({ length: 501 }, (_, i) => ['Task', `T${i}`])];
    expect((await parseIssuesWorkbook(await workbook(many))).fatal[0]).toMatch(/501 dòng, tối đa 500/);
    expect((await parseIssuesWorkbook(await workbook([HEADER]))).fatal[0]).toMatch(/chưa có dòng dữ liệu/);
  });

  it('đọc sheet đầu tiên nếu không có sheet "Issues"', async () => {
    const p = await parseIssuesWorkbook(await workbook([HEADER, ['Task', '', 'X']], 'Sheet1'));
    expect(p.rows[0]!.values).toEqual({ issueType: 'Task', summary: 'X' });
  });
});

describe('resolveImportRows', () => {
  const ctx = (parents: [string, ParentInfo][] = [], source = story) => ({
    lists,
    roleFieldId: 'customfield_10200',
    settings: DEFAULT_SETTINGS,
    source,
    parents: new Map(parents),
  });
  const row = (line: number, values: RawExcelRow['values']): RawExcelRow => ({ line, values });

  it('dòng hợp lệ: đổi tên → id, ngày chỉ có ngày → giờ ca, estimate chuẩn hoá', () => {
    const { rows, issues } = resolveImportRows(
      [
        row(2, {
          issueType: 'sub-task dev',
          summary: 'API',
          labels: 'SQ1, Pilot',
          components: 'Backend; frontend',
          role: 'fe',
          priority: 'High',
          from: '2026-11-10',
          to: '2026-11-11',
          estimate: '12',
        }),
      ],
      ctx(),
    );
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({
      issueTypeId: '10003',
      summary: 'API',
      labels: ['SQ1', 'Pilot'],
      components: ['100', '101'],
      priorityId: '2',
      from: '2026-11-10 08:00',
      to: '2026-11-11 17:00',
      estimate: '1d 4h',
      extra: { customfield_10200: '202' },
    });
  });

  it('báo lỗi rõ theo dòng: giá trị ngoài danh sách, From > To, parent sai', () => {
    const { rows, issues } = resolveImportRows(
      [
        row(3, { issueType: 'Bug', summary: '' }),
        row(4, {
          issueType: 'Sub-task Dev',
          summary: 'A',
          components: 'Mobile',
          role: 'QC',
          priority: 'Low',
        }),
        row(5, {
          issueType: 'Task',
          summary: 'B',
          from: '2026-11-12 10:00',
          to: '2026-11-12 09:00',
          estimate: 'abc',
        }),
        row(6, { issueType: 'Sub-task Dev', summary: 'C', parentKey: 'PS-404' }),
        row(7, { issueType: 'Sub-task Dev', summary: 'D', parentKey: 'ps-2' }),
        row(8, { issueType: 'Sub-task Dev', summary: 'E', parentKey: 'OT-1' }),
        row(9, { issueType: 'Task', summary: 'F', role: 'BE', labels: 'new label', to: '!mai' }),
        row(10, { issueType: 'Sub-task Dev', summary: 'G', parentKey: 'không phải key' }),
      ],
      ctx([
        ['PS-404', null],
        ['PS-2', { subtask: true, projectKey: 'PS' }],
        ['OT-1', { subtask: false, projectKey: 'OT' }],
      ]),
    );
    expect(rows).toHaveLength(8); // vẫn nạp để sửa trên lưới
    const byLine = Object.fromEntries(issues.map((i) => [i.line, i]));
    expect(byLine[3]!.errors).toEqual(['Issue Type "Bug" không có trong danh sách', 'Thiếu Summary']);
    expect(byLine[4]!.errors).toEqual([
      'Component không có trong danh sách: Mobile',
      'Priority "Low" không có trong danh sách',
      'Role of Work "QC" không có trong danh sách của Sub-task Dev',
    ]);
    expect(byLine[5]!.errors).toEqual([
      'From phải trước To',
      'Estimate "abc" sai định dạng (VD 1d 4h, 30m, 6)',
    ]);
    expect(byLine[6]!.errors).toEqual(['Parent Key PS-404 không tồn tại hoặc bạn không có quyền xem']);
    expect(byLine[7]!.errors).toEqual(['Parent Key PS-2 là sub-task → sub-task không thể làm parent']);
    expect(byLine[8]!.errors[0]).toMatch(/OT-1 thuộc project khác/);
    expect(byLine[9]).toMatchObject({
      errors: ['To "mai" sai định dạng (yyyy-mm-dd hh:mm hoặc dd/mm/yyyy hh:mm)'],
      warnings: [
        'Label mới (chưa dùng trong dự án): new_label',
        'Issue type "Task" không có field Role of Work → bỏ qua',
      ],
    });
    expect(byLine[10]!.errors).toEqual(['Parent Key "không phải key" không phải issue key hợp lệ']);
    expect(rows[1]).toMatchObject({ components: [], priorityId: undefined, extra: {} });
    expect(issues.every((i) => rows.some((r) => r.rowId === i.rowId))).toBe(true);
  });

  it('sub-task thiếu Parent Key khi issue gốc là Epic → lỗi', () => {
    const { issues } = resolveImportRows(
      [row(2, { issueType: 'Sub-task Dev', summary: 'X' })],
      ctx([], {
        ...story,
        isEpic: true,
      }),
    );
    expect(issues[0]!.errors).toEqual([
      'Sub-task cần Parent Key (issue gốc là Epic nên không thể làm parent)',
    ]);
  });

  it('collectParentKeys: chỉ key hợp lệ, không trùng, viết hoa', () => {
    expect(
      collectParentKeys([
        row(2, { parentKey: 'ps-1' }),
        row(3, { parentKey: 'PS-1' }),
        row(4, { parentKey: 'abc' }),
        row(5, {}),
      ]),
    ).toEqual(['PS-1']);
  });
});

describe('custom field bắt buộc khác (cột thêm)', () => {
  const withModule: ImportLists = {
    ...lists,
    extraFields: [
      {
        id: 'customfield_10300',
        name: 'Module',
        schema: { type: 'option' },
        allowedValues: [
          { id: '301', name: 'Core' },
          { id: '302', name: 'Portal' },
        ],
        typeIds: ['10002', '10003'],
        requiredTypeIds: ['10002'],
      },
      {
        id: 'customfield_10400',
        name: 'Ngày nghiệm thu',
        schema: { type: 'date' },
        typeIds: ['10002'],
        requiredTypeIds: ['10002'],
      },
    ],
  };

  it('file mẫu có cột Module (dropdown) và cột ngày, ghi chú bắt buộc với Task', async () => {
    const buf = await buildTemplate({
      lists: withModule,
      sourceKey: 'PS-1',
      sourceSummary: 'S',
      projectKey: 'PS',
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Issues')!;
    expect(ws.getCell('L1').value).toBe('Module');
    expect(ws.getCell('M1').value).toBe('Ngày nghiệm thu');
    expect(String(ws.getCell('L1').note)).toContain('bắt buộc với: Task');
    expect(ws.getCell('L2').dataValidation).toMatchObject({ type: 'list', formulae: ['Lists!$F$2:$F$3'] });
    expect(wb.getWorksheet('Lists')!.getCell('F1').value).toBe('Module');
  });

  it('import: đổi tên → id, thiếu ở type bắt buộc → lỗi, giá trị sai → lỗi', () => {
    const { rows, issues } = resolveImportRows(
      [
        {
          line: 2,
          values: { issueType: 'Task', summary: 'A' },
          extra: { Module: 'portal', 'Ngày nghiệm thu': '20/11/2026' },
        },
        { line: 3, values: { issueType: 'Task', summary: 'B' } },
        {
          line: 4,
          values: { issueType: 'Task', summary: 'C' },
          extra: { module: 'Mobile', 'Ngày nghiệm thu': 'x' },
        },
        { line: 5, values: { issueType: 'Sub-task Dev', summary: 'D' } },
      ],
      {
        lists: withModule,
        roleFieldId: 'customfield_10200',
        settings: DEFAULT_SETTINGS,
        source: story,
        parents: new Map(),
      },
    );
    expect(rows[0]!.extra).toEqual({ customfield_10300: '302', customfield_10400: '2026-11-20' });
    const byLine = Object.fromEntries(issues.map((i) => [i.line, i.errors]));
    expect(byLine[3]).toEqual([
      'Thiếu "Module" (bắt buộc với Task)',
      'Thiếu "Ngày nghiệm thu" (bắt buộc với Task)',
    ]);
    expect(byLine[4]).toEqual([
      'Module "Mobile" không có trong danh sách',
      'Ngày nghiệm thu "x" sai định dạng ngày',
    ]);
    expect(byLine[5]).toBeUndefined(); // sub-task không bắt buộc Module
  });
});
