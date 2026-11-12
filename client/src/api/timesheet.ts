import { useQuery } from '@tanstack/react-query';
import type { TimesheetResponse } from '@jpw/shared';
import { api } from './http';

export const timesheetKey = (from: string, to: string) => ['timesheet', from, to] as const;

export function useTimesheet(from: string, to: string) {
  return useQuery({
    queryKey: timesheetKey(from, to),
    queryFn: () =>
      api<TimesheetResponse>(
        `/worklog/timesheet?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),
    enabled: Boolean(from && to),
    staleTime: 0,
  });
}
