import type { ApiError } from '@jpw/shared';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
    this.name = 'ApiClientError';
  }
}

export const UNAUTHORIZED_EVENT = 'jpw:unauthorized';

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiClientError(0, {
      code: 'NETWORK',
      status: 0,
      message: 'Không kết nối được tới server ứng dụng.',
    });
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok) {
    const body: ApiError =
      data && typeof data === 'object' && 'message' in data
        ? (data as ApiError)
        : { code: 'HTTP_' + res.status, status: res.status, message: `Lỗi HTTP ${res.status}` };
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    throw new ApiClientError(res.status, body);
  }
  return data as T;
}

async function failure(res: Response, path: string): Promise<never> {
  const data = (await res.json().catch(() => undefined)) as unknown;
  const body: ApiError =
    data && typeof data === 'object' && 'message' in data
      ? (data as ApiError)
      : { code: 'HTTP_' + res.status, status: res.status, message: `Lỗi HTTP ${res.status}` };
  if (res.status === 401 && !path.startsWith('/auth/'))
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  throw new ApiClientError(res.status, body);
}

const networkError = () =>
  new ApiClientError(0, { code: 'NETWORK', status: 0, message: 'Không kết nối được tới server ứng dụng.' });

/** Tải file (GET) và lưu với tên từ Content-Disposition */
export async function downloadFile(path: string, fallbackName: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { credentials: 'same-origin' });
  } catch {
    throw networkError();
  }
  if (!res.ok) await failure(res, path);
  const name =
    /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

/** Gửi 1 file (multipart/form-data, field "file") */
export async function uploadFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file, file.name);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', body: form });
  } catch {
    throw networkError();
  }
  if (!res.ok) await failure(res, path);
  return (await res.json()) as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.body.message;
  if (err instanceof Error) return err.message;
  return 'Lỗi không xác định';
}
