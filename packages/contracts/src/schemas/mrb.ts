import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

/**
 * 不合格品待审核池状态枚举
 */
export const PendingDefectStatusEnum = z.enum([
  'PENDING_INITIATE', // 待发起评审 (各检验环节不合格品自动汇入)
  'INITIATED',        // 已发起评审 (已生成 MRB 评审单)
  'DISMISSED',        // 已误判撤销/免审归档
]).openapi('PendingDefectStatus');

/**
 * 不合格待审核池单据条目 Schema (统一待审核池★)
 */
export const PendingDefectItemSchema = z.object({
  id: z.string().uuid().openapi({ description: '不合格记录 UUID' }),
  inspectionOrderId: z.string().uuid().openapi({ description: '来源检验工单 UUID' }),
  orderNo: z.string().openapi({ description: '来源检验单号', example: 'IQC20260918-001' }),
  inspectionType: z.string().openapi({ description: '检验类型 (IQC/IPQC/OQC_SF/OQC_SH等)' }),
  batchNo: z.string().openapi({ description: '生产/来料批次号', example: 'LOT-2026-0918-01' }),
  materialCode: z.string().openapi({ description: '物料编码', example: 'MAT-10B21-06' }),
  materialName: z.string().openapi({ description: '物料名称', example: '冷镦钢 10B21' }),
  supplierName: z.string().optional().openapi({ description: '供应商名称' }),
  customerName: z.string().optional().openapi({ description: '客户名称' }),
  defectQty: z.number().int().openapi({ description: '不良数量', example: 50 }),
  totalQty: z
    .number()
    .int()
    .openapi({
      description: '受检数量（不良率分母口径 = 检验单抽样数量，非报检总数）',
      example: 32,
    }),
  defectRate: z
    .number()
    .optional()
    .openapi({ description: '不良率(%) = defectQty / totalQty × 100，服务端按库内 defect_rate 回吐' }),
  defectDescription: z.string().openapi({ description: '不合格现象/超差实测描述' }),
  defectItemCode: z.string().optional().openapi({ description: '具体不合格的指标项编码' }),
  status: PendingDefectStatusEnum.default('PENDING_INITIATE').openapi({ description: '待审核池状态' }),
  mrbId: z.string().uuid().optional().openapi({ description: '关联的 MRB 评审单 ID (发起后回填)' }),
  inspectorId: z.string().uuid().optional().openapi({ description: '质检员 UUID' }),
  inspectorName: z.string().optional().openapi({ description: '质检员姓名' }),
  createdAt: z.string().datetime().openapi({ description: '汇入待审核池时间' }),
}).openapi('PendingDefectItem');

/**
 * 质检主管逐条发起评审请求 Schema
 */
export const InitiateReviewRequestSchema = z.object({
  pendingDefectId: z.string().uuid().openapi({ description: '待审核池条目 UUID' }),
  flowId: z.string().uuid().optional().openapi({ description: '选用的评审流程定义 ID' }),
  urgencyLevel: z.enum(['NORMAL', 'URGENT', 'CRITICAL']).default('NORMAL').openapi({ description: '紧急程度' }),
  reviewNotes: z.string().optional().openapi({ description: '发起说明/建议处置方向' }),
}).openapi('InitiateReviewRequest');

/**
 * 不合格品评审状态枚举 (4 态严格闭环)
 */
export const MRBStatusEnum = z.enum([
  'PENDING_REVIEW', // 待评审
  'UNDER_REVIEW',   // 评审中 (会签中)
  'DISPOSED',       // 已完成处置
  'REJECTED',       // 被驳回/撤回
]).openapi('MRBStatus');

/**
 * MRB 分类页签枚举（前端四大分类 Tab + 全部）
 */
export const MRBCategoryTabEnum = z.enum([
  'ALL',             // 全部
  'IQC_DEFECT',      // 来料不合格
  'IPQC_DEFECT',     // 过程不合格
  'OQC_DEFECT',      // 成品出货不合格
  'CUSTOMER_RETURN', // 客户退货
]).openapi('MRBCategoryTab');

/**
 * MRB 处置方式标准策略枚举 (4 类标准处置方式)
 */
