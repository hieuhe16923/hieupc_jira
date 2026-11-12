import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SourcesResponse } from '@jpw/shared';
import { api } from './http';

export const sourcesKey = ['sources'] as const;

/** Issue gốc đã xác nhận trong phiên (lưu ở session server) */
export function useSources() {
  return useQuery({
    queryKey: sourcesKey,
    queryFn: () => api<SourcesResponse>('/sources'),
    staleTime: Infinity,
  });
}

function useSourcesMutation<V>(fn: (v: V) => Promise<SourcesResponse>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (res) => qc.setQueryData(sourcesKey, res),
  });
}

export const useAddSource = () =>
  useSourcesMutation((v: { key: string; input?: string }) => api<SourcesResponse>('/sources', { body: v }));

export const useRefreshSource = () =>
  useSourcesMutation((key: string) =>
    api<SourcesResponse>(`/sources/${encodeURIComponent(key)}/refresh`, { method: 'POST' }),
  );

export const useRemoveSource = () =>
  useSourcesMutation((key: string) =>
    api<SourcesResponse>(`/sources/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  );
