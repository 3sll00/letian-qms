import React, { useState, useEffect } from 'react';
import { Plus, X } from 'lucide-react';
import { api } from '../../lib/api';
import { CreatePlanModal } from './CreatePlanModal';

import planKpiTotal from '../../assets/plan_kpi_total.png';
import planKpiEnabled from '../../assets/plan_kpi_enabled.png';
import planKpiPending from '../../assets/plan_kpi_pending.png';
import planKpiProducts from '../../assets/plan_kpi_products.png';
import planImportIcon from '../../assets/plan_import_icon.png';

interface PlanRow {
  id: string;
  planCode: string;
  planName: string;
  applicableProduct: string;
  inspectionType: string;
  inspectionCategories: { label: string; bg: string; text: string }[];
  itemCountText: string;
  status: 'ENABLED' | 'PENDING_APPROVAL';
  creator: string;
  updatedAt: string;
  rawPlan?: any;
}

const INITIAL_PLANS: PlanRow[] = [
  {
    id: '1',
    planCode: 'QP-20260706-001',
    planName: '六角螺栓M10-来料检验',
    applicableProduct: '六角螺栓M10',
    inspectionType: '来料检验',
    inspectionCategories: [
      { label: '外观', bg: '#FEF3C7', text: '#F59E0B' },
      { label: '尺寸', bg: '#DBEAFE', text: '#3B82F6' },
    ],
    itemCountText: '21项',
    status: 'ENABLED',
    creator: '张检验',
    updatedAt: '2026-07-06 10:30',
  },
  {
    id: '2',
    planCode: 'QP-20260706-002',
    planName: '六角螺栓M10-过程检验',
    applicableProduct: '六角螺栓M10',
    inspectionType: '过程检验',
    inspectionCategories: [
      { label: '性能', bg: '#D1FAE5', text: '#10B981' },
    ],
    itemCountText: '9项',
    status: 'ENABLED',
    creator: '李检验',
    updatedAt: '2026-07-05 16:00',
  },
  {
    id: '3',
    planCode: 'QP-20260706-003',
    planName: '碳钢圆钢-来料检验',
    applicableProduct: '碳钢圆钢',
    inspectionType: '来料检验',
    inspectionCategories: [
      { label: '外观', bg: '#FEF3C7', text: '#F59E0B' },
      { label: '尺寸', bg: '#DBEAFE', text: '#3B82F6' },
    ],
    itemCountText: '19项',
    status: 'ENABLED',
    creator: '张检验',
    updatedAt: '2026-07-04 09:15',
  },
  {
    id: '4',
    planCode: 'QP-20260706-004',
    planName: '不锈钢棒料-来料检验',
    applicableProduct: '不锈钢棒料',
    inspectionType: '来料检验',
    inspectionCategories: [
      { label: '外观', bg: '#FEF3C7', text: '#F59E0B' },
      { label: '尺寸', bg: '#DBEAFE', text: '#3B82F6' },
      { label: '性能', bg: '#D1FAE5', text: '#10B981' },
    ],
    itemCountText: '30项',
    status: 'PENDING_APPROVAL',
    creator: '王检验',
    updatedAt: '2026-07-03 14:20',
  },
  {
    id: '5',
    planCode: 'QP-20260706-005',
    planName: '六角螺栓M12-出货检验',
    applicableProduct: '六角螺栓M12',
    inspectionType: '出货检验',
    inspectionCategories: [
      { label: '外观', bg: '#FEF3C7', text: '#F59E0B' },
      { label: '尺寸', bg: '#DBEAFE', text: '#3B82F6' },
      { label: '性能', bg: '#D1FAE5', text: '#10B981' },
    ],
    itemCountText: '25项',
    status: 'ENABLED',
    creator: '李检验',
    updatedAt: '2026-07-02 11:45',
  },
  {
    id: '6',
    planCode: 'QP-20260706-006',
    planName: '法兰螺栓-来料检验',
    applicableProduct: '法兰螺栓',
    inspectionType: '来料检验',
    inspectionCategories: [
      { label: '外观', bg: '#FEF3C7', text: '#F59E0B' },
      { label: '尺寸', bg: '#DBEAFE', text: '#3B82F6' },
    ],
    itemCountText: '22项',
    status: 'ENABLED',
    creator: '张检验',
    updatedAt: '2026-07-01 15:30',
  },
];

