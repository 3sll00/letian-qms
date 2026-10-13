import {
  ColumnType,
  Generated,
  Selectable,
  Insertable,
  Updateable,
} from 'kysely';
import type {
  AuditLog,
  InspectionItem,
  InspectionPlanItem,
  InspectionStatus,
  InspectionType,
  IntegrationSyncLog,
  MRBApproverAction,
  MRBDisposition,
  MRBFailCategory,
  MRBStatus,
  MaterialPermission,
  OverallDecision,
  PlanSnapshot,
  PlanVersionStatus,
  ReviewFlowNode,
  SyncDirection,
  SyncStatus,
  SystemType,
  TraceNodeStatus,
  TraceRelationType,
} from '@letian/contracts';

/**
 * 本文件是 PostgreSQL 物理表结构与 TypeScript 类型的唯一映射层。
 * 列名使用 camelCase（运行时由 CamelCasePlugin 自动翻译为 snake_case），
 * 因此这里出现的每一个列名都必须在库中找到对应的 snake_case 列。
 *
 * 数值列说明：node-postgres 默认把 NUMERIC 读成字符串，本项目在
 * database/connection.ts 中把 OID 1700 (NUMERIC) 注册为 Number 解析器，
 * 与该文件里 NumericColumnType 的 SelectType 保持一致，
 * 避免出现"类型写 number、运行时却是 string"的静默不一致。
 *
 * JSONB 列说明：这里不使用 kysely 自带的 JSONColumnType，因为它的写入类型默认是
 * string，会强迫每个调用点手写 JSON.stringify。下面两个别名允许直接传对象/数组，
 * node-postgres 会把参数序列化成 JSON；读出来仍是已解析的 JS 值。
 */
/** NUMERIC（无库默认值，写入必填） */
export type NumericColumnType = ColumnType<number, number | string, number | string>;
/** NUMERIC + 库默认值（写入可省略） */
export type NumericGeneratedColumnType = ColumnType<
  number,
  number | string | undefined,
  number | string
>;
/** JSONB（无库默认值，写入必填） */
export type JsonColumnType<T> = ColumnType<T, string | T, string | T>;
/** JSONB + 库默认值（写入可省略） */
export type JsonGeneratedColumnType<T> = ColumnType<T, string | T | undefined, string | T>;

/** 方案抽样配置（inspection_plans.sampling_config JSONB 的内部结构） */
export interface PlanSamplingConfig {
  samplingScheme: string;
  aqlLevel: string;
  strictness: string;
  /** 方案版本生效起始日 (YYYY-MM-DD)，空表示即刻生效 */
  effectiveStartDate?: string;
  /** 方案版本生效截止日 (YYYY-MM-DD)，空表示长期有效 */
  effectiveEndDate?: string;
}

// ============================================================================
// 1. ERP 主数据档案（物料 / 存货分类 / 供应商 / 客户 / 车间 / 员工）
// ============================================================================

