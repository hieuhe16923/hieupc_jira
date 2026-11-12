import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type FieldMeta, type IssueRow, type SourceIssue } from '@jpw/shared';
import { buildIssuePayload, convertFieldValue, type BuildContext } from './payload';

const f = (id: string, name: string, type: string, extra: Partial<FieldMeta> = {}): FieldMeta => ({
  id,
  name,
  required: false,
  hasDefaultValue: false,
  schema: { type },
  ...extra,
});

const SUBTASK_FIELDS: FieldMeta[] = [
  f('project', 'Project', 'project', { required: true }),
  f('issuetype', 'Issue Type', 'issuetype', { required: true }),
  f('summary', 'Summary', 'string', { required: true }),
  f('parent', 'Parent', 'issuelink', { required: true }),
  f('reporter', 'Reporter', 'user', { required: true, hasDefaultValue: true }),
  f('description', 'Description', 'string'),
  f('assignee', 'Assignee', 'user'),
  f('labels', 'Labels', 'array', { schema: { type: 'array', items: 'string' } }),
  f('components', 'Components', 'array', { schema: { type: 'array', items: 'component' } }),
  f('priority', 'Priority', 'priority'),
  f('duedate', 'Due date', 'date'),
  f('timetracking', 'Time tracking', 'timetracking'),
  f('customfield_10300', 'Start date', 'datetime'),
  f('customfield_10200', 'Role', 'option', {
    required: true,
    allowedValues: [
      { id: '1', name: 'BE' },
      { id: '2', name: 'FE' },
    ],
  }),
];
const STORY_FIELDS: FieldMeta[] = [
  ...SUBTASK_FIELDS.filter((x) => x.id !== 'parent' && x.id !== 'customfield_10200'),
  f('customfield_10100', 'Epic Link', 'any'),
  f('customfield_10101', 'Sprint', 'array', { schema: { type: 'array', items: 'json' } }),
];

const story: SourceIssue = {
  id: '1',
  key: 'ABC-123',
  url: 'https://jira/browse/ABC-123',
  summary: 'Story',
  status: { name: 'To Do' },
  project: { id: '10', key: 'ABC', name: 'Alpha' },
  issueType: { id: '7', name: 'Story', subtask: false },
  isEpic: false,
  epicKey: 'ABC-1',
  sprints: [
    { id: 11, name: 'S10', state: 'CLOSED' },
    { id: 12, name: 'S11', state: 'ACTIVE' },
  ],
  components: [{ id: '100', name: 'Backend' }],
  labels: ['api'],
  fixVersions: [{ id: '5', name: 'v1' }],
};
const epic: SourceIssue = {
  ...story,
  key: 'ABC-1',
  issueType: { id: '6', name: 'Epic', subtask: false },
  isEpic: true,
  epicKey: undefined,
};

const SUBTASK_TYPE = { id: '5', name: 'Sub-task BE', subtask: true };
const TASK_TYPE = { id: '3', name: 'Task', subtask: false };

function ctx(over: Partial<BuildContext> = {}): BuildContext {
  return {
    source: story,
    issueType: SUBTASK_TYPE,
    fields: SUBTASK_FIELDS,
    fieldIds: {
      startDate: { id: 'customfield_10300', name: 'Start date', schemaType: 'datetime' },
      epicLink: { id: 'customfield_10100', name: 'Epic Link' },
      role: { id: 'customfield_10200', name: 'Role' },
      sprint: { id: 'customfield_10101', name: 'Sprint' },
    },
    settings: DEFAULT_SETTINGS,
    user: { name: 'jdoe', accountId: 'acc-1', displayName: 'John' },
    deploymentType: 'Server',
    inherit: { sprint: true, fixVersions: true, components: true, labels: false },
    ...over,
  };
}

function row(over: Partial<IssueRow> = {}): IssueRow {
  return {
    rowId: 'r1',
    issueTypeId: SUBTASK_TYPE.id,
    summary: 'Viết API',
    labels: ['be'],
    components: [],
    from: '2026-11-10 08:00',
    to: '2026-11-11 12:00',
    extra: { customfield_10200: '1' },
    ...over,
  };
}