export function PlansPage() {
  const [plans, setPlans] = useState<PlanRow[]>(INITIAL_PLANS);
  const [loading, setLoading] = useState(false);
  const [filterName, setFilterName] = useState('');
  const [filterCode, setFilterCode] = useState('CL-001');
  const [filterCategory, setFilterCategory] = useState('全部');
  const [filterType, setFilterType] = useState('全部');
  const [currentPage, setCurrentPage] = useState(1);
  const [detailPlan, setDetailPlan] = useState<any | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  // Load from API if available
  useEffect(() => {
    async function loadPlans() {
      try {
        setLoading(true);
        const res = await api.get('/plans');
        if (res && Array.isArray(res) && res.length > 0) {
          const mapped: PlanRow[] = res.map((p: any, idx: number) => {
            const rawCategories = p.versions?.[0]?.items || [];
            const hasAppearance = rawCategories.some((i: any) => i.metricCategory === 'APPEARANCE' || (i.itemName && i.itemName.includes('外观')));
            const hasDimension = rawCategories.some((i: any) => i.metricCategory === 'DIMENSION' || (i.itemName && (i.itemName.includes('尺寸') || i.itemName.includes('长度') || i.itemName.includes('直径'))));
            const hasPerformance = rawCategories.some((i: any) => i.metricCategory === 'PERFORMANCE' || (i.itemName && (i.itemName.includes('性能') || i.itemName.includes('硬度'))));

            const cats = [];
            if (hasAppearance || cats.length === 0) cats.push({ label: '外观', bg: '#FEF3C7', text: '#F59E0B' });
            if (hasDimension) cats.push({ label: '尺寸', bg: '#DBEAFE', text: '#3B82F6' });
            if (hasPerformance) cats.push({ label: '性能', bg: '#D1FAE5', text: '#10B981' });

            const typeMap: Record<string, string> = {
              IQC: '来料检验',
              IPQC: '过程检验',
              FQC: '出货检验',
              OQC: '出货检验',
            };

            return {
              id: p.id || String(idx + 1),
              planCode: p.planCode,
              planName: p.planName,
              applicableProduct: p.materialCode || p.planName.split('-')[0] || '六角螺栓M10',
              inspectionType: typeMap[p.inspectionType] || p.inspectionType || '来料检验',
              inspectionCategories: cats,
              itemCountText: `${p.versions?.[0]?.items?.length || 21}项`,
              status: p.versions?.[0]?.status === 'ARCHIVED' ? 'PENDING_APPROVAL' : 'ENABLED',
              creator: '张检验',
              updatedAt: p.updatedAt ? p.updatedAt.replace('T', ' ').substring(0, 16) : '2026-07-06 10:30',
              rawPlan: p,
            };
          });
          setPlans(mapped);
        }
      } catch {
        // Keep initial mock plans on network or 404 error
      } finally {
        setLoading(false);
      }
    }
    loadPlans();
  }, []);

  const handleReset = () => {
    setFilterName('');
    setFilterCode('');
    setFilterCategory('全部');
    setFilterType('全部');
  };

  const filteredPlans = plans.filter((p) => {
    if (filterName && !p.planName.toLowerCase().includes(filterName.toLowerCase())) return false;
    if (filterCode && !p.planCode.toLowerCase().includes(filterCode.toLowerCase()) && !p.applicableProduct.toLowerCase().includes(filterCode.toLowerCase())) return false;
    if (filterType !== '全部' && p.inspectionType !== filterType) return false;
    return true;
  });

  const getInspectionTypeBadgeStyle = (type: string) => {
    switch (type) {
      case '来料检验':
        return { bg: '#DBEAFE', text: '#3B82F6' };
      case '过程检验':
        return { bg: '#F3E8FF', text: '#8B5CF6' };
      case '出货检验':
        return { bg: '#CFFAFE', text: '#06B6D4' };
      default:
        return { bg: '#DBEAFE', text: '#3B82F6' };
    }
  };

  return (
    <div className="space-y-4 font-sans text-slate-800">
      {/* Title & Top Action Buttons */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">质检方案设计</h1>
          <p className="text-xs text-slate-400 mt-1">
            根据产品或产品分类设置质检方案，同一产品可配置多种质检方案类型
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => alert('请选择要导入的质检方案文件 (.xlsx, .json)')}
            className="flex items-center gap-2 px-3.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
          >
            <img src={planImportIcon} alt="" className="w-3.5 h-3.5 object-contain" />
            <span>导入方案</span>
          </button>
          <button
            onClick={() => {
              const name = prompt('请输入新方案名称：', '新零件-来料检验');
              if (name) {
                const newRow: PlanRow = {
                  id: String(Date.now()),
                  planCode: `QP-20260706-00${plans.length + 1}`,
                  planName: name,
                  applicableProduct: name.split('-')[0] || '标准零件',
                  inspectionType: '来料检验',
                  inspectionCategories: [
                    { label: '外观', bg: '#FEF3C7', text: '#F59E0B' },
                    { label: '尺寸', bg: '#DBEAFE', text: '#3B82F6' },
                  ],
                  itemCountText: '10项',
                  status: 'ENABLED',
                  creator: '张检验',
                  updatedAt: '2026-07-06 12:00',
                };
                setPlans([newRow, ...plans]);
              }
            }}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-[#2563EB] hover:bg-blue-700 text-white rounded-lg text-xs font-medium transition-colors shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新建质检方案</span>
          </button>
        </div>
      </div>

      {/* Filter / Search Bar Card */}
      <div className="bg-white rounded-xl border border-slate-200/80 px-6 py-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-6 text-xs text-slate-700">
            {/* 方案名称 */}
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-slate-600">方案名称</span>
              <input
                type="text"
                placeholder="请输入方案名称"
                value={filterName}
                onChange={(e) => setFilterName(e.target.value)}
                className="w-44 px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg placeholder-slate-400 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            {/* 产品编码 */}
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-slate-600">产品编码</span>
              <input
                type="text"
                value={filterCode}
                onChange={(e) => setFilterCode(e.target.value)}
                className="w-40 px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg placeholder-slate-400 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            {/* 产品分类 */}
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-slate-600">产品分类</span>
              <div className="relative">
                <select
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value)}
                  className="w-36 appearance-none px-3 py-1.5 pr-7 text-xs bg-white border border-slate-200 rounded-lg text-slate-700 focus:outline-none focus:border-blue-500 cursor-pointer"
                >
                  <option value="全部">全部</option>
                  <option value="标准件">标准件</option>
                  <option value="紧固件">紧固件</option>
                  <option value="原材料">原材料</option>
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400 text-[10px]">
                  ▼
                </div>
              </div>
            </div>

            {/* 质检类型 */}
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-slate-600">质检类型</span>
              <div className="relative">
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                  className="w-36 appearance-none px-3 py-1.5 pr-7 text-xs bg-white border border-slate-200 rounded-lg text-slate-700 focus:outline-none focus:border-blue-500 cursor-pointer"
                >
                  <option value="全部">全部</option>
                  <option value="来料检验">来料检验</option>
                  <option value="过程检验">过程检验</option>
                  <option value="出货检验">出货检验</option>
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400 text-[10px]">
                  ▼
                </div>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={handleReset}
              className="px-4 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-600 hover:bg-slate-50 transition-colors shadow-sm"
            >
              重置
            </button>
            <button
              onClick={() => {}}
              className="px-4 py-1.5 bg-[#2563EB] hover:bg-blue-700 text-white rounded-lg text-xs font-medium transition-colors shadow-sm"
            >
              查询
            </button>
          </div>
        </div>
      </div>

      {/* 4 Metric KPI Cards */}
      <div className="grid grid-cols-4 gap-4">
        {/* Card 1: 质检方案总数 */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-4 flex items-center gap-4 shadow-sm">
          <img src={planKpiTotal} alt="质检方案总数" className="w-[52px] h-[52px] object-contain shrink-0" />
          <div className="flex flex-col justify-center">
            <span className="text-xs text-slate-500">质检方案总数</span>
            <span className="text-2xl font-bold text-slate-900 tracking-tight mt-0.5">12</span>
          </div>
        </div>

        {/* Card 2: 已启用 */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-4 flex items-center gap-4 shadow-sm">
          <img src={planKpiEnabled} alt="已启用" className="w-[52px] h-[52px] object-contain shrink-0" />
          <div className="flex flex-col justify-center">
            <span className="text-xs text-slate-500">已启用</span>
            <span className="text-2xl font-bold text-slate-900 tracking-tight mt-0.5">10</span>
          </div>
        </div>

        {/* Card 3: 待审批 */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-4 flex items-center gap-4 shadow-sm">
          <img src={planKpiPending} alt="待审批" className="w-[52px] h-[52px] object-contain shrink-0" />
          <div className="flex flex-col justify-center">
            <span className="text-xs text-slate-500">待审批</span>
            <span className="text-2xl font-bold text-slate-900 tracking-tight mt-0.5">1</span>
          </div>
        </div>

        {/* Card 4: 覆盖产品数 */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-4 flex items-center gap-4 shadow-sm">
          <img src={planKpiProducts} alt="覆盖产品数" className="w-[52px] h-[52px] object-contain shrink-0" />
          <div className="flex flex-col justify-center">
            <span className="text-xs text-slate-500">覆盖产品数</span>
            <span className="text-2xl font-bold text-slate-900 tracking-tight mt-0.5">36</span>
          </div>
        </div>
      </div>

      {/* Main Data Table Card */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-slate-500 font-normal">
                <th className="py-3.5 px-6 font-normal">方案编号</th>
                <th className="py-3.5 px-4 font-normal">方案名称</th>
                <th className="py-3.5 px-4 font-normal">适用产品</th>
                <th className="py-3.5 px-4 font-normal">质检类型</th>
                <th className="py-3.5 px-4 font-normal">检验类别</th>
                <th className="py-3.5 px-4 font-normal">检验项目数</th>
                <th className="py-3.5 px-4 font-normal">状态</th>
                <th className="py-3.5 px-4 font-normal">创建人</th>
                <th className="py-3.5 px-4 font-normal">更新时间</th>
                <th className="py-3.5 px-6 font-normal text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-400">
                    加载中...
                  </td>
                </tr>
              ) : filteredPlans.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-400">
                    未检索到符合条件的质检方案
                  </td>
                </tr>
              ) : (
                filteredPlans.map((row) => {
                  const typeStyle = getInspectionTypeBadgeStyle(row.inspectionType);
                  return (
                    <tr key={row.id} className="hover:bg-slate-50/70 transition-colors">
                      {/* 方案编号 (可点击链接) */}
                      <td className="py-3.5 px-6">
                        <button
                          onClick={() => setDetailPlan(row.rawPlan || row)}
                          className="text-[#2563EB] hover:underline font-medium"
                        >
                          {row.planCode}
                        </button>
                      </td>

                      {/* 方案名称 (加粗) */}
                      <td className="py-3.5 px-4 font-bold text-slate-900">
                        {row.planName}
                      </td>

                      {/* 适用产品 */}
                      <td className="py-3.5 px-4 text-slate-700">
                        {row.applicableProduct}
                      </td>

                      {/* 质检类型胶囊 */}
                      <td className="py-3.5 px-4">
                        <span
                          className="inline-block px-2.5 py-0.5 rounded text-xs"
                          style={{ backgroundColor: typeStyle.bg, color: typeStyle.text }}
                        >
                          {row.inspectionType}
                        </span>
                      </td>

                      {/* 检验类别胶囊列表 */}
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {row.inspectionCategories.map((cat, idx) => (
                            <span
                              key={idx}
                              className="inline-block px-2 py-0.5 rounded text-xs"
                              style={{ backgroundColor: cat.bg, color: cat.text }}
                            >
                              {cat.label}
                            </span>
                          ))}
                        </div>
                      </td>

                      {/* 检验项目数 */}
                      <td className="py-3.5 px-4 text-slate-700">
                        {row.itemCountText}
                      </td>

                      {/* 状态胶囊 */}
                      <td className="py-3.5 px-4">
                        {row.status === 'ENABLED' ? (
                          <span className="inline-block px-2.5 py-0.5 rounded bg-[#D1FAE5] text-[#10B981] text-xs">
                            已启用
                          </span>
                        ) : (
                          <span className="inline-block px-2.5 py-0.5 rounded bg-[#FEF3C7] text-[#F59E0B] text-xs">
                            待审批
                          </span>
                        )}
                      </td>

                      {/* 创建人 */}
                      <td className="py-3.5 px-4 text-slate-700">
                        {row.creator}
                      </td>

                      {/* 更新时间 */}
                      <td className="py-3.5 px-4 text-slate-400">
                        {row.updatedAt}
                      </td>

                      {/* 操作 */}
                      <td className="py-3.5 px-6 text-right">
                        <div className="flex items-center justify-end gap-3 text-xs">
                          <button
                            onClick={() => alert(`编辑方案：${row.planName}`)}
                            className="text-[#2563EB] hover:underline"
                          >
                            编辑
                          </button>
                          {row.status === 'PENDING_APPROVAL' ? (
                            <button
                              onClick={() => {
                                alert(`审批方案：${row.planName}`);
                                setPlans((prev) =>
                                  prev.map((p) =>
                                    p.id === row.id ? { ...p, status: 'ENABLED' } : p
                                  )
                                );
                              }}
                              className="text-[#2563EB] hover:underline"
                            >
                              审批
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                const copyRow: PlanRow = {
                                  ...row,
                                  id: String(Date.now()),
                                  planCode: `${row.planCode}-COPY`,
                                  planName: `${row.planName}-副本`,
                                  updatedAt: '2026-07-06 14:00',
                                };
                                setPlans([copyRow, ...plans]);
                              }}
                              className="text-[#2563EB] hover:underline"
                            >
                              复制
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Section */}
        <div className="flex items-center justify-end px-6 py-4 border-t border-slate-100 gap-3 text-xs text-slate-400">
          <span>共 12 条</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="w-7 h-7 flex items-center justify-center rounded border border-slate-200 text-slate-400 hover:bg-slate-50 disabled:opacity-40"
            >
              &lt;
            </button>
            <button
              onClick={() => setCurrentPage(1)}
              className={`w-7 h-7 flex items-center justify-center rounded text-xs font-medium ${
                currentPage === 1
                  ? 'bg-[#2563EB] text-white border border-[#2563EB]'
                  : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              1
            </button>
            <button
              onClick={() => setCurrentPage(2)}
              className={`w-7 h-7 flex items-center justify-center rounded text-xs font-medium ${
                currentPage === 2
                  ? 'bg-[#2563EB] text-white border border-[#2563EB]'
                  : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              2
            </button>
            <button
              onClick={() => setCurrentPage((p) => Math.min(2, p + 1))}
              disabled={currentPage === 2}
              className="w-7 h-7 flex items-center justify-center rounded border border-slate-200 text-slate-400 hover:bg-slate-50 disabled:opacity-40"
            >
              &gt;
            </button>
          </div>
        </div>
      </div>

      {/* Plan Detail Modal */}
      {detailPlan && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="text-sm font-bold text-slate-900">
                质检方案详情 — {detailPlan.planName} ({detailPlan.planCode})
              </h3>
              <button onClick={() => setDetailPlan(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="text-xs space-y-2 text-slate-600">
              <div>适用产品：<span className="font-semibold text-slate-900">{detailPlan.applicableProduct || detailPlan.materialCode}</span></div>
              <div>质检类型：<span className="font-semibold text-slate-900">{detailPlan.inspectionType}</span></div>
              <div>状态：<span className="font-semibold text-slate-900">{detailPlan.status === 'ENABLED' ? '已启用' : '待审批'}</span></div>
              <div className="font-semibold text-slate-900 pt-2">检验指标项：</div>
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-60 overflow-y-auto">
                {detailPlan.versions?.[0]?.items?.map((it: any, i: number) => (
                  <div key={i} className="p-2.5 flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-700">{it.itemName || it.name}</span>
                    <span className="text-slate-500">{it.standardText || `${it.nominalValue ?? it.targetValue ?? ''} ${it.unit || ''}`}</span>
                  </div>
                )) || (
                  <div className="p-3 text-center text-slate-400">标准检验项目共 {detailPlan.itemCountText || '21项'}</div>
                )}
              </div>
            </div>
            <div className="flex justify-end pt-3">
              <button
                onClick={() => setDetailPlan(null)}
                className="px-4 py-1.5 rounded-lg bg-[#2563EB] text-white text-xs font-medium hover:bg-blue-700"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
      <CreatePlanModal isOpen={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} onSuccess={() => window.location.reload()} />
    </div>
  );
}
