import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { MRBDispositionEnum } from './mrb';

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

/**
 * 证书打印模板枚举（docs/51）：操作员在「填写检验内容前」为本单选定的打印版式。
 *   QUALITY       = 《质量保证书 CERTIFICATE OF INSPECTION》（纵向 A4：三列字段网格 + 尺寸/机械/化学三段）
 *   MANUFACTURING = 《MANUFACTURING CERTIFICATE》（横向 A4：14 列产品检验表 + EN 10204 声明页脚）
 * 缺省（未选择）时界面按模块缺省渲染：IQC / IPQC / OQC -> QUALITY，委外 -> MANUFACTURING。
 */
export const CertTemplateEnum = z.enum(['QUALITY', 'MANUFACTURING']).openapi('CertTemplate');

/** 证书专用补充字段袋：键为字段名、值为文本；只服务于证书打印，不进任何业务判定 */
export const CertFieldsSchema = z.record(z.string(), z.string()).openapi('CertFields');

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
  // —— ERP 检验方案明细口径（T_Inf_PtypeCheckingSchemeDly）——
  // 字段映射：TITypeId -> testItemCode、StandardValue -> standardText、Dif -> dif、
  //          CheckWay -> checkWay、CheckDevice -> measurementTool（既有）、Summary -> remark（既有）
  /** 检验项目字典回链：ERP `TestItem.TypeID`（如 '00001'），对应 TestItemSchema.testItemCode */
  testItemCode: z.string().optional().openapi({ description: 'ERP 检验项目字典编码（TITypeId）' }),
  /** 公差/偏差文本（ERP `Dif` nvarchar(50)，如 '±0.1'）；数值判定仍走 upper/lowerTolerance，本字段承载 ERP 原文 */
  dif: z.string().optional().openapi({ description: '公差/偏差（ERP Dif 原文）' }),
  /** 检验方式（ERP `CheckWay`，如 '抽检'/'全检'/'目视'） */
  checkWay: z.string().optional().openapi({ description: '检验方式（ERP CheckWay）' }),
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
  inspectionType: InspectionTypeEnum.openapi({
    description: '主检验类型（多选时取第一个；匹配/展示的主口径，向后兼容单列 inspection_stage）',
  }),
  inspectionTypes: z.array(InspectionTypeEnum).min(1).optional().openapi({
    description:
      '方案适用的检验类型全集（含主类型；ERP GxTypeId 口径的扩展——一个方案可服务多个工序/检验环节）。缺省 = [inspectionType]',
  }),
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
  inspectionTypes: z.array(InspectionTypeEnum).optional().openapi({
    description: '命中方案适用的检验类型全集（含本次匹配用类型）',
  }),
  materialCode: z.string().openapi({ description: '命中的物料编码' }),
  samplingScheme: z.string().openapi({ description: '抽样方案类型 (GB_T_2828 等)' }),
  aqlLevel: z.string().openapi({ description: 'AQL 检查水平' }),
  strictness: z.string().openapi({ description: '检验严格度' }),
  items: z.array(InspectionPlanItemSchema).openapi({ description: '待检指标清单' }),
  matchedAt: z.string().openapi({ description: '匹配时间戳' }),
}).openapi('MatchedInspectionPlan');

/**
 * Excel 方案导入结果（POST /api/v1/plans/import 响应体）。
 *
 * 导入按「方案组」聚合：同一份 Excel 中 方案名称 + 物料编码 + 产品分类编码 相同的行
 * 合并为一个方案，每行 = 一个检验指标项。逐组独立落库——某组校验失败不影响其它组，
 * 三组明细（新建 / 跳过-判重 / 失败）都在本响应里如实回显。
 */
export const ImportPlanCreatedSchema = z.object({
  planCode: z.string().openapi({ description: '服务端实际落库的方案编码（QP-{YYYYMMDD}-{NNN} 取号）' }),
  planName: z.string(),
  versionNo: z.string().openapi({ description: '首个草稿版本号（默认 V1.0，导入一律 DRAFT）' }),
  itemCount: z.number().int().min(1).openapi({ description: '导入的检验指标项数' }),
  rows: z.array(z.number().int().min(1)).openapi({
    description: '该方案占用的 Excel 数据行号清单（工作表真实行号，表头为第 1 行）',
  }),
}).openapi('ImportPlanCreated');

export const ImportPlanSkippedSchema = z.object({
  planName: z.string(),
  rows: z.array(z.number().int().min(1)),
  existingPlanCode: z.string().openapi({
    description: '方案库中已存在的同名同物料同主类型方案编码（重复导入保护）',
  }),
}).openapi('ImportPlanSkipped');

