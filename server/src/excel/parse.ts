import ExcelJS from 'exceljs';
import { columnForHeader, COLUMNS, ISSUES_SHEET, MAX_IMPORT_ROWS, type ColumnKey } from './columns';

/** 1 dòng dữ liệu đọc từ sheet Issues (giá trị đã chuẩn hoá thành chuỗi) */
export interface RawExcelRow {
  /** Số dòng trong Excel (1-based) */
  line: number;
  values: Partial<Record<ColumnKey, string>>;
  /** Cột ngoài danh sách cố định (theo tên cột) — có thể là custom field bắt buộc */
  extra?: Record<string, string>;
}

export interface ParsedWorkbook {
  rows: RawExcelRow[];
  fatal: string[];
  /** Cột ngoài danh sách cố định (giá trị nằm trong RawExcelRow.extra) */
  unknownColumns: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Date (exceljs đọc ngày Excel thành UTC "giờ tường") → "YYYY-MM-DD HH:mm" | "YYYY-MM-DD" */
function fromDate(d: Date): string {
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return h || m ? `${date} ${pad(h)}:${pad(m)}` : date;
}

/** Số serial Excel (1 = 1900-01-01) → Date UTC */
function fromSerial(n: number): Date {
  return new Date(Math.round((n - 25569) * 86_400_000));
}

/** Giá trị ô exceljs → chuỗi */
export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return fromDate(value);
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText
        .map((t) => t.text)
        .join('')
        .trim();
    }
    if ('result' in value && value.result !== undefined) return cellText(value.result as ExcelJS.CellValue);
    if ('text' in value && typeof value.text === 'string') return value.text.trim();
    if ('error' in value) return '';
  }
  return String(value).trim();
}

/**
 * Chuẩn hoá ngày giờ: "2026-11-10 08:00", "2026-11-10", "10/11/2026 08:00", "10/11/2026",
 * Date / số serial Excel. Trả về "YYYY-MM-DD[ HH:mm]" hoặc null nếu sai.
 */
export function normalizeDateTime(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return fromDate(value);
  if (typeof value === 'number') return value > 0 ? fromDate(fromSerial(value)) : null;
  const s = cellText(value);
  if (!s) return '';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(s);
    if (!m) return null;
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  if (m[4] === undefined) return date;
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  if (hh > 23 || mm > 59) return null;
  return `${date} ${pad(hh)}:${pad(mm)}`;
}

/** Đọc sheet "Issues" (hoặc sheet đầu tiên) → các dòng dữ liệu */
export async function parseIssuesWorkbook(data: Buffer | ArrayBuffer): Promise<ParsedWorkbook> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as ArrayBuffer);
  } catch {
    return {
      rows: [],
      fatal: ['Không đọc được file. Hãy dùng file .xlsx (Excel 2007 trở lên).'],
      unknownColumns: [],
    };
  }
  const ws =
    wb.worksheets.find((w) => w.name.trim().toLowerCase() === ISSUES_SHEET.toLowerCase()) ?? wb.worksheets[0];
  if (!ws) return { rows: [], fatal: ['File không có sheet nào.'], unknownColumns: [] };

  // Tìm dòng tiêu đề trong 10 dòng đầu (dòng có nhiều cột nhận ra nhất)
  let headerLine = 0;
  let headerMap = new Map<number, ColumnKey>();
  const unknownColumns: string[] = [];
  for (let line = 1; line <= Math.min(10, ws.rowCount); line++) {
    const map = new Map<number, ColumnKey>();
    ws.getRow(line).eachCell((cell, col) => {
      const def = columnForHeader(cellText(cell.value));
      if (def && ![...map.values()].includes(def.key)) map.set(col, def.key);
    });
    if (map.size > headerMap.size) {
      headerMap = map;
      headerLine = line;
    }
  }
  const found = new Set(headerMap.values());
  const missing = COLUMNS.filter((c) => c.required && !found.has(c.key)).map((c) => `"${c.header}"`);
  if (!headerLine || missing.length) {
    return {
      rows: [],
      fatal: [
        `Sheet "${ws.name}" thiếu cột bắt buộc: ${
          missing.join(', ') ||
          COLUMNS.filter((c) => c.required)
            .map((c) => `"${c.header}"`)
            .join(', ')
        }. Hãy dùng file mẫu.`,
      ],
      unknownColumns,
    };
  }
  const extraCols = new Map<number, string>();
  ws.getRow(headerLine).eachCell((cell, col) => {
    const t = cellText(cell.value);
    if (t && !headerMap.has(col) && !unknownColumns.includes(t)) {
      unknownColumns.push(t);
      extraCols.set(col, t);
    }
  });

  const rows: RawExcelRow[] = [];
  for (let line = headerLine + 1; line <= ws.rowCount; line++) {
    const row = ws.getRow(line);
    const values: Partial<Record<ColumnKey, string>> = {};
    let any = false;
    for (const [col, key] of headerMap) {
      const raw = row.getCell(col).value;
      let v: string;
      if (key === 'from' || key === 'to') {
        const dt = normalizeDateTime(raw);
        v = dt === null ? `!${cellText(raw)}` : dt; // "!" = sai định dạng, báo lỗi ở bước resolve
      } else if (key === 'estimate' && typeof raw === 'number') {
        v = `${raw}h`; // số → giờ
      } else {
        v = cellText(raw);
      }
      if (v) {
        values[key] = v;
        any = true;
      }
    }
    const extra: Record<string, string> = {};
    for (const [col, name] of extraCols) {
      const v = cellText(row.getCell(col).value);
      if (v) {
        extra[name] = v;
        any = true;
      }
    }
    if (any) rows.push(Object.keys(extra).length ? { line, values, extra } : { line, values });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return {
      rows: [],
      fatal: [`File có ${rows.length} dòng, tối đa ${MAX_IMPORT_ROWS} dòng mỗi lần nhập.`],
      unknownColumns,
    };
  }
  if (!rows.length) {
    return { rows: [], fatal: [`Sheet "${ws.name}" chưa có dòng dữ liệu nào.`], unknownColumns };
  }
  return { rows, fatal: [], unknownColumns };
}
