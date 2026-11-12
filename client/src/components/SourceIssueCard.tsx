import { Avatar, Card, Descriptions, Space, Tag, Typography } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import type { SourceIssue } from '@jpw/shared';
import type { ReactNode } from 'react';

const STATUS_COLOR: Record<string, string> = { new: 'default', indeterminate: 'processing', done: 'success' };

function IssueTypeIcon({ url, name }: { url?: string; name: string }) {
  return url ? (
    <img src={url} alt={name} width={16} height={16} style={{ verticalAlign: 'text-bottom' }} />
  ) : null;
}

const none = <Typography.Text type="secondary">—</Typography.Text>;
const tags = (list: string[]): ReactNode => (list.length ? list.map((x) => <Tag key={x}>{x}</Tag>) : none);

export function SourceIssueCard({ issue, extra }: { issue: SourceIssue; extra?: ReactNode }) {
  const browse = (key: string) => issue.url.replace(/\/browse\/.*$/, `/browse/${key}`);
  return (
    <Card
      size="small"
      title={
        <Space wrap>
          <IssueTypeIcon url={issue.issueType.iconUrl} name={issue.issueType.name} />
          <Typography.Link href={issue.url} target="_blank" rel="noreferrer">
            {issue.key} <ExportOutlined />
          </Typography.Link>
          <Typography.Text strong style={{ whiteSpace: 'normal' }}>
            {issue.summary}
          </Typography.Text>
        </Space>
      }
      extra={extra}
    >
      <Descriptions size="small" column={{ xs: 1, sm: 1, md: 2, lg: 3 }} bordered>
        <Descriptions.Item label="Loại">
          <Space>
            {issue.issueType.name}
            {issue.issueType.subtask && <Tag color="purple">sub-task</Tag>}
            {issue.isEpic && <Tag color="magenta">epic</Tag>}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="Trạng thái">
          <Tag color={STATUS_COLOR[issue.status.category ?? ''] ?? 'default'}>{issue.status.name}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Project">
          {issue.project.key} — {issue.project.name}
        </Descriptions.Item>
        <Descriptions.Item label="Parent">
          {issue.parent ? (
            <Typography.Link href={browse(issue.parent.key)} target="_blank" rel="noreferrer">
              {issue.parent.key} · {issue.parent.summary}
            </Typography.Link>
          ) : (
            none
          )}
        </Descriptions.Item>
        <Descriptions.Item label="Epic">
          {issue.epicKey ? (
            <Typography.Link href={browse(issue.epicKey)} target="_blank" rel="noreferrer">
              {issue.epicKey}
            </Typography.Link>
          ) : (
            none
          )}
        </Descriptions.Item>
        <Descriptions.Item label="Sprint">
          {issue.sprints.length
            ? issue.sprints.map((s) => (
                <Tag key={s.id} color={s.state?.toUpperCase() === 'ACTIVE' ? 'green' : 'default'}>
                  {s.name}
                </Tag>
              ))
            : none}
        </Descriptions.Item>
        <Descriptions.Item label="Components">{tags(issue.components.map((c) => c.name))}</Descriptions.Item>
        <Descriptions.Item label="Labels">{tags(issue.labels)}</Descriptions.Item>
        <Descriptions.Item label="Fix versions">
          {tags(issue.fixVersions.map((v) => v.name))}
        </Descriptions.Item>
        <Descriptions.Item label="Priority">{issue.priority?.name ?? none}</Descriptions.Item>
        <Descriptions.Item label="Assignee">
          {issue.assignee ? (
            <Space>
              <Avatar size={18} src={issue.assignee.avatarUrl} />
              {issue.assignee.displayName}
            </Space>
          ) : (
            none
          )}
        </Descriptions.Item>
        <Descriptions.Item label="Estimate / Spent">
          {issue.timetracking?.originalEstimate ?? '—'} / {issue.timetracking?.timeSpent ?? '—'}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}