export const ImportPlanFailedSchema = z.object({
  planName: z.string().openapi({ description: '失败归属方案名；行级错误时为该行填写的方案名' }),
  rows: z.array(z.number().int().min(1)).openapi({ description: '关联的 Excel 数据行号' }),
  reason: z.string().openapi({ description: '失败原因（行级校验/组内一致性/落库异常逐条列出）' }),
}).openapi('ImportPlanFailed');

export const ImportPlansResultSchema = z.object({
  fileName: z.string().openapi({ description: '上传文件名回显' }),
  totalRows: z.number().int().min(0).openapi({ description: '解析到的有效数据行数（不含表头与空行）' }),
  planCount: z.number().int().min(0).openapi({
    description: '聚合出的方案组数（= created.length + skipped.length + failed.length）',
  }),
  created: z.array(ImportPlanCreatedSchema),
  skipped: z.array(ImportPlanSkippedSchema),
  failed: z.array(ImportPlanFailedSchema),
}).openapi('ImportPlansResult');

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

/**
 * 炉批号数据关联（docs/47）—— 溯源来源枚举。
 *
 * 与领域层 `HeatBatchTraceService` 的 `HEAT_TRACE_SOURCE_TYPES` 同源同值：
 *   OUTSOURCE_HEAT_TREATMENT = L1 委外检验·热处理（OQC_HEAT）
 *   IQC_RAW_MATERIAL         = L2 来料检验（IQC）
 *   NONE                     = L3 两处均无记录（界面静默空态，不显示关联数据）
 */
export const HeatTraceAppliedSourceTypeEnum = z.enum([
  'OUTSOURCE_HEAT_TREATMENT',
  'IQC_RAW_MATERIAL',
]);
export const HeatTraceSourceTypeEnum = z.enum([
  'OUTSOURCE_HEAT_TREATMENT',
  'IQC_RAW_MATERIAL',
  'NONE',
]);

/**
 * 炉批号上游异常提示的理由码（docs/47 §3.9 / TBD-01，P1）。
 * 只提示、不带值、不阻断；跨环节阻断是 docs/48 的职责，两者不合并。
 */
