import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Printer, Search, RotateCcw, GitFork, X } from 'lucide-react';
import { CertificatePrintModal } from '../../../components/certificate/CertificatePrintModal';
import { buildIqcCertificateData } from '../../../lib/certificateDataService';
import type { QualityCertificateData } from '../../../lib/inspectionTypes';
import { api } from '../../../lib/api';

export interface IqcItem {
  id: string;
  docNo: string;
  receiptNo: string;
  receiptDate: string;
  materialCode: string;
  materialName: string;
  spec: string;
  qty: number;
  unit: string;
  supplier: string;
  batchNo: string;
  status: '待检验' | '检验中' | '已合格' | '不合格' | '已关闭';
  inspectorName: string;
  rawStatus?: string;
  judgment?: string | null;
  steelGrade?: string;
  furnaceNo?: string;
  date?: string;
}

/**
 * 后端 `GET /inspections` 的响应信封：
 * 真实后端为 `{ total, list, statusCounts }`，离线 Mock（MSW）为 `{ items, total }`，两者都兼容。
 */
interface InspectionOrderListResponse {
  total?: number;
  list?: InspectionOrderRow[];
  items?: InspectionOrderRow[];
  statusCounts?: Record<string, number>;
}

/** 检验工单行：只声明本页实际读取的字段，用显式类型替代 `any`，避免字段口径静默漂移 */
interface InspectionOrderRow {
  id?: string;
  orderNo?: string;
  receiptNo?: string | null;
  receiptDate?: string | null;
  materialCode?: string;
  materialName?: string;
  spec?: string;
  specification?: string;
  sampleQty?: number | string | null;
  totalQty?: number | string | null;
  unit?: string;
  supplierName?: string;
  supplierCode?: string;
  batchNo?: string;
  status?: string;
  overallDecision?: string | null;
  inspectorName?: string | null;
  steelGrade?: string;
  furnaceHeatNo?: string;
  furnaceNo?: string;
}

/** 已提交的筛选条件 */
interface IqcFilters {
  doc: string;
  material: string;
  supplier: string;
  status: string;
  date: string;
}

const EMPTY_IQC_FILTERS: IqcFilters = {
  doc: '',
  material: '',
  supplier: '全部',
  status: '全部',
  date: '',
};

/**
 * 界面「检验状态」中文口径 -> 后端 inspectionState 派生状态。
 * 后端该参数由 status + judgment 共同翻译（见 docs 16 §5.1），与台账该列显示口径一一对应。
 */
const CN_TO_INSPECTION_STATE: Record<string, 'PENDING' | 'INSPECTING' | 'PASSED' | 'FAILED'> = {
  待检验: 'PENDING',
  检验中: 'INSPECTING',
  已合格: 'PASSED',
  不合格: 'FAILED',
};

interface IqcListProps {
  onInspect: (item: any, readOnly?: boolean) => void;
  onNavigateTrace?: (batchNo: string) => void;
}


