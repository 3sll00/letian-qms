import { InspectionTypeEnum } from './inspection';
import { z } from 'zod';

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
