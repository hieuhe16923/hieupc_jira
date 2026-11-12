import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DetectFieldsResponse,
  LoginRequest,
  PublicConfig,
  ResolveResponse,
  SessionInfo,
  Settings,
} from '@jpw/shared';
import { api, ApiClientError } from './http';

export const qk = {
  me: ['me'] as const,
  config: ['config'] as const,
  settings: ['settings'] as const,
};

export function usePublicConfig() {
  return useQuery({ queryKey: qk.config, queryFn: () => api<PublicConfig>('/config'), staleTime: Infinity });
}

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        return await api<SessionInfo>('/auth/me');
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api<SessionInfo>('/auth/login', { body }),
    onSuccess: (info) => {
      qc.clear();
      qc.setQueryData(qk.me, info);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      qc.clear();
      qc.setQueryData(qk.me, null);
    },
  });
}

export function useResolve() {
  return useMutation({
    mutationFn: (input: string) => api<ResolveResponse>('/context/resolve', { body: { input } }),
  });
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: () => api<Settings>('/settings') });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => api<Settings>('/settings', { method: 'PUT', body: patch }),
    onSuccess: (s) => qc.setQueryData(qk.settings, s),
  });
}

export function useDetectFields() {
  return useMutation({
    mutationFn: () => api<DetectFieldsResponse>('/settings/detect-fields', { method: 'POST', body: {} }),
  });
}

export function useRefreshMeta() {
  return useMutation({
    mutationFn: (projectKey?: string) => api<{ cleared: number }>('/meta/refresh', { body: { projectKey } }),
  });
}
