# Jira Personal Workbench

Ứng dụng web cá nhân để tạo task/sub-task và theo dõi worklog Jira nhanh hơn giao diện Jira.

- **client/**: React 18, TypeScript, Vite, Ant Design, TanStack Query, dayjs
- **server/**: Fastify và TypeScript, đóng vai trò proxy tới Jira. Token chỉ nằm trong session phía server.
- **shared/**: type dùng chung và logic thuần (parse URL, tính giờ làm việc, map parent) kèm unit test

## Chạy nhanh

```bash
cp .env.example .env      # sửa JIRA_BASE_URL
npm install
npm run dev
```

- Giao diện (dev): http://localhost:5173
- API: http://127.0.0.1:3001/api/health

Các lệnh khác:

| Lệnh                              | Mô tả                                                  |
| --------------------------------- | ------------------------------------------------------ |
| `npm test`                        | Unit test (shared + server)                            |
| `npm run typecheck`               | Kiểm tra TypeScript strict cả 3 package                |
| `npm run lint` / `npm run format` | ESLint / Prettier                                      |
| `npm run build && npm start`      | Build production, server phục vụ luôn client tại :3001 |
| `docker compose up -d --build`    | Chạy bằng Docker tại http://127.0.0.1:3001             |

## Cấu hình `.env`

| Biến                   | Ý nghĩa                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `JIRA_BASE_URL`        | URL gốc Jira, có thể kèm context path                                                                          |
| `JIRA_ALLOWED_HOSTS`   | Danh sách host được phép gọi, phân cách bằng dấu phẩy (chống SSRF). Để trống thì dùng host của `JIRA_BASE_URL` |
| `API_PORT`, `HOST`     | Cổng và interface của server (mặc định `127.0.0.1:3001`)                                                       |
| `SESSION_IDLE_MINUTES` | Session tự hết hạn sau N phút không hoạt động (mặc định 480)                                                   |
| `COOKIE_SECURE`        | Đặt `true` khi truy cập qua HTTPS                                                                              |
| `DATA_DIR`             | Nơi lưu `settings.json` (mặc định `./data`)                                                                    |

## Bảo mật

- Token chỉ lưu trong RAM server (session) và được tham chiếu qua cookie `httpOnly; SameSite=Strict`. Không lưu localStorage, không trả về client.
- Logger có redact `authorization`, `cookie`, `token`. Không log body request.
- Chỉ gọi tới host trong allowlist, chỉ cho path `/rest/...`, không follow redirect.
- Jira trả 401 thì server huỷ session và client tự quay về màn đăng nhập.
- Đăng xuất sẽ huỷ session trên server và xoá cookie.

## API backend (`/api`)

| Method  | Path                                      | Mô tả                                                                                       |
| ------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET     | `/config`                                 | Base URL mặc định                                                                           |
| POST    | `/auth/login`                             | `{ token, baseUrl?, email? }` → thông tin user, set cookie                                  |
| POST    | `/auth/logout`                            | Huỷ session                                                                                 |
| GET     | `/auth/me`                                | Session hiện tại                                                                            |
| POST    | `/context/resolve`                        | `{ input }` (URL/issue key) → issue gốc hoặc danh sách từ JQL/filter                        |
| GET/PUT | `/settings`                               | Đọc/ghi settings                                                                            |
| POST    | `/settings/detect-fields`                 | Tự dò id field Start date / Epic Link / Role / Sprint                                       |
| POST    | `/meta/refresh`                           | Xoá cache metadata (10 phút)                                                                |
| GET     | `/meta/:projectKey/issuetypes`            | Issue type được phép tạo (createmeta, fallback API cũ)                                      |
| GET     | `/meta/:projectKey/issuetypes/:id/fields` | Field của issue type: required, schema, allowedValues                                       |
| GET     | `/meta/:projectKey/components`            | Components của project                                                                      |
| GET     | `/meta/labels?q=`                         | Gợi ý label                                                                                 |
| GET     | `/meta/users?q=&projectKey=`              | Tìm user (cho custom field kiểu user)                                                       |
| GET     | `/meta/field-ids`                         | Id các field Start date / Epic Link / Role / Sprint                                         |
| POST    | `/issues/preview`                         | `{ sourceKey, inherit, rows[] }` → payload + lỗi/cảnh báo từng dòng                         |
| GET     | `/issues/mine?source=KEY`                 | Công việc giao cho tôi dưới issue gốc, kèm editmeta và kiểm tra quy tắc log work            |
| POST    | `/issues/update`                          | `{ items: [{ key, changes }] }` → PUT từng issue, chỉ field thay đổi, kiểm quyền editmeta   |
| POST    | `/issues/create`                          | Như preview, gửi `POST /issue/bulk` (batch ≤ 50), tạo link "relates to" → kết quả từng dòng |

## Quy tắc tạo issue (GĐ2)

| Issue gốc      | Tạo        | Kết quả                                                |
| -------------- | ---------- | ------------------------------------------------------ |
| Story/Task/Bug | Sub-task   | `parent` = issue gốc                                   |
| Sub-task       | Sub-task   | `parent` = parent của issue gốc                        |
| Epic           | Story/Task | Server/DC: Epic Link = Epic. Cloud: `parent` = Epic    |
| Story/Task     | Task/Story | Gắn cùng Epic, sau đó tạo link "Relates" tới issue gốc |
| Epic           | Sub-task   | Báo lỗi                                                |

- Assignee luôn là người đăng nhập (Cloud dùng `accountId`, Server/DC dùng `name`).
- From ghi vào Start date (tự đổi định dạng theo kiểu date/datetime của field), To ghi vào `duedate`.
- Estimate = giờ làm việc từ From đến To (bỏ T7, CN và ngày nghỉ trong Settings), ghi vào `timetracking.originalEstimate`. Có thể nhập tay để ghi đè.
- Kế thừa từ issue gốc (tuỳ chọn): sprint đang active/future (sub-task không gắn sprint, vì Jira tự lấy theo parent), fix version, components, labels.
- Field không có trên màn hình tạo của issue type sẽ bị bỏ qua và hiện cảnh báo. Field bắt buộc còn thiếu sẽ báo lỗi ngay khi preview.

### Công việc của tôi trên issue gốc

Sau khi xác nhận issue gốc, bảng **"Công việc của tôi"** liệt kê các issue giao cho bạn bên dưới issue gốc:

```
assignee = currentUser() AND (parent = KEY OR issue in linkedIssues("KEY")) ORDER BY created ASC
```

- Nếu issue gốc là sub-task, KEY là parent của nó. Với Epic trên Server/DC, có thêm điều kiện Epic Link.
- Nếu Jira không hỗ trợ `linkedIssues()`, app tự bỏ điều kiện này.
- Sửa ngay trên bảng: Summary, Description, Labels, Components, Role, Priority, From (Start date), To (Due date), Estimate. Bấm **Lưu thay đổi** để gửi `PUT /issue/{key}`, chỉ gồm field đã đổi.
- Quyền sửa lấy theo `GET /issue/{key}/editmeta`. Field không có quyền sẽ bị khoá (biểu tượng 🔒), và server cũng chặn.
- Khi đổi Estimate, Remaining được tính lại = Estimate − thời gian đã log.
- Mỗi dòng kiểm tra quy tắc log work. ⚠ nghĩa là Estimate ≠ tổng log work, hoặc có log ngoài Start date → Due date. Rê chuột để xem chi tiết. Cột "Đã log" liệt kê từng worklog.

#### Log work dưới mỗi issue

Bấm **Log work** (hoặc dấu +) ở một dòng để mở khu log work của issue đó.

- **Log theo ngày (From → To):** lưới có mỗi ngày một ô giờ (T7/CN tô mờ) và cột Tổng.
  - Mỗi ô là tổng giờ log của bạn trong ngày đó. Log của người khác hiện mờ bên dưới ô.
  - Bấm **Lưu log theo ngày** để lưu một lần: ngày chưa có log thì tạo, ngày đã có thì sửa, ô để 0 thì xoá.
  - Nút nhanh: **Điền theo giờ làm việc**, **Điền theo Estimate**, **Xoá hết**, **Hoàn tác**.
- **Danh sách worklog:** thêm 1 worklog với ngày, giờ bắt đầu, thời gian, ghi chú. Sửa hoặc xoá được worklog của chính bạn.
- **Quy tắc:**
  - Ngày log phải nằm trong Start date → Due date. App chặn ở cả client lẫn server.
  - **Tổng log > Estimate không bị chặn.** Sau khi lưu, app cập nhật **Estimate = tổng log** và Remaining = 0. App báo trước khi lưu và báo lại "Estimate X → Y" sau khi lưu.
- Mọi thao tác dùng `adjustEstimate=auto`.
- API:
  - `POST /api/issues/:key/worklogs` với body `{ date, time, duration, comment? }`
  - `PUT /api/issues/:key/worklogs/:id`
  - `DELETE /api/issues/:key/worklogs/:id`
  - `PUT /api/issues/:key/worklogs/daily` với body `{ days: [{ date, duration }], comment? }`
  - Tất cả trả về `{ issue, estimateUpdated?, created?, updated?, deleted?, warnings }`.

### Log work: nhập thủ công

Khi tạo issue, app **không** tự log work. Log work được thêm thủ công sau đó ở các chỗ sau:

- Bảng "Công việc của tôi", nút **Log work** dưới mỗi issue: lưới theo ngày hoặc thêm từng worklog.
- Ô **log nhanh** trên timesheet: ở dock Worklog đáy trang tạo issue, hoặc ở trang Worklog.

Quy tắc khi log:

- **Ngày log phải nằm trong Start date → Due date.** Ngày ngoài khoảng bị chặn.
- **Estimate = tổng thời gian log work.** Khi tổng log vượt Estimate, app cập nhật Estimate = tổng log và Remaining = 0.
- Màn Worklog dùng `checkWorklogRules` (shared) để cảnh báo issue vi phạm quy tắc.

## Import Excel (GĐ3)

Sau khi xác nhận issue gốc, dưới lưới tạo issue có hai nút **Tải file mẫu** và **Nhập Excel**.

**File mẫu** (`.xlsx`) được sinh từ dữ liệu Jira thật của project, gồm 3 sheet:

| Sheet    | Nội dung                                                                                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Issues` | Nơi nhập liệu. Cột: Issue Type\*, Parent Key, Summary\*, Description, Labels, Components, Role, Priority, From, To, Estimate, cộng thêm một cột cho mỗi **custom field bắt buộc** khác (VD Module). Có sẵn dropdown cho tối đa 500 dòng. |
| `Lists`  | Danh sách issue type, component, Role, priority, label đang dùng trong dự án, giá trị của custom field bắt buộc, và bảng Role theo từng issue type.                                                                                      |
| `Guide`  | Ý nghĩa từng cột và 2 dòng ví dụ (sub-task và task).                                                                                                                                                                                     |

Cách nhập từng cột:

- Labels / Components nhập nhiều giá trị cách nhau bằng dấu phẩy.
- From / To nhận `yyyy-mm-dd hh:mm`, `dd/mm/yyyy hh:mm` hoặc ô ngày của Excel. Nếu chỉ có ngày thì From lấy giờ bắt đầu ca, To lấy giờ kết thúc ca.
- Estimate để trống thì tự tính theo From → To. Nhập số (VD `6`) được hiểu là giờ.
- Parent Key:
  - Với sub-task là parent của dòng đó; để trống thì dùng issue gốc.
  - Với loại khác là issue để link "relates to".

**Khi nhập file:**

- Đọc sheet `Issues`, hoặc sheet đầu tiên nếu không có. Dòng tiêu đề được tìm trong 10 dòng đầu, chấp nhận tên cột tiếng Việt và tên khác.
- **Lỗi chặn cả file:** không phải `.xlsx`, file lớn hơn 5 MB, thiếu cột bắt buộc, hơn 500 dòng, không có dòng dữ liệu.
- **Lỗi theo từng dòng:**
  - Thiếu Issue Type hoặc Summary.
  - Giá trị không có trong danh sách (issue type, component, Role, priority, giá trị custom field).
  - From ≥ To, ngày hoặc Estimate sai định dạng.
  - Parent Key không tồn tại (tra từng key qua `GET /issue/{key}`), là sub-task, hoặc thuộc project khác.
  - Sub-task không có parent khi issue gốc là Epic.
  - Thiếu custom field bắt buộc của issue type đó.
- **Cảnh báo:** label mới, field không có trên màn hình tạo của issue type đó, cột không nhận ra.
- Hộp thoại kết quả liệt kê lỗi theo số dòng Excel. Bạn chọn **thay thế** các dòng chưa tạo hoặc **thêm vào cuối** lưới.
- Dòng lỗi vẫn được nạp vào lưới: giá trị sai để trống, dòng tô đỏ, rê chuột để xem lỗi. Sửa xong bấm Preview → Tạo như luồng thường.

API:

- `GET /api/excel/template?source=KEY`: tải file mẫu.
- `POST /api/excel/import?source=KEY`: gửi file qua multipart, field `file`. Trả về `{ rows, issues, fatal }`.

## Nhiều issue gốc và Worklog trên trang tạo issue

**Nhiều issue gốc:**

- Phân tích rồi **Xác nhận** để mở issue gốc thành một tab. Có thể mở tối đa 20 tab.
- Mỗi tab có card issue gốc (nút Làm mới / Đóng), bảng "Công việc của tôi" và lưới tạo issue riêng. Chuyển tab không làm mất dữ liệu đang nhập.
- Danh sách issue gốc được **cache trong session server** (không lưu ở trình duyệt). Tải lại trang thì các tab vẫn còn; đăng xuất hoặc hết phiên thì mất.
- Tab đang mở được nhớ trong `sessionStorage`, chỉ là tuỳ chọn giao diện.
- Phân tích lại một issue đã có tab thì hiện nút "Đã có — mở tab".
- API: `GET /api/sources`, `POST /api/sources` với body `{ key, input }`, `POST /api/sources/:key/refresh`, `DELETE /api/sources/:key`.

**Dock Worklog:**

- Nằm ở đáy trang tạo issue, **luôn hiện** khi cuộn trang (sticky).
- Thanh tóm tắt cho kỳ đang chọn (mặc định tuần này): số giờ đã log / giờ chuẩn, chênh lệch, số ngày thiếu giờ, số issue vi phạm quy tắc.
- Bấm thanh hoặc nút **Mở rộng / Thu gọn** để hiện timesheet đầy đủ: chọn kỳ, cảnh báo, lưới issue × ngày, log nhanh, xuất Excel. Trạng thái mở / đóng được nhớ.
- Log work ở bất kỳ đâu (lưới theo ngày, log nhanh) đều tự làm mới dock và bảng "Công việc của tôi".

## Worklog / Timesheet (GĐ4)

Menu **Worklog**. Chọn khoảng ngày (tối đa 93 ngày) hoặc chọn nhanh: Tuần này, Tuần trước, Tháng này, Tháng trước.

**Cách lấy dữ liệu:**

1. Tìm issue có log của bạn trong kỳ:
   ```
   worklogAuthor = currentUser() AND worklogDate >= "from" AND worklogDate <= "to"
   ```
2. Đọc toàn bộ worklog của từng issue (`GET /issue/{key}/worklog`, có phân trang).
3. Chỉ giữ worklog **của bạn** có ngày bắt đầu nằm trong kỳ. Ngày tính theo múi giờ Jira trả về, giống cách Clockwork và Jira hiển thị.

Trang **Worklog** gồm:

- **Thẻ tổng hợp:** tổng giờ đã log, giờ chuẩn (ngày làm việc đã qua, trước hôm nay, × giờ/ngày), chênh lệch, số ngày thiếu giờ và số issue vi phạm quy tắc.
- **Cảnh báo:** ngày làm việc log thiếu giờ, ngày log quá giờ chuẩn, issue vi phạm quy tắc log work (Estimate ≠ tổng log, hoặc có log ngoài Start → Due).
- **Lưới issue × ngày:**
  - T7/CN tô mờ, ngày hôm nay có viền xanh.
  - Cột "Est · Log · Còn": Estimate, tổng log của mọi người, Remaining.
  - Dòng **Tổng theo ngày**: đỏ là thiếu giờ, vàng là vượt giờ.
- **Log nhanh:** bấm vào một ô, nhập số giờ, giờ bắt đầu và ghi chú rồi bấm Log.
  - Quy tắc vẫn áp dụng: ngày phải nằm trong Start → Due, và Estimate tự tăng khi tổng log vượt Estimate.
- **Xuất Excel:** 3 sheet: Tổng hợp, Timesheet (issue × ngày, đơn vị giờ, tô màu thiếu/vượt và T7/CN), Chi tiết (từng worklog kèm ghi chú).

API:

- `GET /api/worklog/timesheet?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/worklog/timesheet.xlsx?from=…&to=…`

## Chuyển trạng thái issue

Trong bảng "Công việc của tôi", bấm vào **tag trạng thái** của một issue để mở danh sách bước chuyển mà Jira cho phép từ trạng thái hiện tại.

- Bước chuyển có màn hình nhập liệu (dấu `…`) mở một form. Form gồm các field bắt buộc chưa có giá trị mặc định, Resolution (nếu có) và một ô comment tuỳ chọn.
- Lỗi từ workflow (validator) được hiện theo tên field.
- Chuyển xong thì bảng và timesheet tự cập nhật.
- API:
  - `GET /api/issues/:key/transitions` (dùng `expand=transitions.fields`)
  - `POST /api/issues/:key/transitions` với body `{ transitionId, fields?, comment? }`

## Cài đặt (GĐ5)

Trang **Cài đặt** chỉ sửa trên form. Bấm **Lưu** mới ghi vào `data/settings.json`. Server kiểm tra và chuẩn hoá trước khi ghi; giá trị sai được đưa về mặc định.

| Nhóm                   | Nội dung                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Map field Jira         | Start date, Epic Link, Role, Sprint: tên field để tự dò, hoặc chọn field id từ danh sách mọi field của Jira (`GET /api/meta/fields`). Cột "Đang dùng" cho biết field đang được dùng. Nút **Tự dò**. |
| Giờ làm việc           | Số giờ / ngày (1d). Các khung giờ: sắp xếp, bỏ khung chồng lấn, cảnh báo nếu tổng khung giờ khác số giờ / ngày. Ngày làm việc trong tuần. Múi giờ gửi lên Jira.                                     |
| Ngày nghỉ              | Thêm / xoá ngày nghỉ. Ngày nghỉ không tính vào Estimate và giờ chuẩn timesheet. Mặc định để trống.                                                                                                  |
| Mặc định khi tạo issue | Labels, components (theo tên), mẫu summary (`{summary}`, có ví dụ xem trước), các ô kế thừa (sprint, fix version, components, labels).                                                              |
| Cache                  | Làm mới metadata.                                                                                                                                                                                   |

- Các nút: **Huỷ thay đổi**, **Mặc định** (đưa form về mặc định, chưa lưu), **Lưu**.
- Lưu xong, các màn khác (timesheet, công việc của tôi, metadata) tự làm mới.

## Tiến độ

- [x] **GĐ1**: Login bằng PAT, parse URL, card issue gốc, tự dò field, dark mode
- [x] **GĐ2**: Lưới tạo issue, preview, bulk create, link relates, retry dòng lỗi
- [x] **GĐ3**: Import Excel (file mẫu 3 sheet có dropdown dữ liệu thật, kiểm tra theo dòng, nạp vào lưới)
- [x] **GĐ4**: Worklog / Timesheet (lưới issue × ngày, tổng, cảnh báo thiếu/vượt giờ, quy tắc log work, log nhanh, xuất Excel)
- [x] **GĐ5**: Settings đầy đủ (map field, giờ làm việc, ngày nghỉ, múi giờ, mặc định khi tạo issue) + chuyển trạng thái issue
