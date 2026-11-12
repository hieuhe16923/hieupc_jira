import { randomBytes } from 'node:crypto';
import type { DeploymentType, JiraUser, SourceEntry } from '@jpw/shared';

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
}

/** Session chỉ nằm trong RAM của server. Restart = phải đăng nhập lại. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly idleMs: number;

  constructor(idleMinutes: number) {
    this.idleMs = idleMinutes * 60_000;
    setInterval(() => this.sweep(), 60_000).unref();
  }

  create(data: Omit<Session, 'id' | 'createdAt' | 'lastSeen'>): Session {
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
