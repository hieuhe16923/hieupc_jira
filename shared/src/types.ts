// ===== Kiểu dữ liệu dùng chung giữa client và server =====

export type DeploymentType = 'Server' | 'Cloud' | 'Unknown';

export interface JiraUser {
  /** Jira Server/DC: user key */
  key?: string;
  /** Jira Server/DC: username (dùng cho assignee.name) */
  name?: string;
  /** Jira Cloud: accountId */
  accountId?: string;
  displayName: string;
  emailAddress?: string;
  avatarUrl?: string;
  timeZone?: string;
}

export interface SessionInfo {
  user: JiraUser;
  baseUrl: string;
  deploymentType: DeploymentType;
  serverVersion?: string;
}

export interface PublicConfig {
  defaultBaseUrl: string;
}

export interface LoginRequest {
  token: string;
  baseUrl?: string;
  /** Chỉ dùng cho Jira Cloud (email + API token → Basic auth). Bỏ trống với Server/DC (PAT → Bearer). */
  email?: string;
}

export interface IssueTypeRef {
  id: string;
  name: string;
  subtask: boolean;
  iconUrl?: string;
}

export interface NamedRef {
  id: string;
  name: string;
}

export interface SprintRef {
  id: number;
  name: string;
  state?: string;
}

export interface SourceIssue {
  id: string;
  key: string;
  url: string;
  summary: string;
  status: { name: string; category?: string };
  project: { id: string; key: string; name: string };
  issueType: IssueTypeRef;
  isEpic: boolean;
  /** Parent (chỉ khi issue gốc là sub-task) */
  parent?: { key: string; summary: string; issueType: IssueTypeRef };
  /** Epic chứa issue (với sub-task: epic của parent) */
  epicKey?: string;
  sprints: SprintRef[];
  components: NamedRef[];
  labels: string[];
  fixVersions: NamedRef[];
  priority?: NamedRef;
  assignee?: JiraUser;
  timetracking?: { originalEstimate?: string; remainingEstimate?: string; timeSpent?: string };
}

export interface IssueSummary {
  key: string;
  summary: string;
  issueType: IssueTypeRef;
  status: string;
}

export type ParsedInput =
  | { kind: 'issue'; key: string; host?: string }
  | { kind: 'jql'; jql: string; host?: string }
  | { kind: 'filter'; filterId: string; host?: string }
  | { kind: 'invalid'; reason: string };

export interface ResolveRequest {
  input: string;
}

export interface ResolveResponse {
  parsed: ParsedInput;
  issue?: SourceIssue;
  /** Kết quả khi input là JQL / filter */
  issues?: IssueSummary[];
  total?: number;
  jql?: string;
  warnings: string[];
}

export interface ApiError {
  code: string;
  status: number;
  message: string;
  jira?: { errorMessages?: string[]; errors?: Record<string, string> };
}

// ===== Settings =====

export interface TimeWindow {
  /** HH:mm */
  start: string;
  /** HH:mm */
  end: string;
}

export interface WorkSchedule {
  /** Số giờ của 1 ngày công khi quy đổi estimate (Jira mặc định 8) */
  hoursPerDay: number;
  /** Khung giờ làm việc trong ngày */
  windows: TimeWindow[];
  /** Ngày làm việc trong tuần: 0=CN, 1=T2 ... 6=T7 */
  workingWeekdays: number[];
  /** Ngày nghỉ (YYYY-MM-DD) — không tính giờ */
  holidays: string[];
}

export interface FieldMapping {
  /** customfield_xxxxx; để trống = tự dò theo tên */
  id?: string;
  /** Tên field dùng để tự dò */
  name: string;
}

export interface Settings {
  fields: {
    startDate: FieldMapping;
    epicLink: FieldMapping;
    role: FieldMapping;
    sprint: FieldMapping;
  };
  workSchedule: WorkSchedule;
  /** Offset múi giờ dùng khi gửi ngày-giờ lên Jira, VD "+07:00" */
  utcOffset: string;
  defaults: {
    labels: string[];
    components: string[];
    /** VD "[BE] {summary}" */
    summaryTemplate: string;
    inherit: { sprint: boolean; fixVersions: boolean; components: boolean; labels: boolean };
    /** Tự log work khi tạo issue (mặc định tắt — log work thêm thủ công) */
    logWork: boolean;
  };
  allowAssigneeEdit: boolean;
  clockwork: { enabled: boolean };
}

export interface DetectedField {
  id: string;
  name: string;
  schemaType?: string;
}

export type DetectFieldsResponse = Record<keyof Settings['fields'], DetectedField | null>;

// ===== GĐ2: metadata tạo issue =====

export interface FieldSchema {
  type: string;
  items?: string;
  custom?: string;
  system?: string;
  customId?: number;
}

