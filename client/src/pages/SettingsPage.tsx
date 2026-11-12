import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Divider,
  Empty,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import {
  CheckCircleFilled,
  DeleteOutlined,
  PlusOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  SaveOutlined,
  UndoOutlined,
  WarningFilled,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  DEFAULT_SETTINGS,
  applySummaryTemplate,
  type DetectedField,
  type DetectFieldsResponse,
  type Settings,
} from '@jpw/shared';
import { useDetectFields, useRefreshMeta, useSaveSettings, useSettings } from '../api/hooks';
import { api, errorMessage } from '../api/http';

type FieldKey = keyof Settings['fields'];
const FIELD_ROWS: { key: FieldKey; label: string; hint: string }[] = [
  { key: 'startDate', label: 'Start date', hint: 'Nhận giá trị From. Kiểu date hoặc datetime.' },
  {
    key: 'epicLink',
    label: 'Epic Link',
    hint: 'Jira Server/DC. Cloud dùng field parent nên có thể để trống.',
  },
  { key: 'role', label: 'Role', hint: 'Cột Role trong lưới tạo issue (VD "Role of Work").' },
  { key: 'sprint', label: 'Sprint', hint: 'Để kế thừa sprint đang chạy cho Story/Task.' },
];
const WEEKDAYS = [
  { value: 1, label: 'T2' },
  { value: 2, label: 'T3' },
  { value: 3, label: 'T4' },
  { value: 4, label: 'T5' },
  { value: 5, label: 'T6' },
  { value: 6, label: 'T7' },
  { value: 0, label: 'CN' },
];
const OFFSETS = Array.from({ length: 27 }, (_, i) => i - 12).map((h) => {
  const v = `${h < 0 ? '-' : '+'}${String(Math.abs(h)).padStart(2, '0')}:00`;
  return { value: v, label: `UTC${v}${v === '+07:00' ? ' (Việt Nam)' : ''}` };
});

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

