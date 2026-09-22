import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import type {
  InspectionPlan,
  InspectionType,
  MetricCategory,
  PlanStats,
  PlanStatus,
} from '@letian/contracts';
import { api, errorMessage } from '../../lib/api';
import { INSPECTION_TYPES } from '../../lib/inspectionTypes';
import { planPeriodHint, planPeriodLabel } from '../../lib/planMatch';
import {
  approvalTargetVersion,
  effectiveVersion,
  planVersionActionVisibility,
  type PlanVersionActionVisibility,
} from '../../lib/planVersionActions';
import { CreatePlanModal } from './CreatePlanModal';

import planKpiTotal from '../../assets/plan_kpi_total.png';
import planKpiEnabled from '../../assets/plan_kpi_enabled.png';
import planKpiPending from '../../assets/plan_kpi_pending.png';
import planKpiProducts from '../../assets/plan_kpi_products.png';
import planImportIcon from '../../assets/plan_import_icon.png';

/**
 * 质检方案设计（质检方案与指标库）
 *
 * 数据口径（与 docs/04-API与导入规范.md §3.7、docs/20-质检方案设计页数据字段与接口打通设计.md 一致）：
 *   1. 列表只渲染 GET /api/v1/plans 的真实字段，缺失显示 '-'，不做前端二次过滤或字段推导；
 *      适用产品（materialName）/ 检验类别（items）/ 状态（status）/ 创建人（createdByName）
 *      全部由接口按数据库列派生，前端不再映射主数据名称、也不再自行推导方案状态；
 *   2. 「方案名称 / 产品编码 / 产品分类 / 质检类型」四个条件全部下沉到后端查询参数，
 *      输入框为草稿态、点「查询」后才提交，保证「界面条件 == 接口条件」；
 *   3. 四张 KPI 卡取 GET /api/v1/plans/stats 的服务端聚合（仅受物料权限过滤），
 *      不用当页列表数据推算全局指标；
 *   4. 接口不可用时展示空态 + 显式错误提示，不用内置演示行冒充真实方案库。
 */

/** 每页行数：与设计稿首屏一致（首屏 6 行 + 「共 N 条」页码分页） */
const PLAN_PAGE_SIZE = 6;

interface Badge {
  label: string;
  bg: string;
  text: string;
}

interface PlanRow {
  id: string;
  planCode: string;
  planName: string;
  /** 适用产品：物料专属方案取接口派生的 materialName（缺失回退物料编码），分类通用方案取 categoryName */
  applicableProduct: string;
  inspectionType: InspectionType;
  itemCount: number;
  status: PlanStatus;
  /** 生效周期提示：空串 = 周期覆盖今天；非空时在状态徽标下补一行小字（未生效 / 已过期） */
  periodHint: '' | '未生效' | '已过期';
  creator: string;
  updatedAt: string;
  raw: InspectionPlan;
  /** 操作列按钮可见性：由版本集合推导，与「审批 / 停用 / 启用」实际作用的目标版本同源（见 lib/planVersionActions） */
  actions: PlanVersionActionVisibility;
}

/** 界面筛选条件（草稿态与已提交态共用同一结构） */
interface PlanFilters {
  name: string;
  productCode: string;
  categoryCode: string;
  inspectionType: string;
}

interface PlanListResponse {
  total?: number;
  /** 契约主字段；list 为后端兼容别名，两者指向同一份当页数据 */
  items?: InspectionPlan[];
  list?: InspectionPlan[];
}

interface CategoryNodeView {
  id: string;
  code: string;
  name: string;
  children?: CategoryNodeView[];
}

