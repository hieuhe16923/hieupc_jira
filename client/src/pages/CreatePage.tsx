import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Input,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseOutlined,
  ExportOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { IssueSummary, SourceEntry } from '@jpw/shared';
import { useResolve } from '../api/hooks';
import { errorMessage } from '../api/http';
import { useAddSource, useRefreshSource, useRemoveSource, useSources } from '../api/sources';
import { SourceIssueCard } from '../components/SourceIssueCard';
import { IssueGrid } from '../components/IssueGrid';
import { MyIssuesPanel } from '../components/MyIssuesPanel';
import { WorklogDock } from '../components/WorklogDock';

const ACTIVE_KEY = 'jpw-active-source';
const readActive = () => {
  try {
    return sessionStorage.getItem(ACTIVE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};
const writeActive = (key: string | undefined) => {
  try {
    if (key) sessionStorage.setItem(ACTIVE_KEY, key);
    else sessionStorage.removeItem(ACTIVE_KEY);
  } catch {
    // trình duyệt chặn storage → chỉ mất việc nhớ tab đang mở
  }
};

/** Nội dung 1 tab issue gốc: card, công việc của tôi, lưới tạo issue */
function SourcePane({ entry, onClose }: { entry: SourceEntry; onClose: () => void }) {
  const refresh = useRefreshSource();
  const { message } = App.useApp();
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <SourceIssueCard
        issue={entry.issue}
        extra={
          <Space>
            <Tooltip title="Đọc lại issue gốc từ Jira">
              <Button
                icon={<ReloadOutlined />}
                loading={refresh.isPending}
                onClick={() =>
                  refresh.mutate(entry.key, {
                    onSuccess: () => message.success(`Đã làm mới ${entry.key}`),
                    onError: (e) => message.error(errorMessage(e)),
                  })
                }
              >
                Làm mới
              </Button>
            </Tooltip>
            <Button icon={<CloseOutlined />} onClick={onClose}>
              Đóng
            </Button>
          </Space>
        }
      />
      <MyIssuesPanel source={entry.issue} />
      <IssueGrid source={entry.issue} />
    </Space>
  );
}

export function CreatePage() {
  const { message, modal } = App.useApp();
  const [input, setInput] = useState('');
  const resolve = useResolve();
  const data = resolve.data;
  const sourcesQ = useSources();
  const sources = sourcesQ.data?.sources ?? [];
  const add = useAddSource();
  const remove = useRemoveSource();
  const [active, setActiveState] = useState<string | undefined>(readActive);
  const setActive = (key: string | undefined) => {
    setActiveState(key);
    writeActive(key);
  };

  // Tab đang mở không còn trong danh sách → mở tab cuối
  useEffect(() => {
    if (!sourcesQ.data) return;
    if (!sources.length) setActive(undefined);
    else if (!active || !sources.some((s) => s.key === active)) setActive(sources[sources.length - 1]!.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesQ.data]);

  const run = (value: string) => {
    const v = value.trim();
    if (v) resolve.mutate(v);
  };

  const confirm = () => {
    if (!data?.issue) return;
    add.mutate(
      { key: data.issue.key, input: input.trim() || data.issue.key },
      {
        onSuccess: () => {
          setActive(data.issue!.key);
          resolve.reset();
          setInput('');
        },
        onError: (e) => message.error(errorMessage(e)),
      },
    );
  };

  const close = (key: string) =>
    modal.confirm({
      title: `Đóng issue gốc ${key}?`,
      content: 'Các dòng chưa tạo trong lưới của tab này sẽ mất. Issue đã tạo trên Jira không bị ảnh hưởng.',
      okText: 'Đóng tab',
      cancelText: 'Huỷ',
      onOk: () =>
        remove.mutateAsync(key).catch((e) => {
          message.error(errorMessage(e));
        }),
    });

  const already = data?.issue && sources.some((s) => s.key === data.issue!.key);

  return (
    <>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Tạo issue con
        </Typography.Title>

        <Card size="small" title="1. Thêm issue gốc">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input.Search
              size="large"
              allowClear
              enterButton={
                <>
                  <SearchOutlined /> Phân tích
                </>
              }
              placeholder="Dán URL Jira (/browse/ABC-123, board có selectedIssue, ?jql=, ?filter=) hoặc issue key"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onSearch={run}
              loading={resolve.isPending}
            />
            {resolve.isError && <Alert type="error" showIcon message={errorMessage(resolve.error)} />}
            {data?.warnings.map((w) => (
              <Alert key={w} type="warning" showIcon message={w} />
            ))}

            {data?.issue && (
              <SourceIssueCard
                issue={data.issue}
                extra={
                  already ? (
                    <Button
                      icon={<ExportOutlined />}
                      onClick={() => {
                        setActive(data.issue!.key);
                        resolve.reset();
                        setInput('');
                      }}
                    >
                      Đã có — mở tab
                    </Button>
                  ) : (
                    <Button
                      type="primary"
                      icon={<CheckCircleOutlined />}
                      loading={add.isPending}
                      onClick={confirm}
                    >
                      Xác nhận issue gốc
                    </Button>
                  )
                }
              />
            )}

            {data?.issues && (
              <Card
                size="small"
                title={
                  <Space wrap>
                    Kết quả JQL
                    <Typography.Text code style={{ whiteSpace: 'normal' }}>
                      {data.jql}
                    </Typography.Text>
                  </Space>
                }
              >
                <Table<IssueSummary>
                  size="small"
                  rowKey="key"
                  dataSource={data.issues}
                  pagination={{ pageSize: 10, hideOnSinglePage: true }}
                  scroll={{ x: 600 }}
                  locale={{ emptyText: <Empty description="Không có issue nào" /> }}
                  columns={[
                    { title: 'Key', dataIndex: 'key', width: 120 },
                    {
                      title: 'Loại',
                      width: 140,
                      render: (_, r) => (
                        <Space>
                          {r.issueType.iconUrl && (
                            <img src={r.issueType.iconUrl} width={16} height={16} alt="" />
                          )}
                          {r.issueType.name}
                        </Space>
                      ),
                    },
                    { title: 'Summary', dataIndex: 'summary' },
                    {
                      title: 'Trạng thái',
                      dataIndex: 'status',
                      width: 130,
                      render: (s: string) => <Tag>{s}</Tag>,
                    },
                    {
                      title: '',
                      width: 90,
                      render: (_, r) => (
                        <Button
                          size="small"
                          onClick={() => {
                            setInput(r.key);
                            run(r.key);
                          }}
                        >
                          Chọn
                        </Button>
                      ),
                    },
                  ]}
                />
              </Card>
            )}
          </Space>
        </Card>

        {sourcesQ.isLoading ? (
          <Spin />
        ) : sources.length === 0 ? (
          <Card size="small" title="2. Issue gốc đã xác nhận">
            <Empty description="Phân tích và xác nhận issue gốc để bắt đầu. Có thể mở nhiều issue gốc cùng lúc (mỗi issue một tab)." />
          </Card>
        ) : (
          <Tabs
            type="editable-card"
            hideAdd
            activeKey={active}
            onChange={setActive}
            onEdit={(key, action) => action === 'remove' && typeof key === 'string' && close(key)}
            items={sources.map((s) => ({
              key: s.key,
              label: (
                <Tooltip title={`${s.issue.issueType.name}: ${s.issue.summary}`}>
                  <Space size={4}>
                    {s.issue.issueType.iconUrl && (
                      <img src={s.issue.issueType.iconUrl} width={14} height={14} alt="" />
                    )}
                    {s.key}
                    <Typography.Text type="secondary" ellipsis style={{ maxWidth: 160, fontSize: 12 }}>
                      {s.issue.summary}
                    </Typography.Text>
                  </Space>
                </Tooltip>
              ),
              children: <SourcePane entry={s} onClose={() => close(s.key)} />,
            }))}
          />
        )}
      </Space>
      {/* Ngoài Space để sticky bám theo vùng nội dung trang */}
      <WorklogDock />
    </>
  );
}
