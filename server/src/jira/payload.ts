import {
  applySummaryTemplate,
  estimateFromRange,
  formatJiraDuration,
  isEpicTypeName,
  mapParent,
  parseJiraDuration,
  planWorklogs,
  toJiraDate,
  wallTimeToMinutes,
  toJiraDateTime,
  type DeploymentType,
  type DetectFieldsResponse,
  type FieldMeta,
  type FieldValue,
  type InheritOptions,
  type IssueRow,
  type IssueTypeRef,
  type JiraUser,
  type RowPreview,
  type Settings,
  type SourceIssue,
  type SprintRef,
  type WorklogPlanItem,
} from '@jpw/shared';

export interface BuildContext {
  source: SourceIssue;
  issueType: IssueTypeRef | undefined;
  fields: FieldMeta[];
  fieldIds: DetectFieldsResponse;
  settings: Settings;
  user: JiraUser;
  deploymentType: DeploymentType;
  inherit: InheritOptions;
  /** Tự log work: mỗi ngày làm việc From→To một worklog, tổng = Estimate */
  logWork?: boolean;
}

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

/** Các field được điều khiển bởi cột riêng của lưới / tự động — không lặp lại ở "Trường khác" */
export const MANAGED_FIELDS = new Set([
  'project',
  'issuetype',
  'summary',
  'description',
  'labels',
  'components',
  'priority',
  'assignee',
  'reporter',
  'duedate',
  'timetracking',
  'parent',
  'fixVersions',
]);

function isEmpty(v: FieldValue): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function userRef(id: string, deploymentType: DeploymentType) {
  return deploymentType === 'Cloud' ? { accountId: id } : { name: id };
}

function pickSprint(sprints: SprintRef[]): SprintRef | undefined {
  const by = (state: string) => sprints.find((s) => s.state?.toLowerCase() === state);
  return by('active') ?? by('future') ?? undefined;
}

/** Chuyển giá trị từ UI sang định dạng Jira REST theo schema của field */
export function convertFieldValue(
  meta: FieldMeta,
  value: FieldValue,
  ctx: { deploymentType: DeploymentType; utcOffset: string },
): { value?: unknown; error?: string } {
  const { type, items } = meta.schema;
  const list = Array.isArray(value) ? value.map(String) : [String(value)];
  const one = list[0] ?? '';
  switch (type) {
    case 'option':
    case 'option-with-child':
    case 'priority':
    case 'version':
    case 'component':
    case 'resolution':
    case 'securitylevel':
      return { value: { id: one } };
    case 'array':
      switch (items) {
        case 'option':
        case 'version':
        case 'component':
          return { value: list.map((id) => ({ id })) };
        case 'user':
          return { value: list.map((id) => userRef(id, ctx.deploymentType)) };
        case 'group':
          return { value: list.map((name) => ({ name })) };
        default:
          return { value: list };
      }
    case 'number': {
      const n = Number(one.replace(',', '.'));
      return Number.isFinite(n) ? { value: n } : { error: `"${meta.name}" phải là số` };
    }
    case 'date': {
      const d = toJiraDate(one);
      return d ? { value: d } : { error: `"${meta.name}" không đúng định dạng ngày (YYYY-MM-DD)` };
    }
    case 'datetime': {
      const d = toJiraDateTime(one, ctx.utcOffset);
      return d ? { value: d } : { error: `"${meta.name}" không đúng định dạng ngày giờ` };
    }
    case 'user':
      return { value: userRef(one, ctx.deploymentType) };
    case 'group':
      return { value: { name: one } };
    case 'string':
      return { value: Array.isArray(value) ? list.join(', ') : one };
    default:
      return { value };
  }
}

