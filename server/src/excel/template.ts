import ExcelJS from 'exceljs';
import type { AllowedValue, FieldSchema, IssueTypeRef, NamedRef } from '@jpw/shared';
import { COLUMNS, GUIDE_SHEET, ISSUES_SHEET, LISTS_SHEET, MAX_IMPORT_ROWS, type ColumnKey } from './columns';

/** Dữ liệu thật từ Jira dùng cho dropdown và để đối chiếu khi import */
export interface ImportLists {
  issueTypes: IssueTypeRef[];
  components: NamedRef[];
  priorities: NamedRef[];
  /** Giá trị Role theo issue type id (chỉ các type có field Role trên màn hình tạo) */
  roles: Map<string, AllowedValue[]>;
  roleFieldName?: string;
  /** Label đang dùng trong project */
  labels: string[];
  /** Custom field bắt buộc khác (ngoài các cột cố định) → thêm cột riêng trong file mẫu */
  extraFields?: ExtraField[];
}

export interface ExtraField {
  id: string;
  name: string;
  schema: FieldSchema;
  allowedValues?: AllowedValue[];
  /** Issue type có field này trên màn hình tạo */
  typeIds: string[];
  /** Issue type bắt buộc field này */
  requiredTypeIds: string[];
}

export interface TemplateContext {
  lists: ImportLists;
  sourceKey: string;
  sourceSummary: string;
  projectKey: string;
  /** Issue type mặc định cho ví dụ (sub-task) */
  exampleSubtask?: string;
  exampleTask?: string;
}

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
const REQUIRED_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF9C2A2A' } };
const DATA_ROWS = MAX_IMPORT_ROWS + 1; // dòng 2 … 501

function colLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function extraNote(f: ExtraField, typeNames: (ids: string[]) => string): string {
  const kind = f.allowedValues?.length
    ? f.schema.type === 'array'
      ? 'Chọn từ danh sách, nhiều giá trị cách nhau bằng dấu phẩy.'
      : 'Chọn từ danh sách.'
    : f.schema.type === 'date' || f.schema.type === 'datetime'
      ? 'Ngày (yyyy-mm-dd hoặc dd/mm/yyyy).'
      : f.schema.type === 'number'
        ? 'Số.'
        : 'Văn bản.';
  return `Custom field bắt buộc với: ${typeNames(f.requiredTypeIds)}. ${kind}`;
}

function uniqueRoleNames(roles: Map<string, AllowedValue[]>): string[] {
  const set = new Set<string>();
  for (const list of roles.values()) list.forEach((v) => set.add(v.name));
  return [...set];
}

