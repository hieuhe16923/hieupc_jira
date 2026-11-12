import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Collapse, Form, Input, Space, Typography, theme } from 'antd';
import { KeyOutlined, LinkOutlined, MailOutlined, PlusSquareOutlined } from '@ant-design/icons';
import { isJiraCloudHost, normalizeJiraBaseUrl } from '@jpw/shared';
import { useLogin, useMe, usePublicConfig } from '../api/hooks';
import { errorMessage } from '../api/http';

interface FormValues {
  baseUrl: string;
  token: string;
  email?: string;
}

function cloudOf(baseUrl: string | undefined): boolean {
  try {
    return !!baseUrl && isJiraCloudHost(new URL(normalizeJiraBaseUrl(baseUrl)).host);
  } catch {
    return false;
  }
}

export function LoginPage() {
  const [form] = Form.useForm<FormValues>();
  const cfg = usePublicConfig();
  const me = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const baseUrl = Form.useWatch('baseUrl', form);
  const isCloud = cloudOf(baseUrl);

  useEffect(() => {
    if (cfg.data && !form.getFieldValue('baseUrl')) form.setFieldValue('baseUrl', cfg.data.defaultBaseUrl);
  }, [cfg.data, form]);

  if (me.data) return <Navigate to="/create" replace />;

  const onFinish = (v: FormValues) => {
    let base = v.baseUrl;
    try {
      base = normalizeJiraBaseUrl(v.baseUrl);
      form.setFieldValue('baseUrl', base);
    } catch {
      // để server báo lỗi
    }
    login.mutate(
      {
        token: v.token,
        baseUrl: base,
        email: (form.getFieldValue('email') as string | undefined)?.trim() || undefined,
      },
      {
        onSuccess: () => {
          // Xoá token khỏi state của form ngay sau khi đăng nhập
          form.resetFields(['token']);
          navigate('/create', { replace: true });
        },
      },
    );
  };

  const emailItem = (
    <Form.Item
      name="email"
      label={isCloud ? 'Email Atlassian' : undefined}
      style={isCloud ? undefined : { marginBottom: 0 }}
      rules={[
        { required: isCloud, message: 'Jira Cloud cần email đăng nhập Atlassian' },
        { type: 'email', message: 'Email không hợp lệ' },
      ]}
    >
      <Input
        prefix={<MailOutlined />}
        placeholder={isCloud ? 'Email bạn dùng để đăng nhập Jira' : 'Chỉ nhập khi dùng Jira Cloud'}
        autoComplete="username"
      />
    </Form.Item>
  );

  return (
    <div className="login-wrap">
      <Card style={{ width: '100%', maxWidth: 440 }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <PlusSquareOutlined style={{ fontSize: 36, color: token.colorPrimary }} />
            <Typography.Title level={3} style={{ margin: '8px 0 0' }}>
              Jira Personal Workbench
            </Typography.Title>
            <Typography.Text type="secondary">
              {isCloud
                ? 'Jira Cloud: đăng nhập bằng email + API token'
                : 'Đăng nhập bằng Personal Access Token'}
            </Typography.Text>
          </div>

          {login.isError && <Alert type="error" showIcon message={errorMessage(login.error)} />}

          <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false} autoComplete="off">
            <Form.Item
              label="Jira Base URL"
              name="baseUrl"
              rules={[{ required: true, message: 'Nhập URL Jira, VD: https://ten-cong-ty.atlassian.net' }]}
              extra="Chỉ phần gốc, không kèm /browse/... (app sẽ tự cắt nếu bạn dán cả link issue)."
            >
              <Input prefix={<LinkOutlined />} placeholder="https://ten-cong-ty.atlassian.net" />
            </Form.Item>
            {isCloud && emailItem}
            <Form.Item
              label={isCloud ? 'API token' : 'Personal Access Token'}
              name="token"
              rules={[{ required: true, whitespace: true, message: 'Nhập token' }]}
              extra={
                isCloud ? (
                  <>
                    Tạo tại{' '}
                    <Typography.Link
                      href="https://id.atlassian.com/manage-profile/security/api-tokens"
                      target="_blank"
                      rel="noreferrer"
                    >
                      id.atlassian.com → Security → API tokens
                    </Typography.Link>
                    . Token chỉ được giữ trong phiên của server, không lưu ở trình duyệt.
                  </>
                ) : (
                  'Tạo tại Jira → Hồ sơ cá nhân → Personal Access Tokens. Token chỉ được giữ trong phiên của server, không lưu ở trình duyệt.'
                )
              }
            >
              <Input.Password
                prefix={<KeyOutlined />}
                placeholder="Dán token vào đây"
                autoComplete="new-password"
              />
            </Form.Item>
            {!isCloud && (
              <Collapse
                ghost
                size="small"
                style={{ marginBottom: 16 }}
                items={[
                  {
                    key: 'cloud',
                    label: 'Jira Cloud? (dùng email + API token)',
                    children: emailItem,
                    forceRender: true,
                  },
                ]}
              />
            )}
            <Button type="primary" htmlType="submit" block size="large" loading={login.isPending}>
              Đăng nhập
            </Button>
          </Form>
        </Space>
      </Card>
    </div>
  );
}