/** 质检类型徽标：契约 InspectionTypeEnum → 展示名 + 配色（Record 保证枚举新增成员时编译期报错） */
const TYPE_BADGES: Record<InspectionType, Badge> = {
  IQC: { label: '来料检验', bg: '#DBEAFE', text: '#3B82F6' },
  IPQC_CT: { label: '过程检验', bg: '#F3E8FF', text: '#8B5CF6' },
  IPQC_RL: { label: '过程检验', bg: '#F3E8FF', text: '#8B5CF6' },
  IPQC_FN: { label: '过程检验', bg: '#F3E8FF', text: '#8B5CF6' },
  OQC_SF: { label: '委外检验', bg: '#E0E7FF', text: '#4F46E5' },
  OQC_SH: { label: '出货检验', bg: '#CFFAFE', text: '#06B6D4' },
  OQC_HEAT: { label: '委外检验', bg: '#E0E7FF', text: '#4F46E5' },
  OQC_BLACK: { label: '委外检验', bg: '#E0E7FF', text: '#4F46E5' },
  OQC_ZINC: { label: '委外检验', bg: '#E0E7FF', text: '#4F46E5' },
  OQC_NICKEL: { label: '委外检验', bg: '#E0E7FF', text: '#4F46E5' },
  OQC_PHOSPH: { label: '委外检验', bg: '#E0E7FF', text: '#4F46E5' },
  OQC_DACRO: { label: '委外检验', bg: '#E0E7FF', text: '#4F46E5' },
  OQC_MACH: { label: '委外检验', bg: '#E0E7FF', text: '#4F46E5' },
};

/** 检验类别徽标：指标项 metricCategory → 类别名 + 配色（Record 保证枚举新增成员时编译期报错） */
const CATEGORY_BADGES: Record<MetricCategory, Badge> = {
  DIMENSION: { label: '尺寸', bg: '#DBEAFE', text: '#3B82F6' },
  APPEARANCE: { label: '外观', bg: '#FEF3C7', text: '#F59E0B' },
  HARDNESS: { label: '硬度', bg: '#D1FAE5', text: '#10B981' },
  COATING_THICKNESS: { label: '膜厚', bg: '#CFFAFE', text: '#06B6D4' },
  TENSILE_STRENGTH: { label: '性能', bg: '#D1FAE5', text: '#10B981' },
  MECHANICAL_PERFORMANCE: { label: '性能', bg: '#D1FAE5', text: '#10B981' },
  CHEMICAL_COMPOSITION: { label: '成分', bg: '#FFE4E6', text: '#F43F5E' },
  TEXT_INTERVAL: { label: '文本', bg: '#EEF2FF', text: '#6366F1' },
};

/** 状态徽标 */
const STATUS_BADGES: Record<PlanStatus, Badge> = {
  ENABLED: { label: '已启用', bg: '#D1FAE5', text: '#10B981' },
  PENDING_APPROVAL: { label: '待审批', bg: '#FEF3C7', text: '#F59E0B' },
  DISABLED: { label: '已停用', bg: '#F1F5F9', text: '#64748B' },
};

const EMPTY_FILTERS: PlanFilters = {
  name: '',
  productCode: '',
  categoryCode: '全部',
  inspectionType: '全部',
};

/** 后端当页数据信封（兼容 items / list / 裸数组三种历史形态） */
function listOf(res: PlanListResponse | InspectionPlan[] | null | undefined): InspectionPlan[] {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.items)) return res.items;
  if (Array.isArray(res?.list)) return res.list;
  return [];
}

/**
 * 生效版本 -> 生效周期提示（空串 = 周期覆盖今天，正常参与自动匹配）。
 * 列表状态列与详情弹窗共用，保证同一方案两处提示口径一致（TBD-08）。
 */
function periodHintOf(plan: InspectionPlan): '' | '未生效' | '已过期' {
  return planPeriodHint(effectiveVersion(plan));
}

/** 生效版本 -> 生效周期展示文案（`2026-09-21 ~ 长期有效`；两侧都未配置时返回 `-`） */
function periodLabelOf(plan: InspectionPlan): string {
  return planPeriodLabel(effectiveVersion(plan));
}

/**
 * 适用产品展示口径（列表列与详情弹窗共用，保证同一方案两处显示一致）：
 * 物料专属方案取接口派生的物料名，缺失回退物料编码；分类通用方案取接口派生的分类名。
 */