export interface AllowedValue {
  id: string;
  name: string;
  iconUrl?: string;
  children?: AllowedValue[];
}

export interface FieldMeta {
  id: string;
  name: string;
  required: boolean;
  hasDefaultValue: boolean;
  schema: FieldSchema;
  allowedValues?: AllowedValue[];
  autoCompleteUrl?: string;
}

export interface IssueTypeFieldsResponse {
  issueTypeId: string;
  fields: FieldMeta[];
}

/** Gợi ý label: label đang dùng trong project, và label khác trên toàn Jira */
export interface LabelSuggestions {
  project: string[];
  others: string[];
}

export interface UserOption {
  /** Cloud: accountId; Server/DC: username */
  id: string;
  displayName: string;
  avatarUrl?: string;
  emailAddress?: string;
}

export type FieldValue = string | number | string[] | null | undefined;

/** Một dòng trong lưới tạo issue (cũng là đầu ra của import Excel) */
export interface IssueRow {
  rowId: string;
  issueTypeId: string;
  summary: string;
  description?: string;
  labels: string[];
  /** id component */
  components: string[];
  priorityId?: string;
  /** "YYYY-MM-DD HH:mm" (giờ địa phương) */
  from?: string;
  to?: string;
  /** Ghi đè estimate, VD "1d 4h". Trống = tự tính từ From–To */
  estimate?: string;
  /** Ghi đè parent (sub-task). Trống = tự map theo issue gốc */
  parentKey?: string;
  /** Giá trị các custom field khác (Role, field bắt buộc...) theo fieldId */
  extra: Record<string, FieldValue>;
}

export interface InheritOptions {
  sprint: boolean;
  fixVersions: boolean;
  components: boolean;
  labels: boolean;
}

export interface CreateIssuesRequest {
  sourceKey: string;
  inherit: InheritOptions;
  /** Tự log work sau khi tạo: mỗi ngày làm việc From→To một worklog, tổng = Estimate */
  logWork?: boolean;
  rows: IssueRow[];
}

export interface RowRelation {
  parentKey?: string;
  epicKey?: string;
  relatesToKey?: string;
}

/** Một worklog dự kiến (giờ tường, theo utcOffset trong Settings) */
export interface WorklogPlanItem {
  /** YYYY-MM-DD */
  date: string;
  /** YYYY-MM-DD HH:mm */
  start: string;
  minutes: number;
}

export interface RowPreview {
  rowId: string;
  fields?: Record<string, unknown>;
  relation: RowRelation;
  estimate?: string;
  /** Kế hoạch log work (khi bật logWork) */
  worklogs?: WorklogPlanItem[];
  errors: string[];
  warnings: string[];
}

export interface PreviewResponse {
  rows: RowPreview[];
}

export interface RowResult {
  rowId: string;
  ok: boolean;
  key?: string;
  url?: string;
  /** Số worklog đã ghi thành công / dự kiến */
  worklogsLogged?: number;
  worklogsPlanned?: number;
  errors: string[];
  warnings: string[];
}

export interface CreateIssuesResponse {
  results: RowResult[];
}

// ---------- Công việc của tôi trên issue gốc (xem + sửa) ----------

export interface MyWorklog {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** YYYY-MM-DD HH:mm (giờ tường theo started của Jira) */
  start: string;
  minutes: number;
  author?: string;
  /** Worklog do chính tôi ghi (được sửa/xoá) */
  mine: boolean;
  comment?: string;
}

/** Thêm / sửa 1 worklog */
export interface WorklogInput {
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm */
  time: string;
  /** VD "1h 30m", "0.5d" */
  duration: string;
  comment?: string;
}

export interface MyIssue {
  key: string;
  url: string;
  summary: string;
  description?: string;
  issueType: IssueTypeRef;
  status: { name: string; category?: string };
  parentKey?: string;
  labels: string[];
  /** id */
  components: string[];
  priorityId?: string;
  /** Start date: "YYYY-MM-DD HH:mm" hoặc "YYYY-MM-DD" */
  from?: string;
  /** Due date: "YYYY-MM-DD" */
  to?: string;
  estimate?: string;
  estimateMinutes?: number;
  spentMinutes: number;
  remaining?: string;
  /** Giá trị field Role (id option) */
  role?: FieldValue;
  /** Tên hiển thị (dùng khi ô chỉ đọc) */
  display: { components: string[]; priority?: string; role?: string };
  /** Field user được phép sửa (editmeta), chỉ gồm các field app quản lý */
  editMeta: FieldMeta[];
  worklogs: MyWorklog[];
  /** Vi phạm quy tắc: Estimate = tổng log work, log trong Start date → Due date */
  ruleIssues: string[];
}

export interface MyIssuesResponse {
  /** Issue dùng làm gốc truy vấn (sub-task → parent của nó) */
  anchorKey: string;
  jql: string;
  issues: MyIssue[];
  total: number;
  warnings: string[];
}

