import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  MyIssuesResponse,
  UpdateIssuesRequest,
  UpdateIssuesResponse,
  DailyWorklogRequest,
  WorklogInput,
  WorklogSaveResponse,
} from '@jpw/shared';
import { api } from './http';

/** Sau khi log work: làm mới timesheet (dock + trang Worklog) và bảng Công việc của tôi */
export const invalidateWorklogViews = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: ['timesheet'] });
  void qc.invalidateQueries({ queryKey: ['my-issues'] });
};

export const myIssuesKey = (sourceKey?: string) => ['my-issues', sourceKey ?? ''] as const;

export function useMyIssues(sourceKey: string | undefined) {
  return useQuery({
    queryKey: myIssuesKey(sourceKey),
    queryFn: () => api<MyIssuesResponse>(`/issues/mine?source=${encodeURIComponent(sourceKey!)}`),
    enabled: Boolean(sourceKey),
    staleTime: 60_000,
  });
}

export function useUpdateIssues() {
  return useMutation({
    mutationFn: (body: UpdateIssuesRequest) => api<UpdateIssuesResponse>('/issues/update', { body }),
  });
}

export interface WorklogMutation {
  key: string;
  /** Có id = sửa; không có = thêm mới */
  id?: string;
  /** Không có input = xoá */
  input?: WorklogInput;
}

/** Thêm / sửa / xoá worklog → trả về issue sau khi cập nhật */
export function useWorklogMutation() {
  const qc = useQueryClient();
  return useMutation({
    onSuccess: () => invalidateWorklogViews(qc),
    mutationFn: ({ key, id, input }: WorklogMutation) => {
      const base = `/issues/${encodeURIComponent(key)}/worklogs`;
      if (!input) return api<WorklogSaveResponse>(`${base}/${encodeURIComponent(id!)}`, { method: 'DELETE' });
      if (id)
        return api<WorklogSaveResponse>(`${base}/${encodeURIComponent(id)}`, { method: 'PUT', body: input });
      return api<WorklogSaveResponse>(base, { method: 'POST', body: input });
    },
  });
}

/** Log theo ngày From → To (mỗi ngày = tổng log của tôi) */
export function useDailyWorklog() {
  const qc = useQueryClient();
  return useMutation({
    onSuccess: () => invalidateWorklogViews(qc),
    mutationFn: ({ key, body }: { key: string; body: DailyWorklogRequest }) =>
      api<WorklogSaveResponse>(`/issues/${encodeURIComponent(key)}/worklogs/daily`, { method: 'PUT', body }),
  });
}
