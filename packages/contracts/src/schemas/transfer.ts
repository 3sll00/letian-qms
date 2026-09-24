import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { InspectionStatusEnum, InspectionTypeEnum, OverallDecisionEnum, TransferOverrideInputSchema } from './inspection';
import { MRBDispositionEnum } from './mrb';

extendZodWithOpenApi(z);

/**
 * 「合格后传递」传递门禁契约（docs/48-合格后传递通用链路规则设计与改造方案.md §4.2）
 *
 * 本文件只定义**形状**，不含规则：规则唯一实现在 `@letian/domain` 的
 * `canTransferToNextStage`（纯函数），执法在应用层用例。
 */

/** 链路锚点类型（同批次 > 同炉批号 > 同工单，命中即停、不混合） */
export const ChainAnchorKindEnum = z
  .enum(['BATCH', 'HEAT', 'WORK_ORDER'])
  .openapi('ChainAnchorKind');

/** 传递判定理由码（与 `TransferGateCode` 同源同名） */
export const TransferGateCodeEnum = z
  .enum([
    'UPSTREAM_PASSED',
    'UPSTREAM_CONCESSION',
    'UPSTREAM_REWORK_PASSED',
    'UPSTREAM_OVERRIDDEN',
    'UPSTREAM_MISSING',
    'UPSTREAM_INSPECTING',
    'UPSTREAM_UNDER_MRB',
    'UPSTREAM_FAILED',
    'UPSTREAM_REINSPECTING',
    'CHAIN_TERMINATED',
    'NO_PREDECESSOR_STAGE',
    'ANCHOR_UNRESOLVED',
  ])
  .openapi('TransferGateCode');

/** 传递门禁豁免工单状态（docs/48 §8 P2 / TBD-09） */
export const TransferOverrideStatusEnum = z
  .enum(['PENDING', 'APPROVED', 'REJECTED', 'CONSUMED'])
  .openapi('TransferOverrideStatus');

export { TransferOverrideInputSchema };

/** 创建豁免申请请求 */
export const CreateTransferOverrideTicketRequestSchema = z
  .object({
    batchNo: z.string().min(1, '批次号不能为空'),
    materialCode: z.string().min(1, '物料编码不能为空'),
    inspectionType: InspectionTypeEnum,
    workOrderNo: z.string().optional(),
    furnaceHeatNo: z.string().optional(),
    upstreamOrderNo: z.string().optional(),
    reason: z.string().min(5, '豁免原因至少5个字符'),
    applicantId: z.string().uuid(),
    applicantName: z.string().optional(),
  })
  .openapi('CreateTransferOverrideTicketRequest');

/** 审批豁免申请请求 */
export const ReviewTransferOverrideTicketRequestSchema = z
  .object({
    action: z.enum(['APPROVE', 'REJECT']).openapi({ description: '审批动作：同意 / 驳回' }),
    reviewerId: z.string().uuid().openapi({ description: '审批人用户 UUID' }),
    reviewerName: z.string().optional(),
    reviewNotes: z.string().optional().openapi({ description: '审批审核意见' }),
    approvalDocNo: z.string().optional().openapi({ description: '书面特批单据编号' }),
  })
  .openapi('ReviewTransferOverrideTicketRequest');

/** 豁免工单明细 */
export const TransferOverrideTicketSchema = z
  .object({
    id: z.string().uuid(),
    ticketNo: z.string(),
    batchNo: z.string(),
    materialCode: z.string(),
    inspectionType: InspectionTypeEnum,
    workOrderNo: z.string().nullable().optional(),
    furnaceHeatNo: z.string().nullable().optional(),
    upstreamOrderNo: z.string().nullable().optional(),
    upstreamGateCode: TransferGateCodeEnum,
    reason: z.string(),
    applicantId: z.string().uuid(),
    applicantName: z.string().nullable().optional(),
    status: TransferOverrideStatusEnum,
    reviewerId: z.string().uuid().nullable().optional(),
    reviewerName: z.string().nullable().optional(),
    reviewNotes: z.string().nullable().optional(),
    approvalDocNo: z.string().nullable().optional(),
    consumedOrderId: z.string().uuid().nullable().optional(),
    consumedOrderNo: z.string().nullable().optional(),
    createdAt: z.string().datetime(),
    reviewedAt: z.string().datetime().nullable().optional(),
    consumedAt: z.string().datetime().nullable().optional(),
  })
  .openapi('TransferOverrideTicket');

