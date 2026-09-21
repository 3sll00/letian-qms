import React, { useEffect, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { EChart } from '../../components/EChart';
import { api, errorMessage } from '../../lib/api';

import kpiTotal from '../../assets/kpi_total.png';
import kpiPending from '../../assets/kpi_pending.png';
import kpiPassed from '../../assets/kpi_passed.png';
import kpiFailed from '../../assets/kpi_failed.png';
import kpiRate from '../../assets/kpi_rate.png';

/** 与后端 /dashboard/overview 响应对齐（packages/infrastructure dashboard-repository） */
interface DashboardOverview {
  totalInspections: number;
  passRate: number;
  pendingCount: number;
  inspectingCount: number;
  failedCount: number;
  inMRBCount: number;
  stageDistribution: { iqcCount: number; ipqcCount: number; oqcCount: number };
  trendSeries: Array<{ date: string; iqcCount: number; ipqcCount: number; oqcCount: number; passRate: number }>;
  topDefects: Array<{ defectName: string; category: string; count: number }>;
  recentActivities: Array<{ id: string; type: string; title: string; status: string; timestamp: string }>;
}

interface PendingTask {
  id: string;
  orderNo: string;
  type: string;
  material: string;
  qty: number;
  status: string;
}

interface InspectionListResult {
  total: number;
  items: Array<{
    id?: string;
    orderNo: string;
    inspectionType: string;
    materialName: string;
    sampleQty: number;
    status: string;
  }>;
}

const TYPE_LABEL: Record<string, string> = {
  IQC: '来料检验',
  IPQC_CT: '下料检验',
  IPQC_RL: '滚丝检验',
  IPQC_FN: '成品检验',
  OQC_SF: '出货检验',
  OQC_SH: '发货检验',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待检验',
  INSPECTING: '检验中',
  DRAFT: '暂存草稿',
  RE_INSPECTING: '复检中',
  PASSED: '已合格',
  FAILED: '不合格',
  IN_MRB_REVIEW: 'MRB评审中',
  COMPLETED: '已结单',
};

export function DashboardPage() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [ov, pending] = await Promise.all([
          api.get<DashboardOverview>('/dashboard/overview'),
          api.get<InspectionListResult>('/inspections', {
            statuses: 'PENDING,INSPECTING,DRAFT,RE_INSPECTING',
            page: 1,
            pageSize: 6,
          }),
        ]);
        if (cancelled) return;
        setOverview(ov);
        setPendingTasks(
          (pending.items ?? []).map((o) => ({
            id: o.id ?? o.orderNo,
            orderNo: o.orderNo,
            type: TYPE_LABEL[o.inspectionType] ?? o.inspectionType,
            material: o.materialName,
            qty: o.sampleQty,
            status: STATUS_LABEL[o.status] ?? o.status,
          }))
        );
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const today = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Donut Chart: 检验环节分布（IQC / IPQC / OQC，真实聚合）
  const stage = overview?.stageDistribution ?? { iqcCount: 0, ipqcCount: 0, oqcCount: 0 };
  const donutOption: EChartsOption = {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: {
      bottom: 0,
      left: 'center',
      icon: 'rect',
      itemWidth: 12,
      itemHeight: 8,
      textStyle: { color: '#64748B', fontSize: 11 },
      data: ['来料检验 (IQC)', '过程检验 (IPQC)', '出货检验 (OQC)'],
    },
    color: ['#2563EB', '#8B5CF6', '#06B6D4'],
    series: [
      {
        name: '检验环节',
        type: 'pie',
        radius: ['52%', '72%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: false,
        label: { show: false },
        data: [
          { value: stage.iqcCount, name: '来料检验 (IQC)' },
          { value: stage.ipqcCount, name: '过程检验 (IPQC)' },
          { value: stage.oqcCount, name: '出货检验 (OQC)' },
        ],
      },
    ],
  };

  // Trend Line Chart: 质量趋势(近7天) — 每日合格率 + 当日检验量
  const trend = overview?.trendSeries ?? [];
  const lineOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: {
      top: 0,
      right: 10,
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: '#64748B', fontSize: 11 },
      data: ['合格率(%)', '检验量'],
    },
    grid: { top: 30, left: 30, right: 30, bottom: 25, containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: trend.map((d) => d.date.slice(5).replace('-', '/')),
      axisLine: { lineStyle: { color: '#E2E8F0' } },
      axisLabel: { color: '#94A3B8', fontSize: 11 },
    },
    yAxis: [
      {
        type: 'value',
        min: 0,
        max: 100,
        splitLine: { lineStyle: { color: '#F1F5F9' } },
        axisLabel: { color: '#94A3B8', fontSize: 11 },
      },
      {
        type: 'value',
        minInterval: 1,
        splitLine: { show: false },
        axisLabel: { color: '#CBD5E1', fontSize: 11 },
      },
    ],
    series: [
      {
        name: '合格率(%)',
        type: 'line',
        smooth: true,
        showSymbol: true,
        symbolSize: 4,
        data: trend.map((d) => d.passRate),
        lineStyle: { color: '#10B981', width: 2 },
        itemStyle: { color: '#10B981' },
        areaStyle: { color: 'rgba(16, 185, 129, 0.08)' },
      },
      {
        name: '检验量',
        type: 'bar',
        yAxisIndex: 1,
        barWidth: 8,
        data: trend.map((d) => d.iqcCount + d.ipqcCount + d.oqcCount),
        itemStyle: { color: 'rgba(37, 99, 235, 0.35)', borderRadius: [2, 2, 0, 0] },
      },
    ],
  };

  // Bar Chart: 缺陷类型 TOP（真实检验单失败指标聚合）
  const defects = (overview?.topDefects ?? []).slice(0, 8).reverse();
  const barOption: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { top: 15, left: 110, right: 30, bottom: 25 },
    xAxis: {
      type: 'value',
      minInterval: 1,
      splitLine: { lineStyle: { color: '#F1F5F9' } },
      axisLabel: { color: '#94A3B8', fontSize: 11 },
    },
    yAxis: {
      type: 'category',
      data: defects.map((d) => d.defectName),
      axisLine: { lineStyle: { color: '#E2E8F0' } },
      axisTick: { show: false },
      axisLabel: { color: '#64748B', fontSize: 11 },
    },
    series: [
      {
        name: '不合格次数',
        type: 'bar',
        barWidth: 10,
        data: defects.map((d) => ({
          value: d.count,
          label: { show: true, position: 'right', color: '#64748B', fontSize: 11 },
        })),
        itemStyle: { color: '#EF4444', borderRadius: [0, 2, 2, 0] },
      },
    ],
  };

  const kpi = [
    { label: '总检验单数', value: String(overview?.totalInspections ?? '—'), sub: '当前账号可见范围', icon: kpiTotal, accent: 'text-slate-400' },
    { label: '待检验', value: String(overview?.pendingCount ?? '—'), sub: '含草稿与复检', icon: kpiPending, accent: 'text-rose-500' },
    { label: '检验中', value: String(overview?.inspectingCount ?? '—'), sub: '在途任务', icon: kpiPassed, accent: 'text-emerald-500' },
    { label: '不合格', value: String(overview?.failedCount ?? '—'), sub: overview ? `其中 ${overview.inMRBCount} 单进入 MRB` : '', icon: kpiFailed, accent: 'text-rose-500' },
    { label: '综合合格率', value: overview ? `${overview.passRate}%` : '—', sub: '已判定单据口径', icon: kpiRate, accent: 'text-emerald-500' },
  ];

  return (
    <div className="space-y-4">
      {/* Top Header Title */}
      <div>
        <h1 className="text-base font-semibold text-slate-800">检验进度总览</h1>
        <p className="text-xs text-slate-400 mt-0.5">
          {today} · 数据已按当前登录用户的物料权限自动过滤
        </p>
      </div>

      {loadError && (
        <div className="rounded border border-red-200 bg-red-50 px-3.5 py-2 text-xs text-red-700">
          看板数据加载失败：{loadError}
        </div>
      )}

      {/* Row 1: 5 KPI Cards */}
      <div className="grid grid-cols-5 gap-4">
        {kpi.map((c) => (
          <div
            key={c.label}
            className="bg-white border border-slate-100 rounded-lg p-3.5 shadow-sm flex items-center justify-between"
          >
            <div className="space-y-1">
              <div className="text-xs text-slate-400 font-normal">{c.label}</div>
              <div className="text-2xl font-bold text-slate-800 font-mono tracking-tight">{c.value}</div>
              <div className={`text-[11px] ${c.accent}`}>
                <span className="text-slate-400 ml-0.5">{c.sub}</span>
              </div>
            </div>
            <img src={c.icon} alt={c.label} className="w-10 h-10 object-contain" />
          </div>
        ))}
      </div>

      {/* Row 2: Two Charts (Donut + Trend Line) */}
      <div className="grid grid-cols-2 gap-4">
        {/* Left: 检验环节分布 */}
        <div className="bg-white border border-slate-100 rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[13px] font-semibold text-slate-800">检验环节分布</h2>
            <span className="text-[11px] text-slate-400">全部时段 · 真实库聚合</span>
          </div>
          <EChart option={donutOption} style={{ height: '240px' }} />
        </div>

        {/* Right: 质量趋势 (近7天) */}
        <div className="bg-white border border-slate-100 rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[13px] font-semibold text-slate-800">质量趋势 (近7天)</h2>
          </div>
          <EChart option={lineOption} style={{ height: '240px' }} />
        </div>
      </div>

      {/* Row 3: Bottom Row (缺陷 TOP + 待办检验任务) */}
      <div className="grid grid-cols-2 gap-4">
        {/* Left: 缺陷类型 TOP */}
        <div className="bg-white border border-slate-100 rounded-lg p-4 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[13px] font-semibold text-slate-800">缺陷类型 TOP</h2>
            <span className="text-[11px] text-slate-400">取自检验单失败指标</span>
          </div>
          <div className="flex-1 flex items-center">
            <div className="w-full">
              <EChart option={barOption} style={{ height: '220px' }} />
            </div>
          </div>
        </div>

        {/* Right: 待办检验任务 */}
        <div className="bg-white border border-slate-100 rounded-lg p-4 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[13px] font-semibold text-slate-800">待办检验任务</h2>
            <span className="text-[11px] text-slate-400">仅显示有权限的物料</span>
          </div>

          <div className="overflow-x-auto flex-1">
            <table className="w-full text-[12px] text-left">
              <thead>
                <tr className="text-slate-400 border-b border-slate-100 font-normal">
                  <th className="py-2 font-normal">检验单号</th>
                  <th className="py-2 font-normal">类型</th>
                  <th className="py-2 font-normal">物料</th>
                  <th className="py-2 font-normal">数量</th>
                  <th className="py-2 font-normal">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-600">
                {pendingTasks.length === 0 && !loadError && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-400 text-xs">
                      {overview === null ? '加载中...' : '当前账号权限范围内没有待办任务'}
                    </td>
                  </tr>
                )}
                {pendingTasks.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50/60">
                    <td className="py-2.5 font-mono text-blue-600 font-normal">{t.orderNo}</td>
                    <td className="py-2.5">{t.type}</td>
                    <td className="py-2.5 text-slate-700">{t.material}</td>
                    <td className="py-2.5 font-mono">{t.qty}</td>
                    <td className="py-2.5">
                      <span
                        className={`inline-block px-1.5 py-0.5 text-[11px] rounded ${
                          t.status === '待检验'
                            ? 'bg-slate-100 text-slate-500'
                            : 'bg-blue-50 text-blue-600'
                        }`}
                      >
                        {t.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DashboardPage;
