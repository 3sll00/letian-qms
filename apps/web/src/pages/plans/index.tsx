import React, { useState, useEffect } from 'react';
import { FilePlus, Search, Eye, Edit, Layers } from 'lucide-react';
import { StatusBadge } from '../../components/StatusBadge';
import { api, errorMessage } from '../../lib/api';
import type { InspectionPlan } from '@letian/contracts';

// 页签值 (契约检验类型) → 展示文案；IPQC_FN 即原来的 FQC 成品检，保持页面文案不变
const TAB_LABELS: Record<'ALL' | 'IQC' | 'IPQC' | 'IPQC_FN', string> = {
  ALL: '全部规程',
  IQC: 'IQC 规程',
  IPQC: 'IPQC 规程',
  IPQC_FN: 'FQC 规程',
};

/** 后端 GET /plans 的列表响应包装（items 与 list 指向同一份当页数据） */
interface PlanListResponse {
  total: number;
  page: number;
  pageSize: number;
  items: InspectionPlan[];
}

export function PlansPage() {
  // 页签值必须取自契约真实检验类型 (FQC 对应的真实类型是 IPQC_FN)
  const [activeTab, setActiveTab] = useState<'ALL' | 'IQC' | 'IPQC' | 'IPQC_FN'>('ALL');
  const [search, setSearch] = useState('');
  const [plans, setPlans] = useState<InspectionPlan[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    // 一次取回全部方案（种子库 7 个 plan_code，小于 pageSize 上限），页签与关键字在本地过滤，
    // 与页面原有的即时筛选手感保持一致。
    api
      .get<PlanListResponse>('/plans', { pageSize: 100 })
      .then((res) => {
        setPlans(res.items);
        setLoadError(null);
      })
      .catch((err) => {
        setLoadError(errorMessage(err));
        console.error('Plans fetch error:', err);
      });
  }, []);

  /** 生效版本优先，无 ACTIVE 版本时回退到最新版本（versions 按版本号升序返回） */
  const primaryVersionOf = (plan: InspectionPlan) =>
    plan.versions?.find((v) => v.status === 'ACTIVE') ??
    (plan.versions && plan.versions.length > 0 ? plan.versions[plan.versions.length - 1] : undefined);

  const filteredPlans = plans.filter((p) => {
    const matchType = activeTab === 'ALL' || p.inspectionType === activeTab;
    const keyword = search.toLowerCase();
    const matchSearch =
      search === '' ||
      p.planCode.toLowerCase().includes(keyword) ||
      p.planName.toLowerCase().includes(keyword) ||
      p.materialCode.toLowerCase().includes(keyword);
    return matchType && matchSearch;
  });

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/80 border border-slate-800 p-5 rounded-xl">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <Layers className="w-5 h-5 text-sky-400" />
            检验计划规程库与 AQL 抽样规则中心
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            包含 IQC 来料、IPQC 过程制程（下料/冷镦/搓丝/热处理）、FQC 成品入库与 OQC 抽检方案
          </p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold rounded-lg shadow-lg shadow-sky-600/30 transition">
          <FilePlus className="w-4 h-4" />
          新建检验规程
        </button>
      </div>

      {/* Filter and Tabs */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
        <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
          {(['ALL', 'IQC', 'IPQC', 'IPQC_FN'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition ${
                activeTab === tab
                  ? 'bg-sky-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="搜索规程代码、名称或物料..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-72 bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-sky-500"
          />
        </div>
      </div>

      {loadError ? (
        <div className="bg-rose-950/40 border border-rose-500/40 text-rose-200 text-xs rounded-xl px-4 py-3">
          检验方案加载失败: {loadError}
        </div>
      ) : null}

      {/* Plans Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 text-slate-400 uppercase font-mono tracking-wider border-b border-slate-800">
              <tr>
                <th className="px-4 py-3">规程编号</th>
                <th className="px-4 py-3">规程名称</th>
                <th className="px-4 py-3">检验类型</th>
                <th className="px-4 py-3">引用质量标准</th>
                <th className="px-4 py-3">AQL 抽样方案</th>
                <th className="px-4 py-3">适用物料范围</th>
                <th className="px-4 py-3">版本</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {filteredPlans.map((plan) => {
                const version = primaryVersionOf(plan);
                return (
                  <tr key={plan.planCode} className="hover:bg-slate-800/40 transition">
                    <td className="px-4 py-3.5 font-mono text-sky-400 font-medium whitespace-nowrap">
                      {plan.planCode}
                    </td>
                    <td className="px-4 py-3.5 font-medium text-slate-200">
                      <div className="flex items-center gap-1.5">
                        <span>{plan.planName}</span>
                        <span className="text-[10px] text-slate-400 font-mono">
                          ({version?.items.length ?? 0} 项指标)
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[11px] border border-slate-700">
                        {plan.inspectionType}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-slate-300 font-mono text-[11px]">
                      {/* 契约与数据库中检验方案没有「引用质量标准」字段，指标级标准文本见各版本 items */}
                      {'-'}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-mono text-amber-300 text-[11px]">
                        AQL {version?.aqlLevel ?? '-'}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {version?.samplingScheme ?? '-'} · {version?.strictness ?? '-'}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-slate-300 text-[11px]">{plan.materialCode}</td>
                    <td className="px-4 py-3.5 font-mono text-slate-400 text-[11px]">
                      {version?.versionNo ?? '-'}
                    </td>
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <StatusBadge status={version?.status ?? 'DRAFT'} />
                    </td>
                    <td className="px-4 py-3.5 text-right whitespace-nowrap space-x-2">
                      <button
                        className="text-sky-400 hover:text-sky-300 p-1 hover:bg-slate-800 rounded transition"
                        title="查看规程"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      <button
                        className="text-slate-400 hover:text-white p-1 hover:bg-slate-800 rounded transition"
                        title="编辑指标"
                      >
                        <Edit className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
