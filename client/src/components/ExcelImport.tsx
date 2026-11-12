import { useRef, useState } from 'react';
import { Alert, App, Button, Modal, Radio, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { DownloadOutlined, FileExcelOutlined } from '@ant-design/icons';
import type { ExcelImportResponse, ImportRowIssue } from '@jpw/shared';
import { downloadFile, errorMessage, uploadFile } from '../api/http';

export type ImportMode = 'replace' | 'append';

/** Nút "Tải file mẫu" + "Nhập Excel" và hộp thoại kết quả trước khi nạp vào lưới */
export function ExcelImport({
  sourceKey,
  hasPendingRows,
  onImport,
}: {
  sourceKey: string;
  /** Lưới đang có dòng chưa tạo (có nội dung) → hỏi thay thế / thêm vào */
  hasPendingRows: boolean;
  onImport: (res: ExcelImportResponse, mode: ImportMode) => void;
}) {
  const { message, modal } = App.useApp();
  const input = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ res: ExcelImportResponse; file: string } | null>(null);
  const [mode, setMode] = useState<ImportMode>('replace');

  const download = async () => {
    setDownloading(true);
    try {
      const name = await downloadFile(
        `/excel/template?source=${encodeURIComponent(sourceKey)}`,
        `mau-nhap-issue-${sourceKey}.xlsx`,
      );
      message.success(`Đã tải ${name}`);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setDownloading(false);
    }
  };

  const upload = async (file: File) => {
    if (!/\.xlsx$/i.test(file.name)) {
      message.error('Chỉ nhận file .xlsx');
      return;
    }
    setUploading(true);
    try {
      const res = await uploadFile<ExcelImportResponse>(
        `/excel/import?source=${encodeURIComponent(sourceKey)}`,
        file,
      );
      if (res.fatal.length) {
        modal.error({
          title: `Không nhập được ${file.name}`,
          content: (
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {res.fatal.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ),
        });
        return;
      }
      setMode(hasPendingRows ? 'replace' : 'append');
      setResult({ res, file: file.name });
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  const errorLines = result?.res.issues.filter((i) => i.errors.length).length ?? 0;
  const warnLines = result?.res.issues.filter((i) => !i.errors.length && i.warnings.length).length ?? 0;

  return (
    <>
      <Tooltip title="File .xlsx gồm sheet Issues (nhập liệu, có dropdown), Lists (dữ liệu Jira thật) và Guide (hướng dẫn + ví dụ)">
        <Button icon={<DownloadOutlined />} onClick={download} loading={downloading}>
          Tải file mẫu
        </Button>
      </Tooltip>
      <Button icon={<FileExcelOutlined />} onClick={() => input.current?.click()} loading={uploading}>
        Nhập Excel
      </Button>
      <input
        ref={input}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />

      <Modal
        open={!!result}
        width={900}
        title={`Kết quả đọc ${result?.file ?? ''}`}
        onCancel={() => setResult(null)}
        okText={`Nạp ${result?.res.rows.length ?? 0} dòng vào lưới`}
        cancelText="Huỷ"
        onOk={() => {
          if (result) onImport(result.res, mode);
          setResult(null);
        }}
      >
        {result && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space wrap>
              <Tag color="blue">{result.res.rows.length} dòng</Tag>
              {errorLines > 0 && <Tag color="red">{errorLines} dòng có lỗi</Tag>}
              {warnLines > 0 && <Tag color="orange">{warnLines} dòng có cảnh báo</Tag>}
              {!errorLines && !warnLines && <Tag color="green">Không có lỗi</Tag>}
            </Space>
            {errorLines > 0 && (
              <Alert
                type="warning"
                showIcon
                message="Dòng lỗi vẫn được nạp (giá trị sai để trống, đánh dấu đỏ trên lưới). Sửa trên lưới rồi Preview / Tạo như bình thường."
              />
            )}
            {result.res.issues.length > 0 && (
              <Table<ImportRowIssue>
                size="small"
                rowKey={(r) => `${r.line}-${r.rowId ?? ''}`}
                pagination={{ pageSize: 8, hideOnSinglePage: true }}
                dataSource={result.res.issues}
                columns={[
                  { title: 'Dòng Excel', dataIndex: 'line', width: 90 },
                  {
                    title: 'Chi tiết',
                    render: (_, r) => (
                      <Space direction="vertical" size={0}>
                        {r.errors.map((e) => (
                          <Typography.Text key={e} type="danger">
                            ✖ {e}
                          </Typography.Text>
                        ))}
                        {r.warnings.map((w) => (
                          <Typography.Text key={w} type="warning">
                            ⚠ {w}
                          </Typography.Text>
                        ))}
                      </Space>
                    ),
                  },
                ]}
              />
            )}
            {hasPendingRows && (
              <Radio.Group value={mode} onChange={(e) => setMode(e.target.value as ImportMode)}>
                <Radio value="replace">Thay thế các dòng chưa tạo trên lưới</Radio>
                <Radio value="append">Thêm vào cuối lưới</Radio>
              </Radio.Group>
            )}
          </Space>
        )}
      </Modal>
    </>
  );
}
