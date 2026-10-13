import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileUp,
  Loader2,
  X,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import type { ImportPlansResult } from '@letian/contracts';

/**
 * 导入质检方案弹窗（质检方案设计页「导入方案」入口）。
 *
 * 三步交互：下载导入模板 → 选择填好的 .xlsx / 表格型 .pdf → 上传导入（POST /api/v1/plans/import）。
 *   - 模板由后端实时生成（GET /plans/import-template），「填写说明 / 物料参照」页
 *     携带预置检验项目清单（与新建弹窗的勾选清单同源）/ 存货分类 / 物料编码，保证模板即取值域；
 *   - 上传接受 .xlsx 与表格型 .pdf：xlsx 直接读单元格；PDF 抽文字层后按表头列位还原表格，
 *     两种格式走同一套校验与落库链路（扫描件/图片型 PDF 无文字层，服务端会明确拒绝并说明）；
 *   - 上传走 multipart/form-data（字段名 file），服务端按「方案名称+分类+物料」聚组落库，
 *     结果以 新建 / 跳过(重复) / 失败 三态逐组回显，绝不把部分成功说成全部成功；
 *   - 导入成功的方案保存即启用（与新建弹窗同口径，方案不再有「草稿 → 审批」链路）；
 *   - 有成功导入时调用 onSuccess 刷新列表与 KPI，弹窗保持打开以便用户查看逐组结果。
 */

interface ImportPlanModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

