import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

// ============================================================================
// 1. 检验单与模块枚举 (对齐架构 v2.6.0：8态生命周期 + 委外七分类细分)
// ============================================================================

export const InspectionTypeEnum = z.enum([
  'IQC',       // 来料检验
  'IPQC_CT',   // 下料检验 (自动断料)
  'IPQC_RL',   // 滚丝检验 (手工滚牙)
  'IPQC_FN',   // 成品检 (检测入库 - 强制检验关卡★)
  'OQC_SF',    // 委外加工检验 (通用/表面处理)
  'OQC_SH',    // 出货检验 (客户出货放行)
  // 委外七分类专属细分契约
  'OQC_HEAT',  // 委外热处理
  'OQC_BLACK', // 委外发黑
  'OQC_ZINC',  // 委外镀锌
  'OQC_NICKEL',// 委外镀镍
  'OQC_PHOSPH',// 委外磷化
  'OQC_DACRO', // 委外达克罗
  'OQC_MACH',  // 委外机加工
]).openapi('InspectionType');

export const InspectionStatusEnum = z.enum([
  'PENDING',        // 待检验
  'INSPECTING',     // 检验录入中
  'DRAFT',          // 草稿暂存
  'PASSED',         // 指标合格
  'FAILED',         // 指标不合格 (汇入待审核池)
  'IN_MRB_REVIEW',  // MRB 会签评审中
  'RE_INSPECTING',  // 返工重新检验轮次
  'COMPLETED',      // 终审结单归档
]).openapi('InspectionStatus');

export const OverallDecisionEnum = z.enum([
  'PASSED',     // 合格
  'FAILED',     // 不合格
  'CONCESSION', // 让步接收 (特采放行)
]).openapi('OverallDecision');

// ============================================================================
// 2. 检验指标类型与判定枚举
// ============================================================================

export const DataTypeEnum = z.enum([
  'NUMERIC',     // 数值型公差
  'TEXT',        // 文本区间
  'QUALITATIVE', // 定性外观
]).openapi('DataType');

export const MetricCategoryEnum = z.enum([
  'DIMENSION',              // 尺寸规格
  'APPEARANCE',             // 外观表面
  'HARDNESS',               // 材质硬度
  'COATING_THICKNESS',      // 镀层膜厚
  'TENSILE_STRENGTH',       // 抗拉强度
  'MECHANICAL_PERFORMANCE', // 综合机械性能 (抗拉/屈服/伸长率)
  'CHEMICAL_COMPOSITION',   // 化学成分 (多元素百分比矩阵)
  'TEXT_INTERVAL',          // 文本成分区间
]).openapi('MetricCategory');

export const InspectionItemDecisionEnum = z.enum([
  'PENDING',
  'PASSED',
  'FAILED',
  'EXEMPT', // 不解检/免检★ (不计入合格率分母)
]).openapi('InspectionItemDecision');

// ============================================================================
// 3. 质检方案版本库与指标模板 Schema (支持分类继承与批量建方案)
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
}).openapi('InspectionPlanItem');

export const PlanVersionStatusEnum = z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).openapi('PlanVersionStatus');

export const InspectionPlanVersionSchema = z.object({
  id: z.string().uuid().optional(),
  planId: z.string().uuid(),
  versionNo: z.string().min(1, '版本号不能为空'),
  status: PlanVersionStatusEnum.default('DRAFT'),
  samplingScheme: z.string().default('GB_T_2828'),
  aqlLevel: z.string().default('II'),
  strictness: z.string().default('NORMAL'),
  effectiveStartDate: z.string().optional().openapi({ description: '方案生效起止日期 (活动有效周期)' }),
  effectiveEndDate: z.string().optional().openapi({ description: '方案生效截止日期' }),
  items: z.array(InspectionPlanItemSchema).default([]),
  createdBy: z.string().uuid(),
  createdAt: z.string().optional(),
}).openapi('InspectionPlanVersion');

