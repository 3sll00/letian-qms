import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileSignature,
  FlaskConical,
  PackageSearch,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Truck,
  X,
} from 'lucide-react';
import {
  inspectionTypeToFailCategory,
  type MRBUrgencyLevel,
  type MrbReviewRecord,
  type PendingDefectItem,
  type PendingDefectStatus,
  type ReviewFlow,
} from '@letian/contracts';
import { api, errorMessage } from '../../lib/api';
import { StatusBadge, type BadgeTone } from '../../components/StatusBadge';
import { INSPECTION_TYPES, type InspectionGroup } from '../../lib/inspectionTypes';

/**
 * 不合格待审核池工作台（docs/tasks/v2.6.0-pending-modules-plan.md §2.2-4）
 *
 * - 汇集 IQC / IPQC / FQC / OQC 各环节判定不合格、汇入待审核池的记录；
 * - KPI 与列表数据一律取 `GET /mrb/pending-pool` 的服务端 total（PBAC 过滤后口径），
 *   页面**不得**用当页数据自行推算（分页下必然失真，口径同 MRB 处置页）；
 * - 「发起评审」弹窗供质检主管对滞留池中的条目逐条发起 MRB：
 *   正常链路下判定不合格会自动建单（docs/43），本入口只兜底未自动发起的滞留/历史条目。
 */

const PAGE_SIZE = 20;

type PoolStageTab = 'ALL' | InspectionGroup;

const STAGE_TABS: readonly { key: PoolStageTab; label: string }[] = [
  { key: 'ALL', label: '全部环节' },
  { key: 'IQC', label: 'IQC 来料' },
  { key: 'IPQC', label: 'IPQC 过程' },
  { key: 'FQC', label: 'FQC 成品终检' },
  { key: 'OQC', label: 'OQC 委外/出货' },
];

const POOL_STATUS_LABEL: Record<PendingDefectStatus, string> = {
  PENDING_INITIATE: '待发起',
  INITIATED: '已发起',
  DISMISSED: '已撤销',
};

const POOL_STATUS_TONE: Record<PendingDefectStatus, BadgeTone> = {
  PENDING_INITIATE: 'amber',
  INITIATED: 'blue',
  DISMISSED: 'slate',
};

const URGENCY_OPTIONS: readonly { value: MRBUrgencyLevel; label: string }[] = [
  { value: 'NORMAL', label: '常规' },
  { value: 'URGENT', label: '紧急' },
  { value: 'CRITICAL', label: '特急' },
];

const FAIL_CATEGORY_LABEL: Record<string, string> = {
  INCOMING_FAIL: '来料不合格',
  PROCESS_FAIL: '过程不合格',
  SHIPMENT_FAIL: '出货不合格',
  SUBCONTRACT_FAIL: '委外不合格',
};

interface PoolListResponse {
  items?: PendingDefectItem[];
  list?: PendingDefectItem[];
  total?: number;
}

interface PoolFilters {
  status: PendingDefectStatus | '';
  materialCode: string;
  batchNo: string;
}

const EMPTY_FILTERS: PoolFilters = { status: 'PENDING_INITIATE', materialCode: '', batchNo: '' };

function buildQuery(
  stage: PoolStageTab,
  filters: PoolFilters,
  page: number,
  pageSize: number
): Record<string, string | number | undefined> {
  return {
    page,
    pageSize,
    sourceStage: stage === 'ALL' ? undefined : stage,
    status: filters.status === '' ? undefined : filters.status,
    materialCode: filters.materialCode.trim() || undefined,
    batchNo: filters.batchNo.trim() || undefined,
  };
}

function typeLabel(inspectionType: string): string {
  return (
    (INSPECTION_TYPES as Record<string, { label: string } | undefined>)[inspectionType]?.label ??
    inspectionType
  );
}

function formatDateTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

