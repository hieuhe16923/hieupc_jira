import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { DeploymentType, JiraUser, SourceIssue } from '@jpw/shared';
import type { Session, SessionBackend, SessionData } from './store';

/** Nội dung cookie (rút gọn tên trường để cookie nhỏ, < 4KB) */
interface Payload {
  v: 1;
  sid: string;
  a: string;
  b: string;
  u: JiraUser;
  d: DeploymentType;
  sv?: string;
  c: number;
  l: number;
  s?: { k: string; i: string; t: number }[];
}

const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_INPUT = 200;
const MAX_CACHED_ISSUES = 500;

/**
 * Session lưu trong cookie mã hoá AES-256-GCM (dành cho serverless như Vercel, nơi RAM không
 * dùng chung giữa các instance). Cookie chứa header Authorization nên PHẢI mã hoá; khoá lấy từ
 * SESSION_SECRET. Chi tiết issue gốc chỉ cache trong RAM của instance — cookie chỉ giữ key.
 *
 * Hạn chế: đăng xuất chỉ xoá cookie ở trình duyệt, server không thu hồi được cookie đã cấp
 * (cookie vẫn hết hạn theo SESSION_IDLE_MINUTES).
 */
export class CookieSessionStore implements SessionBackend {
  readonly stateless = true;
  private readonly key: Buffer;
  private readonly idleMs: number;
  private readonly issueCache = new Map<string, SourceIssue>();

  constructor(secret: string, idleMinutes: number) {
    if (secret.length < 32) throw new Error('SESSION_SECRET phải dài ít nhất 32 ký tự');
    this.key = createHash('sha256').update(secret).digest();
    this.idleMs = idleMinutes * 60_000;
  }

  create(data: SessionData): Session {
    const now = Date.now();
    return { ...data, id: randomBytes(16).toString('base64url'), createdAt: now, lastSeen: now };
  }

  get(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const p = this.open(token);
    if (!p || p.v !== 1) return undefined;
    if (Date.now() - p.l > this.idleMs) return undefined;

    const sess: Session = {
      id: p.sid,
      authHeader: p.a,
      baseUrl: p.b,
      user: p.u,
      deploymentType: p.d,
      serverVersion: p.sv,
      createdAt: p.c,
      lastSeen: Date.now(),
    };
    if (p.s?.length) {
      sess.sources = [];
      for (const s of p.s) {
        const issue = this.issueCache.get(`${p.sid}:${s.k}`);
        if (issue) sess.sources.push({ key: s.k, input: s.i, addedAt: s.t, issue });
        else (sess.pendingSources ??= []).push({ key: s.k, input: s.i, addedAt: s.t });
      }
    }
    return sess;
  }

  destroy(): void {
    // Không có trạng thái phía server — việc xoá cookie do route đảm nhiệm
  }

  cookieValue(s: Session): string {
    const sources = [
      ...(s.sources ?? []).map((e) => {
        this.cacheIssue(`${s.id}:${e.key}`, e.issue);
        return { k: e.key, i: e.input.slice(0, MAX_INPUT), t: e.addedAt };
      }),
      ...(s.pendingSources ?? []).map((e) => ({ k: e.key, i: e.input.slice(0, MAX_INPUT), t: e.addedAt })),
    ];
    const payload: Payload = {
      v: 1,
      sid: s.id,
      a: s.authHeader,
      b: s.baseUrl,
      u: s.user,
      d: s.deploymentType,
      sv: s.serverVersion,
      c: s.createdAt,
      l: s.lastSeen,
      ...(sources.length ? { s: sources } : {}),
    };
    return this.seal(payload);
  }

  private cacheIssue(k: string, issue: SourceIssue): void {
    this.issueCache.delete(k);
    this.issueCache.set(k, issue);
    if (this.issueCache.size > MAX_CACHED_ISSUES) {
      this.issueCache.delete(this.issueCache.keys().next().value!);
    }
  }

  private seal(p: Payload): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(p), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
  }

  private open(token: string): Payload | undefined {
    try {
      const buf = Buffer.from(token, 'base64url');
      if (buf.length <= IV_LEN + TAG_LEN) return undefined;
      const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, IV_LEN));
      decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
      const pt = Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
      return JSON.parse(pt.toString('utf8')) as Payload;
    } catch {
      return undefined;
    }
  }
}
