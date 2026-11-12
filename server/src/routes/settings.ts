import type { FastifyInstance } from 'fastify';
import type { DetectFieldsResponse, Settings } from '@jpw/shared';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const { settings, meta } = app.deps;

  app.get('/settings', { preHandler: app.requireAuth }, async (): Promise<Settings> => settings.get());

  app.put<{ Body: Partial<Settings> }>(
    '/settings',
    { preHandler: app.requireAuth, schema: { body: { type: 'object' } } },
    async (req): Promise<Settings> => settings.update(req.body),
  );

  app.post(
    '/settings/detect-fields',
    { preHandler: app.requireAuth },
    async (req): Promise<DetectFieldsResponse> => meta.detectFields(req.jira!, await settings.get()),
  );

  app.post<{ Body: { projectKey?: string } }>(
    '/meta/refresh',
    { preHandler: app.requireAuth, schema: { body: { type: 'object', nullable: true } } },
    async (req) => ({ cleared: meta.invalidate(req.jira!, req.body?.projectKey) }),
  );
}
