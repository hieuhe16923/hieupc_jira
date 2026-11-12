import { randomUUID } from 'node:crypto';
import {
  formatJiraDuration,
  parseJiraDuration,
  wallTimeToMinutes,
  type ImportRowIssue,
  type IssueRow,
  type Settings,
  type SourceIssue,
} from '@jpw/shared';
import { normalizeHeader } from './columns';
import { normalizeDateTime, type RawExcelRow } from './parse';
import type { ExtraField, ImportLists } from './template';

/** Thông tin parent đã tra trên Jira; null = không tồn tại / không có quyền xem */
export type ParentInfo = { subtask: boolean; projectKey: string } | null;

export interface ResolveContext {
  lists: ImportLists;
  roleFieldId?: string;
  settings: Settings;
  source: SourceIssue;
  parents: Map<string, ParentInfo>;
}

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
const norm = (s: string) => s.trim().toLowerCase();
const splitList = (s?: string) =>
  (s ?? '')
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Các Parent Key hợp lệ (dạng key) cần tra trên Jira */
export function collectParentKeys(rows: RawExcelRow[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) {
    const k = r.values.parentKey?.trim().toUpperCase();
    if (k && ISSUE_KEY_RE.test(k)) keys.add(k);
  }
  return [...keys];
}

/**
 * Đổi tên → id theo dữ liệu Jira và kiểm tra từng dòng.
 * Dòng lỗi vẫn được nạp vào lưới (giá trị sai để trống) để người dùng sửa.
 */
