import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { config } from './config';
import { JiraClient } from './jira/client';
import { JiraError, toApiError, AppError } from './jira/errors';
import { IssueService } from './jira/issue.service';
import { MyIssuesService } from './jira/my-issues.service';
import { TimesheetService } from './jira/timesheet.service';
import { MetaService } from './jira/meta.service';
import { TtlCache } from './lib/cache';
import { CookieSessionStore, SessionStore, type Session, type SessionBackend } from './session/store';
import { cookieOptions, SESSION_COOKIE, writeSessionCookie } from './session/cookie';
import { SettingsStore } from './settings/store';
import { authRoutes } from './routes/auth';
import { contextRoutes } from './routes/context';
import { settingsRoutes } from './routes/settings';
import { metaRoutes } from './routes/meta';
import { issueRoutes } from './routes/issues';
import { myIssueRoutes } from './routes/my-issues';
import { excelRoutes } from './routes/excel';
import { worklogRoutes } from './routes/worklog';
import { sourceRoutes } from './routes/sources';
import { transitionRoutes } from './routes/transitions';

export interface AppDeps {
  sessions: SessionBackend;
  settings: SettingsStore;
  meta: MetaService;
  issues: IssueService;
  myIssues: MyIssuesService;
  timesheet: TimesheetService;
  allowedHosts: Set<string>;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    sess?: Session;
    jira?: JiraClient;
  }
}

export async function buildApp(overrides: Partial<AppDeps> = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? (config.isProd ? 'info' : 'debug'),
      // Không bao giờ ghi token / cookie ra log
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.token',
          '*.authHeader',
        ],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: false,
  });

  const deps: AppDeps = {
    sessions:
      overrides.sessions ??
      (config.sessionSecret
        ? new CookieSessionStore(config.sessionSecret, config.sessionIdleMinutes)
        : new SessionStore(config.sessionIdleMinutes)),
    settings: overrides.settings ?? new SettingsStore(config.dataDir),
    meta: overrides.meta ?? new MetaService(new TtlCache(config.cacheTtlMs)),
    issues: overrides.issues ?? new IssueService(),
    myIssues: overrides.myIssues ?? new MyIssuesService(),
    timesheet: overrides.timesheet ?? new TimesheetService(),
    allowedHosts: overrides.allowedHosts ?? config.allowedHosts,
  };
  app.decorate('deps', deps);

  await app.register(cookie);

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    const sess = deps.sessions.get(req.cookies[SESSION_COOKIE]);
    if (!sess) {
      reply.clearCookie(SESSION_COOKIE, cookieOptions());
      throw new AppError(401, 'UNAUTHENTICATED', 'Bạn chưa đăng nhập hoặc phiên đã hết hạn.');
    }
    req.sess = sess;
    req.jira = new JiraClient(sess.baseUrl, sess.authHeader, deps.allowedHosts);
    // Cookie store: gia hạn phiên (lastSeen) bằng cách ghi lại cookie
    if (deps.sessions.stateless) writeSessionCookie(deps.sessions, req, reply);
  });

  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  app.setErrorHandler((err, req, reply) => {
    const apiErr = toApiError(err);
    // Token hết hạn / bị thu hồi → huỷ session để client quay về màn login
    if (err instanceof JiraError && err.status === 401 && req.sess) {
      deps.sessions.destroy(req.sess.id);
      reply.clearCookie(SESSION_COOKIE, cookieOptions());
    }
    const e = err as Error;
    if (apiErr.status >= 500) req.log.error({ err: { message: e.message, name: e.name } }, 'request failed');
    else req.log.info({ code: apiErr.code, status: apiErr.status }, 'request rejected');
    reply.status(apiErr.status).send(apiErr);
  });

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(contextRoutes, { prefix: '/api' });
  await app.register(settingsRoutes, { prefix: '/api' });
  await app.register(metaRoutes, { prefix: '/api' });
  await app.register(issueRoutes, { prefix: '/api' });
  await app.register(myIssueRoutes, { prefix: '/api' });
  await app.register(excelRoutes, { prefix: '/api' });
  await app.register(worklogRoutes, { prefix: '/api' });
  await app.register(sourceRoutes, { prefix: '/api' });
  await app.register(transitionRoutes, { prefix: '/api' });

  app.get('/api/health', async () => ({ ok: true }));

  if (config.isProd && existsSync(config.clientDist)) {
    await app.register(fastifyStatic, { root: config.clientDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.status(404).send({ code: 'NOT_FOUND', status: 404, message: 'API không tồn tại' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