export const InspectionPlanSchema = z.object({
  id: z.string().uuid().optional(),
  planCode: z.string().min(1, '方案编码不能为空'),
  planName: z.string().min(1, '方案名称不能为空'),
  inspectionType: InspectionTypeEnum,
  materialCode: z.string().optional().nullable().openapi({ description: '专属物料编码 (为空时表示全分类通用方案)' }),
  categoryId: z.string().uuid().optional().openapi({ description: '绑定的存货分类 ID (分类继承模式)' }),
  categoryName: z.string().optional().openapi({ description: '存货分类名称' }),
  materialCategory: z.string().optional(),
  isCategoryDefault: z.boolean().default(false).optional().openapi({ description: '是否为该分类的默认方案' }),
  versions: z.array(InspectionPlanVersionSchema).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).openapi('InspectionPlan');

/**
 * 按分类批量创建质检方案请求 Schema
 */
export const BatchCreateCategoryPlanRequestSchema = z.object({
  planName: z.string().min(1).openapi({ description: '方案主标题/主名称', example: '高强度螺栓通用检验标准' }),
  inspectionType: InspectionTypeEnum.openapi({ description: '检验类型' }),
  categoryId: z.string().uuid().openapi({ description: '产品存货分类 UUID' }),
  effectiveStartDate: z.string().optional().openapi({ description: '有效周期起始 YYYY-MM-DD' }),
  effectiveEndDate: z.string().optional().openapi({ description: '有效周期截止 YYYY-MM-DD' }),
  samplingScheme: z.string().default('GB_T_2828'),
  aqlLevel: z.string().default('II'),
  items: z.array(InspectionPlanItemSchema).min(1).openapi({ description: '统一检验项目与要求明细' }),
}).openapi('BatchCreateCategoryPlanRequest');

// ============================================================================
// 4. 检验工单实测项与工单本体 Schema (带炉批号联动与不解检标记)
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
  isExempt: z.boolean().default(false).openapi({ description: '是否标记为不解检(免检)' }),
  exemptReason: z.string().optional().openapi({ description: '不解检原因说明' }),
  defectReason: z.string().optional(),
  remark: z.string().optional(),
  // 炉批号继承溯源留痕
  inheritedFrom: z.enum(['OUTSOURCE_HEAT_TREATMENT', 'IQC_RAW_MATERIAL', 'MANUAL_ENTRY']).optional(),
  originalInheritedValue: z.union([z.number(), z.string()]).optional().openapi({ description: '带出的原始历史值快照' }),
  isManuallyModified: z.boolean().default(false).openapi({ description: '带出数据是否经过质检员手工修改' }),
  modifiedReason: z.string().optional().openapi({ description: '手工编辑修改原因' }),
}).openapi('InspectionItem');

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
  orderNo: z.string().min(1, '检验单号不能为空').openapi({
    description: '检验单号，规则 {类型前缀}-{YYYYMMDD}-{4位流水号}',
    example: 'OQC-SH-20260706-0001',
  }),
  inspectionType: InspectionTypeEnum,
  materialCode: z.string().min(1, '物料编码不能为空'),
  materialName: z.string().min(1, '物料名称不能为空'),
  batchNo: z.string().min(1, '批次号不能为空'),
  furnaceHeatNo: z.string().optional().openapi({ description: '炉批号 (支持智能关联溯源)' }),
  // 006 ERP 采购入库与规格对账字段扩展
  receiptNo: z.string().optional().openapi({ description: '采购入库单号 (来自 ERP Dlyndx)', example: 'RK-20260706-001' }),
  receiptDate: z.string().optional().openapi({ description: '采购入库日期', example: '2026-07-06' }),
  specification: z.string().optional().openapi({ description: '规格型号 (来自 ERP Ptype.Standard)', example: 'Φ20mm' }),
  spec: z.string().optional().openapi({ description: '规格型号别名 (兼容易读)', example: 'Φ20mm' }),
  totalQty: z.number().min(0).optional().openapi({ description: '来料批次总数量', example: 500 }),
  unit: z.string().optional().openapi({ description: '计量单位', example: '件' }),
  supplierName: z.string().optional().openapi({ description: '供应商企业全称', example: '宝钢' }),
  inspectorName: z.string().optional().openapi({ description: '检验人姓名', example: '张检验' }),
  // 007 过程检验 (IPQC: 下料检验/滚丝检验/成品检) 字段
  workOrderNo: z.string().optional().openapi({ description: 'MES生产工单号', example: 'WO-20260706-01' }),
  blankingLength: z.number().optional().openapi({ description: '断料长度/下料长度 (mm)', example: 150.0 }),
  operatorName: z.string().optional().openapi({ description: '操作员姓名', example: '陈操作' }),
  operatorId: z.string().optional().openapi({ description: '操作员工号', example: 'OP-0102' }),
  equipmentCode: z.string().optional().openapi({ description: '设备编号', example: 'EQ-CT-01' }),
  equipmentName: z.string().optional().openapi({ description: '设备名称', example: '1#全自动高速冷镦机' }),
  threadSpec: z.string().optional().openapi({ description: '牙纹规格/螺纹规格', example: 'M12*1.25 6g' }),
  inspectionTeam: z.string().optional().openapi({ description: '终检组/检验班组', example: '终检一组' }),
  processStep: z.string().optional().openapi({ description: '工序阶段/工序名称', example: '自动断料' }),
  // 008 出货检验 (OQC) 销售出库关联字段
  salesOrderNo: z.string().optional().openapi({ description: '销售出库单号', example: 'SO-20260706-01' }),
  dispatchDate: z.string().optional().openapi({ description: '出库日期', example: '2026-07-06' }),
  customerName: z.string().optional().openapi({ description: '客户名称', example: '客户A科技' }),
  salesOrderPoNo: z.string().optional().openapi({ description: '客户采购订单号', example: 'PO-A-001' }),
  erpStatus: z.string().optional().openapi({ description: 'ERP出库单审核状态', example: '待审核' }),
  // 009 委外检验 (OQC 七分类) 台账字段
  outsourceNo: z.string().optional().openapi({ description: 'ERP 委外加工单号', example: 'WW-20260706-001' }),
  processType: z.string().optional().openapi({ description: '加工类型/工艺分类', example: '镀锌' }),
  returnDate: z.string().optional().openapi({ description: '委外件回厂登记日期 (YYYY-MM-DD)', example: '2026-07-06' }),
  vendorName: z.string().optional().openapi({ description: '加工商/外协厂商名称快照', example: '苏州机加工厂' }),
  completedAt: z.string().optional().openapi({ description: '检验完成时间' }),
  supplierCode: z.string().optional(),
  customerCode: z.string().optional(),
  sampleQty: z.number().min(0, '检验抽检数量必须大于等于0'),
  passQty: z.number().min(0).default(0),
  failQty: z.number().min(0).default(0),
  exemptQty: z.number().min(0).default(0).optional().openapi({ description: '不解检数量' }),
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
}).openapi('InspectionOrder');

