/** Cột của sheet "Issues" — dùng chung cho file mẫu và parser */
export type ColumnKey =
  | 'issueType'
  | 'parentKey'
  | 'summary'
  | 'description'
  | 'labels'
  | 'components'
  | 'role'
  | 'priority'
  | 'from'
  | 'to'
  | 'estimate';

export interface ColumnDef {
  key: ColumnKey;
  header: string;
  required?: boolean;
  width: number;
  /** Tên cột khác được chấp nhận khi đọc file (không phân biệt hoa thường, bỏ phần trong ngoặc) */
  aliases: string[];
  note: string;
}

export const COLUMNS: ColumnDef[] = [
  {
    key: 'issueType',
    header: 'Issue Type',
    required: true,
    width: 22,
    aliases: ['issuetype', 'type', 'loại', 'loại issue'],
    note: 'Bắt buộc. Chọn từ danh sách (sheet Lists).',
  },
  {
    key: 'parentKey',
    header: 'Parent Key',
    width: 18,
    aliases: ['parent', 'parent issue'],
    note: 'Sub-task: parent của dòng (để trống = theo issue gốc). Loại khác: issue để tạo link "relates to".',
  },
  {
    key: 'summary',
    header: 'Summary',
    required: true,
    width: 45,
    aliases: ['tiêu đề', 'tên công việc'],
    note: 'Bắt buộc. Tối đa 255 ký tự.',
  },
  { key: 'description', header: 'Description', width: 40, aliases: ['mô tả'], note: 'Tuỳ chọn.' },
  {
    key: 'labels',
    header: 'Labels',
    width: 24,
    aliases: ['label', 'nhãn'],
    note: 'Nhiều label cách nhau bằng dấu phẩy. Khoảng trắng trong label được đổi thành "_".',
  },
  {
    key: 'components',
    header: 'Components',
    width: 24,
    aliases: ['component'],
    note: 'Nhiều component cách nhau bằng dấu phẩy. Phải có trong danh sách.',
  },
  {
    key: 'role',
    header: 'Role',
    width: 18,
    aliases: ['role of work', 'vai trò'],
    note: 'Giá trị field Role của issue type (chọn từ danh sách).',
  },
  { key: 'priority', header: 'Priority', width: 14, aliases: ['độ ưu tiên'], note: 'Chọn từ danh sách.' },
  {
    key: 'from',
    header: 'From (yyyy-mm-dd hh:mm)',
    width: 20,
    aliases: ['from', 'start', 'start date', 'từ'],
    note: 'Ghi vào Start date. Chỉ có ngày → giờ bắt đầu ca làm việc.',
  },
  {
    key: 'to',
    header: 'To (yyyy-mm-dd hh:mm)',
    width: 20,
    aliases: ['to', 'due', 'due date', 'đến'],
    note: 'Ghi vào Due date. Chỉ có ngày → giờ kết thúc ca làm việc.',
  },
  {
    key: 'estimate',
    header: 'Estimate',
    width: 12,
    aliases: ['original estimate', 'ước lượng'],
    note: 'Để trống = tự tính giờ làm việc From → To. Hoặc nhập 1d 4h / 30m / số giờ (VD 6).',
  },
];

export const ISSUES_SHEET = 'Issues';
export const LISTS_SHEET = 'Lists';
export const GUIDE_SHEET = 'Guide';
export const MAX_IMPORT_ROWS = 500;

/** "From (yyyy-mm-dd hh:mm)" → "from" */
export function normalizeHeader(text: string): string {
  return text
    .replace(/\(.*?\)/g, '')
    .replace(/[*:]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function columnForHeader(text: string): ColumnDef | undefined {
  const h = normalizeHeader(text);
  if (!h) return undefined;
  return COLUMNS.find(
    (c) => normalizeHeader(c.header) === h || c.aliases.some((a) => normalizeHeader(a) === h),
  );
}
