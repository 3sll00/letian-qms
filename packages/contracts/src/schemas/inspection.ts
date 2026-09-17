import { z } from 'zod';

// ============================================================================
// 1. 检验单与模块枚举 (严格对齐架构 v2.5.0 的 8 态生命周期)
// ============================================================================

export const InspectionTypeEnum = z.enum([
  'IQC',       // 来料检验
  'IPQC_CT',   // 下料检验 (自动断料)
  'IPQC_RL',   // 滚丝检验 (手工滚牙)
  'IPQC_FN',   // 成品检 (检测入库 - 强制检验关卡★)
  'OQC_SF',    // 委外加工检验 (表面处理/热处理/机加工)
  'OQC_SH',    // 出货检验 (客户出货放行)
]);

export const InspectionStatusEnum = z.enum([
  'PENDING',        // 待检验
  'INSPECTING',     // 检验录入中
  'DRAFT',          // 草稿暂存
  'PASSED',         // 指标合格
  'FAILED',         // 指标不合格 (触发 MRB)
  'IN_MRB_REVIEW',  // MRB 会签评审中
  'RE_INSPECTING',  // 返工重新检验轮次
  'COMPLETED',      // 终审结单归档
]);

export const OverallDecisionEnum = z.enum([
  'PASSED',     // 合格
  'FAILED',     // 不合格
  'CONCESSION', // 让步接收 (特采放行)
]);

// ============================================================================
// 2. 检验指标类型与判定枚举
// ============================================================================

export const DataTypeEnum = z.enum([
  'NUMERIC',     // 数值型公差
  'TEXT',        // 文本区间
  'QUALITATIVE', // 定性外观
]);

export const MetricCategoryEnum = z.enum([
  'DIMENSION',            // 尺寸规格
  'APPEARANCE',           // 外观表面
  'HARDNESS',             // 材质硬度
  'COATING_THICKNESS',    // 镀层膜厚
  'TENSILE_STRENGTH',     // 抗拉强度
  'CHEMICAL_COMPOSITION', // 化学成分
  'TEXT_INTERVAL',        // 文本成分区间
]);

export const InspectionItemDecisionEnum = z.enum([
  'PENDING',
  'PASSED',
  'FAILED',
]);

// ============================================================================
// 3. 质检方案版本库与指标模板 Schema
// ============================================================================

export const InspectionPlanItemSchema = z.object({
  id: z.string().uuid().optional(),
  seq: z.number().int().default(1),
  itemCode: z.string().min(1, '指标编码不能为空'),
  name: z.string().min(1, '指标名称不能为空'),
  dataType: DataTypeEnum.default('NUMERIC'),
  metricCategory: MetricCategoryEnum.default('DIMENSION'),
  standardText: z.string().optional(),
  nominalValue: z.number().optional(),
  upperTolerance: z.number().optional(),
  lowerTolerance: z.number().optional(),
  sampleSize: z.number().int().optional(),
  unit: z.string().optional(),
  measurementTool: z.string().optional(),
  isMandatory: z.boolean().default(true),
  remark: z.string().optional(),
});

export const PlanVersionStatusEnum = z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']);

export const InspectionPlanVersionSchema = z.object({
  id: z.string().uuid().optional(),
  planId: z.string().uuid(),
  versionNo: z.string().min(1, '版本号不能为空'),
  status: PlanVersionStatusEnum.default('DRAFT'),
  samplingScheme: z.string().default('GB_T_2828'),
  aqlLevel: z.string().default('II'),
  strictness: z.string().default('NORMAL'),
  items: z.array(InspectionPlanItemSchema).default([]),
  createdBy: z.string().uuid(),
  createdAt: z.string().optional(),
});

