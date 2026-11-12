import {
  checkWorklogRules,
  formatJiraDuration,
  parseJiraDuration,
  toJiraDate,
  toJiraDateTime,
  wallTimeToMinutes,
  type DeploymentType,
  type DetectFieldsResponse,
  type FieldMeta,
  type FieldValue,
  type IssueChanges,
  type JiraUser,
  type MyIssue,
  type MyWorklog,
  type Settings,
  type SourceIssue,
} from '@jpw/shared';
import type { JiraClient } from './client';
import { JiraError } from './errors';
import { mapIssueType } from './issue.service';
import { mapFieldMeta } from './meta.service';
import { convertFieldValue } from './payload';

/* eslint-disable @typescript-eslint/no-explicit-any -- dữ liệu thô từ Jira REST */
type RawIssue = { id: string; key: string; fields: Record<string, any> };

const MAX_ISSUES = 200;
const PAGE = 100;

export interface MyIssuesContext {
  settings: Settings;
  fieldIds: DetectFieldsResponse;
  deploymentType: DeploymentType;
  /** Người đăng nhập (để biết worklog nào của tôi) */
  user?: JiraUser;
}

/** Field mà bảng "Công việc của tôi" quản lý (để lọc editmeta) */
function managedIds(fieldIds: DetectFieldsResponse): string[] {
  return [
    'summary',
    'description',
    'labels',
    'components',
    'priority',
    'duedate',
    'timetracking',
    fieldIds.startDate?.id,
    fieldIds.role?.id,
  ].filter((x): x is string => Boolean(x));
}

/** JQL lấy issue giao cho tôi dưới issue gốc: sub-task (parent), issue con của Epic, issue có link tới gốc */
export function buildMyIssuesJql(
  anchorKey: string,
  opts: { epicLinkId?: string; isEpic?: boolean; deploymentType: DeploymentType; withLinks: boolean },
): string {
  const scope = [`parent = ${anchorKey}`];
  if (opts.isEpic && opts.deploymentType !== 'Cloud' && opts.epicLinkId) {
    const num = /^customfield_(\d+)$/.exec(opts.epicLinkId)?.[1];
    if (num) scope.push(`cf[${num}] = ${anchorKey}`);
  }
  if (opts.withLinks) scope.push(`issue in linkedIssues("${anchorKey}")`);
  return `assignee = currentUser() AND (${scope.join(' OR ')}) ORDER BY created ASC`;
}

export function toWall(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  // "2026-11-10T08:00:00.000+0700" → "2026-11-10 08:00"; "2026-11-10" giữ nguyên
  return value.length > 10 ? value.slice(0, 16).replace('T', ' ') : value.slice(0, 10);
}

function commentText(c: unknown): string | undefined {
  if (typeof c === 'string') return c || undefined;
  // Cloud v3 ADF (phòng khi Jira trả về dạng document)
  if (c && typeof c === 'object') {
    const texts: string[] = [];
    const walk = (n: any) => {
      if (n?.text) texts.push(n.text);
      (n?.content ?? []).forEach(walk);
    };
    walk(c);
    return texts.join(' ') || undefined;
  }
  return undefined;
}

function isMe(author: any, me?: JiraUser): boolean {
  if (!author || !me) return false;
  if (me.accountId) return author.accountId === me.accountId;
  return (!!me.name && author.name === me.name) || (!!me.key && author.key === me.key);
}

