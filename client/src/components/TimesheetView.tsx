import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  Popover,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleFilled,
  FileExcelOutlined,
  PlusOutlined,
  ReloadOutlined,
  WarningFilled,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import type { TimesheetDay, TimesheetIssue } from '@jpw/shared';
import { useQueryClient } from '@tanstack/react-query';
import { downloadFile, errorMessage } from '../api/http';
import { useSettings } from '../api/hooks';
import { useWorklogMutation } from '../api/myIssues';
import { useTimesheet } from '../api/timesheet';
import { rangePresets, type DateRange } from '../lib/dateRanges';

const WEEKDAY = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const FMT = 'YYYY-MM-DD';
const h = (m: number) => {
  const v = Math.round((m / 60) * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '');
};

/** Popover log nhanh 1 ô (issue × ngày) */
function QuickLog({ issue, day, onDone }: { issue: TimesheetIssue; day: TimesheetDay; onDone: () => void }) {
  const { message } = App.useApp();
  const settings = useSettings().data;
  const mutation = useWorklogMutation();
  const dayStart = settings?.workSchedule.windows[0]?.start ?? '08:00';
  const hpd = settings?.workSchedule.hoursPerDay ?? 8;
  const left = Math.max(0, hpd * 60 - day.minutes);
  const [hours, setHours] = useState<number | null>(left ? left / 60 : 1);
  const [time, setTime] = useState<Dayjs>(dayjs(dayStart, 'HH:mm'));
  const [comment, setComment] = useState('');
  const mine = issue.worklogs.filter((w) => w.date === day.date);
  const outside =
    (issue.from && day.date < issue.from.slice(0, 10)) || (issue.to && day.date > issue.to.slice(0, 10));

  const submit = () => {
    if (!hours || hours <= 0) return;
    const minutes = Math.round(hours * 60);
    mutation.mutate(
      {
        key: issue.key,
        input: {
          date: day.date,
          time: time.format('HH:mm'),
          duration: `${Math.floor(minutes / 60)}h ${minutes % 60}m`,
          comment: comment.trim() || undefined,
        },
      },
      {
        onSuccess: (res) => {
          message.success(`Đã log ${h(minutes)}h vào ${issue.key} ngày ${dayjs(day.date).format('DD/MM')}`);
          if (res.estimateUpdated) {
            message.info(
              `Estimate ${issue.key}: ${res.estimateUpdated.from ?? '—'} → ${res.estimateUpdated.to}`,
            );
          }
          res.warnings.forEach((w) => message.warning(w, 6));
          onDone();
        },
        onError: (e) => message.error(errorMessage(e), 6),
      },
    );
  };

  return (
    <Space direction="vertical" size="small" style={{ width: 280 }}>
      <Typography.Text strong>
        {issue.key} · {WEEKDAY[day.weekday]} {dayjs(day.date).format('DD/MM/YYYY')}
      </Typography.Text>
      {mine.length > 0 && (
        <div style={{ fontSize: 12 }}>
          {mine.map((w) => (
            <div key={w.id}>
              {w.start.slice(11, 16)} · {h(w.minutes)}h{w.comment ? ` · ${w.comment}` : ''}
            </div>
          ))}
        </div>
      )}
      {outside && (
        <Alert
          type="warning"
          showIcon
          message={`Ngày này nằm ngoài Start → Due của issue (${issue.from?.slice(0, 10) ?? '—'} → ${issue.to?.slice(0, 10) ?? '—'}) → theo quy tắc log work, app sẽ không cho log ngày này.`}
        />
      )}
      <Space>
        <InputNumber
          min={0.25}
          step={0.5}
          value={hours}
          onChange={setHours}
          addonAfter="giờ"
          style={{ width: 120 }}
          autoFocus
          onPressEnter={submit}
        />
        <TimePicker
          value={time}
          onChange={(t) => t && setTime(t)}
          format="HH:mm"
          minuteStep={15}
          allowClear={false}
        />
      </Space>
      <Input
        placeholder="Ghi chú (tuỳ chọn)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onPressEnter={submit}
      />
      <Button
        type="primary"
        icon={<PlusOutlined />}
        block
        loading={mutation.isPending}
        disabled={!hours}
        onClick={submit}
      >
        Log {hours ? `${h(Math.round(hours * 60))}h` : ''}
      </Button>
    </Space>
  );
}

/**
 * Timesheet issue × ngày (dùng ở trang Worklog và dock trên trang tạo issue).
 * compact: bỏ tiêu đề và thẻ thống kê, bảng thấp hơn.
 */
