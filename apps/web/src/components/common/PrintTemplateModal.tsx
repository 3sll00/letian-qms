import React, { useState, useEffect } from 'react';
import {
  Printer,
  FileDown,
  X,
  FileSpreadsheet,
  FileText,
  Layers,
  Eye,
  Settings2,
} from 'lucide-react';
import { api } from '../../lib/api';

export interface QualityTemplate {
  id: string;
  templateCode: string;
  templateName: string;
  scope?: string;
  isDefault?: boolean;
  enabledSections?: string[];
}

export interface PrintTemplateModalProps {
  open: boolean;
  onClose: () => void;
  orderId?: string;
  orderNo?: string;
  inspectionType?: string;
  initialData?: any;
}

const DEFAULT_TEMPLATES: QualityTemplate[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    templateCode: 'TPL_GENERAL_STD',
    templateName: '标准通用四段式出货质量证明书 (A4 纵向)',
    scope: 'STANDARD',
    isDefault: true,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    templateCode: 'TPL_COA_RAW',
    templateName: '供应商原材料入库 COA 检验报告 (A4 纵向)',
    scope: 'SUPPLIER_COA',
    isDefault: false,
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    templateCode: 'TPL_CRITICAL_PART',
    templateName: '关键安全件深度质量追溯报告 (A3 横向)',
    scope: 'CRITICAL_PART',
    isDefault: false,
  },
];

