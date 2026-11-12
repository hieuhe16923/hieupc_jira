import { useEffect, useRef, useState } from 'react';
import { Avatar, DatePicker, Input, InputNumber, Select, Space, Spin, Tag } from 'antd';
import dayjs from 'dayjs';
import type { FieldMeta, FieldValue, LabelSuggestions, UserOption } from '@jpw/shared';
import { fetchLabels, fetchUsers } from '../api/meta';

export const DATE_FMT = 'YYYY-MM-DD';
export const DATETIME_FMT = 'YYYY-MM-DD HH:mm';
export const DISPLAY_DATETIME = 'DD/MM/YYYY HH:mm';

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Select có tìm kiếm từ server (label / user) */
function RemoteSelect<T>({
  value,
  onChange,
  multiple,
  tags,
  fetcher,
  toOption,
  placeholder,
  status,
  disabled,
}: {
  value: string | string[] | undefined;
  onChange: (v: string | string[] | undefined) => void;
  multiple?: boolean;
  tags?: boolean;
  fetcher: (q: string) => Promise<T[]>;
  toOption: (x: T) => { value: string; label: React.ReactNode };
  placeholder?: string;
  status?: 'error';
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [options, setOptions] = useState<{ value: string; label: React.ReactNode }[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    fetcher(q)
      .then((list) => id === seq.current && setOptions(list.map(toOption)))
      .catch(() => id === seq.current && setOptions([]))
      .finally(() => id === seq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <Select
      showSearch
      allowClear
      mode={tags ? 'tags' : multiple ? 'multiple' : undefined}
      value={value}
      onChange={(v) => onChange(v as string | string[] | undefined)}
      onSearch={setSearch}
      filterOption={false}
      options={options}
      notFoundContent={loading ? <Spin size="small" /> : null}
      placeholder={placeholder}
      style={{ width: '100%' }}
      status={status}
      disabled={disabled}
      maxTagCount="responsive"
      tokenSeparators={tags ? [',', ' '] : undefined}
      popupMatchSelectWidth={false}
    />
  );
}

const LABEL_COLORS = ['#b57ce8', '#2fbfa8', '#e0b400', '#8c8c8c', '#e66ab8', '#5b8def', '#f08a3c', '#52b35c'];

/** Màu viền ổn định theo tên label (giống kiểu tag màu của Jira) */
function labelColor(label: string): string {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LABEL_COLORS[h % LABEL_COLORS.length]!;
}

export function LabelChip({ label, onClose }: { label: string; onClose?: () => void }) {
  return (
    <Tag
      className="jira-label"
      style={{ borderColor: labelColor(label), marginInlineEnd: 4 }}
      closable={Boolean(onClose)}
      onClose={onClose}
      onMouseDown={(e) => e.preventDefault()}
    >
      {label}
    </Tag>
  );
}

const normalizeLabel = (l: string) => l.trim().replace(/\s+/g, '_');

export function LabelSelect(props: {
  value: string[];
  onChange: (v: string[]) => void;
  projectKey?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 250);
  const [data, setData] = useState<LabelSuggestions | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // Chỉ gọi server khi mở dropdown (lưới có nhiều dòng)
  useEffect(() => {
    if (!open) return;
    const id = ++seq.current;
    setLoading(true);
    fetchLabels(q, props.projectKey)
      .then((r) => id === seq.current && setData(r))
      .catch(() => id === seq.current && setData({ project: [], others: [] }))
      .finally(() => id === seq.current && setLoading(false));
  }, [open, q, props.projectKey]);

  const chosen = new Set(props.value);
  const opt = (l: string) => ({ value: l, label: <LabelChip label={l} /> });
  const groups = [
    { title: props.projectKey ? 'Label trong dự án' : 'Tất cả label', list: data?.project ?? [] },
    { title: 'Label khác', list: data?.others ?? [] },
  ].filter((g) => g.list.length);
  const typed = normalizeLabel(search);
  // Label Jira phân biệt hoa/thường, nhưng nếu đã có label trùng (bỏ qua hoa/thường) thì không gợi ý tạo mới
  const lower = typed.toLowerCase();
  const known = [...chosen, ...groups.flatMap((g) => g.list)].some((l) => l.toLowerCase() === lower);
  const options = [
    ...groups.map((g) => ({ label: g.title, options: g.list.map(opt) })),
    // Đặt cuối để Enter chọn label có sẵn trước
    ...(typed && !known ? [{ label: 'Tạo label mới', options: [opt(typed)] }] : []),
  ];

  return (
    <Select
      mode="multiple"
      allowClear
      showSearch
      value={props.value}
      onChange={(v: string[]) => {
        props.onChange([...new Set(v.map(normalizeLabel).filter(Boolean))]);
        setSearch('');
      }}
      searchValue={search}
      onSearch={setSearch}
      onDropdownVisibleChange={setOpen}
      filterOption={false}
      options={options}
      // value undefined = ô "+N" khi không đủ chỗ
      tagRender={({ value, label, onClose }) =>
        value === undefined ? <Tag>{label}</Tag> : <LabelChip label={String(value)} onClose={onClose} />
      }
      maxTagPlaceholder={(omitted) => `+${omitted.length}`}
      notFoundContent={loading ? <Spin size="small" /> : 'Không có label'}
      placeholder="Chọn / nhập label"
      style={{ width: '100%' }}
      disabled={props.disabled}
      maxTagCount="responsive"
      popupMatchSelectWidth={false}
      listHeight={320}
    />
  );
}

export function UserSelect(props: {
  value: string | string[] | undefined;
  onChange: (v: string | string[] | undefined) => void;
  multiple?: boolean;
  projectKey?: string;
  status?: 'error';
  disabled?: boolean;
}) {
  return (
    <RemoteSelect<UserOption>
      multiple={props.multiple}
      value={props.value}
      onChange={props.onChange}
      fetcher={(q) => fetchUsers(q, props.projectKey)}
      toOption={(u) => ({
        value: u.id,
        label: (
          <Space size={4}>
            <Avatar size={16} src={u.avatarUrl} />
            {u.displayName}
          </Space>
        ),
      })}
      placeholder="Tìm người dùng"
      status={props.status}
      disabled={props.disabled}
    />
  );
}

/** Render input theo schema của field Jira (option, multi-option, string, number, date, datetime, user...) */
export function FieldInput({
  meta,
  value,
  onChange,
  projectKey,
  disabled,
}: {
  meta: FieldMeta;
  value: FieldValue;
  onChange: (v: FieldValue) => void;
  projectKey?: string;
  disabled?: boolean;
}) {
  const { type, items, custom } = meta.schema;
  const missing =
    meta.required &&
    !meta.hasDefaultValue &&
    (value === undefined || value === '' || value === null || (Array.isArray(value) && !value.length));
  const status = missing ? ('error' as const) : undefined;
  const isArray = type === 'array';

  if (meta.allowedValues) {
    const options = meta.allowedValues.map((v) => ({
      value: v.id,
      label: (
        <Space size={4}>
          {v.iconUrl && <img src={v.iconUrl} width={14} height={14} alt="" />}
          {v.name}
        </Space>
      ),
      title: v.name,
    }));
    return (
      <Select
        allowClear
        showSearch
        mode={isArray ? 'multiple' : undefined}
        optionFilterProp="title"
        value={(value as string | string[] | undefined) ?? undefined}
        onChange={(v) => onChange(v as FieldValue)}
        options={options}
        status={status}
        style={{ width: '100%' }}
        maxTagCount="responsive"
        placeholder={`Chọn ${meta.name}`}
        disabled={disabled}
        popupMatchSelectWidth={false}
      />
    );
  }

  if (type === 'user' || (isArray && items === 'user')) {
    return (
      <UserSelect
        multiple={isArray}
        value={value as string | string[] | undefined}
        onChange={onChange}
        projectKey={projectKey}
        status={status}
        disabled={disabled}
      />
    );
  }

  if (type === 'number') {
    return (
      <InputNumber
        value={value === undefined || value === null || value === '' ? null : Number(value)}
        onChange={(v) => onChange(v ?? undefined)}
        status={status}
        style={{ width: '100%' }}
        disabled={disabled}
      />
    );
  }

  if (type === 'date' || type === 'datetime') {
    const withTime = type === 'datetime';
    const fmt = withTime ? DATETIME_FMT : DATE_FMT;
    return (
      <DatePicker
        showTime={withTime ? { format: 'HH:mm', minuteStep: 15 } : false}
        format={withTime ? DISPLAY_DATETIME : 'DD/MM/YYYY'}
        value={typeof value === 'string' && value ? dayjs(value, fmt) : null}
        onChange={(d) => onChange(d ? d.format(fmt) : undefined)}
        status={status}
        style={{ width: '100%' }}
        disabled={disabled}
      />
    );
  }

  if (isArray && items === 'string') {
    return (
      <Select
        mode="tags"
        value={(value as string[] | undefined) ?? []}
        onChange={(v) => onChange(v)}
        status={status}
        style={{ width: '100%' }}
        open={false}
        disabled={disabled}
      />
    );
  }

  if (custom?.endsWith(':textarea')) {
    return (
      <Input.TextArea
        autoSize={{ minRows: 1, maxRows: 4 }}
        value={(value as string | undefined) ?? ''}
        onChange={(e) => onChange(e.target.value)}
        status={status}
        disabled={disabled}
      />
    );
  }

  return (
    <Input
      value={(value as string | undefined) ?? ''}
      onChange={(e) => onChange(e.target.value)}
      status={status}
      disabled={disabled}
    />
  );
}
