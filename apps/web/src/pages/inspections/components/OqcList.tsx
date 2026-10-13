import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus,
  RefreshCw,
} from 'lucide-react';
import { CertificatePrintModal } from '../../../components/certificate/CertificatePrintModal';
import { DateInput } from '../../../components/common/DateInput';
import type {
  CertTemplateKind,
  ManufacturingCertData,
  QualityCertificateData,
} from '../../../lib/inspectionTypes';
import { buildOqcCertificateData, buildManufacturingCertData } from '../../../lib/certificateDataService';
import { loadCompanyProfile } from '../../../lib/companyProfile';
import { api } from '../../../lib/api';
import type { TransferStateFields } from '../../../lib/transferGateFormat';

export interface OqcItem {
  id: string;
  docNo: string; // 检验单号, 如 'OQC-SH-20260706-0001'
  salesOrderNo: string; // 销售出库单号, 如 'SO-20260706-01'
  dispatchDate: string; // 出库日期, 如 '2026-07-06'
  customer: string; // 客户, 如 '客户A科技'
  orderNo: string; // 订单号, 如 'PO-A-001'
  productCode: string; // 成品编码, 如 'MAT-BLT-88-M10'
  productName: string; // 成品名称, 如 '六角螺栓M10'
  qty: number; // 数量, 如 5000
  erpStatus: '待审核' | '已审核' | '已拦截' | '-'; // ERP状态（缺失显示 '-'，不由检验结论反推）
  status: '待检验' | '检验中' | '已合格' | '不合格'; // 检验状态
  inspectorName: string; // 检验人, 如 '-', '张检验', '李检验', '王检验'
  actionText?: '检验' | '继续' | '详情';
  spec?: string;
  batchNo?: string;
  /** 物料编码（接口 materialCode）：证书与方案匹配的真实来源 */
  materialCode?: string;
  /** 材质牌号（接口 steelGrade）：无来源即空，证书留白 */
  steelGrade?: string;
  /** 炉号（接口 furnaceHeatNo）：证书「炉号」列的真实来源 */
  heatNo?: string;
  /** 工单实测项（inspection_orders.items）：证书「化学成分 / 力学性能 / 尺寸」三段的唯一真实来源 */
  items?: any[];
  /** 质量负责人签核人姓名（inspection_orders.approver_name，docs/35 §5）：未签核即空 */
  approverName?: string;
  /** 签核时间（inspection_orders.approved_at） */
  approvedAt?: string;
  rawStatus?: string;
  judgment?: string | null;
  /** 证书模板（docs/51）：建单前选定的版式；历史单无值即按本模块缺省出证 */
  certTemplate?: CertTemplateKind;
  /** 证书专用补充字段袋（cert_fields） */
  certFields?: Record<string, string>;
  /** 终判备注（inspection_orders.inspection_notes）：质保书「备注 IN REMARK」栏的真实来源 */
  inspectionNotes?: string;
  /**
   * 「合格后传递」派生字段（docs/48 §4.6，服务端 `withTransferState` 回填）：
   * canTransfer / transferCode / blockedBy / predecessorOrderNo / chainKey。
   * 字段缺失 = 服务端未下发判定（**不等于「允许」**），徽标据此显示 —。
   */
  canTransfer?: boolean | null;
  transferCode?: string | null;
  predecessorOrderNo?: string | null;
  chainKey?: string | null;
  blockedBy?: TransferStateFields['blockedBy'];
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

/** 当前月份的起止日期（YYYY-MM-DD）：1 日 ~ 月末最后一日，用于「默认显示本月筛选内容」 */
function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0); // 当月最后一日
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { from: fmt(first), to: fmt(last) };
}

