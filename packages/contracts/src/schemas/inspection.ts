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
  acceptableValues: z.array(z.string().min(1)).optional().openapi({
    description:
      '定性/文本型指标的「可接受值清单」(TBD-06)。非空时判定只认清单成员，不再依赖 standardText 里的 , ， / | 分隔符约定',
  }),
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

/**
 * 方案级状态（由该方案全部版本行的 version_status 派生，全系统唯一口径）：
 * ENABLED = 存在 ACTIVE 版本；PENDING_APPROVAL = 无 ACTIVE 但有 DRAFT 版本；DISABLED = 其余（仅剩 INACTIVE）。
 * 与「质检方案设计」页 状态列的 已启用 / 待审批 / 已停用 三色徽标一一对应。
 */
export const PlanStatusEnum = z.enum(['ENABLED', 'PENDING_APPROVAL', 'DISABLED']).openapi('PlanStatus');

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
  createdByName: z.string().optional().openapi({ description: '版本创建人姓名 (employees.name，按 createdBy 读时派生)' }),
  createdAt: z.string().optional(),
}).openapi('InspectionPlanVersion');

export const InspectionPlanSchema = z.object({
  id: z.string().uuid().optional(),
  planCode: z.string().min(1, '方案编码不能为空'),
  planName: z.string().min(1, '方案名称不能为空'),
  inspectionType: InspectionTypeEnum,
  materialCode: z.string().optional().nullable().openapi({ description: '专属物料编码 (为空时表示全分类通用方案)' }),
  categoryCode: z.string().optional().nullable().openapi({
    description: '方案归属的存货分类编码；materialCode 为空时表示“该分类的通用方案”，作为分类级兜底匹配依据',
  }),
  categoryId: z.string().uuid().optional().openapi({ description: '绑定的存货分类 ID (分类继承模式)' }),
  categoryName: z.string().optional().openapi({
    description: '存货分类名称 (按 categoryCode 联表 inventory_categories 读时派生)',
  }),
  materialCategory: z.string().optional(),
  isCategoryDefault: z.boolean().default(false).optional().openapi({
    description: '是否为该分类的默认方案 (materialCode 为空且 categoryCode 非空 = 分类通用方案，口径见 014 迁移)',
  }),
  status: PlanStatusEnum.optional().openapi({
    description: '方案级状态 (由 versions[].status 派生：有 ACTIVE=已启用，仅 DRAFT=待审批，否则已停用)',
  }),
  materialName: z.string().optional().openapi({
    description: '适用产品名称 (按 materialCode 联表 materials 读时派生；分类通用方案为空)',
  }),
  versions: z.array(InspectionPlanVersionSchema).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).openapi('InspectionPlan');

/**
 * 新建方案请求体（POST /api/v1/plans 专用口径）。
 *
 * 与 InspectionPlanSchema（读模型）的唯一差别：版本行主键 `id`、归属方案 `planId`、
 * 创建人 `createdBy` 由服务端派生 —— `planId`/`id` 落库时才生成，`createdBy` 一律取 JWT 操作人
 * （见 apps/api/src/controllers/plans.controller.ts）。若把这几个字段留在创建请求体里必填，
 * 页面新建方案会被 400 挡在门外（界面无法伪造尚不存在的版本行 UUID）。
 *
 * 首个版本一律以 DRAFT 落库（PlanVersionStatusEnum），请求体携带的 status 被服务端忽略，
 * 待质量主管在方案设计页执行「审批」后启用。
 *
 * `planCode` 同样可以省略：留空时由服务端按 `QP-{YYYYMMDD}-{NNN}` 取号
 * （口径见 @letian/domain 的 inspection-plan-number，取号池见迁移 017）。
 */
export const CreateInspectionPlanRequestSchema = InspectionPlanSchema.omit({
  planCode: true,
  versions: true,
})
  .extend({
    /**
     * 方案编码。**留空时由服务端按 `QP-{YYYYMMDD}-{NNN}` 取号**（当日流水，3 位左补零）。
     * 显式指定时按原值使用：库中既有的语义化编码（如 `QP-IQC-304SS`）仍然合法。
     */
    planCode: z
      .string()
      .min(1, '方案编码不能为空')
      .optional()
      .openapi({ description: '方案编码；留空时由服务端按 QP-{YYYYMMDD}-{NNN} 取号' }),
    versions: z
      .array(InspectionPlanVersionSchema.omit({ id: true, planId: true, createdBy: true }))
      .optional(),
  })
  .openapi('CreateInspectionPlanRequest');

/** 方案版本启停动作：ACTIVATE = 审批启用该版本，DEACTIVATE = 停用该版本 */
export const PlanVersionStatusActionEnum = z
  .enum(['ACTIVATE', 'DEACTIVATE'])
  .openapi('PlanVersionStatusAction');

/**
 * 方案版本启停（审批）请求体（POST /api/v1/plans/versions/{versionId}/status）。
 *
 * 只传动作，目标版本由 URL 的版本行 UUID 指定 —— 不做任何「按方案编码回退」，
 * 避免审批动作落到非预期版本上。服务端状态机（@letian/domain InspectionPlan）保证：
 *   1. ACTIVATE 后该版本为 ACTIVE，同方案其它 ACTIVE 版本自动转 INACTIVE（单激活态）；
 *   2. 激活要求版本至少含 1 个指标项（空版本一律拒绝，避免建单时拿不到待检清单）；
 *   3. DEACTIVATE 只接受当前为 ACTIVE 的版本，其余状态一律 400。
 * 角色门禁：仅质量主管 / 系统管理员可执行（403）。
 */
export const TogglePlanVersionStatusRequestSchema = z
  .object({
    action: PlanVersionStatusActionEnum,
  })
  .openapi('TogglePlanVersionStatusRequest');

/**
 * 方案版本升版请求体（POST /api/v1/plans/versions/{versionId}/upgrade）。
 *
 * 语义：以 URL 上的**版本行**为模板，为该方案再产出一个 `DRAFT` 草稿版本。
 * **全部字段均可省略** —— 空对象 `{}` 即「完全沿用被升版版本」：
 *   1. `versionNo` 省略：由服务端按领域规则 `nextInspectionPlanVersionNo` 升位（如 v2.5 → v2.6，
 *      口径与 `plan_code` 服务端取号完全对称，见 docs/17 §7.5.7 / §7.5.8）；
 *   2. `items` / `samplingScheme` / `aqlLevel` / `strictness` 省略：沿用 URL 版本行的值；
 *   3. `effectiveStartDate` / `effectiveEndDate` **不继承**：生效周期是日期绑定的，
 *      照抄会让旧周期已过期时新草稿「出生即过期」，故省略即长期有效，需要限定时必须显式传入。
 * 领域守门（一律 400）：同一方案**已有 `DRAFT` 时禁止再造草稿**（`PLAN_DRAFT_ALREADY_EXISTS`）、
 * 指标项为空（`PLAN_EMPTY_ITEMS`）。显式传入 `items` 时必须至少 1 项。
 * 门禁：只做 PBAC 物料权限（与 `POST /plans` 同级）；改变生效状态的启停动作才需要质量主管角色。
 */
export const UpgradePlanVersionRequestSchema = z
  .object({
    versionNo: z.string().min(1, '版本号不能为空').optional().openapi({
      description: '新版本号；省略时由服务端在现有最大版本号上自动升位（如 v2.5 → v2.6）',
    }),
    items: z
      .array(InspectionPlanItemSchema)
      .min(1, '至少需要 1 个指标项')
      .optional()
      .openapi({ description: '新版本的指标项；省略时沿用被升版版本的指标项' }),
    samplingScheme: z.string().optional().openapi({ description: '抽样方案；省略时沿用被升版版本' }),
    aqlLevel: z.string().optional().openapi({ description: 'AQL 水平；省略时沿用被升版版本' }),
    strictness: z.string().optional().openapi({ description: '检验严格度；省略时沿用被升版版本' }),
    effectiveStartDate: z.string().optional().openapi({
      description: '生效起始日（**不继承**，省略即长期有效）',
    }),
    effectiveEndDate: z.string().optional().openapi({
      description: '生效截止日（**不继承**，省略即长期有效）',
    }),
  })
  .openapi('UpgradePlanVersionRequest');

/**
 * 「质检方案设计」页 KPI 卡片口径（方案总数 / 已启用 / 待审批 / 覆盖产品数）。
 *
 * 由服务端按全量方案聚合，只施加 PBAC 物料权限过滤，不受列表筛选条件与分页影响，
 * 杜绝「用当页数据推算全局 KPI」导致方案数超过一页时数字失真。
 */
export const PlanStatsSchema = z
  .object({
    total: z.number().int().min(0).openapi({ description: '质检方案总数 (去重 plan_code)' }),
    enabled: z.number().int().min(0).openapi({ description: '已启用方案数 (存在 ACTIVE 版本)' }),
    pending: z.number().int().min(0).openapi({ description: '待审批方案数 (无 ACTIVE 版本但存在 DRAFT 版本)' }),
    productCount: z.number().int().min(0).openapi({
      description: '覆盖产品数 (去重 material_code，分类通用方案不计入)',
    }),
  })
  .openapi('PlanStats');

/**
 * 质检方案自动匹配查询 (检验录入页"根据物料自动匹配质检方案"入口)
 *
 * 匹配规则唯一真相 (见 docs/17-检验录入界面说明与质检方案匹配口径.md §7.3)：
 * material_code 精确匹配 + inspection_stage 精确匹配 + version_status = ACTIVE，多命中取最新创建的一行。
 */
export const MatchInspectionPlanQuerySchema = z.object({
  materialCode: z.string().min(1, '物料编码不能为空'),
  inspectionType: InspectionTypeEnum,
}).openapi('MatchInspectionPlanQuery');

/** 命中来源：物料专属方案 / 存货分类通用方案（兜底） */
export const PlanMatchSourceEnum = z.enum(['MATERIAL', 'MATERIAL_CATEGORY']).openapi('PlanMatchSource');

/**
 * 质检方案匹配结果：直接给出"需要检验的指标清单"，
 * 前端可零成本渲染待检项，并把 planVersionId 原样回传给建单接口完成快照绑定。
 */
export const MatchedInspectionPlanSchema = z.object({
  planCode: z.string().openapi({ description: '方案编码' }),
  planName: z.string().openapi({ description: '方案名称' }),
  matchSource: PlanMatchSourceEnum.openapi({
    description: '命中来源：MATERIAL = 物料专属方案；MATERIAL_CATEGORY = 存货分类通用方案（兜底命中）',
  }),
  planVersionId: z.string().uuid().openapi({ description: '命中的方案版本行 UUID (建单时原样回传)' }),
  versionNo: z.string().openapi({ description: '版本号' }),
  inspectionType: InspectionTypeEnum,
  materialCode: z.string().openapi({ description: '命中的物料编码' }),
  samplingScheme: z.string().openapi({ description: '抽样方案类型 (GB_T_2828 等)' }),
  aqlLevel: z.string().openapi({ description: 'AQL 检查水平' }),
  strictness: z.string().openapi({ description: '检验严格度' }),
  items: z.array(InspectionPlanItemSchema).openapi({ description: '待检指标清单' }),
  matchedAt: z.string().openapi({ description: '匹配时间戳' }),
}).openapi('MatchedInspectionPlan');

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
  acceptableValues: z.array(z.string().min(1)).optional().openapi({
    description: '建单时随方案快照固化的可接受值清单 (TBD-06)，回看与落库判定都以本单快照上的值为准',
  }),
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
  materialName: z.string().min(1, '物料名称不能为空').openapi({
    description: '物料名称/品名快照 (来自 ERP Ptype.FullName -> materials.material_name)',
    example: '不锈钢线材 Φ5.0mm',
  }),
  batchNo: z.string().min(1, '批次号不能为空'),
  furnaceHeatNo: z.string().optional().openapi({ description: '炉批号 (支持智能关联溯源)' }),
  // 006 来料检验 (IQC) 入库单号 / 入库日期 / 规格型号对账字段扩展
  // 「采购入库单号」与「入库单号」是同一业务对象，统一收敛为入库单号（迁移 021 已重命名物理列）
  inboundNo: z.string().optional().openapi({ description: '入库单号 (来自 ERP 采购入库单 Dlyndx.Number)', example: 'RK-20260706-001' }),
  inboundDate: z.string().optional().openapi({ description: '入库日期 (ERP 采购入库制单日期)', example: '2026-07-06' }),
  specification: z.string().optional().openapi({
    description: '规格型号快照 (来自 ERP Ptype.Standard -> materials.spec_model，物理列 inspection_orders.specification)',
    example: 'Φ5.0mm / 盘圆 / 304HC',
  }),
  spec: z.string().optional().openapi({
    description: '规格型号只读别名：读侧由 specification 派生，不落库（写侧请用 specification）',
    example: 'Φ5.0mm / 盘圆 / 304HC',
  }),
  totalQty: z.number().min(0).optional().openapi({
    description:
      '报检批量总数（物理列 total_qty）。来料检验 = 到货批数量；过程检验 = 该工序投产/送检批量，即台账「数量」列。缺失时台账显示 --，不用 sampleQty 推导（见 docs/29 §2）',
    example: 500,
  }),
  unit: z.string().optional().openapi({
    description: '计量单位快照 (来自 ERP Unit1 -> materials.unit，物理列 inspection_orders.unit)',
    example: 'KG',
  }),
  supplierName: z.string().optional().openapi({ description: '供应商企业全称', example: '宝钢' }),
  inspectorName: z.string().optional().openapi({ description: '检验人姓名', example: '张检验' }),
  // 007 过程检验 (IPQC: 下料检验/滚丝检验/成品检) 字段
  workOrderNo: z.string().optional().openapi({ description: 'MES生产工单号', example: 'WO-20260706-01' }),
  blankingLength: z.number().optional().openapi({ description: '断料长度/下料长度 (mm)', example: 150.0 }),
  // 注意：这里的 operatorName / operatorId 是**机台作业员**（工序执行人，台账「操作员」列），
  // 与「当前登录操作人」（审计/Outbox 用的 operatorId/operatorName）同名但语义不同，见 docs/29 §5.3
  operatorName: z.string().optional().openapi({
    description: '机台作业员姓名（工序执行人，台账「操作员」列；**不是**当前登录操作人）',
    example: '陈操作',
  }),
  operatorId: z.string().optional().openapi({ description: '机台作业员工号（工序执行人）', example: 'OP-0102' }),
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
  outsourceNo: z.string().optional().openapi({ description: 'ERP 委外加工单号', example: 'WWJG-20260706-001' }),
  processType: z.string().optional().openapi({ description: '加工类型/工艺分类', example: '镀锌' }),
  returnDate: z.string().optional().openapi({ description: '委外件回厂登记日期 (YYYY-MM-DD)', example: '2026-07-06' }),
  vendorName: z.string().optional().openapi({ description: '加工商/外协厂商名称快照', example: '苏州机加工厂' }),
  // 029 质量负责人签核（docs/35 §5）：由 POST /inspections/{id}/approve 写入**真实签核动作**；
  // 未签核即缺省 —— 证书留白，绝不打印任何人名
  approverId: z.string().uuid().optional().openapi({ description: '质量负责人（员工主数据 id），未签核时缺省' }),
  approverName: z.string().optional().openapi({
    description: '质量负责人签核人姓名（真实签核动作的产物）',
    example: '李质量',
  }),
  approvedAt: z.string().optional().openapi({ description: '签核时间 (ISO 8601)', example: '2026-09-22T08:00:00.000Z' }),
  completedAt: z.string().optional().openapi({
    description:
      '台账「完成时间」列：该工序报工/报检登记时间（MES 同步链路以 t_check_report.check_date 写入）；终判完成时由状态流转刷新',
  }),
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
  materialCode: z.string().min(1).openapi({
    description: '物料编码 (来自 ERP Ptype.UserCode)；服务端按它回查存货档案，为台账补齐物料名称 / 规格型号 / 计量单位',
  }),
  materialName: z.string().min(1).optional().openapi({
    description:
      '物料名称/品名 (来自 ERP Ptype.FullName -> materials.material_name)；省略时由服务端按 materialCode 从存货档案补齐，显式传入时以传入值为准',
  }),
  batchNo: z.string().min(1),
  furnaceHeatNo: z.string().optional().openapi({ description: '炉批号' }),
  supplierCode: z.string().optional(),
  customerCode: z.string().optional(),
  sampleQty: z.number().positive(),
  totalQty: z.number().min(0).optional().openapi({
    description: '报检批量总数（落库 inspection_orders.total_qty，过程检验台账「数量」列）；省略则该列保持 NULL',
  }),
  inboundNo: z.string().optional().openapi({ description: '入库单号（ERP 采购入库单号）' }),
  inboundDate: z.string().optional().openapi({ description: '入库日期' }),
  specification: z.string().optional().openapi({
    description:
      '规格型号 (来自 ERP Ptype.Standard -> materials.spec_model)；与 spec 等价但优先级更高，服务端统一收敛到该字段落库；省略时按 materialCode 从存货档案补齐',
  }),
  spec: z.string().optional().openapi({
    description: '规格型号的兼容别名：仅在省略 specification 时生效，服务端归一后写入 specification 列',
  }),
  unit: z.string().optional().openapi({
    description:
      '计量单位 (来自 ERP Unit1 -> materials.unit)；省略时按 materialCode 从存货档案补齐',
  }),
  supplierName: z.string().optional().openapi({ description: '供应商全称' }),
  inspectorId: z.string().uuid().optional().openapi({
    description: '检验人（员工主数据 id，落库 inspection_orders.inspector_id）：与 inspectorName 可任选其一或同时传入',
  }),
  inspectorName: z.string().optional().openapi({
    description:
      '检验人姓名（落库 inspection_orders.inspector_name，即过程检验台账「检验人」列）；缺省时由读侧按 inspector_id 从员工主数据补齐，绝不推导假值',
  }),
  workOrderNo: z.string().optional().openapi({ description: 'MES生产工单号' }),
  blankingLength: z.number().optional().openapi({ description: '断料长度 (mm)' }),
  // 同样是「机台作业员」而不是当前登录操作人：控制器会把它收进 ipqcProcess 分组下发，
  // 避免与审计用的操作人字段互相覆盖（见 docs/29 §5.3）
  operatorName: z.string().optional().openapi({ description: '机台作业员姓名（**不是**当前登录操作人）' }),
  operatorId: z.string().optional().openapi({ description: '机台作业员工号' }),
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
  completedAt: z.string().optional().openapi({
    description:
      '台账「完成时间」列：该工序报工/报检登记时间（MES 同步链路以 t_check_report.check_date 写入）；终判完成时由状态流转刷新',
  }),
  // 显式传入的版本行必须真实存在（不存在返回 404，禁止静默降级）；省略时由服务端按「物料编码 + 检验类型」自动匹配，
  // 匹配不到返回 400 inspection-plan-not-found。口径见 docs/17-检验录入界面说明与质检方案匹配口径.md §7。
  planVersionId: z.string().uuid().optional().openapi({
    description: '指定的质检方案版本行 UUID；省略时服务端按「物料编码 + 检验类型」自动匹配已启用方案',
    example: '11111111-1111-1111-1111-111111111111',
  }),
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
/**
 * 质量负责人签核请求（docs/35 §5）。
 *
 * 签核人是**当前登录用户**（服务端从会话取，不由请求体传入）：签核是一个真实发生过的动作，
 * 不能由客户端声称「是谁签的」。`remark` 作为签核意见写入检验单备注。
 */
export const ApproveInspectionOrderRequestSchema = z.object({
  remark: z.string().optional().openapi({ description: '签核意见（写入审计日志，不覆盖检验单备注）', example: '资料齐全，同意放行' }),
}).openapi('ApproveInspectionOrderRequest');

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