describe('buildIssuePayload — Story → Sub-task (tiêu chí nghiệm thu)', () => {
  it('parent = Story, assignee = tôi, estimate theo From–To, role, labels/components', () => {
    const r = buildIssuePayload(row(), ctx());
    expect(r.errors).toEqual([]);
    expect(r.fields).toMatchObject({
      project: { key: 'ABC' },
      issuetype: { id: '5' },
      summary: 'Viết API',
      parent: { key: 'ABC-123' },
      assignee: { name: 'jdoe' },
      labels: ['be'],
      components: [{ id: '100' }],
      customfield_10200: { id: '1' },
      customfield_10300: '2026-11-10T08:00:00.000+0700',
      duedate: '2026-11-11',
      timetracking: { originalEstimate: '1d 4h', remainingEstimate: '1d 4h' },
    });
    // sub-task không set sprint / epic link
    expect(r.fields).not.toHaveProperty('customfield_10101');
    expect(r.fields).not.toHaveProperty('customfield_10100');
    expect(r.relation).toEqual({ parentKey: 'ABC-123' });
  });

  it('Cloud dùng accountId cho assignee', () => {
    const r = buildIssuePayload(row(), ctx({ deploymentType: 'Cloud' }));
    expect(r.fields?.assignee).toEqual({ accountId: 'acc-1' });
  });

  it('thiếu Role bắt buộc → lỗi rõ ràng', () => {
    const r = buildIssuePayload(row({ extra: {} }), ctx());
    expect(r.errors).toContain('Thiếu trường bắt buộc "Role"');
  });

  it('From sau To, estimate sai, summary trống', () => {
    const r = buildIssuePayload(
      row({ summary: ' ', from: '2026-11-12 08:00', to: '2026-11-11 08:00', estimate: 'abc' }),
      ctx(),
    );
    expect(r.errors).toEqual(
      expect.arrayContaining(['Thiếu Summary', 'From phải trước To', expect.stringContaining('Estimate')]),
    );
  });

  it('estimate ghi đè thủ công được chuẩn hoá', () => {
    expect(buildIssuePayload(row({ estimate: '12h' }), ctx()).estimate).toBe('1d 4h');
  });

  it('parent override từ Excel', () => {
    const r = buildIssuePayload(row({ parentKey: 'abc-999' }), ctx());
    expect(r.fields?.parent).toEqual({ key: 'ABC-999' });
  });

  it('template summary', () => {
    const s = {
      ...DEFAULT_SETTINGS,
      defaults: { ...DEFAULT_SETTINGS.defaults, summaryTemplate: '[BE] {summary}' },
    };
    expect(buildIssuePayload(row(), ctx({ settings: s })).fields?.summary).toBe('[BE] Viết API');
  });
});

describe('buildIssuePayload — Task / Story', () => {
  it('Story + Task → cùng Epic (Epic Link), sprint đang active, relates to', () => {
    const r = buildIssuePayload(
      row({ issueTypeId: TASK_TYPE.id, extra: {} }),
      ctx({ issueType: TASK_TYPE, fields: STORY_FIELDS }),
    );
    expect(r.errors).toEqual([]);
    expect(r.fields).toMatchObject({ customfield_10100: 'ABC-1', customfield_10101: 12 });
    expect(r.fields).not.toHaveProperty('parent');
    expect(r.relation).toEqual({ epicKey: 'ABC-1', relatesToKey: 'ABC-123' });
  });

  it('Epic + Task trên Cloud → parent = Epic', () => {
    const r = buildIssuePayload(
      row({ issueTypeId: TASK_TYPE.id, extra: {} }),
      ctx({
        source: epic,
        issueType: TASK_TYPE,
        deploymentType: 'Cloud',
        fields: [...STORY_FIELDS, f('parent', 'Parent', 'issuelink')],
      }),
    );
    expect(r.fields?.parent).toEqual({ key: 'ABC-1' });
    expect(r.relation.relatesToKey).toBeUndefined();
  });

  it('Epic + Sub-task → lỗi', () => {
    expect(buildIssuePayload(row(), ctx({ source: epic })).errors[0]).toMatch(/Epic/);
  });

  it('field không có trên màn hình → cảnh báo và bỏ qua', () => {
    const fields = STORY_FIELDS.filter((x) => x.id !== 'timetracking');
    const r = buildIssuePayload(row({ issueTypeId: '3', extra: {} }), ctx({ issueType: TASK_TYPE, fields }));
    expect(r.fields).not.toHaveProperty('timetracking');
    expect(r.warnings.join()).toMatch(/Time tracking/);
  });
});

describe('convertFieldValue', () => {
  const c = { deploymentType: 'Server' as const, utcOffset: '+07:00' };
  it('theo schema', () => {
    expect(convertFieldValue(f('x', 'X', 'option'), '3', c).value).toEqual({ id: '3' });
    expect(
      convertFieldValue(f('x', 'X', 'array', { schema: { type: 'array', items: 'option' } }), ['1', '2'], c)
        .value,
    ).toEqual([{ id: '1' }, { id: '2' }]);
    expect(convertFieldValue(f('x', 'X', 'number'), '1,5', c).value).toBe(1.5);
    expect(convertFieldValue(f('x', 'X', 'number'), 'abc', c).error).toBeTruthy();
    expect(convertFieldValue(f('x', 'X', 'date'), '2026-11-10 08:00', c).value).toBe('2026-11-10');
    expect(convertFieldValue(f('x', 'X', 'user'), 'jdoe', c).value).toEqual({ name: 'jdoe' });
    expect(convertFieldValue(f('x', 'X', 'user'), 'acc', { ...c, deploymentType: 'Cloud' }).value).toEqual({
      accountId: 'acc',
    });
  });
});
