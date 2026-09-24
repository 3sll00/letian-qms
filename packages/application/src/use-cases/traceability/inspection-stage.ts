/**
 * 检验环节口径单点模块（docs/41-检验环节自动登记追溯节点设计.md §4）
 *
 * 「检验类型 → 环节名」「检验单状态 + 终判 → 追溯节点状态」「来源单据号」三件事有两处消费方：
 *   1. 订单维度视图（`GetOrderTraceChainUseCase`：【本订单检验环节】）；
 *   2. 批次追溯节点登记（`registerInspectionTraceNode`：写 `batch_trace_nodes`）。
 * 两处必须共用同一份映射 —— 同一环节在两张界面上出现两种中文名就是口径打架（docs/04 §? 口径统一），
 * 因此把映射抽成单点：要改只改这一个文件，新增检验类型时 TS 会编译期报错逼你补齐。
 */

import type {
  InspectionOrder,
  InspectionStatus,
  InspectionType,
  OverallDecision,
  TraceNodeStatus,
} from '@letian/contracts';
import { stageSeqOf } from '@letian/domain';
/**
 * 检验类型 → 工艺序位 + 环节简称。
 *
 * 用 `Record<InspectionType, ...>` 而不是松散对象：契约新增检验类型时此处编译期报错，
 * 不会静默漏掉一个环节。序位按**工艺先后**排，不按时间排 —— 现场的时间戳可能因补录而乱序。
 *
 * **序位的唯一真相已下沉到 `@letian/domain` 的 `STAGE_SEQUENCE`**（docs/48 §4.3）：
 * 传递门禁的「门禁上游集合」由同一份序位派生，本表只负责中文名并**派生** seq，
 * 避免出现「台账排序」与「门禁顺序」两份序位表（两份必然打架）。
 */
function stage(type: InspectionType, stageName: string): { seq: number; stageName: string } {
  return { seq: stageSeqOf(type), stageName };
}

export const ORDER_TYPE_STAGE: Readonly<Record<InspectionType, { seq: number; stageName: string }>> = {
  IQC: stage('IQC', '来料检验'),
  IPQC_CT: stage('IPQC_CT', '下料检'),
  IPQC_RL: stage('IPQC_RL', '滚丝检'),
  IPQC_FN: stage('IPQC_FN', '成品检'),
  OQC_SF: stage('OQC_SF', '委外表面处理检'),
  OQC_HEAT: stage('OQC_HEAT', '委外热处理检'),
  OQC_BLACK: stage('OQC_BLACK', '委外发黑检'),
  OQC_ZINC: stage('OQC_ZINC', '委外镀锌检'),
  OQC_NICKEL: stage('OQC_NICKEL', '委外镀镍检'),
  OQC_PHOSPH: stage('OQC_PHOSPH', '委外磷化检'),
  OQC_DACRO: stage('OQC_DACRO', '委外达克罗检'),
  OQC_MACH: stage('OQC_MACH', '委外机加工检'),
  OQC_SH: stage('OQC_SH', '出货检验'),
};

/**
 * 检验单状态 + 终判 → 追溯节点状态。
 *
 * 终判优先：`CONCESSION`（特采）必须如实呈现，不得被压成 `PASSED`。
 * 已结单却没有终判属于口径异常：按「检验中」展示，**不冒充合格**。
 */
export function toTraceNodeStatus(status: InspectionStatus, judgment: OverallDecision | undefined): TraceNodeStatus {
  if (judgment === 'CONCESSION') return 'CONCESSION';
  if (judgment === 'FAILED') return 'FAILED';
  if (judgment === 'PASSED') return 'PASSED';

  switch (status) {
    case 'FAILED':
      return 'FAILED';
    case 'PASSED':
      return 'PASSED';
    case 'PENDING':
      return 'PENDING';
    default:
      // INSPECTING / DRAFT / RE_INSPECTING / IN_MRB_REVIEW / COMPLETED(无终判)
      return 'INSPECTING';
  }
}

/**
 * 来源单据号：按环节类型取该环节真正对应的上游单据，**不含批次号兜底**。
 *
 * 追溯节点卡片上的「来源单据」必须是真实上游单据；查不到就留空（界面显示 —），
 * 把批次号当单据号展示等于编造来源（docs/24 §3.2 口径）。
 * 订单维度视图若要保留「无则回落批次号」的既有展示权衡，由调用方自行兜底。
 */
export function resolveInspectionSourceDocNo(order: InspectionOrder): string | undefined {
  if (order.inspectionType === 'OQC_SH') {
    return order.salesOrderNo;
  }
  if (order.inspectionType.startsWith('OQC_')) {
    return order.outsourceNo;
  }
  if (order.inspectionType === 'IQC') {
    return order.inboundNo;
  }
  return order.workOrderNo;
}
