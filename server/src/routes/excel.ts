import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  AllowedValue,
  DetectFieldsResponse,
  ExcelImportResponse,
  FieldMeta,
  IssueTypeRef,
  NamedRef,
} from '@jpw/shared';
import type { JiraClient } from '../jira/client';
import { AppError, JiraError } from '../jira/errors';
import { normalizeHeader } from '../excel/columns';
import { collectParentKeys, resolveImportRows, type ParentInfo } from '../excel/resolve';
import { MANAGED_FIELDS } from '../jira/payload';
import { parseIssuesWorkbook } from '../excel/parse';
import { buildTemplate, type ExtraField, type ImportLists } from '../excel/template';

const ISSUE_KEY = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*-\\d+$', maxLength: 40 } as const;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export async function excelRoutes(app: FastifyInstance): Promise<void> {
  const { meta, issues, settings } = app.deps;
  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5 } });

  /** Issue gốc + dữ liệu Jira cho danh sách (issue type, component, role, priority, label) */
  async function loadContext(req: FastifyRequest, sourceKey: string) {
    const client = req.jira!;
    const conf = await settings.get();
    const fieldIds = await meta.detectFields(client, conf);
    const source = await issues.getSourceIssue(client, sourceKey.toUpperCase(), fieldIds);
    const projectKey = source.project.key;
    const issueTypes = await meta.getIssueTypes(client, projectKey);
    const metas = await Promise.all(
      issueTypes.map(async (t) => ({ t, fields: await meta.getIssueTypeFields(client, projectKey, t.id) })),
    );

    const roles = new Map<string, AllowedValue[]>();
    let priorities: NamedRef[] = [];
    for (const { t, fields } of metas) {
      const role = fieldIds.role && fields.find((f) => f.id === fieldIds.role!.id);
      if (role?.allowedValues?.length) roles.set(t.id, role.allowedValues);
      const prio = fields.find((f) => f.id === 'priority');
      if (!priorities.length && prio?.allowedValues?.length) {
        priorities = prio.allowedValues.map((a) => ({ id: a.id, name: a.name }));
      }
    }
    if (!priorities.length) {
      try {
        const all = await client.get<{ id: string; name: string }[]>('/rest/api/2/priority');
        priorities = all.map((p) => ({ id: String(p.id), name: p.name }));
      } catch (e) {
        if (e instanceof JiraError && e.status === 401) throw e;
      }
    }
    let labels: string[] = [];
    try {
      labels = await meta.getProjectLabels(client, req.sess!.deploymentType, projectKey);
    } catch (e) {
      if (e instanceof JiraError && e.status === 401) throw e;
    }
    const lists: ImportLists = {
      issueTypes,
      components: await meta.getComponents(client, projectKey),
      priorities,
      roles,
      roleFieldName: fieldIds.role?.name,
      labels: labels.slice(0, 300),
      extraFields: collectExtraFields(metas, fieldIds),
    };
    return { conf, fieldIds, source, lists };
  }

  app.get<{ Querystring: { source: string } }>(
    '/excel/template',
    {
      preHandler: app.requireAuth,
      schema: { querystring: { type: 'object', required: ['source'], properties: { source: ISSUE_KEY } } },
    },
    async (req, reply) => {
      const { source, lists } = await loadContext(req, req.query.source);
      const buf = await buildTemplate({
        lists,
        sourceKey: source.key,
        sourceSummary: source.summary,
        projectKey: source.project.key,
        exampleSubtask: lists.issueTypes.find((t) => t.subtask)?.name,
        exampleTask: lists.issueTypes.find((t) => !t.subtask && !/epic/i.test(t.name))?.name,
      });
      const name = `mau-nhap-issue-${source.key}.xlsx`;
      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .send(buf);
    },
  );

  app.post<{ Querystring: { source: string } }>(
    '/excel/import',
    {
      preHandler: app.requireAuth,
      schema: { querystring: { type: 'object', required: ['source'], properties: { source: ISSUE_KEY } } },
    },
    async (req): Promise<ExcelImportResponse> => {
      if (!req.isMultipart())
        throw new AppError(400, 'NOT_MULTIPART', 'Hãy gửi file Excel (multipart/form-data).');
      const file = await req.file();
      if (!file) throw new AppError(400, 'NO_FILE', 'Chưa chọn file.');
      if (!/\.xlsx$/i.test(file.filename)) {
        throw new AppError(400, 'BAD_FILE', 'Chỉ nhận file .xlsx (Excel 2007 trở lên).');
      }
      const data = await file.toBuffer();
      if (file.file.truncated) throw new AppError(413, 'FILE_TOO_LARGE', 'File quá lớn (tối đa 5 MB).');

      const parsed = await parseIssuesWorkbook(data);
      if (parsed.fatal.length) return { rows: [], issues: [], fatal: parsed.fatal };

      const { conf, fieldIds, source, lists } = await loadContext(req, req.query.source);
      const parents = await lookupParents(req.jira!, collectParentKeys(parsed.rows));
      const resolved = resolveImportRows(parsed.rows, {
        lists,
        roleFieldId: fieldIds.role?.id,
        settings: conf,
        source,
        parents,
      });
      const fatal: string[] = [];
      const extraNames = new Set((lists.extraFields ?? []).map((f) => normalizeHeader(f.name)));
      const ignored = parsed.unknownColumns.filter((c) => !extraNames.has(normalizeHeader(c)));
      if (ignored.length) {
        resolved.issues.unshift({
          line: 1,
          errors: [],
          warnings: [`Bỏ qua cột không nhận ra: ${ignored.join(', ')}`],
        });
      }
      return { ...resolved, fatal };
    },
  );
}

