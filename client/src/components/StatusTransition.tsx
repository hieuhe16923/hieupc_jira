import { useState } from 'react';
import { App, Dropdown, Form, Input, Modal, Spin, Tag, Tooltip } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FieldValue, MyIssue, TransitionOption, TransitionRequest } from '@jpw/shared';
import { api, errorMessage } from '../api/http';
import { FieldInput } from './FieldInput';

const statusColor = (category?: string) =>
  category === 'done' ? 'green' : category === 'indeterminate' ? 'blue' : 'default';

/** Tag trạng thái bấm được → danh sách bước chuyển Jira cho phép; hỏi field bắt buộc nếu cần */
export function StatusTransition({
  issue,
  projectKey,
  onChanged,
}: {
  issue: MyIssue;
  projectKey?: string;
  onChanged: (issue: MyIssue) => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<TransitionOption | null>(null);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [comment, setComment] = useState('');

  const list = useQuery({
    queryKey: ['transitions', issue.key, issue.status.name],
    queryFn: () => api<TransitionOption[]>(`/issues/${encodeURIComponent(issue.key)}/transitions`),
    enabled: open,
    staleTime: 30_000,
  });

  const run = useMutation({
    mutationFn: (body: TransitionRequest) =>
      api<MyIssue>(`/issues/${encodeURIComponent(issue.key)}/transitions`, { body }),
    onSuccess: (updated) => {
      onChanged(updated);
      void qc.invalidateQueries({ queryKey: ['transitions', issue.key] });
      void qc.invalidateQueries({ queryKey: ['timesheet'] });
      message.success(`${issue.key}: ${issue.status.name} → ${updated.status.name}`);
      setPending(null);
    },
    onError: (e) => message.error(errorMessage(e), 6),
  });

  const choose = (t: TransitionOption) => {
    setOpen(false);
    if (t.fields.length) {
      setValues({});
      setComment('');
      setPending(t);
    } else run.mutate({ transitionId: t.id });
  };

  const missing = pending?.fields.filter((f) => {
    if (!f.required || f.hasDefaultValue) return false;
    const v = values[f.id];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  });

  return (
    <>
      <Dropdown
        trigger={['click']}
        open={open}
        onOpenChange={setOpen}
        menu={{
          items: list.isLoading
            ? [{ key: 'loading', label: <Spin size="small" />, disabled: true }]
            : list.isError
              ? [{ key: 'err', label: errorMessage(list.error), disabled: true, danger: true }]
              : (list.data ?? []).length
                ? list.data!.map((t) => ({
                    key: t.id,
                    label: (
                      <span>
                        {t.name}
                        {t.name !== t.to.name && (
                          <>
                            {' '}
                            → <Tag color={statusColor(t.to.category)}>{t.to.name}</Tag>
                          </>
                        )}
                        {t.fields.length > 0 && ' …'}
                      </span>
                    ),
                  }))
                : [{ key: 'none', label: 'Không có bước chuyển nào', disabled: true }],
          onClick: ({ key }) => {
            const t = list.data?.find((x) => x.id === key);
            if (t) choose(t);
          },
        }}
      >
        <Tooltip title="Bấm để chuyển trạng thái">
          <Tag color={statusColor(issue.status.category)} style={{ cursor: 'pointer', marginTop: 2 }}>
            {run.isPending ? <Spin size="small" /> : issue.status.name}{' '}
            <DownOutlined style={{ fontSize: 9 }} />
          </Tag>
        </Tooltip>
      </Dropdown>

      <Modal
        open={!!pending}
        title={
          pending
            ? `${issue.key}: ${issue.status.name} → ${pending.to.name}${pending.name !== pending.to.name ? ` (${pending.name})` : ''}`
            : ''
        }
        okText="Chuyển trạng thái"
        cancelText="Huỷ"
        confirmLoading={run.isPending}
        okButtonProps={{ disabled: !!missing?.length }}
        onCancel={() => setPending(null)}
        onOk={() =>
          pending &&
          run.mutate({ transitionId: pending.id, fields: values, comment: comment.trim() || undefined })
        }
      >
        <Form layout="vertical">
          {pending?.fields.map((f) => (
            <Form.Item key={f.id} label={f.name} required={f.required && !f.hasDefaultValue}>
              <FieldInput
                meta={f}
                value={values[f.id]}
                projectKey={projectKey}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.id]: v }))}
              />
            </Form.Item>
          ))}
          <Form.Item label="Comment (tuỳ chọn)">
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 5 }}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