export const MRBDispositionEnum = z.enum([
  'RETURN_TO_VENDOR', // 退货
  'REWORK',           // 返工 / 返修
  'CONCESSION',       // 让步接收 (特采)
  'SCRAP',            // 报废
]).openapi('MRBDisposition');

/**
 * 不合格来源分类枚举 (4 类不合格来源，用于驱动评审流程路由引擎)
 */
export const MRBFailCategoryEnum = z.enum([
  'INCOMING_FAIL',    // 来料不合格
  'PROCESS_FAIL',     // 过程不合格
  'SHIPMENT_FAIL',    // 出货不合格
  'SUBCONTRACT_FAIL', // 委外不合格
]).openapi('MRBFailCategory');

/**
 * MRB 发起紧急程度枚举（015 落库 mrb_reviews.urgency_level）
 */
export const MRBUrgencyLevelEnum = z.enum([
  'NORMAL',   // 常规
  'URGENT',   // 紧急
  'CRITICAL', // 特急
]).openapi('MRBUrgencyLevel');

/**
 * 评审流程节点定义 Schema
 */
export const ReviewFlowNodeSchema = z.object({
  nodeLevel: z.number().int().openapi({ description: '审批层级序号', example: 1 }),
  nodeName: z.string().openapi({ description: '审批节点名称', example: '技术部工程评审' }),
  roleCode: z.string().openapi({ description: '审批责任角色编码', example: 'TECH_DEPT' }),
  roleName: z
    .string()
    .optional()
    .openapi({ description: '授权签署角色显示名；未配置时读侧回退 roleCode（docs/21 §10.3）' }),
  isRequired: z
    .boolean()
    .default(true)
    .openapi({ description: '是否必签：必签节点未签署不得推进到下一层级（PRD §3.6 会签链）' }),
  allowConcession: z
    .boolean()
    .default(false)
    .openapi({
      description: '是否具有让步接收（特采）裁决权；PRD §3.6 规定特采需技术部门与客户代表联合双签，故默认仅终审节点为真',
    }),
  requireCustomerSign: z.boolean().default(false).openapi({ description: '是否强制要求客户或客户代表书面签核' }),
}).openapi('ReviewFlowNode');

/**
 * 评审流程定义 Schema (可配置工作流引擎)
 */
export const ReviewFlowSchema = z.object({
  id: z.string().uuid().optional().openapi({ description: '流程定义唯一标识' }),
  flowCode: z.string().openapi({ description: '流程编码', example: 'FLOW-IQC-FAIL' }),
  flowName: z.string().openapi({ description: '流程名称', example: '来料检验不合格多方会签流程' }),
  description: z
    .string()
    .optional()
    .openapi({ description: '流程说明（落 review_flows.description，供流程设置页卡片与详情展示）' }),
  applicableType: MRBFailCategoryEnum.openapi({ description: '适用的不合格类型维度' }),
  version: z.string().default('v1.0.0').openapi({ description: '流程定义版本号', example: 'v1.0.0' }),
  isActive: z.boolean().default(true).openapi({ description: '是否启用' }),
  nodes: z.array(ReviewFlowNodeSchema).openapi({ description: '流程审批节点列表' }),
}).openapi('ReviewFlow');

/**
 * MRB 审批人签核明细 Schema
 */
export const MRBApproverActionSchema = z.object({
  userId: z.string().uuid().openapi({ description: '审批人 UUID', example: 'u1a8e100-0000-0000-0000-000000000001' }),
  userName: z.string().openapi({ description: '审批人姓名', example: '李技术' }),
  roleCode: z.string().openapi({ description: '审批角色编码', example: 'TECH_LEAD' }),
  action: z.enum(['APPROVED', 'REJECTED']).openapi({ description: '审批动作' }),
  comment: z.string().openapi({ description: '签署意见', example: '同意让步接收，尺寸偏差不影响总装' }),
  signatureUrl: z.string().optional().openapi({ description: '电子签名凭证图片路径' }),
  signedAt: z.string().datetime().openapi({ description: '签署时间' }),
}).openapi('MRBApproverAction');

/**
 * MRB 评审记录 Schema
 */
