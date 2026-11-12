import type { FastifyInstance } from 'fastify';
import { parseJiraInput, type ResolveRequest, type ResolveResponse } from '@jpw/shared';
import { AppError } from '../jira/errors';

export async function contextRoutes(app: FastifyInstance): Promise<void> {
  const { meta, issues, settings } = app.deps;

  app.post<{ Body: ResolveRequest }>(
    '/context/resolve',
    {
      preHandler: app.requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['input'],
          properties: { input: { type: 'string', minLength: 1, maxLength: 4000 } },
        },
      },
    },
    async (req): Promise<ResolveResponse> => {
      const client = req.jira!;
      const sess = req.sess!;
      const parsed = parseJiraInput(req.body.input);
      const warnings: string[] = [];

      if (parsed.kind === 'invalid') throw new AppError(400, 'INVALID_INPUT', parsed.reason);
      const sessionHost = new URL(sess.baseUrl).host.toLowerCase();
      if (parsed.host && parsed.host.toLowerCase() !== sessionHost) {
        warnings.push(
          `URL thuộc host "${parsed.host}" khác Jira đang đăng nhập (${sessionHost}); sẽ tra cứu trên ${sessionHost}.`,
        );
      }

      if (parsed.kind === 'issue') {
        const fieldIds = await meta.detectFields(client, await settings.get());
        if (!fieldIds.epicLink && sess.deploymentType !== 'Cloud')
          warnings.push('Không dò được field "Epic Link". Kiểm tra trong Cài đặt.');
        if (!fieldIds.sprint) warnings.push('Không dò được field "Sprint". Kiểm tra trong Cài đặt.');
        const issue = await issues.getSourceIssue(client, parsed.key, fieldIds);
        return { parsed, issue, warnings };
      }

      const jql = parsed.kind === 'jql' ? parsed.jql : await issues.getFilterJql(client, parsed.filterId);
      const result = await issues.search(client, jql, sess.deploymentType);
      if (result.total > result.issues.length)
        warnings.push(`Chỉ hiển thị ${result.issues.length}/${result.total} issue đầu tiên.`);
      return { parsed, jql, issues: result.issues, total: result.total, warnings };
    },
  );
}
