import React, { useEffect, useState } from 'react';
import {
  TrendingUp,
  ShieldAlert,
  CheckCircle,
  Cpu,
  ArrowUpRight,
  AlertTriangle,
  Flame,
  Activity,
  Zap,
} from 'lucide-react';
import type { EChartsOption } from 'echarts';
import { EChart } from '../../components/EChart';
import { api, errorMessage } from '../../lib/api';

interface DefectDistributionItem {
  name: string;
  value: number;
  percentage: string;
}

interface WeeklyTrend {
  dates: string[];
  yieldRates: number[];
  inspectionCounts: number[];
  defectCounts: number[];
}

interface InterceptionEvent {
  id: string;
  time: string;
  station: string;
  batch: string;
  item: string;
  mesStatus: string;
}

/** GET /api/v1/dashboard/stats 响应（后端 KyselyDashboardRepository.getStats） */
interface DashboardStats {
  todayInspections: number;
  yieldRate: number;
  interceptedBatches: number;
  pendingMrb: number;
  defectDistribution: DefectDistributionItem[];
  weeklyTrend: WeeklyTrend;
  interceptionEvents: InterceptionEvent[];
}

/** GET /api/v1/integration/equipment 单条设备（设备清单为进程内 MES 网关目录，无数据库表） */
interface EquipmentItem {
  id: string;
  equipmentCode: string;
  status: string;
}

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [equipment, setEquipment] = useState<{ online: number; total: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<DashboardStats>('/dashboard/stats')
      .then((data) => {
        setStats(data);
        setLoadError(null);
      })
      .catch((err) => {
        setLoadError(errorMessage(err));
        console.error('Failed to load dashboard stats:', err);
      });

    // 机台联网率取自真实设备清单，而不是统计接口里的固定值
    api
      .get<EquipmentItem[]>('/integration/equipment')
      .then((list) => {
        setEquipment({
          online: list.filter((item) => item.status === 'ONLINE').length,
          total: list.length,
        });
      })
      .catch((err) => console.error('Failed to load equipment list:', err));
  }, []);

  if (loadError !== null) {
    return (
      <div className="flex items-center justify-center h-64 text-rose-300 bg-rose-950/30 border border-rose-500/40 rounded-xl text-sm px-4 text-center">
        看板数据加载失败：{loadError}
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400">
        <Activity className="w-6 h-6 animate-spin mr-2 text-sky-400" />
        加载工业态势中枢实时数据...
      </div>
    );
  }

  // ECharts Ring Chart (Defect Distribution)
  const donutOption: EChartsOption = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      formatter: '{b}: {c} 次 ({d}%)',
    },
    legend: {
      bottom: '0%',
      left: 'center',
      textStyle: {
        color: '#94A3B8',
        fontSize: 11,
      },
      itemWidth: 10,
      itemHeight: 10,
    },
    series: [
      {
        name: '缺陷类型',
        type: 'pie',
        radius: ['52%', '76%'],
        center: ['50%', '42%'],
        avoidLabelOverlap: false,
        itemStyle: {
          borderRadius: 4,
          borderColor: '#0B1120',
          borderWidth: 2,
        },
        label: {
          show: false,
        },
        emphasis: {
          label: {
            show: true,
            fontSize: 13,
            fontWeight: 'bold',
            color: '#F8FAFC',
          },
        },
        data: stats.defectDistribution.map((d, i) => {
          const colors = ['#F43F5E', '#F59E0B', '#0284C7', '#8B5CF6', '#10B981'];
          return {
            name: d.name,
            value: d.value,
            itemStyle: { color: colors[i % colors.length] },
          };
        }),
      },
    ],
  };

  // 合格率轴范围随真实数据自适应：种子库合格率约 40%~60%，
  // 固定 98~100 的轴会让折线整条落在可视区之外
  const yieldValues = stats.weeklyTrend.yieldRates;
  const yieldMin = yieldValues.length > 0 ? Math.min(...yieldValues) : 0;
  const yieldMax = yieldValues.length > 0 ? Math.max(...yieldValues) : 100;
  const axisPadding = Math.max(2, Math.round((yieldMax - yieldMin) * 0.2));
  const yAxisMin = Math.max(0, Math.floor(yieldMin - axisPadding));
  const yAxisMax = Math.min(100, Math.ceil(yieldMax + axisPadding));

  // ECharts Trend Line Chart (Weekly Yield)
  const lineOption: EChartsOption = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1E293B',
      borderColor: '#334155',
      textStyle: { color: '#F8FAFC' },
    },
    grid: {
      top: '12%',
      left: '3%',
      right: '4%',
      bottom: '10%',
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: stats.weeklyTrend.dates,
      axisLine: { lineStyle: { color: '#334155' } },
      axisLabel: { color: '#94A3B8', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      min: yAxisMin,
      max: yAxisMax,
      axisLine: { lineStyle: { color: '#334155' } },
      splitLine: { lineStyle: { color: '#1E293B' } },
      axisLabel: {
        color: '#94A3B8',
        formatter: '{value}%',
        fontSize: 11,
      },
    },
    series: [
      {
        name: '产品综合合格率',
        type: 'line',
        smooth: true,
        data: stats.weeklyTrend.yieldRates,
        itemStyle: { color: '#06B6D4' },
        lineStyle: { width: 3, color: '#06B6D4' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(6,182,212,0.35)' },
              { offset: 1, color: 'rgba(6,182,212,0.0)' },
            ],
          },
        },
      },
    ],
  };

  // ECharts Bar Chart (Defect Breakdown per Day)
  const barOption: EChartsOption = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: '#1E293B',
      borderColor: '#334155',
      textStyle: { color: '#F8FAFC' },
    },
    grid: {
      top: '12%',
      left: '3%',
      right: '4%',
      bottom: '10%',
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: stats.weeklyTrend.dates,
      axisLine: { lineStyle: { color: '#334155' } },
      axisLabel: { color: '#94A3B8', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: '#334155' } },
      splitLine: { lineStyle: { color: '#1E293B' } },
      axisLabel: { color: '#94A3B8', fontSize: 11 },
    },
    series: [
      {
        name: '质检抽样批次数',
        type: 'bar',
        data: stats.weeklyTrend.inspectionCounts,
        itemStyle: { color: '#3B82F6', borderRadius: [4, 4, 0, 0] },
      },
      {
        name: '不良拦截批次',
        type: 'bar',
        data: stats.weeklyTrend.defectCounts,
        itemStyle: { color: '#F43F5E', borderRadius: [4, 4, 0, 0] },
      },
    ],
  };

  return (
    <div className="space-y-6">
      {/* 4 KPI Top Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Today Inspections */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-lg flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-400 font-medium">今日完成检验批次</div>
            <div className="text-2xl font-bold font-mono text-white mt-1">
              {stats.todayInspections}{' '}
              <span className="text-xs text-emerald-400 font-normal ml-1">
                +14.2% <ArrowUpRight className="inline w-3 h-3" />
              </span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1 font-mono">覆盖 IQC/IPQC/FQC</div>
          </div>
          <div className="w-12 h-12 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400">
            <CheckCircle className="w-6 h-6" />
          </div>
        </div>

        {/* Card 2: Yield Rate */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-lg flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-400 font-medium">整厂综合直通率 (FPY)</div>
            <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">
              {stats.yieldRate}%
            </div>
            <div className="text-[11px] text-slate-400 mt-1 font-mono">目标阈值 ≥99.0%</div>
          </div>
          <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <TrendingUp className="w-6 h-6" />
          </div>
        </div>

        {/* Card 3: Intercepted Batches */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-lg flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-400 font-medium">MES 触发硬拦截批次</div>
            <div className="text-2xl font-bold font-mono text-rose-400 mt-1">
              {stats.interceptedBatches}{' '}
              <span className="text-xs bg-rose-500/20 text-rose-300 px-1.5 py-0.5 rounded border border-rose-500/30">
                机台锁死
              </span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1 font-mono">下料/热处理工序</div>
          </div>
          <div className="w-12 h-12 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
            <ShieldAlert className="w-6 h-6" />
          </div>
        </div>

        {/* Card 4: Equipment Connectivity */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-lg flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-400 font-medium">关键机台联网率</div>
            <div className="text-2xl font-bold font-mono text-sky-400 mt-1">
              {equipment && equipment.total > 0
                ? Number(((equipment.online / equipment.total) * 100).toFixed(1))
                : 0}
              %
            </div>
            <div className="text-[11px] text-slate-400 mt-1 font-mono">
              {equipment ? `${equipment.online} / ${equipment.total} 台在线实时通讯` : '设备清单加载中...'}
            </div>
          </div>
          <div className="w-12 h-12 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400">
            <Cpu className="w-6 h-6" />
          </div>
        </div>
      </div>

      {/* Main Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Trend Line (Span 2) */}
        <div className="lg:col-span-2 bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Zap className="w-4 h-4 text-cyan-400" />
                近 7 日紧固件合格率与质量波动趋势
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">连续式热处理及精密下料 SPC 监控带</p>
            </div>
            <span className="text-xs font-mono text-cyan-400 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-500/30">
              动态刷新中
            </span>
          </div>
          <EChart option={lineOption} style={{ height: '300px' }} />
        </div>

        {/* Donut Chart (Span 1) */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Flame className="w-4 h-4 text-rose-400" />
                高频不良类型分布
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">柏拉图 Pareto 分析源</p>
            </div>
          </div>
          <EChart option={donutOption} style={{ height: '300px' }} />
        </div>
      </div>

      {/* Bottom Row: Bar chart & Live Interceptions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Bar chart (Span 2) */}
        <div className="lg:col-span-2 bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Activity className="w-4 h-4 text-blue-400" />
                各工段每日检验量与不合格批对比
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">下料 / 冷镦 / 搓丝 / 调质 / 包装</p>
            </div>
          </div>
          <EChart option={barOption} style={{ height: '280px' }} />
        </div>

        {/* Real-time Interception Feed (Span 1) */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-lg flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              当前 MES 拦截锁定实况
            </h2>
            <span className="text-[10px] bg-rose-950/80 text-rose-400 px-2 py-0.5 rounded border border-rose-500/30">
              物理停机
            </span>
          </div>

          <div className="space-y-3 flex-1 overflow-y-auto">
            {stats.interceptionEvents.map((evt) => (
              <div
                key={evt.id}
                className="p-3 rounded-lg bg-rose-950/30 border border-rose-500/30 space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-bold text-rose-300">{evt.station}</span>
                  <span className="text-[10px] font-mono text-slate-400">{evt.time}</span>
                </div>
                <div className="text-xs text-slate-200">
                  批次: <span className="font-mono text-amber-300">{evt.batch}</span>
                </div>
                <div className="text-xs text-rose-400 font-medium">原因: {evt.item}</div>
                <div className="text-[11px] text-emerald-400 bg-slate-950/60 px-2 py-1 rounded border border-slate-800 flex items-center justify-between">
                  <span>{evt.mesStatus}</span>
                  <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
                </div>
              </div>
            ))}

            <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800 text-xs text-slate-400 text-center">
              所有关键工艺尺寸均由传感器与卡尺自动上传 QMS 阻断中枢
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
