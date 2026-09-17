import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

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
 * 评审流程节点定义 Schema
 */
export const ReviewFlowNodeSchema = z.object({
  nodeLevel: z.number().int().openapi({ description: '审批层级序号', example: 1 }),
  nodeName: z.string().openapi({ description: '审批节点名称', example: '技术部工程评审' }),
  roleCode: z.string().openapi({ description: '审批责任角色编码', example: 'TECH_DEPT' }),
  requireCustomerSign: z.boolean().default(false).openapi({ description: '是否强制要求客户或客户代表书面签核' }),
}).openapi('ReviewFlowNode');

/**
 * 评审流程定义 Schema (可配置工作流引擎)
 */
export const ReviewFlowSchema = z.object({
  id: z.string().uuid().optional().openapi({ description: '流程定义唯一标识' }),
  flowCode: z.string().openapi({ description: '流程编码', example: 'FLOW-IQC-FAIL' }),
  flowName: z.string().openapi({ description: '流程名称', example: '来料检验不合格多方会签流程' }),
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
  batchNo: z.string().openapi({ description: '关联物料/生产批次号', example: 'LOT-2026-0701' }),
  materialCode: z.string().openapi({ description: '物料编码', example: 'CL-001' }),
  materialName: z.string().openapi({ description: '物料名称', example: '冷镦钢 10B21' }),
  defectDescription: z.string().openapi({ description: '不合格项具体现象与缺陷描述', example: '碳含量0.52%，超出规格上限0.45%' }),
  defectQty: z.number().int().openapi({ description: '不合格涉及数量', example: 500 }),
  status: MRBStatusEnum.default('PENDING_REVIEW').openapi({ description: '当前评审流转状态' }),
  disposition: MRBDispositionEnum.optional().openapi({ description: '最终裁决处置方案' }),
  dispositionNotes: z.string().optional().openapi({ description: '处置执行方案说明' }),
  approvers: z.array(MRBApproverActionSchema).default([]).openapi({ description: '多方联合会签历史与签名记录' }),
  concessionAttachmentUrl: z.string().optional().openapi({ description: '让步接收（特采）必须上传的客户书面同意书附件路径' }),
  createdAt: z.string().datetime().openapi({ description: '单据发起时间' }),
  updatedAt: z.string().datetime().openapi({ description: '最新状态变更时间' }),
}).openapi('MRBRecord');

/**
 * 提交 MRB 决策请求 Schema
 */
export const DisposeMRBRequestSchema = z.object({
  disposition: MRBDispositionEnum.openapi({ description: '处置决策方式' }),
  dispositionNotes: z.string().min(2).openapi({ description: '处置决议理由与防范措施', example: '经工程评审，硬度尚可满足降级使用' }),
  approvers: z.array(MRBApproverActionSchema).min(1).openapi({ description: '本次参与签署的审批人凭证' }),
  concessionAttachmentUrl: z.string().optional().openapi({ description: '特采让步接收必须附带的书面授权件' }),
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
