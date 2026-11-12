import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TimesheetResponse } from '@jpw/shared';
import { buildTimesheetXlsx } from '../excel/timesheet-export';
import { todayInOffset, type TimesheetContext } from '../jira/timesheet.service';

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const rangeSchema = {
  querystring: {
    type: 'object',
    required: ['from', 'to'],
    properties: { from: DATE, to: DATE },
  },
} as const;

export async function worklogRoutes(app: FastifyInstance): Promise<void> {
  const { meta, settings, timesheet } = app.deps;

  async function context(req: FastifyRequest): Promise<TimesheetContext> {
    const conf = await settings.get();
    return {
      settings: conf,
      fieldIds: await meta.detectFields(req.jira!, conf),
      deploymentType: req.sess!.deploymentType,
      user: req.sess!.user,
      today: todayInOffset(conf.utcOffset),
    };
  }

  /** Timesheet của tôi trong khoảng ngày: issue × ngày, tổng, ngày thiếu/vượt giờ, quy tắc log work */
  app.get<{ Querystring: { from: string; to: string } }>(
    '/worklog/timesheet',
    { preHandler: app.requireAuth, schema: rangeSchema },
    async (req): Promise<TimesheetResponse> =>
      timesheet.build(req.jira!, req.query.from, req.query.to, await context(req)),
  );

  /** Xuất timesheet ra Excel */
  app.get<{ Querystring: { from: string; to: string } }>(
    '/worklog/timesheet.xlsx',
    { preHandler: app.requireAuth, schema: rangeSchema },
    async (req, reply) => {
      const data = await timesheet.build(req.jira!, req.query.from, req.query.to, await context(req));
      const buf = await buildTimesheetXlsx(data);
      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="timesheet-${data.from}_${data.to}.xlsx"`)
        .send(buf);
    },
  );
}