export const HeatTraceWarningCodeEnum = z.enum([
  'UPSTREAM_FAILED',
  'UPSTREAM_UNDER_MRB',
  'UPSTREAM_INSPECTING',
]);

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
  furnaceHeatNo: z.string().optional().openapi({
    description:
      '炉批号 (Heat No)：钢材冶炼炉号 / 热处理炉批号，落 inspection_orders.furnace_heat_batch_no（迁移 004 建列、034 起有写入路径与归一索引）。' +
      '出货检验录入该字段即按 docs/47 的三级优先级关联上游检验记录（委外热处理 OQC_HEAT -> 来料检验 IQC -> 无记录）',
    example: 'HT02-20231008-A',
  }),
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
  // 030 委外检验录入页业务事实字段（docs/36 迁移 030）：三列均为录入事实，缺省即缺省，绝不推导
  materialGrade: z.string().optional().openapi({
    description: '材质牌号/强度等级（落库 inspection_orders.material_grade）',
    example: '10.9级',
  }),
  techStandard: z.string().optional().openapi({
    description: '执行技术标准与工艺规范（落库 inspection_orders.tech_standard）；制造证书「执行规范」行读该列',
    example: 'GB/T 3098.1-2010',
  }),
  inspectedDate: z.string().optional().openapi({
    description: '检验日期 YYYY-MM-DD（落库 inspection_orders.inspected_date）；为空时读侧才回落 completedAt/createdAt',
    example: '2026-09-23',
  }),
  // 034 炉批号溯源留痕（docs/47 §3.6 R5）：本单炉批号数据「带出自哪张上游检验单」。
  // 由 PATCH /inspections/{id}/header 在服务端重新解析后写入，不接受客户端自称来源。
  heatSourceType: HeatTraceAppliedSourceTypeEnum.optional().openapi({
    description: '炉批号数据带出源类型（委外热处理 / 来料检验）；未发生带出时缺省',
  }),
  heatSourceOrderNo: z.string().optional().openapi({
    description: '炉批号数据带出的源检验单号；未发生带出时缺省',
    example: 'OQC-HT-20260705-0003',
  }),
  // 029 质量负责人签核（docs/35 §5）：由 POST /inspections/{id}/approve 写入**真实签核动作**；
  // 未签核即缺省 —— 证书留白，绝不打印任何人名
  approverId: z.string().uuid().optional().openapi({ description: '质量负责人（员工主数据 id），未签核时缺省' }),
  approverName: z.string().optional().openapi({
    description: '质量负责人签核人姓名（真实签核动作的产物）',
    example: '李质量',
  }),
  approvedAt: z.string().optional().openapi({ description: '签核时间 (ISO 8601)', example: '2026-09-22T08:00:00.000Z' }),
  // 「合格后传递」读取派生字段（docs/48 §4.2）：台账 / 看板 / MES 用同一份判定结果，
  // 全部由服务端实时按领域纯函数推导（P1 起可与留痕列比对），**不是**物理列、不接受写入。
  canTransfer: z.boolean().optional().openapi({
    description:
      '本单**所在环节**的传递许可：上游已放行（合格 / MRB 让步接收 / 返工复检合格）或上游缺失时按 TBD-01 放行。只读派生，不落库',
  }),
  blockedBy: z
    .object({
      code: z.string().openapi({ description: '阻断理由码（TransferGateCode）', example: 'UPSTREAM_FAILED' }),
      stage: z.string().openapi({ description: '阻断来源环节', example: 'IQC' }),
      orderNo: z.string().nullish().openapi({ description: '权威上游单号', example: 'IQC-20260923-0001' }),
      status: z.string().nullish().openapi({ description: '权威上游单当前状态', example: 'FAILED' }),
    })
    .optional()
    .openapi({ description: '被阻断时的结构化上游信息（blockedBy.code 供 MES / 看板分支）' }),
  predecessorOrderNo: z.string().optional().openapi({
    description: '权威上游检验单号（返工轮次时指向复检单，不是原单）',
    example: 'IQC-20260923-0001',
  }),
  chainKey: z.string().optional().openapi({
    description: '命中的链路锚点值（BATCH / HEAT / WORK_ORDER 中优先级最高者）',
    example: 'BATCH-TEST2609-001',
  }),
  transferCode: z.string().optional().openapi({
    description:
      '传递判定理由码（TransferGateCode）。与 canTransfer 成对下发：`canTransfer=true` 且 `transferCode=UPSTREAM_MISSING` 就是「放行但上游环节缺失」的显式标记（TBD-01），界面据此显示缺失徽标而不是默认当作正常',
    example: 'UPSTREAM_MISSING',
  }),
  // 035 建单传递留痕（docs/48 §4.1）：**建单那一次**判定的持久化存档。与上面
  // canTransfer / transferCode / chainKey 的「当前实时判定」是**两个语义** —— 上游状态会变
  // （MRB 结案 / 复检终判 / 下游被冻结都会改写它），所以历史存档单独挂在本键下，
  // 绝不与实时字段同名（同名会让「当初凭什么放行」与「现在还能不能传」在界面上无法区分）。
  // 只读物理列；MRB 返工复检单等未走建单门禁的单据缺省，界面显示 —（不补一个猜出来的结论）。
  transferTrace: z
    .object({
      chainKey: z.string().optional().openapi({ description: '建单时命中的链路锚点值（未命中时回落本单批次号）' }),
      chainKeyKind: z
        .string()
        .optional()
        .openapi({ description: '建单时命中的锚点类型：BATCH / HEAT / WORK_ORDER' }),
      upstreamOrderNo: z
        .string()
        .optional()
        .openapi({ description: '建单时认定的权威上游检验单号（复检轮次指向复检单；无上游单时缺省）' }),
      upstreamGateCode: z
        .string()
        .optional()
        .openapi({ description: '建单时的判定理由码（TransferGateCode）' }),
    })
    .optional()
    .openapi({
      description:
        '建单传递留痕（迁移 035 物理列 chain_key / chain_key_kind / upstream_order_no / upstream_gate_code，只读）：回答「这批货当初凭什么放行」',
    }),
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
  // 038 证书模板与证书专用字段（docs/51）：由操作员在「填写检验内容前」选定并随单保存；
  // 只读展示字段，客户端可经 PATCH /inspections/{id}/header 或建单 POST 写入。
  certTemplate: CertTemplateEnum.optional().openapi({
    description: '本单选用的证书打印模板；缺省 = 未选择（界面按模块缺省渲染）',
  }),
  certFields: CertFieldsSchema.optional().openapi({
    description:
      '证书专用补充字段袋（制造证书 doRef/jobcardNo/deliveryPoint/coating/colour/customerPoNo，质保书 marking/samplePlan/samplingDate 等）；只服务于证书打印',
  }),
  planVersionId: z.string().uuid(),
  planSnapshot: PlanSnapshotSchema,
  items: z.array(InspectionItemSchema).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).openapi('InspectionOrder');