/** Chỉ gửi field có thay đổi; null = xoá giá trị */
export interface IssueChanges {
  summary?: string;
  description?: string;
  labels?: string[];
  components?: string[];
  priorityId?: string;
  from?: string | null;
  to?: string | null;
  estimate?: string | null;
  role?: FieldValue;
}

export interface UpdateIssuesRequest {
  items: { key: string; changes: IssueChanges }[];
}

export interface UpdateIssueResult {
  key: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Issue sau khi cập nhật (đọc lại từ Jira) */
  issue?: MyIssue;
}

export interface UpdateIssuesResponse {
  results: UpdateIssueResult[];
}

/** Log theo ngày From → To: mỗi ngày tổng thời gian của TÔI ("" hoặc "0" = xoá log ngày đó) */
export interface DailyWorklogRequest {
  days: { date: string; duration: string }[];
  comment?: string;
}

/** Kết quả mọi thao tác log work */
export interface WorklogSaveResponse {
  issue: MyIssue;
  /** Estimate được nâng = tổng log (khi tổng log > Estimate) */
  estimateUpdated?: { from?: string; to: string };
  /** Số thao tác đã thực hiện (log theo ngày) */
  created?: number;
  updated?: number;
  deleted?: number;
  warnings: string[];
}

// ---------- GĐ3: Import Excel ----------

/** Lỗi / cảnh báo của 1 dòng Excel */
export interface ImportRowIssue {
  /** Số dòng trong sheet Issues (theo Excel, bắt đầu từ 1) */
  line: number;
  /** rowId của dòng tương ứng trong lưới (nếu dòng được nạp vào lưới) */
  rowId?: string;
  errors: string[];
  warnings: string[];
}

export interface ExcelImportResponse {
  /** Dòng nạp vào lưới (kể cả dòng có lỗi — giá trị sai được bỏ trống để sửa trên lưới) */
  rows: IssueRow[];
  issues: ImportRowIssue[];
  /** Lỗi chặn toàn file (thiếu sheet / thiếu cột bắt buộc / quá nhiều dòng) */
  fatal: string[];
}

// ---------- GĐ4: Worklog / Timesheet ----------

export interface TimesheetDay {
  /** YYYY-MM-DD */
  date: string;
  /** 0 = CN … 6 = T7 */
  weekday: number;
  /** Ngày làm việc theo Settings (thứ + ngày nghỉ) */
  working: boolean;
  /** Tổng phút tôi log trong ngày */
  minutes: number;
}

export interface TimesheetIssue {
  key: string;
  url: string;
  summary: string;
  issueType: IssueTypeRef;
  status: { name: string; category?: string };
  parentKey?: string;
  /** Start date / Due date (giờ tường) */
  from?: string;
  to?: string;
  estimate?: string;
  estimateMinutes?: number;
  /** Tổng log của MỌI người trên issue (Jira timeSpent) */
  spentMinutes: number;
  remaining?: string;
  /** Log của tôi trong kỳ, theo ngày */
  byDay: Record<string, number>;
  /** Tổng log của tôi trong kỳ */
  minutes: number;
  /** Worklog của tôi trong kỳ */
  worklogs: MyWorklog[];
  /** Vi phạm quy tắc (Estimate = tổng log, log trong Start → Due) — tính trên toàn bộ worklog của issue */
  ruleIssues: string[];
}

export interface TimesheetResponse {
  from: string;
  to: string;
  jql: string;
  days: TimesheetDay[];
  issues: TimesheetIssue[];
  totalMinutes: number;
  /** Giờ chuẩn = số ngày làm việc đã qua (trước hôm nay, trong kỳ) × giờ/ngày */
  expectedMinutes: number;
  /** Ngày làm việc (đã qua) log thiếu giờ chuẩn */
  shortDays: { date: string; minutes: number }[];
  /** Ngày log quá giờ chuẩn */
  overDays: { date: string; minutes: number }[];
  hoursPerDay: number;
  warnings: string[];
}

// ---------- Nhiều issue gốc (lưu trong session server) ----------

export interface SourceEntry {
  key: string;
  /** Chuỗi người dùng đã nhập (URL / key) */
  input: string;
  issue: SourceIssue;
  addedAt: number;
}

export interface SourcesResponse {
  sources: SourceEntry[];
}

// ---------- Chuyển trạng thái issue ----------

export interface TransitionOption {
  id: string;
  name: string;
  to: { name: string; category?: string };
  /** Field trên màn hình chuyển trạng thái (chỉ field bắt buộc chưa có mặc định + resolution) */
  fields: FieldMeta[];
}

export interface TransitionRequest {
  transitionId: string;
  fields?: Record<string, FieldValue>;
  comment?: string;
}
