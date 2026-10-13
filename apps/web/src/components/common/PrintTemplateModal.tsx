import React, { useEffect, useMemo, useState } from 'react';
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
import type {
  QualityReportData,
  QualityReportTemplate,
  ReportItemDecision,
  ReportSection,
} from '@letian/contracts';
import { api, errorMessage } from '../../lib/api';

export type QualityTemplate = QualityReportTemplate & { applicableType?: string };

interface ReportSourceRow {
  seq?: number;
  itemCode?: string;
  title?: string;
  name?: string;
  standard?: string;
  actual?: string;
  unit?: string;
  isExempt?: boolean;
  storedDecision?: ReportItemDecision;
  storedRemark?: string;
  planItem?: {
    itemCode?: string;
    name?: string;
    metricCategory?: string;
    standardText?: string;
    unit?: string;
  };
}

export interface PrintTemplateInitialData {
  productName?: string;
  materialCode?: string;
  materialName?: string;
  materialSpec?: string;
  specification?: string;
  batchNo?: string;
  furnaceHeatNo?: string;
  heatNo?: string;
  supplierName?: string;
  customerName?: string;
  inspectionDate?: string;
  inspectorName?: string;
  approverName?: string;
  appearanceItems?: ReportSourceRow[];
  dimItems?: ReportSourceRow[];
  mechProperties?: ReportSourceRow[];
  chemElements?: ReportSourceRow[];
  [key: string]: unknown;
}

export interface PrintTemplateModalProps {
  open: boolean;
  onClose: () => void;
  orderId?: string;
  orderNo?: string;
  inspectionType?: string;
  initialData?: PrintTemplateInitialData;
}

const ALL_SECTIONS: readonly ReportSection[] = [
  'APPEARANCE',
  'DIMENSION',
  'MECHANICAL_PERFORMANCE',
  'CHEMICAL_COMPOSITION',
];

const SECTION_OPTIONS: ReadonlyArray<{ key: ReportSection; label: string; title: string }> = [
  { key: 'APPEARANCE', label: '一、外观质量检验', title: '一、外观表面质量检验' },
  { key: 'DIMENSION', label: '二、几何尺寸公差', title: '二、几何尺寸与公差检验' },
  { key: 'MECHANICAL_PERFORMANCE', label: '三、机械力学性能', title: '三、机械力学性能检验' },
  { key: 'CHEMICAL_COMPOSITION', label: '四、材料化学成分', title: '四、材料化学成分检验' },
];

const SCOPE_LABEL: Record<string, string> = {
  STANDARD: '通用标准',
  OUTSOURCE: '委外/原材料',
  CUSTOM: '客户定制',
};

const DECISION_LABEL: Record<string, string> = {
  PENDING: '未检',
  PASSED: '合格',
  FAILED: '不合格',
  EXEMPT: '免检',
  CONCESSION: '让步接收',
};

const DECISION_CLASS: Record<string, string> = {
  PENDING: 'bg-slate-100 text-slate-600 border-slate-200',
  PASSED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  FAILED: 'bg-rose-50 text-rose-700 border-rose-200',
  EXEMPT: 'bg-blue-50 text-blue-700 border-blue-200',
  CONCESSION: 'bg-amber-50 text-amber-700 border-amber-200',
};

const INHERITED_SOURCE_LABEL: Record<string, string> = {
  OUTSOURCE_HEAT_TREATMENT: '委外热处理带出',
  IQC_RAW_MATERIAL: '来料检验带出',
  MANUAL_ENTRY: '人工录入',
};

const DEFAULT_TEMPLATES: QualityTemplate[] = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    templateCode: 'TPL-STD-001',
    templateName: '通用紧固件出厂检验标准模板',
    scope: 'STANDARD',
    isDefault: true,
    enabledSections: [...ALL_SECTIONS],
  },
  {
    id: '00000000-0000-0000-0000-000000000002',
    templateCode: 'TPL-AUTO-002',
    templateName: '汽车紧固件PPAP全尺寸检验报告模板',
    scope: 'CUSTOM',
    isDefault: false,
    enabledSections: [...ALL_SECTIONS],
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    templateCode: 'TPL-RAW-003',
    templateName: '原材料进料物理化学综合检验报告模板',
    scope: 'OUTSOURCE',
    isDefault: false,
    enabledSections: [...ALL_SECTIONS],
  },
];

