import type {
  AllowedValue,
  DeploymentType,
  DetectFieldsResponse,
  DetectedField,
  FieldMeta,
  IssueTypeRef,
  NamedRef,
  Settings,
  UserOption,
} from '@jpw/shared';
import type { TtlCache } from '../lib/cache';
import type { JiraClient } from './client';
import { JiraError } from './errors';

export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type?: string; items?: string; custom?: string; customId?: number; system?: string };
}

export interface ServerInfo {
  version?: string;
  deploymentType?: string;
  baseUrl?: string;
}

const EPIC_LINK_TYPE = 'com.pyxis.greenhopper.jira:gh-epic-link';
const SPRINT_TYPE = 'com.pyxis.greenhopper.jira:gh-sprint';

/* eslint-disable @typescript-eslint/no-explicit-any -- dữ liệu thô từ Jira REST */

export async function getServerInfo(
  client: JiraClient,
): Promise<{ deploymentType: DeploymentType; version?: string }> {
  try {
    const info = await client.get<ServerInfo>('/rest/api/2/serverInfo');
    const dt = info.deploymentType === 'Cloud' ? 'Cloud' : info.deploymentType ? 'Server' : 'Unknown';
    return { deploymentType: dt, version: info.version };
  } catch {
    return { deploymentType: 'Unknown' };
  }
}

function mapAllowed(v: any): AllowedValue {
  return {
    id: String(v.id ?? v.key ?? v.value),
    name: String(v.name ?? v.value ?? v.label ?? v.displayName ?? v.key ?? v.id),
    iconUrl: v.iconUrl,
    children: Array.isArray(v.children) ? v.children.map(mapAllowed) : undefined,
  };
}

/** Chuẩn hoá 1 field từ createmeta (Cloud dùng fieldId/key, DC dùng fieldId, bản cũ là key của map) */
export function mapFieldMeta(raw: any, idFallback?: string): FieldMeta {
  return {
    id: String(raw.fieldId ?? raw.key ?? idFallback),
    name: String(raw.name ?? raw.fieldId ?? idFallback),
    required: Boolean(raw.required),
    hasDefaultValue: Boolean(raw.hasDefaultValue),
    schema: {
      type: raw.schema?.type ?? 'any',
      items: raw.schema?.items,
      custom: raw.schema?.custom,
      system: raw.schema?.system,
      customId: raw.schema?.customId,
    },
    allowedValues: Array.isArray(raw.allowedValues) ? raw.allowedValues.map(mapAllowed) : undefined,
    autoCompleteUrl: raw.autoCompleteUrl,
  };
}

function mapIssueTypeRef(raw: any): IssueTypeRef {
  return { id: String(raw.id), name: String(raw.name), subtask: Boolean(raw.subtask), iconUrl: raw.iconUrl };
}

interface Page<T> {
  values?: T[];
  issueTypes?: T[];
  fields?: T[];
  total?: number;
  isLast?: boolean;
}

export class MetaService {
  constructor(private readonly cache: TtlCache) {}

  private key(client: JiraClient, ...parts: string[]): string {
    return [client.baseUrl, ...parts].join('|');
  }

  getFields(client: JiraClient): Promise<JiraField[]> {
    return this.cache.getOrLoad(this.key(client, 'fields'), () =>
      client.get<JiraField[]>('/rest/api/2/field'),
    );
  }

  invalidate(client: JiraClient, projectKey?: string): number {
    return this.cache.invalidate(projectKey ? this.key(client, 'project', projectKey) : this.key(client));
  }

