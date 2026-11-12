import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateIssuesRequest,
  CreateIssuesResponse,
  DetectFieldsResponse,
  FieldMeta,
  IssueTypeFieldsResponse,
  IssueTypeRef,
  LabelSuggestions,
  NamedRef,
  PreviewResponse,
  UserOption,
} from '@jpw/shared';
import { api } from './http';

const STALE = 10 * 60_000;

export const metaKeys = {
  all: ['meta'] as const,
  issueTypes: (p: string) => ['meta', p, 'issuetypes'] as const,
  fields: (p: string, t: string) => ['meta', p, 'fields', t] as const,
  components: (p: string) => ['meta', p, 'components'] as const,
  fieldIds: ['meta', 'field-ids'] as const,
};

export function useIssueTypes(projectKey: string | undefined) {
  return useQuery({
    queryKey: metaKeys.issueTypes(projectKey ?? ''),
    queryFn: () => api<IssueTypeRef[]>(`/meta/${projectKey}/issuetypes`),
    enabled: !!projectKey,
    staleTime: STALE,
  });
}

/** Field meta cho nhiều issue type cùng lúc → Map issueTypeId → FieldMeta[] */
export function useFieldMetas(projectKey: string | undefined, issueTypeIds: string[]) {
  const ids = [...new Set(issueTypeIds.filter(Boolean))].sort();
  const queries = useQueries({
    queries: ids.map((id) => ({
      queryKey: metaKeys.fields(projectKey ?? '', id),
      queryFn: () => api<IssueTypeFieldsResponse>(`/meta/${projectKey}/issuetypes/${id}/fields`),
      enabled: !!projectKey,
      staleTime: STALE,
    })),
  });
  const map = new Map<string, FieldMeta[]>();
  queries.forEach((q, i) => {
    if (q.data) map.set(ids[i]!, q.data.fields);
  });
  return {
    map,
    isLoading: queries.some((q) => q.isLoading),
    error: queries.find((q) => q.error)?.error,
  };
}

export function useComponents(projectKey: string | undefined) {
  return useQuery({
    queryKey: metaKeys.components(projectKey ?? ''),
    queryFn: () => api<NamedRef[]>(`/meta/${projectKey}/components`),
    enabled: !!projectKey,
    staleTime: STALE,
  });
}

export function useFieldIds() {
  return useQuery({
    queryKey: metaKeys.fieldIds,
    queryFn: () => api<DetectFieldsResponse>('/meta/field-ids'),
    staleTime: STALE,
  });
}

export const fetchLabels = (q: string, projectKey?: string) =>
  api<LabelSuggestions>(
    `/meta/labels?q=${encodeURIComponent(q)}${projectKey ? `&projectKey=${encodeURIComponent(projectKey)}` : ''}`,
  );

export const fetchUsers = (q: string, projectKey?: string) =>
  api<UserOption[]>(
    `/meta/users?q=${encodeURIComponent(q)}${projectKey ? `&projectKey=${encodeURIComponent(projectKey)}` : ''}`,
  );

export function usePreviewIssues() {
  return useMutation({
    mutationFn: (body: CreateIssuesRequest) => api<PreviewResponse>('/issues/preview', { body }),
  });
}

export function useCreateIssues() {
  const qc = useQueryClient();
  return useMutation({
    // Issue mới (có thể kèm log work) → làm mới timesheet
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['timesheet'] }),
    mutationFn: (body: CreateIssuesRequest) => api<CreateIssuesResponse>('/issues/create', { body }),
  });
}
