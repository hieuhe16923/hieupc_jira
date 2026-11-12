import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Spin, Result, Button } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { qk, useMe } from './api/hooks';
import { UNAUTHORIZED_EVENT, errorMessage } from './api/http';
import { AppLayout } from './components/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { CreatePage } from './pages/CreatePage';
import { WorklogPage } from './pages/WorklogPage';
import { SettingsPage } from './pages/SettingsPage';

function Protected() {
  const me = useMe();
  if (me.isPending) {
    return (
      <div className="login-wrap">
        <Spin size="large" />
      </div>
    );
  }
  if (me.isError) {
    return (
      <Result
        status="error"
        title="Không kết nối được server"
        subTitle={errorMessage(me.error)}
        extra={<Button onClick={() => me.refetch()}>Thử lại</Button>}
      />
    );
  }
  if (!me.data) return <Navigate to="/login" replace />;
  return <AppLayout session={me.data} />;
}

export function App() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  // Bất kỳ API nào trả 401 → xoá cache và quay về màn đăng nhập
  useEffect(() => {
    const onUnauthorized = () => {
      qc.clear();
      qc.setQueryData(qk.me, null);
      navigate('/login', { replace: true });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [qc, navigate]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Protected />}>
        <Route path="/create" element={<CreatePage />} />
        <Route path="/worklog" element={<WorklogPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/create" replace />} />
    </Routes>
  );
}
