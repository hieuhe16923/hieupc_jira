import { randomBytes } from 'node:crypto';
import type { DeploymentType, JiraUser, SourceEntry } from '@jpw/shared';

export { CookieSessionStore } from './cookie-store';

export interface Session {
  id: string;
  /** Header Authorization đã dựng sẵn — KHÔNG bao giờ trả ra client hoặc ghi log */
  authHeader: string;
  baseUrl: string;
  user: JiraUser;
  deploymentType: DeploymentType;
  serverVersion?: string;
  createdAt: number;
  lastSeen: number;
  /** Issue gốc đã xác nhận (cache theo phiên đăng nhập, mất khi đăng xuất) */
  sources?: SourceEntry[];
  /**
   * Issue gốc chỉ còn key (khôi phục từ cookie trên instance serverless chưa có cache) —
   * route /sources sẽ đọc lại từ Jira rồi chuyển vào `sources`.
   */
  pendingSources?: { key: string; input: string; addedAt: number }[];
}

export type SessionData = Omit<Session, 'id' | 'createdAt' | 'lastSeen'>;

/** Nơi lưu session: RAM (chạy local / Docker) hoặc cookie mã hoá (serverless, VD Vercel) */
export interface SessionBackend {
  /** true = trạng thái nằm trong cookie, phải ghi lại cookie mỗi khi session thay đổi */
  readonly stateless: boolean;
  create(data: SessionData): Session;
  get(token: string | undefined): Session | undefined;
  destroy(token: string | undefined): void;
  /** Giá trị đặt vào cookie cho session này */
  cookieValue(s: Session): string;
}

/** Session chỉ nằm trong RAM của server. Restart = phải đăng nhập lại. */
export class SessionStore implements SessionBackend {
  readonly stateless = false;
  private readonly sessions = new Map<string, Session>();
  private readonly idleMs: number;

  constructor(idleMinutes: number) {
    this.idleMs = idleMinutes * 60_000;
    setInterval(() => this.sweep(), 60_000).unref();
  }

  cookieValue(s: Session): string {
    return s.id;
  }

  create(data: SessionData): Session {
    const now = Date.now();
    const session: Session = {
      ...data,
      id: randomBytes(32).toString('base64url'),
      createdAt: now,
      lastSeen: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (Date.now() - s.lastSeen > this.idleMs) {
      this.destroy(id);
      return undefined;
    }
    s.lastSeen = Date.now();
    return s;
  }

  destroy(id: string | undefined): void {
    if (!id) return;
    const s = this.sessions.get(id);
    if (s) s.authHeader = '';
    this.sessions.delete(id);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > this.idleMs) this.destroy(id);
    }
  }
}
