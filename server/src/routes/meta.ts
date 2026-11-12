import type { FastifyInstance } from 'fastify';
import type {
  DetectFieldsResponse,
  DetectedField,
  IssueTypeFieldsResponse,
  IssueTypeRef,
  LabelSuggestions,
  NamedRef,
  UserOption,
} from '@jpw/shared';

const PROJECT_KEY = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*$', maxLength: 50 } as const;

export async function metaRoutes(app: FastifyInstance): Promise<void> {
  const { meta, settings } = app.deps;

  app.get<{ Params: { projectKey: string } }>(
    '/meta/:projectKey/issuetypes',
    {
      preHandler: app.requireAuth,
      schema: { params: { type: 'object', properties: { projectKey: PROJECT_KEY } } },
    },
    async (req): Promise<IssueTypeRef[]> => meta.getIssueTypes(req.jira!, req.params.projectKey),
  );

  app.get<{ Params: { projectKey: string; issueTypeId: string } }>(
    '/meta/:projectKey/issuetypes/:issueTypeId/fields',
    {
      preHandler: app.requireAuth,
      schema: {
        params: {
          type: 'object',
          properties: { projectKey: PROJECT_KEY, issueTypeId: { type: 'string', pattern: '^\\d+$' } },
        },
      },
    },
    async (req): Promise<IssueTypeFieldsResponse> => ({
      issueTypeId: req.params.issueTypeId,
      fields: await meta.getIssueTypeFields(req.jira!, req.params.projectKey, req.params.issueTypeId),
    }),
  );

  app.get<{ Params: { projectKey: string } }>(
    '/meta/:projectKey/components',
    {
      preHandler: app.requireAuth,
      schema: { params: { type: 'object', properties: { projectKey: PROJECT_KEY } } },
    },
    async (req): Promise<NamedRef[]> => meta.getComponents(req.jira!, req.params.projectKey),
  );

  app.get<{ Querystring: { q?: string; projectKey?: string } }>(
    '/meta/labels',
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: {
          type: 'object',
          properties: { q: { type: 'string', maxLength: 100 }, projectKey: PROJECT_KEY },
        },
      },
    },
    async (req): Promise<LabelSuggestions> =>
      meta.suggestProjectLabels(req.jira!, req.sess!.deploymentType, req.query.q ?? '', req.query.projectKey),
  );

  app.get<{ Querystring: { q?: string; projectKey?: string } }>(
    '/meta/users',
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: {
          type: 'object',
          properties: { q: { type: 'string', maxLength: 100 }, projectKey: PROJECT_KEY },
        },
      },
    },
    async (req): Promise<UserOption[]> =>
      meta.searchUsers(req.jira!, req.sess!.deploymentType, req.query.q ?? '', req.query.projectKey),
  );

  app.get('/meta/field-ids', { preHandler: app.requireAuth }, async (req): Promise<DetectFieldsResponse> =>
    meta.detectFields(req.jira!, await settings.get()),
  );

  /** Tất cả field của Jira (cho trang Cài đặt chọn field map) */
  app.get('/meta/fields', { preHandler: app.requireAuth }, async (req): Promise<DetectedField[]> =>
    (await meta.getFields(req.jira!))
      .map((f) => ({ id: f.id, name: f.name, schemaType: f.schema?.custom ?? f.schema?.type }))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi')),
  );
}
