import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import type { SessionBackend } from './store';

export const SESSION_COOKIE = 'jpw_sid';

export function cookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.cookieSecure,
  };
}

/** Ghi (lại) cookie session — cần sau mỗi thay đổi session khi dùng cookie store */
export function writeSessionCookie(sessions: SessionBackend, req: FastifyRequest, reply: FastifyReply): void {
  if (!req.sess) return;
  reply.setCookie(SESSION_COOKIE, sessions.cookieValue(req.sess), {
    ...cookieOptions(),
    maxAge: config.sessionIdleMinutes * 60,
  });
}