export const MRBReviewSchema = z.object({
  id: z.string().uuid().openapi({ description: 'MRB 单据唯一标识', example: 'm1a8e100-0000-0000-0000-000000000001' }),
  mrbNo: z.string().openapi({ description: '评审单号', example: 'MRB20260706-001' }),
  sourceType: MRBFailCategoryEnum.openapi({ description: '不合格来源分类' }),
  sourceOrderNo: z.string().openapi({ description: '关联的原始检验单号', example: 'IQC20260706-001' }),
  pendingDefectId: z.string().uuid().optional().openapi({ description: '关联的不合格待审核池记录 UUID' }),
  reviewFlowId: z
    .string()
    .uuid()
    .optional()
    .openapi({ description: '发起时选用的评审流程定义 ID（落 mrb_reviews.review_flow_id）' }),
  urgencyLevel: MRBUrgencyLevelEnum.default('NORMAL').openapi({
    description: '紧急程度（落 mrb_reviews.urgency_level，默认 NORMAL）',
  }),
  reviewNotes: z
    .string()
    .optional()
    .openapi({ description: '发起说明/建议处置方向（落 mrb_reviews.review_notes，与不合格描述分离）' }),
  batchNo: z.string().openapi({ description: '关联物料/生产批次号', example: 'LOT-2026-0701' }),
  materialCode: z.string().openapi({ description: '物料编码', example: 'MAT-10B21-06' }),
  materialName: z.string().openapi({ description: '物料名称', example: '冷镦钢 10B21' }),
  defectDescription: z.string().openapi({ description: '不合格项具体现象与缺陷描述', example: '碳含量0.52%，超出规格上限0.45%' }),
  defectQty: z.number().int().openapi({ description: '不合格涉及数量', example: 500 }),
  inspectorName: z
    .string()
    .optional()
    .openapi({
      description:
        '源检验单检验人姓名（读侧按 sourceOrderNo 关联 inspection_orders 派生，非 mrb_reviews 物理列）',
      example: '张检验',
    }),
  status: MRBStatusEnum.default('PENDING_REVIEW').openapi({ description: '当前评审流转状态' }),
  disposition: MRBDispositionEnum.optional().openapi({ description: '最终裁决处置方案' }),
  dispositionNotes: z.string().optional().openapi({ description: '处置执行方案说明' }),
  disposedAt: z.string().datetime().optional().openapi({ description: '处置闭环时间（DISPOSED 时写入）' }),
  disposedBy: z.string().optional().openapi({ description: '最终裁决人姓名/账号' }),
  approvers: z.array(MRBApproverActionSchema).default([]).openapi({ description: '多方联合会签历史与签名记录' }),
  concessionAttachmentUrl: z.string().optional().openapi({ description: '让步接收（特采）必须上传的客户书面同意书附件路径' }),
  createdAt: z.string().datetime().openapi({ description: '单据发起时间' }),
  updatedAt: z.string().datetime().openapi({ description: '最新状态变更时间' }),
}).openapi('MRBRecord');

/**
 * MRB 最终处置结论响应 Schema（POST /mrb/records/{id}/disposition）
 *
 * 响应体 = MRB 单据本体（MRBRecord）+ 处置连带产物：返工（REWORK）处置会在同一事务内
 * 生成下一轮复检单，这里把复检单标识一并回吐，使 MRB 页面无需按批次号反查即可展示
 * 「已生成复检单 {单号}」。这两个字段不是 mrb_reviews 的物理列，故不并入 MRBReviewSchema
 * （列表 / 详情接口不做无谓回填）。
 */
export const DisposeMRBResponseSchema = MRBReviewSchema.extend({
  reinspectionOrderId: z.string().uuid().optional().openapi({
    description: '返工处置连带生成的复检单 UUID（仅 disposition=REWORK 时返回）',
    example: 'c1a8e100-0000-4000-8000-000000000001',
  }),
  reinspectionOrderNo: z.string().optional().openapi({
    description: '复检单号，规则 {原检验单号}-R{轮次}（仅 disposition=REWORK 时返回）',
    example: 'IQC-20260706-0001-R2',
  }),
}).openapi('DisposeMRBResponse');