function applicableProductOf(plan: InspectionPlan): string {
  const materialCode = plan.materialCode ?? '';
  // 分类通用方案由接口 isCategoryDefault 判定（materialCode 为空串且 categoryCode 非空，口径见迁移 014），
  // 前端不再自行推导「是不是分类通用方案」；字段缺失（旧载荷）时回退到 materialCode 判空，行为不变。
  if (plan.isCategoryDefault === true || materialCode === '') return plan.categoryName ?? '-';
  return plan.materialName ?? materialCode;
}

function formatDateTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = (num: number) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 分类树 → 下拉选项（仅取有编码的节点，父级在前） */
function flattenCategories(nodes: CategoryNodeView[], depth = 0): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (const node of nodes) {
    if (node.code) {
      options.push({ value: node.code, label: `${'　'.repeat(depth)}${node.name || node.code}` });
    }
    if (node.children && node.children.length > 0) {
      options.push(...flattenCategories(node.children, depth + 1));
    }
  }
  return options;
}

/** 页码窗口：当前页居中最多 5 个页码，与设计稿的「< 1 2 >」分页样式一致 */
function pageWindow(current: number, totalPages: number, size = 5): number[] {
  const half = Math.floor(size / 2);
  let start = Math.max(1, current - half);
  const end = Math.min(totalPages, start + size - 1);
  start = Math.max(1, end - size + 1);
  const pages: number[] = [];
  for (let value = start; value <= end; value += 1) pages.push(value);
  return pages;
}

function toPlanRow(plan: InspectionPlan): PlanRow {
  const version = effectiveVersion(plan);
  return {
    id: plan.id ?? plan.planCode,
    planCode: plan.planCode,
    planName: plan.planName,
    applicableProduct: applicableProductOf(plan),
    inspectionType: plan.inspectionType,
    itemCount: version?.items?.length ?? 0,
    // 方案状态由接口按 versions[].status 派生（契约 PlanStatusEnum）；字段缺失时按已停用兜底
    status: plan.status ?? 'DISABLED',
    // 生效周期提示与后端 findActivePlan 的周期过滤同口径，空串表示周期覆盖今天
    periodHint: periodHintOf(plan),
    // 创建人取生效版本（无生效版本时为最新版本）的创建人姓名，与「检验项目数」同版本口径
    creator: version?.createdByName ?? '-',
    updatedAt: formatDateTime(plan.updatedAt ?? version?.createdAt),
    raw: plan,
    actions: planVersionActionVisibility(plan),
  };
}

