import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  fields: {
    startDate: { name: 'Start date' },
    epicLink: { name: 'Epic Link' },
    role: { name: 'Role of Work' },
    sprint: { name: 'Sprint' },
  },
  workSchedule: {
    hoursPerDay: 8,
    windows: [
      { start: '08:00', end: '12:00' },
      { start: '13:00', end: '17:00' },
    ],
    workingWeekdays: [1, 2, 3, 4, 5],
    // Theo yêu cầu: ngày lễ tính như ngày thường → mặc định rỗng, có thể thêm trong Settings
    holidays: [],
  },
  utcOffset: '+07:00',
  defaults: {
    labels: [],
    components: [],
    summaryTemplate: '{summary}',
    inherit: { sprint: true, fixVersions: true, components: true, labels: false },
    logWork: false,
  },
  allowAssigneeEdit: false,
  clockwork: { enabled: false },
};

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` lên `base`; mảng được thay thế nguyên khối; bỏ qua key lạ & sai kiểu. */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return base;
  const out: Plain = { ...base };
  for (const [k, baseVal] of Object.entries(base)) {
    if (!(k in patch)) continue;
    const pv = patch[k];
    if (isPlainObject(baseVal)) {
      out[k] = mergeSettings(baseVal, pv);
    } else if (Array.isArray(baseVal)) {
      if (Array.isArray(pv)) out[k] = pv;
    } else if (baseVal === undefined || typeof pv === typeof baseVal) {
      out[k] = pv;
    }
  }
  // FieldMapping.id là optional → base không có key, cho phép copy riêng
  if ('id' in patch && 'name' in base && (typeof patch.id === 'string' || patch.id === undefined)) {
    out.id = patch.id ? patch.id : undefined;
  }
  return out as T;
}

/** Áp template summary, VD "[BE] {summary}" */
export function applySummaryTemplate(template: string, summary: string): string {
  if (!template || !template.includes('{summary}')) return summary;
  const result = template.replace('{summary}', summary);
  // Không áp lại nếu summary đã có tiền tố
  const prefix = template.split('{summary}')[0];
  if (prefix && summary.startsWith(prefix)) return summary;
  return result;
}
