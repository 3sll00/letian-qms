import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  RotateCcw,
  Search,
  Plus,
  RefreshCw,
  FileCheck,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Download,
} from 'lucide-react';
import { CertificatePrintModal } from '../../../components/certificate/CertificatePrintModal';
import { QualityCertificateData } from '../../../lib/inspectionTypes';
import { api } from '../../../lib/api';

export interface OqcItem {
  id: string;
  docNo: string; // 检验单号, 如 'OQC-SH-20260706-0001'
  salesOrderNo: string; // 销售出库单号, 如 'SO-20260706-01'
  dispatchDate: string; // 出库日期, 如 '2026-07-06'
  customer: string; // 客户, 如 '客户A科技'
  orderNo: string; // 订单号, 如 'PO-A-001'
  productCode: string; // 成品编码, 如 'CP-001'
  productName: string; // 成品名称, 如 '六角螺栓M10'
  qty: number; // 数量, 如 5000
  erpStatus: '待审核' | '已审核' | '已拦截' | '-'; // ERP状态（缺失显示 '-'，不由检验结论反推）
  status: '待检验' | '检验中' | '已合格' | '不合格'; // 检验状态
  inspectorName: string; // 检验人, 如 '-', '张检验', '李检验', '王检验'
  actionText?: '检验' | '继续' | '详情';
  spec?: string;
  batchNo?: string;
  rawStatus?: string;
  judgment?: string | null;
}


interface OqcListProps {
  onInspect: (item: any) => void;
  onNew?: () => void;
}

/**
 * 界面中文「检验状态」-> 后端 `inspectionState` 语义筛选取值。
 *
 * 该列表头展示的是**业务语义状态**，由库中 status + judgment 共同决定，与契约 status 枚举
 * 并非一一对应（例如「不合格」既可能是 status=FAILED，也可能是 COMPLETED + judgment=FAILED）。
 * 若前端自行拼装 statuses 组合，筛选结果就会与列上显示的字样不一致（按「不合格」筛选会一条都查不到）。
 * 因此统一提交单个 `inspectionState`，由后端仓储层按唯一口径翻译（见 docs 16 §5.1）。
 */
const CN_TO_INSPECTION_STATE: Record<string, string> = {
  待检验: 'PENDING',
  检验中: 'INSPECTING',
  已合格: 'PASSED',
  不合格: 'FAILED',
};