// ============================================================================
// 5. 检验请求与响应 DTO Schemas
// ============================================================================

export const CreateInspectionOrderRequestSchema = z.object({
  // 检验单号可省略：省略时由服务端按编号规则 `{PREFIX}-{YYYYMMDD}-{NNNN}` 申请当日流水号，
  // 显式传入时以其为准（兼容 ERP/MES 下发的外部单号）。规则见 @letian/domain 的 inspection-order-number。
  orderNo: z.string().min(1).optional().openapi({
    description: '检验单号；省略时由服务端按 {类型前缀}-{YYYYMMDD}-{4位流水号} 规则生成',
    example: 'OQC-SH-20260706-0001',
  }),
  inspectionType: InspectionTypeEnum,
  materialCode: z.string().min(1),
  materialName: z.string().min(1),
  batchNo: z.string().min(1),
  furnaceHeatNo: z.string().optional().openapi({ description: '炉批号' }),
  supplierCode: z.string().optional(),
  customerCode: z.string().optional(),
  sampleQty: z.number().positive(),
  totalQty: z.number().min(0).optional().openapi({ description: '总数量' }),
  receiptNo: z.string().optional().openapi({ description: '采购入库单号' }),
  receiptDate: z.string().optional().openapi({ description: '采购入库日期' }),
  specification: z.string().optional().openapi({ description: '规格型号' }),
  spec: z.string().optional().openapi({ description: '规格型号别名' }),
  unit: z.string().optional().openapi({ description: '计量单位' }),
  supplierName: z.string().optional().openapi({ description: '供应商全称' }),
  inspectorName: z.string().optional().openapi({ description: '检验人姓名' }),
  workOrderNo: z.string().optional().openapi({ description: 'MES生产工单号' }),
  blankingLength: z.number().optional().openapi({ description: '断料长度 (mm)' }),
  operatorName: z.string().optional().openapi({ description: '操作员姓名' }),
  operatorId: z.string().optional().openapi({ description: '操作员工号' }),
  equipmentCode: z.string().optional().openapi({ description: '设备编号' }),
  equipmentName: z.string().optional().openapi({ description: '设备名称' }),
  threadSpec: z.string().optional().openapi({ description: '螺纹规格' }),
  inspectionTeam: z.string().optional().openapi({ description: '终检组' }),
  processStep: z.string().optional().openapi({ description: '工序阶段' }),
  salesOrderNo: z.string().optional().openapi({ description: '销售出库单号' }),
  dispatchDate: z.string().optional().openapi({ description: '出库日期' }),
  customerName: z.string().optional().openapi({ description: '客户名称' }),
  salesOrderPoNo: z.string().optional().openapi({ description: '客户采购订单号' }),
  erpStatus: z.string().optional().openapi({ description: 'ERP状态' }),
  outsourceNo: z.string().optional().openapi({ description: 'ERP 委外加工单号' }),
  processType: z.string().optional().openapi({ description: '加工类型/工艺分类' }),
  returnDate: z.string().optional().openapi({ description: '委外件回厂登记日期 (YYYY-MM-DD)' }),
  vendorName: z.string().optional().openapi({ description: '加工商/外协厂商名称' }),
  completedAt: z.string().optional().openapi({ description: '检验完成时间' }),
  planVersionId: z.string().uuid(),
  isMandatoryGate: z.boolean().optional(),
}).openapi('CreateInspectionOrderRequest');

