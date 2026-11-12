import dayjs from 'dayjs';
import {
  estimateFromRange,
  formatJiraDuration,
  isEpicTypeName,
  mapParent,
  parseJiraDuration,
  type IssueRow,
  type IssueTypeRef,
  type NamedRef,
  type Settings,
  type SourceIssue,
} from '@jpw/shared';

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

/** Issue type mặc định giống Jira: gốc là Epic → Story/Task, còn lại → Sub-task */
export function defaultIssueType(types: IssueTypeRef[], source: SourceIssue): IssueTypeRef | undefined {
  const subtasks = types.filter((t) => t.subtask);
  const standard = types.filter((t) => !t.subtask && !isEpicTypeName(t.name));
  const prefer = (list: IssueTypeRef[], names: string[]) =>
    names.map((n) => list.find((t) => t.name.toLowerCase() === n)).find(Boolean) ?? list[0];
  if (source.isEpic) return prefer(standard, ['story', 'task']);
  return subtasks[0] ?? prefer(standard, ['task', 'story']);
}

export function makeRow(opts: {
  issueTypeId: string;
  settings: Settings;
  components: NamedRef[];
  date?: dayjs.Dayjs;
}): IssueRow {
  const { settings } = opts;
  const d = (opts.date ?? dayjs()).format('YYYY-MM-DD');
  const windows = settings.workSchedule.windows;
  const compIds = settings.defaults.components
    .map((name) => opts.components.find((c) => c.name === name || c.id === name)?.id)
    .filter((x): x is string => !!x);
  return {
    rowId: newId(),
    issueTypeId: opts.issueTypeId,
    summary: '',
    description: '',
    labels: [...settings.defaults.labels],
    components: compIds,
    from: windows[0] ? `${d} ${windows[0].start}` : `${d} 08:00`,
    to: windows.length ? `${d} ${windows[windows.length - 1]!.end}` : `${d} 17:00`,
    extra: {},
  };
}

/** Estimate hiển thị: override hợp lệ hoặc tự tính từ From–To */
export function rowEstimate(
  row: IssueRow,
  settings: Settings,
): { minutes: number; text: string; auto: boolean } | null {
  const hpd = settings.workSchedule.hoursPerDay;
  if (row.estimate?.trim()) {
    const m = parseJiraDuration(row.estimate, hpd);
    return m === null ? null : { minutes: m, text: formatJiraDuration(m, hpd), auto: false };
  }
  if (row.from && row.to) {
    const r = estimateFromRange(row.from, row.to, settings.workSchedule);
    return { minutes: r.minutes, text: r.jira, auto: true };
  }
  return null;
}

/** Mô tả quan hệ cha-con sẽ được áp dụng cho dòng */
export function describeRelation(row: IssueRow, type: IssueTypeRef | undefined, source: SourceIssue): string {
  if (!type) return '';
  if (type.subtask && row.parentKey?.trim()) return `parent ${row.parentKey.trim().toUpperCase()}`;
  const r = mapParent(
    {
      key: source.key,
      issueType: source.issueType,
      isEpic: source.isEpic,
      parentKey: source.parent?.key,
      epicKey: source.epicKey,
    },
    { subtask: type.subtask, isEpic: isEpicTypeName(type.name) },
  );
  if (r.error) return `⚠ ${r.error}`;
  const parts: string[] = [];
  if (r.parentKey) parts.push(`parent ${r.parentKey}`);
  if (r.epicKey) parts.push(`epic ${r.epicKey}`);
  const relates = row.parentKey?.trim() ? row.parentKey.trim().toUpperCase() : r.relatesToKey;
  if (relates) parts.push(`relates ${relates}`);
  return parts.join(' · ');
}
