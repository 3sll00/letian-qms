
// 不合格来源分类的**类型**由 dtos 统一派生（`z.infer<typeof MRBFailCategoryEnum>`），
// 这里只做类型引用，避免与 schemas/mrb 之间产生运行时环依赖。
import type { MRBFailCategory } from '../dtos';

export type InspectionGroupKey = 'ALL' | 'IQC' | 'IPQC' | 'OUTSOURCE' | 'OQC';

/**
 * 检验类型与业务大类的分组映射
 * 委外大类扩展为七工艺分类 (热处理/发黑/镀锌/镀镍/磷化/达克罗/机加工)
 */
export const INSPECTION_GROUPS = {
  IQC: ['IQC'] as const,
  IPQC: ['IPQC_CT', 'IPQC_RL', 'IPQC_FN'] as const,
  OUTSOURCE: [
    'OQC_SF',    // 通用表面处理
    'OQC_HEAT',  // 委外热处理
    'OQC_BLACK', // 委外发黑
    'OQC_ZINC',  // 委外镀锌
    'OQC_NICKEL',// 委外镀镍
    'OQC_PHOSPH',// 委外磷化
    'OQC_DACRO', // 委外达克罗
    'OQC_MACH',  // 委外机加工
  ] as const,
  OQC: ['OQC_SH'] as const,
} as const;

export const INSPECTION_FILTER_TABS = [
  { key: 'ALL', label: '全部检验' },
  { key: 'IQC', label: '来料检验 (IQC)' },
  { key: 'IPQC', label: '过程检验 (IPQC)' },
  { key: 'OUTSOURCE', label: '委外加工 (7分类)' },
  { key: 'OQC', label: '出货检验 (OQC)' },
] as const;

export function isInspectionGroup(value: unknown): value is InspectionGroupKey {
  return (
    typeof value === 'string' &&
    ['ALL', 'IQC', 'IPQC', 'OUTSOURCE', 'OQC'].includes(value)
  );
}

export function inspectionTypeMatchesGroup(
  inspectionType: string,
  group: InspectionGroupKey,
): boolean {
  if (group === 'ALL') return true;
  const validTypes = INSPECTION_GROUPS[group] as readonly string[];
  return validTypes ? validTypes.includes(inspectionType) : false;
}

export function inspectionGroupMembers(group: InspectionGroupKey): string[] {
  if (group === 'ALL') {
    return Object.values(INSPECTION_GROUPS).flat();
  }
  return [...INSPECTION_GROUPS[group]];
}

/** 业务大类 → 不合格来源分类（驱动 MRB 评审流程路由） */
export const GROUP_TO_FAIL_CATEGORY: Record<
  Exclude<InspectionGroupKey, 'ALL'>,
  MRBFailCategory
> = {
  IQC: 'INCOMING_FAIL',
  IPQC: 'PROCESS_FAIL',
  OUTSOURCE: 'SUBCONTRACT_FAIL',
  OQC: 'SHIPMENT_FAIL',
};

/**
 * 检验环节 → 不合格来源分类（`mrb_reviews.source_type` / `review_flows.applicable_type`）的**唯一口径**。
 *
 * 口径表（docs/44-过程委外出货不合格自动进MRB口径补齐设计.md §1）：
 * - `IQC` → `INCOMING_FAIL`（来料）
 * - `IPQC_CT` / `IPQC_RL` / `IPQC_FN` → `PROCESS_FAIL`（过程：下料 / 滚丝 / 成品检）
 * - `OQC_SF` / `OQC_HEAT` / `OQC_BLACK` / `OQC_ZINC` / `OQC_NICKEL` / `OQC_PHOSPH` / `OQC_DACRO` / `OQC_MACH`
 *   → `SUBCONTRACT_FAIL`（委外：通用表面处理 + 七分类）
 * - `OQC_SH*` → `SHIPMENT_FAIL`（出货检验 / 客户放行）
 *
 * 先按 `INSPECTION_GROUPS`（唯一分组清单）精确命中，再走历史别名（`FQC*` / `SHIPMENT*` → 出货，
 * `OUTSOURCE*` / `SUBCONTRACT*` → 委外），最后对未知环节回落 `PROCESS_FAIL` ——
 * 终判是现场写路径，不能因为「出现了一个没登记过的检验类型」把质量判定卡死（回落分支显式声明，非静默兜底）。
 */
export function inspectionTypeToFailCategory(inspectionType: string | undefined): MRBFailCategory {
  const type = (inspectionType ?? '').trim().toUpperCase();
  if (type === '') return 'PROCESS_FAIL';

  for (const [group, category] of Object.entries(GROUP_TO_FAIL_CATEGORY) as Array<
    [Exclude<InspectionGroupKey, 'ALL'>, MRBFailCategory]
  >) {
    if (inspectionGroupMembers(group).includes(type)) return category;
  }

  if (type.startsWith('FQC') || type.startsWith('SHIPMENT')) return 'SHIPMENT_FAIL';
  if (type.startsWith('OUTSOURCE') || type.startsWith('SUBCONTRACT')) return 'SUBCONTRACT_FAIL';
  // 未登记子类型按前缀归族：`OQC_SH*` 是出货，其余 `OQC_*` 一律委外
  if (type.startsWith('OQC_SH')) return 'SHIPMENT_FAIL';
  if (type.startsWith('OQC')) return 'SUBCONTRACT_FAIL';
  if (type.startsWith('IPQC')) return 'PROCESS_FAIL';
  if (type.startsWith('IQC')) return 'INCOMING_FAIL';
  return 'PROCESS_FAIL';
}
