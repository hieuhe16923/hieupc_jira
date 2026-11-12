import { Alert, Button, Collapse, Modal, Space, Table, Tag, Typography } from 'antd';
import { RocketOutlined } from '@ant-design/icons';
import type { IssueRow, IssueTypeRef, RowPreview } from '@jpw/shared';

/** 450 → "7h 30m" (không quy đổi ra ngày) */
const fmtMinutes = (m: number) =>
  [Math.floor(m / 60) ? `${Math.floor(m / 60)}h` : '', m % 60 ? `${m % 60}m` : ''].filter(Boolean).join(' ');

export function PreviewModal(props: {
  open: boolean;
  onClose: () => void;
  rows: IssueRow[];
  previews: Map<string, RowPreview>;
  typeById: Map<string, IssueTypeRef>;
  creating: boolean;
  onCreate: () => void;
}) {
  const { rows, previews } = props;
  const valid = rows.filter((r) => previews.get(r.rowId) && !previews.get(r.rowId)!.errors.length).length;
  const invalid = rows.length - valid;

  return (
    <Modal
      open={props.open}
      onCancel={props.onClose}
      width={1100}
      title="Preview payload gửi lên Jira"
      footer={
        <Space>
          <Button onClick={props.onClose}>Đóng</Button>
          <Button
            type="primary"
            icon={<RocketOutlined />}
            loading={props.creating}
            disabled={valid === 0}
            onClick={props.onCreate}
          >
            Tạo {valid} issue hợp lệ
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {invalid > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={`${invalid} dòng có lỗi sẽ không được gửi. Đóng preview để sửa, hoặc tạo trước ${valid} dòng hợp lệ.`}
          />
        ) : (
          <Alert type="success" showIcon message={`Tất cả ${valid} dòng hợp lệ.`} />
        )}
        <Table<IssueRow>
          rowKey="rowId"
          size="small"
          pagination={false}
          dataSource={rows}
          scroll={{ x: 900, y: 520 }}
          columns={[
            { title: '#', width: 44, render: (_, __, i) => i + 1 },
            {
              title: 'Issue',
              width: 280,
              render: (_, r) => {
                const p = previews.get(r.rowId);
                return (
                  <Space direction="vertical" size={0}>
                    <Typography.Text strong>{String(p?.fields?.summary ?? r.summary)}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {props.typeById.get(r.issueTypeId)?.name}
                      {p?.estimate ? ` · ${p.estimate}` : ''}
                    </Typography.Text>
                  </Space>
                );
              },
            },
            {
              title: 'Quan hệ',
              width: 180,
              render: (_, r) => {
                const rel = previews.get(r.rowId)?.relation;
                return (
                  <Space size={[4, 4]} wrap>
                    {rel?.parentKey && <Tag color="purple">parent {rel.parentKey}</Tag>}
                    {rel?.epicKey && <Tag color="magenta">epic {rel.epicKey}</Tag>}
                    {rel?.relatesToKey && <Tag>relates {rel.relatesToKey}</Tag>}
                  </Space>
                );
              },
            },
            {
              title: 'Kiểm tra',
              render: (_, r) => {
                const p = previews.get(r.rowId);
                if (!p) return <Typography.Text type="secondary">—</Typography.Text>;
                return (
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    {p.errors.map((e) => (
                      <Typography.Text key={e} type="danger">
                        ✖ {e}
                      </Typography.Text>
                    ))}
                    {p.warnings.map((w) => (
                      <Typography.Text key={w} type="warning">
                        ⚠ {w}
                      </Typography.Text>
                    ))}
                    {!p.errors.length && <Typography.Text type="success">✔ Hợp lệ</Typography.Text>}
                    {p.worklogs?.length ? (
                      <Space size={[4, 4]} wrap>
                        <Typography.Text type="secondary">
                          Log work {p.worklogs.length} ngày (tổng {p.estimate}):
                        </Typography.Text>
                        {p.worklogs.map((w) => (
                          <Tag key={w.date} color="blue">
                            {w.start.slice(8, 10)}/{w.start.slice(5, 7)} {w.start.slice(11)} ·{' '}
                            {fmtMinutes(w.minutes)}
                          </Tag>
                        ))}
                      </Space>
                    ) : null}
                    {p.fields && (
                      <Collapse
                        size="small"
                        ghost
                        items={[
                          {
                            key: 'json',
                            label: 'Payload JSON',
                            children: (
                              <pre style={{ margin: 0, fontSize: 12, maxHeight: 260, overflow: 'auto' }}>
                                {JSON.stringify({ fields: p.fields }, null, 2)}
                              </pre>
                            ),
                          },
                        ]}
                      />
                    )}
                  </Space>
                );
              },
            },
          ]}
        />
      </Space>
    </Modal>
  );
}