// ============================================================================
// 5. 检验请求与响应 DTO Schemas
// ============================================================================

/** 质量负责人传递门禁特批豁免直接输入（docs/48 §8 P2 / TBD-09） */
export const TransferOverrideInputSchema = z
  .object({
    reason: z
      .string()
      .min(5, '豁免原因至少5个字符')
      .openapi({ description: '豁免原因（必填，至少5字，记入审计）', example: '客户紧急试制，质量总监李工特批放行' }),
    approverId: z.string().uuid().openapi({ description: '审批人 UUID（须具备 QA_MANAGER 或 ADMIN 权限）' }),
    approverName: z.string().optional().openapi({ description: '审批人姓名快照' }),
    approvalDocNo: z.string().optional().openapi({ description: '书面特批单据编号', example: 'QA-OVR-20260924-001' }),
    ticketId: z.string().uuid().optional().openapi({ description: '关联的已审批豁免工单 ID（若走完审批流）' }),
    ticketNo: z.string().optional().openapi({ description: '关联的已审批豁免工单编号（如 TOT-20260924-0001）' }),
  })
  .openapi('TransferOverrideInput');

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
  furnaceHeatNo: z.string().optional().openapi({
    description:
      '炉批号 (Heat No)（落 inspection_orders.furnace_heat_batch_no）：建单即落库，供出货检验按 docs/47 的优先级链关联上游检验记录',
    example: 'HT02-20231008-A',
  }),
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
  // 030 委外检验录入页业务事实字段（docs/36）：空串按「未提供」归一，不落 NULL 覆盖既有值
  materialGrade: z.string().optional().openapi({ description: '材质牌号/强度等级（落库 inspection_orders.material_grade）' }),
  techStandard: z.string().optional().openapi({ description: '执行技术标准与工艺规范（落库 inspection_orders.tech_standard）' }),
  inspectedDate: z.string().optional().openapi({ description: '检验日期 YYYY-MM-DD（落库 inspection_orders.inspected_date）' }),
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
  certTemplate: CertTemplateEnum.optional().openapi({
    description: '本单选用的证书打印模板（docs/51：操作员填写前选定，随单保存）',
  }),
  certFields: CertFieldsSchema.optional().openapi({
    description: '证书专用补充字段袋（只服务于证书打印，不进判定）',
  }),
  transferOverride: TransferOverrideInputSchema.optional().openapi({
    description: '质量负责人传递门禁特批豁免凭据（TBD-09，允许绕过上游阻断）',
  }),
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

/**
 * 实测值批量录入 / 判定请求（`POST /inspections/:id/submit-measurements`）。
 *
 * `passQty` / `failQty` 是**检验员在录入弹窗里填写的合格数量 / 不合格数量**（docs/17 §7、docs/21 §14）：
 * 判定为不合格时它们随判定一并落 `inspection_orders.pass_qty / fail_qty`，并成为
 * 「判定即自动创建的 MRB 单」的「不合格数量」—— 与服务端终判口径**同源**。缺省时服务端按
 * 抽样数量派生兜底（`failQty = sampleQty - passQty - exemptQty`），首次判定时该兜底值恒等于
 * 抽样数（检测数），故**凡是能拿到填写值的调用方都必须下发**，否则 MRB 单会显示成检测数。
 */
