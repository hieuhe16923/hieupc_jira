import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  CreateIssuesRequest,
  CreateIssuesResponse,
  FieldMeta,
  PreviewResponse,
  RowPreview,
  RowResult,
} from '@jpw/shared';
import { toJiraDateTime } from '@jpw/shared';
import { JiraError, toApiError } from '../jira/errors';
import { buildIssuePayload } from '../jira/payload';

const BATCH_SIZE = 50;
const MAX_ROWS = 500;

const createSchema = {
  body: {
    type: 'object',
    required: ['sourceKey', 'inherit', 'rows'],
    properties: {
      sourceKey: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*-\\d+$' },
      inherit: {
        type: 'object',
        properties: {
          sprint: { type: 'boolean' },
          fixVersions: { type: 'boolean' },
          components: { type: 'boolean' },
          labels: { type: 'boolean' },
        },
      },
      logWork: { type: 'boolean' },
      rows: {
        type: 'array',
        maxItems: MAX_ROWS,
        items: {
          type: 'object',
          required: ['rowId', 'issueTypeId', 'summary'],
          properties: {
            rowId: { type: 'string', maxLength: 64 },
            issueTypeId: { type: 'string', maxLength: 30 },
            summary: { type: 'string', maxLength: 1000 },
            description: { type: 'string', maxLength: 32000 },
            labels: { type: 'array', items: { type: 'string', maxLength: 255 }, default: [] },
            components: { type: 'array', items: { type: 'string', maxLength: 30 }, default: [] },
            priorityId: { type: 'string', maxLength: 30 },
            from: { type: 'string', maxLength: 30 },
            to: { type: 'string', maxLength: 30 },
            estimate: { type: 'string', maxLength: 30 },
            parentKey: { type: 'string', maxLength: 40 },
            extra: { type: 'object', default: {} },
          },
        },
      },
    },
  },
} as const;

interface BulkElementError {
  status?: number;
  failedElementNumber: number;
  elementErrors?: { errorMessages?: string[]; errors?: Record<string, string> };
}
interface BulkResponse {
  issues?: { id: string; key: string }[];
  errors?: BulkElementError[];
}

