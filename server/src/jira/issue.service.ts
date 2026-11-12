import {
  isEpicTypeName,
  type DeploymentType,
  type DetectFieldsResponse,
  type IssueSummary,
  type IssueTypeRef,
  type JiraUser,
  type NamedRef,
  type SourceIssue,
  type SprintRef,
} from '@jpw/shared';
import type { JiraClient } from './client';

/* eslint-disable @typescript-eslint/no-explicit-any -- dữ liệu thô từ Jira REST */
type RawIssue = { id: string; key: string; fields: Record<string, any> };

export function mapIssueType(raw: any): IssueTypeRef {
  return {
    id: String(raw?.id ?? ''),
    name: String(raw?.name ?? ''),
    subtask: Boolean(raw?.subtask),
    iconUrl: raw?.iconUrl,
  };
}

export function mapUser(raw: any): JiraUser | undefined {
  if (!raw) return undefined;
  return {
    key: raw.key,
    name: raw.name,
    accountId: raw.accountId,
    displayName: raw.displayName ?? raw.name ?? '',
    emailAddress: raw.emailAddress,
    avatarUrl: raw.avatarUrls?.['48x48'] ?? raw.avatarUrls?.['32x32'],
    timeZone: raw.timeZone,
  };
}

const named = (list: any): NamedRef[] =>
  Array.isArray(list) ? list.map((x) => ({ id: String(x.id), name: String(x.name) })) : [];

/**
 * Sprint field:
 * - Server/DC (API v2) trả về mảng chuỗi "com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=12,rapidViewId=3,state=ACTIVE,name=Sprint 5,...]"
 * - Cloud / bản mới trả về mảng object {id, name, state}
 */
export function parseSprints(value: unknown): SprintRef[] {
  if (!Array.isArray(value)) return [];
  const out: SprintRef[] = [];
  for (const item of value) {
    if (item && typeof item === 'object' && 'id' in item) {
      const s = item as { id: number; name?: string; state?: string };
      out.push({ id: Number(s.id), name: String(s.name ?? s.id), state: s.state });
    } else if (typeof item === 'string') {
      const id = /[[,]id=(\d+)/.exec(item)?.[1];
      if (!id) continue;
      const name = /[[,]name=(.*?)(?:,[a-zA-Z]+=|\]$)/.exec(item)?.[1];
      const state = /[[,]state=([A-Z_]+)/.exec(item)?.[1];
      out.push({ id: Number(id), name: name ?? `Sprint ${id}`, state });
    }
  }
  return out;
}

function isEpicIssueType(raw: any): boolean {
  return isEpicTypeName(String(raw?.name ?? '')) || raw?.hierarchyLevel === 1;
}

export class IssueService {
  async getSourceIssue(
    client: JiraClient,
    key: string,
    fieldIds: DetectFieldsResponse,
  ): Promise<SourceIssue> {
    const raw = await client.get<RawIssue>(`/rest/api/2/issue/${encodeURIComponent(key)}`, {
      expand: 'names',
    });
    const f = raw.fields;
    const issueType = mapIssueType(f.issuetype);
    const epicField = fieldIds.epicLink?.id;
    const sprintField = fieldIds.sprint?.id;

    let parent: SourceIssue['parent'];
    let epicKey: string | undefined = epicField ? (f[epicField] ?? undefined) : undefined;
    let sprints = sprintField ? parseSprints(f[sprintField]) : [];

    if (issueType.subtask && f.parent) {
      parent = {
        key: f.parent.key,
        summary: f.parent.fields?.summary ?? '',
        issueType: mapIssueType(f.parent.fields?.issuetype),
      };
      // Sub-task không mang Epic Link → lấy từ parent
      const parentFields = ['summary', 'issuetype', 'parent', epicField, sprintField]
        .filter(Boolean)
        .join(',');
      const p = await client.get<RawIssue>(`/rest/api/2/issue/${encodeURIComponent(parent.key)}`, {
        fields: parentFields,
      });
      if (epicField && p.fields[epicField]) epicKey = p.fields[epicField];
      if (!epicKey && p.fields.parent && isEpicIssueType(p.fields.parent.fields?.issuetype))
        epicKey = p.fields.parent.key;
      if (!sprints.length && sprintField) sprints = parseSprints(p.fields[sprintField]);
    } else if (!issueType.subtask && f.parent && isEpicIssueType(f.parent.fields?.issuetype)) {
      // Jira Cloud: Epic là parent của Story/Task
      epicKey = epicKey ?? f.parent.key;
    }

    return {
      id: raw.id,
      key: raw.key,
      url: `${client.baseUrl}/browse/${raw.key}`,
      summary: f.summary ?? '',
      status: { name: f.status?.name ?? '', category: f.status?.statusCategory?.key },
      project: { id: String(f.project?.id ?? ''), key: f.project?.key ?? '', name: f.project?.name ?? '' },
      issueType,
      isEpic: isEpicIssueType(f.issuetype),
      parent,
      epicKey: typeof epicKey === 'string' ? epicKey : undefined,
      sprints,
      components: named(f.components),
      labels: Array.isArray(f.labels) ? f.labels : [],
      fixVersions: named(f.fixVersions),
      priority: f.priority ? { id: String(f.priority.id), name: f.priority.name } : undefined,
      assignee: mapUser(f.assignee),
      timetracking: f.timetracking
        ? {
            originalEstimate: f.timetracking.originalEstimate,
            remainingEstimate: f.timetracking.remainingEstimate,
            timeSpent: f.timetracking.timeSpent,
          }
        : undefined,
    };
  }

  async search(
    client: JiraClient,
    jql: string,
    deploymentType: DeploymentType,
    maxResults = 50,
  ): Promise<{ issues: IssueSummary[]; total: number }> {
    const fields = ['summary', 'issuetype', 'status'];
    let res: { issues: RawIssue[]; total?: number };
    if (deploymentType === 'Cloud') {
      res = await client.get('/rest/api/2/search/jql', { jql, maxResults, fields: fields.join(',') });
    } else {
      res = await client.post('/rest/api/2/search', { jql, maxResults, fields, validateQuery: 'warn' });
    }
    return {
      total: res.total ?? res.issues.length,
      issues: res.issues.map((i) => ({
        key: i.key,
        summary: i.fields.summary ?? '',
        issueType: mapIssueType(i.fields.issuetype),
        status: i.fields.status?.name ?? '',
      })),
    };
  }

  async getFilterJql(client: JiraClient, filterId: string): Promise<string> {
    const res = await client.get<{ jql: string }>(`/rest/api/2/filter/${encodeURIComponent(filterId)}`);
    return res.jql;
  }
}
