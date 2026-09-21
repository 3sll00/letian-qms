import React, { useEffect, useMemo, useState } from 'react';
import { Search, RotateCcw, Download, Loader2 } from 'lucide-react';
import type { Customer, InspectionOrder, InspectionStatus, InspectionType, Supplier } from '@letian/contracts';
import { StatusBadge } from '../../components/StatusBadge';
import { MultiSelect, type MultiSelectOption } from '../../components/MultiSelect';
import { api, errorMessage } from '../../lib/api';
import {
  INSPECTION_STATUS_LABELS,
  INSPECTION_TYPES,
  inspectionTypeLabel,
} from '../../lib/inspectionTypes';

/**
 * 检验进度明细（质量总览 - 检验进度明细）
 *
 * 数据来自 GET /api/v1/inspections（真实库聚合，mock 模式下由 MSW 同构拦截），
 * 支持跨字段组合查询；同一字段支持多选，多值之间为 OR，由后端 SQL 的 IN 语句承接：
 *   - 检验类型：order_type IN (...)
 *   - 检验状态：status IN (...)
 *   - 检验人：  inspector_id IN (...)
 * 不同字段之间仍为 AND 叠加。
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
  status: string;
  statusLabel: string;
}

/** 筛选表单字段。空串 / 空数组表示该条件不参与过滤 */
interface DetailFilters {
  dateFrom: string;
  dateTo: string;
  inspectionTypes: readonly string[];
  statuses: readonly string[];
  inspectors: readonly string[];
  materialKeyword: string;
  partnerKeyword: string;
  docKeyword: string;
}

function makeEmptyFilters(): DetailFilters {
  return {
    dateFrom: '',
    dateTo: '',
    inspectionTypes: [],
    statuses: [],
    inspectors: [],
    materialKeyword: '',
    partnerKeyword: '',
    docKeyword: '',
  };
}

const TYPE_OPTIONS: readonly MultiSelectOption[] = (
  Object.keys(INSPECTION_TYPES) as InspectionType[]
).map((type) => ({ value: type, label: INSPECTION_TYPES[type].label }));

