import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  DatePicker,
  Empty,
  Input,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  FieldTimeOutlined,
  LockOutlined,
  ReloadOutlined,
  SaveOutlined,
  UndoOutlined,
  WarningFilled,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useQueryClient } from '@tanstack/react-query';
import type { FieldValue, IssueChanges, MyIssue, MyIssuesResponse, SourceIssue } from '@jpw/shared';
import { useFieldIds } from '../api/meta';
import { myIssuesKey, useMyIssues, useUpdateIssues } from '../api/myIssues';
import { errorMessage } from '../api/http';
import { StatusTransition } from './StatusTransition';
import { WorklogPanel } from './WorklogPanel';
import { DATETIME_FMT, DATE_FMT, DISPLAY_DATETIME, FieldInput, LabelChip, LabelSelect } from './FieldInput';

type Key = keyof IssueChanges;

/** Giá trị gốc tương ứng với từng khoá thay đổi */
function original(issue: MyIssue, k: Key): unknown {
  switch (k) {
    case 'estimate':
      return issue.estimate ?? null;
    case 'from':
    case 'to':
      return issue[k] ?? null;
    default:
      return issue[k as keyof MyIssue];
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const fmtMinutes = (m: number) =>
  [Math.floor(m / 60) ? `${Math.floor(m / 60)}h` : '', m % 60 ? `${m % 60}m` : '']
    .filter(Boolean)
    .join(' ') || '0m';

export function MyIssuesPanel({ source }: { source: SourceIssue }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const q = useMyIssues(source.key);
  const fieldIds = useFieldIds().data;
  const update = useUpdateIssues();
  const [changes, setChanges] = useState<Record<string, IssueChanges>>({});
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const toggle = (key: string) =>
    setExpanded((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  /** Thay 1 issue trong cache sau khi log work */
  const replaceIssue = (issue: MyIssue) =>
    qc.setQueryData<MyIssuesResponse>(myIssuesKey(source.key), (old) =>
      old ? { ...old, issues: old.issues.map((i) => (i.key === issue.key ? issue : i)) } : old,
    );

  const issues = useMemo(() => q.data?.issues ?? [], [q.data]);
  const dirtyKeys = Object.keys(changes).filter((k) => Object.keys(changes[k]!).length);

  const val = <K extends Key>(issue: MyIssue, k: K): IssueChanges[K] =>
    (changes[issue.key] && k in changes[issue.key]!
      ? changes[issue.key]![k]
      : original(issue, k)) as IssueChanges[K];

  const setVal = (issue: MyIssue, patch: IssueChanges) =>
    setChanges((prev) => {
      const next = { ...(prev[issue.key] ?? {}) };
      for (const [k, v] of Object.entries(patch) as [Key, unknown][]) {
        if (same(v, original(issue, k))) delete next[k];
        else (next as Record<string, unknown>)[k] = v;
      }
      return { ...prev, [issue.key]: next };
    });

  const can = (issue: MyIssue, id: string | undefined) => !!id && issue.editMeta.some((m) => m.id === id);
  const metaOf = (issue: MyIssue, id: string | undefined) => issue.editMeta.find((m) => m.id === id);
  const locked = (title: string) => (
    <Tooltip title={`Không có quyền sửa ${title}`}>
      <LockOutlined style={{ opacity: 0.45, marginRight: 4 }} />
    </Tooltip>
  );

  const save = () => {
    const items = dirtyKeys.map((key) => ({ key, changes: changes[key]! }));
    if (!items.length) return;
    update.mutate(
      { items },
      {
        onSuccess: (res) => {
          const okKeys = res.results.filter((r) => r.ok).map((r) => r.key);
          qc.setQueryData<MyIssuesResponse>(myIssuesKey(source.key), (old) =>
            old
              ? {
                  ...old,
                  issues: old.issues.map((i) => res.results.find((r) => r.key === i.key)?.issue ?? i),
                }
              : old,
          );
          setChanges((prev) => {
            const next = { ...prev };
            okKeys.forEach((k) => delete next[k]);
            return next;
          });
          setErrors(Object.fromEntries(res.results.filter((r) => !r.ok).map((r) => [r.key, r.errors])));
          const fail = res.results.length - okKeys.length;
          if (fail) message.warning(`Đã lưu ${okKeys.length}/${res.results.length} issue, ${fail} issue lỗi`);
          else message.success(`Đã lưu ${okKeys.length} issue`);
        },
        onError: (e) => message.error(errorMessage(e)),
      },
    );
  };

  const startId = fieldIds?.startDate?.id;
  const roleId = fieldIds?.role?.id;

  const columns: ColumnsType<MyIssue> = [
    {
      title: '',
      width: 40,
      fixed: 'left',
      align: 'center',
      render: (_, i) => {
        const err = errors[i.key];
        if (err?.length)
          return (
            <Tooltip title={<div style={{ whiteSpace: 'pre-line' }}>{err.join('\n')}</div>}>
              <CloseCircleFilled style={{ color: '#ff4d4f' }} />
            </Tooltip>
          );
        if (i.ruleIssues.length)
          return (
            <Tooltip title={<div style={{ whiteSpace: 'pre-line' }}>{i.ruleIssues.join('\n')}</div>}>
              <WarningFilled style={{ color: '#faad14' }} />
            </Tooltip>
          );
        return (
          <Tooltip title="Estimate = tổng log work, log trong Start date → Due date">
            <CheckCircleFilled style={{ color: '#52c41a' }} />
          </Tooltip>
        );
      },
    },
    {
      title: 'Issue',
      width: 170,
      fixed: 'left',
      render: (_, i) => (
        <Space direction="vertical" size={0}>
          <a href={i.url} target="_blank" rel="noreferrer">
            {i.key}
          </a>
          <Space size={4}>
            {i.issueType.iconUrl && <img src={i.issueType.iconUrl} width={14} height={14} alt="" />}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {i.issueType.name}
            </Typography.Text>
          </Space>
          <StatusTransition issue={i} projectKey={source.project.key} onChanged={replaceIssue} />
        </Space>
      ),
    },
    {
      title: 'Summary',
      width: 240,
      render: (_, i) => (
        <Input.TextArea
          autoSize={{ minRows: 1, maxRows: 3 }}
          value={val(i, 'summary') ?? ''}
          onChange={(e) => setVal(i, { summary: e.target.value })}
          disabled={!can(i, 'summary')}
          status={!(val(i, 'summary') ?? '').trim() ? 'error' : undefined}
        />
      ),
    },
    {
      title: 'Description',
      width: 220,
      render: (_, i) => (
        <Input.TextArea
          autoSize={{ minRows: 1, maxRows: 3 }}
          value={val(i, 'description') ?? ''}
          onChange={(e) => setVal(i, { description: e.target.value })}
          disabled={!can(i, 'description')}
        />
      ),
    },
    {
      title: 'Labels',
      width: 190,
      render: (_, i) =>
        can(i, 'labels') ? (
          <LabelSelect
            value={val(i, 'labels') ?? []}
            projectKey={source.project.key}
            onChange={(labels) => setVal(i, { labels })}
          />
        ) : (
          <Space size={[0, 4]} wrap>
            {locked('Labels')}
            {i.labels.map((l) => (
              <LabelChip key={l} label={l} />
            ))}
          </Space>
        ),
    },
    {
      title: 'Components',
      width: 180,
      render: (_, i) => {
        const m = metaOf(i, 'components');
        return m ? (
          <FieldInput
            meta={{ ...m, required: false }}
            value={val(i, 'components')}
            onChange={(v) => setVal(i, { components: ((v as string[]) ?? []).map(String) })}
          />
        ) : (
          <span>
            {locked('Components')}
            {i.display.components.join(', ') || '—'}
          </span>
        );
      },
    },
    {
      title: fieldIds?.role?.name ?? 'Role',
      width: 150,
      render: (_, i) => {
        const m = metaOf(i, roleId);
        return m ? (
          <FieldInput
            meta={m}
            value={val(i, 'role') as FieldValue}
            onChange={(v) => setVal(i, { role: v })}
          />
        ) : (
          <span>
            {roleId && locked(fieldIds?.role?.name ?? 'Role')}
            {i.display.role ?? '—'}
          </span>
        );
      },
    },
    {
      title: 'Priority',
      width: 130,
      render: (_, i) => {
        const m = metaOf(i, 'priority');
        return m ? (
          <FieldInput
            meta={{ ...m, required: false }}
            value={val(i, 'priorityId')}
            onChange={(v) => v && setVal(i, { priorityId: String(v) })}
          />
        ) : (
          <span>
            {locked('Priority')}
            {i.display.priority ?? '—'}
          </span>
        );
      },
    },
    {
      title: 'From (Start date)',
      width: 175,
      render: (_, i) => {
        const v = val(i, 'from');
        const bad = v && val(i, 'to') && dayjs(v).valueOf() > dayjs(`${val(i, 'to')} 23:59`).valueOf();
        return (
          <DatePicker
            showTime={{ format: 'HH:mm', minuteStep: 15 }}
            format={DISPLAY_DATETIME}
            value={v ? dayjs(v, v.length > 10 ? DATETIME_FMT : DATE_FMT) : null}
            onChange={(d) => setVal(i, { from: d ? d.format(DATETIME_FMT) : null })}
            disabled={!can(i, startId)}
            status={bad ? 'error' : undefined}
            style={{ width: '100%' }}
          />
        );
      },
    },
    {
      title: 'To (Due date)',
      width: 140,
      render: (_, i) => {
        const v = val(i, 'to');
        return (
          <DatePicker
            format="DD/MM/YYYY"
            value={v ? dayjs(v, DATE_FMT) : null}
            onChange={(d) => setVal(i, { to: d ? d.format(DATE_FMT) : null })}
            disabled={!can(i, 'duedate')}
            style={{ width: '100%' }}
          />
        );
      },
    },
    {
      title: 'Estimate',
      width: 105,
      render: (_, i) => (
        <Input
          value={val(i, 'estimate') ?? ''}
          placeholder="VD 1d 4h"
          onChange={(e) => setVal(i, { estimate: e.target.value || null })}
          disabled={!can(i, 'timetracking')}
        />
      ),
    },
    {
      title: 'Đã log',
      width: 130,
      render: (_, i) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{fmtMinutes(i.spentMinutes)}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {i.worklogs.length} lần · còn {i.remaining ?? '—'}
          </Typography.Text>
          <Button
            size="small"
            type="link"
            icon={<FieldTimeOutlined />}
            style={{ padding: 0, height: 'auto' }}
            onClick={() => toggle(i.key)}
          >
            {expanded.includes(i.key) ? 'Đóng' : 'Log work'}
          </Button>
        </Space>
      ),
    },
    {
      title: '',
      width: 48,
      fixed: 'right',
      render: (_, i) =>
        changes[i.key] && Object.keys(changes[i.key]!).length ? (
          <Tooltip title="Huỷ thay đổi dòng này">
            <Button
              size="small"
              type="text"
              icon={<UndoOutlined />}
              onClick={() =>
                setChanges((prev) => {
                  const next = { ...prev };
                  delete next[i.key];
                  return next;
                })
              }
            />
          </Tooltip>
        ) : null,
    },
  ];

  const violations = issues.filter((i) => i.ruleIssues.length).length;

  return (
    <Card
      size="small"
      title={
        <Space wrap>
          Công việc của tôi trên {q.data?.anchorKey ?? source.key}
          <Tag>{issues.length} issue</Tag>
          {violations > 0 && (
            <Tooltip title="Estimate ≠ tổng log work, hoặc log ngoài Start date → Due date">
              <Tag color="warning" icon={<WarningFilled />}>
                {violations} vi phạm quy tắc log work
              </Tag>
            </Tooltip>
          )}
        </Space>
      }
      extra={
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={q.isFetching} onClick={() => void q.refetch()}>
            Làm mới
          </Button>
          <Button icon={<UndoOutlined />} disabled={!dirtyKeys.length} onClick={() => setChanges({})}>
            Huỷ thay đổi
          </Button>
          <Badge count={dirtyKeys.length} size="small">
            <Button
              type="primary"
              icon={<SaveOutlined />}
              disabled={!dirtyKeys.length}
              loading={update.isPending}
              onClick={save}
            >
              Lưu thay đổi
            </Button>
          </Badge>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {q.isError && <Alert type="error" showIcon message={errorMessage(q.error)} />}
        {q.data?.warnings.map((w) => (
          <Alert key={w} type="warning" showIcon message={w} />
        ))}
        <Table<MyIssue>
          rowKey="key"
          size="small"
          bordered
          loading={q.isLoading}
          dataSource={issues}
          columns={columns}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          scroll={{ x: 1950 }}
          rowClassName={(i) =>
            errors[i.key]?.length
              ? 'row-error'
              : changes[i.key] && Object.keys(changes[i.key]!).length
                ? 'row-dirty'
                : ''
          }
          locale={{
            emptyText: <Empty description="Chưa có issue nào giao cho bạn dưới issue gốc này" />,
          }}
          expandable={{
            expandedRowKeys: expanded,
            onExpand: (_, i) => toggle(i.key),
            expandedRowRender: (i) => (
              <WorklogPanel
                issue={i}
                dirty={Boolean(changes[i.key] && Object.keys(changes[i.key]!).length)}
                onUpdated={replaceIssue}
              />
            ),
          }}
        />
        {q.data && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            JQL: <Typography.Text code>{q.data.jql}</Typography.Text> · Ô có <LockOutlined /> hoặc bị khoá là
            field Jira không cho bạn sửa.
          </Typography.Text>
        )}
      </Space>
    </Card>
  );
}
