import type { InspectionStatus, InspectionType } from '@letian/contracts';

/**
 * 检验类型页面映射 —— 单一来源 (single source of truth)。
 *
 * 契约 InspectionTypeEnum (packages/contracts/src/schemas/inspection.ts) 的真实成员只有：
 *   IQC / IPQC_CT / IPQC_RL / IPQC_FN / OQC_SF / OQC_SH
 * 页面把细分类型归并成 4 个展示分组，供筛选页签与录入表单使用：
 *   IQC  = 来料进货检验
 *   IPQC = 过程制程 (下料 IPQC_CT / 滚丝 IPQC_RL / 成品检 IPQC_FN)
 *   FQC  = 成品入库终检 (IPQC_FN)，它是 IPQC 组的子集 —— 分组之间允许重叠
 *   OQC  = 委外与出货 (委外 OQC_SF / 出货 OQC_SH)
 *
 * 为什么这里是两张表而不是一张：
 *   - INSPECTION_TYPES 方向为「枚举 → 展示信息」，用于读取接口数据时渲染 (列表 / 详情)；
 *   - INSPECTION_GROUPS 方向为「分组 → 契约成员 + 表单默认提交类型」，用于写入接口时反查。
 *     一个页面选项必须落到一个确定的枚举值，而「枚举 → 分组」是多对一，无法反向唯一还原，
 *     两个方向语义不同，因此保留两张表，但所有键/值都只引用契约真实枚举成员；
 *     任一侧新增枚举成员时，TS 会因 Record<InspectionType, ...> 缺键而在此处直接报错。
 */
export type InspectionGroup = 'IQC' | 'IPQC' | 'FQC' | 'OQC';
export type InspectionFilterTab = 'ALL' | InspectionGroup;

/** 契约枚举成员 → 展示分组与中文名 (列表 / 详情渲染的唯一入口) */
export const INSPECTION_TYPES: Record<
  InspectionType,
  { group: InspectionGroup; label: string }
> = {
  IQC: { group: 'IQC', label: 'IQC 来料检验' },
  IPQC_CT: { group: 'IPQC', label: 'IPQC 下料检验' },
  IPQC_RL: { group: 'IPQC', label: 'IPQC 滚丝检验' },
  IPQC_FN: { group: 'FQC', label: 'FQC 成品入库终检' },
  OQC_SF: { group: 'OQC', label: 'OQC 委外加工检验' },
  OQC_SH: { group: 'OQC', label: 'OQC 出货检验' },
};

/** 展示分组 → 包含的契约成员 与 录入表单默认提交的细分类型 */
export const INSPECTION_GROUPS: Record<
  InspectionGroup,
  { members: readonly InspectionType[]; submitType: InspectionType }
> = {
  IQC: { members: ['IQC'], submitType: 'IQC' },
  IPQC: { members: ['IPQC_CT', 'IPQC_RL', 'IPQC_FN'], submitType: 'IPQC_CT' },
  FQC: { members: ['IPQC_FN'], submitType: 'IPQC_FN' },
  OQC: { members: ['OQC_SF', 'OQC_SH'], submitType: 'OQC_SH' },
};

export const INSPECTION_FILTER_TABS: readonly InspectionFilterTab[] = [
  'ALL',
  'IQC',
  'IPQC',
  'FQC',
  'OQC',
];

/** 运行时判定一个 query 参数是否为合法的页面展示分组 */
export function isInspectionGroup(value: string): value is InspectionGroup {
  return Object.prototype.hasOwnProperty.call(INSPECTION_GROUPS, value);
}

/** 单条记录的检验类型展示名 */
export function inspectionTypeLabel(type: InspectionType): string {
  return INSPECTION_TYPES[type].label;
}

/**
 * 契约 InspectionStatusEnum 成员 → 台账展示用中文名。
 *
 * 用途：工单「尚未形成综合判定」(overallDecision 为空) 时，台账必须按后端真实状态展示，
 * 不能一律显示成「合格通过」——否则刚创建、一条实测值都没录入的工单会被误读为已放行。
 * Record<InspectionStatus, ...> 保证枚举新增成员时此处编译期报错，不会静默漏掉新状态。
 */
export const INSPECTION_STATUS_LABELS: Record<InspectionStatus, string> = {
  PENDING: '待检验',
  INSPECTING: '检验录入中',
  DRAFT: '草稿暂存',
  PASSED: '合格通过',
  FAILED: '不合格',
  IN_MRB_REVIEW: 'MRB 评审中',
  RE_INSPECTING: '复检中',
  COMPLETED: '已结单',
};

/**
 * 展示分组筛选匹配规则。
 * 页面页签 (前端) 与 mock handler 的 query 过滤 (被 mock 的后端) 共用此函数，
 * 保证「页签能看到什么」与「接口返回什么」使用同一份成员定义。
 */
export function inspectionTypeMatchesGroup(type: InspectionType, group: string): boolean {
  if (group === 'ALL') return true;
  return isInspectionGroup(group) && INSPECTION_GROUPS[group].members.includes(type);
}
