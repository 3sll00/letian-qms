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
}

// ============================================================================
// 2. 质检方案与检验工单
// ============================================================================

export interface InspectionPlansTable {
  id: Generated<string>;
  planCode: string;
  planName: string;
  materialCode: string;
  version: Generated<string>;
  versionStatus: Generated<PlanVersionStatus>;
  /** 与契约 InspectionTypeEnum 的 6 个取值一致（002 迁移已对齐 CHECK 约束） */
  inspectionStage: InspectionType;
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
  /** 与契约 InspectionTypeEnum 的 6 个取值一致 */
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
  // 006 来料检验采购入库与规格对账字段
  receiptNo?: string | null;
  receiptDate?: Date | null;
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
}

// ============================================================================
// 3. MRB 评审与可配置评审流程
// ============================================================================

export interface ReviewFlowsTable {
  id: Generated<string>;
  flowCode: string;
  flowName: string;
  applicableType: MRBFailCategory;
  version: Generated<string>;
  isActive: Generated<boolean>;
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
  failReason: string;
  failedItems: JsonColumnType<any[]>;
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

export interface Database {
  warehouses: WarehousesTable;
  materials: MaterialsTable;
  inventoryCategories: InventoryCategoriesTable;
  suppliers: SuppliersTable;
  customers: CustomersTable;
  workshops: WorkshopsTable;
  employees: EmployeesTable;
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


export type MaterialInsert = Insertable<MaterialsTable>;
export type InventoryCategoryInsert = Insertable<InventoryCategoriesTable>;
export type SupplierInsert = Insertable<SuppliersTable>;
export type CustomerInsert = Insertable<CustomersTable>;
export type WorkshopInsert = Insertable<WorkshopsTable>;
export type EmployeeInsert = Insertable<EmployeesTable>;
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