export const PaginatedTransferOverrideTicketsSchema = z
  .object({
    items: z.array(TransferOverrideTicketSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .openapi('PaginatedTransferOverrideTickets');

/** 各环节传递 KPI */
export const StageTransferKpiSchema = z
  .object({
    total: z.number().int(),
    passed: z.number().int(),
    blocked: z.number().int(),
    concession: z.number().int(),
    override: z.number().int(),
    missingUpstream: z.number().int(),
  })
  .openapi('StageTransferKpi');

/** 传递链整体 KPI（docs/48 §8 P2） */
export const TransferKpisSchema = z
  .object({
    totalInspections: z.number().int().openapi({ description: '受检总批单数' }),
    passCount: z.number().int().openapi({ description: '正常放行单数（UPSTREAM_PASSED）' }),
    missingUpstreamCount: z.number().int().openapi({ description: '上游缺失放行数（UPSTREAM_MISSING，TBD-01）' }),
    concessionPassCount: z.number().int().openapi({ description: '特采/让步接收放行数（MRB_CONCESSION）' }),
    reworkPassCount: z.number().int().openapi({ description: '返工复检合格放行数（MRB_REWORK_PASSED）' }),
    overridePassCount: z.number().int().openapi({ description: '质量负责人豁免放行数（UPSTREAM_OVERRIDDEN，TBD-09）' }),
    blockedCount: z.number().int().openapi({
      description: '当前处于阻断态的单数（UPSTREAM_FAILED / UPSTREAM_INSPECTING / UPSTREAM_UNDER_MRB / CHAIN_TERMINATED）',
    }),
    terminatedCount: z.number().int().openapi({ description: '整链终止单数（CHAIN_TERMINATED）' }),
    blockRate: z.number().openapi({ description: '阻断率 (%) = blockedCount / totalInspections * 100' }),
    concessionRate: z.number().openapi({ description: '特采放行率 (%) = concessionPassCount / totalInspections * 100' }),
    overrideRate: z.number().openapi({ description: '豁免放行率 (%) = overridePassCount / totalInspections * 100' }),
    missingUpstreamRate: z.number().openapi({ description: '上游缺失率 (%) = missingUpstreamCount / totalInspections * 100' }),
    averageBlockDurationHours: z.number().openapi({
      description: '平均阻断处置时长（小时）：从上游不合格建单到最终放行（特采/复检/豁免）的平均耗时，含 MRB 评审耗时',
    }),
    stageBreakdown: z.record(z.string(), StageTransferKpiSchema).openapi({ description: '各环节传递分布' }),
    generatedAt: z.string().datetime().openapi({ description: '统计生成时间' }),
  })
  .openapi('TransferKpis');

/** 放行凭证：特采必须能举证客户书面授权件，返工必须能举证复检合格 */
export const TransferPermitEvidenceSchema = z
  .object({
    kind: z.enum(['NONE', 'MRB_CONCESSION', 'REWORK_REINSPECTION']).openapi({
      description: '放行凭证类别：无凭据 / MRB 让步接收 / 返工复检合格',
    }),
    mrbNo: z.string().optional().openapi({ description: '让步接收对应的 MRB 评审单号' }),
    orderNo: z.string().optional().openapi({ description: '凭证对应的检验单号（返工复检单）' }),
    attachmentRequired: z.boolean().openapi({
      description: '是否必须有客户书面授权件（特采为 true；缺件即不得放行）',
    }),
  })
  .openapi('TransferPermitEvidence');

/** 传递判定结果：放行 / 阻断 + 理由码 + 上游单号（界面与 MES 直接展示） */
export const TransferDecisionSchema = z
  .object({
    allowed: z.boolean().openapi({ description: '是否允许传递到本环节' }),
    code: TransferGateCodeEnum.openapi({ description: '判定理由码（结构化，供 MES 与看板分支）' }),
    stage: InspectionTypeEnum.openapi({ description: '本单环节（下游）' }),
    chainKey: z.string().openapi({ description: '命中的链路锚点值；未命中时回落本单批次号' }),
    chainKeyKind: ChainAnchorKindEnum.openapi({ description: '命中的链路锚点类型' }),
    precedentStage: InspectionTypeEnum.optional().openapi({ description: '门禁上游环节类型' }),
    predecessorOrderNo: z
      .string()
      .optional()
      .openapi({ description: '权威上游检验单号（复检轮次时指向复检单，不是原单）' }),
    predecessorStatus: InspectionStatusEnum.optional().openapi({ description: '权威上游单当前状态' }),
    mrbNo: z.string().optional().openapi({ description: '相关 MRB 评审单号（不合格分支）' }),
    mrbDisposition: MRBDispositionEnum.optional().openapi({ description: 'MRB 处置结论' }),
    permitEvidence: TransferPermitEvidenceSchema,
    terminateChain: z.boolean().openapi({
      description: '是否终止整条链（退货 / 报废）：下游禁止建单、已建未终判单需冻结',
    }),
    reason: z.string().openapi({ description: '中文可读理由（界面直接展示，不得只给码）' }),
  })
  .openapi('TransferDecision');

/** 传递许可预览请求（列表页 / 看板 / 建单前预览共用） */
export const TransferPermitRequestSchema = z
  .object({
    inspectionType: InspectionTypeEnum,
    batchNo: z.string().min(1, '批次号不能为空'),
    materialCode: z.string().min(1).optional(),
    furnaceHeatNo: z.string().optional().openapi({ description: '炉批号（同炉批号锚点）' }),
    workOrderNo: z.string().optional().openapi({ description: 'MES 生产工单号（同工单锚点）' }),
    orderNo: z.string().optional().openapi({ description: '调用方持有的单号（仅回显，便于前端对号入座）' }),
  })
  .openapi('TransferPermitRequest');

export const TransferPermitItemSchema = TransferPermitRequestSchema.extend({
  decision: TransferDecisionSchema,
}).openapi('TransferPermitItem');

export const TransferPermitBatchRequestSchema = z
  .object({
    items: z.array(TransferPermitRequestSchema).min(1, '至少一项').max(100, '单次最多 100 项'),
  })
  .openapi('TransferPermitBatchRequest');

export const TransferPermitBatchResponseSchema = z
  .object({
    items: z.array(TransferPermitItemSchema),
  })
  .openapi('TransferPermitBatchResponse');

/**
 * 链路环节传递状态（看板「传递链状态」顶栏，`GET /api/v1/traceability/chain-status`，docs/48 §4.6 P1）
 *
 * 口径（docs/48 §4.7「看板数据来源提醒」）：
 *   - 环节行**由检验单派生**（`inspection_orders`），不看 `batch_trace_nodes` —— 后者终判才落节点，
 *     用节点画门禁会把「未终判」的中间态全部画成缺失；
 *   - 每环节的状态与传递判定都是**服务端实时重算**（`evaluateStageVerdict` / `canTransferToNextStage`），
 *     留痕列只作展示与比对，永不作为判据。
 */
export const ChainStageStateEnum = z
  .enum(['RELEASED', 'BLOCKED', 'PENDING', 'MISSING', 'TERMINATED'])
  .openapi('ChainStageState');

export const ChainStatusBlockedBySchema = z
  .object({
    code: TransferGateCodeEnum.openapi({
      description: '阻断理由码（与台账徽标 / 建单 422 同源）：链路**卡在这个环节**的原因码',
    }),
    stage: InspectionTypeEnum.openapi({ description: '产生阻断的环节（链路卡在该环节的权威单上）' }),
    orderNo: z.string().nullable().openapi({ description: '阻断环节的权威单号（无单号时为 null）' }),
    status: InspectionStatusEnum.nullable().openapi({
      description: '阻断环节权威单的当前状态（未知时为 null）',
    }),
  })
  .openapi('ChainStatusBlockedBy');

export const ChainStatusStageSchema = z
  .object({
    stage: InspectionTypeEnum.openapi({ description: '环节类型' }),
    seq: z.number().int().openapi({ description: '工艺序位（IQC=1 → OQC_SH=6；委外八类并列=5）' }),
    state: ChainStageStateEnum.openapi({
      description:
        '环节状态：RELEASED 已放行 / BLOCKED 不合格无放行结论 / PENDING 检验中或 MRB 未结案 / TERMINATED 整链终止。' +
        '`stages` 只列**已建单**环节，故此处不会出现 MISSING（MISSING 只在整条链路零单据时出现在 summary）',
    }),
    orderCount: z.number().int().openapi({ description: '本环节在本批次下的检验单数量（含并列与复检轮次）' }),
    orderNo: z.string().optional().openapi({ description: '权威单号（复检轮次最高 + 最近一次终判，docs/48 §2.4）' }),
    orderStatus: InspectionStatusEnum.optional(),
    overallDecision: OverallDecisionEnum.optional(),
    mrbNo: z.string().optional(),
    mrbDisposition: MRBDispositionEnum.optional(),
    updatedAt: z.string().optional().openapi({ description: '权威单最后更新时间（ISO 8601）' }),
    stateCode: TransferGateCodeEnum.openapi({
      description:
        '本环节**自身**的放行理由码（`evaluateStageVerdict` 产出）：与 `decision.code` 语义不同 —— ' +
        '`decision.code` 回答「本环节当初为什么能开始」，`stateCode` 回答「本环节现在为什么不算已放行」',
    }),
    stateReason: z.string().openapi({
      description:
        '中文可读的环节状态理由（由单张判定 `evaluateStageVerdict` 产出，界面直接展示：为什么本环节不是「已放行」）',
    }),
    decision: TransferDecisionSchema.openapi({
      description:
        '进入本环节的传递判定（与建单门禁 / 台账徽标**同一份判定**）：看板把闸门画在本环节左侧，' +
        '阻断来源即 `precedentStage` / `predecessorOrderNo` / `predecessorStatus` 三元组；' +
        '`allowed=true` 且 `code=UPSTREAM_MISSING` 表示放行但上游缺失（TBD-01）',
    }),
  })
  .openapi('ChainStatusStage');

export const ChainStatusSummarySchema = z
  .object({
    state: ChainStageStateEnum.openapi({
      description:
        '链路总体状态（取最严重者：终止 > 阻断 > 检验中 > 已放行 > 缺失）：TERMINATED / BLOCKED / PENDING / RELEASED，' +
        '整条链路零单据时为 MISSING',
    }),
    releasedCount: z.number().int(),
    blockedCount: z.number().int(),
    pendingCount: z.number().int(),
    terminatedCount: z.number().int(),
    terminated: z.boolean().openapi({ description: '链路是否已被 MRB 退货 / 报废判定终止' }),
    blockedStage: InspectionTypeEnum.optional().openapi({ description: '首个被阻断的环节（按工艺序位，与台账行序一致）' }),
    blockedBy: ChainStatusBlockedBySchema.optional(),
  })
  .openapi('ChainStatusSummary');

export const ChainStatusResponseSchema = z
  .object({
    batchNo: z.string(),
    materialCode: z.string().optional().openapi({ description: '物料限定（调用方传入时回显；未限定则返回整批次全部物料）' }),
    anchor: z
      .object({
        kind: ChainAnchorKindEnum,
        value: z.string(),
      })
      .openapi({ description: '命中的链路锚点（BATCH > HEAT > WORK_ORDER，命中即停）' }),
    stages: z.array(ChainStatusStageSchema).openapi({ description: '按工艺序位升序的已建单环节' }),
    summary: ChainStatusSummarySchema,
    generatedAt: z.string().openapi({ description: '生成时间（ISO 8601）：本响应是实时判定，不做缓存' }),
  })
  .openapi('ChainStatusResponse');

export type TransferOverrideStatus = z.infer<typeof TransferOverrideStatusEnum>;
export type TransferOverrideTicket = z.infer<typeof TransferOverrideTicketSchema>;
export type CreateTransferOverrideTicketRequest = z.infer<typeof CreateTransferOverrideTicketRequestSchema>;
export type ReviewTransferOverrideTicketRequest = z.infer<typeof ReviewTransferOverrideTicketRequestSchema>;
export type PaginatedTransferOverrideTickets = z.infer<typeof PaginatedTransferOverrideTicketsSchema>;
export type StageTransferKpi = z.infer<typeof StageTransferKpiSchema>;
export type TransferKpis = z.infer<typeof TransferKpisSchema>;

export const BatchFreezeTerminatedChainsRequestSchema = z
  .object({
    dryRun: z.boolean().optional().default(false).openapi({ description: '是否预演（默认 false 执行冻结）' }),
    batchNo: z.string().optional().openapi({ description: '限定批次号（可选）' }),
  })
  .openapi('BatchFreezeTerminatedChainsRequest');

/** 被冻结（或预演冻结）的下游在途单据明细 */
export const FrozenTransferOrderSchema = z
  .object({
    orderId: z.string().uuid(),
    orderNo: z.string(),
    batchNo: z.string(),
    inspectionType: z.string(),
    sourceMrbNo: z.string().openapi({ description: '触发链终止的来源 MRB 单号' }),
    disposition: z.string().openapi({ description: 'MRB 处置方式（RETURN_TO_VENDOR / SCRAP）' }),
    status: z.string().openapi({ description: '冻结时单据状态（PENDING / INSPECTING / DRAFT；冻结不改状态）' }),
  })
  .openapi('FrozenTransferOrder');

export const BatchFreezeTerminatedChainsResponseSchema = z
  .object({
    dryRun: z.boolean(),
    scannedMrbCount: z.number().int().openapi({ description: '扫描到的终止类 MRB 评审单数（退货 / 报废）' }),
    terminatedChainsCount: z.number().int().openapi({ description: '涉及的终止链路批次数' }),
    frozenOrdersCount: z.number().int().openapi({ description: '冻结 / 预演冻结的下游在途单数' }),
    frozenOrders: z.array(FrozenTransferOrderSchema).openapi({ description: '受影响单据明细' }),
    executedAt: z.string().openapi({ description: '执行时间（ISO 8601）' }),
  })
  .openapi('BatchFreezeTerminatedChainsResponse');

export type FrozenTransferOrder = z.infer<typeof FrozenTransferOrderSchema>;
export type BatchFreezeTerminatedChainsRequest = z.infer<typeof BatchFreezeTerminatedChainsRequestSchema>;
export type BatchFreezeTerminatedChainsResponse = z.infer<typeof BatchFreezeTerminatedChainsResponseSchema>;