export const PrintTemplateModal: React.FC<PrintTemplateModalProps> = ({
  open,
  onClose,
  orderId,
  orderNo = 'OQC-20260706-0001',
  initialData,
}) => {
  const [templates, setTemplates] = useState<QualityTemplate[]>(DEFAULT_TEMPLATES);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    DEFAULT_TEMPLATES[0].id
  );
  const [selectedSections, setSelectedSections] = useState<string[]>([
    'APPEARANCE',
    'DIMENSION',
    'MECHANICAL_PERFORMANCE',
    'CHEMICAL_COMPOSITION',
  ]);
  const [exportFormat, setExportFormat] = useState<'PDF' | 'EXCEL'>('PDF');
  const [, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const loadTemplates = async () => {
      try {
        setLoading(true);
        const res = await api.get<{ items: QualityTemplate[] }>('/report-templates');
        if (res && res.items && res.items.length > 0) {
          setTemplates(res.items);
          const defaultTmpl = res.items.find((t) => t.isDefault) || res.items[0];
          setSelectedTemplateId(defaultTmpl.id);
        }
      } catch (e) {
        // Fallback to presets
      } finally {
        setLoading(false);
      }
    };
    loadTemplates();
  }, [open]);

  if (!open) return null;

  const currentTemplate =
    templates.find((t) => t.id === selectedTemplateId) || templates[0];

  const toggleSection = (sec: string) => {
    setSelectedSections((prev) =>
      prev.includes(sec) ? prev.filter((s) => s !== sec) : [...prev, sec]
    );
  };

  const handleExport = async () => {
    try {
      setExporting(true);
      const blob = await api.postBlob('/reports/export', {
        orderId,
        orderNo,
        templateId: selectedTemplateId,
        sections: selectedSections,
        format: exportFormat,
      });

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `QualityReport-${orderNo}.${exportFormat.toLowerCase() === 'pdf' ? 'pdf' : 'xlsx'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (e) {
      alert('导出质检报告失败，请重试');
    } finally {
      setExporting(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* 弹窗头部 */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-blue-100 text-blue-700 rounded-xl">
              <Printer className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-800 flex items-center gap-2">
                打印与导出质检报告
                <span className="text-xs font-normal text-slate-400">
                  (检验单: {orderNo})
                </span>
              </h3>
              <p className="text-xs text-slate-500">
                支持自由切换多套打印模板，并根据客户要求按四段式组合或分段出具报告
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 弹窗主体：左侧配置，右侧实时预览 */}
        <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 md:grid-cols-12 gap-6">
          {/* 左侧控制面板 */}
          <div className="md:col-span-5 space-y-5">
            {/* 1. 模板选择 */}
            <div className="space-y-2.5">
              <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                <Settings2 className="w-4 h-4 text-blue-600" />
                1. 选择打印与导出模板
              </label>
              <div className="space-y-2">
                {templates.map((tmpl) => {
                  const isSelected = tmpl.id === selectedTemplateId;
                  return (
                    <div
                      key={tmpl.id}
                      onClick={() => setSelectedTemplateId(tmpl.id)}
                      className={`p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                        isSelected
                          ? 'border-blue-500 bg-blue-50/60 shadow-sm ring-1 ring-blue-500/30'
                          : 'border-slate-200 hover:border-slate-300 bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-800">
                          {tmpl.templateName}
                        </span>
                        {isSelected && (
                          <span className="w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center text-[10px]">
                            ✓
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 text-[11px] text-slate-500">
                        <span className="bg-slate-100 px-1.5 py-0.5 rounded font-mono">
                          {tmpl.templateCode}
                        </span>
                        <span>{tmpl.scope === 'STANDARD' ? '通用标准' : tmpl.scope === 'SUPPLIER_COA' ? '原材料COA' : '关键追溯件'}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 2. 四段式打印分段勾选 */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <Layers className="w-4 h-4 text-amber-500" />
                  2. 四段式打印分段选择
                </label>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedSections([
                        'APPEARANCE',
                        'DIMENSION',
                        'MECHANICAL_PERFORMANCE',
                        'CHEMICAL_COMPOSITION',
                      ])
                    }
                    className="text-blue-600 hover:underline"
                  >
                    四段全选
                  </button>
                  <span className="text-slate-300">|</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedSections(['APPEARANCE', 'DIMENSION'])
                    }
                    className="text-slate-500 hover:underline"
                  >
                    仅外观+尺寸
                  </button>
                  <span className="text-slate-300">|</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedSections([
                        'MECHANICAL_PERFORMANCE',
                        'CHEMICAL_COMPOSITION',
                      ])
                    }
                    className="text-slate-500 hover:underline"
                  >
                    仅力学+化学
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                {[
                  { key: 'APPEARANCE', label: '一、外观质量检验', color: 'blue' },
                  { key: 'DIMENSION', label: '二、几何尺寸公差', color: 'emerald' },
                  { key: 'MECHANICAL_PERFORMANCE', label: '三、机械力学性能', color: 'purple' },
                  { key: 'CHEMICAL_COMPOSITION', label: '四、材料化学成分', color: 'amber' },
                ].map((sec) => {
                  const checked = selectedSections.includes(sec.key);
                  return (
                    <div
                      key={sec.key}
                      onClick={() => toggleSection(sec.key)}
                      className={`p-2.5 rounded-xl border flex items-center gap-2 cursor-pointer transition-colors ${
                        checked
                          ? 'border-blue-300 bg-blue-50/50 text-blue-900 font-medium'
                          : 'border-slate-200 text-slate-400 bg-slate-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {}}
                        className="rounded text-blue-600 focus:ring-blue-500"
                      />
                      <span>{sec.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 3. 导出文件格式选择 */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-slate-700">
                3. 文件导出格式
              </label>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer text-xs">
                  <input
                    type="radio"
                    name="exportFormat"
                    checked={exportFormat === 'PDF'}
                    onChange={() => setExportFormat('PDF')}
                    className="text-blue-600"
                  />
                  <FileText className="w-4 h-4 text-rose-500" />
                  <span>PDF 文档 (高保真打印)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-xs">
                  <input
                    type="radio"
                    name="exportFormat"
                    checked={exportFormat === 'EXCEL'}
                    onChange={() => setExportFormat('EXCEL')}
                    className="text-emerald-600"
                  />
                  <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
                  <span>Excel 表格 (数据统计)</span>
                </label>
              </div>
            </div>
          </div>

          {/* 右侧实时打印纸张预览区域 */}
          <div className="md:col-span-7 bg-slate-100/70 p-4 rounded-xl border border-slate-200 flex flex-col">
            <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
              <span className="font-semibold flex items-center gap-1">
                <Eye className="w-3.5 h-3.5" />
                排版实时预览 ({currentTemplate.templateName})
              </span>
              <span className="text-[11px] bg-slate-200 px-2 py-0.5 rounded text-slate-600 font-mono">
                A4 (纵向) · 已启用 {selectedSections.length} 个检验段落
              </span>
            </div>

            <div className="flex-1 bg-white p-6 shadow-sm border border-slate-200 rounded-lg text-slate-800 text-xs space-y-4 font-sans overflow-y-auto max-h-[440px]">
              {/* 报告抬头 */}
              <div className="text-center border-b pb-3 border-slate-200">
                <h4 className="text-base font-black tracking-wider text-slate-900">
                  乐天智能制造质检报告 / 检验合格证书
                </h4>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  LETIAN QUALITY CERTIFICATE (EN 10204 3.1)
                </p>
                <div className="flex justify-between items-center text-[11px] text-slate-600 mt-3 pt-2 border-t border-dashed border-slate-200">
                  <span>单号: <strong>{orderNo}</strong></span>
                  <span>批次: <strong>{initialData?.batchNo || 'B2026-0706'}</strong></span>
                  <span>物料: <strong>{initialData?.materialName || '304不锈钢特级棒材'}</strong></span>
                </div>
              </div>

              {/* 段落一：外观质量 */}
              {selectedSections.includes('APPEARANCE') && (
                <div className="border border-slate-200 rounded p-2.5 space-y-1.5 bg-slate-50/50">
                  <div className="font-bold text-slate-800 text-[11px] flex items-center justify-between">
                    <span>一、外观表面质量检验</span>
                    <span className="text-emerald-600 font-semibold">✓ 合格</span>
                  </div>
                  <p className="text-[11px] text-slate-600">
                    表面平整无裂纹、夹渣及氧化皮缺陷，光洁度达到 Ra ≤ 1.6μm 规范要求。
                  </p>
                </div>
              )}

              {/* 段落二：几何尺寸 */}
              {selectedSections.includes('DIMENSION') && (
                <div className="border border-slate-200 rounded p-2.5 space-y-1.5 bg-slate-50/50">
                  <div className="font-bold text-slate-800 text-[11px] flex items-center justify-between">
                    <span>二、几何尺寸与形位公差检验</span>
                    <span className="text-emerald-600 font-semibold">✓ 合格 (全项公差内)</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-600">
                    <div>外径: 25.02 mm (标称 25±0.05)</div>
                    <div>壁厚: 3.01 mm (标称 3.0±0.03)</div>
                    <div>直线度: 0.08 mm/m (≤0.15)</div>
                  </div>
                </div>
              )}

              {/* 段落三：机械性能 */}
              {selectedSections.includes('MECHANICAL_PERFORMANCE') && (
                <div className="border border-slate-200 rounded p-2.5 space-y-1.5 bg-slate-50/50">
                  <div className="font-bold text-slate-800 text-[11px] flex items-center justify-between">
                    <span>三、机械力学性能分析</span>
                    <span className="text-emerald-600 font-semibold">✓ 符合标称</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-600">
                    <div>抗拉强度: 625 MPa (≥520)</div>
                    <div>屈服强度: 310 MPa (≥205)</div>
                    <div>断后伸长率: 42 % (≥35)</div>
                  </div>
                </div>
              )}

              {/* 段落四：化学成分 */}
              {selectedSections.includes('CHEMICAL_COMPOSITION') && (
                <div className="border border-slate-200 rounded p-2.5 space-y-1.5 bg-slate-50/50">
                  <div className="font-bold text-slate-800 text-[11px] flex items-center justify-between">
                    <span>四、材料化学成分光谱分析</span>
                    <span className="text-emerald-600 font-semibold">✓ 材质合规</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-[11px] text-slate-600 font-mono">
                    <div>C: 0.04%</div>
                    <div>Si: 0.55%</div>
                    <div>Mn: 1.42%</div>
                    <div>Cr: 18.25%</div>
                    <div>Ni: 8.12%</div>
                    <div>P: 0.028%</div>
                    <div>S: 0.008%</div>
                    <div>Mo: 0.21%</div>
                  </div>
                </div>
              )}

              {selectedSections.length === 0 && (
                <div className="py-12 text-center text-slate-400 italic">
                  请在左侧勾选至少一个检验段落以预览和出具报告
                </div>
              )}

              {/* 签署印章栏 */}
              <div className="pt-4 border-t border-slate-200 flex justify-between items-center text-[11px] text-slate-500">
                <div>
                  <p>检验专员: 张工 (质检部)</p>
                  <p className="mt-0.5">审核确认: 李主任 (质量保证处)</p>
                </div>
                <div className="text-right">
                  <div className="inline-block border-2 border-dashed border-emerald-500 text-emerald-600 font-bold px-3 py-1 rounded-lg rotate-[-4deg] text-xs">
                    乐天 QMS 质检专用章
                  </div>
                  <p className="mt-1 text-[10px] text-slate-400">
                    签发日期: {new Date().toISOString().slice(0, 10)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 弹窗底部操作条 */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/70 flex items-center justify-between">
          <div className="text-xs text-slate-500">
            提示：点击“立即打印”可调起系统打印机直接出纸；“导出文件”将在后台生成完整归档文件。
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs text-slate-600 hover:text-slate-800 border border-slate-200 hover:bg-slate-100 rounded-xl transition-colors"
            >
              取消 / 关闭
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting || selectedSections.length === 0}
              className="px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-xl flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <FileDown className="w-4 h-4" />
              <span>{exporting ? '生成文件中...' : `导出 ${exportFormat} 报告`}</span>
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={selectedSections.length === 0}
              className="px-5 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl flex items-center gap-1.5 shadow-sm transition-colors disabled:opacity-50"
            >
              <Printer className="w-4 h-4" />
              <span>立即打印质检报告</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