/** Sinh file .xlsx: sheet Issues (nhập liệu + dropdown), Lists (dữ liệu Jira), Guide (hướng dẫn + ví dụ) */
export async function buildTemplate(ctx: TemplateContext): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Jira Personal Workbench';
  wb.created = new Date();
  const { lists } = ctx;
  const roleHeader = lists.roleFieldName ?? 'Role';

  // Danh sách cho sheet Lists (tính trước để sheet Issues tham chiếu vùng dropdown)
  const extras = lists.extraFields ?? [];
  const typeNames = (ids: string[]) =>
    ids.map((id) => lists.issueTypes.find((t) => t.id === id)?.name ?? id).join(', ');
  const listCols: { key: string; title: string; values: string[] }[] = [
    { key: 'issueType', title: 'Issue Type', values: lists.issueTypes.map((t) => t.name) },
    { key: 'components', title: 'Components', values: lists.components.map((c) => c.name) },
    { key: 'role', title: roleHeader, values: uniqueRoleNames(lists.roles) },
    { key: 'priority', title: 'Priority', values: lists.priorities.map((p) => p.name) },
    { key: 'labels', title: 'Labels (trong dự án)', values: lists.labels },
    ...extras
      .filter((f) => f.allowedValues?.length)
      .map((f) => ({ key: `x:${f.id}`, title: f.name, values: f.allowedValues!.map((a) => a.name) })),
  ];
  const listRange = new Map<string, string>();
  listCols.forEach((lc, i) => {
    const L = colLetter(i);
    if (lc.values.length) listRange.set(lc.key, `${LISTS_SHEET}!$${L}$2:$${L}$${lc.values.length + 1}`);
  });

  // ---------- Issues ----------
  const ws = wb.addWorksheet(ISSUES_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    ...COLUMNS.map((c) => ({ header: c.key === 'role' ? roleHeader : c.header, key: c.key, width: c.width })),
    ...extras.map((f) => ({ header: f.name, key: `x:${f.id}`, width: Math.max(18, f.name.length + 4) })),
  ];
  const header = ws.getRow(1);
  header.height = 22;
  COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = c.required ? REQUIRED_FILL : HEADER_FILL;
    cell.alignment = { vertical: 'middle' };
    cell.note = (c.required ? '(Bắt buộc) ' : '') + c.note;
  });
  extras.forEach((f, j) => {
    const i = COLUMNS.length + j;
    const cell = header.getCell(i + 1);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = REQUIRED_FILL;
    cell.alignment = { vertical: 'middle' };
    cell.note = extraNote(f, typeNames);
    const L = colLetter(i);
    const range = listRange.get(`x:${f.id}`);
    const multi = f.schema.type === 'array';
    if (f.schema.type === 'date' || f.schema.type === 'datetime') ws.getColumn(i + 1).numFmt = '@';
    if (!range) return;
    for (let row = 2; row <= DATA_ROWS; row++) {
      ws.getCell(`${L}${row}`).dataValidation = multi
        ? { type: 'list', allowBlank: true, formulae: [range], showErrorMessage: false }
        : {
            type: 'list',
            allowBlank: true,
            formulae: [range],
            showErrorMessage: true,
            errorStyle: 'stop',
            errorTitle: f.name,
            error: 'Giá trị không có trong danh sách (sheet Lists)',
          };
    }
  });

  COLUMNS.forEach((c, i) => {
    const L = colLetter(i);
    const range = listRange.get(c.key);
    const col = ws.getColumn(i + 1);
    if (c.key === 'from' || c.key === 'to' || c.key === 'parentKey' || c.key === 'estimate') {
      col.numFmt = '@'; // văn bản → Excel không tự đổi định dạng ngày/giờ
    }
    for (let row = 2; row <= DATA_ROWS; row++) {
      const cell = ws.getCell(`${L}${row}`);
      if (range && (c.key === 'issueType' || c.key === 'role' || c.key === 'priority')) {
        cell.dataValidation = {
          type: 'list',
          allowBlank: !c.required,
          formulae: [range],
          showErrorMessage: true,
          errorStyle: 'stop',
          errorTitle: c.header,
          error: 'Giá trị không có trong danh sách (sheet Lists)',
        };
      } else if (range && (c.key === 'components' || c.key === 'labels')) {
        // Nhiều giá trị "a, b" → cho phép nhập tự do, dropdown chỉ để gợi ý
        cell.dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [range],
          showErrorMessage: false,
        };
      }
    }
  });

  // ---------- Lists ----------
  const listsWs = wb.addWorksheet(LISTS_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  listCols.forEach((lc, i) => {
    const L = colLetter(i);
    const head = listsWs.getCell(`${L}1`);
    head.value = lc.title;
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = HEADER_FILL;
    lc.values.forEach((v, idx) => {
      listsWs.getCell(`${L}${idx + 2}`).value = v;
    });
    listsWs.getColumn(i + 1).width = Math.max(18, ...lc.values.map((v) => Math.min(50, v.length + 2)));
  });
  // Bảng Role theo issue type (tham khảo)
  const roleCol = listCols.length + 2;
  const rt = listsWs.getCell(1, roleCol);
  rt.value = `${roleHeader} theo Issue Type`;
  rt.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  rt.fill = HEADER_FILL;
  lists.issueTypes.forEach((t, idx) => {
    const vals = lists.roles.get(t.id);
    listsWs.getCell(idx + 2, roleCol).value = t.name;
    listsWs.getCell(idx + 2, roleCol + 1).value = vals?.length
      ? vals.map((v) => v.name).join(', ')
      : '(không có field)';
  });
  listsWs.getColumn(roleCol).width = 24;
  listsWs.getColumn(roleCol + 1).width = 50;

  // ---------- Guide ----------
  const g = wb.addWorksheet(GUIDE_SHEET);
  g.getColumn(1).width = 28;
  g.getColumn(2).width = 100;
  const title = g.getCell('A1');
  title.value = `Mẫu nhập issue cho ${ctx.sourceKey} — ${ctx.sourceSummary}`;
  title.font = { bold: true, size: 14 };
  g.getCell('A2').value =
    `Project ${ctx.projectKey}. Nhập dữ liệu ở sheet "${ISSUES_SHEET}" (tối đa ${MAX_IMPORT_ROWS} dòng), sau đó dùng nút "Nhập Excel" trên lưới tạo issue.`;
  g.getCell('A3').value =
    'Ô màu đỏ ở dòng tiêu đề là cột bắt buộc. Dropdown lấy từ dữ liệu Jira thật (sheet Lists).';

  let gr = 5;
  g.getCell(`A${gr}`).value = 'Cột';
  g.getCell(`B${gr}`).value = 'Ý nghĩa';
  [g.getCell(`A${gr}`), g.getCell(`B${gr}`)].forEach((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = HEADER_FILL;
  });
  for (const c of COLUMNS) {
    gr++;
    g.getCell(`A${gr}`).value = (c.key === 'role' ? roleHeader : c.header) + (c.required ? ' *' : '');
    g.getCell(`B${gr}`).value = c.note;
  }
  for (const f of extras) {
    gr++;
    g.getCell(`A${gr}`).value = `${f.name} *`;
    g.getCell(`B${gr}`).value = extraNote(f, typeNames);
  }

  gr += 2;
  g.getCell(`A${gr}`).value = 'Ví dụ (chép sang sheet Issues rồi sửa):';
  g.getCell(`A${gr}`).font = { bold: true };
  gr++;
  const exHeader = g.getRow(gr);
  COLUMNS.forEach((c, i) => {
    const cell = exHeader.getCell(i + 1);
    cell.value = c.key === 'role' ? roleHeader : c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = c.required ? REQUIRED_FILL : HEADER_FILL;
  });
  const firstRole = (typeName?: string) => {
    const t = lists.issueTypes.find((x) => x.name === typeName);
    return (t && lists.roles.get(t.id)?.[0]?.name) ?? '';
  };
  const examples: Record<ColumnKey, string>[] = [
    {
      issueType: ctx.exampleSubtask ?? lists.issueTypes.find((t) => t.subtask)?.name ?? '',
      parentKey: '',
      summary: 'Xây dựng API đăng nhập',
      description: 'Sub-task của issue gốc (Parent Key để trống)',
      labels: lists.labels.slice(0, 2).join(', '),
      components: lists.components[0]?.name ?? '',
      role: firstRole(ctx.exampleSubtask ?? lists.issueTypes.find((t) => t.subtask)?.name),
      priority: lists.priorities[0]?.name ?? '',
      from: '2026-11-16 08:00',
      to: '2026-11-17 17:00',
      estimate: '',
    },
    {
      issueType: ctx.exampleTask ?? lists.issueTypes.find((t) => !t.subtask)?.name ?? '',
      parentKey: ctx.sourceKey,
      summary: 'Viết tài liệu hướng dẫn',
      description: 'Task cùng Epic, link "relates to" tới Parent Key',
      labels: '',
      components: '',
      role: firstRole(ctx.exampleTask ?? lists.issueTypes.find((t) => !t.subtask)?.name),
      priority: '',
      from: '2026-11-18',
      to: '2026-11-18',
      estimate: '4h',
    },
  ];
  for (const ex of examples) {
    gr++;
    const row = g.getRow(gr);
    COLUMNS.forEach((c, i) => {
      row.getCell(i + 1).value = ex[c.key];
    });
  }
  for (let i = 3; i <= COLUMNS.length; i++) g.getColumn(i).width = Math.max(g.getColumn(i).width ?? 10, 16);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
