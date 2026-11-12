import type { ParsedInput } from './types';

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/i;
const ISSUE_KEY_IN_PATH_RE = /\/(?:browse|issues)\/([A-Z][A-Z0-9_]*-\d+)(?:[/?#]|$)/i;

/** Các segment chắc chắn là trang giao diện / API của Jira, không thuộc context path */
const UI_SEGMENT_RE =
  /\/(?:browse|projects|secure|issues|rest|plugins|servicedesk|dashboards|login\.jsp|jira\/(?:software|core|servicedesk|your-work|projects|dashboards|people|plans|filters|issues))(?:[/?#]|$)/i;

export function isJiraCloudHost(host: string): boolean {
  return /\.atlassian\.net$/i.test(host) || /\.jira\.com$/i.test(host);
}

/**
 * Chuẩn hoá Base URL người dùng dán vào:
 * - Bỏ query/hash, dấu "/" cuối
 * - Cắt bỏ phần đường dẫn giao diện (/browse/ABC-1, /jira/software/..., /secure/...)
 * - Jira Cloud (*.atlassian.net) không có context path → chỉ giữ origin
 * Ném lỗi nếu không phải URL hợp lệ.
 */
export function normalizeJiraBaseUrl(raw: string): string {
  let input = (raw ?? '').trim();
  if (input && !/^https?:\/\//i.test(input)) input = `https://${input}`;
  const url = new URL(input);
  if (isJiraCloudHost(url.host)) return url.origin;
  let path = url.pathname;
  const m = UI_SEGMENT_RE.exec(path);
  if (m) path = path.slice(0, m.index);
  path = path.replace(/\/+$/, '');
  return url.origin + path;
}

export function isIssueKey(value: string): boolean {
  return ISSUE_KEY_RE.test(value.trim());
}

export function normalizeIssueKey(value: string): string {
  return value.trim().toUpperCase();
}

function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    // Thiếu protocol: "jira.example.com/browse/ABC-1"
    if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?\//i.test(input)) {
      try {
        return new URL(`https://${input}`);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Phân tích input người dùng dán vào:
 * - Issue key trần: `ABC-123`
 * - `/browse/ABC-123`, `/projects/ABC/issues/ABC-123`
 * - URL board/backlog có `selectedIssue=ABC-123`
 * - URL có `?jql=...` hoặc `?filter=12345`
 */
export function parseJiraInput(raw: string): ParsedInput {
  const input = (raw ?? '').trim();
  if (!input) return { kind: 'invalid', reason: 'Chưa nhập URL hoặc issue key' };

  if (isIssueKey(input)) return { kind: 'issue', key: normalizeIssueKey(input) };

  const url = tryParseUrl(input);
  if (!url) {
    return { kind: 'invalid', reason: 'Không nhận dạng được URL Jira hoặc issue key (VD: ABC-123)' };
  }
  const host = url.host;
  const params = url.searchParams;

  const selected = params.get('selectedIssue') ?? params.get('issueKey');
  if (selected && isIssueKey(selected)) return { kind: 'issue', key: normalizeIssueKey(selected), host };

  const pathMatch = url.pathname.match(ISSUE_KEY_IN_PATH_RE);
  if (pathMatch?.[1]) return { kind: 'issue', key: normalizeIssueKey(pathMatch[1]), host };

  const jql = params.get('jql');
  if (jql && jql.trim()) return { kind: 'jql', jql: jql.trim(), host };

  const filter = params.get('filter');
  if (filter && /^-?\d+$/.test(filter)) return { kind: 'filter', filterId: filter, host };

  // Fallback: segment cuối của path là issue key
  const last = url.pathname.split('/').filter(Boolean).pop();
  if (last && isIssueKey(last)) return { kind: 'issue', key: normalizeIssueKey(last), host };

  return { kind: 'invalid', reason: 'URL không chứa issue key, JQL hoặc filter' };
}
