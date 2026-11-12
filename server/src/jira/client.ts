import { AppError, JiraError, type JiraErrorBody } from './errors';

export interface JiraRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Số lần retry tối đa khi gặp 429/503 */
  maxRetries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function networkReason(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err.name === 'TimeoutError') return 'quá thời gian chờ (30s).';
  const code = err.cause?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return 'không phân giải được tên miền (kiểm tra Base URL / DNS / VPN).';
  if (code === 'ECONNREFUSED') return 'máy chủ từ chối kết nối.';
  if (code === 'ECONNRESET') return 'kết nối bị ngắt giữa chừng.';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'hết thời gian kết nối.';
  if (/CERT|SSL|TLS/i.test(code)) return `lỗi chứng chỉ SSL (${code}).`;
  return err.cause?.message ?? err.message;
}

/**
 * Wrapper gọi Jira REST API.
 * - Chỉ cho gọi tới host nằm trong allowlist (chống SSRF), path phải bắt đầu bằng /rest/
 * - Không follow redirect (tránh bị chuyển sang host khác / trang SSO)
 * - Retry 429/503 với exponential backoff (tôn trọng Retry-After)
 * - Không bao giờ log header Authorization
 */
export class JiraClient {
  private readonly base: URL;

  constructor(
    baseUrl: string,
    private readonly authHeader: string,
    allowedHosts: Set<string>,
  ) {
    this.base = new URL(baseUrl);
    if (!allowedHosts.has(this.base.host.toLowerCase())) {
      throw new AppError(
        400,
        'HOST_NOT_ALLOWED',
        `Host ${this.base.host} không nằm trong danh sách được phép.`,
      );
    }
  }

  get baseUrl(): string {
    return this.base.toString().replace(/\/$/, '');
  }

  buildUrl(path: string, query?: JiraRequestOptions['query']): URL {
    if (!path.startsWith('/rest/')) throw new AppError(400, 'BAD_PATH', 'Đường dẫn API Jira không hợp lệ.');
    const url = new URL(this.baseUrl + path);
    if (url.host.toLowerCase() !== this.base.host.toLowerCase() || url.protocol !== this.base.protocol) {
      throw new AppError(400, 'HOST_NOT_ALLOWED', 'Không được phép gọi tới host khác Jira đã cấu hình.');
    }
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url;
  }

  async request<T>(path: string, opts: JiraRequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const maxRetries = opts.maxRetries ?? 3;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      'X-Atlassian-Token': 'no-check',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: opts.method ?? 'GET',
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        throw new AppError(
          502,
          'JIRA_UNREACHABLE',
          `Không kết nối được tới Jira (${this.base.host}): ${networkReason(e)}`,
        );
      }

      if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 30_000)
            : Math.min(1000 * 2 ** attempt, 10_000) + Math.floor(Math.random() * 250);
        await res.body?.cancel();
        await sleep(delay);
        continue;
      }

      if (res.status >= 300 && res.status < 400) {
        // Thường là Jira chuyển hướng sang trang đăng nhập/SSO → coi như chưa xác thực
        throw new JiraError(401, undefined, 'Jira chuyển hướng (có thể sang trang đăng nhập)');
      }

      const text = await res.text();
      const isJson = (res.headers.get('content-type') ?? '').includes('json');
      let data: unknown = undefined;
      if (text && isJson) {
        try {
          data = JSON.parse(text);
        } catch {
          data = undefined;
        }
      }

      if (!res.ok) {
        throw new JiraError(res.status, (data as JiraErrorBody) ?? undefined);
      }
      if (text && !isJson) {
        // Proxy/SSO trả về HTML với 200
        const ctype = (res.headers.get('content-type') ?? 'không rõ').split(';')[0];
        throw new AppError(
          502,
          'JIRA_NON_JSON',
          `Jira trả về dữ liệu không phải JSON (${ctype}) khi gọi ${url.origin}${url.pathname}. ` +
            'Kiểm tra lại Base URL: chỉ nhập phần gốc, VD https://ten-cong-ty.atlassian.net.',
        );
      }
      return data as T;
    }
  }

  get<T>(path: string, query?: JiraRequestOptions['query']): Promise<T> {
    return this.request<T>(path, { query });
  }

  post<T>(path: string, body: unknown, query?: JiraRequestOptions['query']): Promise<T> {
    return this.request<T>(path, { method: 'POST', body, query });
  }
}
