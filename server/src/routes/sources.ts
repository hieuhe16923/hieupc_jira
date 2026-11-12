import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SourceEntry, SourcesResponse } from '@jpw/shared';
import { AppError } from '../jira/errors';

const ISSUE_KEY = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*-\\d+$', maxLength: 40 } as const;
const MAX_SOURCES = 20;

/** Danh sách issue gốc đã xác nhận — lưu trong session (RAM server), mất khi đăng xuất / hết phiên */
export async function sourceRoutes(app: FastifyInstance): Promise<void> {
  const { meta, issues, settings } = app.deps;

  const list = (req: FastifyRequest): SourceEntry[] => (req.sess!.sources ??= []);

  async function load(req: FastifyRequest, key: string) {
    const conf = await settings.get();
    const fieldIds = await meta.detectFields(req.jira!, conf);
    return issues.getSourceIssue(req.jira!, key.toUpperCase(), fieldIds);
  }

  app.get('/sources', { preHandler: app.requireAuth }, async (req): Promise<SourcesResponse> => ({
    sources: list(req),
  }));

  /** Xác nhận issue gốc: đọc lại từ Jira rồi thêm vào đầu danh sách (đã có → cập nhật) */
  app.post<{ Body: { key: string; input?: string } }>(
    '/sources',
    {
      preHandler: app.requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['key'],
          properties: { key: ISSUE_KEY, input: { type: 'string', maxLength: 4000 } },
        },
      },
    },
    async (req): Promise<SourcesResponse> => {
      const issue = await load(req, req.body.key);
      const sources = list(req);
      const existing = sources.find((s) => s.key === issue.key);
      if (existing) {
        existing.issue = issue;
        if (req.body.input) existing.input = req.body.input;
      } else {
        if (sources.length >= MAX_SOURCES) {
          throw new AppError(400, 'TOO_MANY_SOURCES', `Tối đa ${MAX_SOURCES} issue gốc — hãy đóng bớt tab.`);
        }
        sources.push({ key: issue.key, input: req.body.input ?? issue.key, issue, addedAt: Date.now() });
      }
      return { sources };
    },
  );

  /** Làm mới thông tin issue gốc từ Jira */
  app.post<{ Params: { key: string } }>(
    '/sources/:key/refresh',
    { preHandler: app.requireAuth, schema: { params: { type: 'object', properties: { key: ISSUE_KEY } } } },
    async (req): Promise<SourcesResponse> => {
      const sources = list(req);
      const entry = sources.find((s) => s.key === req.params.key.toUpperCase());
      if (!entry) throw new AppError(404, 'SOURCE_NOT_FOUND', 'Issue gốc không có trong danh sách');
      entry.issue = await load(req, entry.key);
      return { sources };
    },
  );

  app.delete<{ Params: { key: string } }>(
    '/sources/:key',
    { preHandler: app.requireAuth, schema: { params: { type: 'object', properties: { key: ISSUE_KEY } } } },
    async (req): Promise<SourcesResponse> => {
      const key = req.params.key.toUpperCase();
      req.sess!.sources = list(req).filter((s) => s.key !== key);
      return { sources: req.sess!.sources };
    },
  );
}