export const BatchRecordInspectionItemsRequestSchema = z.object({
  orderId: z.string().uuid(),
  items: z.array(RecordInspectionItemRequestSchema).min(1, '录入指标项不能为空'),
  isDraft: z.boolean().default(false),
  passQty: z
    .number()
    .min(0)
    .optional()
    .openapi({ description: '检验员填写的合格数量（落 inspection_orders.pass_qty，优先于服务端派生值）' }),
  failQty: z.number().min(0).optional().openapi({
    description: '检验员填写的不合格数量（落 inspection_orders.fail_qty，并作为自动创建 MRB 单的「不合格数量」）',
    example: 60,
  }),
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

/**
 * 检验单终判请求（docs/39 §3）。
 *
 * 口径：`status` 必填并受 `InspectionStatusEnum` 约束（非法值 400，不再直接落库）；
 * 判定「不合格」（`status = FAILED` 或 `judgment = FAILED`）时，服务端在**同一事务**内
 * 把该单汇入不合格待审核池（`pending_mrb_items`），由质检主管在【MRB不合格品处置】逐条发起评审。
 * `remark` 与 `inspectionNotes` 语义相同（终判结论备注），同时给出时以 `inspectionNotes` 为准。
 */
export const FinalizeInspectionStatusRequestSchema = z
  .object({
    status: InspectionStatusEnum.openapi({
      description: '终判目标状态：判定不合格用 FAILED（合格 PASSED，委外返工 RE_INSPECTING，归档 COMPLETED）',
      example: 'FAILED',
    }),
    judgment: OverallDecisionEnum.optional().openapi({
      description:
        '综合判定结论：PASSED / FAILED / CONCESSION（让步接收）。与 `status` 是两个字段、取值域不同 —— 原先误用 InspectionStatusEnum，导致合法的 CONCESSION 被接口拒绝、而非法的 PENDING 等状态值反被放行到用例层',
    }),
    passQty: z.number().min(0).optional().openapi({ description: '合格数量（落 inspection_orders.pass_qty）' }),
    failQty: z
      .number()
      .min(0)
      .optional()
      .openapi({ description: '不合格数量（落 inspection_orders.fail_qty，同时作为入池的不合格数）' }),
    sampleQty: z.number().min(0).optional().openapi({ description: '抽样 / 受检数量（保留字段，终判当前不改抽样数）' }),
    remark: z.string().optional().openapi({ description: '终判备注（语义同 inspectionNotes，同时给出时以 inspectionNotes 为准）' }),
    inspectionNotes: z.string().optional().openapi({ description: '终判结论备注（以它为准写入 inspection_notes）' }),
    /**
     * 拟定处置（检验员的处置意图，落 `mrb_reviews.disposition` 初值）。
     * 判定不合格时自动创建的 MRB 单以此作为「处置方式」列初值，终审时由处置决策覆盖；
     * 缺省 `REWORK`（返工），"来料不合格退货" 传 `RETURN_TO_VENDOR`、"让步接收 / 特采" 传 `CONCESSION`。
     */
    preliminaryDisposition: MRBDispositionEnum.optional().openapi({
      description: '拟定处置（判定不合格自动建 MRB 单时的处置方式初值）',
      example: 'RETURN_TO_VENDOR',
    }),
  })
  .openapi('FinalizeInspectionStatusRequest');

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
  // 「合格后传递」收敛（docs/48 §4.2 / 硬约束 4）：放行关卡与传递门禁由**同一份**领域纯函数产出，
  // 下面三个字段把结构化理由一并下发，MES 不必解析中文 reason 才能分支。
  gateCode: z.string().optional().openapi({
    description: '传递判定理由码（TransferGateCode）：UPSTREAM_PASSED / UPSTREAM_CONCESSION / UPSTREAM_FAILED …',
    example: 'UPSTREAM_CONCESSION',
  }),
  predecessorOrderNo: z.string().optional().openapi({
    description: '权威上游检验单号（返工轮次时指向复检单）',
    example: 'OQC-SH-20260923-9001',
  }),
  mrbNo: z.string().optional().openapi({ description: '相关 MRB 评审单号', example: 'MRB20260923-001' }),
}).openapi('MandatoryGateCheckResponse');

/**
 * 炉批号数据关联（docs/47）—— 溯源来源枚举。
 *
 * 与领域层 `HeatBatchTraceService` 的 `HEAT_TRACE_SOURCE_TYPES` 同源同值：
 *   OUTSOURCE_HEAT_TREATMENT = L1 委外检验·热处理（OQC_HEAT）
 *   IQC_RAW_MATERIAL         = L2 来料检验（IQC）
 *   NONE                     = L3 两处均无记录（界面静默空态，不显示关联数据）
 */
/**
 * 炉批号历史追溯带出结果 Schema（**唯一一份**）。
 *
 * 历史教训（docs/47 D9）：本契约原先另有一份 `FurnaceHeatTraceResultSchema`
 * （字段为 `furnaceHeatNo / matchSource / mechanicalData / chemicalData`），
 * 与 `/inspections/heat-batch-trace` 实际返回体（`heatBatchNo / sourceType / inheritedItems`）
 * 完全不是一套 —— 前端只能靠口头约定对齐。本轮收敛为**按真实返回体定义**的这一份，
 * 旧 Schema 下线（禁止再出现两套字段口径）。
 */
