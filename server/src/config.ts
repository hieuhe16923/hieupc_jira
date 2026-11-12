import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeJiraBaseUrl } from '@jpw/shared';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Tìm thư mục gốc repo (chứa .env / data) — hoạt động cả khi chạy từ server/ hay /app trong Docker */
function findRoot(): string {
  const candidates = [process.cwd(), path.resolve(process.cwd(), '..'), path.resolve(here, '..', '..')];
  return (
    candidates.find((c) => existsSync(path.join(c, '.env'))) ??
    candidates.find((c) => existsSync(path.join(c, 'package.json')))!
  );
}

const root = findRoot();
const envFile = path.join(root, '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // bỏ qua: biến môi trường có thể đã được set từ bên ngoài (Docker)
  }
}

export function normalizeBaseUrl(raw: string): URL {
  const url = new URL(normalizeJiraBaseUrl(raw));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Base URL phải là http(s)');
  return url;
}

function parseHosts(raw: string | undefined, fallback: string): Set<string> {
  const list = (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set(list.length ? list : [fallback.toLowerCase()]);
}

/** Jira mặc định khi không đặt JIRA_BASE_URL (VD deploy Vercel chưa khai báo biến môi trường) */
const DEFAULT_JIRA_BASE_URL = 'https://bidv-vn.atlassian.net';
const baseUrlRaw = process.env.JIRA_BASE_URL || DEFAULT_JIRA_BASE_URL;

/**
 * Khoá mã hoá cookie session. Ưu tiên SESSION_SECRET. Trên Vercel nếu chưa đặt thì dùng khoá
 * dẫn xuất từ ID project/repo (ổn định giữa các instance để không bị văng phiên) — KÉM AN TOÀN
 * hơn secret ngẫu nhiên vì các ID này không phải bí mật; nên đặt SESSION_SECRET khi có thể.
 */
function resolveSessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!process.env.VERCEL) return '';
  console.warn('[jpw] SESSION_SECRET chưa đặt — dùng khoá dự phòng, nên khai báo SESSION_SECRET trên Vercel.');
  const seed = [process.env.VERCEL_PROJECT_ID, process.env.VERCEL_GIT_REPO_ID, process.env.VERCEL_GIT_REPO_OWNER]
    .filter(Boolean)
    .join(':');
  return createHash('sha256').update(`jpw-session-fallback:${seed}`).digest('hex');
}
const base = normalizeBaseUrl(baseUrlRaw);

export const config = {
  root,
  port: Number(process.env.API_PORT || 3001),
  host: process.env.HOST || '127.0.0.1',
  jiraBaseUrl: base.toString().replace(/\/$/, ''),
  allowedHosts: parseHosts(process.env.JIRA_ALLOWED_HOSTS, base.host),
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES || 480),
  // Vercel luôn chạy HTTPS → mặc định bật Secure
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : !!process.env.VERCEL,
  /** Có giá trị → session lưu trong cookie mã hoá (bắt buộc khi chạy serverless như Vercel) */
  sessionSecret: resolveSessionSecret(),
  // Trên Vercel chỉ /tmp ghi được (và không bền) → settings ban đầu nên đặt qua SETTINGS_JSON
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : process.env.VERCEL
      ? '/tmp/jpw-data'
      : path.join(root, 'data'),
  clientDist: path.join(root, 'client', 'dist'),
  isProd: process.env.NODE_ENV === 'production',
  cacheTtlMs: 10 * 60 * 1000,
};
