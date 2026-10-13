import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  Download,
  FileSignature,
  RefreshCw,
  RotateCcw,
  Search,
} from 'lucide-react';
import type { MRBStatus, MrbReviewRecord } from '@letian/contracts';
import { api, errorMessage } from '../../lib/api';
import { StatusBadge } from '../../components/StatusBadge';
import { DateInput } from '../../components/common/DateInput';
import { ReviewDispositionDrawer } from './ReviewDispositionDrawer';
import {
  MRB_DISPOSITION_OPTIONS,
  MRB_TABS,
  type MrbTabKey,
  dispositionLabel,
  statusLabel,
  statusTone,
} from './mrbMeta';

/**
 * MRB 不合格品处置（整合单页）
 *
 * 口径与结构依据 docs/19-MRB不合格品处置页整合设计.md：
 * - 阶段 1「不合格台账」→ 判定不合格即自动汇入，**页面无人工发起入口**（docs/43）；
 * - 阶段 2「MRB 评审与处置」→ 本页处置列表 + 行内【评审】抽屉（ReviewDispositionDrawer）。
 *
 * 数据口径：列表与 5 项 KPI 全部取 `GET /mrb/records`，KPI 由服务端在 PBAC 过滤后统计，
 * 页面**不得**用当页数据自行推算（分页下必然失真）。
 */

const PAGE_SIZE = 20;
/** 导出报表单次拉取上限（与接口 pageSize 上限一致） */
const EXPORT_PAGE_SIZE = 100;

interface MrbListResponse {
  items?: MrbReviewRecord[];
  list?: MrbReviewRecord[];
  total?: number;
  pendingCount?: number;
  /**
   * 不合格台账待发起条数。自动发起（docs/43）后正常链路恒为 0，
   * 保留字段仅为兼容历史接口形态；页面已不再消费。
   */
  pendingPoolCount?: number;
  underReviewCount?: number;
  totalReviewedCount?: number;
  disposedCount?: number;
  monthlyReviewRate?: number;
}

interface MrbKpi {
  pendingCount: number;
  underReviewCount: number;
  totalReviewedCount: number;
  disposedCount: number;
  monthlyReviewRate: number;
}

const EMPTY_KPI: MrbKpi = {
  pendingCount: 0,
  underReviewCount: 0,
  totalReviewedCount: 0,
  disposedCount: 0,
  monthlyReviewRate: 0,
};

interface MrbFilters {
  mrbNo: string;
  sourceOrderNo: string;
  disposition: string;
  dateFrom: string;
  dateTo: string;
}

const EMPTY_FILTERS: MrbFilters = {
  mrbNo: '',
  sourceOrderNo: '',
  disposition: '',
  dateFrom: '',
  dateTo: '',
};

/** 页签状态谓词 + 筛选条件 → 服务端查询参数（空值一律不下发） */
function buildQuery(
  statuses: readonly MRBStatus[],
  filters: MrbFilters,
  page: number,
  pageSize: number
): Record<string, string | number | undefined> {
  const query: Record<string, string | number | undefined> = { page, pageSize };
  if (statuses.length > 0) query.status = statuses.join(',');
  if (filters.mrbNo.trim() !== '') query.mrbNo = filters.mrbNo.trim();
  if (filters.sourceOrderNo.trim() !== '') query.sourceOrderNo = filters.sourceOrderNo.trim();
  if (filters.disposition !== '') query.disposition = filters.disposition;
  if (filters.dateFrom !== '') query.dateFrom = filters.dateFrom;
  if (filters.dateTo !== '') query.dateTo = filters.dateTo;
  return query;
}

/** 筛选栏是否填了任一「非状态」条件（页签本身就是状态条件，不计入） */
function hasActiveFilters(filters: MrbFilters): boolean {
  return (
    filters.mrbNo.trim() !== '' ||
    filters.sourceOrderNo.trim() !== '' ||
    filters.disposition !== '' ||
    filters.dateFrom !== '' ||
    filters.dateTo !== ''
  );
}

/**
 * 在同一次筛选条件下，按页签顺序找出第一个真正有数据的页签（都没有则返回 null）。
 *
 * 背景（docs/19 §7）：页签与筛选栏「评审状态」下拉同源，默认停在「待评审」。
 * 只填单号 / 来源单 / 日期等条件时，命中的单据可能落在别的状态上；不做这一步的话，
 * 用户看到的是「当前条件下暂无 MRB 处置记录」，只能逐个页签试探，误判成「查不到」。
 * 命中数一律取接口 `total`（`pageSize=1`，只要计数不要数据），不由当页数据推算。
 */