export const OqcList: React.FC<OqcListProps> = ({ onInspect, onNew }) => {
  const [items, setItems] = useState<OqcItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  /** 接口异常时的显式提示：宁可空态 + 报错，也不用内置演示行冒充真实台账 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [selectedId, setSelectedId] = useState<string>('oqc-2'); // 默认高亮行2，与UI设计图一致

  // 搜索过滤状态
  const [salesOrderNoQuery, setSalesOrderNoQuery] = useState('');
  const [customerQuery, setCustomerQuery] = useState('');
  const [orderNoQuery, setOrderNoQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('全部');
  const [dateFilter, setDateFilter] = useState('');

  // 已提交查询条件：驱动后端 /inspections 查询（输入框为草稿态，点击「查询」后提交）
  const [appliedFilters, setAppliedFilters] = useState<{
    salesOrderNo: string;
    customerName: string;
    salesOrderPoNo: string;
    dispatchDate: string;
    status: string;
  }>({
    salesOrderNo: '',
    customerName: '',
    salesOrderPoNo: '',
    dispatchDate: '',
    status: '全部',
  });

  // 证书与放行卡控弹窗状态
  const [certModalOpen, setCertModalOpen] = useState(false);
  const [certData, setCertData] = useState<QualityCertificateData | null>(null);
  const [releaseGateResult, setReleaseGateResult] = useState<{
    docNo: string;
    canRelease: boolean;
    reason: string;
  } | null>(null);

  // 加载数据
  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<{ list?: any[]; items?: any[]; total: number }>('/inspections', {
        type: 'OQC_SH',
        ...(appliedFilters.status !== '全部' &&
        CN_TO_INSPECTION_STATE[appliedFilters.status] !== undefined
          ? { inspectionState: CN_TO_INSPECTION_STATE[appliedFilters.status] }
          : {}),
        salesOrderNo: appliedFilters.salesOrderNo || undefined,
        customerName: appliedFilters.customerName || undefined,
        salesOrderPoNo: appliedFilters.salesOrderPoNo || undefined,
        dispatchDate: appliedFilters.dispatchDate || undefined,
      });

      // 真实后端 GET /inspections 的响应信封为 { total, list, statusCounts }；
      // 离线 Mock（MSW）为 { items, total, page, pageSize }，两种信封都兼容。
      const rows = Array.isArray(res?.list) ? res.list : Array.isArray(res?.items) ? res.items : [];

      if (rows.length > 0) {
        const mapped: OqcItem[] = rows.map((item: any, idx: number) => {
          // 派生口径与后端 `inspectionState` 完全一致（docs 16 §5.1），否则筛选与列显示会互相矛盾：
          // 待检验 = PENDING/DRAFT；检验中 = INSPECTING/RE_INSPECTING；
          // 已合格 = COMPLETED/PASSED 且 overallDecision ≠ FAILED；
          // 不合格 = FAILED/IN_MRB_REVIEW，或 COMPLETED/PASSED 且 overallDecision = FAILED。
          let statusText: OqcItem['status'] = '待检验';
          if (item.status === 'INSPECTING' || item.status === 'RE_INSPECTING') statusText = '检验中';
          else if (item.status === 'COMPLETED' || item.status === 'PASSED') {
            statusText = item.overallDecision === 'FAILED' ? '不合格' : '已合格';
          } else if (item.status === 'FAILED' || item.status === 'IN_MRB_REVIEW') statusText = '不合格';

          // ERP审批状态一律取库中 `erp_status` 真实列，缺失即 '-':
          // 不再由质检结论反推（"已合格→已审核"会让 ERP 侧口径被质检结论伪造）
          const erpStatusText: OqcItem['erpStatus'] = item.erpStatus ?? '-';

          let actionText: OqcItem['actionText'] = '详情';
          if (statusText === '待检验') actionText = '检验';
          else if (statusText === '检验中') actionText = '继续';

          return {
            id: item.id || `oqc-${idx + 1}`,
            // 展示列一律取接口/数据库真实字段，缺失时显示 '-'：不再按行号编造单号、客户、数量等示例值，
            // 避免"字段没打通 → 页面自己编一个值"的口径失真
            docNo: item.orderNo || '-',
            salesOrderNo: item.salesOrderNo || item.sourceOrderNo || '-',
            dispatchDate: item.dispatchDate || (item.createdAt ? item.createdAt.substring(0, 10) : '-'),
            customer: item.customerName || '-',
            orderNo: item.salesOrderPoNo || '-',
            productCode: item.materialCode || '-',
            productName: item.materialName || '-',
            qty: Number(item.sampleQty ?? item.batchSize ?? item.qty ?? 0),
            erpStatus: erpStatusText,
            status: statusText,
            // 未开始 / 待检验一律显示 '-'（见 docs/09-界面与开源组件.md §2.3 检验人列规范）；
            // 其余状态展示库中真实姓名，缺失时同样以 '-' 兜底，绝不用占位人名冒充
            inspectorName: statusText === '待检验' ? '-' : item.inspectorName || '-',
            actionText,
            spec: item.materialSpec || '',
            batchNo: item.batchNo,
            rawStatus: item.status,
            judgment: item.overallDecision,
          };
        });
        setItems(mapped);
        setTotal(Number(res.total ?? mapped.length));
      } else {
        setItems([]);
        setTotal(Number(res.total ?? 0));
      }
    } catch (err) {
      // 接口不可用（离线 / 后端未启动）时一律空态 + 显式错误提示：
      // 不再回退到内置演示行（演示行与真实台账形态一致，会让"链路是否真打通"无法判断）
      console.warn('Failed to load OQC data from API', err);
      setItems([]);
      setTotal(0);
      setLoadError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setLoading(false);
    }
  }, [appliedFilters]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 筛选条件已全部下沉至后端 GET /inspections（销售出库单号 / 客户 / 订单号 / 出库日期 / 检验状态），
  // 前端只做展示映射，不再二次过滤，杜绝"接口口径 + 前端口径"两套规则漂移
  const filteredItems = useMemo(() => items, [items]);

  // 查询与重置
  const handleSearch = () => {
    setAppliedFilters({
      salesOrderNo: salesOrderNoQuery.trim(),
      customerName: customerQuery.trim(),
      salesOrderPoNo: orderNoQuery.trim(),
      dispatchDate: dateFilter,
      status: statusFilter,
    });
  };

  const handleReset = () => {
    setSalesOrderNoQuery('');
    setCustomerQuery('');
    setOrderNoQuery('');
    setStatusFilter('全部');
    setDateFilter('');
    setAppliedFilters({
      salesOrderNo: '',
      customerName: '',
      salesOrderPoNo: '',
      dispatchDate: '',
      status: '全部',
    });
  };

  // 同步 ERP 出货单模拟操作
  const handleSyncErp = async () => {
    setSyncing(true);
    try {
      await new Promise((r) => setTimeout(r, 800));
      alert('已成功同步 ERP 销售出库单据！');
      loadData();
    } catch (err) {
      alert('同步 ERP 出货单失败，请检查网络设置');
    } finally {
      setSyncing(false);
    }
  };

  // 行操作：调用 onInspect，保持与 OqcRecordForm 完整字段兼容
  const handleRowInspect = (item: OqcItem) => {
    setSelectedId(item.id);
    onInspect({
      ...item,
      id: item.id,
      no: item.docNo,
      doc: item.orderNo,
      orderNo: item.docNo,
      client: item.customer,
      customer: item.customer,
      name: item.productName,
      productName: item.productName,
      productCode: item.productCode,
      salesOrderNo: item.salesOrderNo,
      deliveryNo: item.salesOrderNo,
      spec: item.spec || '',
      qty: `${item.qty} 件`,
      // 证书上的检验人必须是真实承担人，未录入时留空，绝不用示例姓名代替（证书为对外交付物）
      inspector: item.inspectorName !== '-' ? item.inspectorName : '',
      status: item.status,
      isReadOnly: item.status === '已合格' || item.status === '不合格',
    });
  };

  return (
    <div className="space-y-4">
      {/* 顶部标题与操作 */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900">出货检验</h1>
            <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200 font-medium">
              OQC-SH
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            数据来源: ERP 已审核销售单·检验合格后才能审核通过出库单
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleSyncErp}
            disabled={syncing}
            className="px-3.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-sm font-medium flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 text-blue-600 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? '正在同步...' : '同步ERP出货单'}
          </button>
          <button
            onClick={() => (onNew ? onNew() : onInspect(null))}
            className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium flex items-center gap-1.5 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            新建检验
          </button>
        </div>
      </div>

      {/* 筛选区域 */}
      {loadError && (
        <div className="px-4 py-2.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">
          出货检验台账加载失败，已清空列表（不展示演示数据）: <span className="font-mono">{loadError}</span>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200/80 p-4 shadow-sm flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium whitespace-nowrap">销售单号</span>
          <input
            type="text"
            placeholder="XS-2022-03-05-00002"
            value={salesOrderNoQuery}
            onChange={(e) => setSalesOrderNoQuery(e.target.value)}
            className="w-44 px-3 py-1.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 placeholder:text-slate-400 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium whitespace-nowrap">客户</span>
          <input
            type="text"
            placeholder="客户A科技"
            value={customerQuery}
            onChange={(e) => setCustomerQuery(e.target.value)}
            className="w-36 px-3 py-1.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 placeholder:text-slate-400 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium whitespace-nowrap">订单号</span>
          <input
            type="text"
            placeholder="PO-A-001"
            value={orderNoQuery}
            onChange={(e) => setOrderNoQuery(e.target.value)}
            className="w-36 px-3 py-1.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 placeholder:text-slate-400 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium whitespace-nowrap">检验状态</span>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              // 检验状态为单次明确选择，直接提交查询，保持与设计稿一致的即时联动
              setAppliedFilters((prev) => ({ ...prev, status: e.target.value }));
            }}
            className="w-28 px-3 py-1.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 text-sm bg-white"
          >
            <option value="全部">全部</option>
            <option value="待检验">待检验</option>
            <option value="检验中">检验中</option>
            <option value="已合格">已合格</option>
            <option value="不合格">不合格</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium whitespace-nowrap">单据日期</span>
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="w-36 px-3 py-1.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 text-sm bg-white"
          />
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={handleReset}
            className="px-4 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors font-medium text-sm"
          >
            重置
          </button>
          <button
            onClick={handleSearch}
            className="px-5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors font-medium text-sm shadow-sm"
          >
            查询
          </button>
        </div>
      </div>

      {/* 数据表格区域 */}
      <div className="bg-white rounded-xl border border-slate-200/90 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="bg-[#F8FAFC] border-b border-slate-200/80 text-slate-400 font-medium text-[13px] tracking-wide">
                <th className="py-4 px-6 text-left whitespace-nowrap">检验单号</th>
                <th className="py-4 px-4 text-left whitespace-nowrap">销售出库单号</th>
                <th className="py-4 px-4 text-left whitespace-nowrap">出库日期</th>
                <th className="py-4 px-4 text-left whitespace-nowrap">客户</th>
                <th className="py-4 px-4 text-left whitespace-nowrap">订单号</th>
                <th className="py-4 px-4 text-left whitespace-nowrap">成品编码</th>
                <th className="py-4 px-4 text-left whitespace-nowrap">成品名称</th>
                <th className="py-4 px-4 text-left whitespace-nowrap">数量</th>
                <th className="py-4 px-4 text-left whitespace-nowrap">ERP状态</th>
                <th className="py-4 px-4 text-left whitespace-nowrap">检验状态</th>
                <th className="py-4 px-4 text-left whitespace-nowrap">检验人</th>
                <th className="py-4 px-6 text-left whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {filteredItems.map((item) => {
                const isSelected = item.id === selectedId;
                return (
                  <tr
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? 'bg-[#F0F4FF]' : 'bg-white hover:bg-slate-50/70'
                    }`}
                  >
                    {/* 检验单号 */}
                    <td className="py-5 px-6 whitespace-nowrap">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRowInspect(item);
                        }}
                        className="text-[#2B5AED] hover:text-blue-700 font-medium text-[13px] hover:underline"
                      >
                        {item.docNo}
                      </button>
                    </td>

                    {/* 销售出库单号 */}
                    <td className="py-5 px-4 whitespace-nowrap text-slate-700 text-[13px]">
                      {item.salesOrderNo}
                    </td>

                    {/* 出库日期 */}
                    <td className="py-5 px-4 whitespace-nowrap text-slate-700 text-[13px]">
                      {item.dispatchDate}
                    </td>

                    {/* 客户 */}
                    <td className="py-5 px-4 whitespace-nowrap text-slate-800 text-[13px]">
                      {item.customer}
                    </td>

                    {/* 订单号 */}
                    <td className="py-5 px-4 whitespace-nowrap text-slate-400 text-[13px]">
                      {item.orderNo}
                    </td>

                    {/* 成品编码 */}
                    <td className="py-5 px-4 whitespace-nowrap font-bold text-slate-900 text-[13px]">
                      {item.productCode}
                    </td>

                    {/* 成品名称 */}
                    <td className="py-5 px-4 whitespace-nowrap text-slate-800 text-[13px]">
                      {item.productName}
                    </td>

                    {/* 数量 */}
                    <td className="py-5 px-4 whitespace-nowrap text-slate-700 text-[13px]">
                      {item.qty}
                    </td>

                    {/* ERP状态 */}
                    <td className="py-5 px-4 whitespace-nowrap">
                      {item.erpStatus === '待审核' && (
                        <span className="inline-flex items-center px-2.5 py-1 rounded bg-[#FEF3C7] text-[#D97706] text-xs font-medium">
                          待审核
                        </span>
                      )}
                      {item.erpStatus === '已审核' && (
                        <span className="inline-flex items-center px-2.5 py-1 rounded bg-[#D1FAE5] text-[#059669] text-xs font-medium">
                          已审核
                        </span>
                      )}
                      {item.erpStatus === '已拦截' && (
                        <span className="inline-flex items-center px-2.5 py-1 rounded bg-[#FEE2E2] text-[#DC2626] text-xs font-medium">
                          已拦截
                        </span>
                      )}
                      {item.erpStatus === '-' && (
                        <span className="text-xs text-slate-400">-</span>
                      )}
                    </td>

                    {/* 检验状态 */}
                    <td className="py-5 px-4 whitespace-nowrap">
                      {item.status === '待检验' && (
                        <span className="inline-flex items-center px-2.5 py-1 rounded bg-[#F1F5F9] text-[#64748B] text-xs font-medium">
                          待检验
                        </span>
                      )}
                      {item.status === '检验中' && (
                        <span className="inline-flex items-center px-2.5 py-1 rounded bg-[#DBEAFE] text-[#2563EB] text-xs font-medium">
                          检验中
                        </span>
                      )}
                      {item.status === '已合格' && (
                        <span className="inline-flex items-center px-2.5 py-1 rounded bg-[#D1FAE5] text-[#059669] text-xs font-medium">
                          已合格
                        </span>
                      )}
                      {item.status === '不合格' && (
                        <span className="inline-flex items-center px-2.5 py-1 rounded bg-[#FEE2E2] text-[#DC2626] text-xs font-medium">
                          不合格
                        </span>
                      )}
                    </td>

                    {/* 检验人 */}
                    <td className="py-5 px-4 whitespace-nowrap text-slate-700 text-[13px]">
                      {item.inspectorName}
                    </td>

                    {/* 操作 */}
                    <td className="py-5 px-6 whitespace-nowrap">
                      {item.status === '待检验' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRowInspect(item);
                          }}
                          className="text-[#2B5AED] hover:text-blue-700 text-[13px] hover:underline"
                        >
                          检验
                        </button>
                      )}
                      {item.status === '检验中' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRowInspect(item);
                          }}
                          className="text-[#2B5AED] hover:text-blue-700 text-[13px] hover:underline"
                        >
                          继续
                        </button>
                      )}
                      {(item.status === '已合格' || item.status === '不合格') && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRowInspect(item);
                          }}
                          className="text-[#2B5AED] hover:text-blue-700 text-[13px] hover:underline"
                        >
                          详情
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* 底栏分页 */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-100 text-xs text-slate-400">
          <span className="mr-1">共{total}条</span>
          <button
            className="w-8 h-8 rounded border border-slate-200 text-slate-300 flex items-center justify-center bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            disabled
          >
            &lt;
          </button>
          <button className="w-8 h-8 rounded bg-blue-600 text-white font-medium flex items-center justify-center text-xs shadow-sm">
            1
          </button>
          <button
            className="w-8 h-8 rounded border border-slate-200 text-slate-400 flex items-center justify-center bg-white hover:bg-slate-50 transition-colors"
          >
            &gt;
          </button>
        </div>
      </div>

      {/* 质检证书弹窗 */}
      {certModalOpen && certData && (
        <CertificatePrintModal
          isOpen={certModalOpen}
          onClose={() => setCertModalOpen(false)}
          type="quality"
          qualityData={certData}
        />
      )}
    </div>
  );
};