export const InspectionPlanSchema = z.object({
  id: z.string().uuid().optional(),
  planCode: z.string().min(1, '方案编码不能为空'),
  planName: z.string().min(1, '方案名称不能为空'),
  inspectionType: InspectionTypeEnum,
  materialCode: z.string().min(1, '关联物料编码不能为空'),
  versions: z.array(InspectionPlanVersionSchema).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

// ============================================================================
// 4. 检验工单实测项与工单本体 Schema (带方案版本深拷贝快照)
// ============================================================================

export const InspectionItemSchema = z.object({
  id: z.string().uuid().optional(),
  seq: z.number().int().default(1),
  itemCode: z.string().min(1, '指标编码不能为空'),
  name: z.string().min(1, '指标名称不能为空'),
  dataType: DataTypeEnum.default('NUMERIC'),
  metricCategory: MetricCategoryEnum.default('DIMENSION'),
  standardText: z.string().optional(),
  nominalValue: z.number().optional(),
  upperTolerance: z.number().optional(),
  lowerTolerance: z.number().optional(),
  sampleSize: z.number().int().optional(),
  measuredVal: z.number().optional(),
  measuredText: z.string().optional(),
  unit: z.string().optional(),
  result: InspectionItemDecisionEnum.default('PENDING'),
  defectReason: z.string().optional(),
  remark: z.string().optional(),
});

export const InspectionPlanSnapshotSchema = z.object({
  planId: z.string().uuid().openapi({ description: '质检方案 UUID' }),
  planCode: z.string().openapi({ description: '方案编码' }),
  planName: z.string().openapi({ description: '方案名称' }),
  versionId: z.string().uuid().openapi({ description: '方案版本 UUID' }),
  versionNo: z.string().openapi({ description: '版本号' }),
  samplingScheme: z.string().openapi({ description: '抽样方案类型' }),
  aqlLevel: z.string().openapi({ description: 'AQL 检查水平' }),
  strictness: z.string().openapi({ description: '严格度' }),
  items: z.array(InspectionPlanItemSchema).openapi({ description: '方案检验项目快照列表' }),
  snapshotAt: z.string().openapi({ description: '快照生成时间戳' }),
}).openapi('InspectionPlanSnapshot');

export const PlanSnapshotSchema = InspectionPlanSnapshotSchema;

export const InspectionOrderSchema = z.object({
  id: z.string().uuid().optional(),
  orderNo: z.string().min(1, '检验单号不能为空'),
  inspectionType: InspectionTypeEnum,
  materialCode: z.string().min(1, '物料编码不能为空'),
  materialName: z.string().min(1, '物料名称不能为空'),
  batchNo: z.string().min(1, '批次号不能为空'),
  supplierCode: z.string().optional(),
  customerCode: z.string().optional(),
  sampleQty: z.number().min(0, '检验抽检数量必须大于等于0'),
  passQty: z.number().min(0).default(0),
  failQty: z.number().min(0).default(0),
  isMandatoryGate: z.boolean().default(false),
  status: InspectionStatusEnum.default('PENDING'),
  overallDecision: OverallDecisionEnum.optional(),
  inspectorId: z.string().uuid().optional(),
  inspectionNotes: z.string().optional(),
  planVersionId: z.string().uuid(),
  planSnapshot: PlanSnapshotSchema,
  items: z.array(InspectionItemSchema).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

// ============================================================================
// 5. 检验请求与响应 DTO Schemas
// ============================================================================

export const CreateInspectionOrderRequestSchema = z.object({
  orderNo: z.string().min(1),
  inspectionType: InspectionTypeEnum,
  materialCode: z.string().min(1),
  materialName: z.string().min(1),
  batchNo: z.string().min(1),
  supplierCode: z.string().optional(),
  customerCode: z.string().optional(),
  sampleQty: z.number().positive(),
  planVersionId: z.string().uuid(),
  isMandatoryGate: z.boolean().optional(),
});

export const RecordInspectionItemRequestSchema = z.object({
  itemCode: z.string().min(1),
  measuredVal: z.number().optional(),
  measuredText: z.string().optional(),
  defectReason: z.string().optional(),
  remark: z.string().optional(),
});

export const BatchRecordInspectionItemsRequestSchema = z.object({
  orderId: z.string().uuid(),
  items: z.array(RecordInspectionItemRequestSchema).min(1, '录入指标项不能为空'),
  isDraft: z.boolean().default(false),
});

export const InspectionProgressOverviewSchema = z.object({
  totalOrders: z.number().int(),
  pendingOrders: z.number().int(),
  inspectingOrders: z.number().int(),
  passedOrders: z.number().int(),
  failedOrders: z.number().int(),
  inMrbOrders: z.number().int(),
  passRate: z.number(),
});

export const MandatoryGateCheckResponseSchema = z.object({
  batchNo: z.string(),
  isPassed: z.boolean(),
  status: InspectionStatusEnum,
  mandatoryGate: z.boolean(),
  allowNextStep: z.boolean(),
  reason: z.string().optional(),
});
