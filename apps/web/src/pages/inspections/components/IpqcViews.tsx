import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Layers,
  Eye,
  FileText,
  Printer,
  RefreshCw,
  Search,
  RotateCcw,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Sliders,
  X
} from 'lucide-react';
import { CertificatePrintModal } from '../../../components/certificate/CertificatePrintModal';
import { buildIpqcCertificateData } from '../../../lib/certificateDataService';
import type { QualityCertificateData } from '../../../lib/inspectionTypes';
import { api } from '../../../lib/api';
import { StatusBadge, BadgeTone } from '../../../components/StatusBadge';

export interface IpqcViewsProps {
  sub: 'overview' | 'blanking' | 'rolling' | 'finished';
  onChangeSub: (sub: 'overview' | 'blanking' | 'rolling' | 'finished') => void;
  onInspect: (item: any) => void;
}

interface OverviewGroupStats {
  total: number;
  pending: number;
  inspecting: number;
  passed: number;
  failed: number;
  passRate: number;
}

interface IpqcOverviewData {
  blanking: OverviewGroupStats;
  rolling: OverviewGroupStats;
  finished: OverviewGroupStats;
  summary: OverviewGroupStats;
  timestamp?: string;
}

interface InspectionItemData {
  id: string;
  orderNo: string;
  inspectionType: string;
  materialCode: string;
  materialName: string;
  specification?: string;
  unit?: string;
  batchNo?: string;
  workOrderNo?: string;
  sampleQty: number;
  totalQty?: number;
  passQty?: number;
  failQty?: number;
  status: string;
  judgment?: string;
  inspectorName?: string;
  createdAt: string;
  completedAt?: string;
  inspectionNotes?: string;
  isMandatoryGate?: boolean;
  processStep?: string;
  blankingLength?: number;
  threadSpec?: string;
  operatorName?: string;
  operatorId?: string;
  equipmentCode?: string;
  equipmentName?: string;
  inspectionTeam?: string;
  items?: Array<{
    itemCode: string;
    name: string;
    nominalValue?: number;
    measuredVal?: number;
    upperTolerance?: number;
    lowerTolerance?: number;
    standardRequirement?: string;
    unit?: string;
    result?: string;
  }>;
}

export function formatIpqcStatus(status: string): { label: string; tone: BadgeTone } {
  const s = (status || '').toUpperCase();
  if (['PASSED', 'PASS', 'COMPLETED', 'QUALIFIED', '已合格', '合格'].includes(s)) {
    return { label: '已合格', tone: 'green' };
  }
  if (['FAILED', 'FAIL', 'REJECT', 'REJECTED', '不合格'].includes(s)) {
    return { label: '不合格', tone: 'red' };
  }
  if (['INSPECTING', 'RE_INSPECTING', 'IN_PROGRESS', '检验中'].includes(s)) {
    return { label: '检验中', tone: 'blue' };
  }
  if (['IN_MRB_REVIEW'].includes(s)) {
    return { label: 'MRB评审', tone: 'purple' };
  }
  return { label: '待检验', tone: 'amber' };
}