/** Dựng payload `fields` cho 1 dòng + validate. Hàm thuần, không gọi mạng. */
export function buildIssuePayload(row: IssueRow, ctx: BuildContext): RowPreview {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { source, issueType, settings } = ctx;
  const out: Record<string, unknown> = {};
  const meta = new Map(ctx.fields.map((f) => [f.id, f]));

  if (!issueType) {
    return { rowId: row.rowId, relation: {}, errors: ['Chưa chọn Issue type hợp lệ'], warnings };
  }
  const typeName = issueType.name;
  const setIfOnScreen = (id: string, value: unknown, label: string) => {
    if (meta.size && !meta.has(id)) {
      warnings.push(`"${label}" không có trên màn hình tạo ${typeName} → bỏ qua`);
      return;
    }
    out[id] = value;
  };

  out.project = { key: source.project.key };
  out.issuetype = { id: issueType.id };

  // Summary
  const rawSummary = (row.summary ?? '').trim();
  if (!rawSummary) errors.push('Thiếu Summary');
  const summary = applySummaryTemplate(settings.defaults.summaryTemplate, rawSummary);
  if (summary.length > 255) errors.push(`Summary dài ${summary.length} ký tự (tối đa 255)`);
  out.summary = summary;

  if (row.description?.trim()) setIfOnScreen('description', row.description.trim(), 'Description');

  // Assignee = tôi
  const myId = ctx.deploymentType === 'Cloud' ? ctx.user.accountId : ctx.user.name;
  if (myId) setIfOnScreen('assignee', userRef(myId, ctx.deploymentType), 'Assignee');

  // Labels
  const labels = new Set(row.labels.map((l) => l.trim().replace(/\s+/g, '_')).filter(Boolean));
  if (ctx.inherit.labels) source.labels.forEach((l) => labels.add(l));
  if (labels.size) setIfOnScreen('labels', [...labels], 'Labels');

  // Components
  const comps = new Set(row.components);
  if (ctx.inherit.components) source.components.forEach((c) => comps.add(c.id));
  if (comps.size)
    setIfOnScreen(
      'components',
      [...comps].map((id) => ({ id })),
      'Components',
    );

  if (ctx.inherit.fixVersions && source.fixVersions.length) {
    setIfOnScreen(
      'fixVersions',
      source.fixVersions.map((v) => ({ id: v.id })),
      'Fix versions',
    );
  }

  if (row.priorityId) setIfOnScreen('priority', { id: row.priorityId }, 'Priority');

  // From / To / Estimate
  const from = row.from?.trim() || undefined;
  const to = row.to?.trim() || undefined;
  const fromMin = from ? wallTimeToMinutes(from) : null;
  const toMin = to ? wallTimeToMinutes(to, true) : null;
  if (from && fromMin === null) errors.push(`From không hợp lệ: "${from}"`);
  if (to && toMin === null) errors.push(`To không hợp lệ: "${to}"`);
  const fromOk = fromMin !== null;
  const toOk = toMin !== null;
  if (fromOk && toOk && fromMin >= toMin) errors.push('From phải trước To');

  if (fromOk) {
    const sd = ctx.fieldIds.startDate;
    const sdMeta = sd ? meta.get(sd.id) : undefined;
    if (!sd) warnings.push('Chưa map field Start date (Cài đặt) → bỏ qua From');
    else if (!sdMeta && meta.size)
      warnings.push(`"${sd.name}" không có trên màn hình tạo ${typeName} → bỏ qua From`);
    else {
      const isDateTime = (sdMeta?.schema.type ?? sd.schemaType ?? '').includes('datetime');
      out[sd.id] = isDateTime ? toJiraDateTime(from!, settings.utcOffset) : toJiraDate(from!);
    }
  }
  if (toOk) setIfOnScreen('duedate', toJiraDate(to!), 'Due date');

  const hpd = settings.workSchedule.hoursPerDay;
  let estimate: string | undefined;
  let estimateMinutes: number | undefined;
  if (row.estimate?.trim()) {
    const minutes = parseJiraDuration(row.estimate, hpd);
    if (minutes === null) errors.push(`Estimate "${row.estimate}" không hợp lệ (VD: 1d 4h, 30m)`);
    else {
      estimateMinutes = minutes;
      estimate = formatJiraDuration(minutes, hpd);
    }
  } else if (fromOk && toOk) {
    const r = estimateFromRange(from!, to!, settings.workSchedule);
    if (r.minutes > 0) {
      estimateMinutes = r.minutes;
      estimate = r.jira;
    } else warnings.push('Khoảng From–To không có giờ làm việc → không đặt estimate');
  }
  if (estimate) {
    setIfOnScreen(
      'timetracking',
      { originalEstimate: estimate, remainingEstimate: estimate },
      'Time tracking',
    );
  }

  // Tự log work: Estimate = tổng log work, mọi worklog nằm trong From (Start date) → To (Due date)
  let worklogs: WorklogPlanItem[] | undefined;
  if (ctx.logWork) {
    if (!fromOk || !toOk) errors.push('Tự log work cần nhập From và To');
    else if (!estimateMinutes) errors.push('Tự log work cần Estimate > 0');
    else if (!('timetracking' in out))
      errors.push(
        'Không đặt được Estimate (Time tracking không có trên màn hình tạo) → không thể tự log work',
      );
    else {
      worklogs = planWorklogs(from!, to!, settings.workSchedule, estimateMinutes);
      if (!worklogs.length) errors.push('Không có ngày làm việc nào trong From → To để log work');
      else {
        const maxDay = Math.max(...worklogs.map((w) => w.minutes));
        if (maxDay > hpd * 60) {
          warnings.push(
            `Estimate ${estimate} vượt giờ làm việc From → To: có ngày log ${formatJiraDuration(maxDay, 24)}`,
          );
        }
      }
    }
  }

  // Quan hệ cha-con
  const isSubtask = issueType.subtask;
  let relation = mapParent(
    {
      key: source.key,
      issueType: source.issueType,
      isEpic: source.isEpic,
      parentKey: source.parent?.key,
      epicKey: source.epicKey,
    },
    { subtask: isSubtask, isEpic: isEpicTypeName(typeName) },
  );
  const overrideParent = row.parentKey?.trim().toUpperCase();
  if (overrideParent) {
    if (!ISSUE_KEY_RE.test(overrideParent))
      errors.push(`Parent "${row.parentKey}" không phải issue key hợp lệ`);
    else if (isSubtask) relation = { parentKey: overrideParent };
    else relation = { ...relation, error: undefined, relatesToKey: overrideParent };
  }
  if (relation.error) errors.push(relation.error);

  if (isSubtask && relation.parentKey) {
    out.parent = { key: relation.parentKey };
  } else if (!isSubtask && relation.epicKey) {
    if (ctx.deploymentType === 'Cloud') {
      if (!meta.size || meta.has('parent')) out.parent = { key: relation.epicKey };
      else warnings.push(`Không gán được Epic ${relation.epicKey}: field "parent" không có trên màn hình`);
    } else {
      const el = ctx.fieldIds.epicLink;
      if (el && (!meta.size || meta.has(el.id))) out[el.id] = relation.epicKey;
      else warnings.push(`Không gán được Epic ${relation.epicKey}: không có field Epic Link trên màn hình`);
    }
  }

  // Sprint (sub-task tự theo parent)
  if (ctx.inherit.sprint && !isSubtask && ctx.fieldIds.sprint) {
    const sprint = pickSprint(source.sprints);
    const sprintId = ctx.fieldIds.sprint.id;
    if (sprint && (!meta.size || meta.has(sprintId))) out[sprintId] = sprint.id;
  }

  // Custom field khác (Role, field bắt buộc...)
  for (const [fieldId, value] of Object.entries(row.extra ?? {})) {
    if (isEmpty(value) || MANAGED_FIELDS.has(fieldId)) continue;
    const m = meta.get(fieldId);
    if (!m) continue; // field không thuộc issue type này
    const r = convertFieldValue(m, value, {
      deploymentType: ctx.deploymentType,
      utcOffset: settings.utcOffset,
    });
    if (r.error) errors.push(r.error);
    else out[fieldId] = r.value;
  }

  // Field bắt buộc còn thiếu
  for (const f of ctx.fields) {
    if (f.required && !f.hasDefaultValue && !(f.id in out)) {
      errors.push(`Thiếu trường bắt buộc "${f.name}"`);
    }
  }

  return {
    rowId: row.rowId,
    fields: out,
    relation: {
      parentKey: isSubtask ? relation.parentKey : undefined,
      epicKey: isSubtask ? undefined : relation.epicKey,
      relatesToKey: relation.relatesToKey,
    },
    estimate,
    worklogs,
    errors,
    warnings,
  };
}
