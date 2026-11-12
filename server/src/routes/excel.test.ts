import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ExcelImportResponse, IssueRow } from '@jpw/shared';
import { buildApp } from '../app';
import { SettingsStore } from '../settings/store';

const BASE = 'https://jira.test.local';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const F = (fieldId: string, name: string, schema: object, extra: object = {}) => ({
  fieldId,
  name,
  required: false,
  schema,
  ...extra,
});
const common = [
  F('project', 'Project', { type: 'project' }, { required: true }),
  F('issuetype', 'Issue Type', { type: 'issuetype' }, { required: true }),
  F('summary', 'Summary', { type: 'string' }, { required: true }),
  F('description', 'Description', { type: 'string' }),
  F('assignee', 'Assignee', { type: 'user' }),
  F('labels', 'Labels', { type: 'array', items: 'string' }),
  F('components', 'Components', { type: 'array', items: 'component' }),
  F(
    'priority',
    'Priority',
    { type: 'priority' },
    {
      allowedValues: [
        { id: '2', name: 'High' },
        { id: '3', name: 'Medium' },
      ],
    },
  ),
  F('duedate', 'Due date', { type: 'date' }),
  F('timetracking', 'Time tracking', { type: 'timetracking' }),
  F('customfield_10015', 'Start date', { type: 'datetime' }),
];
const subFields = [
  ...common,
  F('parent', 'Parent', { type: 'issuelink' }, { required: true }),
  F(
    'customfield_10200',
    'Role of Work',
    { type: 'option' },
    {
      required: true,
      allowedValues: [
        { id: '201', value: 'BE' },
        { id: '202', value: 'FE' },
      ],
    },
  ),
];

function fakeJira(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  switch (u.pathname) {
    case '/rest/api/2/myself':
      return json({ name: 'jdoe', displayName: 'John' });
    case '/rest/api/2/serverInfo':
      return json({ version: '9.12.0', deploymentType: 'Server' });
    case '/rest/api/2/field':
      return json([
        { id: 'customfield_10200', name: 'Role of Work', custom: true, schema: { type: 'option' } },
        { id: 'customfield_10015', name: 'Start date', custom: true, schema: { type: 'datetime' } },
      ]);
    case '/rest/api/2/issue/ABC-123':
      return json({
        id: '1',
        key: 'ABC-123',
        fields: {
          summary: 'Story gốc',
          status: { name: 'To Do' },
          project: { id: '10', key: 'ABC', name: 'Alpha' },
          issuetype: { id: '7', name: 'Story', subtask: false },
          components: [],
          labels: [],
          fixVersions: [],
        },
      });
    case '/rest/api/2/issue/ABC-50':
      return json({ key: 'ABC-50', fields: { issuetype: { subtask: false }, project: { key: 'ABC' } } });
    case '/rest/api/2/issue/createmeta/ABC/issuetypes':
      return json({
        values: [
          { id: '5', name: 'Sub-task BE', subtask: true },
          { id: '3', name: 'Task', subtask: false },
        ],
        isLast: true,
      });
    case '/rest/api/2/issue/createmeta/ABC/issuetypes/5':
      return json({ values: subFields, isLast: true });
    case '/rest/api/2/issue/createmeta/ABC/issuetypes/3':
      return json({ values: common, isLast: true });
    case '/rest/api/2/project/ABC/components':
      return json([
        { id: '100', name: 'Backend' },
        { id: '101', name: 'Frontend' },
      ]);
    case '/rest/api/2/search':
      // label đang dùng trong project
      return json({ issues: [{ fields: { labels: ['SQ1', 'Pilot'] } }], total: 1, body });
    default:
      return json({ errorMessages: ['Issue does not exist'] }, 404);
  }
}