const STATUS_OPTIONS: readonly MultiSelectOption[] = (
  Object.keys(INSPECTION_STATUS_LABELS) as InspectionStatus[]
).map((status) => ({ value: status, label: INSPECTION_STATUS_LABELS[status] }));

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
  // 表单草稿：输入过程中不生效，点击「查询」后才提交为 applied
  const [form, setForm] = useState<DetailFilters>(makeEmptyFilters());
  const [applied, setApplied] = useState<DetailFilters>(makeEmptyFilters());
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
  const [facetError, setFacetError] = useState('');

  const [exporting, setExporting] = useState(false);

  const updateForm = (patch: Partial<DetailFilters>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  /** 草稿筛选条件 -> 查询串参数（多值字段以逗号拼接，后端拆分为 IN 列表） */
  const buildParams = (f: DetailFilters, targetPage: number, targetPageSize: number) => ({
    page: String(targetPage),
    pageSize: String(targetPageSize),
    ...(f.inspectionTypes.length > 0 ? { inspectionTypes: f.inspectionTypes.join(',') } : {}),
    ...(f.statuses.length > 0 ? { statuses: f.statuses.join(',') } : {}),
    ...(f.inspectors.length > 0 ? { inspectors: f.inspectors.join(',') } : {}),
    ...(f.dateFrom !== '' ? { dateFrom: f.dateFrom } : {}),
    ...(f.dateTo !== '' ? { dateTo: f.dateTo } : {}),
    ...(f.materialKeyword.trim() !== '' ? { materialCode: f.materialKeyword.trim() } : {}),
    ...(f.partnerKeyword.trim() !== '' ? { partner: f.partnerKeyword.trim() } : {}),
    ...(f.docKeyword.trim() !== '' ? { keyword: f.docKeyword.trim() } : {}),
  });

  // 筛选候选与显示映射（仅挂载时拉取一次）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [facets, suppliers, customers] = await Promise.all([
          api.get<{ inspectors: Array<{ id: string; name: string }> }>('/inspections/filters'),
          api.get<Supplier[]>('/master-data/suppliers'),
          api.get<Customer[]>('/master-data/customers'),
        ]);
        if (cancelled) return;
        setInspectorOptions(facets.inspectors.map((item) => ({ value: item.id, label: item.name })));
        setSupplierNames(new Map(suppliers.map((s) => [s.supplierCode, s.supplierName])));
        setCustomerNames(new Map(customers.map((c) => [c.customerCode, c.customerName])));
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
    status: order.status,
    statusLabel: INSPECTION_STATUS_LABELS[order.status],
  });

  const displayRows = useMemo(() => rows.map(toRow), [rows, inspectorNamesById, supplierNames, customerNames]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // 查询即提交筛选条件并回到第一页
  const handleQuery = () => {
    setApplied(form);
    setPage(1);
  };

  const handleReset = () => {
    setForm(makeEmptyFilters());
    setApplied(makeEmptyFilters());
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

      {/* Filter Form Card：回车即触发查询 */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleQuery();
        }}
        className="bg-white border border-slate-100 rounded-lg p-4 shadow-sm space-y-3"
      >
        {/* Filter Row 1：日期范围 + 三个多选字段 */}
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-600">日期范围</span>
            <input
              type="date"
              value={form.dateFrom}
              onChange={(e) => updateForm({ dateFrom: e.target.value })}
              className="border border-slate-200 rounded px-2.5 py-1 text-slate-700 w-32 bg-white focus:outline-none focus:border-blue-500"
            />
            <span className="text-slate-400">至</span>
            <input
              type="date"
              value={form.dateTo}
              onChange={(e) => updateForm({ dateTo: e.target.value })}
              className="border border-slate-200 rounded px-2.5 py-1 text-slate-700 w-32 bg-white focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-slate-600">检验类型</span>
            <MultiSelect
              fieldName="检验类型"
              options={TYPE_OPTIONS}
              value={form.inspectionTypes}
              onChange={(next) => updateForm({ inspectionTypes: next })}
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-slate-600">检验状态</span>
            <MultiSelect
              fieldName="检验状态"
              options={STATUS_OPTIONS}
              value={form.statuses}
              onChange={(next) => updateForm({ statuses: next })}
              widthClass="w-40"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-slate-600">检验人</span>
            <MultiSelect
              fieldName="检验人"
              options={inspectorOptions}
              value={form.inspectors}
              onChange={(next) => updateForm({ inspectors: next })}
              widthClass="w-40"
            />
          </div>
        </div>

        {/* Filter Row 2：关键词输入 + 操作按钮 */}
        <div className="flex flex-wrap items-center justify-between gap-4 text-xs pt-1">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-slate-600">物料编码/名称</span>
              <input
                type="text"
                value={form.materialKeyword}
                onChange={(e) => updateForm({ materialKeyword: e.target.value })}
                placeholder="编码 / 名称"
                className="border border-slate-200 rounded px-2.5 py-1 text-slate-700 w-44 bg-white focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-slate-600">供应商/客户</span>
              <input
                type="text"
                value={form.partnerKeyword}
                onChange={(e) => updateForm({ partnerKeyword: e.target.value })}
                placeholder="供应商 / 客户 / 委外厂商"
                className="border border-slate-200 rounded px-2.5 py-1 text-slate-700 w-36 bg-white focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-slate-600">单据号</span>
              <input
                type="text"
                value={form.docKeyword}
                onChange={(e) => updateForm({ docKeyword: e.target.value })}
                placeholder="检验单号 / 批次号"
                className="border border-slate-200 rounded px-2.5 py-1 text-slate-700 w-44 bg-white focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleReset}
              className="bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 px-3 py-1 rounded shadow-sm text-xs flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5 text-slate-500" />
              重置
            </button>
            <button
              type="submit"
              className="bg-[#2563EB] hover:bg-blue-700 text-white px-4 py-1 rounded shadow-sm text-xs flex items-center gap-1.5"
            >
              <Search className="w-3.5 h-3.5" />
              查询
            </button>
          </div>
        </div>

        {(facetError !== '' || listError !== '') && (
          <div className="text-xs text-rose-500">
            {facetError !== '' ? `筛选选项加载失败: ${facetError}` : `查询失败: ${listError}`}
          </div>
        )}
      </form>

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
                      <StatusBadge status={it.status}>{it.statusLabel}</StatusBadge>
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