export function SettingsPage() {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const settingsQ = useSettings();
  const save = useSaveSettings();
  const detect = useDetectFields();
  const refresh = useRefreshMeta();
  const fieldsQ = useQuery({
    queryKey: ['meta-fields'],
    queryFn: () => api<DetectedField[]>('/meta/fields'),
    staleTime: 10 * 60_000,
  });
  const [detected, setDetected] = useState<DetectFieldsResponse | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);

  useEffect(() => {
    if (settingsQ.data && !draft) setDraft(structuredClone(settingsQ.data));
  }, [settingsQ.data, draft]);
  // Dò field ngay khi mở trang
  useEffect(() => {
    detect.mutate(undefined, { onSuccess: setDetected });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(
    () => !!draft && !!settingsQ.data && JSON.stringify(draft) !== JSON.stringify(settingsQ.data),
    [draft, settingsQ.data],
  );

  if (settingsQ.isLoading || !draft) return <Spin />;
  if (settingsQ.isError) return <Alert type="error" showIcon message={errorMessage(settingsQ.error)} />;

  const set = (fn: (d: Settings) => void) =>
    setDraft((prev) => {
      const next = structuredClone(prev!);
      fn(next);
      return next;
    });

  const ws = draft.workSchedule;
  const windowMinutes = ws.windows.reduce((s, w) => s + Math.max(0, toMin(w.end) - toMin(w.start)), 0);
  const fieldOptions = (fieldsQ.data ?? []).map((f) => ({
    value: f.id,
    label: (
      <span>
        {f.name} <Typography.Text type="secondary">({f.id})</Typography.Text>
      </span>
    ),
    search: `${f.name} ${f.id}`.toLowerCase(),
  }));

  const doSave = () =>
    save.mutate(draft, {
      onSuccess: (s) => {
        setDraft(structuredClone(s));
        message.success('Đã lưu cài đặt');
        // Giờ làm việc / field map ảnh hưởng tới các màn khác
        void qc.invalidateQueries({ queryKey: ['meta'] });
        void qc.invalidateQueries({ queryKey: ['timesheet'] });
        void qc.invalidateQueries({ queryKey: ['my-issues'] });
        detect.mutate(undefined, { onSuccess: setDetected });
      },
      onError: (e) => message.error(errorMessage(e)),
    });

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div className="settings-bar" style={{ background: token.colorBgLayout }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Cài đặt
        </Typography.Title>
        <Space wrap>
          {dirty && <Tag color="orange">Có thay đổi chưa lưu</Tag>}
          <Button
            icon={<UndoOutlined />}
            disabled={!dirty}
            onClick={() => setDraft(structuredClone(settingsQ.data!))}
          >
            Huỷ thay đổi
          </Button>
          <Popconfirm
            title="Đưa mọi cài đặt về mặc định?"
            description="Chỉ thay đổi trên form, bấm Lưu để áp dụng."
            okText="Về mặc định"
            cancelText="Huỷ"
            onConfirm={() => setDraft(structuredClone(DEFAULT_SETTINGS))}
          >
            <Button>Mặc định</Button>
          </Popconfirm>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            disabled={!dirty}
            loading={save.isPending}
            onClick={doSave}
          >
            Lưu
          </Button>
        </Space>
      </div>

      {/* ---------- Field map ---------- */}
      <Card
        size="small"
        title="Map field Jira"
        extra={
          <Button
            icon={<RadarChartOutlined />}
            loading={detect.isPending}
            onClick={() =>
              detect.mutate(undefined, {
                onSuccess: (d) => {
                  setDetected(d);
                  message.success('Đã dò lại field theo cài đặt đang lưu');
                },
                onError: (e) => message.error(errorMessage(e)),
              })
            }
          >
            Tự dò
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Thứ tự dò: <b>Field id</b> nếu đã chọn → kiểu field (Epic Link, Sprint) → <b>tên field</b>. Để trống
          field id để tự dò theo tên.
        </Typography.Paragraph>
        <Table
          size="small"
          pagination={false}
          rowKey="key"
          dataSource={FIELD_ROWS}
          scroll={{ x: 760 }}
          columns={[
            {
              title: 'Mục',
              width: 140,
              render: (_, r) => (
                <Tooltip title={r.hint}>
                  <Typography.Text strong>{r.label}</Typography.Text>
                </Tooltip>
              ),
            },
            {
              title: 'Tên field để tự dò',
              width: 200,
              render: (_, r) => (
                <Input
                  value={draft.fields[r.key].name}
                  onChange={(e) => set((d) => void (d.fields[r.key].name = e.target.value))}
                />
              ),
            },
            {
              title: 'Field id (tuỳ chọn)',
              render: (_, r) => (
                <Select
                  showSearch
                  allowClear
                  style={{ width: '100%' }}
                  placeholder="Tự dò theo tên"
                  loading={fieldsQ.isLoading}
                  value={draft.fields[r.key].id}
                  options={fieldOptions}
                  filterOption={(input, o) => (o?.search ?? '').includes(input.toLowerCase())}
                  onChange={(v?: string) =>
                    set((d) => {
                      if (v) d.fields[r.key].id = v;
                      else delete d.fields[r.key].id;
                    })
                  }
                />
              ),
            },
            {
              title: 'Đang dùng',
              width: 220,
              render: (_, r) => {
                const f = detected?.[r.key];
                return f ? (
                  <Space size={4}>
                    <CheckCircleFilled style={{ color: '#52c41a' }} />
                    <span>
                      {f.name} <Typography.Text type="secondary">({f.id})</Typography.Text>
                    </span>
                  </Space>
                ) : detected ? (
                  <Space size={4}>
                    <WarningFilled style={{ color: '#faad14' }} />
                    <Typography.Text type="warning">Không tìm thấy</Typography.Text>
                  </Space>
                ) : (
                  <Spin size="small" />
                );
              },
            },
          ]}
        />
      </Card>

      <Row gutter={[16, 16]}>
        {/* ---------- Giờ làm việc ---------- */}
        <Col xs={24} lg={12}>
          <Card size="small" title="Giờ làm việc" style={{ height: '100%' }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space wrap>
                <Typography.Text>Số giờ / ngày (1d):</Typography.Text>
                <InputNumber
                  min={0.5}
                  max={24}
                  step={0.5}
                  value={ws.hoursPerDay}
                  onChange={(v) => v && set((d) => void (d.workSchedule.hoursPerDay = v))}
                />
              </Space>

              <Typography.Text>
                Khung giờ làm việc (tính Estimate từ From → To, giờ bắt đầu log):
              </Typography.Text>
              {ws.windows.map((w, i) => (
                <Space key={i}>
                  <TimePicker.RangePicker
                    format="HH:mm"
                    minuteStep={15}
                    allowClear={false}
                    value={[dayjs(w.start, 'HH:mm'), dayjs(w.end, 'HH:mm')]}
                    onChange={(v) =>
                      v?.[0] &&
                      v[1] &&
                      set(
                        (d) =>
                          void (d.workSchedule.windows[i] = {
                            start: v[0]!.format('HH:mm'),
                            end: v[1]!.format('HH:mm'),
                          }),
                      )
                    }
                  />
                  <Button
                    danger
                    type="text"
                    icon={<DeleteOutlined />}
                    disabled={ws.windows.length <= 1}
                    onClick={() => set((d) => void d.workSchedule.windows.splice(i, 1))}
                  />
                </Space>
              ))}
              <Button
                icon={<PlusOutlined />}
                size="small"
                onClick={() =>
                  set((d) => {
                    const last = d.workSchedule.windows.at(-1);
                    const start = last ? last.end : '08:00';
                    const end = `${String(Math.min(23, Number(start.slice(0, 2)) + 2)).padStart(2, '0')}:${start.slice(3)}`;
                    d.workSchedule.windows.push({ start, end });
                  })
                }
              >
                Thêm khung giờ
              </Button>
              {windowMinutes !== ws.hoursPerDay * 60 && (
                <Alert
                  type="warning"
                  showIcon
                  message={`Tổng khung giờ = ${Math.round((windowMinutes / 60) * 100) / 100}h, khác số giờ/ngày (${ws.hoursPerDay}h). Estimate tính theo khung giờ nên 1 ngày trọn sẽ không đúng bằng 1d.`}
                />
              )}

              <Divider style={{ margin: '8px 0' }} />
              <Typography.Text>Ngày làm việc trong tuần:</Typography.Text>
              <Checkbox.Group
                options={WEEKDAYS}
                value={ws.workingWeekdays}
                onChange={(v) => set((d) => void (d.workSchedule.workingWeekdays = (v as number[]).sort()))}
              />
              <Space wrap>
                <Typography.Text>Múi giờ gửi lên Jira:</Typography.Text>
                <Select
                  style={{ width: 200 }}
                  value={draft.utcOffset}
                  options={OFFSETS}
                  onChange={(v) => set((d) => void (d.utcOffset = v))}
                />
              </Space>
            </Space>
          </Card>
        </Col>

        {/* ---------- Ngày nghỉ ---------- */}
        <Col xs={24} lg={12}>
          <Card size="small" title={`Ngày nghỉ (${ws.holidays.length})`} style={{ height: '100%' }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                Ngày nghỉ không tính giờ làm việc (Estimate, giờ chuẩn timesheet). Mặc định để trống — ngày lễ
                tính như ngày thường.
              </Typography.Text>
              <DatePicker
                format="DD/MM/YYYY"
                placeholder="Thêm ngày nghỉ"
                value={null}
                onChange={(d: Dayjs | null) =>
                  d &&
                  set((x) => {
                    const v = d.format('YYYY-MM-DD');
                    if (!x.workSchedule.holidays.includes(v))
                      x.workSchedule.holidays = [...x.workSchedule.holidays, v].sort();
                  })
                }
              />
              {ws.holidays.length ? (
                <Space size={[4, 8]} wrap>
                  {ws.holidays.map((h) => (
                    <Tag
                      key={h}
                      closable
                      onClose={(e) => {
                        e.preventDefault();
                        set(
                          (x) =>
                            void (x.workSchedule.holidays = x.workSchedule.holidays.filter((d) => d !== h)),
                        );
                      }}
                    >
                      {dayjs(h).format('ddd DD/MM/YYYY')}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có ngày nghỉ" />
              )}
              {ws.holidays.length > 0 && (
                <Button size="small" danger onClick={() => set((x) => void (x.workSchedule.holidays = []))}>
                  Xoá tất cả
                </Button>
              )}
            </Space>
          </Card>
        </Col>
      </Row>

      {/* ---------- Mặc định khi tạo issue ---------- */}
      <Card size="small" title="Mặc định khi tạo issue">
        <Row gutter={[16, 12]}>
          <Col xs={24} md={12}>
            <Typography.Text>Labels mặc định cho dòng mới:</Typography.Text>
            <Select
              mode="tags"
              style={{ width: '100%' }}
              placeholder="Gõ label rồi Enter"
              value={draft.defaults.labels}
              tokenSeparators={[',', ' ']}
              onChange={(v: string[]) =>
                set((d) => void (d.defaults.labels = v.map((l) => l.trim().replace(/\s+/g, '_'))))
              }
            />
          </Col>
          <Col xs={24} md={12}>
            <Typography.Text>
              Components mặc định (theo tên, áp dụng nếu project có component đó):
            </Typography.Text>
            <Select
              mode="tags"
              style={{ width: '100%' }}
              placeholder="Gõ tên component rồi Enter"
              value={draft.defaults.components}
              tokenSeparators={[',']}
              onChange={(v: string[]) => set((d) => void (d.defaults.components = v))}
            />
          </Col>
          <Col xs={24} md={12}>
            <Typography.Text>
              Mẫu summary (<Typography.Text code>{'{summary}'}</Typography.Text> = summary đã nhập):
            </Typography.Text>
            <Input
              value={draft.defaults.summaryTemplate}
              placeholder="{summary}"
              onChange={(e) => set((d) => void (d.defaults.summaryTemplate = e.target.value))}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              VD:{' '}
              <b>
                {applySummaryTemplate(
                  draft.defaults.summaryTemplate || '{summary}',
                  'Xây dựng API đăng nhập',
                )}
              </b>
              {!draft.defaults.summaryTemplate.includes('{summary}') &&
                draft.defaults.summaryTemplate.trim() && <> (khi lưu sẽ tự thêm {'{summary}'} vào cuối)</>}
            </Typography.Text>
          </Col>
          <Col xs={24} md={12}>
            <Typography.Text>Kế thừa từ issue gốc (mặc định khi mở lưới):</Typography.Text>
            <div>
              {(
                [
                  ['sprint', 'Sprint'],
                  ['fixVersions', 'Fix version'],
                  ['components', 'Components'],
                  ['labels', 'Labels'],
                ] as const
              ).map(([k, label]) => (
                <Checkbox
                  key={k}
                  checked={draft.defaults.inherit[k]}
                  onChange={(e) => set((d) => void (d.defaults.inherit[k] = e.target.checked))}
                >
                  {label}
                </Checkbox>
              ))}
            </div>
          </Col>
        </Row>
      </Card>

      {/* ---------- Cache ---------- */}
      <Card size="small" title="Cache metadata">
        <Space wrap>
          <Typography.Text type="secondary">
            Issue type, field, component, label… được cache 10 phút. Làm mới khi vừa đổi cấu hình trên Jira.
          </Typography.Text>
          <Button
            icon={<ReloadOutlined />}
            loading={refresh.isPending}
            onClick={() =>
              refresh.mutate(undefined, {
                onSuccess: (r) => {
                  void qc.invalidateQueries({ queryKey: ['meta'] });
                  void qc.invalidateQueries({ queryKey: ['meta-fields'] });
                  message.success(`Đã xoá ${r.cleared} mục cache`);
                },
                onError: (e) => message.error(errorMessage(e)),
              })
            }
          >
            Làm mới metadata
          </Button>
        </Space>
      </Card>
    </Space>
  );
}
