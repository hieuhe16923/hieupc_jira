import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  estimateAfterLog,
  formatJiraDuration,
  parseJiraDuration,
  toJiraDateTime,
  validateWorklogEntry,
  worklogDays,
  type DailyWorklogRequest,
  type MyIssue,
  type MyIssuesResponse,
  type UpdateIssueResult,
  type UpdateIssuesRequest,
  type UpdateIssuesResponse,
  type WorklogInput,
  type WorklogSaveResponse,
} from '@jpw/shared';
import { AppError, JiraError, toApiError } from '../jira/errors';
import { buildUpdateFields, type MyIssuesContext } from '../jira/my-issues.service';

const ISSUE_KEY = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*-\\d+$', maxLength: 40 } as const;
const NULLABLE_STR = { type: ['string', 'null'], maxLength: 40 } as const;

export async function myIssueRoutes(app: FastifyInstance): Promise<void> {
  const { meta, issues, myIssues, settings } = app.deps;

  async function context(req: FastifyRequest): Promise<MyIssuesContext> {
    const conf = await settings.get();
    return {
      settings: conf,
      fieldIds: await meta.detectFields(req.jira!, conf),
      deploymentType: req.sess!.deploymentType,
      user: req.sess!.user,
    };
  }

  /** Công việc giao cho tôi dưới issue gốc */
  app.get<{ Querystring: { source: string } }>(
    '/issues/mine',
    {
      preHandler: app.requireAuth,
      schema: { querystring: { type: 'object', required: ['source'], properties: { source: ISSUE_KEY } } },
    },
    async (req): Promise<MyIssuesResponse> => {
      const ctx = await context(req);
      const source = await issues.getSourceIssue(req.jira!, req.query.source.toUpperCase(), ctx.fieldIds);
      return myIssues.list(req.jira!, source, ctx);
    },
  );

  /** Sửa nhiều issue: chỉ gửi field thay đổi, kiểm quyền theo editmeta */
  app.post<{ Body: UpdateIssuesRequest }>(
    '/issues/update',
    {
      preHandler: app.requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              maxItems: 200,
              items: {
                type: 'object',
                required: ['key', 'changes'],
                properties: {
                  key: ISSUE_KEY,
                  changes: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      summary: { type: 'string', maxLength: 1000 },
                      description: { type: 'string', maxLength: 32000 },
                      labels: { type: 'array', items: { type: 'string', maxLength: 255 } },
                      components: { type: 'array', items: { type: 'string', maxLength: 30 } },
                      priorityId: { type: 'string', maxLength: 30 },
                      from: NULLABLE_STR,
                      to: NULLABLE_STR,
                      estimate: NULLABLE_STR,
                      role: {
                        anyOf: [
                          { type: 'string', maxLength: 60 },
                          { type: 'array', items: { type: 'string', maxLength: 60 } },
                          { type: 'null' },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (req): Promise<UpdateIssuesResponse> => {
      const client = req.jira!;
      const ctx = await context(req);
      const results: UpdateIssueResult[] = [];
      for (const { key, changes } of req.body.items) {
        const k = key.toUpperCase();
        try {
          const current = await myIssues.get(client, k, ctx);
          const built = buildUpdateFields(current, changes, ctx);
          if (built.errors.length) {
            results.push({ key: k, ok: false, errors: built.errors, warnings: [], issue: current });
            continue;
          }
          if (Object.keys(built.fields).length) {
            await client.request(`/rest/api/2/issue/${encodeURIComponent(k)}`, {
              method: 'PUT',
              body: { fields: built.fields },
            });
          }
          const updated = await myIssues.get(client, k, ctx);
          results.push({ key: k, ok: true, errors: [], warnings: updated.ruleIssues, issue: updated });
        } catch (e) {
          if (e instanceof JiraError && e.status === 401) throw e;
          const body = e instanceof JiraError ? (e.body as { errors?: Record<string, string> }) : undefined;
          const fieldErrors = Object.entries(body?.errors ?? {}).map(([id, m]) => `${id}: ${m}`);
          results.push({
            key: k,
            ok: false,
            errors: fieldErrors.length ? fieldErrors : [toApiError(e).message],
            warnings: [],
          });
        }
      }
      return { results };
    },
  );

  // ---------- Log work dưới mỗi issue ----------

  const worklogBody = {
    type: 'object',
    required: ['date', 'time', 'duration'],
    additionalProperties: false,
    properties: {
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      time: { type: 'string', pattern: '^\\d{1,2}:\\d{2}$' },
      duration: { type: 'string', minLength: 1, maxLength: 30 },
      comment: { type: 'string', maxLength: 5000 },
    },
  } as const;
  const keyParams = { type: 'object', properties: { key: ISSUE_KEY } } as const;
  const idParams = {
    type: 'object',
    properties: { key: ISSUE_KEY, id: { type: 'string', pattern: '^\\d+$' } },
  } as const;

  /** Kiểm tra quy tắc rồi trả về body gửi Jira */
  function prepareWorklog(issue: MyIssue, input: WorklogInput, ctx: MyIssuesContext, excludeId?: string) {
    const minutes = parseJiraDuration(input.duration, ctx.settings.workSchedule.hoursPerDay);
    if (minutes === null) {
      throw new AppError(
        400,
        'BAD_DURATION',
        `Thời gian "${input.duration}" không hợp lệ (VD: 1h 30m, 0.5d)`,
      );
    }
    if (excludeId && issue.worklogs.some((w) => w.id === excludeId && !w.mine)) {
      throw new AppError(403, 'NOT_OWNER', 'Chỉ được sửa/xoá worklog của chính bạn');
    }
    const errors = validateWorklogEntry({
      issue,
      date: input.date,
      minutes,
      excludeId,
      hoursPerDay: ctx.settings.workSchedule.hoursPerDay,
    });
    if (errors.length) throw new AppError(400, 'WORKLOG_RULE', errors.join('. '));
    const started = toJiraDateTime(`${input.date} ${input.time}`, ctx.settings.utcOffset);
    if (!started) throw new AppError(400, 'BAD_DATE', 'Ngày/giờ log không hợp lệ');
    return {
      started,
      timeSpentSeconds: minutes * 60,
      ...(input.comment?.trim() ? { comment: input.comment.trim() } : {}),
    };
  }

  const worklogPath = (key: string, id?: string) =>
    `/rest/api/2/issue/${encodeURIComponent(key)}/worklog${id ? `/${encodeURIComponent(id)}` : ''}`;

  /**
   * Đọc lại issue sau khi log; nếu tổng log > Estimate (hoặc chưa có Estimate)
   * → cập nhật Estimate = tổng log, Remaining = 0.
   */
  async function finish(
    req: FastifyRequest,
    key: string,
    ctx: MyIssuesContext,
    extra: Partial<WorklogSaveResponse> = {},
  ): Promise<WorklogSaveResponse> {
    const client = req.jira!;
    const hpd = ctx.settings.workSchedule.hoursPerDay;
    let issue = await myIssues.get(client, key, ctx);
    const warnings = [...(extra.warnings ?? [])];
    const total = issue.worklogs.reduce((s, w) => s + w.minutes, 0);
    const next = estimateAfterLog(issue.estimateMinutes, total);
    let estimateUpdated: WorklogSaveResponse['estimateUpdated'];
    if (next !== undefined) {
      if (!issue.editMeta.some((m) => m.id === 'timetracking')) {
        warnings.push(
          `Tổng log ${formatJiraDuration(total, hpd)} > Estimate nhưng bạn không có quyền sửa Time tracking → Estimate chưa được cập nhật`,
        );
      } else {
        try {
          await client.request(`/rest/api/2/issue/${encodeURIComponent(key)}`, {
            method: 'PUT',
            body: {
              fields: {
                timetracking: { originalEstimate: formatJiraDuration(next, hpd), remainingEstimate: '0m' },
              },
            },
          });
          estimateUpdated = { from: issue.estimate, to: formatJiraDuration(next, hpd) };
          issue = await myIssues.get(client, key, ctx);
        } catch (e) {
          if (e instanceof JiraError && e.status === 401) throw e;
          warnings.push(`Không cập nhật được Estimate: ${toApiError(e).message}`);
        }
      }
    }
    return { ...extra, issue, estimateUpdated, warnings };
  }

  app.post<{ Params: { key: string }; Body: WorklogInput }>(
    '/issues/:key/worklogs',
    { preHandler: app.requireAuth, schema: { params: keyParams, body: worklogBody } },
    async (req): Promise<WorklogSaveResponse> => {
      const ctx = await context(req);
      const key = req.params.key.toUpperCase();
      const issue = await myIssues.get(req.jira!, key, ctx);
      const body = prepareWorklog(issue, req.body, ctx);
      await req.jira!.post(worklogPath(key), body, { adjustEstimate: 'auto' });
      return finish(req, key, ctx, { created: 1 });
    },
  );

  app.put<{ Params: { key: string; id: string }; Body: WorklogInput }>(
    '/issues/:key/worklogs/:id',
    { preHandler: app.requireAuth, schema: { params: idParams, body: worklogBody } },
    async (req): Promise<WorklogSaveResponse> => {
      const ctx = await context(req);
      const key = req.params.key.toUpperCase();
      const issue = await myIssues.get(req.jira!, key, ctx);
      if (!issue.worklogs.some((w) => w.id === req.params.id)) {
        throw new AppError(404, 'WORKLOG_NOT_FOUND', 'Không tìm thấy worklog');
      }
      const body = prepareWorklog(issue, req.body, ctx, req.params.id);
      await req.jira!.request(worklogPath(key, req.params.id), {
        method: 'PUT',
        body,
        query: { adjustEstimate: 'auto' },
      });
      return finish(req, key, ctx, { updated: 1 });
    },
  );

  app.delete<{ Params: { key: string; id: string } }>(
    '/issues/:key/worklogs/:id',
    { preHandler: app.requireAuth, schema: { params: idParams } },
    async (req): Promise<WorklogSaveResponse> => {
      const ctx = await context(req);
      const key = req.params.key.toUpperCase();
      const issue = await myIssues.get(req.jira!, key, ctx);
      const w = issue.worklogs.find((x) => x.id === req.params.id);
      if (!w) throw new AppError(404, 'WORKLOG_NOT_FOUND', 'Không tìm thấy worklog');
      if (!w.mine) throw new AppError(403, 'NOT_OWNER', 'Chỉ được sửa/xoá worklog của chính bạn');
      await req.jira!.request(worklogPath(key, req.params.id), {
        method: 'DELETE',
        query: { adjustEstimate: 'auto' },
      });
      return finish(req, key, ctx, { deleted: 1 });
    },
  );

  /**
   * Log theo ngày From → To: mỗi ngày đặt TỔNG thời gian log của tôi.
   * Ngày chưa có log → tạo; có 1 log → sửa; nhiều log → sửa log đầu, xoá phần còn lại; 0 → xoá hết.
   */
  app.put<{ Params: { key: string }; Body: DailyWorklogRequest }>(
    '/issues/:key/worklogs/daily',
    {
      preHandler: app.requireAuth,
      schema: {
        params: keyParams,
        body: {
          type: 'object',
          required: ['days'],
          additionalProperties: false,
          properties: {
            days: {
              type: 'array',
              maxItems: 93,
              items: {
                type: 'object',
                required: ['date', 'duration'],
                additionalProperties: false,
                properties: {
                  date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                  duration: { type: 'string', maxLength: 30 },
                },
              },
            },
            comment: { type: 'string', maxLength: 5000 },
          },
        },
      },
    },
    async (req): Promise<WorklogSaveResponse> => {
      const ctx = await context(req);
      const client = req.jira!;
      const key = req.params.key.toUpperCase();
      const hpd = ctx.settings.workSchedule.hoursPerDay;
      const issue = await myIssues.get(client, key, ctx);
      if (!issue.from || !issue.to) {
        throw new AppError(
          400,
          'WORKLOG_RULE',
          'Issue chưa có Start date hoặc Due date → đặt From/To trước khi log work',
        );
      }
      const dayInfo = new Map(
        worklogDays(issue.from, issue.to, ctx.settings.workSchedule).map((d) => [d.date, d]),
      );

      // Validate toàn bộ trước khi ghi
      const plan: { date: string; minutes: number }[] = [];
      const errors: string[] = [];
      for (const d of req.body.days) {
        const raw = d.duration.trim();
        const minutes = !raw || raw === '0' ? 0 : parseJiraDuration(raw, hpd);
        if (minutes === null) errors.push(`${d.date}: thời gian "${raw}" không hợp lệ`);
        else if (!dayInfo.has(d.date) && minutes > 0) {
          errors.push(`${d.date}: nằm ngoài Start date → Due date`);
        } else plan.push({ date: d.date, minutes });
      }
      if (errors.length) throw new AppError(400, 'WORKLOG_RULE', errors.join('. '));

      const comment = req.body.comment?.trim();
      const counts = { created: 0, updated: 0, deleted: 0 };
      const warnings: string[] = [];
      const run = async (label: string, fn: () => Promise<unknown>, kind: keyof typeof counts) => {
        try {
          await fn();
          counts[kind]++;
        } catch (e) {
          if (e instanceof JiraError && e.status === 401) throw e;
          warnings.push(`${label}: ${toApiError(e).message}`);
        }
      };

      for (const { date, minutes } of plan) {
        const mine = issue.worklogs.filter((w) => w.mine && w.date === date);
        const current = mine.reduce((s, w) => s + w.minutes, 0);
        if (current === minutes && mine.length <= 1) continue;
        const del = (id: string) => () =>
          client.request(worklogPath(key, id), { method: 'DELETE', query: { adjustEstimate: 'auto' } });

        if (minutes === 0) {
          for (const w of mine) await run(`Xoá log ${date}`, del(w.id), 'deleted');
          continue;
        }
        const [first, ...rest] = mine;
        if (!first) {
          const started = toJiraDateTime(`${date} ${dayInfo.get(date)!.start}`, ctx.settings.utcOffset)!;
          await run(
            `Log ${date}`,
            () =>
              client.post(
                worklogPath(key),
                { started, timeSpentSeconds: minutes * 60, ...(comment ? { comment } : {}) },
                { adjustEstimate: 'auto' },
              ),
            'created',
          );
        } else {
          const started = toJiraDateTime(first.start, ctx.settings.utcOffset)!;
          await run(
            `Sửa log ${date}`,
            () =>
              client.request(worklogPath(key, first.id), {
                method: 'PUT',
                body: {
                  started,
                  timeSpentSeconds: minutes * 60,
                  ...(comment ? { comment } : first.comment ? { comment: first.comment } : {}),
                },
                query: { adjustEstimate: 'auto' },
              }),
            'updated',
          );
          for (const w of rest) await run(`Xoá log trùng ${date}`, del(w.id), 'deleted');
        }
      }
      return finish(req, key, ctx, { ...counts, warnings });
    },
  );
}
