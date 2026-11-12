import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  DatePicker,
  Input,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, SaveOutlined, CloseOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import {
  estimateAfterLog,
  formatJiraDuration,
  parseJiraDuration,
  validateWorklogEntry,
  type MyIssue,
  type MyWorklog,
  type WorklogSaveResponse,
} from '@jpw/shared';
import { DailyWorklogGrid } from './DailyWorklogGrid';
import { useSettings } from '../api/hooks';
import { errorMessage } from '../api/http';
import { useWorklogMutation } from '../api/myIssues';

const hm = (m: number) =>
  [Math.floor(m / 60) ? `${Math.floor(m / 60)}h` : '', m % 60 ? `${m % 60}m` : '']
    .filter(Boolean)
    .join(' ') || '0m';

interface FormState {
  id?: string;
  date: Dayjs | null;
  time: Dayjs | null;
  duration: string;
  comment: string;
}

/** Log work dưới 1 issue: danh sách worklog + thêm / sửa / xoá */
export function WorklogPanel({
  issue,
  dirty,
  onUpdated,
}: {
  issue: MyIssue;
  /** Dòng đang có thay đổi chưa lưu (From/To/Estimate có thể khác Jira) */
  dirty?: boolean;
  onUpdated: (issue: MyIssue) => void;
}) {
  const { message } = App.useApp();
  const settings = useSettings().data;
  const mutation = useWorklogMutation();
  const hpd = settings?.workSchedule.hoursPerDay ?? 8;
  const dayStart = settings?.workSchedule.windows[0]?.start ?? '08:00';

  const fromDay = issue.from ? dayjs(issue.from.slice(0, 10)) : null;
  const toDay = issue.to ? dayjs(issue.to.slice(0, 10)) : null;
  const logged = issue.worklogs.reduce((s, w) => s + w.minutes, 0);
  const est = issue.estimateMinutes;
  const left = est !== undefined ? Math.max(0, est - logged) : undefined;

  const blank = (): FormState => {
    let d = dayjs().startOf('day');
    if (fromDay && d.isBefore(fromDay)) d = fromDay;
    if (toDay && d.isAfter(toDay)) d = toDay;
    return {
      date: d,
      time: dayjs(dayStart, 'HH:mm'),
      duration: '',
      comment: '',
    };
  };
  const [form, setForm] = useState<FormState>(blank);

  // Ô thời gian trống → dùng gợi ý: phần còn lại tới Estimate (tối đa 1 ngày), hết thì 1 ngày
  const suggested = left ? Math.min(left, hpd * 60) : hpd * 60;
  const durationText = form.duration.trim() || hm(suggested);
  const minutes = parseJiraDuration(durationText, hpd);
  const errors = useMemo(() => {
    const list: string[] = [];
    if (minutes === null) list.push('Thời gian không hợp lệ (VD: 2h, 1h 30m, 0.5d)');
    if (!form.date || !form.time) list.push('Chọn ngày và giờ bắt đầu');
    if (minutes !== null && form.date) {
      list.push(
        ...validateWorklogEntry({
          issue,
          date: form.date.format('YYYY-MM-DD'),
          minutes,
          excludeId: form.id,
          hoursPerDay: hpd,
        }),
      );
    }
    return list;
  }, [form, minutes, issue, hpd]);

  const run = (id: string | undefined, input: Parameters<typeof mutation.mutate>[0]['input'], ok: string) =>
    mutation.mutate(
      { key: issue.key, id, input },
      {
        onSuccess: (res) => {
          afterSave(res);
          message.success(ok);
          setForm(blank());
        },
        onError: (e) => message.error(errorMessage(e)),
      },
    );

  const afterSave = (res: WorklogSaveResponse) => {
    onUpdated(res.issue);
    if (res.estimateUpdated) {
      message.info(
        `Estimate ${issue.key}: ${res.estimateUpdated.from ?? '—'} → ${res.estimateUpdated.to} (= tổng log)`,
      );
    }
    res.warnings.forEach((w) => message.warning(w, 6));
  };

  // Tổng sau khi ghi (để báo trước việc nâng Estimate)
  const editingOld = form.id ? (issue.worklogs.find((w) => w.id === form.id)?.minutes ?? 0) : 0;
  const totalAfter = logged - editingOld + (minutes ?? 0);
  const bump = minutes ? estimateAfterLog(est, totalAfter) : undefined;

  const submit = () => {
    if (errors.length || minutes === null || !form.date || !form.time) return;
    run(
      form.id,
      {
        date: form.date.format('YYYY-MM-DD'),
        time: form.time.format('HH:mm'),
        duration: formatJiraDuration(minutes, hpd),
        comment: form.comment.trim() || undefined,
      },
      form.id ? `Đã sửa worklog trên ${issue.key}` : `Đã log ${hm(minutes)} vào ${issue.key}`,
    );
  };

  const edit = (w: MyWorklog) =>
    setForm({
      id: w.id,
      date: dayjs(w.date),
      time: dayjs(w.start.slice(11, 16) || dayStart, 'HH:mm'),
      duration: formatJiraDuration(w.minutes, 24),
      comment: w.comment ?? '',
    });

  const pct = est ? Math.min(100, Math.round((logged / est) * 100)) : 0;

  return (
    <div style={{ padding: '4px 8px 8px 40px' }}>
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Space wrap size="middle">
          <Typography.Text strong>Log work · {issue.key}</Typography.Text>
          <Typography.Text type="secondary">
            Khoảng được log: {fromDay ? fromDay.format('DD/MM/YYYY') : '—'} →{' '}
            {toDay ? toDay.format('DD/MM/YYYY') : '—'}
          </Typography.Text>
          <Space size={6}>
            <Progress
              percent={pct}
              size="small"
              style={{ width: 140, margin: 0 }}
              status={est !== undefined && logged > est ? 'exception' : pct === 100 ? 'success' : 'active'}
              showInfo={false}
            />
            <Typography.Text>
              {hm(logged)} / {est !== undefined ? formatJiraDuration(est, hpd) : 'chưa có Estimate'}
            </Typography.Text>
            {left !== undefined && (
              <Tag color={left ? 'blue' : 'green'}>
                {left ? `còn ${hm(left)} tới Estimate` : 'đủ Estimate'}
              </Tag>
            )}
          </Space>
        </Space>

        {dirty && (
          <Alert
            type="info"
            showIcon
            message="Dòng này có thay đổi chưa lưu. Log work được kiểm tra theo Start date / Due date / Estimate đang có trên Jira — hãy Lưu thay đổi trước nếu bạn vừa sửa các ô đó."
          />
        )}

        <Typography.Text type="secondary">
          Log theo ngày (From → To) — nhập số giờ của bạn cho từng ngày rồi lưu một lần:
        </Typography.Text>
        {settings && (
          <DailyWorklogGrid
            key={
              issue.worklogs.map((w) => `${w.id}:${w.minutes}:${w.date}`).join('|') + issue.from + issue.to
            }
            issue={issue}
            schedule={settings.workSchedule}
            onSaved={afterSave}
          />
        )}

        <Typography.Text type="secondary" style={{ marginTop: 4 }}>
          Danh sách worklog / thêm 1 worklog (chọn giờ, ghi chú riêng):
        </Typography.Text>
        <Table<MyWorklog>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={issue.worklogs}
          locale={{ emptyText: 'Chưa có worklog' }}
          rowClassName={(w) => (w.id === form.id ? 'row-dirty' : '')}
          columns={[
            {
              title: 'Ngày giờ',
              width: 150,
              render: (_, w) => {
                const out =
                  (fromDay && dayjs(w.date).isBefore(fromDay)) || (toDay && dayjs(w.date).isAfter(toDay));
                return (
                  <Space size={4}>
                    {dayjs(w.start || w.date).format('ddd DD/MM HH:mm')}
                    {out && (
                      <Tooltip title="Ngoài khoảng Start date → Due date">
                        <Tag color="warning">ngoài khoảng</Tag>
                      </Tooltip>
                    )}
                  </Space>
                );
              },
            },
            { title: 'Thời gian', width: 90, render: (_, w) => hm(w.minutes) },
            { title: 'Người log', width: 150, render: (_, w) => w.author ?? '—' },
            {
              title: 'Ghi chú',
              render: (_, w) => <Typography.Text type="secondary">{w.comment ?? ''}</Typography.Text>,
            },
            {
              title: '',
              width: 80,
              render: (_, w) =>
                w.mine ? (
                  <Space size={0}>
                    <Tooltip title="Sửa">
                      <Button size="small" type="text" icon={<EditOutlined />} onClick={() => edit(w)} />
                    </Tooltip>
                    <Popconfirm
                      title="Xoá worklog này?"
                      description={`${dayjs(w.date).format('DD/MM')} · ${hm(w.minutes)} — Remaining sẽ được cộng lại.`}
                      okText="Xoá"
                      okButtonProps={{ danger: true }}
                      cancelText="Huỷ"
                      onConfirm={() => run(w.id, undefined, `Đã xoá worklog trên ${issue.key}`)}
                    >
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                ) : (
                  <Tooltip title="Worklog của người khác — không sửa được">
                    <Typography.Text type="secondary">—</Typography.Text>
                  </Tooltip>
                ),
            },
          ]}
        />

        <Space wrap align="start">
          <DatePicker
            value={form.date}
            format="DD/MM/YYYY"
            allowClear={false}
            onChange={(d) => setForm({ ...form, date: d })}
            disabledDate={(d) =>
              Boolean((fromDay && d.isBefore(fromDay, 'day')) || (toDay && d.isAfter(toDay, 'day')))
            }
            style={{ width: 130 }}
          />
          <TimePicker
            value={form.time}
            format="HH:mm"
            minuteStep={15}
            allowClear={false}
            onChange={(t) => setForm({ ...form, time: t })}
            style={{ width: 95 }}
          />
          <Tooltip title="VD: 2h, 1h 30m, 0.5d (1d = số giờ/ngày trong Cài đặt)">
            <Input
              value={form.duration}
              placeholder={`VD ${hm(suggested)}`}
              onChange={(e) => setForm({ ...form, duration: e.target.value })}
              status={errors.length ? 'error' : undefined}
              style={{ width: 110 }}
              onPressEnter={submit}
            />
          </Tooltip>
          <Input
            value={form.comment}
            placeholder="Ghi chú (tuỳ chọn)"
            onChange={(e) => setForm({ ...form, comment: e.target.value })}
            style={{ width: 260 }}
            onPressEnter={submit}
          />
          <Button
            type="primary"
            icon={form.id ? <SaveOutlined /> : <PlusOutlined />}
            disabled={errors.length > 0}
            loading={mutation.isPending}
            onClick={submit}
          >
            {form.id ? `Lưu worklog (${hm(minutes ?? 0)})` : `Log work ${hm(minutes ?? 0)}`}
          </Button>
          {(form.id || form.duration.trim() || form.comment.trim()) && (
            <Button icon={<CloseOutlined />} onClick={() => setForm(blank())}>
              {form.id ? 'Huỷ sửa' : 'Huỷ'}
            </Button>
          )}
        </Space>
        {bump !== undefined && !errors.length && (
          <Typography.Text type="warning" style={{ display: 'block' }}>
            ⚠ Tổng log sẽ là {hm(totalAfter)} &gt; Estimate{' '}
            {est !== undefined ? formatJiraDuration(est, hpd) : '(chưa có)'} → Estimate sẽ được cập nhật ={' '}
            {formatJiraDuration(bump, hpd)}
          </Typography.Text>
        )}
        {errors.length > 0 &&
          errors.map((e) => (
            <Typography.Text key={e} type="danger" style={{ display: 'block' }}>
              ✖ {e}
            </Typography.Text>
          ))}
      </Space>
    </div>
  );
}
