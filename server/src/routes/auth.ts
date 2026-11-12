import type { FastifyInstance } from 'fastify';
import { isJiraCloudHost, type LoginRequest, type PublicConfig, type SessionInfo } from '@jpw/shared';
import { config, normalizeBaseUrl } from '../config';
import { cookieOptions, SESSION_COOKIE } from '../session/cookie';
import { JiraClient } from '../jira/client';
import { AppError, JiraError } from '../jira/errors';
import { mapUser } from '../jira/issue.service';
import { getServerInfo } from '../jira/meta.service';
import type { Session } from '../session/store';

function toSessionInfo(s: Session): SessionInfo {
  return {
    user: s.user,
    baseUrl: s.baseUrl,
    deploymentType: s.deploymentType,
    serverVersion: s.serverVersion,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { sessions, allowedHosts } = app.deps;

  app.get('/config', async (): Promise<PublicConfig> => ({ defaultBaseUrl: config.jiraBaseUrl }));

  app.post<{ Body: LoginRequest }>(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          additionalProperties: false,
          properties: {
            token: { type: 'string', minLength: 1, maxLength: 4096 },
            baseUrl: { type: 'string', maxLength: 500 },
            email: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req, reply): Promise<SessionInfo> => {
      const token = req.body.token.trim();
      const email = req.body.email?.trim();
      let base: URL;
      try {
        base = normalizeBaseUrl(req.body.baseUrl?.trim() || config.jiraBaseUrl);
      } catch {
        throw new AppError(400, 'BAD_BASE_URL', 'Jira Base URL không hợp lệ.');
      }
      if (!allowedHosts.has(base.host.toLowerCase())) {
        throw new AppError(
          400,
          'HOST_NOT_ALLOWED',
          `Host "${base.host}" không nằm trong danh sách được phép (JIRA_ALLOWED_HOSTS trong .env).`,
        );
      }
      const baseUrl = base.toString().replace(/\/$/, '');
      if (isJiraCloudHost(base.host) && !email) {
        throw new AppError(
          400,
          'CLOUD_NEEDS_EMAIL',
          'Đây là Jira Cloud: cần nhập Email (mục "Jira Cloud? (dùng email + API token)") và dùng API token tạo tại id.atlassian.com.',
        );
      }
      const authHeader = email
        ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
        : `Bearer ${token}`;
      const client = new JiraClient(baseUrl, authHeader, allowedHosts);

      let me: unknown;
      try {
        me = await client.get('/rest/api/2/myself');
      } catch (e) {
        if (e instanceof JiraError && (e.status === 401 || e.status === 403)) {
          throw new AppError(
            401,
            'LOGIN_FAILED',
            'Đăng nhập thất bại: token không hợp lệ, đã hết hạn hoặc bị thu hồi.',
          );
        }
        throw e;
      }
      const user = mapUser(me);
      if (!user) throw new AppError(502, 'LOGIN_FAILED', 'Jira không trả về thông tin người dùng.');
      const info = await getServerInfo(client);

      // Huỷ session cũ (nếu có) trước khi cấp session mới
      sessions.destroy(req.cookies[SESSION_COOKIE]);
      const sess = sessions.create({
        authHeader,
        baseUrl,
        user,
        deploymentType: info.deploymentType,
        serverVersion: info.version,
      });
      reply.setCookie(SESSION_COOKIE, sessions.cookieValue(sess), {
        ...cookieOptions(),
        maxAge: config.sessionIdleMinutes * 60,
      });
      req.log.info({ user: user.name ?? user.accountId }, 'login ok');
      return toSessionInfo(sess);
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    sessions.destroy(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, cookieOptions());
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: app.requireAuth }, async (req): Promise<SessionInfo> =>
    toSessionInfo(req.sess!),
  );
}
