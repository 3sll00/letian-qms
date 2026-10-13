import React, { useEffect, useMemo, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { Customer, InspectionOrder, InspectionType, Supplier } from '@letian/contracts';
import { StatusBadge } from '../../components/StatusBadge';
import { MultiSelect, type MultiSelectOption } from '../../components/MultiSelect';
import { DateInput } from '../../components/common/DateInput';
import {
  LetianFilterBuilder,
  type CustomCondition,
  type LetianFilterValues,
} from '../../components/common';
import { api, errorMessage } from '../../lib/api';
import {
  deriveInspectionStateLabel,
  INSPECTION_GROUPS,
  INSPECTION_STATE_OPTIONS,
  INSPECTION_TYPES,
  inspectionTypeLabel,
  isInspectionGroup,
} from '../../lib/inspectionTypes';

/**
 * 检验进度明细（质量总览 - 检验进度明细）
 *
 * 数据来自 GET /api/v1/inspections（真实库聚合，mock 模式下由 MSW 同构拦截），
 * 支持跨字段组合查询；同一字段支持多选，多值之间为 OR，由后端 SQL 承接：
 *   - 检验类型：order_type IN (...)
 *   - 检验状态：inspectionStates 派生语义（status + judgment 共同决定，OR 展开，docs 16 §5.1）
 *   - 检验人：  inspector_id IN (...)
 * 不同字段之间仍为 AND 叠加。
 *
 * 「状态」列必须与各业务台账页同口径：按 status + overallDecision 派生为
 * 待检验 / 检验中 / 已合格 / 不合格，而不是直接展示原始 status 枚举 ——
 * 否则已终判的实际操作记录（judgment）在进度明细里被「已结单」等字样掩盖。
 */

/** 台账展示行：由契约 InspectionOrder 派生（状态/类型中文名、检验人姓名、往来单位名称） */
interface DetailRow {
  orderNo: string;
  typeLabel: string;
  batchNo: string;
  materialCode: string;
  materialName: string;
  qty: number;
  inspectorName: string;
  partner: string;
  inspectDate: string;
  statusLabel: string;
}

/** 页面自有维度（LetianFilterBuilder 之外的草稿条件）。空串 / 空数组表示该条件不参与过滤 */
interface ExtraFilters {
  dateFrom: string;
  dateTo: string;
  inspectionTypes: readonly string[];
  inspectors: readonly string[];
  partnerKeyword: string;
}

/** 生效筛选 = 页面自有维度 + builder 输出（多选物料 / 多选供应商 / 派生状态 / 环节 / 组合条件） */
interface AppliedFilters extends ExtraFilters {
  statuses: readonly string[];
  materialCodes: readonly string[];
  supplierCodes: readonly string[];
  keyword: string;
  conditions: readonly CustomCondition[];
}

function makeEmptyExtraFilters(): ExtraFilters {
  return {
    dateFrom: '',
    dateTo: '',
    inspectionTypes: [],
    inspectors: [],
    partnerKeyword: '',
  };
}

function makeEmptyApplied(): AppliedFilters {
  return {
    ...makeEmptyExtraFilters(),
    statuses: [],
    materialCodes: [],
    supplierCodes: [],
    keyword: '',
    conditions: [],
  };
}

/** builder「检验环节」多选候选：IQC/IPQC/FQC/OQC 四大分组，值即 INSPECTION_GROUPS 键 */
const BUILDER_STAGE_OPTIONS = [
  { value: 'IQC', label: '来料检验 (IQC)' },
  { value: 'IPQC', label: '过程检验 (IPQC)' },
  { value: 'FQC', label: '成品检验 (FQC)' },
  { value: 'OQC', label: '出货/委外检验 (OQC)' },
];

/**
 * builder「高级组合条件」在本页开放的字段：只列后端 /inspections 真正支持的查询参数，
 * 避免操作员选了「不落库的字段」却得到全量结果（组件级 DEFAULT 已按此口径收敛）。
 */
const BUILDER_CONDITION_FIELDS = [
  { value: 'batchNo', label: '批次号 (batchNo)' },
  { value: 'orderNo', label: '检验单号 (orderNo)' },
  { value: 'inspectorName', label: '检验人姓名 (inspectorName)' },
];

const TYPE_OPTIONS: readonly MultiSelectOption[] = (
  Object.keys(INSPECTION_TYPES) as InspectionType[]
).map((type) => ({ value: type, label: INSPECTION_TYPES[type].label }));

/** 「检验状态」多选候选：派生语义四态，与台账列显示口径一致（值即后端 inspectionStates 合法取值） */
const STATUS_OPTIONS: readonly MultiSelectOption[] = INSPECTION_STATE_OPTIONS.map(
  (opt) => ({ value: opt.value, label: opt.label })
);

/** 导出循环拉取的页大小与安全上限 */
const EXPORT_PAGE_SIZE = 100;
const EXPORT_MAX_ROWS = 2000;

/** 导出文件的列（CSV 与 Excel 共用同一份列定义） */
const EXPORT_FIELDS: readonly { field: keyof DetailRow; label: string }[] = [
  { field: 'orderNo', label: '检验单号' },
  { field: 'typeLabel', label: '检验类型' },
  { field: 'batchNo', label: '批次号' },
  { field: 'materialCode', label: '物料编码' },
  { field: 'materialName', label: '物料名称' },
  { field: 'qty', label: '数量' },
  { field: 'inspectorName', label: '检验人' },
  { field: 'partner', label: '供应商/客户' },
  { field: 'inspectDate', label: '检验日期' },
  { field: 'statusLabel', label: '状态' },
];

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: readonly DetailRow[]): string {
  const lines = [EXPORT_FIELDS.map((c) => csvEscape(c.label)).join(',')];
  for (const row of rows) {
    lines.push(EXPORT_FIELDS.map((c) => csvEscape(row[c.field])).join(','));
  }
  return lines.join('\r\n');
}