export const IqcList: React.FC<IqcListProps> = ({ onInspect }) => {
  const [doc, setDoc] = useState('');
  const [material, setMaterial] = useState('');
  const [supplier, setSupplier] = useState('全部');
  const [status, setStatus] = useState('全部');
  const [date, setDate] = useState('');

  /** 已提交的筛选条件（点「查询」才生效）；loadOrders 只读这一份，保证「界面条件 == 接口条件」 */
  const [appliedFilters, setAppliedFilters] = useState<IqcFilters>(EMPTY_IQC_FILTERS);

  const [items, setItems] = useState<IqcItem[]>([]);
  const [loading, setLoading] = useState(false);
  /** 接口异常时的显式提示：宁可空态 + 报错，也不用内置演示行冒充真实台账 */
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const pageSize = 10;
  /** 后端返回的命中总条数（不是当前页条数，也不再是前端二次过滤后的长度） */
  const [rowTotal, setRowTotal] = useState(0);

  // 质保书模态框
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [currentCertData, setCurrentCertData] = useState<QualityCertificateData | undefined>(undefined);

  // 批次追溯弹窗
  const [traceBatchItem, setTraceBatchItem] = useState<IqcItem | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);

  const handleOpenCert = (item: IqcItem) => {
    const certData = buildIqcCertificateData({
      id: item.docNo,
      material: item.materialName,
      spec: item.spec,
      quantity: item.qty,
      supplier: item.supplier,
      inspectDate: item.receiptDate,
      batchNo: item.batchNo,
      furnaceNo: item.furnaceNo || item.batchNo,
    });
    setCurrentCertData(certData);
    setPrintModalOpen(true);
  };

  const handleOpenTrace = (item: IqcItem) => {
    setTraceBatchItem(item);
    setTraceLoading(true);
    setTimeout(() => {
      setTraceLoading(false);
    }, 250);
  };

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 筛选与分页全部下沉到后端：前端只负责把「已提交的筛选条件」翻译成契约查询参数，
      // 不再对「服务端只返回前 100 条」的结果做二次过滤（否则 total 与检索范围都会失真）。
      const res = await api.get<InspectionOrderListResponse>('/inspections', {
        type: 'IQC',
        page,
        pageSize,
        ...(appliedFilters.doc.trim() !== ''
          ? { docKeyword: appliedFilters.doc.trim() }
          : {}),
        ...(appliedFilters.material.trim() !== ''
          ? { materialKeyword: appliedFilters.material.trim() }
          : {}),
        ...(appliedFilters.supplier !== '全部' ? { partner: appliedFilters.supplier } : {}),
        ...(appliedFilters.status !== '全部' &&
        CN_TO_INSPECTION_STATE[appliedFilters.status] !== undefined
          ? { inspectionState: CN_TO_INSPECTION_STATE[appliedFilters.status] }
          : {}),
        ...(appliedFilters.date !== ''
          ? { dateFrom: appliedFilters.date, dateTo: appliedFilters.date }
          : {}),
      });

      // 真实后端信封为 { total, list, statusCounts }；离线 Mock（MSW）为 { items, total }
      const rows = Array.isArray(res?.list)
        ? res.list
        : Array.isArray(res?.items)
        ? res.items
        : [];

      const mapped: IqcItem[] = rows.map((o, idx) => {
        // 状态判定与契约 InspectionStatusEnum / OverallDecisionEnum 对齐，
        // 不再使用已不存在的 CLOSED / REJECT 旧口径，也不再用占位数据污染真实行
        let st: IqcItem['status'] = '待检验';
        if (o.status === 'INSPECTING' || o.status === 'RE_INSPECTING') st = '检验中';
        else if (o.status === 'COMPLETED' || o.status === 'PASSED') {
          st = o.overallDecision === 'FAILED' ? '不合格' : '已合格';
        } else if (o.status === 'FAILED' || o.status === 'IN_MRB_REVIEW') st = '不合格';

        return {
          id: o.id || `iqc-row-${(page - 1) * pageSize + idx + 1}`,
          docNo: o.orderNo || '-',
          // 入库单号与入库日期一律取库中真实列，缺失显示 '-'：
          // 不再用 `RK-` + 检验单号推导单号，也不再用 createdAt 近似入库日期（两者都会让链路真伪无法判断）
          receiptNo: o.receiptNo || '-',
          receiptDate: o.receiptDate ? String(o.receiptDate).slice(0, 10) : '-',
          materialCode: o.materialCode || '-',
          materialName: o.materialName || '-',
          spec: o.spec || o.specification || '',
          qty: Number(o.sampleQty ?? o.totalQty ?? 0),
          unit: o.unit || '',
          supplier: o.supplierName || o.supplierCode || '-',
          batchNo: o.batchNo || '-',
          status: st,
          // 与出货检验台账同口径：未开始 / 待检验一律显示 '-'，其余显示库中真实姓名
          inspectorName: st === '待检验' ? '-' : o.inspectorName || '-',
          rawStatus: o.status,
          judgment: o.overallDecision,
          steelGrade: o.steelGrade,
          furnaceNo: o.furnaceHeatNo || o.furnaceNo,
        };
      });
      setItems(mapped);
      setRowTotal(Number(res?.total ?? mapped.length));
    } catch (err) {
      // 接口不可用（离线 / 后端未启动）时一律展示空态 + 显式错误提示：
      // 不再用内置演示行冒充真实台账（演示行会让"字段/接口是否真打通"无法判断）
      setItems([]);
      setRowTotal(0);
      setLoadError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setLoading(false);
    }
  }, [appliedFilters, page, pageSize]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  // 不再做前端二次过滤：单号 / 物料 / 供应商 / 检验状态 / 入库日期 已全部下沉到后端
  // （见 loadOrders），服务端按 page + pageSize 分页返回，这里直接使用当前页数据；
  // 页脚条数取后端命中总数 rowTotal，而不是"前端过滤后的本地数组长度"。
  const pagedRows = items;

  /** 查询：把界面上的条件提交为 appliedFilters，并回到第 1 页 */
  const handleSearch = () => {
    setPage(1);
    setAppliedFilters({
      doc: doc.trim(),
      material: material.trim(),
      supplier,
      status,
      date,
    });
  };

  /** 重置：清空界面条件并同步清空已提交条件 */
  const handleReset = () => {
    setDoc('');
    setMaterial('');
    setSupplier('全部');
    setStatus('全部');
    setDate('');
    setPage(1);
    setAppliedFilters(EMPTY_IQC_FILTERS);
  };

  const allSelected = pagedRows.length > 0 && pagedRows.every((r) => selectedIds.includes(r.id));
  const toggleSelectAll = () => {
    if (allSelected) {
      const currentIds = new Set(pagedRows.map((r) => r.id));
      setSelectedIds((prev) => prev.filter((id) => !currentIds.has(id)));
    } else {
      const newIds = new Set([...selectedIds, ...pagedRows.map((r) => r.id)]);
      setSelectedIds(Array.from(newIds));
    }
  };

  const toggleSelectRow = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  // 状态徽章渲染（与界面设计图严格像素对齐）
  const renderStatusBadge = (st: IqcItem['status']) => {
    switch (st) {
      case '待检验':
        return <span className="inline-block px-2.5 py-0.5 rounded text-xs bg-slate-100 text-slate-500">待检验</span>;
      case '检验中':
        return <span className="inline-block px-2.5 py-0.5 rounded text-xs bg-blue-50 text-blue-600">检验中</span>;
      case '已合格':
        return <span className="inline-block px-2.5 py-0.5 rounded text-xs bg-emerald-50 text-emerald-600 font-medium">已合格</span>;
      case '不合格':
        return <span className="inline-block px-2.5 py-0.5 rounded text-xs bg-rose-50 text-rose-600 font-medium">不合格</span>;
      case '已关闭':
        return <span className="inline-block px-2.5 py-0.5 rounded text-xs bg-slate-200 text-slate-500">已关闭</span>;
      default:
        return <span className="inline-block px-2.5 py-0.5 rounded text-xs bg-slate-100 text-slate-500">{st}</span>;
    }
  };

  return (
    <div className="space-y-4">
      {/* 顶部搜索与筛选栏 */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">检验单号 / 入库单号</label>
            <div className="relative">
              <input
                type="text"
                placeholder="搜索检验单号或入库单号..."
                value={doc}
                onChange={(e) => setDoc(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500"
              />
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">物料编号 / 物料名称</label>
            <input
              type="text"
              placeholder="物料编号或名称..."
              value={material}
              onChange={(e) => setMaterial(e.target.value)}
              className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">供应商</label>
            <select
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500 bg-white"
            >
              <option value="全部">全部供应商</option>
              <option value="宝钢">宝钢</option>
              <option value="鞍钢">鞍钢</option>
              <option value="武钢">武钢</option>
              <option value="江西铜业">江西铜业</option>
              <option value="标准件厂A">标准件厂A</option>
              <option value="标准件厂B">标准件厂B</option>
              <option value="南山铝业">南山铝业</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">检验状态</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500 bg-white"
            >
              <option value="全部">全部状态</option>
              <option value="待检验">待检验</option>
              <option value="检验中">检验中</option>
              <option value="已合格">已合格</option>
              <option value="不合格">不合格</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">入库日期</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="flex justify-between items-center mt-3 pt-3 border-t border-slate-100">
          <div className="text-xs text-slate-500">
            共查询到 <span className="font-semibold text-slate-700">{rowTotal}</span> 条来料检验记录
            {selectedIds.length > 0 && (
              <span className="ml-2 text-blue-600 font-medium">已选择 {selectedIds.length} 项</span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleReset}
              className="px-3 py-1.5 text-xs border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 flex items-center gap-1"
            >
              <RotateCcw className="w-3.5 h-3.5" /> 重置
            </button>
            <button
              onClick={handleSearch}
              className="px-4 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium flex items-center gap-1"
            >
              <Search className="w-3.5 h-3.5" /> 查询
            </button>
            <button
              onClick={() => loadOrders()}
              className="px-3 py-1.5 text-xs bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 flex items-center gap-1"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
            </button>
          </div>
        </div>
      </div>

      {/* 表格主体 */}
      {loadError && (
        <div className="px-4 py-2.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">
          来料检验台账加载失败，已清空列表（不展示演示数据）: <span className="font-mono">{loadError}</span>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50/70 border-b border-slate-200 text-slate-500 font-normal whitespace-nowrap">
                <th className="py-3 px-4 w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                </th>
                <th className="py-3 px-4 font-normal">检验单号</th>
                <th className="py-3 px-4 font-normal">采购入库单号</th>
                <th className="py-3 px-4 font-normal">入库日期</th>
                <th className="py-3 px-4 font-normal">物料编号</th>
                <th className="py-3 px-4 font-normal">物料名称</th>
                <th className="py-3 px-4 font-normal">规格型号</th>
                <th className="py-3 px-4 font-normal">数量</th>
                <th className="py-3 px-4 font-normal">供应商</th>
                <th className="py-3 px-4 font-normal">批次号</th>
                <th className="py-3 px-4 font-normal text-center">检验状态</th>
                <th className="py-3 px-4 font-normal">检验人</th>
                <th className="py-3 px-4 font-normal text-right pr-6">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pagedRows.length === 0 && (
                <tr>
                  <td colSpan={13} className="py-10 text-center text-slate-400">
                    {loading ? '数据加载中…' : '没有符合条件的来料检验记录'}
                  </td>
                </tr>
              )}
              {pagedRows.map((item) => (
                <tr
                  key={item.id}
                  className="hover:bg-slate-50/60 transition-colors whitespace-nowrap"
                >
                  <td className="py-3 px-4">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(item.id)}
                      onChange={() => toggleSelectRow(item.id)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                  </td>
                  {/* 1. 检验单号 */}
                  <td className="py-3 px-4 font-medium text-blue-600 hover:underline cursor-pointer">
                    <span onClick={() => onInspect(item, item.status !== '待检验' && item.status !== '检验中')}>
                      {item.docNo}
                    </span>
                  </td>
                  {/* 2. 采购入库单号 */}
                  <td className="py-3 px-4 text-slate-600 font-mono">
                    {item.receiptNo}
                  </td>
                  {/* 3. 入库日期 */}
                  <td className="py-3 px-4 text-slate-500">
                    {item.receiptDate}
                  </td>
                  {/* 4. 物料编号 */}
                  <td className="py-3 px-4 font-bold text-slate-900 font-mono">
                    {item.materialCode}
                  </td>
                  {/* 5. 物料名称 */}
                  <td className="py-3 px-4 text-slate-700">
                    {item.materialName}
                  </td>
                  {/* 6. 规格型号 */}
                  <td className="py-3 px-4 text-slate-400">
                    {item.spec}
                  </td>
                  {/* 7. 数量 */}
                  <td className="py-3 px-4 text-slate-700">
                    {item.qty} {item.unit}
                  </td>
                  {/* 8. 供应商 */}
                  <td className="py-3 px-4 text-slate-700">
                    {item.supplier}
                  </td>
                  {/* 9. 批次号 */}
                  <td className="py-3 px-4 text-slate-400 font-mono">
                    {item.batchNo}
                  </td>
                  {/* 10. 检验状态 */}
                  <td className="py-3 px-4 text-center">
                    {renderStatusBadge(item.status)}
                  </td>
                  {/* 11. 检验人 */}
                  <td className="py-3 px-4 text-slate-600">
                    {item.inspectorName}
                  </td>
                  {/* 12. 操作 */}
                  <td className="py-3 px-4 text-right pr-6">
                    <div className="flex items-center justify-end gap-3 text-xs">
                      {item.status === '待检验' && (
                        <button
                          onClick={() => onInspect(item, false)}
                          className="text-blue-600 hover:text-blue-700 hover:underline"
                        >
                          检验
                        </button>
                      )}
                      {item.status === '检验中' && (
                        <button
                          onClick={() => onInspect(item, false)}
                          className="text-blue-600 hover:text-blue-700 hover:underline"
                        >
                          继续
                        </button>
                      )}
                      <button
                        onClick={() => onInspect(item, true)}
                        className="text-blue-600 hover:text-blue-700 hover:underline"
                      >
                        详情
                      </button>
                      {item.status !== '待检验' && (
                        <button
                          onClick={() => handleOpenTrace(item)}
                          className="text-blue-600 hover:text-blue-700 hover:underline"
                        >
                          追溯
                        </button>
                      )}
                      {item.status === '已合格' && (
                        <button
                          title="打印/预览质保书"
                          onClick={() => handleOpenCert(item)}
                          className="text-slate-400 hover:text-slate-600 p-0.5 rounded"
                        >
                          <Printer className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 分页控制 */}
        <div className="p-4 border-t border-slate-100 flex justify-between items-center text-xs text-slate-500">
          <div>
            {rowTotal === 0
              ? '共 0 条'
              : `显示第 ${(page - 1) * pageSize + 1} 至 ${Math.min(page * pageSize, rowTotal)} 条，共 ${rowTotal} 条`}
          </div>
          <div className="flex gap-1 items-center">
            <button
              className="px-2 py-1 border border-slate-200 rounded disabled:text-slate-300 enabled:hover:bg-slate-50"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              &lt;
            </button>
            <span className="px-2.5 py-1 bg-blue-600 text-white rounded font-medium">
              {page} / {Math.max(1, Math.ceil(rowTotal / pageSize))}
            </span>
            <button
              className="px-2 py-1 border border-slate-200 rounded disabled:text-slate-300 enabled:hover:bg-slate-50"
              disabled={page >= Math.max(1, Math.ceil(rowTotal / pageSize))}
              onClick={() => setPage((p) => Math.max(1, p + 1))}
            >
              &gt;
            </button>
          </div>
        </div>
      </div>

      {/* 批次质量全景追溯弹窗 */}
      {traceBatchItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100 bg-slate-50/70">
              <div className="flex items-center gap-2">
                <GitFork className="w-4 h-4 text-blue-600" />
                <h3 className="text-sm font-bold text-slate-800">批次质量上下游追溯</h3>
                <span className="text-xs px-2 py-0.5 bg-blue-50 text-blue-600 rounded font-mono border border-blue-200">
                  {traceBatchItem.batchNo}
                </span>
              </div>
              <button
                onClick={() => setTraceBatchItem(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              {/* 批次基本摘要 */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 p-3.5 rounded-lg border border-slate-100">
                <div>
                  <span className="block text-slate-400 text-[11px]">物料名称</span>
                  <span className="font-semibold text-slate-800">{traceBatchItem.materialName}</span>
                </div>
                <div>
                  <span className="block text-slate-400 text-[11px]">物料编号</span>
                  <span className="font-mono text-slate-700">{traceBatchItem.materialCode}</span>
                </div>
                <div>
                  <span className="block text-slate-400 text-[11px]">供应商</span>
                  <span className="text-slate-700">{traceBatchItem.supplier}</span>
                </div>
                <div>
                  <span className="block text-slate-400 text-[11px]">检验状态</span>
                  <span className="font-medium text-emerald-600">{traceBatchItem.status}</span>
                </div>
              </div>

              {/* 追溯节点链路 */}
              <div>
                <h4 className="font-semibold text-slate-700 mb-2">质量溯源链条</h4>
                {traceLoading ? (
                  <div className="p-8 text-center text-slate-400 flex items-center justify-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin" /> 加载批次拓扑链路中...
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 bg-white">
                      <div className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
                        1
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-slate-800">采购到货入库</span>
                          <span className="text-slate-400 text-[11px]">{traceBatchItem.receiptDate}</span>
                        </div>
                        <p className="text-slate-500 text-[11px] mt-0.5">
                          ERP采购入库单号: <span className="font-mono text-slate-700">{traceBatchItem.receiptNo}</span> | 供应商: {traceBatchItem.supplier} | 数量: {traceBatchItem.qty} {traceBatchItem.unit}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-start gap-3 p-3 rounded-lg border border-emerald-200 bg-emerald-50/30">
                      <div className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
                        2
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-slate-800">来料质量检验 (IQC)</span>
                          <span className="text-slate-400 text-[11px]">{traceBatchItem.receiptDate}</span>
                        </div>
                        <p className="text-slate-500 text-[11px] mt-0.5">
                          检验单号: <span className="font-mono text-slate-700">{traceBatchItem.docNo}</span> | 检验人: {traceBatchItem.inspectorName} | 检验状态: <span className="font-semibold text-emerald-600">{traceBatchItem.status}</span>
                        </p>
                      </div>
                    </div>

                    <div className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 bg-white">
                      <div className="w-6 h-6 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
                        3
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-slate-800">车间领料投产</span>
                          <span className="text-slate-400 text-[11px]">生产关联</span>
                        </div>
                        <p className="text-slate-500 text-[11px] mt-0.5">
                          绑定工单下发中，批次锁定可投料状态。质检关卡放行确认完成。
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setTraceBatchItem(null)}
                className="px-4 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-100"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 质保书导出与打印模态框 */}
      <CertificatePrintModal
        isOpen={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        type="quality"
        qualityData={currentCertData}
      />
    </div>
  );
};