interface PreviewMetric {
  code: string;
  name: string;
  standard: string;
  measured: string;
  unit?: string;
  source?: string;
  conclusion: ReportItemDecision;
}

interface PreviewSection {
  enabled: boolean;
  items: PreviewMetric[];
}

interface PreviewModel {
  source: 'SERVER' | 'LOCAL';
  reportNo: string;
  orderNo: string;
  materialCode: string;
  materialName: string;
  materialSpec?: string;
  batchNo: string;
  furnaceHeatNo?: string;
  supplierName?: string;
  customerName?: string;
  inspectionDate: string;
  inspectorName?: string;
  approverName?: string;
  overallDecision: string;
  sections: Record<ReportSection, PreviewSection>;
}

function text(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

function numberText(value: number | undefined): string {
  return value === undefined ? '—' : String(value);
}

function measuredNumberText(value: number | undefined): string {
  return value === undefined ? '未检' : String(value);
}

function decisionLabel(value: string): string {
  return DECISION_LABEL[value] ?? value;
}

function dimensionStandard(
  nominalValue: number | undefined,
  lowerTolerance: number | undefined,
  upperTolerance: number | undefined
): string {
  if (nominalValue === undefined && lowerTolerance === undefined && upperTolerance === undefined) {
    return '—';
  }
  if (upperTolerance !== undefined && lowerTolerance !== undefined) {
    return upperTolerance === lowerTolerance
      ? `${numberText(nominalValue)} ± ${upperTolerance}`
      : `${numberText(nominalValue)} (+${upperTolerance} / -${lowerTolerance})`;
  }
  if (upperTolerance !== undefined) return `≤ ${numberText(nominalValue)}+${upperTolerance}`;
  if (lowerTolerance !== undefined) return `≥ ${numberText(nominalValue)}-${lowerTolerance}`;
  return numberText(nominalValue);
}

function chemicalStandard(
  standardText: string | undefined,
  standardMin: number | undefined,
  standardMax: number | undefined
): string {
  if (standardText !== undefined && standardText.trim() !== '') return standardText;
  if (standardMin !== undefined || standardMax !== undefined) {
    return `${numberText(standardMin)} ~ ${numberText(standardMax)}`;
  }
  return '—';
}

function emptySections(): Record<ReportSection, PreviewSection> {
  return {
    APPEARANCE: { enabled: false, items: [] },
    DIMENSION: { enabled: false, items: [] },
    MECHANICAL_PERFORMANCE: { enabled: false, items: [] },
    CHEMICAL_COMPOSITION: { enabled: false, items: [] },
  };
}

function previewModelFromServer(data: QualityReportData): PreviewModel {
  const sections = emptySections();
  sections.APPEARANCE = {
    enabled: data.appearanceSection.enabled,
    items: data.appearanceSection.items.map((item) => ({
      code: item.itemCode,
      name: item.name,
      standard: item.standardText,
      measured: item.measuredResult,
      conclusion: item.conclusion,
    })),
  };
  sections.DIMENSION = {
    enabled: data.dimensionSection.enabled,
    items: data.dimensionSection.items.map((item) => ({
      code: item.itemCode,
      name: item.name,
      standard: dimensionStandard(item.nominalValue, item.lowerTolerance, item.upperTolerance),
      measured: measuredNumberText(item.measuredVal),
      ...(item.unit !== undefined ? { unit: item.unit } : {}),
      conclusion: item.conclusion,
    })),
  };
  sections.MECHANICAL_PERFORMANCE = {
    enabled: data.mechanicalSection.enabled,
    items: data.mechanicalSection.items.map((item) => ({
      code: item.itemCode,
      name: item.name,
      standard: item.standardRequirement,
      measured: measuredNumberText(item.measuredVal),
      ...(item.unit !== undefined ? { unit: item.unit } : {}),
      ...(item.inheritedFrom !== undefined
        ? { source: INHERITED_SOURCE_LABEL[item.inheritedFrom] ?? item.inheritedFrom }
        : {}),
      conclusion: item.conclusion,
    })),
  };
  sections.CHEMICAL_COMPOSITION = {
    enabled: data.chemicalSection.enabled,
    items: data.chemicalSection.elements.map((item) => ({
      code: item.element,
      name: item.elementName,
      standard: chemicalStandard(item.standardText, item.standardMin, item.standardMax),
      measured: measuredNumberText(item.measuredVal),
      unit: '%',
      conclusion: item.conclusion,
    })),
  };

  return {
    source: 'SERVER',
    reportNo: data.reportNo,
    orderNo: data.orderNo,
    materialCode: data.materialCode,
    materialName: data.materialName,
    ...(data.materialSpec !== undefined ? { materialSpec: data.materialSpec } : {}),
    batchNo: data.batchNo,
    ...(data.furnaceHeatNo !== undefined ? { furnaceHeatNo: data.furnaceHeatNo } : {}),
    ...(data.supplierName !== undefined ? { supplierName: data.supplierName } : {}),
    ...(data.customerName !== undefined ? { customerName: data.customerName } : {}),
    inspectionDate: data.inspectionDate,
    ...(data.inspectorName !== undefined ? { inspectorName: data.inspectorName } : {}),
    overallDecision: data.overallDecision,
    sections,
  };
}

function rowsOf(data: PrintTemplateInitialData | undefined, key: keyof PrintTemplateInitialData): ReportSourceRow[] {
  const value = data?.[key];
  return Array.isArray(value) ? (value as ReportSourceRow[]) : [];
}

function metricCategoryOf(row: ReportSourceRow): string {
  return row.planItem?.metricCategory ?? '';
}

function fallbackDecision(row: ReportSourceRow): ReportItemDecision {
  if (
    row.storedDecision === 'PENDING' ||
    row.storedDecision === 'PASSED' ||
    row.storedDecision === 'FAILED' ||
    row.storedDecision === 'EXEMPT'
  ) {
    return row.storedDecision;
  }
  return row.isExempt === true ? 'EXEMPT' : 'PENDING';
}

function fallbackMetric(row: ReportSourceRow): PreviewMetric {
  const actual = row.actual?.trim();
  const code = row.itemCode ?? row.planItem?.itemCode ?? row.title ?? row.name ?? '—';
  return {
    code,
    name: row.name ?? row.planItem?.name ?? row.title ?? code,
    standard: row.standard?.trim() || row.planItem?.standardText?.trim() || '—',
    measured: actual !== undefined && actual !== '' && actual !== '-' ? actual : '未检',
    ...(row.unit !== undefined && row.unit !== ''
      ? { unit: row.unit }
      : row.planItem?.unit !== undefined && row.planItem.unit !== ''
        ? { unit: row.planItem.unit }
        : {}),
    conclusion: fallbackDecision(row),
  };
}

function previewModelFromInitialData(
  data: PrintTemplateInitialData | undefined,
  orderNo: string | undefined
): PreviewModel {
  const dimensionRows = rowsOf(data, 'dimItems');
  const appearanceRows = [
    ...rowsOf(data, 'appearanceItems'),
    ...dimensionRows.filter((row) => metricCategoryOf(row) === 'APPEARANCE'),
  ];
  const pureDimensionRows = dimensionRows.filter(
    (row) => metricCategoryOf(row) !== 'APPEARANCE'
  );

  const sections = emptySections();
  sections.APPEARANCE = { enabled: true, items: appearanceRows.map(fallbackMetric) };
  sections.DIMENSION = { enabled: true, items: pureDimensionRows.map(fallbackMetric) };
  sections.MECHANICAL_PERFORMANCE = {
    enabled: true,
    items: rowsOf(data, 'mechProperties').map(fallbackMetric),
  };
  sections.CHEMICAL_COMPOSITION = {
    enabled: true,
    items: rowsOf(data, 'chemElements').map(fallbackMetric),
  };

  return {
    source: 'LOCAL',
    reportNo: '—',
    orderNo: orderNo?.trim() || '未绑定检验单',
    materialCode: text(data?.materialCode),
    materialName: text(data?.materialName ?? data?.productName),
    ...(data?.materialSpec !== undefined || data?.specification !== undefined
      ? { materialSpec: text(data?.materialSpec ?? data?.specification) }
      : {}),
    batchNo: text(data?.batchNo),
    ...(data?.furnaceHeatNo !== undefined || data?.heatNo !== undefined
      ? { furnaceHeatNo: text(data?.furnaceHeatNo ?? data?.heatNo) }
      : {}),
    ...(data?.supplierName !== undefined ? { supplierName: text(data.supplierName) } : {}),
    ...(data?.customerName !== undefined ? { customerName: text(data.customerName) } : {}),
    inspectionDate: data?.inspectionDate?.trim() || '—',
    ...(data?.inspectorName !== undefined ? { inspectorName: text(data.inspectorName) } : {}),
    ...(data?.approverName !== undefined ? { approverName: text(data.approverName) } : {}),
    overallDecision: 'PENDING',
    sections,
  };
}

const DecisionBadge: React.FC<{ decision: string }> = ({ decision }) => (
  <span
    className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
      DECISION_CLASS[decision] ?? 'bg-slate-100 text-slate-600 border-slate-200'
    }`}
  >
    {decisionLabel(decision)}
  </span>
);

function PreviewTable({
  headers,
  rows,
  cells,
  empty,
}: {
  headers: string[];
  rows: PreviewMetric[];
  cells: (row: PreviewMetric) => React.ReactNode[];
  empty: string;
}): React.ReactElement {
  if (rows.length === 0) {
    return <p className="text-[11px] text-slate-400 italic">{empty}</p>;
  }
  return (
    <table className="w-full border-collapse text-[10px]">
      <thead>
        <tr>
          {headers.map((header) => (
            <th key={header} className="border border-slate-300 bg-slate-100 px-1.5 py-1 text-left font-semibold">
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.code}-${index}`}>
            {cells(row).map((cell, cellIndex) => (
              <td key={cellIndex} className="border border-slate-300 px-1.5 py-1 align-top">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const InfoItem: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="min-w-0">
    <span className="text-slate-400">{label}：</span>
    <span className="font-medium text-slate-700 break-all">{value}</span>
  </div>
);

const SectionCard: React.FC<{ title: string; count: number; children: React.ReactNode }> = ({
  title,
  count,
  children,
}) => (
  <section className="border border-slate-200 rounded p-2.5 space-y-2 bg-slate-50/50 break-inside-avoid">
    <div className="font-bold text-slate-800 text-[11px] flex items-center justify-between">
      <span>{title}</span>
      <span className="text-[10px] text-slate-400 font-normal">{count} 项</span>
    </div>
    {children}
  </section>
);

export const PrintTemplateModal: React.FC<PrintTemplateModalProps> = ({
  open,
  onClose,
  orderId,
  orderNo,
  initialData,
}) => {
  const [templates, setTemplates] = useState<QualityTemplate[]>(DEFAULT_TEMPLATES);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(DEFAULT_TEMPLATES[0].id);
  const [selectedSections, setSelectedSections] = useState<ReportSection[]>([...ALL_SECTIONS]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateLoadError, setTemplateLoadError] = useState('');
  const [reportData, setReportData] = useState<QualityReportData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [activeTab, setActiveTab] = useState<'print' | 'export'>('print');
  const [printOrientation, setPrintOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [printIncludeSignature, setPrintIncludeSignature] = useState(true);
  const [exportFormat, setExportFormat] = useState<'PDF' | 'EXCEL'>('PDF');
  const [exporting, setExporting] = useState(false);

  const hasOrderIdentity = Boolean(
    (orderId !== undefined && orderId.trim() !== '') ||
      (orderNo !== undefined && orderNo.trim() !== '')
  );

  useEffect(() => {
    if (!open) return;
    const loadTemplates = async () => {
      try {
        setTemplatesLoading(true);
        setTemplateLoadError('');
        const res = await api.get<{ items: QualityTemplate[] }>('/report-templates');
        if (res.items.length > 0) {
          setTemplates(res.items);
          const defaultTemplate = res.items.find((item) => item.isDefault) ?? res.items[0];
          setSelectedTemplateId(defaultTemplate.id);
        }
      } catch (error) {
        setTemplateLoadError(errorMessage(error));
      } finally {
        setTemplatesLoading(false);
      }
    };
    void loadTemplates();
  }, [open]);

  const currentTemplate =
    templates.find((template) => template.id === selectedTemplateId) ?? templates[0];
  const allowedSections = useMemo(
    () => new Set<ReportSection>(currentTemplate.enabledSections ?? [...ALL_SECTIONS]),
    [currentTemplate]
  );

  useEffect(() => {
    setSelectedSections((previous) => {
      const kept = previous.filter((section) => allowedSections.has(section));
      return kept.length > 0 ? kept : Array.from(allowedSections);
    });
  }, [allowedSections]);

  useEffect(() => {
    if (!open) {
      setReportData(null);
      setPreviewError('');
      setPreviewLoading(false);
      return;
    }
    if (!hasOrderIdentity) {
      setReportData(null);
      setPreviewError('');
      setPreviewLoading(false);
      return;
    }

    let cancelled = false;
    const loadPreview = async () => {
      try {
        setPreviewLoading(true);
        setPreviewError('');
        const res = await api.post<{ success: boolean; reportData: QualityReportData }>(
          '/reports/export',
          {
            ...(orderId !== undefined && orderId.trim() !== ''
              ? { orderId }
              : orderNo !== undefined && orderNo.trim() !== ''
                ? { orderNo }
                : {}),
            templateId: selectedTemplateId,
            sections: [...ALL_SECTIONS],
            format: 'JSON',
          }
        );
        if (!cancelled) setReportData(res.reportData);
      } catch (error) {
        if (!cancelled) {
          setReportData(null);
          setPreviewError(errorMessage(error));
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    };
    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [open, hasOrderIdentity, orderId, orderNo, selectedTemplateId]);

  const previewModel = useMemo(
    () =>
      reportData !== null
        ? previewModelFromServer(reportData)
        : previewModelFromInitialData(initialData, orderNo),
    [reportData, initialData, orderNo]
  );

  const toggleSection = (section: ReportSection) => {
    if (!allowedSections.has(section)) return;
    setSelectedSections((previous) =>
      previous.includes(section)
        ? previous.filter((item) => item !== section)
        : [...previous, section]
    );
  };

  const sectionVisible = (section: ReportSection) =>
    selectedSections.includes(section) && previewModel.sections[section].enabled;

  const handleExport = async () => {
    if (!hasOrderIdentity) {
      alert('当前报告未绑定检验单，无法由服务端生成 PDF/Excel。');
      return;
    }
    try {
      setExporting(true);
      const blob = await api.postBlob('/reports/export', {
        ...(orderId !== undefined && orderId.trim() !== ''
          ? { orderId }
          : orderNo !== undefined && orderNo.trim() !== ''
            ? { orderNo }
            : {}),
        templateId: selectedTemplateId,
        sections: selectedSections,
        format: exportFormat,
      });

      const extension = exportFormat === 'PDF' ? 'pdf' : 'xlsx';
      const stem = (reportData?.reportNo ?? orderNo ?? orderId ?? 'quality-report').replace(
        /[\\/:*?"<>|\s]+/g,
        '_'
      );
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${stem}.${extension}`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      alert(`导出质检报告失败：${errorMessage(error)}`);
    } finally {
      setExporting(false);
    }
  };

  // 打印：仅输出报告纸张区域（隐藏弹窗外框/遮罩），并按所选方向设置页面
  const handlePrint = () => {
    document.body.classList.add('lt-print-report-mode');
    const cleanup = () => {
      document.body.classList.remove('lt-print-report-mode');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
  };

  if (!open) return null;

  const showSignature = !(activeTab === 'print' && !printIncludeSignature);
  const appearanceRows = previewModel.sections.APPEARANCE.items;
  const dimensionRows = previewModel.sections.DIMENSION.items;
  const mechanicalRows = previewModel.sections.MECHANICAL_PERFORMANCE.items;
  const chemicalRows = previewModel.sections.CHEMICAL_COMPOSITION.items;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
      {/* 打印专用样式：仅打印报告内容本身，不打印弹窗与遮罩 */}
      <style>{`
        @media print {
          body.lt-print-report-mode * { visibility: hidden !important; }
          body.lt-print-report-mode .lt-print-report,
          body.lt-print-report-mode .lt-print-report * { visibility: visible !important; }
          body.lt-print-report-mode .lt-print-report {
            position: absolute !important; left: 0 !important; top: 0 !important;
            width: 100% !important; padding: 0 !important; margin: 0 !important;
            box-shadow: none !important; border: none !important; background: #fff !important;
            max-height: none !important; overflow: visible !important;
          }
          @page { size: A4 ${printOrientation}; margin: 12mm; }
        }
      `}</style>
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* 弹窗头部 */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-blue-100 text-blue-700 rounded-xl">
              <Printer className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-800 flex items-center gap-2">
                质检报告 · 打印与导出
                <span className="text-xs font-normal text-slate-400">
                  (检验单: {orderNo || '未绑定'})
                </span>
              </h3>
              <p className="text-xs text-slate-500">
                支持动态模板、四段式组合预览、浏览器打印与 PDF/Excel 服务端导出
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
          <div className="md:col-span-5 space-y-5">
            <div className="space-y-2.5">
              <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                <Settings2 className="w-4 h-4 text-blue-600" />
                1. 选择报告模板
              </label>
              {templatesLoading && (
                <div className="text-[11px] text-slate-400">正在加载服务端模板...</div>
              )}
              {templateLoadError !== '' && (
                <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                  模板列表读取失败，当前显示本地兜底模板：{templateLoadError}
                </div>
              )}
              <div className="space-y-2">
                {templates.map((template) => {
                  const isSelected = template.id === selectedTemplateId;
                  return (
                    <div
                      key={template.id}
                      onClick={() => setSelectedTemplateId(template.id)}
                      className={`p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                        isSelected
                          ? 'border-blue-500 bg-blue-50/60 shadow-sm ring-1 ring-blue-500/30'
                          : 'border-slate-200 hover:border-slate-300 bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-800">
                          {template.templateName}
                        </span>
                        {isSelected && (
                          <span className="w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center text-[10px]">
                            ✓
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 text-[11px] text-slate-500">
                        <span className="bg-slate-100 px-1.5 py-0.5 rounded font-mono">
                          {template.templateCode}
                        </span>
                        <span>{SCOPE_LABEL[template.scope] ?? template.scope}</span>
                        {template.isDefault === true && <span className="text-blue-600">默认</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 四段式分段勾选（打印与导出共用） */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <Layers className="w-4 h-4 text-amber-500" />
                  2. 四段式分段选择
                </label>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setSelectedSections(Array.from(allowedSections))}
                    className="text-blue-600 hover:underline"
                  >
                    模板分段全选
                  </button>
                  <span className="text-slate-300">|</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedSections(
                        (['APPEARANCE', 'DIMENSION'] as ReportSection[]).filter((section) =>
                          allowedSections.has(section)
                        )
                      )
                    }
                    className="text-slate-500 hover:underline"
                  >
                    仅外观+尺寸
                  </button>
                  <span className="text-slate-300">|</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedSections(
                        (['MECHANICAL_PERFORMANCE', 'CHEMICAL_COMPOSITION'] as ReportSection[]).filter(
                          (section) => allowedSections.has(section)
                        )
                      )
                    }
                    className="text-slate-500 hover:underline"
                  >
                    仅力学+化学
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                {SECTION_OPTIONS.map((section) => {
                  const checked = selectedSections.includes(section.key);
                  const enabled = allowedSections.has(section.key);
                  return (
                    <div
                      key={section.key}
                      onClick={() => toggleSection(section.key)}
                      className={`p-2.5 rounded-xl border flex items-center gap-2 transition-colors ${
                        !enabled
                          ? 'border-slate-200 text-slate-300 bg-slate-50 cursor-not-allowed'
                          : checked
                            ? 'border-blue-300 bg-blue-50/50 text-blue-900 font-medium cursor-pointer'
                            : 'border-slate-200 text-slate-400 bg-slate-50 cursor-pointer'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!enabled}
                        onChange={() => {}}
                        className="rounded text-blue-600 focus:ring-blue-500 disabled:opacity-40"
                      />
                      <span>{section.label}{!enabled && '（模板未启用）'}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Tab 切换：打印 / 导出 */}
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl">
              <button
                type="button"
                onClick={() => setActiveTab('print')}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors ${
                  activeTab === 'print'
                    ? 'bg-white text-blue-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <Printer className="w-4 h-4" /> 打印
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('export')}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors ${
                  activeTab === 'export'
                    ? 'bg-white text-blue-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <FileDown className="w-4 h-4" /> 导出
              </button>
            </div>

            {activeTab === 'print' && (
              <div className="space-y-3 p-3 rounded-xl border border-blue-100 bg-blue-50/30">
                <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <Printer className="w-4 h-4 text-blue-600" />
                  3. 打印设置
                </label>
                <div className="space-y-1.5">
                  <div className="text-[11px] text-slate-500">纸张方向</div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 cursor-pointer text-xs">
                      <input
                        type="radio"
                        name="printOrientation"
                        checked={printOrientation === 'portrait'}
                        onChange={() => setPrintOrientation('portrait')}
                        className="text-blue-600"
                      />
                      <span>纵向 (A4)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-xs">
                      <input
                        type="radio"
                        name="printOrientation"
                        checked={printOrientation === 'landscape'}
                        onChange={() => setPrintOrientation('landscape')}
                        className="text-blue-600"
                      />
                      <span>横向 (A4)</span>
                    </label>
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={printIncludeSignature}
                    onChange={(event) => setPrintIncludeSignature(event.target.checked)}
                    className="rounded text-blue-600"
                  />
                  打印时包含签署与质检专用章
                </label>
                <button
                  type="button"
                  onClick={handlePrint}
                  disabled={previewLoading || selectedSections.length === 0}
                  className="w-full px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl flex items-center justify-center gap-1.5 shadow-sm transition-colors disabled:opacity-50"
                >
                  <Printer className="w-4 h-4" />
                  <span>{previewLoading ? '正在组装预览...' : '立即打印质检报告'}</span>
                </button>
              </div>
            )}

            {activeTab === 'export' && (
              <div className="space-y-3 p-3 rounded-xl border border-emerald-100 bg-emerald-50/30">
                <label className="text-xs font-bold text-slate-700">3. 文件导出格式</label>
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
                {!hasOrderIdentity && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                    未绑定检验单：可预览页面已有数据，但不能由服务端生成 PDF/Excel。
                  </p>
                )}
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={exporting || !hasOrderIdentity || selectedSections.length === 0}
                  className="w-full px-4 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded-xl flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
                >
                  <FileDown className="w-4 h-4" />
                  <span>{exporting ? '生成文件中...' : `导出 ${exportFormat} 报告`}</span>
                </button>
              </div>
            )}
          </div>

          {/* 右侧实时排版预览：真实检验单 JSON 与导出接口共用同一份后端数据 */}
          <div className="md:col-span-7 bg-slate-100/70 p-4 rounded-xl border border-slate-200 flex flex-col">
            <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
              <span className="font-semibold flex items-center gap-1">
                <Eye className="w-3.5 h-3.5" />
                排版实时预览 ({currentTemplate.templateName})
              </span>
              <span className="text-[11px] bg-slate-200 px-2 py-0.5 rounded text-slate-600 font-mono">
                {activeTab === 'print'
                  ? `A4 (${printOrientation === 'landscape' ? '横向' : '纵向'}) · 已启用 ${selectedSections.length} 段`
                  : `A4 · 导出 ${exportFormat} · 已启用 ${selectedSections.length} 段`}
              </span>
            </div>

            <div className="lt-print-report flex-1 bg-white p-6 shadow-sm border border-slate-200 rounded-lg text-slate-800 text-xs space-y-4 font-sans overflow-y-auto max-h-[520px]">
              {previewLoading && (
                <div className="text-[11px] text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-2 py-1.5">
                  正在按持久化检验单组装四段式预览...
                </div>
              )}
              {!previewLoading && previewError !== '' && (
                <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                  服务端预览不可用，当前仅展示页面已有数据：{previewError}
                </div>
              )}
              {!previewLoading && previewError === '' && !hasOrderIdentity && (
                <div className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5">
                  未绑定检验单，当前仅展示页面已有数据。
                </div>
              )}
              {!previewLoading && previewError === '' && previewModel.source === 'SERVER' && (
                <div className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2 py-1.5">
                  数据源：持久化检验单（与 PDF/Excel 导出同一份四段式数据）。
                </div>
              )}

              {/* 报告抬头 */}
              <div className="text-center border-b pb-3 border-slate-200">
                <h4 className="text-base font-black tracking-wider text-slate-900">
                  乐天智能制造质检报告 / 检验合格证书
                </h4>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  LETIAN QUALITY CERTIFICATE (EN 10204 3.1)
                </p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-left text-[11px] text-slate-600 mt-3 pt-2 border-t border-dashed border-slate-200">
                  <InfoItem label="报告编号" value={previewModel.reportNo} />
                  <InfoItem label="检验单号" value={previewModel.orderNo} />
                  <InfoItem label="报告模板" value={currentTemplate.templateName} />
                  <InfoItem label="物料" value={`${previewModel.materialCode} / ${previewModel.materialName}`} />
                  <InfoItem label="规格型号" value={previewModel.materialSpec} />
                  <InfoItem label="批次号" value={previewModel.batchNo} />
                  <InfoItem label="炉批号" value={previewModel.furnaceHeatNo} />
                  <InfoItem label="供应商" value={previewModel.supplierName} />
                  <InfoItem label="客户" value={previewModel.customerName} />
                  <InfoItem label="检验日期" value={previewModel.inspectionDate} />
                  <InfoItem label="检验人员" value={previewModel.inspectorName} />
                  <InfoItem label="综合判定" value={<DecisionBadge decision={previewModel.overallDecision} />} />
                </div>
              </div>

              {sectionVisible('APPEARANCE') && (
                <SectionCard title="一、外观表面质量检验" count={appearanceRows.length}>
                  <PreviewTable
                    headers={['项目编码', '项目名称', '标准要求', '实测结果', '判定']}
                    rows={appearanceRows}
                    cells={(row) => [
                      row.code,
                      row.name,
                      row.standard,
                      row.measured,
                      <DecisionBadge key="decision" decision={row.conclusion} />,
                    ]}
                    empty="当前检验单在该分段无指标项"
                  />
                </SectionCard>
              )}

              {sectionVisible('DIMENSION') && (
                <SectionCard title="二、几何尺寸与公差检验" count={dimensionRows.length}>
                  <PreviewTable
                    headers={['项目编码', '项目名称', '标准要求', '实测值', '单位', '判定']}
                    rows={dimensionRows}
                    cells={(row) => [
                      row.code,
                      row.name,
                      row.standard,
                      row.measured,
                      row.unit,
                      <DecisionBadge key="decision" decision={row.conclusion} />,
                    ]}
                    empty="当前检验单在该分段无指标项"
                  />
                </SectionCard>
              )}

              {sectionVisible('MECHANICAL_PERFORMANCE') && (
                <SectionCard title="三、机械力学性能检验" count={mechanicalRows.length}>
                  <PreviewTable
                    headers={['项目编码', '项目名称', '标准要求', '实测值', '单位', '来源', '判定']}
                    rows={mechanicalRows}
                    cells={(row) => [
                      row.code,
                      row.name,
                      row.standard,
                      row.measured,
                      row.unit,
                      row.source,
                      <DecisionBadge key="decision" decision={row.conclusion} />,
                    ]}
                    empty="当前检验单在该分段无指标项"
                  />
                </SectionCard>
              )}

              {sectionVisible('CHEMICAL_COMPOSITION') && (
                <SectionCard title="四、材料化学成分检验" count={chemicalRows.length}>
                  <PreviewTable
                    headers={['元素', '元素名称', '标准要求', '实测值(%)', '判定']}
                    rows={chemicalRows}
                    cells={(row) => [
                      row.code,
                      row.name,
                      row.standard,
                      row.measured,
                      <DecisionBadge key="decision" decision={row.conclusion} />,
                    ]}
                    empty="当前检验单在该分段无指标项"
                  />
                </SectionCard>
              )}

              {selectedSections.length === 0 && (
                <div className="py-12 text-center text-slate-400 italic">
                  请在左侧勾选至少一个检验段落以预览和出具报告
                </div>
              )}

              {showSignature && selectedSections.length > 0 && (
                <div className="pt-4 border-t border-slate-200 flex justify-between items-center text-[11px] text-slate-500">
                  <div>
                    <p>检验专员: {previewModel.inspectorName ?? '—'}</p>
                    <p className="mt-0.5">审核确认: {previewModel.approverName ?? '—'}</p>
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
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/70 flex items-center justify-between">
          <div className="text-xs text-slate-500">
            {activeTab === 'print'
              ? '提示：点击“立即打印”调起系统打印机，仅输出右侧报告内容。'
              : '提示：导出文件由服务端按当前模板与所选分段生成。'}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs text-slate-600 hover:text-slate-800 border border-slate-200 hover:bg-slate-100 rounded-xl transition-colors"
          >
            取消 / 关闭
          </button>
        </div>
      </div>
    </div>
  );
};