export function mapWorklogs(raw: any[], me?: JiraUser): MyWorklog[] {
  return raw
    .map((w) => {
      const started = String(w.started ?? '');
      return {
        id: String(w.id),
        date: started.slice(0, 10),
        start: started.slice(0, 16).replace('T', ' '),
        minutes: Math.round(Number(w.timeSpentSeconds ?? 0) / 60),
        author: w.author?.displayName,
        mine: isMe(w.author, me),
        comment: commentText(w.comment),
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

function roleValue(raw: unknown): FieldValue {
  if (raw === null || raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw.map((x) => String(x?.id ?? x));
  if (typeof raw === 'object') return String((raw as { id?: unknown }).id ?? '');
  return String(raw);
}

function roleName(raw: any): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const one = (x: any) => String(x?.value ?? x?.name ?? x);
  return Array.isArray(raw) ? raw.map(one).join(', ') : one(raw);
}

export class MyIssuesService {
  async list(
    client: JiraClient,
    source: SourceIssue,
    ctx: MyIssuesContext,
  ): Promise<{ anchorKey: string; jql: string; issues: MyIssue[]; total: number; warnings: string[] }> {
    const anchorKey = source.issueType.subtask && source.parent ? source.parent.key : source.key;
    const warnings: string[] = [];
    const base = {
      epicLinkId: ctx.fieldIds.epicLink?.id,
      isEpic: source.isEpic,
      deploymentType: ctx.deploymentType,
    };
    let jql = buildMyIssuesJql(anchorKey, { ...base, withLinks: true });
    let found: { issues: RawIssue[]; total: number };
    try {
      found = await this.search(client, jql, ctx);
    } catch (e) {
      // linkedIssues() có thể không được hỗ trợ → thử lại chỉ với parent
      if (!(e instanceof JiraError) || e.status !== 400) throw e;
      jql = buildMyIssuesJql(anchorKey, { ...base, withLinks: false });
      found = await this.search(client, jql, ctx);
      warnings.push('Jira không hỗ trợ linkedIssues() → chỉ lấy issue con trực tiếp');
    }
    if (found.total > found.issues.length) {
      warnings.push(`Có ${found.total} issue, chỉ hiển thị ${found.issues.length} issue đầu`);
    }
    const issues = await mapLimit(found.issues, 6, (raw) => this.hydrate(client, raw, ctx));
    return { anchorKey, jql, issues, total: found.total, warnings };
  }

  /** Đọc lại 1 issue (sau khi sửa) */
  async get(client: JiraClient, key: string, ctx: MyIssuesContext): Promise<MyIssue> {
    const raw = await client.get<RawIssue>(`/rest/api/2/issue/${encodeURIComponent(key)}`, {
      fields: this.fieldList(ctx).join(','),
    });
    return this.hydrate(client, raw, ctx);
  }

  async getEditMeta(client: JiraClient, key: string, ctx: MyIssuesContext): Promise<FieldMeta[]> {
    const res = await client.get<{ fields?: Record<string, any> }>(
      `/rest/api/2/issue/${encodeURIComponent(key)}/editmeta`,
    );
    const ids = new Set(managedIds(ctx.fieldIds));
    return Object.entries(res.fields ?? {})
      .filter(([id]) => ids.has(id))
      .map(([id, raw]) => mapFieldMeta({ ...raw, fieldId: id }, id));
  }

  private fieldList(ctx: MyIssuesContext): string[] {
    return [
      'summary',
      'description',
      'issuetype',
      'status',
      'parent',
      'labels',
      'components',
      'priority',
      'duedate',
      'timetracking',
      'worklog',
      ctx.fieldIds.startDate?.id,
      ctx.fieldIds.role?.id,
    ].filter((x): x is string => Boolean(x));
  }

  private async search(
    client: JiraClient,
    jql: string,
    ctx: MyIssuesContext,
  ): Promise<{ issues: RawIssue[]; total: number }> {
    const fields = this.fieldList(ctx);
    const issues: RawIssue[] = [];
    if (ctx.deploymentType === 'Cloud') {
      let token: string | undefined;
      let more = false;
      do {
        const res = await client.get<{ issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean }>(
          '/rest/api/2/search/jql',
          { jql, fields: fields.join(','), maxResults: PAGE, nextPageToken: token },
        );
        issues.push(...(res.issues ?? []));
        token = res.nextPageToken;
        more = Boolean(token) && !res.isLast;
      } while (more && issues.length < MAX_ISSUES);
      return { issues: issues.slice(0, MAX_ISSUES), total: more ? issues.length + 1 : issues.length };
    }
    let total = 0;
    for (let startAt = 0; startAt < MAX_ISSUES; startAt += PAGE) {
      const res = await client.post<{ issues?: RawIssue[]; total?: number }>('/rest/api/2/search', {
        jql,
        fields,
        startAt,
        maxResults: PAGE,
      });
      issues.push(...(res.issues ?? []));
      total = res.total ?? issues.length;
      if (!res.issues?.length || issues.length >= total) break;
    }
    return { issues: issues.slice(0, MAX_ISSUES), total };
  }

  private async hydrate(client: JiraClient, raw: RawIssue, ctx: MyIssuesContext): Promise<MyIssue> {
    const f = raw.fields;
    const hpd = ctx.settings.workSchedule.hoursPerDay;
    let wl: any[] = f.worklog?.worklogs ?? [];
    if ((f.worklog?.total ?? 0) > wl.length) {
      const all = await client.get<{ worklogs?: any[] }>(
        `/rest/api/2/issue/${encodeURIComponent(raw.key)}/worklog`,
        { maxResults: 1000 },
      );
      wl = all.worklogs ?? wl;
    }
    let editMeta: FieldMeta[] = [];
    try {
      editMeta = await this.getEditMeta(client, raw.key, ctx);
    } catch (e) {
      if (e instanceof JiraError && e.status === 401) throw e;
    }
    const tt = f.timetracking ?? {};
    const estimateMinutes =
      tt.originalEstimateSeconds !== undefined ? Math.round(tt.originalEstimateSeconds / 60) : undefined;
    const worklogs = mapWorklogs(wl, ctx.user);
    const from = ctx.fieldIds.startDate ? toWall(f[ctx.fieldIds.startDate.id]) : undefined;
    const to = toWall(f.duedate);
    return {
      key: raw.key,
      url: `${client.baseUrl}/browse/${raw.key}`,
      summary: f.summary ?? '',
      description: typeof f.description === 'string' ? f.description : undefined,
      issueType: mapIssueType(f.issuetype),
      status: { name: f.status?.name ?? '', category: f.status?.statusCategory?.key },
      parentKey: f.parent?.key,
      labels: Array.isArray(f.labels) ? f.labels : [],
      components: Array.isArray(f.components) ? f.components.map((c: any) => String(c.id)) : [],
      priorityId: f.priority?.id ? String(f.priority.id) : undefined,
      from,
      to,
      estimate: estimateMinutes !== undefined ? formatJiraDuration(estimateMinutes, hpd) : undefined,
      estimateMinutes,
      spentMinutes: Math.round(Number(tt.timeSpentSeconds ?? 0) / 60),
      remaining:
        tt.remainingEstimateSeconds !== undefined
          ? formatJiraDuration(Math.round(tt.remainingEstimateSeconds / 60), hpd)
          : undefined,
      role: ctx.fieldIds.role ? roleValue(f[ctx.fieldIds.role.id]) : undefined,
      display: {
        components: Array.isArray(f.components) ? f.components.map((c: any) => String(c.name)) : [],
        priority: f.priority?.name,
        role: ctx.fieldIds.role ? roleName(f[ctx.fieldIds.role.id]) : undefined,
      },
      editMeta,
      worklogs,
      ruleIssues: checkWorklogRules({
        estimateMinutes,
        startDate: from,
        dueDate: to,
        worklogs,
        hoursPerDay: hpd,
      }),
    };
  }
}

/** Dựng `fields` cho PUT /issue/{key} từ các thay đổi. Hàm thuần, không gọi mạng. */
export function buildUpdateFields(
  issue: MyIssue,
  changes: IssueChanges,
  ctx: MyIssuesContext,
): { fields: Record<string, unknown>; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fields: Record<string, unknown> = {};
  const meta = new Map(issue.editMeta.map((m) => [m.id, m]));
  const hpd = ctx.settings.workSchedule.hoursPerDay;
  const set = (id: string, label: string, value: unknown) => {
    if (!meta.has(id)) errors.push(`Không có quyền sửa "${label}" trên ${issue.key}`);
    else fields[id] = value;
  };
  const has = (k: keyof IssueChanges) => Object.prototype.hasOwnProperty.call(changes, k);

  if (has('summary')) {
    const s = (changes.summary ?? '').trim();
    if (!s) errors.push('Summary không được để trống');
    else if (s.length > 255) errors.push('Summary tối đa 255 ký tự');
    else set('summary', 'Summary', s);
  }
  if (has('description')) set('description', 'Description', changes.description ?? '');
  if (has('labels')) {
    const labels = [
      ...new Set((changes.labels ?? []).map((l) => l.trim().replace(/\s+/g, '_')).filter(Boolean)),
    ];
    set('labels', 'Labels', labels);
  }
  if (has('components'))
    set(
      'components',
      'Components',
      (changes.components ?? []).map((id) => ({ id })),
    );
  if (has('priorityId') && changes.priorityId) set('priority', 'Priority', { id: changes.priorityId });

  // From / To: kiểm tra trên giá trị sau khi sửa
  const from = has('from') ? (changes.from ?? undefined) : issue.from;
  const to = has('to') ? (changes.to ?? undefined) : issue.to;
  if (from && to) {
    const a = wallTimeToMinutes(from);
    const b = wallTimeToMinutes(to, true);
    if (a === null || b === null) errors.push('From/To không hợp lệ');
    else if (a >= b) errors.push('From phải trước To');
  }
  if (has('from')) {
    const sd = ctx.fieldIds.startDate;
    if (!sd) errors.push('Chưa map field Start date (Cài đặt)');
    else if (!changes.from) set(sd.id, sd.name, null);
    else {
      const isDateTime = (meta.get(sd.id)?.schema.type ?? sd.schemaType ?? '').includes('datetime');
      const v = isDateTime ? toJiraDateTime(changes.from, ctx.settings.utcOffset) : toJiraDate(changes.from);
      if (!v) errors.push(`From không hợp lệ: "${changes.from}"`);
      else set(sd.id, sd.name, v);
    }
  }
  if (has('to')) {
    if (!changes.to) set('duedate', 'Due date', null);
    else {
      const v = toJiraDate(changes.to);
      if (!v) errors.push(`To không hợp lệ: "${changes.to}"`);
      else set('duedate', 'Due date', v);
    }
  }

  let estimateMinutes = issue.estimateMinutes;
  if (has('estimate')) {
    const raw = changes.estimate?.trim();
    const minutes = raw ? parseJiraDuration(raw, hpd) : null;
    if (raw && minutes === null) errors.push(`Estimate "${raw}" không hợp lệ (VD: 1d 4h, 30m)`);
    else if (minutes !== null) {
      estimateMinutes = minutes;
      set('timetracking', 'Time tracking', {
        originalEstimate: formatJiraDuration(minutes, hpd),
        remainingEstimate: formatJiraDuration(Math.max(0, minutes - issue.spentMinutes), hpd),
      });
    }
  }

  if (has('role')) {
    const r = ctx.fieldIds.role;
    const m = r ? meta.get(r.id) : undefined;
    if (!r) errors.push('Chưa map field Role (Cài đặt)');
    else if (!m) errors.push(`Không có quyền sửa "${r.name}" trên ${issue.key}`);
    else {
      const empty =
        changes.role === undefined ||
        changes.role === null ||
        changes.role === '' ||
        (Array.isArray(changes.role) && !changes.role.length);
      if (empty) fields[r.id] = null;
      else {
        const conv = convertFieldValue(m, changes.role, {
          deploymentType: ctx.deploymentType,
          utcOffset: ctx.settings.utcOffset,
        });
        if (conv.error) errors.push(conv.error);
        else fields[r.id] = conv.value;
      }
    }
  }

  // Cảnh báo theo quy tắc log work (không chặn lưu)
  warnings.push(
    ...checkWorklogRules({
      estimateMinutes,
      startDate: from,
      dueDate: to,
      worklogs: issue.worklogs,
      hoursPerDay: hpd,
    }),
  );
  return { fields, errors, warnings };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}
