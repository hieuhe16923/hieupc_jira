import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Input,
  Modal,
  Popconfirm,
  Select,
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
  CopyOutlined,
  DeleteOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
  WarningFilled,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useQueryClient } from '@tanstack/react-query';
import {
  formatJiraDuration,
  type ExcelImportResponse,
  type FieldMeta,
  type ImportRowIssue,
  type InheritOptions,
  type IssueRow,
  type IssueTypeRef,
  type RowPreview,
  type RowResult,
  type SourceIssue,
} from '@jpw/shared';
import { useMe, useRefreshMeta, useSettings } from '../api/hooks';
import { errorMessage } from '../api/http';
import {
  metaKeys,
  useComponents,
  useCreateIssues,
  useFieldIds,
  useFieldMetas,
  useIssueTypes,
  usePreviewIssues,
} from '../api/meta';
import { defaultIssueType, describeRelation, makeRow, newId, rowEstimate } from '../lib/rows';
import { DATETIME_FMT, DISPLAY_DATETIME, FieldInput, LabelSelect } from './FieldInput';
import { PreviewModal } from './PreviewModal';
import { ExcelImport, type ImportMode } from './ExcelImport';
import { myIssuesKey } from '../api/myIssues';

/** Field đã có cột riêng hoặc được điền tự động */
const MANAGED = new Set([
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
  'attachment',
  'issuelinks',
]);

function TypeOption({ t }: { t: IssueTypeRef }) {
  return (
    <Space size={6}>
      {t.iconUrl && <img src={t.iconUrl} width={16} height={16} alt="" />}
      {t.name}
    </Space>
  );
}

export interface IssueGridProps {
  source: SourceIssue;
  /** Dòng được nạp từ bên ngoài (VD import Excel) */
  incomingRows?: { rows: IssueRow[]; replace: boolean; nonce: number };
}