/** Tra Parent Key trên Jira (từng key, song song có giới hạn) — key không tồn tại → null */
async function lookupParents(client: JiraClient, keys: string[]): Promise<Map<string, ParentInfo>> {
  const out = new Map<string, ParentInfo>();
  let i = 0;
  const worker = async () => {
    while (i < keys.length) {
      const key = keys[i++]!;
      try {
        const raw = await client.get<{
          fields: { issuetype?: { subtask?: boolean }; project?: { key?: string } };
        }>(`/rest/api/2/issue/${encodeURIComponent(key)}`, { fields: 'issuetype,project' });
        out.set(key, {
          subtask: Boolean(raw.fields.issuetype?.subtask),
          projectKey: raw.fields.project?.key ?? '',
        });
      } catch (e) {
        if (e instanceof JiraError && e.status === 401) throw e;
        out.set(key, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, keys.length) }, worker));
  return out;
}

/** Custom field bắt buộc (không có giá trị mặc định) ngoài các cột cố định — tối đa 15 field */
function collectExtraFields(
  metas: { t: IssueTypeRef; fields: FieldMeta[] }[],
  fieldIds: DetectFieldsResponse,
): ExtraField[] {
  const skip = new Set<string>([
    ...MANAGED_FIELDS,
    ...[fieldIds.startDate, fieldIds.role, fieldIds.sprint, fieldIds.epicLink]
      .filter(Boolean)
      .map((f) => f!.id),
  ]);
  const byId = new Map<string, ExtraField>();
  for (const { t, fields } of metas) {
    for (const f of fields) {
      if (skip.has(f.id)) continue;
      const required = f.required && !f.hasDefaultValue;
      const cur = byId.get(f.id);
      if (cur) {
        cur.typeIds.push(t.id);
        if (required) cur.requiredTypeIds.push(t.id);
      } else if (required) {
        byId.set(f.id, {
          id: f.id,
          name: f.name,
          schema: f.schema,
          allowedValues: f.allowedValues,
          typeIds: [t.id],
          requiredTypeIds: [t.id],
        });
      }
    }
  }
  // Field chỉ được thêm khi gặp type bắt buộc đầu tiên → bổ sung type có field nhưng gặp trước đó
  for (const ef of byId.values()) {
    for (const { t, fields } of metas) {
      if (!ef.typeIds.includes(t.id) && fields.some((f) => f.id === ef.id)) ef.typeIds.push(t.id);
    }
  }
  return [...byId.values()].slice(0, 15);
}
