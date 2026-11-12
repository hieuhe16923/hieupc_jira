import { useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Avatar,
  Button,
  Dropdown,
  Grid,
  Layout,
  Menu,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import {
  ClockCircleOutlined,
  LogoutOutlined,
  MoonOutlined,
  PlusSquareOutlined,
  SettingOutlined,
  SunOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { SessionInfo } from '@jpw/shared';
import { useLogout } from '../api/hooks';
import { useThemeMode } from '../theme/ThemeProvider';

const items = [
  { key: '/create', icon: <PlusSquareOutlined />, label: 'Tạo issue' },
  { key: '/worklog', icon: <ClockCircleOutlined />, label: 'Worklog' },
  { key: '/settings', icon: <SettingOutlined />, label: 'Cài đặt' },
];

export function AppLayout({ session }: { session: SessionInfo }) {
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useLogout();
  const { mode, toggle } = useThemeMode();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const [collapsed, setCollapsed] = useState(false);
  const isMobile = !screens.md;

  const doLogout = () => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) });

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {!isMobile && (
        <Layout.Sider
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          theme={mode === 'dark' ? 'dark' : 'light'}
          width={200}
          style={{ borderRight: `1px solid ${token.colorBorderSecondary}` }}
        >
          <div className="brand" style={{ padding: 16, color: token.colorText }}>
            <PlusSquareOutlined style={{ color: token.colorPrimary, fontSize: 20 }} />
            {!collapsed && <span>Jira Workbench</span>}
          </div>
          <Menu
            mode="inline"
            theme={mode === 'dark' ? 'dark' : 'light'}
            selectedKeys={[location.pathname]}
            items={items}
            onClick={(e) => navigate(e.key)}
          />
        </Layout.Sider>
      )}
      <Layout>
        <Layout.Header
          className="app-header"
          style={{
            background: token.colorBgContainer,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          {isMobile ? (
            <Menu
              mode="horizontal"
              selectedKeys={[location.pathname]}
              items={items}
              onClick={(e) => navigate(e.key)}
              style={{ flex: 1, minWidth: 0, borderBottom: 'none', background: 'transparent' }}
            />
          ) : (
            <Typography.Text type="secondary" ellipsis className="hide-xs">
              {session.baseUrl}{' '}
              <Tag>
                {session.deploymentType}
                {session.serverVersion ? ` ${session.serverVersion}` : ''}
              </Tag>
            </Typography.Text>
          )}
          <Space size="middle">
            <Tooltip title={mode === 'dark' ? 'Chế độ sáng' : 'Chế độ tối'}>
              <Switch
                checked={mode === 'dark'}
                onChange={toggle}
                checkedChildren={<MoonOutlined />}
                unCheckedChildren={<SunOutlined />}
              />
            </Tooltip>
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: 'info',
                    disabled: true,
                    label: (
                      <div>
                        <div>{session.user.displayName}</div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {session.user.emailAddress ?? session.user.name}
                        </Typography.Text>
                      </div>
                    ),
                  },
                  { type: 'divider' },
                  {
                    key: 'logout',
                    icon: <LogoutOutlined />,
                    label: 'Đăng xuất',
                    danger: true,
                    onClick: doLogout,
                  },
                ],
              }}
            >
              <Button type="text" style={{ height: 'auto', padding: '4px 8px' }}>
                <Space>
                  <Avatar size="small" src={session.user.avatarUrl} icon={<UserOutlined />} />
                  <span className="hide-xs">{session.user.displayName}</span>
                </Space>
              </Button>
            </Dropdown>
          </Space>
        </Layout.Header>
        <Layout.Content className="app-content">
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
