import { config } from '../config';

export const SESSION_COOKIE = 'jpw_sid';

export function cookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.cookieSecure,
  };
}