export interface MaterialsTable {
  id: Generated<string>;
  materialCode: string;
  materialName: string;
  specModel: string | null;
  categoryCode: string;
  unit: Generated<string>;
  confidentialityLevel: Generated<number>; // 密级 1-4
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface InventoryCategoriesTable {
  id: Generated<string>;
  categoryCode: string;
  categoryName: string;
  parentCode: string | null;
  level: Generated<number>;
  createdAt: Generated<Date>;
}

export interface SuppliersTable {
  id: Generated<string>;
  supplierCode: string;
  supplierName: string;
  contactPerson: string | null;
  phone: string | null;
  createdAt: Generated<Date>;
}

export interface CustomersTable {
  id: Generated<string>;
  customerCode: string;
  customerName: string;
  contactPerson: string | null;
  phone: string | null;
  createdAt: Generated<Date>;
}

export interface WorkshopsTable {
  id: Generated<string>;
  workshopCode: string;
  workshopName: string;
  createdAt: Generated<Date>;
}

export interface EmployeesTable {
  id: Generated<string>;
  employeeCode: string;
  name: string;
  department: string | null;
  phone: string | null;
  email: string | null;
  isActive: Generated<boolean>;
  createdAt: Generated<Date>;
  roleCode: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * scrypt 登录口令哈希（迁移 048）。
   * NULL = 未设独立口令 → 登录回落共享初始口令且响应带 mustChangePassword；
   * 敏感列：严禁映射进任何对外 DTO，只允许凭证读方法访问。
   */
  passwordHash: ColumnType<string | null, string | null | undefined, string | null>;
}

// ============================================================================
// 2. 质检方案与检验工单
// ============================================================================

export interface InspectionPlansTable {
  id: Generated<string>;
  planCode: string;
  planName: string;
  materialCode: string;
  /** 方案归属的存货分类编码：material_code 为空串时表示"该分类的通用方案"（014 迁移新增） */
  categoryCode: string | null;
  version: Generated<string>;
  versionStatus: Generated<PlanVersionStatus>;
  /** 与契约 InspectionTypeEnum 的 13 个取值一致（016 迁移已把 CHECK 约束补齐到含委外七分类） */
  inspectionStage: InspectionType;
  /** 方案适用的检验类型全集（039 迁移新增，含主类型 inspectionStage；匹配/筛选按数组包含判定） */
  inspectionTypes: JsonColumnType<InspectionType[]>;
  items: JsonColumnType<InspectionPlanItem[]>;
  samplingConfig: JsonColumnType<PlanSamplingConfig>;
  workshopCode: string | null;
  confidentialityLevel: Generated<number>;
  createdBy: string;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface InspectionOrdersTable {
  id: Generated<string>;
  orderNo: string;
  /** 与契约 InspectionTypeEnum 的 13 个取值一致（009 迁移已对齐 CHECK 约束） */
  orderType: InspectionType;
  planId: string;
  batchNo: string;
  materialCode: string;
  supplierCode: string | null;
  workshopCode: string | null;
  inspectorId: string | null;
  totalQty: NumericColumnType | null;
  sampleQty: NumericColumnType;
  status: Generated<InspectionStatus>;
  /** null 表示尚未终判；非空时只能是 PASSED / FAILED / CONCESSION */
  judgment: OverallDecision | null;
  confidentialityLevel: Generated<number>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  materialName: string;
  customerCode: string | null;
  passQty: NumericGeneratedColumnType;
  failQty: NumericGeneratedColumnType;
  isMandatoryGate: Generated<boolean>;
  inspectionNotes: string | null;
  planVersionId: string;
  planSnapshot: JsonColumnType<PlanSnapshot>;
  items: JsonColumnType<InspectionItem[]>;
  customerAddress?: string | null;
  projectNo?: string | null;
  shortProjectNo?: string | null;
  manufactureDate?: Date | null;
  // 006 来料检验 (IQC) 入库单号 / 入库日期 / 规格对账字段（迁移 021 起列名统一为 inbound_*）
  inboundNo?: string | null;
  inboundDate?: Date | null;
  specification?: string | null;
  unit?: string | null;
  supplierName?: string | null;
  inspectorName?: string | null;
  // 007 过程检验 (IPQC: 下料检验/滚丝检验/成品检) 工序与设备追溯字段
  workOrderNo?: string | null;
  blankingLength?: NumericColumnType | null;
  operatorName?: string | null;
  operatorId?: string | null;
  equipmentCode?: string | null;
  equipmentName?: string | null;
  threadSpec?: string | null;
  inspectionTeam?: string | null;
  processStep?: string | null;
  completedAt?: Date | null;
  // 008 出货检验 (OQC) 销售出库对账与客户追溯字段
  salesOrderNo?: string | null;
  dispatchDate?: string | null;
  customerName?: string | null;
  salesOrderPoNo?: string | null;
  erpStatus?: string | null;
  // 009 委外检验 (OQC 七分类) 台账字段：委外单号 / 加工类型 / 回厂日期 / 加工商快照
  outsourceNo?: string | null;
  processType?: string | null;
  returnDate?: string | null;
  vendorName?: string | null;
  // 030 委外检验录入页业务事实字段（docs/36）：材质牌号 / 执行技术标准 / 检验日期
  materialGrade?: string | null;
  techStandard?: string | null;
  inspectedDate?: string | null;
  // 029 质量负责人签核（docs/35 §5）：由 POST /inspections/{id}/approve 写入**真实签核动作**
  // （签核人 = 当前登录用户）。三列为 NULL 表示尚未签核 —— 证书留白，不打印任何人名。
  approverId?: string | null;
  approverName?: string | null;
  approvedAt?: Date | null;
  // 034 出货检验炉批号数据关联（docs/47）：炉批号 + 溯源留痕 + SQL 侧归一生成列。
  // 此前 furnace_heat_batch_no 由迁移 004 建列后**全仓无写入路径**（列恒 NULL，见 docs/47 D1），
  // 迁移 034 起由「建单透传 + 表头更新」两条写路径落值；归一列是生成列，应用层只读不写。
  /** 炉批号：钢材冶炼炉号 / 热处理炉批号；无炉批概念时为空 */
  furnaceHeatBatchNo?: string | null;
  /** 归一化炉批号（生成列：upper + 去空格 / 连字符 / 下划线 / 全角空格）；仅供等值查询 */
  furnaceHeatBatchNoNorm?: Generated<string | null>;
  /**
   * 本单炉批号数据的带出源：OUTSOURCE_HEAT_TREATMENT / IQC_RAW_MATERIAL；未带出为空。
   *
   * 与契约 `HeatTraceAppliedSourceTypeEnum` 同口径（迁移 020 的 CHECK 约束只允许这两个值）。
   * 原先登记为 `string | null`，会让装配 DTO 时出现「string 不能赋给两值联合」的类型错误 ——
   * 那个错误此前被 `(row as any)` 掩盖掉了。登记真实取值域后，越界值在编译期就会暴露。
   */
  heatSourceType?: 'OUTSOURCE_HEAT_TREATMENT' | 'IQC_RAW_MATERIAL' | null;
  /** 本单炉批号数据带出的源检验单号；未带出为空 */
  heatSourceOrderNo?: string | null;
  // 035 「合格后传递」建单留痕（docs/48 §4.1）：建单那一次判定的存档。
  // **只作留痕与展示，永远不作判据**（判据一律按 §2 实时重算）；未走建单门禁的单据（如 MRB 复检单）四列为空。
  /** 建单时命中的链路锚点值（未命中时回落本单批次号） */
  chainKey?: string | null;
  /** 建单时命中的锚点类型：BATCH / HEAT / WORK_ORDER */
  chainKeyKind?: string | null;
  /** 建单时认定的权威上游检验单号（复检轮次指向复检单；无上游单为空） */
  upstreamOrderNo?: string | null;
  /** 建单时的判定理由码（TransferGateCode） */
  upstreamGateCode?: string | null;
  // 038 证书模板与证书专用字段（docs/51）：操作员在「填写检验内容前」选定打印模板；
  // 两列只作证书打印与展示，不进任何判定/权限/传递链路；NULL = 未选择，界面按模块缺省渲染。
  /**
   * 证书模板：'QUALITY' = 质量保证书（纵向）/ 'MANUFACTURING' = 制造证书（横向）。
   *
   * 与契约 `CertTemplateEnum` 同一取值域；原先写 `string | null`，
   * 装配 DTO 时会因「string 不能赋给两值联合」而报错 —— 该错误此前被 `(row as any)` 掩盖。
   */
  certTemplate?: 'QUALITY' | 'MANUFACTURING' | null;
  /**
   * 证书专用补充字段袋（制造证书 DO ref./Jobcard/交货点/涂层/颜色，质保书 印记/抽样计划 等）。
   *
   * 与契约 `CertFieldsSchema`（z.record(z.string(), z.string())）同一取值域；
   * 原先登记 `Record<string, unknown>`，装配 DTO 时因「unknown 不能赋给 string」而报错 ——
   * 该错误此前被 `(row as any)` 掩盖。JSONB 存的是字符串值袋，按实情登记。
   */
  certFields?: JsonColumnType<Record<string, string>> | null;
}

// ============================================================================
// 3. MRB 评审与可配置评审流程
// ============================================================================

export interface ReviewFlowsTable {
  id: Generated<string>;
  flowCode: string;
  flowName: string;
  /** 019：流程说明（流程设置页卡片与详情展示） */
  description: string | null;
  applicableType: MRBFailCategory;
  version: Generated<string>;
  isActive: Generated<boolean>;
  /** 节点列表；每项含 nodeLevel / nodeName / roleCode / roleName / isRequired / allowConcession / requireCustomerSign */
  nodes: JsonColumnType<ReviewFlowNode[]>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface MrbReviewsTable {
  id: Generated<string>;
  mrbNo: string;
  /** 与契约 MRBFailCategoryEnum 一致：不合格来源分类 */
  sourceType: MRBFailCategory;
  sourceOrderNo: string;
  batchNo: string;
  materialCode: string;
  materialName: string;
  workshopCode: string | null;
  defectDescription: string;
  defectQty: NumericColumnType;
  status: Generated<MRBStatus>;
  disposition: MRBDisposition | null;
  dispositionNotes: string | null;
  approvers: JsonColumnType<MRBApproverAction[]>;
  concessionAttachmentUrl: string | null;
  confidentialityLevel: Generated<number>;
  /** 015：关联的不合格待审核池条目（池 -> MRB 的正向溯源） */
  pendingDefectId: string | null;
  /** 015：发起时选用的评审流程定义 */
  reviewFlowId: string | null;
  /** 015：紧急程度 NORMAL / URGENT / CRITICAL */
  urgencyLevel: Generated<string>;
  /** 015：发起说明（与不合格描述文本分离） */
  reviewNotes: string | null;
  /** 015：处置闭环时间 */
  disposedAt: Date | null;
  /** 015：最终裁决人姓名 */
  disposedBy: string | null;
  /** 047：最近一次自动催办时间；未催办为 null */
  lastRemindedAt: Generated<Date | null>;
  /** 047：自动催办次数 */
  reminderCount: Generated<number>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

// ============================================================================
// 4. 批次追溯（关系边 + 追溯节点）
// ============================================================================

export interface BatchTraceRelationsTable {
  parentBatch: string;
  childBatch: string;
  relationType: TraceRelationType;
  qty: NumericColumnType;
  operator: string;
  operationTime: Generated<Date>;
}

export interface BatchTraceNodesTable {
  id: Generated<string>;
  batchNo: string;
  stageName: string;
  materialName: string;
  operatorName: string;
  nodeStatus: Generated<TraceNodeStatus>;
  orderNo: string | null;
  supplierOrCustomer: string | null;
  occurredAt: Generated<Date>;
  createdAt: Generated<Date>;
  // 020 迁移新增：节点血缘标识（缺值一律留 NULL，不用空串占位）
  /** 物料编码；主数据未建档时为空 */
  materialCode?: string | null;
  /** 炉批号：钢材炉号 / 热处理炉批号；无炉批概念时为空 */
  furnaceHeatBatchNo?: string | null;
  /** 本节点对应的检验单号；该环节尚未建检验单时为空 */
  inspectionOrderNo?: string | null;
}

// ============================================================================
// 5. 审计日志 / 幂等键 / Outbox
// ============================================================================

export interface AuditLogsTable {
  id: Generated<string>;
  entityName: string;
  entityId: string;
  action: string;
  operatorId: string;
  operatorName: string;
  diffPatch: JsonColumnType<Record<string, unknown>>;
  clientIp: string | null;
  userAgent: string | null;
  occurredAt: Generated<Date>;
  traceId: string;
  status: Generated<string>;
}

export interface IdempotencyKeysTable {
  userId: string;
  endpoint: string;
  idempotencyKey: string;
  payloadHash: string;
  responseCode: number;
  responseBody: JsonColumnType<Record<string, unknown>>;
  createdAt: Generated<Date>;
  expiresAt: Date;
}

export interface OutboxEventsTable {
  id: Generated<string>;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: JsonColumnType<Record<string, unknown>>;
  status: Generated<'PENDING' | 'PUBLISHED' | 'FAILED' | 'DEAD_LETTER'>;
  retryCount: Generated<number>;
  createdAt: Generated<Date>;
  processedAt: Date | null;
  /** 047：FAILED 事件下一次允许投递的时间；立即重试时为 null */
  nextRetryAt: Generated<Date | null>;
  /** 047：死信告警成功送达时间；未送达则后台任务继续补发 */
  deadLetterAlertedAt: Generated<Date | null>;
  traceId: string | null;
  errorReason: string | null;
}

// ============================================================================
// 6. MES/ERP 集成配置与同步日志
// ============================================================================

export interface IntegrationConfigsTable {
  id: Generated<string>;
  systemCode: SystemType;
  systemName: string;
  baseUrl: string;
  authType: Generated<string>;
  authSecret: string | null;
  timeoutMs: Generated<number>;
  isEnabled: Generated<boolean>;
  syncSchedule: string | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  subscribedWorkshops: JsonGeneratedColumnType<string[]>;
  subscribedProcesses: JsonGeneratedColumnType<string[]>;
}

export interface IntegrationSyncLogsTable {
  id: Generated<string>;
  systemCode: SystemType;
  taskName: string;
  status: SyncStatus;
  recordsProcessed: Generated<number>;
  errorMessage: string | null;
  durationMs: Generated<number>;
  createdAt: Generated<Date>;
  batchNo: string;
  syncDirection: SyncDirection;
}

// ============================================================================
// 7. 物料行级数据权限（PBAC）
// ============================================================================


export interface RolesTable {
  roleCode: string;
  roleName: string;
  description: string | null;
  isActive: Generated<boolean>;
  sortOrder: Generated<number>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface AuthorizationLogsTable {
  id: Generated<string>;
  userId: string;
  userName: string;
  roleCode: string | null;
  resourceType: string;
  resourceId: string | null;
  materialCode: string | null;
  materialCategory: string | null;
  supplierCode: string | null;
  action: string;
  decision: "ALLOWED" | "DENIED";
  matchedRuleId: string | null;
  detail: string | null;
  createdAt: Generated<Date>;
}

export interface MaterialPermissionsTable {
  id: Generated<string>;
  userId: string;
  userName: string;
  roleCode: string;
  materialCategories: JsonGeneratedColumnType<string[]>;
  materialCodes: JsonGeneratedColumnType<string[]>;
  supplierCodes: JsonGeneratedColumnType<string[]>;
  isActive: Generated<boolean>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}


// ============================================================================
// 8. 质检报表模板配置表
// ============================================================================

// ============================================================================
// 7.5 不合格待审核池工单表 (Pending Review Pool)
// ============================================================================

export interface PendingMrbItemsTable {
  id: Generated<string>;
  sourceOrderId: string;
  sourceOrderNo: string;
  sourceStage: string;
  materialCode: string;
  materialName: string;
  batchNo: string;
  defectQty: NumericColumnType;
  defectRate: NumericColumnType;
  /** 015：报检总数量（不良率分母） */
  totalQty: NumericColumnType;
  failReason: string;
  failedItems: JsonColumnType<any[]>;
  /** 015：首个判不合格的指标项编码 */
  defectItemCode: string | null;
  /** 015：来源检验单供应商（IQC / 委外） */
  supplierName: string | null;
  /** 015：来源检验单客户（OQC） */
  customerName: string | null;
  /** 015：来源检验单检验人 */
  inspectorId: string | null;
  inspectorName: string | null;
  status: Generated<string>;
  mrbReviewId: string | null;
  reviewStartedAt: Date | null;
  reviewStartedBy: string | null;
  createdAt: Generated<Date>;
}

export interface ReportTemplatesTable {
  id: Generated<string>;
  templateCode: string;
  templateName: string;
  scope: string;
  applicableType: string;
  isDefault: Generated<boolean>;
  pageSize: Generated<string>;
  orientation: Generated<string>;
  sectionLayouts: JsonColumnType<any[]>;
  headerConfig: JsonColumnType<Record<string, any>> | null;
  footerConfig: JsonColumnType<Record<string, any>> | null;
  watermarkText: string | null;
  customCss: string | null;
  status: Generated<string>;
  createdBy: string;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}


export interface WarehousesTable {
  id: Generated<string>;
  warehouseCode: string;
  warehouseName: string;
  warehouseType: Generated<string>;
  location: string | null;
  managerName: string | null;
  isActive: Generated<boolean>;
  comment: string | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

/**
 * 方案编码流水号池（迁移 017）：主键 (prefix, day_key) 同时是并发取号的排他锁点，
 * 由仓储 `InspectionPlanRepository.allocatePlanCodeSequence` 以原子 upsert 取号。
 * 与检验单号流水号池（迁移 012）同构，区别只是编码段位数为 3 位。
 */
export interface InspectionPlanCodeSequencesTable {
  prefix: string;
  dayKey: string;
  lastSeq: Generated<number>;
  updatedAt: Generated<Date>;
}

/**
 * 检验单号改号留痕（迁移 025）：历史三段式单号 `INS-{YYYYMMDD}-{NNN}` ->
 * `{前缀}-{YYYYMMDD}-{NNNN}` 的逐条映射，既是「改号 ↔ 对账」的唯一依据，也是迁移 down 的回滚依据。
 * `audit_logs` 为 append-only 不可改写，故留痕独立成表；完整设计见 docs/31。
 */
export interface InspectionOrderNoRenumberingsTable {
  oldNo: string;
  newNo: string;
  orderId: string;
  orderType: string;
  migratedAt: Generated<Date>;
}

/**
 * 物料编码改号留痕（迁移 026）：原型遗留编码 `CP-*` -> 主数据口径 `MAT-*` 的逐条映射，
 * 既是「改号 ↔ 对账」的唯一依据，也是迁移 down 的回滚依据；完整设计见 docs/32。
 */
export interface MaterialCodeRenumberingsTable {
  oldCode: string;
  newCode: string;
  materialId: string | null;
  materialName: string | null;
  note: string | null;
  migratedAt: Generated<Date>;
}
/**
 * 委外单号 / 委外批次号改号留痕（迁移 028）：`kind` 区分 OUTSOURCE_NO（`WW-` -> `WWJG-`）与
 * BATCH_NO（`WW-` -> `B…`），既是「改号 ↔ 对账」的唯一依据，也是迁移 down 的回滚依据；
 * 完整设计见 docs/34 §2。
 */
export interface OutsourceReferenceRenumberingsTable {
  id: Generated<string>;
  orderId: string | null;
  orderNo: string | null;
  kind: string;
  oldValue: string;
  newValue: string;
  note: string | null;
  migratedAt: Generated<Date>;
}
export interface MaterialCategoryReassignmentsTable {
  materialCode: string;
  oldCategoryCode: string | null;
  newCategoryCode: string;
  note: string | null;
  migratedAt: Generated<Date>;
}
/**
 * 企业档案主数据（迁移 029）：证书抬头「签发主体 / 供货单位 / 产地」的唯一真实来源。
 * 单行表：`profile_id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (profile_id)`，结构上不可能有第二行。
 */
export interface CompanyProfileTable {
  profileId: Generated<boolean>;
  legalName: string | null;
  legalNameEn: string | null;
  shortName: string | null;
  address: string | null;
  originPlace: string | null;
  phone: string | null;
  email: string | null;
  /** 证书印章文字（如「江阴乐天质检」）；无值即不打印印章 */
  qualityStamp: string | null;
  updatedBy: string | null;
  updatedAt: Generated<Date>;
}

/**
 * 检验项目字典（迁移 037）：ERP `TestItem` 表的 QMS 镜像。
 * 检验方案明细 ERP 口径字段（testItemCode / dif / checkWay）中的 `testItemCode` 回链表；
 * `bBuy/bProduce/bConsign` 三标志决定该项目在哪个质检阶段（来料/过程/委外·出货）可被选用。
 */
export interface TestItemsTable {
  id: Generated<string>;
  /** ERP `TestItem.TypeID`（如 '00001'），全局唯一 */
  testItemCode: string;
  name: string;
  namePy: string | null;
  testStandard: string | null;
  appliesToBuy: Generated<boolean>;
  appliesToProduce: Generated<boolean>;
  appliesToConsign: Generated<boolean>;
  sortNo: Generated<number>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface Database {
  warehouses: WarehousesTable;
  materials: MaterialsTable;
  inventoryCategories: InventoryCategoriesTable;
  suppliers: SuppliersTable;
  customers: CustomersTable;
  workshops: WorkshopsTable;
  employees: EmployeesTable;
  companyProfile: CompanyProfileTable;
  testItems: TestItemsTable;
  inspectionPlans: InspectionPlansTable;
  inspectionOrders: InspectionOrdersTable;
  reviewFlows: ReviewFlowsTable;
  mrbReviews: MrbReviewsTable;
  batchTraceRelations: BatchTraceRelationsTable;
  batchTraceNodes: BatchTraceNodesTable;
  auditLogs: AuditLogsTable;
  idempotencyKeys: IdempotencyKeysTable;
  outboxEvents: OutboxEventsTable;
  integrationConfigs: IntegrationConfigsTable;
  integrationSyncLogs: IntegrationSyncLogsTable;
  materialPermissions: MaterialPermissionsTable;
  roles: RolesTable;
  authorizationLogs: AuthorizationLogsTable;
  pendingMrbItems: PendingMrbItemsTable;
  reportTemplates: ReportTemplatesTable;
  inspectionPlanCodeSequences: InspectionPlanCodeSequencesTable;
  inspectionOrderNoRenumberings: InspectionOrderNoRenumberingsTable;
  materialCodeRenumberings: MaterialCodeRenumberingsTable;
  materialCategoryReassignments: MaterialCategoryReassignmentsTable;
  outsourceReferenceRenumberings: OutsourceReferenceRenumberingsTable;
  transferOverrideTickets: TransferOverrideTicketsTable;
  qmsErpCodeMapping: QmsErpCodeMappingTable;
}

// ============================================================================
// QMS ↔ ERP 编码映射表（迁移 041）：物料/供应商/检验员 的 QMS 编码 → ERP typeId
// ============================================================================

export interface QmsErpCodeMappingTable {
  id: Generated<string>;
  /** 'MATERIAL' | 'SUPPLIER' | 'EMPLOYEE' */
  entityType: string;
  /** materialCode / supplierCode / inspectorName（QMS 侧键） */
  qmsCode: string;
  /** ERP Ptype / Btype / Employee 的 typeId */
  erpTypeId: string;
  /** ERP UserCode（物料/供应商备查；员工为空） */
  erpUserCode: string | null;
  /** ERP FullName / Employee.Name（备查） */
  erpFullName: string | null;
  /** 'auto' = 回填脚本自动解析；'manual' = 运维手工补合成码 */
  source: string;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

// ============================================================================
// 行类型与写类型别名：仓储读写时直接引用，避免各处重复写 Selectable<XTable>
// ============================================================================

export type MaterialRow = Selectable<MaterialsTable>;
export type InventoryCategoryRow = Selectable<InventoryCategoriesTable>;
export type SupplierRow = Selectable<SuppliersTable>;
export type CustomerRow = Selectable<CustomersTable>;
export type WorkshopRow = Selectable<WorkshopsTable>;
export type EmployeeRow = Selectable<EmployeesTable>;
export type InspectionPlanRow = Selectable<InspectionPlansTable>;
export type CompanyProfileRow = Selectable<CompanyProfileTable>;
export type TestItemRow = Selectable<TestItemsTable>;
export type InspectionOrderRow = Selectable<InspectionOrdersTable>;
export type ReviewFlowRow = Selectable<ReviewFlowsTable>;
export type MrbReviewRow = Selectable<MrbReviewsTable>;
export type BatchTraceNodeRow = Selectable<BatchTraceNodesTable>;
export type BatchTraceRelationRow = Selectable<BatchTraceRelationsTable>;
export type AuditLogRow = Selectable<AuditLogsTable>;
export type OutboxEventRow = Selectable<OutboxEventsTable>;
export type IntegrationConfigRow = Selectable<IntegrationConfigsTable>;
export type IntegrationSyncLogRow = Selectable<IntegrationSyncLogsTable>;
export type MaterialPermissionRow = Selectable<MaterialPermissionsTable>;

export type RoleRow = Selectable<RolesTable>;
export type RoleInsert = Insertable<RolesTable>;
export type RoleUpdate = Updateable<RolesTable>;

export type AuthorizationLogRow = Selectable<AuthorizationLogsTable>;
export type AuthorizationLogInsert = Insertable<AuthorizationLogsTable>;
export type AuthorizationLogUpdate = Updateable<AuthorizationLogsTable>;

export type PendingMrbItemRow = Selectable<PendingMrbItemsTable>;
export type PendingMrbItemInsert = Insertable<PendingMrbItemsTable>;
export type PendingMrbItemUpdate = Updateable<PendingMrbItemsTable>;

export type ReportTemplateRow = Selectable<ReportTemplatesTable>;
export type WarehouseRow = Selectable<WarehousesTable>;
export type NewWarehouseRow = Insertable<WarehousesTable>;
export type ReportTemplateInsert = Insertable<ReportTemplatesTable>;
export type ReportTemplateUpdate = Updateable<ReportTemplatesTable>;

export interface TransferOverrideTicketsTable {
  id: Generated<string>;
  ticketNo: string;
  batchNo: string;
  materialCode: string;
  inspectionType: string;
  workOrderNo: string | null;
  furnaceHeatNo: string | null;
  upstreamOrderNo: string | null;
  upstreamGateCode: string;
  reason: string;
  applicantId: string;
  applicantName: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED';
  reviewerId: string | null;
  reviewerName: string | null;
  reviewNotes: string | null;
  approvalDocNo: string | null;
  consumedOrderId: string | null;
  consumedOrderNo: string | null;
  createdAt: Generated<Date>;
  reviewedAt: Date | null;
  consumedAt: Date | null;
}

export type TransferOverrideTicketRow = Selectable<TransferOverrideTicketsTable>;
export type TransferOverrideTicketInsert = Insertable<TransferOverrideTicketsTable>;
export type TransferOverrideTicketUpdate = Updateable<TransferOverrideTicketsTable>;

export type QmsErpCodeMappingRow = Selectable<QmsErpCodeMappingTable>;
export type QmsErpCodeMappingInsert = Insertable<QmsErpCodeMappingTable>;
export type QmsErpCodeMappingUpdate = Updateable<QmsErpCodeMappingTable>;


export type MaterialInsert = Insertable<MaterialsTable>;
export type InventoryCategoryInsert = Insertable<InventoryCategoriesTable>;
export type SupplierInsert = Insertable<SuppliersTable>;
export type CustomerInsert = Insertable<CustomersTable>;
export type WorkshopInsert = Insertable<WorkshopsTable>;
export type EmployeeInsert = Insertable<EmployeesTable>;
export type CompanyProfileInsert = Insertable<CompanyProfileTable>;
export type InspectionPlanInsert = Insertable<InspectionPlansTable>;
export type InspectionOrderInsert = Insertable<InspectionOrdersTable>;
export type InspectionOrderUpdate = Updateable<InspectionOrdersTable>;
export type ReviewFlowInsert = Insertable<ReviewFlowsTable>;
export type MrbReviewInsert = Insertable<MrbReviewsTable>;
export type AuditLogInsert = Insertable<AuditLogsTable>;
export type OutboxEventInsert = Insertable<OutboxEventsTable>;
export type IntegrationConfigInsert = Insertable<IntegrationConfigsTable>;
export type IntegrationSyncLogInsert = Insertable<IntegrationSyncLogsTable>;
export type MaterialPermissionInsert = Insertable<MaterialPermissionsTable>;

/** 审计日志：application 层的 IAuditLogRepository 直接收发契约 DTO */
export type AuditLogDto = AuditLog;
/** 物料权限：同上 */
export type MaterialPermissionDto = MaterialPermission;
/** 集成同步日志：同上 */
export type IntegrationSyncLogDto = IntegrationSyncLog;
