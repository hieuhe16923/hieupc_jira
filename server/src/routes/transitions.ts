import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MyIssue, TransitionOption, TransitionRequest } from '@jpw/shared';
import { AppError, JiraError } from '../jira/errors';
import { mapFieldMeta } from '../jira/meta.service';
import type { MyIssuesContext } from '../jira/my-issues.service';
import { convertFieldValue } from '../jira/payload';

/* eslint-disable @typescript-eslint/no-explicit-any -- dữ liệu thô từ Jira REST */

const ISSUE_KEY = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*-\\d+$', maxLength: 40 } as const;

/** Field cần hỏi người dùng khi chuyển trạng thái: bắt buộc chưa có mặc định, và Resolution (nếu có trên màn hình) */
function transitionFields(raw: any): TransitionOption['fields'] {
  return Object.entries(raw?.fields ?? {})
    .map(([id, f]) => mapFieldMeta({ ...(f as object), fieldId: id }, id))
    .filter((f) => (f.required && !f.hasDefaultValue) || f.id === 'resolution');
}

export async function transitionRoutes(app: FastifyInstance): Promise<void> {
  const { meta, myIssues, settings } = app.deps;

  async function context(req: FastifyRequest): Promise<MyIssuesContext> {
    const conf = await settings.get();
    return {
      settings: conf,
      fieldIds: await meta.detectFields(req.jira!, conf),
      deploymentType: req.sess!.deploymentType,
      user: req.sess!.user,
    };
  }

  async function load(req: FastifyRequest, key: string): Promise<TransitionOption[]> {
    const res = await req.jira!.get<{ transitions?: any[] }>(
      `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`,
      { expand: 'transitions.fields' },
    );
    return (res.transitions ?? []).map((t) => ({
      id: String(t.id),
      name: String(t.name),
      to: { name: t.to?.name ?? t.name, category: t.to?.statusCategory?.key },
      fields: transitionFields(t),
    }));
  }

  /** Các bước chuyển trạng thái user được phép thực hiện từ trạng thái hiện tại */
  app.get<{ Params: { key: string } }>(
    '/issues/:key/transitions',
    { preHandler: app.requireAuth, schema: { params: { type: 'object', properties: { key: ISSUE_KEY } } } },
    async (req): Promise<TransitionOption[]> => load(req, req.params.key.toUpperCase()),
  );

  /** Chuyển trạng thái (kèm field bắt buộc / comment nếu có) → trả về issue sau khi chuyển */
  app.post<{ Params: { key: string }; Body: TransitionRequest }>(
    '/issues/:key/transitions',
    {
      preHandler: app.requireAuth,
      schema: {
        params: { type: 'object', properties: { key: ISSUE_KEY } },
        body: {
          type: 'object',
          required: ['transitionId'],
          additionalProperties: false,
          properties: {
            transitionId: { type: 'string', pattern: '^\\d+$' },
            fields: { type: 'object' },
            comment: { type: 'string', maxLength: 10000 },
          },
        },
      },
    },
    async (req): Promise<MyIssue> => {
      const key = req.params.key.toUpperCase();
      const ctx = await context(req);
      const options = await load(req, key);
      const t = options.find((o) => o.id === req.body.transitionId);
      if (!t) {
        throw new AppError(
          409,
          'TRANSITION_UNAVAILABLE',
          'Bước chuyển trạng thái này không còn khả dụng — hãy tải lại.',
        );
      }

      const fields: Record<string, unknown> = {};
      const errors: string[] = [];
      for (const meta of t.fields) {
        const v = req.body.fields?.[meta.id];
        const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
        if (empty) {
          if (meta.required && !meta.hasDefaultValue) errors.push(`Thiếu "${meta.name}"`);
          continue;
        }
        const conv = convertFieldValue(meta, v, {
          deploymentType: ctx.deploymentType,
          utcOffset: ctx.settings.utcOffset,
        });
        if (conv.error) errors.push(conv.error);
        else fields[meta.id] = conv.value;
      }
      if (errors.length) throw new AppError(400, 'TRANSITION_FIELDS', errors.join('. '));

      const comment = req.body.comment?.trim();
      try {
        await req.jira!.post(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
          transition: { id: t.id },
          ...(Object.keys(fields).length ? { fields } : {}),
          ...(comment ? { update: { comment: [{ add: { body: comment } }] } } : {}),
        });
      } catch (e) {
        // Jira trả lỗi theo field (VD workflow validator) → đổi id field sang tên
        if (e instanceof JiraError && e.status === 400) {
          const body = e.body as { errors?: Record<string, string>; errorMessages?: string[] } | undefined;
          const msgs = [
            ...(body?.errorMessages ?? []),
            ...Object.entries(body?.errors ?? {}).map(
              ([id, m]) => `${t.fields.find((f) => f.id === id)?.name ?? id}: ${m}`,
            ),
          ];
          if (msgs.length) throw new AppError(400, 'TRANSITION_REJECTED', msgs.join('. '));
        }
        throw e;
      }
      return myIssues.get(req.jira!, key, ctx);
    },
  );
}
