import type { InspectionType } from '@letian/contracts';

/**
 * 检验环节传递阶梯（docs/48-合格后传递通用链路规则设计与改造方案.md §2.2）
 *
 * **本文件是「环节先后顺序」的唯一真相**：`inspection-stage.ts` 的 `ORDER_TYPE_STAGE.seq`
 * 由此派生，传递门禁的 `predecessorTiersOf` 也由此派生 —— 顺序只允许存在一处，
 * 两处各写一份必然出现「台账顺序与门禁顺序不一致」。
 *
 * 序位按**工艺先后**排，不按时间排（现场时间戳会因补录而乱序，与 docs/41 §4 同口径）：
 *   来料检验(1) → 下料(2) → 滚丝(3) → 成品检(4) → 委外各工艺(5，彼此并列) → 出货检验(6)
 */
export const STAGE_SEQUENCE: Readonly<Record<InspectionType, number>> = {
  IQC: 1,
  IPQC_CT: 2,
  IPQC_RL: 3,
  IPQC_FN: 4,
  OQC_SF: 5,
  OQC_HEAT: 5,
  OQC_BLACK: 5,
  OQC_ZINC: 5,
  OQC_NICKEL: 5,
  OQC_PHOSPH: 5,
  OQC_DACRO: 5,
  OQC_MACH: 5,
  OQC_SH: 6,
};

/**
 * 委外检验八类（`OQC_SF` + 七分类细分）。
 *
 * 口径（docs/48 §3 补充）：八类彼此**并列**而非上下游 —— 同一批次先后做「热处理 → 镀锌」
 * 是正常工艺，前者不合格不阻断后者；只有出货检验才要求委外环节全部放行。
 */
export const OUTSOURCE_INSPECTION_TYPES: readonly InspectionType[] = [
  'OQC_SF',
  'OQC_HEAT',
  'OQC_BLACK',
  'OQC_ZINC',
  'OQC_NICKEL',
  'OQC_PHOSPH',
  'OQC_DACRO',
  'OQC_MACH',
];

/** 环节工艺序位；未知类型返回 0（不参与排序与门禁，fail-safe 而非抛错） */
export function stageSeqOf(type: InspectionType): number {
  return STAGE_SEQUENCE[type] ?? 0;
}

/**
 * 门禁上游环节集合：**所有工艺序位更低的环节**（累计口径，docs/48 §2.2）。
 *
 * 为什么是「累计」而不是「只取紧邻上一环节」：本项目的跨工序批次号会变化，
 * 只有拿到锚点（同批次 / 同炉批号 / 同工单）才能把上下游串起来；一旦某个低序位环节
 * 与下游单落在**同一锚点**上，它就是这个批次的真实上游，必须参与门禁 ——
 * 例如同炉批号的来料检验不合格，同炉号做出的成品当然不许出货（AC-14）。
 *
 * 累计不会导致「误阻断」：门禁只对**确实存在候选单**的环节生效（找不到上游单时按
 * TBD-01 放行并留痕），所以「该批次没走委外」不会凭空把出货卡住。
 *
 * 并列关系不受影响：委外八类序位相同、彼此**不**互为上游（热处理不合格不阻断镀锌）。
 */
export function predecessorStagesOf(type: InspectionType): readonly InspectionType[] {
  const seq = stageSeqOf(type);
  if (seq <= 1) {
    return [];
  }
  return (Object.keys(STAGE_SEQUENCE) as InspectionType[])
    .filter((candidate) => STAGE_SEQUENCE[candidate] < seq)
    .sort((left, right) => STAGE_SEQUENCE[left] - STAGE_SEQUENCE[right]);
}

/**
 * 门禁上游**分层**（外层是层，内层是同层并列环节）。
 *
 * 当前口径只有一层（累计上游集合），保留分层结构是为了将来接入 `batch_trace_relations`
 * 血缘边（A4 锚点，P2）时可以表达「血缘优先、锚点兜底」的优先级，而不必改调用方。
 */
export function predecessorTiersOf(type: InspectionType): readonly (readonly InspectionType[])[] {
  const stages = predecessorStagesOf(type);
  return stages.length === 0 ? [] : [stages];
}

/**
 * 下游环节集合：**所有工艺序位更高的环节**（`predecessorStagesOf` 的镜像）。
 *
 * 用途：退货 / 报废导致链路终止时，需要一次性找出「本环节之后、已建但未终判」的单据去冻结
 * （docs/48 §3-9）。与上游集合一样按锚点等值取回，因此不含任何跨链路的臆测。
 */
export function successorStagesOf(type: InspectionType): readonly InspectionType[] {
  const seq = stageSeqOf(type);
  return (Object.keys(STAGE_SEQUENCE) as InspectionType[])
    .filter((candidate) => STAGE_SEQUENCE[candidate] > seq)
    .sort((left, right) => STAGE_SEQUENCE[left] - STAGE_SEQUENCE[right]);
}