  /** Lấy tất cả trang của endpoint createmeta mới (Jira ≥ 8.4 / Cloud) */
  private async paged<T>(client: JiraClient, path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0, startAt = 0; page < 20; page++) {
      const res = await client.get<Page<T>>(path, { startAt, maxResults: 100 });
      const items = res.values ?? res.issueTypes ?? res.fields ?? [];
      out.push(...items);
      startAt += items.length;
      if (!items.length || res.isLast || (res.total !== undefined && startAt >= res.total)) break;
    }
    return out;
  }

  /** createmeta kiểu cũ (Jira < 8.4) — fallback */
  private legacyCreateMeta(client: JiraClient, projectKey: string): Promise<any> {
    return this.cache.getOrLoad(this.key(client, 'project', projectKey, 'legacy-createmeta'), async () => {
      const res = await client.get<any>('/rest/api/2/issue/createmeta', {
        projectKeys: projectKey,
        expand: 'projects.issuetypes.fields',
      });
      const project = res.projects?.[0];
      if (!project)
        throw new JiraError(404, { errorMessages: [`Không có quyền tạo issue trong ${projectKey}`] });
      return project;
    });
  }

  getIssueTypes(client: JiraClient, projectKey: string): Promise<IssueTypeRef[]> {
    return this.cache.getOrLoad(this.key(client, 'project', projectKey, 'issuetypes'), async () => {
      try {
        const list = await this.paged<any>(
          client,
          `/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
        );
        return list.map(mapIssueTypeRef);
      } catch (e) {
        if (!(e instanceof JiraError && e.status === 404)) throw e;
        const project = await this.legacyCreateMeta(client, projectKey);
        return (project.issuetypes ?? []).map(mapIssueTypeRef);
      }
    });
  }

  getIssueTypeFields(client: JiraClient, projectKey: string, issueTypeId: string): Promise<FieldMeta[]> {
    return this.cache.getOrLoad(this.key(client, 'project', projectKey, 'fields', issueTypeId), async () => {
      try {
        const list = await this.paged<any>(
          client,
          `/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}`,
        );
        return list.map((f) => mapFieldMeta(f));
      } catch (e) {
        if (!(e instanceof JiraError && e.status === 404)) throw e;
        const project = await this.legacyCreateMeta(client, projectKey);
        const it = (project.issuetypes ?? []).find((t: any) => String(t.id) === issueTypeId);
        if (!it) throw new JiraError(404, { errorMessages: [`Issue type ${issueTypeId} không tồn tại`] });
        return Object.entries(it.fields ?? {}).map(([id, f]) => mapFieldMeta(f, id));
      }
    });
  }

  getComponents(client: JiraClient, projectKey: string): Promise<NamedRef[]> {
    return this.cache.getOrLoad(this.key(client, 'project', projectKey, 'components'), async () => {
      const list = await client.get<any[]>(
        `/rest/api/2/project/${encodeURIComponent(projectKey)}/components`,
      );
      return list.map((c) => ({ id: String(c.id), name: String(c.name) }));
    });
  }

  /** Gợi ý label: JQL autocomplete (Cloud + DC), fallback API label của DC */
  /**
   * Label đang dùng trong project (giống mục "All labels" của Jira):
   * quét các issue gần đây có label, xếp theo số lần dùng rồi theo độ mới.
   */
  async getProjectLabels(
    client: JiraClient,
    deploymentType: DeploymentType,
    projectKey: string,
  ): Promise<string[]> {
    return this.cache.getOrLoad(this.key(client, 'project', projectKey, 'labels'), async () => {
      const jql = `project = "${projectKey}" AND labels is not EMPTY ORDER BY updated DESC`;
      const stats = new Map<string, { count: number; order: number }>();
      const add = (issues: { fields?: { labels?: string[] } }[]) => {
        for (const i of issues)
          for (const l of i.fields?.labels ?? []) {
            const s = stats.get(l);
            if (s) s.count++;
            else stats.set(l, { count: 1, order: stats.size });
          }
      };
      const PAGE = 100;
      const MAX_ISSUES = 500;
      if (deploymentType === 'Cloud') {
        let token: string | undefined;
        for (let n = 0; n < MAX_ISSUES; n += PAGE) {
          const res = await client.get<{ issues?: any[]; nextPageToken?: string; isLast?: boolean }>(
            '/rest/api/2/search/jql',
            { jql, fields: 'labels', maxResults: PAGE, nextPageToken: token },
          );
          add(res.issues ?? []);
          token = res.nextPageToken;
          if (!token || res.isLast) break;
        }
      } else {
        for (let startAt = 0; startAt < MAX_ISSUES; startAt += PAGE) {
          const res = await client.post<{ issues?: any[]; total?: number }>('/rest/api/2/search', {
            jql,
            fields: ['labels'],
            startAt,
            maxResults: PAGE,
          });
          add(res.issues ?? []);
          if (!res.issues?.length || startAt + PAGE >= (res.total ?? 0)) break;
        }
      }
      return [...stats.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[1].order - b[1].order)
        .map(([l]) => l);
    });
  }

  /** Gợi ý label: label của project (lọc theo q) trước, sau đó label khác trên toàn Jira */
  async suggestProjectLabels(
    client: JiraClient,
    deploymentType: DeploymentType,
    query: string,
    projectKey?: string,
  ): Promise<{ project: string[]; others: string[] }> {
    const q = query.trim().toLowerCase();
    let project: string[] = [];
    if (projectKey) {
      try {
        project = (await this.getProjectLabels(client, deploymentType, projectKey)).filter((l) =>
          l.toLowerCase().includes(q),
        );
      } catch (e) {
        if (!(e instanceof JiraError) || e.status === 401) throw e;
      }
    }
    let others: string[] = [];
    if (q || !project.length) {
      try {
        const inProject = new Set(project);
        others = (await this.suggestLabels(client, query)).filter((l) => !inProject.has(l));
      } catch (e) {
        if (!(e instanceof JiraError) || e.status === 401) throw e;
      }
    }
    return { project: project.slice(0, 200), others: others.slice(0, 50) };
  }

  async suggestLabels(client: JiraClient, query: string): Promise<string[]> {
    try {
      const res = await client.get<{ results?: { value: string }[] }>(
        '/rest/api/2/jql/autocompletedata/suggestions',
        { fieldName: 'labels', fieldValue: query },
      );
      return (res.results ?? []).map((r) => r.value).filter(Boolean);
    } catch (e) {
      if (!(e instanceof JiraError) || e.status === 401) throw e;
      const res = await client.get<{ suggestions?: { label: string }[] }>('/rest/api/1.0/labels/suggest', {
        query,
      });
      return (res.suggestions ?? []).map((s) => s.label);
    }
  }

  async searchUsers(
    client: JiraClient,
    deploymentType: DeploymentType,
    query: string,
    projectKey?: string,
  ): Promise<UserOption[]> {
    const isCloud = deploymentType === 'Cloud';
    const params: Record<string, string | number | undefined> = isCloud
      ? { query, maxResults: 20 }
      : { username: query, maxResults: 20 };
    const path = projectKey ? '/rest/api/2/user/assignable/search' : '/rest/api/2/user/search';
    if (projectKey) params.project = projectKey;
    const list = await client.get<any[]>(path, params);
    return list
      .filter((u) => u.active !== false)
      .map((u) => ({
        id: String(isCloud ? u.accountId : u.name),
        displayName: u.displayName ?? u.name,
        avatarUrl: u.avatarUrls?.['24x24'],
        emailAddress: u.emailAddress,
      }));
  }

  /** Tên link type "relates" (Relates) */
  async getRelatesLinkType(client: JiraClient): Promise<string> {
    const types = await this.cache.getOrLoad(this.key(client, 'linktypes'), () =>
      client.get<{ issueLinkTypes: { name: string; outward: string; inward: string }[] }>(
        '/rest/api/2/issueLinkType',
      ),
    );
    const found = types.issueLinkTypes.find(
      (t) => /^relate/i.test(t.name) || /relates to/i.test(t.outward) || /relates to/i.test(t.inward),
    );
    return found?.name ?? 'Relates';
  }

  /** Dò id cho các field cần map: ưu tiên id cấu hình trong Settings, sau đó theo schema, cuối cùng theo tên */
  async detectFields(client: JiraClient, settings: Settings): Promise<DetectFieldsResponse> {
    const fields = await this.getFields(client);
    const byId = new Map(fields.map((f) => [f.id, f]));
    const toDetected = (f: JiraField | undefined): DetectedField | null =>
      f ? { id: f.id, name: f.name, schemaType: f.schema?.custom ?? f.schema?.type } : null;
    const byName = (name: string) => {
      const n = name.trim().toLowerCase();
      return fields.find((f) => f.custom && f.name.trim().toLowerCase() === n);
    };
    const pick = (
      key: keyof Settings['fields'],
      schemaCustom?: string,
      aliases: string[] = [],
    ): DetectedField | null => {
      const mapping = settings.fields[key];
      if (mapping.id && byId.has(mapping.id)) return toDetected(byId.get(mapping.id));
      if (schemaCustom) {
        const bySchema = fields.find((f) => f.schema?.custom === schemaCustom);
        if (bySchema) return toDetected(bySchema);
      }
      for (const name of [mapping.name, ...aliases]) {
        const f = byName(name);
        if (f) return toDetected(f);
      }
      return null;
    };
    return {
      startDate: pick('startDate'),
      epicLink: pick('epicLink', EPIC_LINK_TYPE),
      // Jira BIDV đặt tên field là "Role of Work"; giữ "Role" làm tên dự phòng
      role: pick('role', undefined, ['Role of Work', 'Role']),
      sprint: pick('sprint', SPRINT_TYPE),
    };
  }
}