export const OqcList: React.FC<OqcListProps> = ({ onInspect, onNew }) => {
  const [items, setItems] = useState<OqcItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [, setLoading] = useState(false);
  /** 接口异常时的显式提示：宁可空态 + 报错，也不用内置演示行冒充真实台账 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [selectedId, setSelectedId] = useState<string>('oqc-2'); // 默认高亮行2，与UI设计图一致

  // 搜索过滤状态
  const [salesOrderNoQuery, setSalesOrderNoQuery] = useState('');
  const [customerQuery, setCustomerQuery] = useState('');
  const [orderNoQuery, setOrderNoQuery] = useState('');
  const [heatNoQuery, setHeatNoQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('全部');
  // 出库日期区间（单据日期）：默认当前月份，满足「默认显示本月筛选内容」
  const [dispatchDateFromQuery, setDispatchDateFromQuery] = useState(() => currentMonthRange().from);
  const [dispatchDateToQuery, setDispatchDateToQuery] = useState(() => currentMonthRange().to);

  // 分页状态：每页 100 行，配合万条上限真正可呈现最多 1 万条
  const PAGE_SIZE = 100;
  const [page, setPage] = useState(1);
  /** 命中数超过万条上限被截断时为 true（后端 capped 透传） */
  const [capped, setCapped] = useState(false);

  // 已提交查询条件：驱动后端 /inspections 查询（输入框为草稿态，点击「查询」后提交）
  const [appliedFilters, setAppliedFilters] = useState<{
    salesOrderNo: string;
    customerName: string;
    salesOrderPoNo: string;
    furnaceHeatNo: string;
    dispatchDateFrom: string;
    dispatchDateTo: string;
    status: string;
  }>(() => {
    const { from, to } = currentMonthRange();
    return {
      salesOrderNo: '',
      customerName: '',
      salesOrderPoNo: '',
      furnaceHeatNo: '',
      dispatchDateFrom: from,
      dispatchDateTo: to,
      status: '全部',
    };
  });

  // 证书与放行卡控弹窗状态（版式按本单 cert_template，docs/51）
  const [certModalOpen, setCertModalOpen] = useState(false);
  const [certKind, setCertKind] = useState<CertTemplateKind>('QUALITY');
  const [certData, setCertData] = useState<QualityCertificateData | null>(null);
  const [mfgData, setMfgData] = useState<ManufacturingCertData | null>(null);

  // 加载数据
  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<{ list?: any[]; items?: any[]; total: number; capped?: boolean }>('/inspections', {
        type: 'OQC_SH',
        // 分页：每页 100 行，配合万条上限真正可呈现最多 1 万条（需求「最大呈现上限万条数据」）
        page,
        pageSize: PAGE_SIZE,
        ...(appliedFilters.status !== '全部' &&
        CN_TO_INSPECTION_STATE[appliedFilters.status] !== undefined
          ? { inspectionState: CN_TO_INSPECTION_STATE[appliedFilters.status] }
          : {}),
        salesOrderNo: appliedFilters.salesOrderNo || undefined,
        customerName: appliedFilters.customerName || undefined,
        salesOrderPoNo: appliedFilters.salesOrderPoNo || undefined,
        // 炉批号筛选（docs/47 §4.2⑤ / P2）：后端按 furnace_heat_batch_no 模糊匹配
        furnaceHeatNo: appliedFilters.furnaceHeatNo || undefined,
        // 出库日期区间筛选（单据日期）：与后端 dispatchDateFrom/To 对应；任一为空即不限制日期
        dispatchDateFrom: appliedFilters.dispatchDateFrom || undefined,
        dispatchDateTo: appliedFilters.dispatchDateTo || undefined,
      });

      // 真实后端 GET /inspections 的响应信封为 { total, list, statusCounts, capped }；
      // 离线 Mock（MSW）为 { items, total, page, pageSize }，两种信封都兼容。
      const rows = Array.isArray(res?.list) ? res.list : Array.isArray(res?.items) ? res.items : [];
      setCapped(res?.capped === true);

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
            // 规格型号取契约真实列（specification / spec）：历史实现读 `materialSpec`，库里没有该列，
            // 于是「规格型号」在台账与证书上恒为空 —— 属字段名错位，不是数据缺失
            spec: item.specification || item.spec || item.materialSpec || '',
            batchNo: item.batchNo,
            materialCode: item.materialCode || '',
            steelGrade: item.steelGrade || '',
            heatNo: item.furnaceHeatNo || '',
            items: Array.isArray(item.items) ? item.items : undefined,
            // 038 证书模板与字段袋：只取库中真实列，列为空即不输出该键
            certTemplate: item.certTemplate,
            certFields: item.certFields ?? undefined,
            inspectionNotes: item.inspectionNotes || '',
            approverName: item.approverName || '',
            approvedAt: item.approvedAt || '',
            rawStatus: item.status,
            judgment: item.overallDecision,
            // 传递派生字段原样透传，前端不做任何推导（docs/48 §2.1：规则在领域、执法在应用、其余只呈现）
            canTransfer: item.canTransfer ?? null,
            transferCode: item.transferCode ?? null,
            predecessorOrderNo: item.predecessorOrderNo ?? null,
            chainKey: item.chainKey ?? null,
            blockedBy: item.blockedBy ?? null,
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
  }, [appliedFilters, page]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 筛选条件已全部下沉至后端 GET /inspections（销售出库单号 / 客户 / 订单号 / 出库日期 / 检验状态），
  // 前端只做展示映射，不再二次过滤，杜绝"接口口径 + 前端口径"两套规则漂移
  const filteredItems = useMemo(() => items, [items]);

  // 查询与重置
  const handleSearch = () => {
    setPage(1);
    setAppliedFilters({
      salesOrderNo: salesOrderNoQuery.trim(),
      customerName: customerQuery.trim(),
      salesOrderPoNo: orderNoQuery.trim(),
      furnaceHeatNo: heatNoQuery.trim(),
      dispatchDateFrom: dispatchDateFromQuery,
      dispatchDateTo: dispatchDateToQuery,
      status: statusFilter,
    });
  };

  const handleReset = () => {
    const m = currentMonthRange();
    setSalesOrderNoQuery('');
    setCustomerQuery('');
    setOrderNoQuery('');
    setHeatNoQuery('');
    setStatusFilter('全部');
    setDispatchDateFromQuery(m.from);
    setDispatchDateToQuery(m.to);
    setPage(1);
    setAppliedFilters({
      salesOrderNo: '',
      customerName: '',
      salesOrderPoNo: '',
      furnaceHeatNo: '',
      dispatchDateFrom: m.from,
      dispatchDateTo: m.to,
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

  /**
   * 行级证书（docs/35 §10 M9）：按本行真实数据组装，未录入的项留白。
   * 键名口径由 certificateDataService 单点维护；企业档案（抬头 / 印章 / 供货单位·产地）取主数据，
   * 未维护即留白（不回落硬编码抬头）。
   */
  const handleOpenCert = (item: OqcItem) => {
    void (async () => {
      const companyProfile = await loadCompanyProfile();
      // 版式取本单建单时选定的 cert_template（docs/51）；历史单无值按本模块缺省 QUALITY 出证
      const kind: CertTemplateKind = item.certTemplate ?? 'QUALITY';
      const shared = {
        orderNo: item.docNo,
        docNo: item.docNo,
        customer: item.customer,
        customerName: item.customer,
        contractNo: item.orderNo,
        salesOrderPoNo: item.orderNo,
        deliveryNo: item.salesOrderNo,
        salesOrderNo: item.salesOrderNo,
        productName: item.productName,
        materialName: item.productName,
        spec: item.spec,
        specification: item.spec,
        steelGrade: item.steelGrade,
        heatNo: item.heatNo,
        batchNo: item.batchNo,
        quantity: item.qty,
        // 检验人必须是真实承担人，未录入时留空，绝不用示例姓名代替（证书为对外交付物）
        inspector: item.inspectorName !== '-' ? item.inspectorName : '',
        ...(item.approverName !== undefined && item.approverName !== ''
          ? { approverName: item.approverName }
          : {}),
        ...(item.judgment === 'PASSED'
          ? { judgment: 'PASSED' }
          : item.judgment === 'FAILED'
          ? { judgment: 'FAILED' }
          : {}),
        items: item.items,
        certFields: item.certFields,
        // 终判备注：质保书「备注 IN REMARK」只打印检验单填写的真实内容
        inspectionNotes: item.inspectionNotes,
        ...(companyProfile !== null ? { companyProfile } : {}),
      };
      if (kind === 'MANUFACTURING') {
        setMfgData(buildManufacturingCertData(shared));
        setCertData(null);
      } else {
        setCertData(buildOqcCertificateData(shared));
        setMfgData(null);
      }
      setCertKind(kind);
      setCertModalOpen(true);
    })();
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

      {capped && !loadError && (
        <div className="px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-700">
          当前筛选命中数据已超过 <span className="font-semibold">1 万条</span> 上限，仅展示前 1 万条（页码已截断）。请缩小「出库日期」区间或增加其它筛选条件以查看完整数据。
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
          <span className="text-slate-600 font-medium whitespace-nowrap">炉批号</span>
          <input
            type="text"
            placeholder="Heat No"
            value={heatNoQuery}
            onChange={(e) => setHeatNoQuery(e.target.value)}
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
          <span className="text-slate-600 font-medium whitespace-nowrap">出库日期</span>
          <DateInput
            wrapClassName="w-36"
            placeholderClassName="text-sm"
            placeholder="起始日期"
            value={dispatchDateFromQuery}
            onChange={(e) => setDispatchDateFromQuery(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 text-sm bg-white"
          />
          <span className="text-slate-400">~</span>
          <DateInput
            wrapClassName="w-36"
            placeholderClassName="text-sm"
            placeholder="结束日期"
            value={dispatchDateToQuery}
            onChange={(e) => setDispatchDateToQuery(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 text-sm bg-white"
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
                      isSelected
                        ? 'bg-[#F0F4FF]'
                        : item.canTransfer === false
                        ? 'bg-rose-50/40 hover:bg-rose-50/60'
                        : 'bg-white hover:bg-slate-50/70'
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
                      {/* 行级证书入口：所有行可点，数据缺失由证书留白体现（不用「按钮消失」表达，docs/35 §10） */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenCert(item);
                        }}
                        title="按本行数据导出证书（未录入的项留白）"
                        className="text-[#2B5AED] hover:text-blue-700 text-[13px] hover:underline ml-3"
                      >
                        证书
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* 底栏分页 */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-100 text-xs text-slate-400">
          <span className="mr-1">
            共 {total} 条{capped ? '（已达 1 万条上限）' : ''}
          </span>
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="w-8 h-8 rounded border border-slate-200 text-slate-500 flex items-center justify-center bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            &lt;
          </button>
          <span className="text-slate-600 tabular-nums">
            {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}
          </span>
          <button
            onClick={() =>
              setPage((p) => Math.min(Math.max(1, Math.ceil(total / PAGE_SIZE)), p + 1))
            }
            disabled={page >= Math.ceil(total / PAGE_SIZE)}
            className="w-8 h-8 rounded border border-slate-200 text-slate-500 flex items-center justify-center bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            &gt;
          </button>
        </div>
      </div>

      {/* 质检证书弹窗（版式按本单 cert_template，docs/51） */}
      {certModalOpen && (certData || mfgData) && (
        <CertificatePrintModal
          isOpen={certModalOpen}
          onClose={() => setCertModalOpen(false)}
          type={certKind === 'MANUFACTURING' ? 'manufacturing' : 'quality'}
          qualityData={certData}
          manufacturingData={mfgData}
        />
      )}
    </div>
  );
};
