import type { ApiError } from '@jpw/shared';

export interface JiraErrorBody {
  errorMessages?: string[];
  errors?: Record<string, string>;
}

export class JiraError extends Error {
  constructor(
    readonly status: number,
    readonly body: JiraErrorBody | undefined,
    message?: string,
  ) {
    super(message ?? `Jira trả về HTTP ${status}`);
    this.name = 'JiraError';
  }
}

/** Lỗi nghiệp vụ của chính ứng dụng (không phải từ Jira) */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'Dữ liệu gửi lên Jira không hợp lệ.',
  401: 'Token không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.',
  403: 'Bạn không có quyền thực hiện thao tác này trên Jira.',
  404: 'Không tìm thấy dữ liệu trên Jira (issue/project không tồn tại hoặc bạn không có quyền xem).',
  429: 'Jira đang giới hạn tần suất gọi API. Đã thử lại nhưng chưa thành công, vui lòng chờ ít phút.',
};

function detailOf(body: JiraErrorBody | undefined): string {
  if (!body) return '';
  const parts = [
    ...(body.errorMessages ?? []),
    ...Object.entries(body.errors ?? {}).map(([k, v]) => `${k}: ${v}`),
  ];
  return parts.join('; ');
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof AppError) {
    return { code: err.code, status: err.status, message: err.message };
  }
  if (err instanceof JiraError) {
    const base =
      STATUS_MESSAGES[err.status] ??
      (err.status >= 500 ? `Jira đang gặp sự cố (HTTP ${err.status}). Thử lại sau.` : err.message);
    const detail = detailOf(err.body);
    return {
      code: err.status === 401 ? 'JIRA_UNAUTHORIZED' : `JIRA_${err.status}`,
      // Jira 5xx → trả 502 (lỗi phía upstream)
      status: err.status >= 500 ? 502 : err.status,
      message: detail && err.status !== 401 ? `${base} Chi tiết: ${detail}` : base,
      jira: err.body,
    };
  }
  const e = err as { statusCode?: number; validation?: unknown; message?: string; code?: string };
  if (e?.validation) {
    return { code: 'BAD_REQUEST', status: 400, message: `Dữ liệu không hợp lệ: ${e.message}` };
  }
  if (e?.statusCode && e.statusCode < 500) {
    return {
      code: e.code ?? 'BAD_REQUEST',
      status: e.statusCode,
      message: e.message ?? 'Yêu cầu không hợp lệ',
    };
  }
  return { code: 'INTERNAL', status: 500, message: 'Lỗi không xác định phía server.' };
}
