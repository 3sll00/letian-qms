// 错误与通用契约
export * from './schemas/error';
export {
  InvalidParamDetailSchema,
  ProblemDetailsSchema,
} from './schemas/error';

// Outbox 契约
export * from './schemas/outbox';
export {
  OutboxStatusEnum,
  OutboxEventSchema,
} from './schemas/outbox';

// 审计日志契约
export * from './schemas/audit';
export {
  AuditActionEnum,
  AuditStatusEnum,
  AuditLogSchema,
  AuditStatsResponseSchema,
} from './schemas/audit';

// PBAC 契约
export * from './schemas/pbac';
export {
  MaterialPermissionSchema,
  UpdateMaterialPermissionRequestSchema,
} from './schemas/pbac';

// 权限管理体系契约
export * from './schemas/permission';
export {
  RoleSchema,
  AuthorizationDecisionEnum,
  AuthorizationLogSchema,
  PermissionLogsQuerySchema,
  PermissionLogListResponseSchema,
  PermissionListQuerySchema,
  MaterialPermissionListResponseSchema,
  CreatePermissionRequestSchema,
  ApplyRolePermissionRequestSchema,
  PermissionCheckRequestSchema,
  PermissionCheckResponseSchema,
  AuthUserSchema,
  LoginRequestSchema,
  LoginUserSchema,
  LoginResponseSchema,
} from './schemas/permission';

// 批次追溯契约
export * from './schemas/trace';
export {
  TraceRelationTypeEnum,
  TraceDirectionEnum,
  TraceNodeStatusEnum,
  TraceNodeSchema,
  TraceEdgeSchema,
  TraceabilityGraphResponseSchema,
} from './schemas/trace';

// MRB 评审契约
export * from './schemas/mrb';
export {
  MRBStatusEnum,
  MRBCategoryTabEnum,
  MRBDispositionEnum,
  MRBFailCategoryEnum,
  ReviewFlowNodeSchema,
  ReviewFlowSchema,
  MRBApproverActionSchema,
  MRBReviewSchema,
  PaginatedMRBRecordsSchema,
  ReviewNodeStatusEnum,
  ConcessionSignOffSchema,
  ReviewStepConfigSchema,
  MRBReviewNodeSchema,
  CreateMRBReviewRequestSchema,
  SubmitNodeReviewRequestSchema,
  DisposeMRBRequestSchema,
  MRBDispositionDecisionRequestSchema,
  MRBMetricsOverviewSchema,
} from './schemas/mrb';

// 检验工单与质检方案契约
export * from './schemas/inspection';
export {
  InspectionTypeEnum,
  InspectionStatusEnum,
  OverallDecisionEnum,
  DataTypeEnum,
  MetricCategoryEnum,
  InspectionItemDecisionEnum,
  InspectionPlanItemSchema,
  PlanVersionStatusEnum,
  InspectionPlanVersionSchema,
  InspectionPlanSchema,
  InspectionItemSchema,
  InspectionPlanSnapshotSchema,
  PlanSnapshotSchema,
  InspectionOrderSchema,
  CreateInspectionOrderRequestSchema,
  RecordInspectionItemRequestSchema,
  BatchRecordInspectionItemsRequestSchema,
  InspectionProgressOverviewSchema,
  MandatoryGateCheckResponseSchema,
} from './schemas/inspection';

// 检验分组契约
export * from './schemas/inspection-groups';
export {
  INSPECTION_GROUPS,
  INSPECTION_FILTER_TABS,
  isInspectionGroup,
  inspectionTypeMatchesGroup,
  inspectionGroupMembers,
} from './schemas/inspection-groups';

// ERP/MES 集成主数据契约
export * from './schemas/integration';
export {
  MaterialSchema,
  InventoryCategorySchema,
  SupplierSchema,
  CustomerSchema,
  WorkshopSchema,
  EmployeeSchema,
  SystemTypeEnum,
  IntegrationConfigSchema,
  SyncDirectionEnum,
  SyncStatusEnum,
  IntegrationSyncLogSchema,
  TriggerSyncRequestSchema,
  TriggerSyncResponseSchema,
} from './schemas/integration';

export * from './schemas';
export * from './dtos';
export * from './errors';
export * from './openapi/generator';