/** 不良率展示：优先服务端回吐的 defectRate，缺省时按 defectQty/totalQty 折算 */
function defectRateText(item: PendingDefectItem): string {
  const rate =
    item.defectRate !== undefined
      ? item.defectRate
      : item.totalQty > 0
        ? (item.defectQty / item.totalQty) * 100
        : null;
  return rate === null ? '—' : `${rate.toFixed(1)}%`;
}

export function PendingMRBPoolPage() {
  const [stage, setStage] = useState<PoolStageTab>('ALL');
  const [draftFilters, setDraftFilters] = useState<PoolFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<PoolFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [searchToken, setSearchToken] = useState(0);

  const [items, setItems] = useState<PendingDefectItem[]>([]);
  const [total, setTotal] = useState(0);
  /** 各环节「待发起」计数：KPI 用服务端 total（pageSize=1 只取计数），不做当页推算 */
  const [kpiCounts, setKpiCounts] = useState<Record<PoolStageTab, number>>({
    ALL: 0,
    IQC: 0,
    IPQC: 0,
    FQC: 0,
    OQC: 0,
  });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [initiateTarget, setInitiateTarget] = useState<PendingDefectItem | null>(null);

  const loadKpis = useCallback(async () => {
    // 5 个轻量计数请求并行发出；任一失败只影响对应卡片，不阻断列表
    const results = await Promise.all(
      STAGE_TABS.map(async (tab) => {
        try {
          const res = await api.get<PoolListResponse>(
            '/mrb/pending-pool',
            buildQuery(tab.key, EMPTY_FILTERS, 1, 1)
          );
          return [tab.key, res.total ?? 0] as const;
        } catch {
          return [tab.key, 0] as const;
        }
      })
    );
    setKpiCounts(Object.fromEntries(results) as Record<PoolStageTab, number>);
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<PoolListResponse>(
        '/mrb/pending-pool',
        buildQuery(stage, appliedFilters, page, PAGE_SIZE)
      );
      setItems(res.items ?? res.list ?? []);
      setTotal(res.total ?? 0);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [stage, appliedFilters, page]);

  useEffect(() => {
    void loadItems();
  }, [loadItems, searchToken]);

  useEffect(() => {
    void loadKpis();
  }, [loadKpis]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleSearch = () => {
    setAppliedFilters(draftFilters);
    setPage(1);
    setSearchToken((token) => token + 1);
  };

  const handleReset = () => {
    setDraftFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    setPage(1);
  };

  const handleStageChange = (next: PoolStageTab) => {
    setStage(next);
    setPage(1);
  };

  const reloadAll = () => {
    void loadItems();
    void loadKpis();
  };

  const kpiCards: readonly {
    key: PoolStageTab;
    title: string;
    hint: string;
    icon: React.ComponentType<{ className?: string }>;
    iconClass: string;
  }[] = [
    {
      key: 'ALL',
      title: '待发起评审',
      hint: '各环节滞留池内合计',
      icon: Clock,
      iconClass: 'bg-amber-50 text-amber-600 border-amber-200',
    },
    {
      key: 'IQC',
      title: 'IQC 来料不合格',
      hint: '供应商来料判定不合格',
      icon: Truck,
      iconClass: 'bg-blue-50 text-blue-600 border-blue-200',
    },
    {
      key: 'IPQC',
      title: 'IPQC 过程不合格',
      hint: '下料 / 滚丝制程',
      icon: FlaskConical,
      iconClass: 'bg-purple-50 text-purple-600 border-purple-200',
    },
    {
      key: 'FQC',
      title: 'FQC 成品终检不合格',
      hint: '成品入库终检',
      icon: CheckCircle2,
      iconClass: 'bg-indigo-50 text-indigo-600 border-indigo-200',
    },
    {
      key: 'OQC',
      title: 'OQC 委外/出货不合格',
      hint: '委外加工与出货检验',
      icon: PackageSearch,
      iconClass: 'bg-rose-50 text-rose-500 border-rose-200',
    },
  ];

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">不合格待审核池</h2>
          <p className="text-xs text-slate-500 mt-1">
            各检验环节判定不合格自动汇入 · 判定不合格即自动发起评审（docs/43）·
            本页发起入口仅兜底滞留条目
          </p>
        </div>
        <button
          type="button"
          onClick={reloadAll}
          className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 shadow-sm flex items-center gap-1.5 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5 text-blue-600" />
          <span>刷新</span>
        </button>
      </div>

      {/* 5 项 KPI：一律取服务端口径 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
        {kpiCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.key}
              className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex items-center justify-between"
            >
              <div className="min-w-0">
                <div className="text-xs text-slate-500 font-medium">{card.title}</div>
                <div className="text-2xl font-black font-mono mt-1 text-slate-900">
                  {kpiCounts[card.key]} 条
                </div>
                <div className="text-[11px] text-slate-400 mt-1 truncate">{card.hint}</div>
              </div>
              <div
                className={`w-11 h-11 rounded-xl border flex items-center justify-center shrink-0 ${card.iconClass}`}
              >
                <Icon className="w-5 h-5" />
              </div>
            </div>
          );
        })}
      </div>

      {/* 筛选栏 */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1.5">池状态</span>
            <select
              value={draftFilters.status}
              onChange={(e) =>
                setDraftFilters({
                  ...draftFilters,
                  status: e.target.value as PoolFilters['status'],
                })
              }
              className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-blue-500"
            >
              <option value="">全部</option>
              <option value="PENDING_INITIATE">待发起评审</option>
              <option value="INITIATED">已发起评审</option>
              <option value="DISMISSED">已撤销</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1.5">物料编码</span>
            <input
              type="text"
              value={draftFilters.materialCode}
              onChange={(e) => setDraftFilters({ ...draftFilters, materialCode: e.target.value })}
              placeholder="如 MAT-10B21-06"
              className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1.5">批次号</span>
            <input
              type="text"
              value={draftFilters.batchNo}
              onChange={(e) => setDraftFilters({ ...draftFilters, batchNo: e.target.value })}
              placeholder="如 LOT-2026-0918-01"
              className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
            />
          </label>
          <div className="flex items-end justify-end gap-2.5">
            <button
              type="button"
              onClick={handleReset}
              className="px-4 py-2 text-xs text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 flex items-center gap-1.5 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>重置</span>
            </button>
            <button
              type="button"
              onClick={handleSearch}
              className="px-5 py-2 text-xs font-bold text-white bg-[#2563EB] hover:bg-blue-700 rounded-xl shadow-sm flex items-center gap-1.5 transition-colors"
            >
              <Search className="w-3.5 h-3.5" />
              <span>查询</span>
            </button>
          </div>
        </div>
      </div>

      {/* 环节页签 */}
      <div className="border-b border-slate-200 flex items-center gap-8 px-1">
        {STAGE_TABS.map((tab) => {
          const active = stage === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => handleStageChange(tab.key)}
              className={`pb-3 text-sm transition-colors border-b-2 -mb-px ${
                active
                  ? 'text-blue-600 font-semibold border-blue-600'
                  : 'text-slate-500 border-transparent hover:text-slate-800'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {loadError !== null && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl px-4 py-3">
          待审核池加载失败：{loadError}
        </div>
      )}

      {/* 缺陷条目列表 */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-500 border-b border-slate-100">
                <th className="py-3.5 px-4 font-semibold">来源检验单</th>
                <th className="py-3.5 px-4 font-semibold">检验环节</th>
                <th className="py-3.5 px-4 font-semibold">批次号</th>
                <th className="py-3.5 px-4 font-semibold">物料</th>
                <th className="py-3.5 px-4 font-semibold">供应商/客户</th>
                <th className="py-3.5 px-4 font-semibold text-center">不良数量</th>
                <th className="py-3.5 px-4 font-semibold text-center">不良率</th>
                <th className="py-3.5 px-4 font-semibold">不合格现象</th>
                <th className="py-3.5 px-4 font-semibold">检验人</th>
                <th className="py-3.5 px-4 font-semibold">汇入时间</th>
                <th className="py-3.5 px-4 font-semibold">状态</th>
                <th className="py-3.5 px-4 font-semibold text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.length === 0 ? (
                <tr>
                  <td colSpan={12} className="text-center py-14 text-slate-400">
                    {loading ? (
                      <span className="inline-flex items-center gap-2">
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        正在加载待审核池…
                      </span>
                    ) : (
                      '当前条件下暂无不合格待审核记录'
                    )}
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-4 font-mono font-bold text-blue-600 whitespace-nowrap">
                      {item.orderNo}
                    </td>
                    <td className="py-3.5 px-4 text-slate-700 whitespace-nowrap">
                      {typeLabel(item.inspectionType)}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-slate-500 whitespace-nowrap">
                      {item.batchNo}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <div className="font-semibold text-slate-800">{item.materialCode}</div>
                      <div className="text-[11px] text-slate-400">{item.materialName}</div>
                    </td>
                    <td className="py-3.5 px-4 text-slate-700 whitespace-nowrap">
                      {item.supplierName ?? item.customerName ?? '—'}
                    </td>
                    <td className="py-3.5 px-4 text-center whitespace-nowrap">
                      <span className="font-bold font-mono text-rose-600">{item.defectQty}</span>
                      <span className="text-slate-400"> / {item.totalQty}</span>
                    </td>
                    <td className="py-3.5 px-4 text-center font-mono text-rose-600 whitespace-nowrap">
                      {defectRateText(item)}
                    </td>
                    <td className="py-3.5 px-4 max-w-xs">
                      <span
                        className="inline-block px-2 py-0.5 rounded text-[11px] font-medium bg-rose-50 text-rose-600 border border-rose-200 truncate max-w-[220px] align-middle"
                        title={item.defectDescription}
                      >
                        {item.defectDescription}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-slate-700 whitespace-nowrap">
                      {item.inspectorName ?? '—'}
                    </td>
                    <td className="py-3.5 px-4 text-slate-500 whitespace-nowrap">
                      {formatDateTime(item.createdAt)}
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusBadge
                        status={POOL_STATUS_LABEL[item.status] ?? item.status}
                        tone={POOL_STATUS_TONE[item.status] ?? 'slate'}
                      />
                    </td>
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      {item.status === 'PENDING_INITIATE' ? (
                        <button
                          type="button"
                          onClick={() => setInitiateTarget(item)}
                          className="text-xs font-semibold text-blue-600 hover:text-blue-800 inline-flex items-center gap-1"
                        >
                          <FileSignature className="w-3.5 h-3.5" />
                          发起评审
                        </button>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 bg-slate-50/60">
          <span>
            共 <strong className="text-slate-800">{total}</strong> 条 · 第 {page}/{totalPages} 页
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1 || loading}
              className="px-2.5 py-1 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              上一页
            </button>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages || loading}
              className="px-2.5 py-1 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1"
            >
              下一页
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 发起评审弹窗 */}
      {initiateTarget !== null && (
        <InitiateReviewDialog
          item={initiateTarget}
          onClose={() => setInitiateTarget(null)}
          onSubmitted={() => {
            setInitiateTarget(null);
            reloadAll();
          }}
        />
      )}
    </div>
  );
}

interface InitiateReviewDialogProps {
  item: PendingDefectItem;
  onClose: () => void;
  onSubmitted: () => void;
}

/**
 * 发起评审弹窗（v2.6.0 规划 §2.2-4）：选择评审流程 + 紧急程度 + 发起说明，
 * 提交 POST /mrb/pending-pool/initiate。流程下拉预选中适用该条目的生效流程
 * （按 inspectionType → 来源分类匹配 applicableType），留空则由服务端自动匹配。
 */
function InitiateReviewDialog({ item, onClose, onSubmitted }: InitiateReviewDialogProps) {
  const failCategory = useMemo(
    () => inspectionTypeToFailCategory(item.inspectionType),
    [item.inspectionType]
  );

  const [flows, setFlows] = useState<ReviewFlow[]>([]);
  const [flowId, setFlowId] = useState('');
  const [urgencyLevel, setUrgencyLevel] = useState<MRBUrgencyLevel>('NORMAL');
  const [reviewNotes, setReviewNotes] = useState('');
  const [flowsError, setFlowsError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ items?: ReviewFlow[] }>('/review-flows')
      .then((res) => {
        if (cancelled) return;
        const active = (res.items ?? []).filter((flow) => flow.isActive);
        setFlows(active);
        const matched = active.find(
          (flow) => flow.applicableType === failCategory && flow.id !== undefined
        );
        if (matched !== undefined && matched.id !== undefined) setFlowId(matched.id);
      })
      .catch((err) => {
        if (cancelled) return;
        setFlowsError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [failCategory]);

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const review = await api.post<MrbReviewRecord>('/mrb/pending-pool/initiate', {
        pendingDefectId: item.id,
        ...(flowId !== '' ? { flowId } : {}),
        urgencyLevel,
        ...(reviewNotes.trim() !== '' ? { reviewNotes: reviewNotes.trim() } : {}),
      });
      alert(`已发起 MRB 评审：${review.mrbNo}`);
      onSubmitted();
    } catch (err) {
      setSubmitError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">发起 MRB 评审</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* 条目摘要 */}
          <div className="bg-slate-50 border border-slate-100 rounded-xl p-3.5 text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-mono font-bold text-blue-600">{item.orderNo}</span>
              <span className="text-slate-500">{typeLabel(item.inspectionType)}</span>
            </div>
            <div className="text-slate-700">
              {item.materialCode} · {item.materialName} · 批次 {item.batchNo}
            </div>
            <div className="text-rose-600">
              不良 {item.defectQty} 件 · {item.defectDescription}
            </div>
            <div className="text-slate-400">
              来源分类：{FAIL_CATEGORY_LABEL[failCategory] ?? failCategory}
            </div>
          </div>

          {flowsError !== null && (
            <div className="bg-amber-50 border border-amber-200 text-amber-700 text-xs rounded-xl px-3.5 py-2.5 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              评审流程列表加载失败（{flowsError}），提交时将交由服务端自动匹配。
            </div>
          )}

          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1.5">评审流程</span>
            <select
              value={flowId}
              onChange={(e) => setFlowId(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-blue-500"
            >
              <option value="">自动匹配（按不合格来源分类）</option>
              {flows.map((flow) => (
                <option key={flow.id} value={flow.id}>
                  {flow.flowName}（{flow.flowCode}
                  {flow.applicableType === failCategory ? ' · 适用' : ''}）
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1.5">紧急程度</span>
            <select
              value={urgencyLevel}
              onChange={(e) => setUrgencyLevel(e.target.value as MRBUrgencyLevel)}
              className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-blue-500"
            >
              {URGENCY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1.5">
              发起说明 / 建议处置方向（选填）
            </span>
            <textarea
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
              rows={3}
              placeholder="如：不良集中在杆部外径超差，建议工程部评估返修可行性"
              className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 resize-none"
            />
          </label>

          {submitError !== null && (
            <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl px-3.5 py-2.5">
              发起失败：{submitError}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-100 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-xs text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="px-5 py-2 text-xs font-bold text-white bg-[#2563EB] hover:bg-blue-700 rounded-xl shadow-sm flex items-center gap-1.5 transition-colors disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            {submitting ? '提交中…' : '确认发起评审'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PendingMRBPoolPage;
