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
  UpdateMaterialPermissionRequestSchema,
  ApplyRolePermissionRequestSchema,
  PermissionCheckRequestSchema,
  PermissionCheckResponseSchema,
  AuthUserSchema,
  LoginRequestSchema,
  LoginUserSchema,
  LoginResponseSchema,
  ChangePasswordRequestSchema,
} from './schemas/permission';

// 批次追溯契约
export * from './schemas/trace';
export {
  TraceRelationTypeEnum,
  TraceDirectionEnum,
  TraceNodeStatusEnum,
  TraceNodeSchema,
  TraceEdgeSchema,
  TraceImpactSummarySchema,
  TraceabilityGraphResponseSchema,
  TraceBatchSummarySchema,
  TraceBatchSearchResponseSchema,
  TraceOrderChainStageSchema,
  TraceOrderChainResponseSchema,
} from './schemas/trace';

// MRB 评审契约
export * from './schemas/mrb';
export {
  PendingDefectStatusEnum,
  PendingDefectItemSchema,
  InitiateReviewRequestSchema,
  MRBStatusEnum,
  MRBCategoryTabEnum,
  MRBDispositionEnum,
  MRBFailCategoryEnum,
  MRBUrgencyLevelEnum,
  ReviewFlowNodeSchema,
  ReviewFlowSchema,
  MRBApproverActionSchema,
  MRBReviewSchema,
  DisposeMRBResponseSchema,
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
  ToleranceKindEnum,
  JudgmentMethodEnum,
  InspectionItemDecisionEnum,
  InspectionPlanItemSchema,
  PlanVersionStatusEnum,
  PlanStatusEnum,
  PlanStatsSchema,
  InspectionPlanVersionSchema,
  InspectionPlanSchema,
  CreateInspectionPlanRequestSchema,
  PlanVersionStatusActionEnum,
  TogglePlanVersionStatusRequestSchema,
  UpgradePlanVersionRequestSchema,
  ImportPlanCreatedSchema,
  ImportPlanSkippedSchema,
  ImportPlanFailedSchema,
  ImportPlansResultSchema,
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
  GROUP_TO_FAIL_CATEGORY,
  inspectionTypeToFailCategory,
} from './schemas/inspection-groups';

// ERP/MES 集成主数据契约
export * from './schemas/integration';
export {
  MaterialSchema,
  InventoryCategorySchema,
  TestItemSchema,
  SupplierSchema,
  CustomerSchema,
  WorkshopSchema,
  EmployeeSchema,
  CompanyProfileSchema,
  UpsertCompanyProfileRequestSchema,
  SystemTypeEnum,
  IntegrationConfigSchema,
  SyncDirectionEnum,
  SyncStatusEnum,
  IntegrationSyncLogSchema,
  TriggerSyncRequestSchema,
  TriggerSyncResponseSchema,
} from './schemas/integration';

// 设备管理契约（系统管理-设备管理，迁移 049）
export * from './schemas/equipment';
export {
  EQUIPMENT_STATUS_OPTIONS,
  EquipmentSchema,
  CreateEquipmentRequestSchema,
  EquipmentListQuerySchema,
  EquipmentListResponseSchema,
} from './schemas/equipment';

export * from './schemas';
export * from './dtos';
export * from './errors';
export * from './openapi/generator';