export function TimesheetView({
  range,
  onRangeChange,
  compact,
}: {
  range: DateRange;
  onRangeChange: (r: DateRange) => void;
  compact?: boolean;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const setRange = onRangeChange;
  const from = range[0].format(FMT);
  const to = range[1].format(FMT);
  const q = useTimesheet(from, to);
  const data = q.data;
  const [exporting, setExporting] = useState(false);
  const [openCell, setOpenCell] = useState<string | null>(null);

  const shortSet = useMemo(() => new Set(data?.shortDays.map((d) => d.date)), [data]);
  const overSet = useMemo(() => new Set(data?.overDays.map((d) => d.date)), [data]);
  const violations = data?.issues.filter((i) => i.ruleIssues.length) ?? [];
  const today = dayjs().format(FMT);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['timesheet'] });

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const name = await downloadFile(
        `/worklog/timesheet.xlsx?from=${from}&to=${to}`,
        `timesheet-${from}_${to}.xlsx`,
      );
      message.success(`Đã xuất ${name}`);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const columns: ColumnsType<TimesheetIssue> = [
    {
      title: 'Issue',
      key: 'issue',
      fixed: 'left',
      width: 300,
      render: (_, i) => (
        <Space direction="vertical" size={0} style={{ maxWidth: 284 }}>
          <Space size={4}>
            {i.issueType.iconUrl && <img src={i.issueType.iconUrl} width={14} height={14} alt="" />}
            <a href={i.url} target="_blank" rel="noreferrer">
              {i.key}
            </a>
            <Tag style={{ marginInlineEnd: 0 }}>{i.status.name}</Tag>
            {i.ruleIssues.length > 0 && (
              <Tooltip title={<div style={{ whiteSpace: 'pre-line' }}>{i.ruleIssues.join('\n')}</div>}>
                <WarningFilled style={{ color: '#faad14' }} />
              </Tooltip>
            )}
          </Space>
          <Typography.Text ellipsis={{ tooltip: i.summary }} style={{ fontSize: 12 }}>
            {i.summary}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: (
        <Tooltip title="Estimate · tổng log của mọi người · còn lại">
          <span>Est · Log · Còn</span>
        </Tooltip>
      ),
      key: 'est',
      width: 130,
      render: (_, i) => (
        <Typography.Text style={{ fontSize: 12 }} type={i.ruleIssues.length ? 'warning' : undefined}>
          {i.estimate ?? '—'} · {h(i.spentMinutes)}h · {i.remaining ?? '—'}
        </Typography.Text>
      ),
    },
    ...(data?.days ?? []).map((d) => ({
      key: d.date,
      width: 54,
      align: 'center' as const,
      title: (
        <div
          style={{
            lineHeight: 1.15,
            fontWeight: d.date === today ? 700 : undefined,
            opacity: d.working ? 1 : 0.55,
          }}
        >
          <div style={{ fontSize: 11 }}>{WEEKDAY[d.weekday]}</div>
          <div style={{ fontSize: 12 }}>{dayjs(d.date).format('DD/MM')}</div>
        </div>
      ),
      onCell: () => ({
        className: `ts-cell${d.working ? '' : ' cell-weekend'}${d.date === today ? ' ts-today' : ''}`,
      }),
      render: (_: unknown, i: TimesheetIssue) => {
        const m = i.byDay[d.date];
        const cellKey = `${i.key}|${d.date}`;
        return (
          <Popover
            trigger="click"
            destroyTooltipOnHide
            open={openCell === cellKey}
            onOpenChange={(o) => setOpenCell(o ? cellKey : null)}
            content={
              <QuickLog
                issue={i}
                day={d}
                onDone={() => {
                  setOpenCell(null);
                  refresh();
                }}
              />
            }
          >
            <div className="ts-click" title="Bấm để log nhanh">
              {m ? <Typography.Text strong>{h(m)}</Typography.Text> : <span className="ts-empty">+</span>}
            </div>
          </Popover>
        );
      },
    })),
    {
      title: 'Tổng',
      key: 'total',
      fixed: 'right',
      width: 64,
      align: 'center',
      render: (_, i) => <Typography.Text strong>{h(i.minutes)}</Typography.Text>,
    },
  ];

  const diff = data ? data.totalMinutes - data.expectedMinutes : 0;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap style={{ justifyContent: compact ? 'flex-end' : 'space-between', width: '100%' }}>
        {!compact && (
          <Typography.Title level={4} style={{ margin: 0 }}>
            Worklog / Timesheet
          </Typography.Title>
        )}
        <Space wrap>
          <DatePicker.RangePicker
            value={range}
            format="DD/MM/YYYY"
            allowClear={false}
            presets={rangePresets()}
            onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])}
          />
          <Button icon={<ReloadOutlined />} loading={q.isFetching} onClick={refresh}>
            Làm mới
          </Button>
          <Button icon={<FileExcelOutlined />} loading={exporting} disabled={!data} onClick={exportXlsx}>
            Xuất Excel
          </Button>
        </Space>
      </Space>

      {q.isError && <Alert type="error" showIcon message={errorMessage(q.error)} />}
      {data?.warnings.map((w) => (
        <Alert key={w} type="warning" showIcon message={w} />
      ))}

      {!compact && (
        <Row gutter={[12, 12]}>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="Tổng giờ đã log"
                value={data ? h(data.totalMinutes) : '—'}
                suffix="h"
                loading={q.isLoading}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title={
                  <Tooltip
                    title={`Số ngày làm việc đã qua (trước hôm nay) trong kỳ × ${data?.hoursPerDay ?? 8}h`}
                  >
                    Giờ chuẩn (đến hết hôm qua)
                  </Tooltip>
                }
                value={data ? h(data.expectedMinutes) : '—'}
                suffix="h"
                loading={q.isLoading}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="Chênh lệch"
                value={data ? `${diff > 0 ? '+' : ''}${h(diff)}` : '—'}
                suffix="h"
                valueStyle={{ color: diff < 0 ? '#ff4d4f' : diff > 0 ? '#faad14' : '#52c41a' }}
                loading={q.isLoading}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="Ngày thiếu giờ · Issue vi phạm"
                value={data ? `${data.shortDays.length} · ${violations.length}` : '—'}
                valueStyle={{
                  color: data && (data.shortDays.length || violations.length) ? '#ff4d4f' : '#52c41a',
                }}
                loading={q.isLoading}
              />
            </Card>
          </Col>
        </Row>
      )}

      {data && (data.shortDays.length > 0 || data.overDays.length > 0 || violations.length > 0) && (
        <Card size="small" title="Cảnh báo">
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {data.shortDays.length > 0 && (
              <div>
                <Typography.Text type="danger" strong>
                  Thiếu giờ ({data.shortDays.length} ngày):{' '}
                </Typography.Text>
                {data.shortDays.map((d) => (
                  <Tag key={d.date} color="red">
                    {WEEKDAY[dayjs(d.date).day()]} {dayjs(d.date).format('DD/MM')} · {h(d.minutes)}/
                    {data.hoursPerDay}h
                  </Tag>
                ))}
              </div>
            )}
            {data.overDays.length > 0 && (
              <div>
                <Typography.Text type="warning" strong>
                  Vượt giờ:{' '}
                </Typography.Text>
                {data.overDays.map((d) => (
                  <Tag key={d.date} color="orange">
                    {dayjs(d.date).format('DD/MM')} · {h(d.minutes)}h
                  </Tag>
                ))}
              </div>
            )}
            {violations.map((i) => (
              <div key={i.key}>
                <WarningFilled style={{ color: '#faad14' }} />{' '}
                <a href={i.url} target="_blank" rel="noreferrer">
                  {i.key}
                </a>
                : {i.ruleIssues.join('; ')}
              </div>
            ))}
          </Space>
        </Card>
      )}

      <Card size="small" bodyStyle={{ padding: 0 }}>
        <Table<TimesheetIssue>
          rowKey="key"
          size="small"
          bordered
          className="timesheet"
          loading={q.isFetching}
          dataSource={data?.issues ?? []}
          columns={columns}
          pagination={false}
          scroll={{
            x: 300 + 130 + 64 + (data?.days.length ?? 0) * 54,
            y: compact ? 'calc(55vh - 170px)' : 'calc(100vh - 420px)',
          }}
          sticky
          locale={{ emptyText: <Empty description="Không có worklog nào của bạn trong khoảng này" /> }}
          summary={() =>
            data && data.issues.length ? (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={2}>
                    <Typography.Text strong>Tổng theo ngày</Typography.Text>
                  </Table.Summary.Cell>
                  {data.days.map((d, idx) => (
                    <Table.Summary.Cell
                      key={d.date}
                      index={idx + 2}
                      align="center"
                      className={
                        shortSet.has(d.date) ? 'ts-short' : overSet.has(d.date) ? 'ts-over' : undefined
                      }
                    >
                      <Tooltip
                        title={
                          shortSet.has(d.date)
                            ? `Thiếu ${h(data.hoursPerDay * 60 - d.minutes)}h`
                            : overSet.has(d.date)
                              ? `Vượt ${h(d.minutes - data.hoursPerDay * 60)}h`
                              : undefined
                        }
                      >
                        <Typography.Text strong>
                          {d.minutes ? h(d.minutes) : d.working && d.date < today ? '0' : ''}
                        </Typography.Text>
                      </Tooltip>
                    </Table.Summary.Cell>
                  ))}
                  <Table.Summary.Cell index={data.days.length + 2} align="center">
                    <Typography.Text strong>{h(data.totalMinutes)}</Typography.Text>
                  </Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            ) : null
          }
        />
      </Card>
      {data && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <CheckCircleFilled /> Chỉ tính worklog của bạn, theo ngày bắt đầu (múi giờ Jira của bạn). Bấm vào
          một ô để log nhanh. JQL: <Typography.Text code>{data.jql}</Typography.Text>
        </Typography.Text>
      )}
    </Space>
  );
}
