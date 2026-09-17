import { InspectionTypeEnum } from './inspection.js';
import type { z } from 'zod';

/**
 * 检验类型展示分组 —— 前后端共享的唯一分组定义。
 *
 * 契约 InspectionTypeEnum 的真实成员只有 6 个细分类型，页面把它们归并成 4 个展示分组：
 *   IQC  = 来料进货检验
 *   IPQC = 过程制程 (下料 IPQC_CT / 滚丝 IPQC_RL / 成品检 IPQC_FN)
 *   FQC  = 成品入库终检 (IPQC_FN)，它是 IPQC 组的子集 —— 分组之间允许重叠
 *   OQC  = 委外与出货 (委外 OQC_SF / 出货 OQC_SH)
 *
 * 该文件只描述"哪些枚举成员属于哪个分组"这一业务事实（分组语义），
 * 中文展示名等纯展示信息仍留在前端页面层，避免契约层承载 UI 文案。
 *
 * 分组筛选必须由服务端与前端共用同一份成员定义，
 * 否则会出现「页签点得到、接口查不到」的前后端规则漂移。
 */
/** 契约检验类型（与 dtos 的 InspectionType 同义；此处只用内部别名避免重复导出） */
type InspectionTypeValue = z.infer<typeof InspectionTypeEnum>;
export type InspectionGroup = 'IQC' | 'IPQC' | 'FQC' | 'OQC';
export type InspectionFilterTab = 'ALL' | InspectionGroup;

/** 展示分组 → 包含的契约成员 与 录入表单默认提交的细分类型 */
export const INSPECTION_GROUPS: Record<
  InspectionGroup,
  { members: readonly InspectionTypeValue[]; submitType: InspectionTypeValue }
> = {
  IQC: { members: ['IQC'], submitType: 'IQC' },
  IPQC: { members: ['IPQC_CT', 'IPQC_RL', 'IPQC_FN'], submitType: 'IPQC_CT' },
  FQC: { members: ['IPQC_FN'], submitType: 'IPQC_FN' },
  OQC: { members: ['OQC_SF', 'OQC_SH'], submitType: 'OQC_SH' },
};

/** 页面筛选页签顺序（ALL 表示不过滤） */
export const INSPECTION_FILTER_TABS: readonly InspectionFilterTab[] = [
  'ALL',
  ...(Object.keys(INSPECTION_GROUPS) as InspectionGroup[]),
];

/** 运行时判定一个 query 参数是否为合法的页面展示分组 */
export function isInspectionGroup(value: string): value is InspectionGroup {
  return Object.prototype.hasOwnProperty.call(INSPECTION_GROUPS, value);
}

/** 展示分组筛选匹配规则（服务端查询与前端页签共用） */
export function inspectionTypeMatchesGroup(type: InspectionTypeValue, group: string): boolean {
  if (group === 'ALL') return true;
  return isInspectionGroup(group) && INSPECTION_GROUPS[group].members.includes(type);
}

/** 展示分组 → 契约枚举成员集合（服务端 SQL IN 过滤使用；非法分组返回空数组） */
export function inspectionGroupMembers(group: string): readonly InspectionTypeValue[] {
  return isInspectionGroup(group) ? INSPECTION_GROUPS[group].members : [];
}