export function PlansPage() {
  // 草稿条件（界面输入）与已提交条件（驱动接口查询）分离：输入过程中不触发请求
  const [draft, setDraft] = useState<PlanFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<PlanFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  const [plans, setPlans] = useState<InspectionPlan[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<PlanStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  /** 新建/复制成功后自增，触发列表与 KPI 重新拉取 */
  const [refreshToken, setRefreshToken] = useState(0);

  const [categoryOptions, setCategoryOptions] = useState<{ value: string; label: string }[]>([]);

  const [detailPlan, setDetailPlan] = useState<InspectionPlan | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  // 参照数据（存货分类）：只用于「产品分类」筛选下拉的取值域。
  // 表格里的物料名 / 分类名 / 创建人姓名一律由接口读时派生，前端不再拉主数据做名称映射。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const categories = await api
        .get<CategoryNodeView[]>('/master-data/categories')
        .catch(() => [] as CategoryNodeView[]);
      if (cancelled) return;
      setCategoryOptions(flattenCategories(categories));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // KPI 统计：取服务端聚合（GET /plans/stats），与列表分页、界面筛选条件解耦
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<PlanStats>('/plans/stats');
        if (!cancelled) setStats(res);
      } catch {
        if (!cancelled) setStats(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  // 列表查询：筛选条件与分页全部下沉到后端，前端不对结果做二次过滤
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const res = await api.get<PlanListResponse>('/plans', {
          page,
          pageSize: PLAN_PAGE_SIZE,
          ...(applied.name.trim() !== '' ? { keyword: applied.name.trim() } : {}),
          ...(applied.productCode.trim() !== '' ? { materialCode: applied.productCode.trim() } : {}),
          ...(applied.categoryCode !== '全部' ? { categoryCode: applied.categoryCode } : {}),
          ...(applied.inspectionType !== '全部' ? { inspectionType: applied.inspectionType } : {}),
        });
        if (cancelled) return;
        setPlans(listOf(res));
        setTotal(Number(res.total ?? 0));
      } catch (err) {
        if (cancelled) return;
        setPlans([]);
        setTotal(0);
        setLoadError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applied, page, refreshToken]);

  const rows = useMemo(
    () => plans.map((plan) => toPlanRow(plan)),
    [plans]
  );

  const totalPages = Math.max(1, Math.ceil(total / PLAN_PAGE_SIZE));

  /** 查询：把界面上的草稿条件提交为接口条件，并回到第 1 页 */
  const handleSearch = () => {
    setPage(1);
    setApplied({ ...draft });
  };

  /** 重置：清空界面条件与已提交条件 */
  const handleReset = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(1);
  };

  /**
   * 复制方案：以当前生效版本的指标项为模板，通过 POST /plans 生成新方案副本。
   *
   * 方案编码**不在这里拼**（原实现是 `{原编码}-C{时间戳后 6 位}`：既不是当日流水、又可能撞号），
   * 一律交给服务端按 `QP-{YYYYMMDD}-{NNN}` 取号（TBD-11），并把服务端真正落库的编码回显给用户。
   */
  const handleCopy = async (row: PlanRow) => {
    const version = effectiveVersion(row.raw);
    if (!version || version.items.length === 0) {
      alert(`方案 [${row.planCode}] 当前版本没有可复制的指标项，请先在方案详情中配置`);
      return;
    }
    try {
      const copied = await api.post<InspectionPlan>('/plans', {
        planName: `${row.planName}-副本`,
        inspectionType: row.inspectionType,
        ...(row.raw.materialCode != null && row.raw.materialCode !== ''
          ? { materialCode: row.raw.materialCode }
          : {}),
        versions: [
          {
            versionNo: 'V1.0',
            samplingScheme: version.samplingScheme,
            aqlLevel: version.aqlLevel,
            strictness: version.strictness,
            items: version.items,
          },
        ],
      });
      alert(`已复制质检方案：${copied.planCode}（草稿态，待审批后启用）`);
      setRefreshToken((token) => token + 1);
    } catch (err) {
      alert(`复制方案失败：${errorMessage(err)}`);
    }
  };

  /**
   * 方案版本启停（POST /plans/versions/:versionId/status）：
   * 审批 = 启用草稿版本（ACTIVATE），停用 = 下架当前生效版本（DEACTIVATE）。
   *
   * 一律等真实接口返回后再刷新列表与 KPI，不做本地假改状态 ——
   * 界面上的「已启用 / 待审批 / 已停用」必须始终等于库中的 version_status 派生结果。
   */
  const toggleVersion = async (row: PlanRow, action: 'ACTIVATE' | 'DEACTIVATE') => {
    // 审批必须打到待审批草稿（见 approvalTargetVersion）；停用只打当前生效版本
    const version = action === 'ACTIVATE' ? approvalTargetVersion(row.raw) : effectiveVersion(row.raw);
    if (version === undefined || version.id === undefined) {
      alert(`方案 [${row.planCode}] 缺少版本行标识，无法启停，请刷新页面后重试`);
      return;
    }
    const versionId = version.id;
    if (
      action === 'DEACTIVATE' &&
      !window.confirm(
        `确认停用方案 [${row.planCode}] 的版本 ${version.versionNo}？停用后该方案不再参与检验录入的自动匹配。`
      )
    ) {
      return;
    }
    try {
      await api.post(`/plans/versions/${versionId}/status`, { action });
      alert(
        action === 'ACTIVATE'
          ? `方案 [${row.planCode}] 版本 ${version.versionNo} 已启用，现可参与检验录入的自动匹配`
          : `方案 [${row.planCode}] 版本 ${version.versionNo} 已停用，不再参与自动匹配`
      );
      setRefreshToken((token) => token + 1);
    } catch (err) {
      alert(`${action === 'ACTIVATE' ? '启用' : '停用'}方案版本失败：${errorMessage(err)}`);
    }
  };

  /**
   * 升级版本（POST /plans/versions/:versionId/upgrade）：
   * 以当前生效版本为模板，给该方案再产出一个草稿版本 ——
   * 版本号由服务端升位（如 v2.5 → v2.6）、指标项与抽样参数沿用当前版本、生效周期不继承（默认长期有效）。
   * 与启停同一口径：等接口真实返回后再刷新列表与 KPI，不做本地假改状态。
   */
  const upgradeVersion = async (row: PlanRow) => {
    const version = effectiveVersion(row.raw);
    if (version?.id === undefined) {
      alert(`方案 [${row.planCode}] 缺少版本行标识，无法升级版本，请刷新页面后重试`);
      return;
    }
    try {
      const updated = await api.post<InspectionPlan>(`/plans/versions/${version.id}/upgrade`, {});
      const draft = (updated.versions ?? []).find((candidate) => candidate.status === 'DRAFT');
      alert(
        `方案 [${row.planCode}] 已生成草稿版本 ${draft?.versionNo ?? ''}（继承当前版本的指标项与抽样参数，生效周期未设置＝长期有效），待质量主管审批后启用`
      );
      setRefreshToken((token) => token + 1);
    } catch (err) {
      alert(`升级方案版本失败：${errorMessage(err)}`);
    }
  };

  return (
    <div className="space-y-4 font-sans text-slate-800">
      {/* 页面标题与顶部操作 */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[24px] font-bold text-[#1E293B] tracking-tight">质检方案设计</h1>
          <p className="text-[14px] text-[#94A3B8] mt-1.5">
            根据产品或产品分类设置质检方案，同一产品可配置多种质检方案类型
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => alert('请选择要导入的质检方案文件 (.xlsx, .json)')}
            className="h-11 flex items-center gap-2 px-5 bg-white border border-[#E2E8F0] rounded-[10px] text-[14px] font-medium text-[#1E293B] hover:bg-slate-50 transition-colors"
          >
            <img src={planImportIcon} alt="" className="w-[18px] h-[18px] object-contain" />
            <span>导入方案</span>
          </button>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="h-11 flex items-center gap-1.5 px-5 bg-[#2B5AED] hover:bg-[#2450D4] text-white rounded-[10px] text-[14px] font-medium transition-colors"
          >
            <Plus className="w-[18px] h-[18px]" />
            <span>新建质检方案</span>
          </button>
        </div>
      </div>

      {/* 筛选条件卡片 */}
      <div className="bg-white rounded-xl border border-[#F1F5F9] px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-x-14 gap-y-3 text-[14px] text-[#1E293B]">
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-[#475569]">方案名称</span>
              <input
                type="text"
                placeholder="请输入方案名称"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleSearch();
                }}
                className="h-10 w-[215px] px-3.5 text-[14px] bg-white border border-[#E2E8F0] rounded-lg placeholder-[#94A3B8] focus:outline-none focus:border-[#2B5AED] transition-colors"
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="shrink-0 text-[#475569]">产品编码</span>
              <input
                type="text"
                placeholder="MAT-304SS-05"
                value={draft.productCode}
                onChange={(event) => setDraft({ ...draft, productCode: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleSearch();
                }}
                className="h-10 w-[200px] px-3.5 text-[14px] bg-white border border-[#E2E8F0] rounded-lg placeholder-[#94A3B8] focus:outline-none focus:border-[#2B5AED] transition-colors"
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="shrink-0 text-[#475569]">产品分类</span>
              <div className="relative">
                <select
                  value={draft.categoryCode}
                  onChange={(event) => setDraft({ ...draft, categoryCode: event.target.value })}
                  className="h-10 w-[180px] appearance-none px-3.5 pr-9 text-[14px] bg-white border border-[#E2E8F0] rounded-lg text-[#1E293B] focus:outline-none focus:border-[#2B5AED] cursor-pointer"
                >
                  <option value="全部">全部</option>
                  {categoryOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8]" />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="shrink-0 text-[#475569]">质检类型</span>
              <div className="relative">
                <select
                  value={draft.inspectionType}
                  onChange={(event) => setDraft({ ...draft, inspectionType: event.target.value })}
                  className="h-10 w-[185px] appearance-none px-3.5 pr-9 text-[14px] bg-white border border-[#E2E8F0] rounded-lg text-[#1E293B] focus:outline-none focus:border-[#2B5AED] cursor-pointer"
                >
                  <option value="全部">全部</option>
                  {(Object.keys(INSPECTION_TYPES) as InspectionType[]).map((type) => (
                    <option key={type} value={type}>
                      {INSPECTION_TYPES[type].label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8]" />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={handleReset}
              className="h-10 px-5 bg-white border border-[#E2E8F0] rounded-lg text-[14px] text-[#475569] hover:bg-slate-50 transition-colors"
            >
              重置
            </button>
            <button
              onClick={handleSearch}
              className="h-10 px-5 bg-[#2B5AED] hover:bg-[#2450D4] text-white rounded-lg text-[14px] font-medium transition-colors"
            >
              查询
            </button>
          </div>
        </div>
      </div>

      {/* KPI 指标卡 */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-[#F1F5F9] p-5 flex items-center gap-4">
          <img src={planKpiTotal} alt="质检方案总数" className="w-[54px] h-[54px] object-contain shrink-0" />
          <div className="flex flex-col justify-center">
            <span className="text-[14px] text-[#64748B]">质检方案总数</span>
            <span className="text-2xl font-bold text-[#1E293B] tracking-tight mt-0.5">
              {stats === null ? '-' : stats.total}
            </span>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-[#F1F5F9] p-5 flex items-center gap-4">
          <img src={planKpiEnabled} alt="已启用" className="w-[54px] h-[54px] object-contain shrink-0" />
          <div className="flex flex-col justify-center">
            <span className="text-[14px] text-[#64748B]">已启用</span>
            <span className="text-2xl font-bold text-[#1E293B] tracking-tight mt-0.5">
              {stats === null ? '-' : stats.enabled}
            </span>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-[#F1F5F9] p-5 flex items-center gap-4">
          <img src={planKpiPending} alt="待审批" className="w-[54px] h-[54px] object-contain shrink-0" />
          <div className="flex flex-col justify-center">
            <span className="text-[14px] text-[#64748B]">待审批</span>
            <span className="text-2xl font-bold text-[#1E293B] tracking-tight mt-0.5">
              {stats === null ? '-' : stats.pending}
            </span>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-[#F1F5F9] p-5 flex items-center gap-4">
          <img src={planKpiProducts} alt="覆盖产品数" className="w-[54px] h-[54px] object-contain shrink-0" />
          <div className="flex flex-col justify-center">
            <span className="text-[14px] text-[#64748B]">覆盖产品数</span>
            <span className="text-2xl font-bold text-[#1E293B] tracking-tight mt-0.5">
              {stats === null ? '-' : stats.productCount}
            </span>
          </div>
        </div>
      </div>

      {/* 方案台账卡片 */}
      <div className="bg-white rounded-xl border border-[#F1F5F9] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px] border-collapse">
            <thead>
              <tr className="bg-[#F5F7FA] border-b border-[#E2E8F0] text-[#94A3B8]">
                <th className="py-4 px-6 font-normal">方案编号</th>
                <th className="py-4 px-4 font-normal">方案名称</th>
                <th className="py-4 px-4 font-normal">适用产品</th>
                <th className="py-4 px-4 font-normal">质检类型</th>
                <th className="py-4 px-4 font-normal">检验类别</th>
                <th className="py-4 px-4 font-normal">检验项目数</th>
                <th className="py-4 px-4 font-normal">状态</th>
                <th className="py-4 px-4 font-normal">创建人</th>
                <th className="py-4 px-4 font-normal">更新时间</th>
                <th className="py-4 px-5 font-normal text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-[#1E293B]">
              {loading ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-400">
                    加载中...
                  </td>
                </tr>
              ) : loadError !== '' ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-400">
                    质检方案加载失败：{loadError}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-400">
                    未检索到符合条件的质检方案
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const typeBadge = TYPE_BADGES[row.inspectionType] ?? TYPE_BADGES.IQC;
                  const statusBadge = STATUS_BADGES[row.status];
                  const categoryBadges: Badge[] = [];
                  for (const item of effectiveVersion(row.raw)?.items ?? []) {
                    const badge = CATEGORY_BADGES[item.metricCategory] ?? CATEGORY_BADGES.DIMENSION;
                    if (!categoryBadges.some((existing) => existing.label === badge.label)) {
                      categoryBadges.push(badge);
                    }
                  }
                  return (
                    <tr key={row.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-4 px-6">
                        <button
                          onClick={() => setDetailPlan(row.raw)}
                          className="text-[#2B5AED] hover:underline font-medium"
                        >
                          {row.planCode}
                        </button>
                      </td>

                      <td className="py-4 px-4 font-bold text-[#1E293B]">{row.planName}</td>

                      <td className="py-4 px-4">{row.applicableProduct}</td>

                      <td className="py-4 px-4">
                        <span
                          className="inline-block px-2.5 py-1 rounded-md"
                          style={{ backgroundColor: typeBadge.bg, color: typeBadge.text }}
                        >
                          {typeBadge.label}
                        </span>
                      </td>

                      <td className="py-4 px-4">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {categoryBadges.map((badge) => (
                            <span
                              key={badge.label}
                              className="inline-block px-2.5 py-1 rounded-md"
                              style={{ backgroundColor: badge.bg, color: badge.text }}
                            >
                              {badge.label}
                            </span>
                          ))}
                        </div>
                      </td>

                      <td className="py-4 px-4">{row.itemCount}项</td>

                      <td className="py-4 px-4">
                        <span
                          className="inline-block px-2.5 py-1 rounded-md"
                          style={{ backgroundColor: statusBadge.bg, color: statusBadge.text }}
                        >
                          {statusBadge.label}
                        </span>
                        {row.periodHint !== '' && (
                          <div
                            className="mt-1 text-[11px] text-amber-600"
                            title={`生效周期：${periodLabelOf(row.raw)}；不在周期内的版本不参与自动匹配`}
                          >
                            {row.periodHint}
                          </div>
                        )}
                      </td>

                      <td className="py-4 px-4">{row.creator}</td>

                      <td className="py-4 px-4 text-[#94A3B8]">{row.updatedAt}</td>

                      <td className="py-4 px-5 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            onClick={() => setDetailPlan(row.raw)}
                            className="text-[#2B5AED] hover:underline"
                          >
                            编辑
                          </button>
                          {/* 操作列可见性统一取 row.actions（lib/planVersionActions），
                              保证「按钮出现 ⟺ 动作真能执行」：已有草稿时隐藏【升级版本】，
                              存在 ACTIVE 版本时才给【停用】，全部停用才给【启用】 */}
                          {row.actions.upgrade && (
                            <button
                              onClick={() => void upgradeVersion(row)}
                              className="text-[#2B5AED] hover:underline"
                            >
                              升级版本
                            </button>
                          )}
                          {/* 审批入口：只要存在待审批草稿就给按钮 —— 含「已启用 + 有新草稿」这一升版后的常态
                              （方案级状态仍是已启用，但草稿必须能被批掉，否则升版链路在界面上走不通） */}
                          {row.actions.approve && (
                            <button
                              onClick={() => void toggleVersion(row, 'ACTIVATE')}
                              className="text-[#2B5AED] hover:underline"
                            >
                              审批
                            </button>
                          )}
                          {row.actions.deactivate && (
                            <button
                              onClick={() => void toggleVersion(row, 'DEACTIVATE')}
                              className="text-[#2B5AED] hover:underline"
                            >
                              停用
                            </button>
                          )}
                          {/* 已停用行没有 ACTIVE 版本，但版本行仍可重新启用（接口语义支持） */}
                          {row.actions.reactivate && (
                            <button
                              onClick={() => void toggleVersion(row, 'ACTIVATE')}
                              className="text-[#2B5AED] hover:underline"
                            >
                              启用
                            </button>
                          )}
                          <button
                            onClick={() => void handleCopy(row)}
                            className="text-[#2B5AED] hover:underline"
                          >
                            复制
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

        {/* 分页 */}
        <div className="flex items-center justify-end px-6 py-5 border-t border-[#F1F5F9] gap-3 text-[14px] text-[#94A3B8]">
          <span>共 {total} 条</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1}
              className="w-9 h-9 flex items-center justify-center rounded-lg border border-[#E2E8F0] text-[#94A3B8] hover:bg-slate-50 disabled:opacity-40"
            >
              &lt;
            </button>
            {pageWindow(page, totalPages).map((pageNo) => (
              <button
                key={pageNo}
                onClick={() => setPage(pageNo)}
                className={`w-9 h-9 flex items-center justify-center rounded-lg ${
                  pageNo === page
                    ? 'bg-[#2B5AED] text-white border border-[#2B5AED]'
                    : 'border border-[#E2E8F0] text-[#1E293B] hover:bg-slate-50'
                }`}
              >
                {pageNo}
              </button>
            ))}
            <button
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages}
              className="w-9 h-9 flex items-center justify-center rounded-lg border border-[#E2E8F0] text-[#94A3B8] hover:bg-slate-50 disabled:opacity-40"
            >
              &gt;
            </button>
          </div>
        </div>
      </div>

      {/* 方案详情弹窗 */}
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
            <div className="text-sm space-y-2 text-slate-600">
              <div>
                适用产品：
                <span className="font-semibold text-slate-900">
                  {applicableProductOf(detailPlan)}
                </span>
              </div>
              <div>
                质检类型：
                <span className="font-semibold text-slate-900">
                  {TYPE_BADGES[detailPlan.inspectionType]?.label ?? detailPlan.inspectionType}
                </span>
              </div>
              <div>
                状态：
                <span className="font-semibold text-slate-900">
                  {STATUS_BADGES[detailPlan.status ?? 'DISABLED'].label}
                </span>
              </div>
              <div className="font-semibold text-slate-900 pt-2">版本与指标项：</div>
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-60 overflow-y-auto">
                {(effectiveVersion(detailPlan)?.items ?? []).map((item, index) => (
                  <div
                    key={`${item.itemCode}-${index}`}
                    className="p-2.5 flex items-center justify-between text-sm"
                  >
                    <span className="font-medium text-slate-700">{item.name}</span>
                    <span className="text-slate-500">
                      {item.standardText ?? `${item.nominalValue ?? '-'} ${item.unit ?? ''}`}
                    </span>
                  </div>
                ))}
                {(effectiveVersion(detailPlan)?.items ?? []).length === 0 && (
                  <div className="p-3 text-center text-slate-400">该方案版本尚未配置指标项</div>
                )}
              </div>
              <div className="text-slate-400">
                版本：
                {(detailPlan.versions ?? [])
                  .map((version) => `${version.versionNo}（${version.status}）`)
                  .join('、') || '-'}
              </div>
              <div>
                生效周期：
                <span className="font-semibold text-slate-900">{periodLabelOf(detailPlan)}</span>
                {periodHintOf(detailPlan) !== '' && (
                  <span className="ml-2 text-amber-600">
                    （{periodHintOf(detailPlan)}，不参与自动匹配）
                  </span>
                )}
              </div>
            </div>
            <div className="flex justify-end pt-3">
              <button
                onClick={() => setDetailPlan(null)}
                className="px-5 py-2 rounded-lg bg-[#2B5AED] text-white text-sm font-medium hover:bg-[#2450D4]"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      <CreatePlanModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={() => {
          setPage(1);
          setRefreshToken((token) => token + 1);
        }}
      />
    </div>
  );
}