export async function issueRoutes(app: FastifyInstance): Promise<void> {
  const { meta, issues, settings } = app.deps;

  /** Dựng payload cho mọi dòng (dùng chung cho preview và create) */
  async function buildAll(req: FastifyRequest<{ Body: CreateIssuesRequest }>) {
    const client = req.jira!;
    const sess = req.sess!;
    const { sourceKey, inherit, rows } = req.body;
    const conf = await settings.get();
    const fieldIds = await meta.detectFields(client, conf);
    const source = await issues.getSourceIssue(client, sourceKey.toUpperCase(), fieldIds);
    const types = await meta.getIssueTypes(client, source.project.key);
    const typeIds = [...new Set(rows.map((r) => r.issueTypeId))].filter((id) =>
      types.some((t) => t.id === id),
    );
    const metas = new Map<string, FieldMeta[]>();
    await Promise.all(
      typeIds.map(async (id) => metas.set(id, await meta.getIssueTypeFields(client, source.project.key, id))),
    );
    const previews: RowPreview[] = rows.map((row) =>
      buildIssuePayload(row, {
        source,
        issueType: types.find((t) => t.id === row.issueTypeId),
        fields: metas.get(row.issueTypeId) ?? [],
        fieldIds,
        settings: conf,
        user: sess.user,
        deploymentType: sess.deploymentType,
        inherit: {
          sprint: Boolean(inherit.sprint),
          fixVersions: Boolean(inherit.fixVersions),
          components: Boolean(inherit.components),
          labels: Boolean(inherit.labels),
        },
        logWork: Boolean(req.body.logWork),
      }),
    );
    return { previews, metas, source, conf };
  }

  app.post<{ Body: CreateIssuesRequest }>(
    '/issues/preview',
    { preHandler: app.requireAuth, schema: createSchema },
    async (req): Promise<PreviewResponse> => ({ rows: (await buildAll(req)).previews }),
  );

  app.post<{ Body: CreateIssuesRequest }>(
    '/issues/create',
    { preHandler: app.requireAuth, schema: createSchema },
    async (req): Promise<CreateIssuesResponse> => {
      const client = req.jira!;
      const { previews, metas, conf } = await buildAll(req);
      const rowType = new Map(req.body.rows.map((r) => [r.rowId, r.issueTypeId]));
      const results = new Map<string, RowResult>();

      const fieldName = (rowId: string, fieldId: string) =>
        metas.get(rowType.get(rowId) ?? '')?.find((f) => f.id === fieldId)?.name ?? fieldId;

      for (const p of previews) {
        if (p.errors.length) {
          results.set(p.rowId, { rowId: p.rowId, ok: false, errors: p.errors, warnings: p.warnings });
        }
      }
      const sendable = previews.filter((p) => !p.errors.length);

      for (let i = 0; i < sendable.length; i += BATCH_SIZE) {
        const batch = sendable.slice(i, i + BATCH_SIZE);
        let res: BulkResponse;
        try {
          res = await client.post<BulkResponse>('/rest/api/2/issue/bulk', {
            issueUpdates: batch.map((p) => ({ fields: p.fields })),
          });
        } catch (e) {
          // Jira trả 400 khi TẤT CẢ phần tử lỗi, body vẫn có dạng {issues, errors}
          const body = e instanceof JiraError ? (e.body as BulkResponse | undefined) : undefined;
          if (e instanceof JiraError && e.status !== 401 && Array.isArray(body?.errors)) {
            res = body!;
          } else if (e instanceof JiraError && e.status === 401) {
            throw e;
          } else {
            const msg = toApiError(e).message;
            for (const p of batch) {
              results.set(p.rowId, { rowId: p.rowId, ok: false, errors: [msg], warnings: p.warnings });
            }
            continue;
          }
        }

        const failed = new Map<number, BulkElementError>();
        for (const err of res.errors ?? []) failed.set(err.failedElementNumber, err);
        const created = [...(res.issues ?? [])];
        batch.forEach((p, idx) => {
          const err = failed.get(idx);
          if (err) {
            const msgs = [
              ...(err.elementErrors?.errorMessages ?? []),
              ...Object.entries(err.elementErrors?.errors ?? {}).map(
                ([fid, m]) => `${fieldName(p.rowId, fid)}: ${m}`,
              ),
            ];
            results.set(p.rowId, {
              rowId: p.rowId,
              ok: false,
              errors: msgs.length ? msgs : [`Jira từ chối (HTTP ${err.status ?? 400})`],
              warnings: p.warnings,
            });
            return;
          }
          const issue = created.shift();
          results.set(p.rowId, {
            rowId: p.rowId,
            ok: Boolean(issue),
            key: issue?.key,
            url: issue ? `${client.baseUrl}/browse/${issue.key}` : undefined,
            errors: issue ? [] : ['Không nhận được key từ Jira'],
            warnings: [...p.warnings],
          });
        });
      }

      // Tạo link "relates to" cho Task/Story tạo từ Story/Task
      const toLink = sendable.filter((p) => p.relation.relatesToKey && results.get(p.rowId)?.ok);
      if (toLink.length) {
        let linkType = 'Relates';
        try {
          linkType = await meta.getRelatesLinkType(client);
        } catch {
          // dùng mặc định
        }
        for (const p of toLink) {
          const r = results.get(p.rowId)!;
          try {
            await client.post('/rest/api/2/issueLink', {
              type: { name: linkType },
              inwardIssue: { key: r.key },
              outwardIssue: { key: p.relation.relatesToKey },
            });
          } catch (e) {
            r.warnings.push(
              `Đã tạo ${r.key} nhưng không tạo được link tới ${p.relation.relatesToKey}: ${toApiError(e).message}`,
            );
          }
        }
      }

      // Tự log work: tuần tự từng worklog (adjustEstimate=auto → Remaining giảm dần về 0)
      for (const p of sendable) {
        const r = results.get(p.rowId);
        if (!r?.ok || !r.key || !p.worklogs?.length) continue;
        r.worklogsPlanned = p.worklogs.length;
        r.worklogsLogged = 0;
        const failed: string[] = [];
        for (const w of p.worklogs) {
          try {
            await client.post(
              `/rest/api/2/issue/${encodeURIComponent(r.key)}/worklog`,
              { started: toJiraDateTime(w.start, conf.utcOffset), timeSpentSeconds: w.minutes * 60 },
              { adjustEstimate: 'auto' },
            );
            r.worklogsLogged++;
          } catch (e) {
            if (e instanceof JiraError && e.status === 401) throw e;
            failed.push(`${w.date}: ${toApiError(e).message}`);
          }
        }
        if (failed.length) {
          r.warnings.push(
            `Đã tạo ${r.key} nhưng log work lỗi ${failed.length}/${p.worklogs.length} ngày (cần log tay): ${failed.join('; ')}`,
          );
        }
      }

      return {
        results: req.body.rows.map(
          (r) => results.get(r.rowId) ?? { rowId: r.rowId, ok: false, errors: ['Không xử lý'], warnings: [] },
        ),
      };
    },
  );
}