/** 炉批号历史追溯查询条件（GET /inspections/heat-batch-trace） */
export const FurnaceHeatTraceQuerySchema = z
  .object({
    heatBatchNo: z.string().min(1, '炉批号不能为空'),
    materialCode: z.string().optional(),
    excludeOrderId: z.string().optional(),
  })
  .openapi('FurnaceHeatTraceQuery');

export const FurnaceHeatTraceResponseSchema = z
  .object({
    heatBatchNo: z.string().openapi({
      description: '被查询的炉批号（回显原值，非归一值）',
      example: 'HT02-20231008-A',
    }),
    sourceType: HeatTraceSourceTypeEnum.openapi({
      description: '关联来源：委外热处理 / 来料检验 / 无记录',
    }),
    matchScope: z.enum(['MATERIAL', 'GLOBAL']).openapi({
      description:
        '命中范围：MATERIAL = 同物料命中；GLOBAL = 跨物料命中（或未带物料编码），界面据此提示确认炉次归属',
    }),
    sourceOrderNo: z.string().optional().openapi({
      description: '来源检验单号',
      example: 'OQC-HT-20260705-0003',
    }),
    sourceOrderId: z.string().optional().openapi({ description: '来源检验单主键' }),
    sourceMaterialCode: z.string().optional().openapi({
      description: '源单物料编码（跨物料命中时供界面确认归属）',
    }),
    inspectedAt: z.string().optional().openapi({
      description: '源单检验日期 / 终判时间（优先业务检验日期）',
      example: '2026-07-05',
    }),
    inheritedItems: z
      .array(
        z.object({
          itemCode: z.string(),
          name: z.string(),
          metricCategory: MetricCategoryEnum,
          measuredVal: z.number().optional(),
          measuredText: z.string().optional(),
          unit: z.string().optional(),
        })
      )
      .default([])
      .openapi({
        description:
          '带出的历史实测项（白名单：力学性能 / 硬度 / 抗拉强度 / 化学成分；只带有实测值的项）',
      }),
    upstreamWarning: z
      .object({
        code: HeatTraceWarningCodeEnum,
        orderNos: z.array(z.string()).openapi({
          description: '命中的单据号（升序，最多 10 条）',
        }),
        message: z.string().openapi({
          description: '中文可读提示，界面直接展示（不在前端二次拼文案）',
        }),
      })
      .optional()
      .openapi({
        description:
          '上游异常提示（TBD-01）：同一炉批号存在「不合格 / MRB 未结案 / 未终判」记录时给出，只提示不带值、不阻断；无异常时缺省',
      }),
  })
  .openapi('FurnaceHeatTraceResponse');

/**
 * 检验单表头业务事实更新请求（`PATCH /inspections/{id}/header`）。
 *
 * 口径（docs/47 §4.6）：炉批号为关联锚点，服务端在写入时**重新解析**带出源并落
 * `heat_source_type` / `heat_source_order_no` —— 请求体不接受客户端自称的溯源来源。
 */
export const UpdateInspectionHeaderRequestSchema = z.object({
  furnaceHeatNo: z.string().max(64).optional().openapi({
    description: '炉批号（Heat No）；落 inspection_orders.furnace_heat_batch_no，空串表示清空',
    example: 'HT02-20231008-A',
  }),
  processType: z.string().max(64).optional().openapi({
    description: '加工类型/工艺分类（委外检验台账列，落 process_type）；空串表示清空',
    example: '镀锌',
  }),
  returnDate: z.string().max(32).optional().openapi({
    description: '回厂日期 YYYY-MM-DD（委外检验台账列，落 return_date）；空串表示清空',
    example: '2026-07-06',
  }),
  vendorName: z.string().max(255).optional().openapi({
    description: '加工商名称快照（委外检验台账列，落 vendor_name）；空串表示清空',
    example: '江阴达克罗金属制品有限公司',
  }),
  materialGrade: z.string().max(64).optional().openapi({ description: '材质牌号', example: 'ML40Cr' }),
  techStandard: z.string().max(128).optional().openapi({
    description: '执行产品技术标准',
    example: 'GB/T 3098.1-2010',
  }),
  inspectedDate: z.string().max(32).optional().openapi({
    description: '检验日期 YYYY-MM-DD',
    example: '2026-09-23',
  }),
  certTemplate: CertTemplateEnum.optional().openapi({
    description: '证书打印模板（docs/51：操作员填写前选定，随单保存）',
  }),
  certFields: CertFieldsSchema.optional().openapi({
    description: '证书专用补充字段袋（整体覆盖写入；只服务于证书打印）',
  }),
}).openapi('UpdateInspectionHeaderRequest');
