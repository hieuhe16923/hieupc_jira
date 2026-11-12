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

const baseUrlRaw = process.env.JIRA_BASE_URL || 'https://jira.example.com';
const base = normalizeBaseUrl(baseUrlRaw);

export const config = {
  root,
  port: Number(process.env.API_PORT || 3001),
  host: process.env.HOST || '127.0.0.1',
  jiraBaseUrl: base.toString().replace(/\/$/, ''),
  allowedHosts: parseHosts(process.env.JIRA_ALLOWED_HOSTS, base.host),
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES || 480),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data'),
  clientDist: path.join(root, 'client', 'dist'),
  isProd: process.env.NODE_ENV === 'production',
  cacheTtlMs: 10 * 60 * 1000,
};
