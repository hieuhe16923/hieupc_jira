import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import viVN from 'antd/locale/vi_VN';
import dayjs from 'dayjs';
import 'dayjs/locale/vi';

dayjs.locale('vi');

type Mode = 'light' | 'dark';
const STORAGE_KEY = 'jpw-theme';

const ThemeCtx = createContext<{ mode: Mode; toggle: () => void }>({ mode: 'light', toggle: () => {} });

function initialMode(): Mode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // localStorage có thể bị chặn
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>(initialMode);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.body.style.background = mode === 'dark' ? '#000' : '#f5f5f5';
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // bỏ qua
    }
  }, [mode]);

  const value = useMemo(
    () => ({ mode, toggle: () => setMode((m) => (m === 'dark' ? 'light' : 'dark')) }),
    [mode],
  );

  return (
    <ThemeCtx.Provider value={value}>
      <ConfigProvider
        locale={viVN}
        theme={{
          algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
          token: { colorPrimary: '#1677ff', borderRadius: 6 },
        }}
      >
        <AntApp>{children}</AntApp>
      </ConfigProvider>
    </ThemeCtx.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useThemeMode = () => useContext(ThemeCtx);