export function resolveImportRows(
  raw: RawExcelRow[],
  ctx: ResolveContext,
): { rows: IssueRow[]; issues: ImportRowIssue[] } {
  const { lists, settings, source } = ctx;
  const hpd = settings.workSchedule.hoursPerDay;
  const firstStart = settings.workSchedule.windows[0]?.start ?? '08:00';
  const lastEnd = settings.workSchedule.windows.at(-1)?.end ?? '17:00';
  const typeByName = new Map(lists.issueTypes.map((t) => [norm(t.name), t]));
  const compByName = new Map(lists.components.map((c) => [norm(c.name), c]));
  const prioByName = new Map(lists.priorities.map((p) => [norm(p.name), p]));
  const knownLabels = new Set(lists.labels.map(norm));

  const rows: IssueRow[] = [];
  const issues: ImportRowIssue[] = [];

  for (const { line, values: v, extra: xv } of raw) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const rowId = `xl${line}-${randomUUID().slice(0, 8)}`;

    // Issue type
    const typeText = v.issueType ?? '';
    const type = typeByName.get(norm(typeText)) ?? lists.issueTypes.find((t) => t.id === typeText.trim());
    if (!typeText) errors.push('Thiếu Issue Type');
    else if (!type) errors.push(`Issue Type "${typeText}" không có trong danh sách`);

    // Summary
    const summary = (v.summary ?? '').trim();
    if (!summary) errors.push('Thiếu Summary');
    else if (summary.length > 255) warnings.push('Summary dài hơn 255 ký tự → sẽ bị cắt');

    // Parent
    let parentKey = v.parentKey?.trim().toUpperCase() || undefined;
    if (parentKey && !ISSUE_KEY_RE.test(parentKey)) {
      errors.push(`Parent Key "${v.parentKey}" không phải issue key hợp lệ`);
      parentKey = undefined;
    } else if (parentKey) {
      const info = ctx.parents.get(parentKey);
      if (info === null || info === undefined) {
        errors.push(`Parent Key ${parentKey} không tồn tại hoặc bạn không có quyền xem`);
      } else if (type?.subtask) {
        if (info.subtask) errors.push(`Parent Key ${parentKey} là sub-task → sub-task không thể làm parent`);
        else if (info.projectKey !== source.project.key) {
          errors.push(
            `Parent Key ${parentKey} thuộc project khác (${info.projectKey}) → sub-task phải cùng project`,
          );
        }
      }
    }
    if (type?.subtask && !parentKey && source.isEpic) {
      errors.push('Sub-task cần Parent Key (issue gốc là Epic nên không thể làm parent)');
    }

    // Components
    const components: string[] = [];
    const badComps: string[] = [];
    for (const name of splitList(v.components)) {
      const c = compByName.get(norm(name));
      if (c) components.push(c.id);
      else badComps.push(name);
    }
    if (badComps.length) errors.push(`Component không có trong danh sách: ${badComps.join(', ')}`);

    // Labels (cho phép label mới, chỉ cảnh báo)
    const labels = [...new Set(splitList(v.labels).map((l) => l.replace(/\s+/g, '_')))];
    const newLabels = labels.filter((l) => !knownLabels.has(norm(l)));
    if (newLabels.length && lists.labels.length)
      warnings.push(`Label mới (chưa dùng trong dự án): ${newLabels.join(', ')}`);

    // Priority
    let priorityId: string | undefined;
    if (v.priority) {
      const p = prioByName.get(norm(v.priority));
      if (p) priorityId = p.id;
      else errors.push(`Priority "${v.priority}" không có trong danh sách`);
    }

    // Role
    const extra: IssueRow['extra'] = {};
    if (v.role) {
      const roleName = lists.roleFieldName ?? 'Role';
      const allowed = type ? ctx.lists.roles.get(type.id) : undefined;
      if (!ctx.roleFieldId) warnings.push(`Chưa map field ${roleName} (Cài đặt) → bỏ qua`);
      else if (type && !allowed)
        warnings.push(`Issue type "${type.name}" không có field ${roleName} → bỏ qua`);
      else if (allowed) {
        const opt = allowed.find((a) => norm(a.name) === norm(v.role!) || a.id === v.role!.trim());
        if (opt) extra[ctx.roleFieldId] = opt.id;
        else errors.push(`${roleName} "${v.role}" không có trong danh sách của ${type!.name}`);
      }
    }

    // Custom field bắt buộc khác (cột thêm trong file mẫu)
    for (const f of lists.extraFields ?? []) {
      const text = Object.entries(xv ?? {}).find(
        ([h]) => normalizeHeader(h) === normalizeHeader(f.name),
      )?.[1];
      const onScreen = !type || f.typeIds.includes(type.id);
      if (!text) {
        if (type && f.requiredTypeIds.includes(type.id))
          errors.push(`Thiếu "${f.name}" (bắt buộc với ${type.name})`);
        continue;
      }
      if (!onScreen) {
        warnings.push(`"${f.name}" không có trên màn hình tạo ${type!.name} → bỏ qua`);
        continue;
      }
      const conv = convertExtra(f, text);
      if (conv.error) errors.push(conv.error);
      else extra[f.id] = conv.value;
    }

    // From / To
    const dt = (key: 'from' | 'to', label: string, defaultTime: string): string | undefined => {
      const s = v[key];
      if (!s) return undefined;
      if (s.startsWith('!')) {
        errors.push(`${label} "${s.slice(1)}" sai định dạng (yyyy-mm-dd hh:mm hoặc dd/mm/yyyy hh:mm)`);
        return undefined;
      }
      return s.length === 10 ? `${s} ${defaultTime}` : s;
    };
    const from = dt('from', 'From', firstStart);
    const to = dt('to', 'To', lastEnd);
    if (from && to && (wallTimeToMinutes(from) ?? 0) >= (wallTimeToMinutes(to) ?? 0)) {
      errors.push('From phải trước To');
    }

    // Estimate
    let estimate: string | undefined;
    if (v.estimate) {
      const text = v.estimate.trim().replace(',', '.');
      const m = parseJiraDuration(/^\d+(\.\d+)?$/.test(text) ? `${text}h` : text, hpd);
      if (m === null) errors.push(`Estimate "${v.estimate}" sai định dạng (VD 1d 4h, 30m, 6)`);
      else estimate = formatJiraDuration(m, hpd);
    }

    rows.push({
      rowId,
      issueTypeId: type?.id ?? '',
      summary: summary.slice(0, 255),
      description: v.description || undefined,
      labels,
      components,
      priorityId,
      from,
      to,
      estimate,
      parentKey,
      extra,
    });
    if (errors.length || warnings.length) issues.push({ line, rowId, errors, warnings });
  }
  return { rows, issues };
}

/** Giá trị ô Excel → giá trị field (id option, số, ngày…) theo schema */
function convertExtra(f: ExtraField, text: string): { value?: string | number | string[]; error?: string } {
  const multi = f.schema.type === 'array';
  if (f.allowedValues?.length) {
    const parts = multi ? splitList(text) : [text.trim()];
    const ids: string[] = [];
    const bad: string[] = [];
    for (const part of parts) {
      const a = f.allowedValues.find((x) => norm(x.name) === norm(part) || x.id === part);
      if (a) ids.push(a.id);
      else bad.push(part);
    }
    if (bad.length) return { error: `${f.name} "${bad.join(', ')}" không có trong danh sách` };
    return { value: multi ? ids : ids[0] };
  }
  if (f.schema.type === 'date' || f.schema.type === 'datetime') {
    const d = normalizeDateTime(text);
    return d ? { value: d } : { error: `${f.name} "${text}" sai định dạng ngày` };
  }
  if (f.schema.type === 'number') {
    const n = Number(text.replace(',', '.'));
    return Number.isFinite(n) ? { value: n } : { error: `${f.name} "${text}" phải là số` };
  }
  if (multi) return { value: splitList(text) };
  return { value: text };
}