async function findTabWithRecords(
  filters: MrbFilters,
  currentTab: MrbTabKey
): Promise<MrbTabKey | null> {
  const candidates = MRB_TABS.filter((item) => item.key !== 'ALL' && item.key !== currentTab);
  for (const candidate of candidates) {
    const res = await api.get<MrbListResponse>(
      '/mrb/records',
      buildQuery(candidate.statuses, filters, 1, 1)
    );
    if ((res.total ?? 0) > 0) return candidate.key;
  }
  return null;
}

/** 导出报表列定义（与表格十列 + 处置方式一致） */
const EXPORT_COLUMNS: readonly {
  label: string;
  pick: (record: MrbReviewRecord) => string | number;
}[] = [
  { label: 'MRB单号', pick: (record) => record.mrbNo },
  { label: '来源检验单', pick: (record) => record.sourceOrderNo },
  { label: '物料编码', pick: (record) => record.materialCode },
  { label: '物料名称', pick: (record) => record.materialName },
  { label: '不合格原因', pick: (record) => record.defectDescription },
  { label: '不合格数量', pick: (record) => record.defectQty },
  {
    label: '检验人',
    pick: (record) => (record.inspectorName !== undefined ? record.inspectorName : '-'),
  },
  { label: '发现日期', pick: (record) => record.createdAt.slice(0, 10) },
  { label: '评审状态', pick: (record) => statusLabel(record.status) },
  { label: '处置方式', pick: (record) => dispositionLabel(record.disposition) },
];

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(records: readonly MrbReviewRecord[]): string {
  const lines = [EXPORT_COLUMNS.map((column) => csvEscape(column.label)).join(',')];
  for (const record of records) {
    lines.push(EXPORT_COLUMNS.map((column) => csvEscape(column.pick(record))).join(','));
  }
  return lines.join('\r\n');
}