/** 触发浏览器下载 Blob（模板文件名与后端 Content-Disposition 保持一致） */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function ImportPlanModal({ isOpen, onClose, onSuccess }: ImportPlanModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [result, setResult] = useState<ImportPlansResult | null>(null);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 每次打开弹窗重置为初始态（与 CreatePlanModal 同一惯例）
  useEffect(() => {
    if (!isOpen) return;
    setFile(null);
    setImporting(false);
    setTemplateLoading(false);
    setResult(null);
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [isOpen]);

  if (!isOpen) return null;

  const handleDownloadTemplate = async () => {
    setTemplateLoading(true);
    setError('');
    try {
      const blob = await api.getBlob('/plans/import-template');
      downloadBlob(blob, '质检方案导入模板.xlsx');
    } catch (err) {
      setError(`下载导入模板失败：${errorMessage(err)}`);
    } finally {
      setTemplateLoading(false);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    setResult(null);
    setError('');
    if (selected !== null && !/\.(xlsx|pdf)$/i.test(selected.name)) {
      setFile(null);
      setError('仅支持 .xlsx 或 .pdf 格式文件，请使用导入模板填写后上传');
      return;
    }
    setFile(selected);
  };

  const handleClearFile = () => {
    setFile(null);
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleImport = async () => {
    if (file === null) return;
    setImporting(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.postFormData<ImportPlansResult>('/plans/import', formData);
      setResult(res);
      if (res.created.length > 0) onSuccess();
    } catch (err) {
      setError(`导入失败：${errorMessage(err)}`);
    } finally {
      setImporting(false);
    }
  };

  const handleImportAnother = () => {
    setFile(null);
    setResult(null);
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const fieldLabel = 'block text-[13px] text-[#1E293B] mb-1.5';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 flex items-center justify-between">
          <h2 className="text-[17px] font-bold text-[#1E293B]">导入质检方案</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-[#94A3B8] hover:bg-slate-100 hover:text-[#475569] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-5">
          {/* 第一步：下载模板 */}
          <div>
            <label className={fieldLabel}>第一步 · 下载导入模板</label>
            <div className="flex items-center gap-3 p-4 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl">
              <FileSpreadsheet className="w-8 h-8 text-[#2B5AED] shrink-0" />
              <div className="flex-1 text-[13px] text-[#475569] leading-5">
                模板含「方案导入 / 填写说明 / 物料参照」三页：按表头逐行填写检验项目，
                同一方案的多行保持方案级字段一致；检验项目从预置清单里选（填编码或项目名均可），
                标准值填数值口径（如 36±0.5）即可自动判定。
              </div>
              <button
                type="button"
                onClick={() => void handleDownloadTemplate()}
                disabled={templateLoading}
                className="h-9 shrink-0 flex items-center gap-1.5 px-4 bg-white border border-[#E2E8F0] rounded-lg text-[13px] font-medium text-[#1E293B] hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                {templateLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                <span>{templateLoading ? '生成中…' : '下载模板'}</span>
              </button>
            </div>
          </div>

          {/* 第二步：选择文件 */}
          <div>
            <label className={fieldLabel}>第二步 · 选择填写好的 .xlsx 或 .pdf 文件</label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.pdf"
              onChange={handleFileChange}
              className="hidden"
            />
            {file === null ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full h-24 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-[#E2E8F0] rounded-xl text-[#94A3B8] hover:border-[#2B5AED] hover:text-[#2B5AED] transition-colors"
              >
                <FileUp className="w-6 h-6" />
                <span className="text-[13px]">点击选择 .xlsx 或 .pdf 文件（不超过 10MB）</span>
                <span className="text-[11px] text-[#CBD5E1]">
                  PDF 需为模板另存 / 打印出来的表格型 PDF（扫描件无法识别）
                </span>
              </button>
            ) : (
              <div className="flex items-center gap-3 p-4 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl">
                <FileSpreadsheet className="w-8 h-8 text-[#10B981] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-medium text-[#1E293B] truncate">{file.name}</div>
                  <div className="text-[12px] text-[#94A3B8]">{formatFileSize(file.size)}</div>
                </div>
                <button
                  type="button"
                  onClick={handleClearFile}
                  className="p-1.5 rounded-lg text-[#94A3B8] hover:bg-slate-100 hover:text-[#475569] transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* 错误提示 */}
          {error !== '' && (
            <div className="flex items-start gap-2 p-3.5 bg-rose-50 border border-rose-100 rounded-xl text-[13px] text-rose-600">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="leading-5">{error}</span>
            </div>
          )}

          {/* 导入结果 */}
          {result !== null && (
            <div className="border border-[#E2E8F0] rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-[#F5F7FA] border-b border-[#E2E8F0] text-[13px] text-[#475569]">
                共解析 {result.totalRows} 行数据、聚合 {result.planCount} 个方案：
                <span className="text-[#10B981] font-medium">新建 {result.created.length}</span>
                <span className="mx-1">·</span>
                <span className="text-[#F59E0B] font-medium">重复跳过 {result.skipped.length}</span>
                <span className="mx-1">·</span>
                <span className="text-rose-500 font-medium">失败 {result.failed.length}</span>
              </div>
              <div className="max-h-64 overflow-y-auto divide-y divide-slate-100 text-[13px]">
                {result.created.map((item) => (
                  <div key={item.planCode} className="px-4 py-3 flex items-start gap-2.5">
                    <CheckCircle2 className="w-4 h-4 mt-0.5 text-[#10B981] shrink-0" />
                    <div className="leading-5">
                      <span className="font-medium text-[#1E293B]">{item.planName}</span>
                      <span className="text-[#64748B]">
                        （{item.planCode} · {item.versionNo} · {item.itemCount} 项指标 · 已启用）
                      </span>
                      <div className="text-[12px] text-[#94A3B8]">Excel 行：{item.rows.join('、')}</div>
                    </div>
                  </div>
                ))}
                {result.skipped.map((item, index) => (
                  <div key={`${item.existingPlanCode}-${index}`} className="px-4 py-3 flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 mt-0.5 text-[#F59E0B] shrink-0" />
                    <div className="leading-5">
                      <span className="font-medium text-[#1E293B]">{item.planName}</span>
                      <span className="text-[#64748B]">
                        （方案库已存在同名方案 {item.existingPlanCode}，已跳过防止重复导入）
                      </span>
                      <div className="text-[12px] text-[#94A3B8]">Excel 行：{item.rows.join('、')}</div>
                    </div>
                  </div>
                ))}
                {result.failed.map((item, index) => (
                  <div key={`${item.planName}-${index}`} className="px-4 py-3 flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 mt-0.5 text-rose-500 shrink-0" />
                    <div className="leading-5">
                      <span className="font-medium text-[#1E293B]">{item.planName}</span>
                      <span className="text-rose-600">（{item.reason}）</span>
                      <div className="text-[12px] text-[#94A3B8]">Excel 行：{item.rows.join('、')}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#F1F5F9] flex items-center justify-end gap-3">
          {result === null ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="h-10 px-5 bg-white border border-[#E2E8F0] rounded-lg text-[14px] text-[#475569] hover:bg-slate-50 transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleImport()}
                disabled={file === null || importing}
                className="h-10 px-5 flex items-center gap-1.5 bg-[#2B5AED] hover:bg-[#2450D4] text-white rounded-lg text-[14px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importing && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>{importing ? '导入中…' : '开始导入'}</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleImportAnother}
                className="h-10 px-5 bg-white border border-[#E2E8F0] rounded-lg text-[14px] text-[#475569] hover:bg-slate-50 transition-colors"
              >
                继续导入其它文件
              </button>
              <button
                type="button"
                onClick={onClose}
                className="h-10 px-5 bg-[#2B5AED] hover:bg-[#2450D4] text-white rounded-lg text-[14px] font-medium transition-colors"
              >
                完成
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
