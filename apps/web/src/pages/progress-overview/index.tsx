import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EChartsOption } from 'echarts';
import {
  Activity,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import type { MrbReviewRecord } from '@letian/contracts';
import { EChart } from '../../components/EChart';
import { api, errorMessage } from '../../lib/api';

const REFRESH_INTERVAL_MS = 15_000;
const MRB_CAROUSEL_INTERVAL_MS = 8_000;
const MRB_SLIDE_SCROLL_MS = 900;
const MRB_ROW_HEIGHT = 80;
const TASK_PAGE_SIZE = 8;
const CHART_HEIGHT = 260;

interface DashboardOverview {
  totalInspections: number;
  passRate: number;
  pendingCount: number;
  inspectingCount: number;
  failedCount: number;
  inMRBCount: number;
  stageDistribution: { iqcCount: number; ipqcCount: number; oqcCount: number };
  trendSeries: Array<{
    date: string;
    iqcCount: number;
    ipqcCount: number;
    oqcCount: number;
    passRate: number;
  }>;
  topDefects: Array<{ defectName: string; category: string; count: number }>;
  recentActivities: Array<{ id: string; type: string; title: string; status: string; timestamp: string }>;
}

interface InspectionTask {
  id?: string;
  orderNo: string;
  inspectionType: string;
  materialName: string;
  sampleQty: number;
  status: string;
}

interface InspectionListResponse {
  items?: InspectionTask[];
  list?: InspectionTask[];
}

interface MrbListResponse {
  items?: MrbReviewRecord[];
  list?: MrbReviewRecord[];
  total?: number;
  pendingCount?: number;
  underReviewCount?: number;
}

interface BoardData {
  overview: DashboardOverview | null;
  tasks: InspectionTask[];
  mrbRecords: MrbReviewRecord[];
}

const EMPTY_BOARD_DATA: BoardData = {
  overview: null,
  tasks: [],
  mrbRecords: [],
};

const TYPE_LABEL: Record<string, string> = {
  IQC: '来料检验',
  IPQC_CT: '下料检验',
  IPQC_RL: '滚丝检验',
  IPQC_FN: '成品检验',
  OQC_SF: '委外检验',
  OQC_SH: '出货检验',
  OQC_HEAT: '委外检验',
  OQC_BLACK: '委外检验',
  OQC_ZINC: '委外检验',
  OQC_NICKEL: '委外检验',
  OQC_PHOSPH: '委外检验',
  OQC_DACRO: '委外检验',
  OQC_MACH: '委外检验',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待检验',
  INSPECTING: '检验中',
  DRAFT: '草稿暂存',
  RE_INSPECTING: '复检中',
  PASSED: '已合格',
  FAILED: '不合格',
  IN_MRB_REVIEW: 'MRB评审中',
  COMPLETED: '已结单',
};

const MRB_STATUS_LABEL: Record<string, string> = {
  PENDING_REVIEW: '待评审',
  UNDER_REVIEW: '评审中',
  DISPOSED: '已处置',
  REJECTED: '已驳回',
};

const DISPOSITION_LABEL: Record<string, string> = {
  RETURN_TO_VENDOR: '退货',
  REWORK: '返工 / 返修',
  CONCESSION: '特采',
  SCRAP: '报废',
};

const formatTime = (value: string | Date | undefined): string => {
  if (value === undefined) return '--';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
};

function mrbPriority(status: string): number {
  if (status === 'PENDING_REVIEW') return 0;
  if (status === 'UNDER_REVIEW') return 1;
  return 2;
}

function mrbTone(status: string): string {
  if (status === 'PENDING_REVIEW') return 'border-amber-400/40 bg-amber-400/10 text-amber-200';
  if (status === 'UNDER_REVIEW') return 'border-sky-400/40 bg-sky-400/10 text-sky-200';
  if (status === 'DISPOSED') return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  return 'border-rose-400/40 bg-rose-400/10 text-rose-200';
}

function mrbToneLight(status: string): string {
  if (status === 'PENDING_REVIEW') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (status === 'UNDER_REVIEW') return 'border-sky-200 bg-sky-50 text-sky-700';
  if (status === 'DISPOSED') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  return 'border-rose-200 bg-rose-50 text-rose-700';
}

function taskTone(status: string): string {
  if (status === 'PENDING' || status === 'DRAFT') return 'bg-slate-700 text-slate-200';
  if (status === 'INSPECTING' || status === 'RE_INSPECTING') return 'bg-sky-400/15 text-sky-200';
  return 'bg-rose-400/15 text-rose-200';
}

function taskToneLight(status: string): string {
  if (status === 'PENDING' || status === 'DRAFT') return 'bg-slate-100 text-slate-600';
  if (status === 'INSPECTING' || status === 'RE_INSPECTING') return 'bg-sky-50 text-sky-700';
  return 'bg-rose-50 text-rose-700';
}

function emptyOverview(): DashboardOverview {
  return {
    totalInspections: 0,
    passRate: 0,
    pendingCount: 0,
    inspectingCount: 0,
    failedCount: 0,
    inMRBCount: 0,
    stageDistribution: { iqcCount: 0, ipqcCount: 0, oqcCount: 0 },
    trendSeries: [],
    topDefects: [],
    recentActivities: [],
  };
}

export function ProgressOverviewPage() {
  const boardRef = useRef<HTMLDivElement>(null);
  const carouselTrackRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const [boardData, setBoardData] = useState<BoardData>(EMPTY_BOARD_DATA);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [carouselPlaying, setCarouselPlaying] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setRefreshing(true);
    const results = await Promise.allSettled([
      api.get<DashboardOverview>('/dashboard/overview'),
      api.get<InspectionListResponse>('/inspections', {
        statuses: 'PENDING,INSPECTING,DRAFT,RE_INSPECTING',
        page: 1,
        pageSize: TASK_PAGE_SIZE,
      }),
      api.get<MrbListResponse>('/mrb/records', { page: 1, pageSize: 100 }),
    ]);

    if (requestId !== requestIdRef.current) return;

    const errors: string[] = [];
    setBoardData((previous) => {
      const next: BoardData = { ...previous };
      const [overviewResult, taskResult, mrbResult] = results;

      if (overviewResult.status === 'fulfilled') {
        next.overview = overviewResult.value;
      } else {
        errors.push(`质量指标：${errorMessage(overviewResult.reason)}`);
      }

      if (taskResult.status === 'fulfilled') {
        next.tasks = taskResult.value.items ?? taskResult.value.list ?? [];
      } else {
        errors.push(`待办任务：${errorMessage(taskResult.reason)}`);
      }

      if (mrbResult.status === 'fulfilled') {
        next.mrbRecords = mrbResult.value.items ?? mrbResult.value.list ?? [];
      } else {
        errors.push(`MRB问题：${errorMessage(mrbResult.reason)}`);
      }

      return next;
    });
    setLoadError(errors.length > 0 ? errors.join('；') : null);
    setLastUpdated(new Date());
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      requestIdRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === boardRef.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const sortedMrbRecords = useMemo(
    () =>
      [...boardData.mrbRecords].sort((a, b) => {
        const priority = mrbPriority(a.status) - mrbPriority(b.status);
        if (priority !== 0) return priority;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }),
    [boardData.mrbRecords]
  );

  useEffect(() => {
    setCarouselIndex((current) =>
      sortedMrbRecords.length === 0 ? 0 : Math.min(current, sortedMrbRecords.length - 1)
    );
  }, [sortedMrbRecords.length]);

  useEffect(() => {
    if (!carouselPlaying || sortedMrbRecords.length <= 1) return;
    const timer = window.setInterval(
      () => setCarouselIndex((current) => (current + 1) % sortedMrbRecords.length),
      MRB_CAROUSEL_INTERVAL_MS
    );
    return () => window.clearInterval(timer);
  }, [carouselPlaying, sortedMrbRecords.length]);

  useEffect(() => {
    const track = carouselTrackRef.current;
    if (track === null) return;
    const target = Math.min(
      carouselIndex * MRB_ROW_HEIGHT,
      Math.max(0, track.scrollHeight - track.clientHeight)
    );
    track.scrollTo({ top: target, behavior: 'smooth' });
  }, [carouselIndex, sortedMrbRecords.length]);

  const overview = boardData.overview ?? emptyOverview();
  const trend = overview.trendSeries;
  const defects = [...overview.topDefects].slice(0, 6).reverse();
  const stage = overview.stageDistribution;

  const stageOption: EChartsOption = {
    tooltip: { trigger: 'item', formatter: '{b}: {c} 单 ({d}%)' },
    legend: {
      bottom: 0,
      left: 'center',
      itemWidth: 10,
      itemHeight: 8,
      textStyle: { color: '#475569', fontSize: 11 },
      data: ['来料 IQC', '过程 IPQC', '出货 OQC'],
    },
    color: ['#2563EB', '#7C3AED', '#0EA5E9'],
    series: [
      {
        name: '检验环节',
        type: 'pie',
        radius: ['50%', '72%'],
        center: ['50%', '43%'],
        label: { show: false },
        data: [
          { value: stage.iqcCount, name: '来料 IQC' },
          { value: stage.ipqcCount, name: '过程 IPQC' },
          { value: stage.oqcCount, name: '出货 OQC' },
        ],
      },
    ],
  };

  const trendOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: {
      top: 0,
      right: 0,
      itemWidth: 10,
      itemHeight: 8,
      textStyle: { color: '#475569', fontSize: 11 },
      data: ['合格率', '检验量'],
    },
    grid: { top: 30, left: 28, right: 28, bottom: 22, containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: trend.map((item) => item.date.slice(5).replace('-', '/')),
      axisLine: { lineStyle: { color: '#E2E8F0' } },
      axisLabel: { color: '#64748B', fontSize: 10 },
    },
    yAxis: [
      {
        type: 'value',
        min: 0,
        max: 100,
        splitLine: { lineStyle: { color: '#F1F5F9' } },
        axisLabel: { color: '#64748B', fontSize: 10, formatter: '{value}%' },
      },
      {
        type: 'value',
        minInterval: 1,
        splitLine: { show: false },
        axisLabel: { color: '#94A3B8', fontSize: 10 },
      },
    ],
    series: [
      {
        name: '合格率',
        type: 'line',
        smooth: true,
        showSymbol: true,
        symbolSize: 4,
        data: trend.map((item) => item.passRate),
        lineStyle: { color: '#10B981', width: 2 },
        itemStyle: { color: '#10B981' },
        areaStyle: { color: 'rgba(16, 185, 129, 0.12)' },
      },
      {
        name: '检验量',
        type: 'bar',
        yAxisIndex: 1,
        barWidth: 8,
        data: trend.map((item) => item.iqcCount + item.ipqcCount + item.oqcCount),
        itemStyle: { color: 'rgba(37, 99, 235, 0.4)', borderRadius: [2, 2, 0, 0] },
      },
    ],
  };

  const defectOption: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { top: 10, left: 100, right: 30, bottom: 20 },
    xAxis: {
      type: 'value',
      minInterval: 1,
      splitLine: { lineStyle: { color: '#F1F5F9' } },
      axisLabel: { color: '#64748B', fontSize: 10 },
    },
    yAxis: {
      type: 'category',
      data: defects.map((item) => item.defectName),
      axisLine: { lineStyle: { color: '#E2E8F0' } },
      axisTick: { show: false },
      axisLabel: { color: '#475569', fontSize: 10 },
    },
    series: [
      {
        name: '不合格次数',
        type: 'bar',
        barWidth: 10,
        data: defects.map((item) => ({
          value: item.count,
          label: { show: true, position: 'right', color: '#475569', fontSize: 10 },
        })),
        itemStyle: { color: '#EF4444', borderRadius: [0, 3, 3, 0] },
      },
    ],
  };

  const handleFullscreen = async () => {
    setFullscreenError(null);
    try {
      if (document.fullscreenElement === boardRef.current) {
        await document.exitFullscreen();
      } else if (boardRef.current?.requestFullscreen !== undefined) {
        await boardRef.current.requestFullscreen();
      } else {
        setFullscreenError('当前浏览器不支持全屏投屏，请使用浏览器菜单进入全屏。');
      }
    } catch (err) {
      setFullscreenError(`全屏投屏失败：${errorMessage(err)}`);
    }
  };

  const moveCarousel = (delta: number) => {
    if (sortedMrbRecords.length === 0) return;
    setCarouselIndex(
      (current) => (current + delta + sortedMrbRecords.length) % sortedMrbRecords.length
    );
  };

  const kpis = [
    { label: '总检验单', value: overview.totalInspections, hint: '当前权限范围', icon: ClipboardCheck, color: 'text-sky-600' },
    { label: '待检验', value: overview.pendingCount, hint: '含草稿与复检', icon: Clock3, color: 'text-amber-600' },
    { label: '检验中', value: overview.inspectingCount, hint: '在途任务', icon: Activity, color: 'text-violet-600' },
    { label: '不合格 / MRB', value: `${overview.failedCount} / ${overview.inMRBCount}`, hint: '异常处置关注', icon: ShieldAlert, color: 'text-rose-600' },
    { label: '综合合格率', value: `${overview.passRate}%`, hint: '已判定单据口径', icon: CheckCircle2, color: 'text-emerald-600' },
  ];

  return (
    <section
      ref={boardRef}
      data-testid="progress-overview-board"
      className="min-h-full rounded-2xl bg-white p-4 text-slate-800 shadow-2xl sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.4)]" />
            <h1 className="text-xl font-black tracking-[0.12em] text-slate-900 sm:text-2xl">进度总览</h1>
            <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-600">
              QMS LIVE
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">检验进度与 MRB 不合格品处置 · 面向现场电视投屏</p>
        </div>
        <div className="flex items-center gap-2 text-right">
          <div className="mr-1 hidden sm:block">
            <div className="font-mono text-lg font-semibold tracking-wider text-slate-800">{formatTime(clock)}</div>
            <div className="text-[10px] text-slate-400">上次更新 {formatTime(lastUpdated)}</div>
          </div>
          <button
            type="button"
            data-testid="progress-refresh"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600 transition hover:border-blue-400 hover:text-blue-600 disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            刷新
          </button>
          <button
            type="button"
            data-testid="progress-fullscreen"
            onClick={() => void handleFullscreen()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white transition hover:bg-blue-500"
          >
            {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            {isFullscreen ? '退出全屏' : '投屏全屏'}
          </button>
        </div>
      </div>

      {(loadError !== null || fullscreenError !== null) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <CircleAlert className="h-4 w-4 shrink-0" />
          <span>{fullscreenError ?? `部分数据刷新失败：${loadError}`}</span>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-5">
        {kpis.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="rounded-xl border border-slate-200 bg-white px-3.5 py-3 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[11px] text-slate-500">{item.label}</div>
                  <div className={`mt-1 font-mono text-2xl font-black tracking-tight ${item.color}`}>
                    {loading && boardData.overview === null ? '—' : item.value}
                  </div>
                </div>
                <Icon className={`mt-1 h-5 w-5 ${item.color}`} />
              </div>
              <div className="mt-1 text-[10px] text-slate-400">{item.hint}</div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(330px,0.65fr)]">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800">检验环节分布</h2>
              <span className="text-[10px] text-slate-400">全部时段</span>
            </div>
            <EChart option={stageOption} style={{ height: `${CHART_HEIGHT}px` }} />
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800">质量趋势 · 近 7 天</h2>
              <span className="text-[10px] text-slate-400">自动刷新 {REFRESH_INTERVAL_MS / 1000}s</span>
            </div>
            <EChart option={trendOption} style={{ height: `${CHART_HEIGHT}px` }} />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">缺陷类型 TOP</h2>
            <span className="text-[10px] text-slate-400">实时聚合</span>
          </div>
          <EChart option={defectOption} style={{ height: `${CHART_HEIGHT}px` }} />
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div
          data-testid="mrb-carousel"
          className="flex h-[520px] flex-col rounded-xl border border-rose-200 bg-white p-4 shadow-sm"
        >
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-rose-500" />
                <h2 className="text-sm font-semibold text-slate-800">MRB 问题轮播</h2>
              </div>
              <p className="mt-1 text-[10px] text-slate-500">按表格行逐行向下滚动 · 待评审与评审中优先展示 · 每 {MRB_CAROUSEL_INTERVAL_MS / 1000} 秒切换</p>
            </div>
            <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-1 font-mono text-[10px] font-medium text-rose-600">
              {sortedMrbRecords.length === 0 ? '0 / 0' : `${carouselIndex + 1} / ${sortedMrbRecords.length}`}
            </span>
          </div>

          <div className="mt-3 flex h-[440px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-slate-50/40">
            <div className="grid grid-cols-[minmax(110px,1.1fr)_minmax(110px,1fr)_minmax(160px,1.4fr)_minmax(160px,1.6fr)_minmax(70px,0.6fr)_minmax(90px,0.8fr)_minmax(70px,0.6fr)_minmax(90px,0.8fr)] gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-[10px] font-medium text-slate-500">
              <span>MRB 单号</span>
              <span>来源检验单</span>
              <span>物料</span>
              <span>问题描述</span>
              <span className="text-right">不合格数量</span>
              <span>处置方式</span>
              <span className="text-center">状态</span>
              <span>发现时间</span>
            </div>
            <div
              ref={carouselTrackRef}
              data-testid="mrb-carousel-track"
              className="flex-1 overflow-hidden"
            >
              {sortedMrbRecords.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-slate-500">当前权限范围内暂无 MRB 问题</div>
              ) : (
                <div
                  className="flex flex-col"
                  style={{ transition: `transform ${MRB_SLIDE_SCROLL_MS}ms cubic-bezier(0.45, 0.05, 0.2, 1)` }}
                >
                  {sortedMrbRecords.map((record, index) => {
                    const isActive = index === carouselIndex;
                    return (
                      <div
                        key={record.id}
                        data-testid="mrb-slide"
                        aria-hidden={!isActive}
                        className={`grid h-[80px] grid-cols-[minmax(110px,1.1fr)_minmax(110px,1fr)_minmax(160px,1.4fr)_minmax(160px,1.6fr)_minmax(70px,0.6fr)_minmax(90px,0.8fr)_minmax(70px,0.6fr)_minmax(90px,0.8fr)] items-center gap-2 border-b border-slate-100 px-4 text-xs transition-colors ${
                          isActive ? 'bg-rose-50 text-slate-900' : 'text-slate-500'
                        }`}
                      >
                        <span className="truncate font-mono font-semibold text-rose-600" title={record.mrbNo}>
                          {record.mrbNo}
                        </span>
                        <span className="truncate font-mono text-blue-600" title={record.sourceOrderNo}>
                          {record.sourceOrderNo}
                        </span>
                        <span className="truncate" title={record.materialName}>
                          {record.materialName}
                        </span>
                        <span className="truncate" title={record.defectDescription}>
                          {record.defectDescription}
                        </span>
                        <span className={`text-right font-mono font-bold ${isActive ? 'text-rose-600' : 'text-rose-500/80'}`}>
                          {record.defectQty}
                        </span>
                        <span className="truncate">
                          {DISPOSITION_LABEL[record.disposition ?? ''] ?? '待定'}
                        </span>
                        <span className="flex justify-center">
                          <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${mrbToneLight(record.status)}`}>
                            {MRB_STATUS_LABEL[record.status] ?? record.status}
                          </span>
                        </span>
                        <span className="truncate font-mono text-[11px] text-slate-500">
                          {formatTime(record.createdAt).slice(0, 16)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3">
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="上一条 MRB 问题"
                onClick={() => moveCarousel(-1)}
                disabled={sortedMrbRecords.length <= 1}
                className="rounded-md p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label={carouselPlaying ? '暂停 MRB 轮播' : '播放 MRB 轮播'}
                data-testid="mrb-carousel-toggle"
                onClick={() => setCarouselPlaying((playing) => !playing)}
                disabled={sortedMrbRecords.length <= 1}
                className="rounded-md p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30"
              >
                {carouselPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
              <button
                type="button"
                aria-label="下一条 MRB 问题"
                onClick={() => moveCarousel(1)}
                disabled={sortedMrbRecords.length <= 1}
                className="rounded-md p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <span className="text-[10px] text-slate-500">{carouselPlaying ? '自动滚动中' : '已暂停'}</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">待办检验任务</h2>
            <span className="text-[10px] text-slate-400">当前权限范围 · 前 {TASK_PAGE_SIZE} 条</span>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-xs">
              <thead className="border-b border-slate-200 text-[10px] text-slate-500">
                <tr>
                  <th className="px-2 py-2 font-normal">检验单号</th>
                  <th className="px-2 py-2 font-normal">类型</th>
                  <th className="px-2 py-2 font-normal">物料</th>
                  <th className="px-2 py-2 font-normal">数量</th>
                  <th className="px-2 py-2 font-normal">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {boardData.tasks.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-2 py-8 text-center text-slate-400">
                      {loading ? '正在加载待办任务…' : '当前没有待办检验任务'}
                    </td>
                  </tr>
                ) : (
                  boardData.tasks.map((task) => (
                    <tr key={task.id ?? task.orderNo} className="text-slate-600">
                      <td className="px-2 py-2.5 font-mono text-blue-600">{task.orderNo}</td>
                      <td className="px-2 py-2.5">{TYPE_LABEL[task.inspectionType] ?? task.inspectionType}</td>
                      <td className="max-w-[200px] truncate px-2 py-2.5 text-slate-700">{task.materialName}</td>
                      <td className="px-2 py-2.5 font-mono">{task.sampleQty}</td>
                      <td className="px-2 py-2.5">
                        <span className={`rounded px-1.5 py-1 text-[10px] ${taskToneLight(task.status)}`}>
                          {STATUS_LABEL[task.status] ?? task.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

export default ProgressOverviewPage;
