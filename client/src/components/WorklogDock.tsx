import { useState } from 'react';
import { Button, Space, Spin, Tag, Tooltip, Typography, theme } from 'antd';
import { ClockCircleOutlined, DownOutlined, ExportOutlined, UpOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { useTimesheet } from '../api/timesheet';
import { thisWeek, type DateRange } from '../lib/dateRanges';
import { TimesheetView } from './TimesheetView';

const OPEN_KEY = 'jpw-worklog-dock-open';
const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
};

const h = (m: number) => {
  const v = Math.round((m / 60) * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '');
};

/**
 * Worklog gắn dưới đáy trang tạo issue (sticky): thanh tóm tắt luôn hiện,
 * bấm để mở rộng / thu gọn timesheet (mặc định tuần này).
 */
export function WorklogDock() {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const [open, setOpenState] = useState(readOpen);
  const [range, setRange] = useState<DateRange>(thisWeek);
  const q = useTimesheet(range[0].format('YYYY-MM-DD'), range[1].format('YYYY-MM-DD'));
  const data = q.data;

  const setOpen = (v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(OPEN_KEY, v ? '1' : '0');
    } catch {
      // bỏ qua: chỉ mất việc nhớ trạng thái
    }
  };

  const diff = data ? data.totalMinutes - data.expectedMinutes : 0;
  const violations = data?.issues.filter((i) => i.ruleIssues.length).length ?? 0;
  const sameDay = range[0].isSame(range[1], 'day');
  const label = `${range[0].format('DD/MM')}${sameDay ? '' : ` → ${range[1].format('DD/MM')}`}`;

  return (
    <div
      className="worklog-dock"
      style={{
        background: token.colorBgElevated,
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        boxShadow: token.boxShadowSecondary,
      }}
    >
      <div className="worklog-dock-bar" onClick={() => setOpen(!open)} role="button" aria-expanded={open}>
        <Space wrap size={[12, 4]} style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text strong>
            <ClockCircleOutlined /> Worklog
          </Typography.Text>
          <Typography.Text type="secondary">{label}</Typography.Text>
          {q.isLoading ? (
            <Spin size="small" />
          ) : data ? (
            <>
              <Tooltip title="Đã log / giờ chuẩn (ngày làm việc đã qua)">
                <Typography.Text>
                  <b>{h(data.totalMinutes)}h</b> / {h(data.expectedMinutes)}h
                </Typography.Text>
              </Tooltip>
              {diff !== 0 && (
                <Tag color={diff < 0 ? 'red' : 'orange'}>
                  {diff > 0 ? '+' : ''}
                  {h(diff)}h
                </Tag>
              )}
              {data.shortDays.length > 0 && (
                <Tooltip
                  title={data.shortDays
                    .map((d) => `${dayjs(d.date).format('DD/MM')}: ${h(d.minutes)}h`)
                    .join(', ')}
                >
                  <Tag color="red">{data.shortDays.length} ngày thiếu giờ</Tag>
                </Tooltip>
              )}
              {violations > 0 && <Tag color="warning">{violations} issue vi phạm quy tắc</Tag>}
              {!data.shortDays.length && !violations && diff === 0 && <Tag color="green">Đủ giờ</Tag>}
            </>
          ) : q.isError ? (
            <Typography.Text type="danger">Không tải được worklog</Typography.Text>
          ) : null}
        </Space>
        <Space size={4} onClick={(e) => e.stopPropagation()}>
          <Tooltip title="Mở trang Worklog đầy đủ">
            <Button size="small" type="text" icon={<ExportOutlined />} onClick={() => navigate('/worklog')} />
          </Tooltip>
          <Button size="small" icon={open ? <DownOutlined /> : <UpOutlined />} onClick={() => setOpen(!open)}>
            {open ? 'Thu gọn' : 'Mở rộng'}
          </Button>
        </Space>
      </div>
      {open && (
        <div className="worklog-dock-body">
          <TimesheetView range={range} onRangeChange={setRange} compact />
        </div>
      )}
    </div>
  );
}