function multipart(filename: string, data: Buffer) {
  const boundary = '----jpwtest';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n',
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('Import Excel', () => {
  let app: FastifyInstance;
  let cookies: Record<string, string>;

  beforeEach(async () => {
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

  it('tải file mẫu → điền 20 dòng → import → preview: 18 dòng hợp lệ, 2 dòng báo lỗi rõ', async () => {
    const tpl = await app.inject({ method: 'GET', url: '/api/excel/template?source=ABC-123', cookies });
    expect(tpl.statusCode).toBe(200);
    expect(tpl.headers['content-type']).toContain('spreadsheetml');
    expect(tpl.headers['content-disposition']).toContain('mau-nhap-issue-ABC-123.xlsx');

    // Điền vào chính file mẫu
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl.rawPayload as unknown as ArrayBuffer);
    expect(wb.getWorksheet('Lists')!.getCell('C2').value).toBe('BE');
    const ws = wb.getWorksheet('Issues')!;
    for (let i = 0; i < 18; i++) {
      ws.getRow(i + 2).values = [
        i % 3 === 2 ? 'Task' : 'Sub-task BE',
        i % 3 === 2 ? 'ABC-50' : '',
        `Việc số ${i + 1}`,
        '',
        'SQ1',
        i % 2 ? 'Frontend' : 'Backend',
        i % 3 === 2 ? '' : i % 2 ? 'FE' : 'BE',
        'Medium',
        `2026-11-${String(10 + (i % 5)).padStart(2, '0')} 08:00`,
        `2026-11-${String(10 + (i % 5)).padStart(2, '0')} 17:00`,
        '',
      ];
    }
    ws.getRow(20).values = [
      'Sub-task BE',
      'ABC-404',
      'Parent sai',
      '',
      '',
      'Mobile',
      'QA',
      '',
      '2026-11-12 17:00',
      '2026-11-12 08:00',
    ];
    ws.getRow(21).values = ['Story', '', 'Loại sai'];
    const file = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const imp = await app.inject({
      method: 'POST',
      url: '/api/excel/import?source=ABC-123',
      cookies,
      ...multipart('nhap.xlsx', file),
    });
    expect(imp.statusCode).toBe(200);
    const data = imp.json<ExcelImportResponse>();
    expect(data.fatal).toEqual([]);
    expect(data.rows).toHaveLength(20);
    expect(data.issues.map((i) => i.line)).toEqual([20, 21]);
    expect(data.issues[0]!.errors).toEqual([
      'Parent Key ABC-404 không tồn tại hoặc bạn không có quyền xem',
      'Component không có trong danh sách: Mobile',
      'Role of Work "QA" không có trong danh sách của Sub-task BE',
      'From phải trước To',
    ]);
    expect(data.issues[1]!.errors).toEqual(['Issue Type "Story" không có trong danh sách']);
    expect(data.rows[0]).toMatchObject({
      issueTypeId: '5',
      labels: ['SQ1'],
      components: ['100'],
      priorityId: '3',
      from: '2026-11-10 08:00',
      to: '2026-11-10 17:00',
      extra: { customfield_10200: '201' },
    });

    // Đưa 18 dòng hợp lệ qua preview như luồng thường
    const valid: IssueRow[] = data.rows.slice(0, 18);
    const pv = await app.inject({
      method: 'POST',
      url: '/api/issues/preview',
      cookies,
      payload: { sourceKey: 'ABC-123', inherit: {}, rows: valid },
    });
    const previews = pv.json().rows as { errors: string[]; estimate?: string; relation: object }[];
    expect(previews.filter((p) => p.errors.length)).toEqual([]);
    expect(previews[0]).toMatchObject({ estimate: '1d', relation: { parentKey: 'ABC-123' } });
    expect(previews[2]).toMatchObject({ relation: { relatesToKey: 'ABC-50' } });
  });

  it('từ chối file không phải .xlsx và file thiếu cột bắt buộc', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/excel/import?source=ABC-123',
      cookies,
      ...multipart('a.csv', Buffer.from('a,b')),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/\.xlsx/);

    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Issues').addRow(['Summary']);
    const res = await app.inject({
      method: 'POST',
      url: '/api/excel/import?source=ABC-123',
      cookies,
      ...multipart('a.xlsx', Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)),
    });
    expect(res.json().fatal[0]).toMatch(/thiếu cột bắt buộc/);
  });
});