function toExcelHtml(rows: readonly DetailRow[]): string {
  const head = EXPORT_FIELDS.map((c) => `<th>${c.label}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${EXPORT_FIELDS.map((c) => `<td>${row[c.field]}</td>`).join('')}</tr>`)
    .join('');
  return `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table border="1"><tr>${head}</tr>${body}</table></body></html>`;
}

function downloadFile(filename: string, content: string, mime: string): void {
  // 前置 BOM 保证 Excel 直接打开中文不乱码
  const blob = new Blob([`\uFEFF${content}`], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function InspectionHistoryPage() {
  // 页面自有维度草稿：输入过程中不生效，点击 builder「应用筛选」后与其输出一起提交为 applied
  const [form, setForm] = useState<ExtraFilters>(makeEmptyExtraFilters());
  const [applied, setApplied] = useState<AppliedFilters>(makeEmptyApplied());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [rows, setRows] = useState<InspectionOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');

  // 筛选候选与显示映射（检验人 / 供应商名 / 客户名）
  const [inspectorOptions, setInspectorOptions] = useState<readonly MultiSelectOption[]>([]);
  const [supplierNames, setSupplierNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [customerNames, setCustomerNames] = useState<ReadonlyMap<string, string>>(new Map());
  // builder 多选候选（真实主数据档案，组件自带兜底拉取被 props 短路）
  const [materialOptions, setMaterialOptions] = useState<Array<{ code: string; name: string }>>([]);
  const [supplierOptions, setSupplierOptions] = useState<Array<{ code: string; name: string }>>([]);
  const [facetError, setFacetError] = useState('');

  const [exporting, setExporting] = useState(false);

  const updateForm = (patch: Partial<ExtraFilters>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  /** 生效筛选条件 -> 查询串参数（多值字段以逗号拼接，后端拆分为 IN 列表） */
  const buildParams = (f: AppliedFilters, targetPage: number, targetPageSize: number) => {
    const params: Record<string, string> = {
      page: String(targetPage),
      pageSize: String(targetPageSize),
    };
    if (f.inspectionTypes.length > 0) params.inspectionTypes = f.inspectionTypes.join(',');
    // 派生语义多选：由仓储层把每个取值翻译成 status + judgment 谓词后 OR 叠加，
    // 不能用 statuses（原始枚举 IN 无法表达「COMPLETED 且判定不合格」这类口径）
    if (f.statuses.length > 0) params.inspectionStates = f.statuses.join(',');
    if (f.inspectors.length > 0) params.inspectors = f.inspectors.join(',');
    if (f.supplierCodes.length > 0) params.supplierCodes = f.supplierCodes.join(',');
    if (f.materialCodes.length > 0) params.materialCodes = f.materialCodes.join(',');
    if (f.dateFrom !== '') params.dateFrom = f.dateFrom;
    if (f.dateTo !== '') params.dateTo = f.dateTo;
    if (f.partnerKeyword.trim() !== '') params.partner = f.partnerKeyword.trim();
    if (f.keyword.trim() !== '') params.keyword = f.keyword.trim();
    // 高级组合条件 -> 各字段单值槽位：后端每字段只有一个筛选参数，同字段多条取第一条非空值
    for (const cond of f.conditions) {
      const value = cond.value.trim();
      if (value === '') continue;
      if (cond.field === 'batchNo' && params.batchNo === undefined) params.batchNo = value;
      if (cond.field === 'orderNo' && params.orderNo === undefined) params.orderNo = value;
      if (cond.field === 'inspectorName' && params.operatorName === undefined) {
        params.operatorName = value;
      }
    }
    return params;
  };

  // 筛选候选与显示映射（仅挂载时拉取一次）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [facets, suppliers, customers, inventory] = await Promise.all([
          api.get<{ inspectors: Array<{ id: string; name: string }> }>('/inspections/filters'),
          api.get<Supplier[]>('/master-data/suppliers'),
          api.get<Customer[]>('/master-data/customers'),
          api.get<Array<{ materialCode: string; materialName: string }>>(
            '/master-data/inventory'
          ),
        ]);
        if (cancelled) return;
        setInspectorOptions(facets.inspectors.map((item) => ({ value: item.id, label: item.name })));
        setSupplierNames(new Map(suppliers.map((s) => [s.supplierCode, s.supplierName])));
        setCustomerNames(new Map(customers.map((c) => [c.customerCode, c.customerName])));
        setSupplierOptions(suppliers.map((s) => ({ code: s.supplierCode, name: s.supplierName })));
        setMaterialOptions(inventory.map((m) => ({ code: m.materialCode, name: m.materialName })));
      } catch (err) {
        if (!cancelled) setFacetError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 服务端分页查询：applied / page / pageSize 任一变化即重新拉取
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setListError('');
    (async () => {
      try {
        const res = await api.get<{ items: InspectionOrder[]; total: number }>(
          '/inspections',
          buildParams(applied, page, pageSize)
        );
        if (cancelled) return;
        setRows(res.items);
        setTotal(res.total);
      } catch (err) {
        if (!cancelled) setListError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // buildParams 与 applied/page/pageSize 同步变化，此处按值依赖避免每次渲染重复请求
  }, [applied, page, pageSize]);

  const inspectorNamesById = useMemo(
    () => new Map(inspectorOptions.map((opt) => [opt.value, opt.label])),
    [inspectorOptions]
  );

  const toRow = (order: InspectionOrder): DetailRow => ({
    orderNo: order.orderNo,
    typeLabel: inspectionTypeLabel(order.inspectionType),
    batchNo: order.batchNo,
    materialCode: order.materialCode,
    materialName: order.materialName,
    qty: order.sampleQty,
    inspectorName:
      order.inspectorId !== undefined
        ? inspectorNamesById.get(order.inspectorId) ?? '未知检验员'
        : '未指派',
    partner:
      order.supplierCode !== undefined
        ? supplierNames.get(order.supplierCode) ?? order.supplierCode
        : order.customerCode !== undefined
          ? customerNames.get(order.customerCode) ?? order.customerCode
          : '',
    inspectDate: (order.createdAt ?? '').slice(0, 10),
    // 与各业务台账页同一份派生口径（lib/inspectionTypes.ts）：终判记录参与显示
    statusLabel: deriveInspectionStateLabel(order.status, order.overallDecision),
  });

  const displayRows = useMemo(() => rows.map(toRow), [rows, inspectorNamesById, supplierNames, customerNames]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  /**
   * builder「应用筛选」：把 builder 输出（环节/物料/供应商/状态/关键字/组合条件）与
   * 页面自有维度草稿（日期 / 检验类型 / 检验人 / 往来单位）合并为一次服务端查询。
   * 「检验环节」多选按 INSPECTION_GROUPS 展开成成员类型后，与「检验类型」多选取并集
   * 一起下发 inspectionTypes（同字段内 OR）。
   */
  const handleBuilderApply = (values: LetianFilterValues) => {
    const stageMemberTypes = values.stages.flatMap((stage) =>
      isInspectionGroup(stage) ? INSPECTION_GROUPS[stage].members : []
    );
    const mergedTypes = Array.from(
      new Set([...form.inspectionTypes, ...stageMemberTypes])
    ) as InspectionType[];
    setApplied({
      ...form,
      inspectionTypes: mergedTypes,
      statuses: values.statuses,
      materialCodes: values.materialCodes,
      supplierCodes: values.supplierCodes,
      keyword: values.keyword,
      conditions: values.conditions,
    });
    setPage(1);
  };

  const handleBuilderReset = () => {
    setForm(makeEmptyExtraFilters());
    setApplied(makeEmptyApplied());
    setPage(1);
  };

  const handlePageSizeChange = (size: number) => {
    setPageSize(size);
    setPage(1);
  };

  const exportFilename = (ext: string) =>
    `检验进度明细_${new Date().toISOString().slice(0, 10)}.${ext}`;

  /** 导出：按当前筛选条件循环拉取全量数据（带安全上限），再按前端既有格式落盘 */
  const handleExport = async (kind: 'csv' | 'xls') => {
    setExporting(true);
    try {
      const collected: InspectionOrder[] = [];
      let cursor = 1;
      while (collected.length < EXPORT_MAX_ROWS) {
        const res = await api.get<{ items: InspectionOrder[]; total: number }>(
          '/inspections',
          buildParams(applied, cursor, EXPORT_PAGE_SIZE)
        );
        collected.push(...res.items);
        if (collected.length >= res.total || res.items.length === 0) break;
        cursor += 1;
      }
      if (collected.length === 0) {
        alert('当前没有可导出的数据');
        return;
      }
      const exportRows = collected.map(toRow);
      if (kind === 'csv') {
        downloadFile(exportFilename('csv'), toCsv(exportRows), 'text/csv;charset=utf-8');
      } else {
        downloadFile(exportFilename('xls'), toExcelHtml(exportRows), 'application/vnd.ms-excel');
      }
    } catch (err) {
      alert(`导出失败: ${errorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Title + Subtitle + Right export buttons */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-800">检验进度明细</h1>
          <p className="text-xs text-slate-400 mt-0.5">关联所有检验数据: 来料(IQC) / 过程(IPQC) / 委外(OQC) / 出货(OQC)</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            title="在打印对话框中选择“另存为 PDF”"
            className="bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs px-3 py-1.5 rounded flex items-center gap-1.5 shadow-sm"
          >
            <span className="text-rose-500 font-bold text-[10px]">PDF</span>
            <span>导出 PDF</span>
          </button>
          <button
            type="button"
            disabled={exporting}
            onClick={() => handleExport('csv')}
            className="bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs px-3 py-1.5 rounded flex items-center gap-1.5 shadow-sm disabled:opacity-50"
          >
            <span className="text-blue-500 font-bold text-[10px]">CSV</span>
            <span>导出 CSV</span>
          </button>
          <button
            type="button"
            disabled={exporting}
            onClick={() => handleExport('xls')}
            className="bg-[#2563EB] hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded flex items-center gap-1.5 shadow-sm disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{exporting ? '导出中…' : '导出 Excel'}</span>
          </button>
        </div>
      </div>

      {/*
        通用高级筛选组件（v2.6.0 未结模块）：关键字 + 检验环节 / 物料 / 供应商 / 状态四个多选 +
        可展开的组合条件行，「应用筛选」一次性下发后端 IN / 模糊参数。
        页面自有维度（日期范围 / 检验类型 / 检验人 / 往来单位名称）经 children 插槽并入同一工具栏。
      */}
      <LetianFilterBuilder
        materials={materialOptions}
        suppliers={supplierOptions}
        statuses={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        stages={BUILDER_STAGE_OPTIONS}
        conditionFields={BUILDER_CONDITION_FIELDS}
        loading={loading}
        onFilter={handleBuilderApply}
        onReset={handleBuilderReset}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-slate-500">日期</span>
          <DateInput
            wrapClassName="w-28"
            value={form.dateFrom}
            onChange={(e) => updateForm({ dateFrom: e.target.value })}
            className="border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 bg-white focus:outline-none focus:border-blue-500"
          />
          <span className="text-slate-400 text-[11px]">至</span>
          <DateInput
            wrapClassName="w-28"
            value={form.dateTo}
            onChange={(e) => updateForm({ dateTo: e.target.value })}
            className="border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 bg-white focus:outline-none focus:border-blue-500"
          />
        </div>

        <MultiSelect
          fieldName="检验类型"
          options={TYPE_OPTIONS}
          value={form.inspectionTypes}
          onChange={(next) => updateForm({ inspectionTypes: next })}
        />

        <MultiSelect
          fieldName="检验人"
          options={inspectorOptions}
          value={form.inspectors}
          onChange={(next) => updateForm({ inspectors: next })}
          widthClass="w-36"
        />

        <input
          type="text"
          value={form.partnerKeyword}
          onChange={(e) => updateForm({ partnerKeyword: e.target.value })}
          placeholder="供应商 / 客户名称"
          className="border border-slate-200 rounded px-2.5 py-1 text-xs text-slate-700 w-36 bg-white focus:outline-none focus:border-blue-500"
        />
      </LetianFilterBuilder>

      {(facetError !== '' || listError !== '') && (
        <div className="text-xs text-rose-500">
          {facetError !== '' ? `筛选选项加载失败: ${facetError}` : `查询失败: ${listError}`}
        </div>
      )}

      {/* Table Card */}
      <div className="bg-white border border-slate-100 rounded-lg shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] text-left">
            <thead>
              <tr className="bg-slate-50/70 text-slate-500 border-b border-slate-100">
                <th className="py-2.5 px-3 font-normal">检验单号</th>
                <th className="py-2.5 px-3 font-normal">检验类型</th>
                <th className="py-2.5 px-3 font-normal">批次号</th>
                <th className="py-2.5 px-3 font-normal">物料编码</th>
                <th className="py-2.5 px-3 font-normal">物料名称</th>
                <th className="py-2.5 px-3 font-normal">数量</th>
                <th className="py-2.5 px-3 font-normal">检验人</th>
                <th className="py-2.5 px-3 font-normal">检验日期</th>
                <th className="py-2.5 px-3 font-normal">状态</th>
                <th className="py-2.5 px-3 font-normal text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading ? (
                <tr>
                  <td colSpan={10} className="py-10 text-center text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" />
                    加载中…
                  </td>
                </tr>
              ) : displayRows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-10 text-center text-slate-400">
                    暂无符合条件的检验单，请调整筛选条件后重新查询
                  </td>
                </tr>
              ) : (
                displayRows.map((it) => (
                  <tr key={it.orderNo} className="hover:bg-slate-50/60">
                    <td className="py-2.5 px-3 font-mono text-blue-600">{it.orderNo}</td>
                    <td className="py-2.5 px-3">{it.typeLabel}</td>
                    <td className="py-2.5 px-3 font-mono text-slate-600">{it.batchNo}</td>
                    <td className="py-2.5 px-3 font-mono">{it.materialCode}</td>
                    <td className="py-2.5 px-3">{it.materialName}</td>
                    <td className="py-2.5 px-3 font-mono">{it.qty}</td>
                    <td className="py-2.5 px-3">{it.inspectorName}</td>
                    <td className="py-2.5 px-3 font-mono">{it.inspectDate}</td>
                    <td className="py-2.5 px-3">
                      <StatusBadge status={it.statusLabel}>{it.statusLabel}</StatusBadge>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <button
                        type="button"
                        className="text-blue-600 hover:underline"
                        onClick={() =>
                          alert(
                            `${it.orderNo}\n${it.typeLabel} · ${it.statusLabel}\n物料: ${it.materialCode} ${it.materialName}\n数量: ${it.qty}\n批次: ${it.batchNo}\n检验人: ${it.inspectorName} · ${it.inspectDate}`
                          )
                        }
                      >
                        详情
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <div>
            共 {total} 条，第 {page}/{totalPages} 页
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
              className="px-2 py-0.5 border border-slate-200 rounded bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white"
            >
              &lt;
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPage(p)}
                className={
                  p === page
                    ? 'px-2.5 py-0.5 border border-blue-600 rounded bg-blue-600 text-white font-medium'
                    : 'px-2.5 py-0.5 border border-slate-200 rounded text-slate-700 bg-white hover:bg-slate-50'
                }
              >
                {p}
              </button>
            ))}
            <button
              type="button"
              disabled={page === totalPages}
              onClick={() => setPage(page + 1)}
              className="px-2 py-0.5 border border-slate-200 rounded bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white"
            >
              &gt;
            </button>
            <select
              value={pageSize}
              onChange={(e) => handlePageSizeChange(Number(e.target.value))}
              className="border border-slate-200 rounded px-1.5 py-0.5 bg-white text-slate-700 ml-2"
            >
              <option value={10}>10条/页</option>
              <option value={20}>20条/页</option>
              <option value={50}>50条/页</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