function downloadCsv(filename: string, content: string): void {
  // 前置 BOM 保证 Excel 直接打开中文不乱码
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

interface MrbPageProps {
  /**
   * 跳转「不合格待审核池」工作台入口（v2.6.0 未结模块：挂载至主菜单与 MRB 页面子标签）。
   * 由 App 注入导航回调；未注入时页头不渲染该入口。
   */
  onOpenPendingPool?: () => void;
}

export function MrbPage({ onOpenPendingPool }: MrbPageProps = {}) {
  // 默认落在「待评审」页签，与 WPS图片(13) 的初始视图一致；
  // 跨状态检索由筛选栏「评审状态 = 全部」完成（同一 tab 状态的两个入口）
  const [tab, setTab] = useState<MrbTabKey>('PENDING_REVIEW');
  const [draftFilters, setDraftFilters] = useState<MrbFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<MrbFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  /** 每点一次【查询】自增：筛选值一字未改时也要真的重查一次，同时充当自动跳转的触发标记 */
  const [searchToken, setSearchToken] = useState(0);
  /** 已被自动跳转消费掉的 searchToken（StrictMode 下 effect 会连跑两次，用 token 幂等去重） */
  const autoJumpTokenRef = useRef(0);

  const [records, setRecords] = useState<MrbReviewRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [kpi, setKpi] = useState<MrbKpi>(EMPTY_KPI);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeRecord, setActiveRecord] = useState<MrbReviewRecord | null>(null);

  const tabStatuses = useMemo<readonly MRBStatus[]>(
    () => MRB_TABS.find((item) => item.key === tab)?.statuses ?? [],
    [tab]
  );

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<MrbListResponse>(
        '/mrb/records',
        buildQuery(tabStatuses, appliedFilters, page, PAGE_SIZE)
      );
      setRecords(res.items ?? res.list ?? []);
      setTotal(res.total ?? 0);
      setKpi({
        pendingCount: res.pendingCount ?? 0,
        underReviewCount: res.underReviewCount ?? 0,
        totalReviewedCount: res.totalReviewedCount ?? 0,
        disposedCount: res.disposedCount ?? 0,
        monthlyReviewRate: res.monthlyReviewRate ?? 0,
      });
      setLoadError(null);

      // 本次由【查询】触发、当前页签却查不到数据时，自动跳到同条件下真有数据的页签
      // （docs/19 §7）。只有点【查询】才跳：手动点页签不跳，否则会与「我就想看这个页签」打架。
      if (
        searchToken > 0 &&
        autoJumpTokenRef.current !== searchToken &&
        (res.total ?? 0) === 0 &&
        hasActiveFilters(appliedFilters)
      ) {
        autoJumpTokenRef.current = searchToken;
        const fallback = await findTabWithRecords(appliedFilters, tab);
        if (fallback !== null) {
          setTab(fallback);
          setPage(1);
        }
      }
    } catch (err) {
      setLoadError(errorMessage(err));
      setRecords([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [tabStatuses, appliedFilters, page, tab, searchToken]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleSearch = () => {
    setAppliedFilters(draftFilters);
    setPage(1);
    // 同一份条件重复点【查询】时上面的两个 setState 都是同值，effect 不会重跑，
    // 这里用自增 token 兜底，保证每次都真的查一次
    setSearchToken((token) => token + 1);
  };

  const handleReset = () => {
    setDraftFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    setPage(1);
  };

  const handleTabChange = (next: MrbTabKey) => {
    setTab(next);
    setPage(1);
  };

  const handleExport = async () => {
    try {
      setExporting(true);
      const res = await api.get<MrbListResponse>(
        '/mrb/records',
        buildQuery(tabStatuses, appliedFilters, 1, EXPORT_PAGE_SIZE)
      );
      const rows = res.items ?? res.list ?? [];
      if (rows.length === 0) {
        alert('当前查询条件下没有可导出的 MRB 处置记录。');
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      downloadCsv(`MRB不合格品处置-${stamp}.csv`, toCsv(rows));
      if ((res.total ?? rows.length) > rows.length) {
        alert(
          `已导出前 ${rows.length} 条（接口单次上限 ${EXPORT_PAGE_SIZE} 条），当前条件共 ${res.total} 条。请收窄查询条件后分批导出。`
        );
      }
    } catch (err) {
      alert(`导出报表失败: ${errorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const kpiCards: readonly {
    key: keyof MrbKpi;
    title: string;
    hint: string;
    value: string;
    icon: React.ComponentType<{ className?: string }>;
    iconClass: string;
    valueClass: string;
  }[] = [
    {
      key: 'pendingCount',
      title: '待评审',
      hint: '已发起、待会签',
      value: `${kpi.pendingCount} 份`,
      icon: Clock,
      iconClass: 'bg-amber-50 text-amber-600 border-amber-200',
      valueClass: 'text-slate-900',
    },
    {
      key: 'underReviewCount',
      title: '评审中',
      hint: '会签流转中',
      value: `${kpi.underReviewCount} 份`,
      icon: Search,
      iconClass: 'bg-blue-50 text-blue-600 border-blue-200',
      valueClass: 'text-slate-900',
    },
    {
      key: 'totalReviewedCount',
      title: '已评审',
      hint: '累计已有评审结论',
      value: `${kpi.totalReviewedCount} 份`,
      icon: ClipboardList,
      iconClass: 'bg-purple-50 text-purple-600 border-purple-200',
      valueClass: 'text-slate-900',
    },
    {
      key: 'disposedCount',
      title: '已处置',
      hint: '闭环完成',
      value: `${kpi.disposedCount} 份`,
      icon: CheckCircle2,
      iconClass: 'bg-emerald-50 text-emerald-600 border-emerald-200',
      valueClass: 'text-emerald-600',
    },
    {
      key: 'monthlyReviewRate',
      title: '本月评审率',
      hint: '本月已处置 / 本月发起',
      value: `${kpi.monthlyReviewRate}%`,
      icon: BarChart3,
      iconClass: 'bg-rose-50 text-rose-500 border-rose-200',
      valueClass: 'text-slate-900',
    },
  ];

  return (
    <div className="space-y-5">
      {/* 页头：标题 + 导出报表 / 发起评审 */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">MRB不合格品处置</h2>
          {/*
            口径（docs/43-不合格判定自动发起MRB评审设计.md）：判定不合格即**自动创建 MRB
            评审单**并进入会签，页面无人工发起入口 —— 原「+ 发起评审」按钮与「待发起评审」
            计数胶囊（docs/39 §2 D3）已随客户口径变更移除。
          */}
          <p className="text-xs text-slate-500 mt-1">
            <span>不合格品评审与处置 · 判定不合格自动进入评审</span>
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {onOpenPendingPool !== undefined && (
            <button
              type="button"
              onClick={onOpenPendingPool}
              title="进入不合格待审核池工作台（v2.6.0 未结模块）"
              className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 shadow-sm flex items-center gap-1.5 transition-colors"
            >
              <ClipboardList className="w-3.5 h-3.5 text-amber-600" />
              <span>待审核池</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 shadow-sm flex items-center gap-1.5 transition-colors disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5 text-blue-600" />
            <span>{exporting ? '导出中…' : '导出报表'}</span>
          </button>
        </div>
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
                <div className={`text-2xl font-black font-mono mt-1 ${card.valueClass}`}>
                  {card.value}
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
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1.5">MRB单号</span>
            <input
              type="text"
              value={draftFilters.mrbNo}
              onChange={(e) => setDraftFilters({ ...draftFilters, mrbNo: e.target.value })}
              placeholder="如 MRB-20260706-001"
              className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1.5">来源检验单</span>
            <input
              type="text"
              value={draftFilters.sourceOrderNo}
              onChange={(e) => setDraftFilters({ ...draftFilters, sourceOrderNo: e.target.value })}
              placeholder="如 IQC-20260706-0002"
              className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1.5">评审状态</span>
            <select
              value={tab}
              onChange={(e) => handleTabChange(e.target.value as MrbTabKey)}
              className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-blue-500"
            >
              {MRB_TABS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.key === 'ALL' ? '全部' : item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1.5">处置方式</span>
            <select
              value={draftFilters.disposition}
              onChange={(e) => setDraftFilters({ ...draftFilters, disposition: e.target.value })}
              className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-blue-500"
            >
              <option value="">全部</option>
              {MRB_DISPOSITION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1.5">日期</span>
            <div className="flex items-center gap-2">
              <DateInput
                wrapClassName="flex-1"
                placeholder="开始日期"
                value={draftFilters.dateFrom}
                onChange={(e) => setDraftFilters({ ...draftFilters, dateFrom: e.target.value })}
                className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-blue-500"
              />
              <span className="text-slate-400 text-xs shrink-0">~</span>
              <DateInput
                wrapClassName="flex-1"
                placeholder="结束日期"
                value={draftFilters.dateTo}
                onChange={(e) => setDraftFilters({ ...draftFilters, dateTo: e.target.value })}
                className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2.5 mt-3.5">
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

      {/* 状态页签 */}
      <div className="border-b border-slate-200 flex items-center gap-8 px-1">
        {MRB_TABS.filter((item) => item.key !== 'ALL').map((item) => {
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => handleTabChange(item.key)}
              className={`pb-3 text-sm transition-colors border-b-2 -mb-px ${
                active
                  ? 'text-blue-600 font-semibold border-blue-600'
                  : 'text-slate-500 border-transparent hover:text-slate-800'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {loadError !== null && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl px-4 py-3">
          MRB 处置列表加载失败：{loadError}
        </div>
      )}

      {/* 处置列表 */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-500 border-b border-slate-100">
                <th className="py-3.5 px-4 font-semibold">MRB单号</th>
                <th className="py-3.5 px-4 font-semibold">来源检验单</th>
                <th className="py-3.5 px-4 font-semibold">物料编码</th>
                <th className="py-3.5 px-4 font-semibold">物料名称</th>
                <th className="py-3.5 px-4 font-semibold">不合格原因</th>
                <th className="py-3.5 px-4 font-semibold text-center">不合格数量</th>
                <th className="py-3.5 px-4 font-semibold">检验人</th>
                <th className="py-3.5 px-4 font-semibold">发现日期</th>
                <th className="py-3.5 px-4 font-semibold">评审状态</th>
                <th className="py-3.5 px-4 font-semibold text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {records.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center py-14 text-slate-400">
                    {loading ? (
                      <span className="inline-flex items-center gap-2">
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        正在加载 MRB 处置记录…
                      </span>
                    ) : (
                      '当前条件下暂无 MRB 处置记录'
                    )}
                  </td>
                </tr>
              ) : (
                records.map((record) => (
                  <tr key={record.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-4 font-mono font-bold text-blue-600 whitespace-nowrap">
                      {record.mrbNo}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-slate-500 whitespace-nowrap">
                      {record.sourceOrderNo}
                    </td>
                    <td className="py-3.5 px-4 font-semibold text-slate-800 whitespace-nowrap">
                      {record.materialCode}
                    </td>
                    <td className="py-3.5 px-4 text-slate-700">{record.materialName}</td>
                    <td className="py-3.5 px-4 max-w-xs">
                      <span
                        className="inline-block px-2 py-0.5 rounded text-[11px] font-medium bg-rose-50 text-rose-600 border border-rose-200 truncate max-w-[220px] align-middle"
                        title={record.defectDescription}
                      >
                        {record.defectDescription}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-center font-bold font-mono text-rose-600">
                      {record.defectQty}
                    </td>
                    <td className="py-3.5 px-4 text-slate-700 whitespace-nowrap">
                      {record.inspectorName !== undefined ? record.inspectorName : '-'}
                    </td>
                    <td className="py-3.5 px-4 text-slate-500 whitespace-nowrap">
                      {record.createdAt.slice(0, 10)}
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusBadge status={statusLabel(record.status)} tone={statusTone(record.status)} />
                    </td>
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setActiveRecord(record)}
                        className="text-xs font-semibold text-blue-600 hover:text-blue-800 inline-flex items-center gap-1"
                      >
                        <FileSignature className="w-3.5 h-3.5" />
                        评审
                      </button>
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

      {/* 阶段 2：评审与处置抽屉 */}
      <ReviewDispositionDrawer
        record={activeRecord}
        onClose={() => setActiveRecord(null)}
        onChanged={(updated) => {
          // 回填最新处置结果：抽屉据此把状态切到「已处置」并禁用重复提交，
          // 同时保留响应里的复检单号等派生字段（列表刷新仍以接口为准）。
          setActiveRecord(updated);
          void loadRecords();
        }}
      />
    </div>
  );
}