/**
 * 提交 MRB 决策请求 Schema
 */
export const DisposeMRBRequestSchema = z.object({
  disposition: MRBDispositionEnum.openapi({ description: '处置决策方式' }),
  dispositionReason: z
    .string()
    .min(2)
    .optional()
    .openapi({
      description: '处置决议理由与防范措施（与 dispositionNotes 二选一，值落 disposition_notes）',
      example: '经工程评审，硬度尚可满足降级使用',
    }),
  dispositionNotes: z
    .string()
    .min(2)
    .optional()
    .openapi({ description: '别名：语义等同 dispositionReason（兼容早期消费方）' }),
  approvers: z
    .array(MRBApproverActionSchema)
    .default([])
    .openapi({ description: '可选：本次共同签署人凭证；省略时沿用会签历史，最终裁决人记入 disposedBy' }),
  concessionAttachmentUrl: z
    .string()
    .optional()
    .openapi({ description: '特采让步接收必须附带的客户书面授权件；缺失时服务端返回 400' }),
}).openapi('DisposeMRBRequest');

/**
 * MRB 列表分页与 KPI 统计响应 Schema
 */
export const PaginatedMRBRecordsSchema = z.object({
  total: z.number().int().openapi({ description: '总条数', example: 12 }),
  pendingCount: z.number().int().openapi({ description: 'KPI: 待评审数', example: 2 }),
  underReviewCount: z.number().int().openapi({ description: 'KPI: 评审中数', example: 1 }),
  totalReviewedCount: z.number().int().openapi({ description: 'KPI: 累计已评审数', example: 9 }),
  disposedCount: z.number().int().openapi({ description: 'KPI: 已处置完成数', example: 8 }),
  monthlyReviewRate: z.number().openapi({ description: 'KPI: 本月评审完成率(%)', example: 88.9 }),
  items: z.array(MRBReviewSchema).openapi({ description: 'MRB 评审单据明细列表' }),
}).openapi('PaginatedMRBRecords');

export const ReviewNodeStatusEnum = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXEMPT',
]).openapi('ReviewNodeStatus');

export const ConcessionSignOffSchema = z.object({
  role: z.string().openapi({ description: '签署角色' }),
  reviewerId: z.string().uuid().openapi({ description: '签署人UUID' }),
  reviewerName: z.string().openapi({ description: '签署人姓名' }),
  reviewComment: z.string().openapi({ description: '签署意见' }),
  reviewedAt: z.string().openapi({ description: '签署时间戳' }),
  attachmentUrl: z.string().optional().openapi({ description: '客户书面签核凭证' }),
}).openapi('ConcessionSignOff');

export const ReviewStepConfigSchema = z.object({
  stepNo: z.number().int(),
  stepName: z.string(),
  approverRole: z.string(),
  isMandatory: z.boolean().default(true),
}).openapi('ReviewStepConfig');

export const MRBReviewNodeSchema = z.object({
  stepNo: z.number().int(),
  stepName: z.string(),
  approverRole: z.string(),
  status: ReviewNodeStatusEnum.default('PENDING'),
  reviewerId: z.string().uuid().optional(),
  reviewerName: z.string().optional(),
  comment: z.string().optional(),
  reviewedAt: z.string().datetime().optional(),
}).openapi('MRBReviewNode');

export const CreateMRBReviewRequestSchema = z.object({
  sourceType: MRBFailCategoryEnum,
  sourceOrderNo: z.string().min(1),
  pendingDefectId: z.string().uuid().optional(),
  batchNo: z.string().min(1),
  materialCode: z.string().min(1),
  materialName: z.string().min(1),
  defectDescription: z.string().min(1),
  defectQty: z.number().int().positive(),
}).openapi('CreateMRBReviewRequest');

export const SubmitNodeReviewRequestSchema = z.object({
  action: z.enum(['APPROVED', 'REJECTED']),
  comment: z.string().min(1),
  signatureUrl: z.string().optional(),
}).openapi('SubmitNodeReviewRequest');

export const MRBDispositionDecisionRequestSchema = DisposeMRBRequestSchema;
export const MRBMetricsOverviewSchema = PaginatedMRBRecordsSchema;
