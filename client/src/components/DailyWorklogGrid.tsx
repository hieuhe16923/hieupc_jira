import { useMemo, useState } from 'react';
import { Alert, App, Button, Input, InputNumber, Space, Table, Tooltip, Typography } from 'antd';
import { CalendarOutlined, ClearOutlined, CloseOutlined, SaveOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  estimateAfterLog,
  formatJiraDuration,
  planWorklogs,
  worklogDays,
  type MyIssue,
  type WorkSchedule,
  type WorklogSaveResponse,
} from '@jpw/shared';
import { errorMessage } from '../api/http';
import { useDailyWorklog } from '../api/myIssues';

const WEEKDAY = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

const hm = (m: number) =>
  [Math.floor(m / 60) ? `${Math.floor(m / 60)}h` : '', m % 60 ? `${m % 60}m` : '']
    .filter(Boolean)
    .join(' ') || '0m';

/**
 * Log theo ngày: mỗi ngày từ From → To một ô giờ (tổng log của TÔI ngày đó) + tổng.
 * Lưu một lần; tổng log > Estimate → server nâng Estimate = tổng log.
 */
export function DailyWorklogGrid({
  issue,
  schedule,
  onSaved,
}: {
  issue: MyIssue;
  schedule: WorkSchedule;
  onSaved: (res: WorklogSaveResponse) => void;
}) {
  const { message } = App.useApp();
  const save = useDailyWorklog();
  const hpd = schedule.hoursPerDay;

  const days = useMemo(
    () => (issue.from && issue.to ? worklogDays(issue.from, issue.to, schedule) : []),
    [issue.from, issue.to, schedule],
  );
  /** Phút đã log theo ngày: của tôi / của người khác */
  const initial = useMemo(() => {
    const mine: Record<string, number> = {};
    const others: Record<string, number> = {};
    for (const w of issue.worklogs) {
      const bag = w.mine ? mine : others;
      bag[w.date] = (bag[w.date] ?? 0) + w.minutes;
    }
    return { mine, others };
  }, [issue.worklogs]);

  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(days.map((d) => [d.date, initial.mine[d.date] ?? 0])),
  );
  const [comment, setComment] = useState('');

  if (!issue.from || !issue.to) {
    return (
      <Alert
        type="info"
        showIcon
        message="Issue chưa có From (Start date) / To (Due date) — đặt trước khi log theo ngày."
      />
    );
  }
  if (!days.length) {
    return (
      <Alert type="warning" showIcon message="Khoảng From → To quá dài (tối đa 93 ngày) hoặc không hợp lệ." />
    );
  }

  const inRange = new Set(days.map((d) => d.date));
  const othersTotal = Object.values(initial.others).reduce((s, m) => s + m, 0);
  // Log của tôi ở ngày ngoài khoảng vẫn được tính vào tổng (không sửa ở lưới này)
  const mineOutside = Object.entries(initial.mine)
    .filter(([d]) => !inRange.has(d))
    .reduce((s, [, m]) => s + m, 0);
  const mineInGrid = days.reduce((s, d) => s + (values[d.date] ?? 0), 0);
  const total = mineInGrid + othersTotal + mineOutside;
  const changed = days.filter((d) => (values[d.date] ?? 0) !== (initial.mine[d.date] ?? 0));
  const bump = estimateAfterLog(issue.estimateMinutes, total);
  const est = issue.estimateMinutes;

  const set = (date: string, minutes: number) => setValues((v) => ({ ...v, [date]: Math.max(0, minutes) }));

  const fillWorkHours = () =>
    setValues(Object.fromEntries(days.map((d) => [d.date, d.working ? d.workMinutes : 0])));

  const fillEstimate = () => {
    if (!est) return;
    // Phần Estimate còn lại sau khi trừ log của người khác / ngoài khoảng, chia theo giờ làm việc
    const target = Math.max(0, est - othersTotal - mineOutside);
    const plan = new Map(
      planWorklogs(issue.from!, issue.to!, schedule, target).map((p) => [p.date, p.minutes]),
    );
    setValues(Object.fromEntries(days.map((d) => [d.date, plan.get(d.date) ?? 0])));
  };

  /** Huỷ: bỏ thay đổi chưa lưu, trả về số giờ đang có trên Jira */
  const cancel = () => {
    setValues(Object.fromEntries(days.map((d) => [d.date, initial.mine[d.date] ?? 0])));
    setComment('');
  };

  const submit = () => {
    if (!changed.length) return;
    save.mutate(
      {
        key: issue.key,
        body: {
          days: changed.map((d) => ({ date: d.date, duration: hm(values[d.date] ?? 0) })),
          comment: comment.trim() || undefined,
        },
      },
      {
        onSuccess: (res) => {
          onSaved(res);
          const ops = [
            res.created ? `tạo ${res.created}` : '',
            res.updated ? `sửa ${res.updated}` : '',
            res.deleted ? `xoá ${res.deleted}` : '',
          ]
            .filter(Boolean)
            .join(', ');
          message.success(`Đã lưu log theo ngày (${ops || 'không đổi'})`);
        },
        onError: (e) => message.error(errorMessage(e)),
      },
    );
  };

  const columns = [
    {
      title: '',
      key: 'label',
      fixed: 'left' as const,
      width: 90,
      render: () => <Typography.Text strong>Giờ log</Typography.Text>,
    },
    ...days.map((d) => {
      const others = initial.others[d.date] ?? 0;
      const dirty = (values[d.date] ?? 0) !== (initial.mine[d.date] ?? 0);
      return {
        key: d.date,
        width: 78,
        align: 'center' as const,
        title: (
          <Tooltip title={d.working ? `Giờ làm việc: ${hm(d.workMinutes)}` : 'Ngày nghỉ'}>
            <div style={{ lineHeight: 1.2, opacity: d.working ? 1 : 0.5 }}>
              <div style={{ fontSize: 11 }}>{WEEKDAY[d.weekday]}</div>
              <div>{dayjs(d.date).format('DD/MM')}</div>
            </div>
          </Tooltip>
        ),
        onCell: () => ({ className: d.working ? undefined : 'cell-weekend' }),
        render: () => (
          <div>
            <InputNumber
              size="small"
              min={0}
              step={0.5}
              value={(values[d.date] ?? 0) / 60 || null}
              placeholder="0"
              onChange={(h) => set(d.date, Math.round(Number(h ?? 0) * 60))}
              style={{ width: 64, borderColor: dirty ? '#faad14' : undefined }}
              controls={false}
            />
            {others > 0 && (
              <Tooltip title="Log của người khác ngày này (không sửa ở đây)">
                <div style={{ fontSize: 11, opacity: 0.6 }}>+{hm(others)}</div>
              </Tooltip>
            )}
          </div>
        ),
      };
    }),
    {
      title: 'Tổng',
      key: 'total',
      fixed: 'right' as const,
      width: 110,
      align: 'center' as const,
      render: () => (
        <Tooltip
          title={
            <div>
              Của tôi trong lưới: {hm(mineInGrid)}
              {mineOutside > 0 && <div>Của tôi ngoài khoảng: {hm(mineOutside)}</div>}
              {othersTotal > 0 && <div>Người khác: {hm(othersTotal)}</div>}
            </div>
          }
        >
          <Typography.Text strong type={bump ? 'warning' : est === total ? 'success' : undefined}>
            {hm(total)}
          </Typography.Text>
          <div style={{ fontSize: 11, opacity: 0.7 }}>
            / {est !== undefined ? formatJiraDuration(est, hpd) : '—'}
          </div>
        </Tooltip>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Table
        size="small"
        bordered
        pagination={false}
        rowKey="key"
        dataSource={[{ key: 'row' }]}
        columns={columns}
        scroll={{ x: 90 + 110 + days.length * 78 }}
        className="daily-worklog"
      />
      <Space wrap>
        <Tooltip title="Mỗi ngày làm việc = số giờ làm việc trong khung giờ (bỏ T7/CN)">
          <Button size="small" icon={<CalendarOutlined />} onClick={fillWorkHours}>
            Điền theo giờ làm việc
          </Button>
        </Tooltip>
        <Tooltip title="Chia Estimate cho các ngày làm việc (tổng = Estimate)">
          <Button size="small" onClick={fillEstimate} disabled={!est}>
            Điền theo Estimate
          </Button>
        </Tooltip>
        <Button
          size="small"
          icon={<ClearOutlined />}
          onClick={() => setValues(Object.fromEntries(days.map((d) => [d.date, 0])))}
        >
          Xoá hết
        </Button>
        <Input
          size="small"
          placeholder="Ghi chú cho log mới (tuỳ chọn)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          style={{ width: 240 }}
        />
        <Button
          type="primary"
          size="small"
          icon={<SaveOutlined />}
          disabled={!changed.length}
          loading={save.isPending}
          onClick={submit}
        >
          Lưu log theo ngày{changed.length ? ` (${changed.length} ngày)` : ''}
        </Button>
        <Tooltip title="Bỏ mọi thay đổi chưa lưu, trả về số giờ đang có trên Jira">
          <Button
            size="small"
            icon={<CloseOutlined />}
            disabled={!changed.length && !comment}
            onClick={cancel}
          >
            Huỷ
          </Button>
        </Tooltip>
        {changed.length > 0 && (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            {changed.length} ngày chưa lưu
          </Typography.Text>
        )}
      </Space>
      {bump !== undefined && (
        <Alert
          type="warning"
          showIcon
          message={`Tổng log ${hm(total)} > Estimate ${est !== undefined ? formatJiraDuration(est, hpd) : '(chưa có)'} → khi lưu, Estimate sẽ được cập nhật = ${formatJiraDuration(bump, hpd)}.`}
        />
      )}
    </Space>
  );
}