export const RecordInspectionItemRequestSchema = z.object({
  itemCode: z.string().min(1),
  measuredVal: z.number().optional(),
  measuredText: z.string().optional(),
  isExempt: z.boolean().optional().openapi({ description: '是否标记为不解检' }),
  exemptReason: z.string().optional(),
  defectReason: z.string().optional(),
  remark: z.string().optional(),
  // 炉批号继承修改
  inheritedFrom: z.enum(['OUTSOURCE_HEAT_TREATMENT', 'IQC_RAW_MATERIAL', 'MANUAL_ENTRY']).optional(),
  originalInheritedValue: z.union([z.number(), z.string()]).optional(),
  inheritedHeatValue: z.union([z.number(), z.string()]).optional(),
  inheritedValue: z.union([z.number(), z.string()]).optional(),
  isManuallyModified: z.boolean().optional(),
  modifiedReason: z.string().optional(),
  modificationReason: z.string().optional(),
}).openapi('RecordInspectionItemRequest');

export const BatchRecordInspectionItemsRequestSchema = z.object({
  orderId: z.string().uuid(),
  items: z.array(RecordInspectionItemRequestSchema).min(1, '录入指标项不能为空'),
  isDraft: z.boolean().default(false),
}).openapi('BatchRecordInspectionItemsRequest');

export const InspectionProgressOverviewSchema = z.object({
  totalOrders: z.number().int(),
  pendingOrders: z.number().int(),
  inspectingOrders: z.number().int(),
  passedOrders: z.number().int(),
  failedOrders: z.number().int(),
  inMrbOrders: z.number().int(),
  passRate: z.number(),
}).openapi('InspectionProgressOverview');

export const MandatoryGateCheckResponseSchema = z.object({
  batchNo: z.string(),
  isPassed: z.boolean(),
  status: InspectionStatusEnum,
  mandatoryGate: z.boolean(),
  allowNextStep: z.boolean(),
  reason: z.string().optional(),
}).openapi('MandatoryGateCheckResponse');

/**
 * 炉批号历史追溯带出结果 Schema
 */
export const FurnaceHeatTraceResultSchema = z.object({
  furnaceHeatNo: z.string().openapi({ description: '查询的炉批号' }),
  matchSource: z.enum(['OUTSOURCE_HEAT_TREATMENT', 'IQC_RAW_MATERIAL', 'NONE']).openapi({ description: '匹配来源' }),
  sourceOrderNo: z.string().optional().openapi({ description: '来源检验单号' }),
  mechanicalData: z.array(z.object({
    itemCode: z.string(),
    name: z.string(),
    measuredVal: z.number().optional(),
    unit: z.string().optional(),
    standardRequirement: z.string().optional(),
  })).default([]).openapi({ description: '带出的机械性能数据项' }),
  chemicalData: z.array(z.object({
    element: z.string(),
    elementName: z.string(),
    measuredVal: z.number(),
  })).default([]).openapi({ description: '带出的化学成分数据项' }),
}).openapi('FurnaceHeatTraceResult');