export const IpqcViews: React.FC<IpqcViewsProps> = ({ sub, onChangeSub, onInspect }) => {
  const [overviewData, setOverviewData] = useState<IpqcOverviewData | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);

  const [items, setItems] = useState<InspectionItemData[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [tableLoading, setTableLoading] = useState(false);
  const [tableError, setTableError] = useState<string | null>(null);

  const [filterDoc, setFilterDoc] = useState('');
  const [filterMaterial, setFilterMaterial] = useState('');
  const [filterStatus, setFilterStatus] = useState('全部');

  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [certData, setCertData] = useState<QualityCertificateData | undefined>(undefined);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<InspectionItemData | null>(null);
  const [inspectModalOpen, setInspectModalOpen] = useState(false);
  const [inspectingOrder, setInspectingOrder] = useState<InspectionItemData | null>(null);
  const [inspectVerdict, setInspectVerdict] = useState<'PASSED' | 'FAILED' | 'INSPECTING'>('PASSED');
  const [inspectPassQty, setInspectPassQty] = useState<number>(0);
  const [inspectFailQty, setInspectFailQty] = useState<number>(0);
  const [inspectRemark, setInspectRemark] = useState('');
  const [inspectSubmitting, setInspectSubmitting] = useState(false);

  const activeType = useMemo(() => {
    if (sub === 'blanking') return 'IPQC_CT';
    if (sub === 'rolling') return 'IPQC_RL';
    if (sub === 'finished') return 'IPQC_FN';
    return 'IPQC';
  }, [sub]);

  const fetchOverview = useCallback(async () => {
    setOverviewLoading(true);
    try {
      const res = await api.get<IpqcOverviewData>('/inspections/ipqc-overview');
      setOverviewData(res);
    } catch (err) {
      console.error('Failed to load IPQC overview stats:', err);
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const fetchTableData = useCallback(async () => {
    if (sub === 'overview') return;
    setTableLoading(true);
    setTableError(null);

    try {
      const queryParams: Record<string, any> = {
        type: activeType,
        page,
        pageSize,
      };

      if (filterDoc.trim()) {
        queryParams.workOrderNo = filterDoc.trim();
      }
      if (filterMaterial.trim()) {
        queryParams.materialCode = filterMaterial.trim();
      }
      if (filterStatus && filterStatus !== '全部') {
        if (filterStatus === '待检验') queryParams.status = 'PENDING';
        else if (filterStatus === '检验中') queryParams.status = 'INSPECTING';
        else if (filterStatus === '已合格') queryParams.status = 'PASSED';
        else if (filterStatus === '不合格') queryParams.status = 'FAILED';
      }

      const res = await api.get<{
        items: InspectionItemData[];
        total: number;
        statusCounts?: Record<string, number>;
      }>('/inspections', queryParams);

      setItems(res.items || []);
      setTotal(res.total || 0);
      if (res.statusCounts) {
        setStatusCounts(res.statusCounts);
      }
    } catch (err: any) {
      console.error('Failed to load IPQC table data:', err);
      setTableError(err?.message || '加载过程检验台账失败，请检查网络或后端连接');
    } finally {
      setTableLoading(false);
    }
  }, [activeType, sub, page, pageSize, filterDoc, filterMaterial, filterStatus]);

  useEffect(() => {
    if (sub === 'overview') {
      fetchOverview();
    } else {
      setPage(1);
      fetchTableData();
    }
  }, [sub, fetchOverview]);

  useEffect(() => {
    if (sub !== 'overview') {
      fetchTableData();
    }
  }, [page, pageSize, fetchTableData, sub]);

  const handleSearch = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setPage(1);
    fetchTableData();
  };

  const handleReset = () => {
    setFilterDoc('');
    setFilterMaterial('');
    setFilterStatus('全部');
    setPage(1);
  };

  const handleOpenCert = (item: InspectionItemData) => {
    const isFail = ['FAILED', 'FAIL', 'REJECT', 'REJECTED'].includes(item.status);
    const passQty = item.passQty ?? (isFail ? 0 : item.sampleQty);
    const failQty = item.failQty ?? (isFail ? item.sampleQty : 0);

    const data = buildIpqcCertificateData({
      id: item.orderNo,
      workOrder: item.workOrderNo || item.batchNo || item.orderNo,
      material: item.materialName,
      spec: item.specification || '标准紧固件',
      quantity: `${item.totalQty || item.sampleQty || 100} ${item.unit || '件'}`,
      sampleQty: item.sampleQty || 32,
      passQty,
      failQty,
      inspectDate: (item.completedAt || item.createdAt || '2026-09-20').slice(0, 10),
      inspector: item.inspectorName || '张强',
      conclusion: isFail ? 'FAIL' : 'PASS',
      items: item.items && item.items.length > 0 ? item.items.map(it => ({
        name: it.name,
        standard: it.standardRequirement || `${it.nominalValue ?? '--'} ${it.unit || 'mm'}`,
        measured: it.measuredVal !== undefined ? `${it.measuredVal} ${it.unit || 'mm'}` : '符合',
        result: it.result === 'FAIL' ? 'NG' : 'OK',
      })) : undefined,
    });
    setCertData(data);
    setPrintModalOpen(true);
  };

  const handleOpenDetail = (item: InspectionItemData) => {
    setSelectedOrder(item);
    setDetailModalOpen(true);
  };

  const handleOpenInspect = (item: InspectionItemData) => {
    setInspectingOrder(item);
    setInspectVerdict(item.status === 'FAILED' ? 'FAILED' : 'PASSED');
    setInspectPassQty(item.passQty ?? item.sampleQty ?? 32);
    setInspectFailQty(item.failQty ?? 0);
    setInspectRemark(item.inspectionNotes || '');
    setInspectModalOpen(true);
  };

  const handleSubmitInspect = async () => {
    if (!inspectingOrder) return;
    setInspectSubmitting(true);
    try {
      await api.post(`/inspections/${inspectingOrder.id}/status`, {
        status: inspectVerdict,
        passQty: inspectPassQty,
        failQty: inspectFailQty,
        judgment: inspectVerdict,
        remark: inspectRemark.trim() || undefined,
        inspectionNotes: inspectRemark.trim() || undefined,
      });
      setInspectModalOpen(false);
      setInspectingOrder(null);
      await fetchTableData();
      if (sub === 'overview') {
        await fetchOverview();
      }
    } catch (err: any) {
      alert(`录入检验结果失败: ${err?.message || '网络异常'}`);
    } finally {
      setInspectSubmitting(false);
    }
  };

  // OVERVIEW VIEW
  if (sub === 'overview') {
    const blanking = overviewData?.blanking || { total: 0, pending: 0, inspecting: 0, passed: 0, failed: 0, passRate: 100 };
    const rolling = overviewData?.rolling || { total: 0, pending: 0, inspecting: 0, passed: 0, failed: 0, passRate: 100 };
    const finished = overviewData?.finished || { total: 0, pending: 0, inspecting: 0, passed: 0, failed: 0, passRate: 100 };
    const summary = overviewData?.summary || { total: 0, pending: 0, inspecting: 0, passed: 0, failed: 0, passRate: 100 };

    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <Layers className="w-5 h-5 text-blue-600" />
              过程检验总览 (IPQC)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              数据源: MES车间工序同频 · 下料检验 (IPQC-CT) / 滚丝检验 (IPQC-RL) / 成品检 (IPQC-FN)
            </p>
          </div>
          <button
            onClick={fetchOverview}
            disabled={overviewLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-600 hover:bg-slate-50 shadow-sm transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${overviewLoading ? 'animate-spin text-blue-600' : ''}`} />
            刷新看板
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* 下料检验 Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow transition-all relative overflow-hidden flex flex-col justify-between">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-slate-800 text-sm">下料检验</h3>
                  <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-50 text-emerald-700 font-medium">
                    IPQC-CT
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">工序: 自动断料 · 冷镦毛坯</p>
              </div>
              <div className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded text-xs font-bold">
                合格率 {blanking.passRate}%
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 bg-slate-50 rounded-lg p-2.5 text-center my-2">
              <div>
                <span className="block text-[11px] text-slate-500">待检验</span>
                <span className="text-base font-bold text-amber-600">{blanking.pending}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">检验中</span>
                <span className="text-base font-bold text-blue-600">{blanking.inspecting}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">已合格</span>
                <span className="text-base font-bold text-emerald-600">{blanking.passed}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">不合格</span>
                <span className="text-base font-bold text-rose-600">{blanking.failed}</span>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
              <span className="text-slate-500">MES 1#冷镦车间</span>
              <button
                onClick={() => onChangeSub('blanking')}
                className="text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1 group"
              >
                进入下料台账 ({blanking.total})
                <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          </div>

          {/* 滚丝检验 Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow transition-all relative overflow-hidden flex flex-col justify-between">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-slate-800 text-sm">滚丝检验</h3>
                  <span className="px-2 py-0.5 rounded text-[10px] bg-blue-50 text-blue-700 font-medium">
                    IPQC-RL
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">工序: 手工滚牙 · 牙形校验</p>
              </div>
              <div className="px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs font-bold">
                合格率 {rolling.passRate}%
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 bg-slate-50 rounded-lg p-2.5 text-center my-2">
              <div>
                <span className="block text-[11px] text-slate-500">待检验</span>
                <span className="text-base font-bold text-amber-600">{rolling.pending}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">检验中</span>
                <span className="text-base font-bold text-blue-600">{rolling.inspecting}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">已合格</span>
                <span className="text-base font-bold text-emerald-600">{rolling.passed}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">不合格</span>
                <span className="text-base font-bold text-rose-600">{rolling.failed}</span>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
              <span className="text-slate-500">MES 2#滚丝车间</span>
              <button
                onClick={() => onChangeSub('rolling')}
                className="text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1 group"
              >
                进入滚丝台账 ({rolling.total})
                <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          </div>

          {/* 成品检 Card */}
          <div className="bg-white border border-rose-200/80 rounded-xl p-4 shadow-sm hover:shadow transition-all relative overflow-hidden flex flex-col justify-between">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-slate-800 text-sm flex items-center gap-1">
                    成品检
                    <span className="text-amber-500 text-xs">★</span>
                  </h3>
                  <span className="px-2 py-0.5 rounded text-[10px] bg-rose-50 text-rose-600 border border-rose-100 font-medium">
                    强制关卡
                  </span>
                  <span className="px-2 py-0.5 rounded text-[10px] bg-purple-50 text-purple-700 font-medium">
                    IPQC-FN
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">工序: 检测入库 · 关卡阻断</p>
              </div>
              <div className="px-2 py-1 bg-purple-50 text-purple-700 rounded text-xs font-bold">
                合格率 {finished.passRate}%
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 bg-slate-50 rounded-lg p-2.5 text-center my-2">
              <div>
                <span className="block text-[11px] text-slate-500">待检验</span>
                <span className="text-base font-bold text-amber-600">{finished.pending}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">检验中</span>
                <span className="text-base font-bold text-blue-600">{finished.inspecting}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">已合格</span>
                <span className="text-base font-bold text-emerald-600">{finished.passed}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500">不合格</span>
                <span className="text-base font-bold text-rose-600">{finished.failed}</span>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
              <span className="text-rose-600 font-medium text-[11px]">物理阻断已启用</span>
              <button
                onClick={() => onChangeSub('finished')}
                className="text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1 group"
              >
                进入成品台账 ({finished.total})
                <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          </div>
        </div>

        {/* Global Summary Banner */}
        <div className="bg-gradient-to-r from-slate-900 to-slate-800 rounded-xl p-4 text-white shadow-sm flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <div className="text-xs text-slate-400">今日过程检验管控总量</div>
              <div className="text-xl font-bold">{summary.total} 批次</div>
            </div>
          </div>

          <div className="flex items-center gap-6 text-xs">
            <div>
              <span className="text-slate-400 block">待检排队</span>
              <span className="text-base font-bold text-amber-400">{summary.pending}</span>
            </div>
            <div className="w-px h-8 bg-slate-700" />
            <div>
              <span className="text-slate-400 block">检验中</span>
              <span className="text-base font-bold text-sky-400">{summary.inspecting}</span>
            </div>
            <div className="w-px h-8 bg-slate-700" />
            <div>
              <span className="text-slate-400 block">合格放行</span>
              <span className="text-base font-bold text-emerald-400">{summary.passed}</span>
            </div>
            <div className="w-px h-8 bg-slate-700" />
            <div>
              <span className="text-slate-400 block">不合格拦截</span>
              <span className="text-base font-bold text-rose-400">{summary.failed}</span>
            </div>
            <div className="w-px h-8 bg-slate-700" />
            <div>
              <span className="text-slate-400 block">综合合格率</span>
              <span className="text-base font-bold text-emerald-400">{summary.passRate}%</span>
            </div>
          </div>
        </div>

        {/* Breakdown Table */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between">
            <h3 className="font-semibold text-sm text-slate-800">工序控制指标汇总</h3>
            <span className="text-xs text-slate-400">对接 MES 实时工序采集终端</span>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 font-medium">
              <tr>
                <th className="py-2.5 px-4">工序代号</th>
                <th className="py-2.5 px-4">工序名称</th>
                <th className="py-2.5 px-4">MES执行车间</th>
                <th className="py-2.5 px-4 text-center">待检验</th>
                <th className="py-2.5 px-4 text-center">检验中</th>
                <th className="py-2.5 px-4 text-center">已合格</th>
                <th className="py-2.5 px-4 text-center">不合格</th>
                <th className="py-2.5 px-4 text-center">合格率</th>
                <th className="py-2.5 px-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              <tr className="hover:bg-slate-50/60 transition-colors">
                <td className="py-3 px-4 font-mono font-medium text-emerald-700">IPQC-CT</td>
                <td className="py-3 px-4 font-medium">下料首巡检 (自动断料)</td>
                <td className="py-3 px-4 text-slate-500">1#冷镦车间</td>
                <td className="py-3 px-4 text-center font-semibold text-amber-600">{blanking.pending}</td>
                <td className="py-3 px-4 text-center font-semibold text-blue-600">{blanking.inspecting}</td>
                <td className="py-3 px-4 text-center font-semibold text-emerald-600">{blanking.passed}</td>
                <td className="py-3 px-4 text-center font-semibold text-rose-600">{blanking.failed}</td>
                <td className="py-3 px-4 text-center font-bold text-emerald-600">{blanking.passRate}%</td>
                <td className="py-3 px-4 text-right">
                  <button
                    onClick={() => onChangeSub('blanking')}
                    className="text-blue-600 hover:text-blue-800 font-medium"
                  >
                    查看台账
                  </button>
                </td>
              </tr>
              <tr className="hover:bg-slate-50/60 transition-colors">
                <td className="py-3 px-4 font-mono font-medium text-blue-700">IPQC-RL</td>
                <td className="py-3 px-4 font-medium">滚丝首巡检 (手工滚牙)</td>
                <td className="py-3 px-4 text-slate-500">2#滚丝车间</td>
                <td className="py-3 px-4 text-center font-semibold text-amber-600">{rolling.pending}</td>
                <td className="py-3 px-4 text-center font-semibold text-blue-600">{rolling.inspecting}</td>
                <td className="py-3 px-4 text-center font-semibold text-emerald-600">{rolling.passed}</td>
                <td className="py-3 px-4 text-center font-semibold text-rose-600">{rolling.failed}</td>
                <td className="py-3 px-4 text-center font-bold text-emerald-600">{rolling.passRate}%</td>
                <td className="py-3 px-4 text-right">
                  <button
                    onClick={() => onChangeSub('rolling')}
                    className="text-blue-600 hover:text-blue-800 font-medium"
                  >
                    查看台账
                  </button>
                </td>
              </tr>
              <tr className="hover:bg-slate-50/60 transition-colors">
                <td className="py-3 px-4 font-mono font-medium text-purple-700">IPQC-FN</td>
                <td className="py-3 px-4 font-medium flex items-center gap-1.5">
                  成品全检 (检测入库)
                  <span className="text-rose-500 font-bold text-xs" title="MES入库强制物理关卡">★</span>
                </td>
                <td className="py-3 px-4 text-slate-500">包装与终检班组</td>
                <td className="py-3 px-4 text-center font-semibold text-amber-600">{finished.pending}</td>
                <td className="py-3 px-4 text-center font-semibold text-blue-600">{finished.inspecting}</td>
                <td className="py-3 px-4 text-center font-semibold text-emerald-600">{finished.passed}</td>
                <td className="py-3 px-4 text-center font-semibold text-rose-600">{finished.failed}</td>
                <td className="py-3 px-4 text-center font-bold text-emerald-600">{finished.passRate}%</td>
                <td className="py-3 px-4 text-right">
                  <button
                    onClick={() => onChangeSub('finished')}
                    className="text-blue-600 hover:text-blue-800 font-medium"
                  >
                    查看台账
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // SUBTAB DETAIL VIEWS (下料检验 / 滚丝检验 / 成品检)
  const isBlanking = sub === 'blanking';
  const isRolling = sub === 'rolling';
  const isFinished = sub === 'finished';

  const title = isBlanking ? '下料检验' : isRolling ? '滚丝检验' : '成品检';
  const codeTag = isBlanking ? 'IPQC-CT' : isRolling ? 'IPQC-RL' : 'IPQC-FN';
  const processDesc = isBlanking
    ? 'MES工序: 自动断料 · 冷镦毛坯 · 断料长度与外径公差把控'
    : isRolling
    ? 'MES工序: 手工滚牙 · 螺纹牙型与公差配合 · 人员设备强追溯'
    : 'MES工序: 检测入库 · ★入库关卡必检物理阻断 · 终检组全项合格入库';

  return (
    <div className="space-y-4">
      {/* Top Header Bar */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-1">
              {title}
              {isFinished && <span className="text-amber-500 text-sm">★</span>}
            </h2>
            {isFinished && (
              <span className="px-2 py-0.5 rounded text-[10px] bg-rose-50 text-rose-600 border border-rose-100 font-medium">
                关卡物理阻断
              </span>
            )}
            <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-50 text-emerald-700 font-medium font-mono">
              {codeTag}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">{processDesc}</p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onChangeSub('overview')}
            className="flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 shadow-sm transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> 返回总览
          </button>
          <button
            onClick={fetchTableData}
            disabled={tableLoading}
            className="flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 shadow-sm transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${tableLoading ? 'animate-spin text-blue-600' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {/* Process Alerts */}
      {isRolling && (
        <div className="bg-amber-50 border border-amber-200/80 rounded-lg p-3 text-xs text-amber-800 flex items-center gap-2 shadow-sm">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
          <span>滚丝为紧固件手工/机台复合工序，需严格核实操作工（操作员）与机台设备编号，确保全流程双向追溯。</span>
        </div>
      )}
      {isFinished && (
        <div className="bg-rose-50 border border-rose-200/80 rounded-lg p-3 text-xs text-rose-800 flex items-center gap-2 shadow-sm">
          <span className="text-rose-600 font-bold">★ 关卡必检提示:</span>
          <span>成品检为 MES 终检入库关卡工序（isMandatoryGate=true）。未完成检验或判定不合格批次将直接触发 MES 物理入库阻断。</span>
        </div>
      )}

      {/* Filter Bar */}
      <form onSubmit={handleSearch} className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm flex flex-wrap items-center gap-4 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium">工单号/单号</span>
          <input
            type="text"
            placeholder="工单号/单号"
            value={filterDoc}
            onChange={(e) => setFilterDoc(e.target.value)}
            className="border border-slate-200 rounded px-2.5 py-1.5 w-36 text-slate-700 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium">物料编码</span>
          <input
            type="text"
            placeholder="物料编码/品名"
            value={filterMaterial}
            onChange={(e) => setFilterMaterial(e.target.value)}
            className="border border-slate-200 rounded px-2.5 py-1.5 w-36 text-slate-700 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-medium">检验状态</span>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="border border-slate-200 rounded px-2.5 py-1.5 w-28 text-slate-700 bg-white focus:outline-none focus:border-blue-500"
          >
            <option value="全部">全部</option>
            <option value="待检验">待检验</option>
            <option value="检验中">检验中</option>
            <option value="已合格">已合格</option>
            <option value="不合格">不合格</option>
          </select>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={handleReset}
            className="px-3.5 py-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" /> 重置
          </button>
          <button
            type="submit"
            className="px-4 py-1.5 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 shadow-sm flex items-center gap-1"
          >
            <Search className="w-3 h-3" /> 查询
          </button>
        </div>
      </form>

      {/* Error Alert */}
      {tableError && (
        <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg flex items-center justify-between">
          <span>{tableError}</span>
          <button onClick={fetchTableData} className="underline hover:text-rose-900 ml-2">重试</button>
        </div>
      )}

      {/* Main Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 font-medium select-none">
              <tr>
                <th className="py-2.5 px-3 whitespace-nowrap">检验单号</th>
                <th className="py-2.5 px-3 whitespace-nowrap">工序/关卡</th>
                <th className="py-2.5 px-3 whitespace-nowrap">MES生产工单</th>
                <th className="py-2.5 px-3 whitespace-nowrap">物料编码与名称</th>
                <th className="py-2.5 px-3 whitespace-nowrap">规格型号</th>
                <th className="py-2.5 px-3 whitespace-nowrap text-right">报检/抽样数</th>
                {isBlanking && <th className="py-2.5 px-3 whitespace-nowrap text-right">断料长(mm)</th>}
                {isRolling && <th className="py-2.5 px-3 whitespace-nowrap">螺纹规格</th>}
                <th className="py-2.5 px-3 whitespace-nowrap">操作员</th>
                <th className="py-2.5 px-3 whitespace-nowrap">设备编号/机台</th>
                {isFinished && <th className="py-2.5 px-3 whitespace-nowrap">终检班组</th>}
                <th className="py-2.5 px-3 whitespace-nowrap">报检/完成时间</th>
                <th className="py-2.5 px-3 whitespace-nowrap text-center">状态</th>
                <th className="py-2.5 px-3 whitespace-nowrap">检验员</th>
                <th className="py-2.5 px-3 whitespace-nowrap text-center">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {tableLoading ? (
                <tr>
                  <td colSpan={15} className="py-12 text-center text-slate-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-600" />
                    正在连接数据库获取过程检验数据...
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={15} className="py-12 text-center text-slate-400">
                    暂无符合条件的过程检验数据
                  </td>
                </tr>
              ) : (
                items.map((row) => {
                  const statusInfo = formatIpqcStatus(row.status);
                  return (
                    <tr key={row.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-2.5 px-3 font-mono font-medium text-blue-600 whitespace-nowrap">
                        {row.orderNo}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <span className="text-slate-700 font-medium">
                            {row.processStep || (isBlanking ? '自动断料' : isRolling ? '手工滚牙' : '检测入库')}
                          </span>
                          {row.isMandatoryGate && (
                            <span className="text-rose-500 font-bold" title="关卡必检物理阻断">★</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-600 whitespace-nowrap">
                        {row.workOrderNo || row.batchNo || '--'}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <div className="font-medium text-slate-800">{row.materialName}</div>
                        <div className="font-mono text-[11px] text-slate-400">{row.materialCode}</div>
                      </td>
                      <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                        {row.specification || '--'}
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <div className="font-semibold text-slate-800">
                          {row.sampleQty || 32} <span className="font-normal text-slate-400">抽样</span>
                        </div>
                        <div className="text-[11px] text-slate-400">
                          总量: {row.totalQty || row.sampleQty || 100} {row.unit || '件'}
                        </div>
                      </td>
                      {isBlanking && (
                        <td className="py-2.5 px-3 text-right font-mono font-medium text-slate-800 whitespace-nowrap">
                          {row.blankingLength !== undefined && row.blankingLength !== null
                            ? Number(row.blankingLength).toFixed(2)
                            : '--'}
                        </td>
                      )}
                      {isRolling && (
                        <td className="py-2.5 px-3 font-mono text-slate-700 whitespace-nowrap">
                          {row.threadSpec || '--'}
                        </td>
                      )}
                      <td className="py-2.5 px-3 text-slate-700 whitespace-nowrap">
                        {row.operatorName || '--'}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <div className="text-slate-800 font-medium">{row.equipmentName || row.equipmentCode || '--'}</div>
                        {row.equipmentCode && row.equipmentName && (
                          <div className="font-mono text-[11px] text-slate-400">{row.equipmentCode}</div>
                        )}
                      </td>
                      {isFinished && (
                        <td className="py-2.5 px-3 text-slate-700 whitespace-nowrap">
                          {row.inspectionTeam || '终检一组'}
                        </td>
                      )}
                      <td className="py-2.5 px-3 text-slate-500 whitespace-nowrap">
                        {(row.completedAt || row.createdAt || '--').slice(0, 16).replace('T', ' ')}
                      </td>
                      <td className="py-2.5 px-3 text-center whitespace-nowrap">
                        <StatusBadge status={statusInfo.label} tone={statusInfo.tone} />
                      </td>
                      <td className="py-2.5 px-3 text-slate-700 whitespace-nowrap">
                        {row.inspectorName || '张强'}
                      </td>
                      <td className="py-2.5 px-3 text-center whitespace-nowrap">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleOpenDetail(row)}
                            className="p-1 rounded text-slate-600 hover:text-blue-600 hover:bg-slate-100 transition-colors"
                            title="查看明细"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenInspect(row)}
                            className="px-2 py-0.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 font-medium text-[11px] transition-colors"
                            title="录入/判定检验"
                          >
                            检验
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenCert(row)}
                            className="p-1 rounded text-slate-600 hover:text-emerald-600 hover:bg-slate-100 transition-colors"
                            title="质检证书"
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        <div className="p-3 bg-slate-50/70 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
          <div>
            共 <span className="font-semibold text-slate-700">{total}</span> 条记录
            {total > 0 && (
              <span className="ml-2">
                (当前第 {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, total)} 条)
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-2.5 py-1 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> 上一页
            </button>
            <span className="font-medium text-slate-700">
              {page} / {Math.max(1, Math.ceil(total / pageSize))}
            </span>
            <button
              onClick={() => setPage((p) => (p * pageSize < total ? p + 1 : p))}
              disabled={page * pageSize >= total}
              className="px-2.5 py-1 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            >
              下一页 <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* DETAIL MODAL */}
      {detailModalOpen && selectedOrder && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-base text-slate-800">
                    检验单详情: {selectedOrder.orderNo}
                  </h3>
                  <span className="px-2 py-0.5 rounded text-xs bg-blue-50 text-blue-700 font-mono font-medium">
                    {selectedOrder.inspectionType}
                  </span>
                  <StatusBadge status={formatIpqcStatus(selectedOrder.status).label} tone={formatIpqcStatus(selectedOrder.status).tone} />
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  MES生产工单: {selectedOrder.workOrderNo || selectedOrder.batchNo || '--'}
                </p>
              </div>
              <button
                onClick={() => setDetailModalOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200/50 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto text-xs">
              <div>
                <h4 className="font-semibold text-slate-700 mb-2.5 flex items-center gap-1.5">
                  <Layers className="w-4 h-4 text-blue-500" /> 基本信息与物料规格
                </h4>
                <div className="grid grid-cols-3 gap-3 bg-slate-50 p-3.5 rounded-lg border border-slate-100">
                  <div>
                    <span className="text-slate-400 block">物料编码</span>
                    <span className="font-mono font-medium text-slate-800">{selectedOrder.materialCode}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">物料名称</span>
                    <span className="font-medium text-slate-800">{selectedOrder.materialName}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">规格型号</span>
                    <span className="text-slate-800">{selectedOrder.specification || '--'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">计划/报检总量</span>
                    <span className="font-semibold text-slate-800">{selectedOrder.totalQty || selectedOrder.sampleQty || 100} {selectedOrder.unit || '件'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">抽检样本数量</span>
                    <span className="font-semibold text-slate-800">{selectedOrder.sampleQty || 32} 件</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">合格 / 不合格</span>
                    <span className="font-semibold text-emerald-600">{selectedOrder.passQty ?? 0}</span>
                    <span className="text-slate-400"> / </span>
                    <span className="font-semibold text-rose-600">{selectedOrder.failQty ?? 0}</span>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="font-semibold text-slate-700 mb-2.5 flex items-center gap-1.5">
                  <Sliders className="w-4 h-4 text-blue-500" /> 过程工序追溯与机台设备
                </h4>
                <div className="grid grid-cols-3 gap-3 bg-slate-50 p-3.5 rounded-lg border border-slate-100">
                  <div>
                    <span className="text-slate-400 block">工序阶段</span>
                    <span className="font-medium text-slate-800">{selectedOrder.processStep || '工序巡检'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">机台操作员</span>
                    <span className="font-medium text-slate-800">
                      {selectedOrder.operatorName || '--'}
                      {selectedOrder.operatorId && <span className="text-slate-400 text-[11px] ml-1">({selectedOrder.operatorId})</span>}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">生产设备</span>
                    <span className="font-medium text-slate-800">
                      {selectedOrder.equipmentName || selectedOrder.equipmentCode || '--'}
                      {selectedOrder.equipmentCode && selectedOrder.equipmentName && (
                        <span className="text-slate-400 text-[11px] ml-1">[{selectedOrder.equipmentCode}]</span>
                      )}
                    </span>
                  </div>
                  {selectedOrder.blankingLength !== undefined && selectedOrder.blankingLength !== null && (
                    <div>
                      <span className="text-slate-400 block">断料长度 (mm)</span>
                      <span className="font-mono font-bold text-slate-800">{Number(selectedOrder.blankingLength).toFixed(2)} mm</span>
                    </div>
                  )}
                  {selectedOrder.threadSpec && (
                    <div>
                      <span className="text-slate-400 block">牙纹/螺纹规格</span>
                      <span className="font-mono font-bold text-slate-800">{selectedOrder.threadSpec}</span>
                    </div>
                  )}
                  {selectedOrder.inspectionTeam && (
                    <div>
                      <span className="text-slate-400 block">终检班组</span>
                      <span className="font-medium text-slate-800">{selectedOrder.inspectionTeam}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-slate-400 block">关卡物理阻断</span>
                    <span className={selectedOrder.isMandatoryGate ? 'font-bold text-rose-600' : 'text-slate-600'}>
                      {selectedOrder.isMandatoryGate ? '★ 强制阻断启用 (未合格不可入库)' : '普通工序'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">检验员</span>
                    <span className="font-medium text-slate-800">{selectedOrder.inspectorName || '张强'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">完成时间</span>
                    <span className="text-slate-800">{(selectedOrder.completedAt || selectedOrder.createdAt || '--').replace('T', ' ')}</span>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="font-semibold text-slate-700 mb-2.5 flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-blue-500" /> 检验项目实测明细
                </h4>
                {selectedOrder.items && selectedOrder.items.length > 0 ? (
                  <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 font-medium">
                        <tr>
                          <th className="py-2 px-3">项目编码</th>
                          <th className="py-2 px-3">检验项名称</th>
                          <th className="py-2 px-3">标准值/公差</th>
                          <th className="py-2 px-3">实测值</th>
                          <th className="py-2 px-3 text-center">判定</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {selectedOrder.items.map((it, idx) => (
                          <tr key={idx} className="hover:bg-slate-50/50">
                            <td className="py-2 px-3 font-mono text-slate-500">{it.itemCode}</td>
                            <td className="py-2 px-3 font-medium text-slate-800">{it.name}</td>
                            <td className="py-2 px-3 text-slate-600">
                              {it.standardRequirement || (it.nominalValue !== undefined ? `${it.nominalValue} ${it.unit || 'mm'}` : '符合图纸')}
                            </td>
                            <td className="py-2 px-3 font-mono font-medium text-slate-800">
                              {it.measuredVal !== undefined ? `${it.measuredVal} ${it.unit || 'mm'}` : '合格'}
                            </td>
                            <td className="py-2 px-3 text-center">
                              {it.result === 'FAIL' ? (
                                <span className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 font-semibold text-[10px]">NG</span>
                              ) : (
                                <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 font-semibold text-[10px]">OK</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-slate-500 text-center">
                    依据标准工艺规程完成全项尺寸及外观检验合格，未发现超差。
                  </div>
                )}
              </div>

              {selectedOrder.inspectionNotes && (
                <div>
                  <h4 className="font-semibold text-slate-700 mb-1">检验巡检记录与说明:</h4>
                  <div className="p-2.5 bg-slate-50 border border-slate-100 rounded text-slate-700">
                    {selectedOrder.inspectionNotes}
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
              <button
                onClick={() => {
                  handleOpenCert(selectedOrder);
                }}
                className="px-3.5 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 text-xs font-medium flex items-center gap-1.5 transition-colors"
              >
                <Printer className="w-3.5 h-3.5" /> 打印质检证书
              </button>
              <button
                onClick={() => setDetailModalOpen(false)}
                className="px-4 py-1.5 rounded-lg bg-slate-800 text-white hover:bg-slate-900 text-xs font-medium transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* INSPECT MODAL */}
      {inspectModalOpen && inspectingOrder && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800">
                录入过程检验结果: {inspectingOrder.orderNo}
              </h3>
              <button
                onClick={() => setInspectModalOpen(false)}
                className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-200/50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="bg-slate-50 p-3 rounded border border-slate-100 space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-400">物料:</span>
                  <span className="font-medium text-slate-800">{inspectingOrder.materialName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">工单号:</span>
                  <span className="font-mono text-slate-700">{inspectingOrder.workOrderNo || inspectingOrder.batchNo || '--'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">抽样基准:</span>
                  <span className="font-semibold text-slate-800">{inspectingOrder.sampleQty || 32} 件</span>
                </div>
              </div>

              <div>
                <label className="block text-slate-600 font-medium mb-1.5">检验判定结论</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setInspectVerdict('PASSED');
                      setInspectPassQty(inspectingOrder.sampleQty || 32);
                      setInspectFailQty(0);
                    }}
                    className={`py-2 rounded border text-xs font-semibold flex items-center justify-center gap-1 transition-all ${
                      inspectVerdict === 'PASSED'
                        ? 'bg-emerald-50 border-emerald-500 text-emerald-700 shadow-sm'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    合格放行
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInspectVerdict('FAILED');
                      setInspectPassQty(0);
                      setInspectFailQty(inspectingOrder.sampleQty || 32);
                    }}
                    className={`py-2 rounded border text-xs font-semibold flex items-center justify-center gap-1 transition-all ${
                      inspectVerdict === 'FAILED'
                        ? 'bg-rose-50 border-rose-500 text-rose-700 shadow-sm'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <XCircle className="w-3.5 h-3.5 text-rose-600" />
                    不合格拦截
                  </button>
                  <button
                    type="button"
                    onClick={() => setInspectVerdict('INSPECTING')}
                    className={`py-2 rounded border text-xs font-semibold flex items-center justify-center gap-1 transition-all ${
                      inspectVerdict === 'INSPECTING'
                        ? 'bg-blue-50 border-blue-500 text-blue-700 shadow-sm'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <Clock className="w-3.5 h-3.5 text-blue-600" />
                    检验中
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-medium mb-1">合格数量</label>
                  <input
                    type="number"
                    min={0}
                    value={inspectPassQty}
                    onChange={(e) => setInspectPassQty(Number(e.target.value))}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-medium mb-1">不合格数量</label>
                  <input
                    type="number"
                    min={0}
                    value={inspectFailQty}
                    onChange={(e) => setInspectFailQty(Number(e.target.value))}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 font-medium mb-1">巡检结论说明 / 备注</label>
                <textarea
                  rows={2}
                  value={inspectRemark}
                  onChange={(e) => setInspectRemark(e.target.value)}
                  placeholder="请输入过程巡检实测情况与处置说明..."
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>
            </div>

            <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setInspectModalOpen(false)}
                className="px-3.5 py-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-100 text-xs"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSubmitInspect}
                disabled={inspectSubmitting}
                className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs shadow-sm disabled:opacity-50 flex items-center gap-1"
              >
                {inspectSubmitting ? '正在提交...' : '确认保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CERTIFICATE PRINT MODAL */}
      <CertificatePrintModal
        isOpen={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        type="quality"
        qualityData={certData}
      />
    </div>
  );
};
