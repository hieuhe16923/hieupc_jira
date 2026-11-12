import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '@jpw/shared';

/** Settings lưu ở file JSON local phía server (data/settings.json) */
export class SettingsStore {
  private cached: Settings | null = null;
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'settings.json');
  }

  async get(): Promise<Settings> {
    if (this.cached) return this.cached;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      this.cached = mergeSettings(DEFAULT_SETTINGS, raw);
    } catch {
      this.cached = structuredClone(DEFAULT_SETTINGS);
      // Chưa có file (VD instance serverless mới) → dùng settings ban đầu từ biến môi trường
      if (process.env.SETTINGS_JSON) {
        try {
          this.cached = validateSettings(
            mergeSettings(DEFAULT_SETTINGS, JSON.parse(process.env.SETTINGS_JSON) as unknown),
          );
        } catch {
          // SETTINGS_JSON sai định dạng → giữ mặc định
        }
      }
    }
    return this.cached;
  }

  async update(patch: unknown): Promise<Settings> {
    const next = validateSettings(mergeSettings(await this.get(), patch));
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await rename(tmp, this.file);
    this.cached = next;
    return next;
  }
}

const HM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_ID = /^(customfield_\d+|[a-zA-Z][a-zA-Z0-9_]*)$/;

const toMin = (hm: string) => Number(hm.split(':')[0]) * 60 + Number(hm.split(':')[1]);
const pad = (hm: string) => hm.padStart(5, '0');

/** Chuẩn hoá + kiểm tra settings trước khi ghi file (giá trị sai → về mặc định) */
export function validateSettings(s: Settings): Settings {
  const ws = s.workSchedule;
  const hoursPerDay =
    typeof ws.hoursPerDay === 'number' && ws.hoursPerDay > 0 && ws.hoursPerDay <= 24
      ? Math.round(ws.hoursPerDay * 100) / 100
      : DEFAULT_SETTINGS.workSchedule.hoursPerDay;

  // Khung giờ: đúng định dạng, end > start, sắp theo giờ bắt đầu, bỏ khung chồng lấn
  const windows: Settings['workSchedule']['windows'] = [];
  for (const w of [...(ws.windows ?? [])]
    .filter((w) => HM.test(w?.start ?? '') && HM.test(w?.end ?? '') && toMin(w.end) > toMin(w.start))
    .map((w) => ({ start: pad(w.start), end: pad(w.end) }))
    .sort((a, b) => toMin(a.start) - toMin(b.start))) {
    const last = windows.at(-1);
    if (!last || toMin(w.start) >= toMin(last.end)) windows.push(w);
  }

  const weekdays = [
    ...new Set((ws.workingWeekdays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)),
  ].sort();

  const field = (key: keyof Settings['fields']) => {
    const m = s.fields[key];
    const name =
      typeof m?.name === 'string' && m.name.trim() ? m.name.trim() : DEFAULT_SETTINGS.fields[key].name;
    const id = typeof m?.id === 'string' && FIELD_ID.test(m.id.trim()) ? m.id.trim() : undefined;
    return id ? { name, id } : { name };
  };

  let template =
    typeof s.defaults.summaryTemplate === 'string' ? s.defaults.summaryTemplate.slice(0, 200) : '';
  if (!template.trim()) template = '{summary}';
  else if (!template.includes('{summary}')) template = `${template.trimEnd()} {summary}`;

  const inh = s.defaults.inherit ?? DEFAULT_SETTINGS.defaults.inherit;
  return {
    ...s,
    fields: {
      startDate: field('startDate'),
      epicLink: field('epicLink'),
      role: field('role'),
      sprint: field('sprint'),
    },
    workSchedule: {
      hoursPerDay,
      windows: windows.length ? windows : structuredClone(DEFAULT_SETTINGS.workSchedule.windows),
      workingWeekdays: weekdays.length ? weekdays : [...DEFAULT_SETTINGS.workSchedule.workingWeekdays],
      holidays: [...new Set((ws.holidays ?? []).filter((d) => typeof d === 'string' && DATE.test(d)))].sort(),
    },
    utcOffset: /^[+-](0\d|1[0-4]):[0-5]\d$/.test(s.utcOffset) ? s.utcOffset : DEFAULT_SETTINGS.utcOffset,
    defaults: {
      labels: [
        ...new Set(
          (s.defaults.labels ?? [])
            .filter((l) => typeof l === 'string' && l.trim())
            .map((l) => l.trim().replace(/\s+/g, '_')),
        ),
      ],
      components: [
        ...new Set(
          (s.defaults.components ?? []).filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim()),
        ),
      ],
      summaryTemplate: template,
      inherit: {
        sprint: Boolean(inh.sprint),
        fixVersions: Boolean(inh.fixVersions),
        components: Boolean(inh.components),
        labels: Boolean(inh.labels),
      },
      logWork: Boolean(s.defaults.logWork),
    },
    allowAssigneeEdit: Boolean(s.allowAssigneeEdit),
    clockwork: { enabled: Boolean(s.clockwork?.enabled) },
  };
}