export function IssueGrid({ source, incomingRows }: IssueGridProps) {
  const projectKey = source.project.key;
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const me = useMe();
  const settingsQ = useSettings();
  const typesQ = useIssueTypes(projectKey);
  const compsQ = useComponents(projectKey);
  const fieldIdsQ = useFieldIds();
  const refreshMeta = useRefreshMeta();
  const previewM = usePreviewIssues();
  const createM = useCreateIssues();

  const settings = settingsQ.data;
  const types = useMemo(() => typesQ.data ?? [], [typesQ.data]);
  const components = useMemo(() => compsQ.data ?? [], [compsQ.data]);
  const fieldIds = fieldIdsQ.data;

  const [rows, setRows] = useState<IssueRow[]>([]);
  const [inherit, setInherit] = useState<InheritOptions | null>(null);
  const [previews, setPreviews] = useState<Map<string, RowPreview>>(new Map());
  const [results, setResults] = useState<Map<string, RowResult>>(new Map());
  /** Lỗi / cảnh báo khi nhập Excel, theo rowId (xoá khi dòng được sửa) */
  const [importIssues, setImportIssues] = useState<Map<string, ImportRowIssue>>(new Map());
  const [previewOpen, setPreviewOpen] = useState(false);
  const [extraRowId, setExtraRowId] = useState<string | null>(null);

  const metas = useFieldMetas(
    projectKey,
    rows.map((r) => r.issueTypeId),
  );
  const defType = useMemo(() => defaultIssueType(types, source), [types, source]);

  // Khởi tạo
  useEffect(() => {
    if (settings && !inherit) setInherit({ ...settings.defaults.inherit });
  }, [settings, inherit]);
  useEffect(() => {
    if (settings && defType && rows.length === 0 && !incomingRows) {
      setRows([makeRow({ issueTypeId: defType.id, settings, components })]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, defType]);

  // Nhận dòng từ import Excel
  useEffect(() => {
    if (!incomingRows) return;
    setRows((prev) => (incomingRows.replace ? incomingRows.rows : [...prev, ...incomingRows.rows]));
    setPreviews(new Map());
    if (incomingRows.replace) setResults(new Map());
  }, [incomingRows]);

  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  const roleId = fieldIds?.role?.id;
  const specialIds = new Set(
    [fieldIds?.role?.id, fieldIds?.startDate?.id, fieldIds?.sprint?.id, fieldIds?.epicLink?.id].filter(
      Boolean,
    ),
  );

  const isDone = (rowId: string) => results.get(rowId)?.ok === true;

  const update = (rowId: string, patch: Partial<IssueRow>) => {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)));
    setImportIssues((prev) => {
      if (!prev.has(rowId)) return prev;
      const next = new Map(prev);
      next.delete(rowId);
      return next;
    });
    setPreviews((prev) => {
      if (!prev.has(rowId)) return prev;
      const next = new Map(prev);
      next.delete(rowId);
      return next;
    });
  };
  const updateExtra = (row: IssueRow, fieldId: string, value: unknown) =>
    update(row.rowId, { extra: { ...row.extra, [fieldId]: value as IssueRow['extra'][string] } });

  const addRow = () => {
    if (!settings || !defType) return;
    const last = rows[rows.length - 1];
    const r = makeRow({ issueTypeId: last?.issueTypeId ?? defType.id, settings, components });
    if (last) {
      r.from = last.from;
      r.to = last.to;
      r.labels = [...last.labels];
      r.components = [...last.components];
      r.extra = roleId && last.extra[roleId] !== undefined ? { [roleId]: last.extra[roleId] } : {};
    }
    setRows((prev) => [...prev, r]);
  };
  const duplicate = (row: IssueRow) => {
    const copy: IssueRow = { ...structuredClone(row), rowId: newId() };
    setRows((prev) => {
      const i = prev.findIndex((r) => r.rowId === row.rowId);
      return [...prev.slice(0, i + 1), copy, ...prev.slice(i + 1)];
    });
  };
  const remove = (rowId: string) => setRows((prev) => prev.filter((r) => r.rowId !== rowId));
  const clearDone = () => setRows((prev) => prev.filter((r) => !isDone(r.rowId)));

  /** Dòng chưa tạo có nội dung (bỏ qua dòng trống mặc định) */
  const hasContent = (r: IssueRow) => Boolean(r.summary.trim() || r.description?.trim());
  const importExcel = (res: ExcelImportResponse, mode: ImportMode) => {
    setRows((prev) => {
      const done = prev.filter((r) => isDone(r.rowId));
      const pendingRows = prev.filter((r) => !isDone(r.rowId) && hasContent(r));
      return mode === 'replace' ? [...done, ...res.rows] : [...done, ...pendingRows, ...res.rows];
    });
    setImportIssues(new Map(res.issues.filter((i) => i.rowId).map((i) => [i.rowId!, i])));
    setPreviews(new Map());
    const bad = res.issues.filter((i) => i.errors.length).length;
    if (bad) message.warning(`Đã nạp ${res.rows.length} dòng, ${bad} dòng có lỗi (đánh dấu đỏ)`);
    else message.success(`Đã nạp ${res.rows.length} dòng từ Excel`);
  };

  const otherFields = (row: IssueRow): FieldMeta[] =>
    (metas.map.get(row.issueTypeId) ?? [])
      .filter((f) => !MANAGED.has(f.id) && !specialIds.has(f.id))
      .filter((f) => (f.required && !f.hasDefaultValue) || f.id.startsWith('customfield_'))
      .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
  const missingOther = (row: IssueRow) =>
    otherFields(row).filter((f) => {
      if (!f.required || f.hasDefaultValue) return false;
      const v = row.extra[f.id];
      return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    });

  const pending = rows.filter((r) => !isDone(r.rowId));
  const request = (list: IssueRow[]) => ({
    sourceKey: source.key,
    inherit: inherit!,
    // Không tự log work khi tạo — log work được thêm thủ công sau
    logWork: false,
    rows: list,
  });

  const doPreview = () => {
    if (!pending.length || !inherit) return;
    previewM.mutate(request(pending), {
      onSuccess: (res) => {
        setPreviews(new Map(res.rows.map((p) => [p.rowId, p])));
        setPreviewOpen(true);
      },
      onError: (e) => message.error(errorMessage(e)),
    });
  };

  const doCreate = (list: IssueRow[] = pending) => {
    if (!list.length || !inherit) return;
    createM.mutate(request(list), {
      onSuccess: (res) => {
        setResults((prev) => {
          const next = new Map(prev);
          res.results.forEach((r) => next.set(r.rowId, r));
          return next;
        });
        setPreviewOpen(false);
        const ok = res.results.filter((r) => r.ok).length;
        if (ok) void qc.invalidateQueries({ queryKey: myIssuesKey(source.key) });
        const fail = res.results.length - ok;
        const planned = res.results.reduce((s, r) => s + (r.worklogsPlanned ?? 0), 0);
        const logged = res.results.reduce((s, r) => s + (r.worklogsLogged ?? 0), 0);
        const logText = planned ? `, log work ${logged}/${planned} ngày` : '';
        if (fail === 0 && logged === planned) message.success(`Đã tạo ${ok} issue${logText}`);
        else
          modal.warning({
            title: `Tạo thành công ${ok}/${res.results.length} issue${logText}`,
            content: [
              fail
                ? `${fail} dòng lỗi được đánh dấu đỏ. Sửa rồi bấm "Tạo" để thử lại riêng các dòng lỗi.`
                : '',
              logged < planned
                ? `${planned - logged} ngày log work bị lỗi (biểu tượng vàng). Rê chuột vào để xem, cần log tay trên Jira.`
                : '',
            ]
              .filter(Boolean)
              .join(' '),
          });
      },
      onError: (e) => message.error(errorMessage(e)),
    });
  };

  const refresh = () =>
    refreshMeta.mutate(projectKey, {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: metaKeys.all });
        message.success('Đã làm mới metadata từ Jira');
      },
    });

  const totalMinutes = settings
    ? pending.reduce((sum, r) => sum + (rowEstimate(r, settings)?.minutes ?? 0), 0)
    : 0;

  const loadingMeta = settingsQ.isLoading || typesQ.isLoading || fieldIdsQ.isLoading;
  const metaError = typesQ.error ?? compsQ.error ?? fieldIdsQ.error ?? metas.error;

  const columns: ColumnsType<IssueRow> = [
    {
      title: '#',
      width: 56,
      fixed: 'left',
      align: 'center',
      render: (_, row, i) => {
        const res = results.get(row.rowId);
        const pv = previews.get(row.rowId);
        if (res?.ok) {
          const logInfo = res.worklogsPlanned
            ? `Log work: ${res.worklogsLogged ?? 0}/${res.worklogsPlanned} ngày`
            : '';
          const logFailed = (res.worklogsLogged ?? 0) < (res.worklogsPlanned ?? 0);
          return (
            <Tooltip
              title={
                <div style={{ whiteSpace: 'pre-line' }}>
                  {[`Đã tạo ${res.key}`, logInfo, ...res.warnings].filter(Boolean).join('\n')}
                </div>
              }
            >
              <CheckCircleFilled style={{ color: logFailed ? '#faad14' : '#52c41a' }} />
            </Tooltip>
          );
        }
        const imp = importIssues.get(row.rowId);
        const impLines = imp
          ? [
              ...imp.errors.map((e) => `Excel dòng ${imp.line}: ${e}`),
              ...imp.warnings.map((w) => `Excel dòng ${imp.line}: ⚠ ${w}`),
            ]
          : [];
        const errs = res?.errors.length
          ? res.errors
          : pv
            ? pv.errors
            : imp?.errors.length
              ? impLines
              : undefined;
        if (errs?.length)
          return (
            <Tooltip title={<div style={{ whiteSpace: 'pre-line' }}>{errs.join('\n')}</div>}>
              <CloseCircleFilled style={{ color: '#ff4d4f' }} />
            </Tooltip>
          );
        const warns = pv ? pv.warnings : imp?.warnings.length ? impLines : [];
        if (warns.length)
          return (
            <Tooltip title={<div style={{ whiteSpace: 'pre-line' }}>{warns.join('\n')}</div>}>
              <WarningFilled style={{ color: '#faad14' }} />
            </Tooltip>
          );
        return <Typography.Text type="secondary">{i + 1}</Typography.Text>;
      },
    },
    {
      title: 'Issue type',
      width: 170,
      fixed: 'left',
      render: (_, row) => (
        <Select
          value={row.issueTypeId || undefined}
          onChange={(v: string) => update(row.rowId, { issueTypeId: v })}
          options={types.map((t) => ({ value: t.id, label: <TypeOption t={t} />, title: t.name }))}
          optionFilterProp="title"
          showSearch
          style={{ width: '100%' }}
          disabled={isDone(row.rowId)}
          status={typeById.has(row.issueTypeId) ? undefined : 'error'}
          popupMatchSelectWidth={false}
        />
      ),
    },
    {
      title: 'Summary *',
      width: 260,
      render: (_, row) => {
        const res = results.get(row.rowId);
        if (res?.ok)
          return (
            <Space direction="vertical" size={0}>
              <Typography.Link href={res.url} target="_blank" rel="noreferrer" strong>
                {res.key}
              </Typography.Link>
              <Typography.Text type="secondary" ellipsis style={{ maxWidth: 240 }}>
                {row.summary}
              </Typography.Text>
            </Space>
          );
        return (
          <Input.TextArea
            autoSize={{ minRows: 1, maxRows: 3 }}
            value={row.summary}
            onChange={(e) => update(row.rowId, { summary: e.target.value })}
            status={row.summary.trim() ? undefined : 'error'}
            placeholder="Tiêu đề issue"
          />
        );
      },
    },
    {
      title: 'Description',
      width: 220,
      render: (_, row) => (
        <Input.TextArea
          autoSize={{ minRows: 1, maxRows: 3 }}
          value={row.description}
          onChange={(e) => update(row.rowId, { description: e.target.value })}
          disabled={isDone(row.rowId)}
        />
      ),
    },
    {
      title: 'Labels',
      width: 190,
      render: (_, row) => (
        <LabelSelect
          value={row.labels}
          projectKey={projectKey}
          onChange={(labels) => update(row.rowId, { labels })}
          disabled={isDone(row.rowId)}
        />
      ),
    },
    {
      title: 'Components',
      width: 190,
      render: (_, row) => (
        <Select
          mode="multiple"
          allowClear
          value={row.components}
          onChange={(v: string[]) => update(row.rowId, { components: v })}
          options={components.map((c) => ({ value: c.id, label: c.name }))}
          optionFilterProp="label"
          style={{ width: '100%' }}
          maxTagCount="responsive"
          disabled={isDone(row.rowId)}
          popupMatchSelectWidth={false}
        />
      ),
    },
    {
      title: fieldIds?.role?.name ?? 'Role',
      width: 160,
      render: (_, row) => {
        const meta = roleId ? metas.map.get(row.issueTypeId)?.find((f) => f.id === roleId) : undefined;
        if (!meta)
          return (
            <Tooltip
              title={roleId ? 'Issue type này không có field Role' : 'Chưa dò được field Role (xem Cài đặt)'}
            >
              <Typography.Text type="secondary">—</Typography.Text>
            </Tooltip>
          );
        return (
          <FieldInput
            meta={meta}
            value={row.extra[meta.id]}
            onChange={(v) => updateExtra(row, meta.id, v)}
            projectKey={projectKey}
            disabled={isDone(row.rowId)}
          />
        );
      },
    },
    {
      title: 'Priority',
      width: 130,
      render: (_, row) => {
        const meta = metas.map.get(row.issueTypeId)?.find((f) => f.id === 'priority');
        if (!meta?.allowedValues) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Select
            allowClear
            value={row.priorityId}
            onChange={(v: string | undefined) => update(row.rowId, { priorityId: v })}
            options={meta.allowedValues.map((p) => ({
              value: p.id,
              label: (
                <Space size={4}>
                  {p.iconUrl && <img src={p.iconUrl} width={14} height={14} alt="" />}
                  {p.name}
                </Space>
              ),
            }))}
            placeholder="Mặc định"
            style={{ width: '100%' }}
            disabled={isDone(row.rowId)}
            popupMatchSelectWidth={false}
          />
        );
      },
    },
    ...(['from', 'to'] as const).map((key) => ({
      title: key === 'from' ? 'From' : 'To',
      width: 175,
      render: (_: unknown, row: IssueRow) => {
        const bad = row.from && row.to && dayjs(row.from).valueOf() >= dayjs(row.to).valueOf();
        return (
          <DatePicker
            showTime={{ format: 'HH:mm', minuteStep: 15 }}
            format={DISPLAY_DATETIME}
            value={row[key] ? dayjs(row[key], DATETIME_FMT) : null}
            onChange={(d) => update(row.rowId, { [key]: d ? d.format(DATETIME_FMT) : undefined })}
            style={{ width: '100%' }}
            status={bad ? 'error' : undefined}
            disabled={isDone(row.rowId)}
            allowClear
          />
        );
      },
    })),
    {
      title: 'Estimate',
      width: 115,
      render: (_, row) => {
        const est = settings ? rowEstimate(row, settings) : null;
        const invalid = !!row.estimate?.trim() && !est;
        return (
          <Tooltip title={est?.auto ? `Tự tính từ From–To: ${est.text}` : 'Ghi đè thủ công (VD: 1d 4h)'}>
            <Input
              value={row.estimate}
              placeholder={est?.auto ? est.text : 'VD 1d 4h'}
              onChange={(e) => update(row.rowId, { estimate: e.target.value })}
              status={invalid ? 'error' : undefined}
              disabled={isDone(row.rowId)}
            />
          </Tooltip>
        );
      },
    },
    {
      title: 'Parent / Quan hệ',
      width: 190,
      render: (_, row) => {
        const type = typeById.get(row.issueTypeId);
        const rel = describeRelation(row, type, source);
        return (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Input
              size="small"
              value={row.parentKey}
              placeholder={type?.subtask ? 'Parent key (tự động)' : 'Relates key (tự động)'}
              onChange={(e) => update(row.rowId, { parentKey: e.target.value })}
              disabled={isDone(row.rowId)}
            />
            <Typography.Text type={rel.startsWith('⚠') ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
              {rel}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: 'Khác',
      width: 90,
      render: (_, row) => {
        const fields = otherFields(row);
        if (!fields.length) return <Typography.Text type="secondary">—</Typography.Text>;
        const missing = missingOther(row).length;
        return (
          <Badge count={missing} size="small">
            <Button size="small" onClick={() => setExtraRowId(row.rowId)} danger={missing > 0}>
              {fields.length} field
            </Button>
          </Badge>
        );
      },
    },
    {
      title: '',
      width: 76,
      fixed: 'right',
      render: (_, row) => (
        <Space size={0}>
          <Tooltip title="Nhân bản">
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => duplicate(row)} />
          </Tooltip>
          <Popconfirm title="Xoá dòng này?" onConfirm={() => remove(row.rowId)} okText="Xoá" cancelText="Huỷ">
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const extraRow = rows.find((r) => r.rowId === extraRowId);
  const doneCount = rows.length - pending.length;
  const failedCount = pending.filter((r) => results.get(r.rowId)?.ok === false).length;

  return (
    <Card
      size="small"
      title={
        <Space wrap>
          2. Danh sách issue sẽ tạo
          <Tag>{pending.length} dòng chờ tạo</Tag>
          {settings && totalMinutes > 0 && (
            <Tag color="blue">
              Tổng estimate: {formatJiraDuration(totalMinutes, settings.workSchedule.hoursPerDay)}
            </Tag>
          )}
          {doneCount > 0 && <Tag color="green">{doneCount} đã tạo</Tag>}
          {failedCount > 0 && <Tag color="red">{failedCount} lỗi</Tag>}
        </Space>
      }
      extra={
        <Tooltip title="Xoá cache issue type / field / component (10 phút) và tải lại từ Jira">
          <Button size="small" icon={<ReloadOutlined />} loading={refreshMeta.isPending} onClick={refresh}>
            Làm mới metadata
          </Button>
        </Tooltip>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {metaError && <Alert type="error" showIcon message={errorMessage(metaError)} />}

        <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space wrap>
            <Typography.Text type="secondary">Kế thừa từ {source.key}:</Typography.Text>
            {inherit &&
              (
                [
                  ['sprint', 'Sprint'],
                  ['fixVersions', 'Fix version'],
                  ['components', 'Components'],
                  ['labels', 'Labels'],
                ] as const
              ).map(([k, label]) => (
                <Checkbox
                  key={k}
                  checked={inherit[k]}
                  onChange={(e) => {
                    setInherit({ ...inherit, [k]: e.target.checked });
                    setPreviews(new Map());
                  }}
                >
                  {label}
                </Checkbox>
              ))}
          </Space>
          <Typography.Text type="secondary">
            Assignee: <Typography.Text strong>{me.data?.user.displayName}</Typography.Text> (cố định)
          </Typography.Text>
        </Space>

        <Table<IssueRow>
          rowKey="rowId"
          size="small"
          bordered
          loading={loadingMeta}
          dataSource={rows}
          columns={columns}
          pagination={false}
          scroll={{ x: 2050 }}
          sticky
          rowClassName={(r) =>
            isDone(r.rowId)
              ? 'row-done'
              : results.get(r.rowId)?.ok === false || importIssues.get(r.rowId)?.errors.length
                ? 'row-error'
                : ''
          }
        />

        <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space wrap>
            <Button icon={<PlusOutlined />} onClick={addRow} disabled={!defType}>
              Thêm dòng
            </Button>
            {doneCount > 0 && <Button onClick={clearDone}>Ẩn {doneCount} dòng đã tạo</Button>}
            <ExcelImport
              sourceKey={source.key}
              hasPendingRows={rows.some((r) => !isDone(r.rowId) && hasContent(r))}
              onImport={importExcel}
            />
          </Space>
          <Space wrap>
            <Button
              icon={<EyeOutlined />}
              onClick={doPreview}
              loading={previewM.isPending}
              disabled={!pending.length}
            >
              Preview
            </Button>
            <Button
              type="primary"
              icon={<RocketOutlined />}
              onClick={() => doCreate()}
              loading={createM.isPending}
              disabled={!pending.length}
            >
              {failedCount > 0 && failedCount === pending.length
                ? `Thử lại ${failedCount} dòng lỗi`
                : `Tạo ${pending.length} issue`}
            </Button>
          </Space>
        </Space>
      </Space>

      <PreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        rows={pending}
        previews={previews}
        typeById={typeById}
        creating={createM.isPending}
        onCreate={() => doCreate()}
      />

      <Modal
        open={!!extraRow}
        title={`Trường khác — ${extraRow?.summary || 'dòng chưa có summary'}`}
        onCancel={() => setExtraRowId(null)}
        footer={<Button onClick={() => setExtraRowId(null)}>Xong</Button>}
        width={560}
        destroyOnClose
      >
        {extraRow && (
          <Space direction="vertical" style={{ width: '100%' }}>
            {otherFields(extraRow).map((f) => (
              <div key={f.id}>
                <Typography.Text strong={f.required}>
                  {f.name}
                  {f.required && !f.hasDefaultValue && <Typography.Text type="danger"> *</Typography.Text>}
                </Typography.Text>{' '}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {f.id}
                </Typography.Text>
                <FieldInput
                  meta={f}
                  value={extraRow.extra[f.id]}
                  onChange={(v) => updateExtra(extraRow, f.id, v)}
                  projectKey={projectKey}
                  disabled={isDone(extraRow.rowId)}
                />
              </div>
            ))}
          </Space>
        )}
      </Modal>
    </Card>
  );
}
