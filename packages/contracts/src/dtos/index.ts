import { z } from 'zod';
import * as schemas from '../schemas';

// ============================================================================
// 1. 基础主数据与集成 DTOs (ERP / MES)
// ============================================================================
export type Material = z.infer<typeof schemas.MaterialSchema>;
export type InventoryCategory = z.infer<typeof schemas.InventoryCategorySchema>;
export type TestItem = z.infer<typeof schemas.TestItemSchema>;
export type Supplier = z.infer<typeof schemas.SupplierSchema>;
export type Customer = z.infer<typeof schemas.CustomerSchema>;
export type Workshop = z.infer<typeof schemas.WorkshopSchema>;
export type Employee = z.infer<typeof schemas.EmployeeSchema>;
export type CompanyProfile = z.infer<typeof schemas.CompanyProfileSchema>;
export type UpsertCompanyProfileRequest = z.infer<typeof schemas.UpsertCompanyProfileRequestSchema>;

export type SystemType = z.infer<typeof schemas.SystemTypeEnum>;
export type IntegrationConfig = z.infer<typeof schemas.IntegrationConfigSchema>;
export type SyncDirection = z.infer<typeof schemas.SyncDirectionEnum>;
export type SyncStatus = z.infer<typeof schemas.SyncStatusEnum>;
export type IntegrationSyncLog = z.infer<typeof schemas.IntegrationSyncLogSchema>;
export type TriggerSyncRequest = z.infer<typeof schemas.TriggerSyncRequestSchema>;
export type TriggerSyncResponse = z.infer<typeof schemas.TriggerSyncResponseSchema>;

// ============================================================================
// 2. 检验方案、工单、指标与实测 DTOs (含炉批号追溯与分类批量建方案)
// ============================================================================
export type InspectionType = z.infer<typeof schemas.InspectionTypeEnum>;
export type InspectionStatus = z.infer<typeof schemas.InspectionStatusEnum>;
export type OverallDecision = z.infer<typeof schemas.OverallDecisionEnum>;
export type DataType = z.infer<typeof schemas.DataTypeEnum>;
export type MetricCategory = z.infer<typeof schemas.MetricCategoryEnum>;
export type InspectionItemDecision = z.infer<typeof schemas.InspectionItemDecisionEnum>;
export type CertTemplate = z.infer<typeof schemas.CertTemplateEnum>;
export type CertFields = z.infer<typeof schemas.CertFieldsSchema>;

export type InspectionPlanItem = z.infer<typeof schemas.InspectionPlanItemSchema>;
export type PlanVersionStatus = z.infer<typeof schemas.PlanVersionStatusEnum>;
export type InspectionPlanVersion = z.infer<typeof schemas.InspectionPlanVersionSchema>;
export type InspectionPlan = z.infer<typeof schemas.InspectionPlanSchema>;
export type PlanStatus = z.infer<typeof schemas.PlanStatusEnum>;
export type PlanStats = z.infer<typeof schemas.PlanStatsSchema>;
export type ImportPlanCreated = z.infer<typeof schemas.ImportPlanCreatedSchema>;
export type ImportPlanSkipped = z.infer<typeof schemas.ImportPlanSkippedSchema>;
export type ImportPlanFailed = z.infer<typeof schemas.ImportPlanFailedSchema>;
export type ImportPlansResult = z.infer<typeof schemas.ImportPlansResultSchema>;
export type BatchCreateCategoryPlanRequest = z.infer<typeof schemas.BatchCreateCategoryPlanRequestSchema>;

export type InspectionItem = z.infer<typeof schemas.InspectionItemSchema>;
export type PlanSnapshot = z.infer<typeof schemas.PlanSnapshotSchema>;
export type InspectionPlanSnapshot = z.infer<typeof schemas.InspectionPlanSnapshotSchema>;
export type InspectionOrder = z.infer<typeof schemas.InspectionOrderSchema>;

export type CreateInspectionOrderRequest = z.infer<typeof schemas.CreateInspectionOrderRequestSchema>;
export type RecordInspectionItemRequest = z.infer<typeof schemas.RecordInspectionItemRequestSchema>;
export type BatchRecordInspectionItemsRequest = z.infer<typeof schemas.BatchRecordInspectionItemsRequestSchema>;
export type InspectionProgressOverview = z.infer<typeof schemas.InspectionProgressOverviewSchema>;
export type MandatoryGateCheckResponse = z.infer<typeof schemas.MandatoryGateCheckResponseSchema>;
export type FurnaceHeatTraceResponse = z.infer<typeof schemas.FurnaceHeatTraceResponseSchema>;
export type HeatTraceSourceType = z.infer<typeof schemas.HeatTraceSourceTypeEnum>;
export type HeatTraceAppliedSourceType = z.infer<typeof schemas.HeatTraceAppliedSourceTypeEnum>;
export type UpdateInspectionHeaderRequest = z.infer<typeof schemas.UpdateInspectionHeaderRequestSchema>;

// ============================================================================
// 3. 不合格品处置 (MRB)、待审核池与可配置审批流 DTOs
// ============================================================================
export type PendingDefectStatus = z.infer<typeof schemas.PendingDefectStatusEnum>;
export type PendingDefectItem = z.infer<typeof schemas.PendingDefectItemSchema>;
export type InitiateReviewRequest = z.infer<typeof schemas.InitiateReviewRequestSchema>;

export type MRBStatus = z.infer<typeof schemas.MRBStatusEnum>;
export type MRBDisposition = z.infer<typeof schemas.MRBDispositionEnum>;
export type MRBFailCategory = z.infer<typeof schemas.MRBFailCategoryEnum>;
export type MRBUrgencyLevel = z.infer<typeof schemas.MRBUrgencyLevelEnum>;
export type ReviewNodeStatus = z.infer<typeof schemas.ReviewNodeStatusEnum>;

export type ReviewStepConfig = z.infer<typeof schemas.ReviewStepConfigSchema>;
export type ReviewFlowNode = z.infer<typeof schemas.ReviewFlowNodeSchema>;
export type ReviewFlow = z.infer<typeof schemas.ReviewFlowSchema>;
export type MRBReviewNode = z.infer<typeof schemas.MRBReviewNodeSchema>;
export type MRBApproverAction = z.infer<typeof schemas.MRBApproverActionSchema>;
export type ConcessionSignOff = z.infer<typeof schemas.ConcessionSignOffSchema>;
export type MRBReview = z.infer<typeof schemas.MRBReviewSchema>;
export type DisposeMRBResponse = z.infer<typeof schemas.DisposeMRBResponseSchema>;

export type CreateMRBReviewRequest = z.infer<typeof schemas.CreateMRBReviewRequestSchema>;
export type SubmitNodeReviewRequest = z.infer<typeof schemas.SubmitNodeReviewRequestSchema>;
export type MRBDispositionDecisionRequest = z.infer<typeof schemas.MRBDispositionDecisionRequestSchema>;
export type MRBMetricsOverview = z.infer<typeof schemas.MRBMetricsOverviewSchema>;

// ============================================================================
// 4. 批次全生命周期追溯 (DAG 图谱) DTOs
// ============================================================================
export type ChainAnchorKind = z.infer<typeof schemas.ChainAnchorKindEnum>;
export type TransferGateCode = z.infer<typeof schemas.TransferGateCodeEnum>;
export type TransferPermitEvidence = z.infer<typeof schemas.TransferPermitEvidenceSchema>;
export type TransferDecision = z.infer<typeof schemas.TransferDecisionSchema>;
export type TransferPermitRequest = z.infer<typeof schemas.TransferPermitRequestSchema>;
export type TransferPermitItem = z.infer<typeof schemas.TransferPermitItemSchema>;
export type TransferPermitBatchRequest = z.infer<typeof schemas.TransferPermitBatchRequestSchema>;
export type TransferPermitBatchResponse = z.infer<typeof schemas.TransferPermitBatchResponseSchema>;

export type TraceRelationType = z.infer<typeof schemas.TraceRelationTypeEnum>;
export type TraceNodeStatus = z.infer<typeof schemas.TraceNodeStatusEnum>;
export type TraceNode = z.infer<typeof schemas.TraceNodeSchema>;
export type TraceEdge = z.infer<typeof schemas.TraceEdgeSchema>;
export type TraceabilityGraphResponse = z.infer<typeof schemas.TraceabilityGraphResponseSchema>;
export type TraceImpactSummary = z.infer<typeof schemas.TraceImpactSummarySchema>;
export type TraceBatchSummary = z.infer<typeof schemas.TraceBatchSummarySchema>;
export type TraceBatchSearchResponse = z.infer<typeof schemas.TraceBatchSearchResponseSchema>;
export type TraceOrderChainStage = z.infer<typeof schemas.TraceOrderChainStageSchema>;
export type TraceOrderChainResponse = z.infer<typeof schemas.TraceOrderChainResponseSchema>;

// ============================================================================
// 5. 基于属性的数据权限控制 (PBAC) DTOs
// ============================================================================
export type MaterialPermission = z.infer<typeof schemas.MaterialPermissionSchema>;
export type UpdateMaterialPermissionRequest = z.infer<typeof schemas.UpdateMaterialPermissionRequestSchema>;

// ============================================================================
// 5.5 权限管理体系 DTOs（角色字典 / 校验日志 / 规则 CRUD / 校验工具 / 登录）
// ============================================================================
export type Role = z.infer<typeof schemas.RoleSchema>;
export type AuthorizationDecision = z.infer<typeof schemas.AuthorizationDecisionEnum>;
export type AuthorizationLog = z.infer<typeof schemas.AuthorizationLogSchema>;
export type PermissionLogListResponse = z.infer<typeof schemas.PermissionLogListResponseSchema>;
export type MaterialPermissionListResponse = z.infer<typeof schemas.MaterialPermissionListResponseSchema>;
export type CreatePermissionRequest = z.infer<typeof schemas.CreatePermissionRequestSchema>;
export type ApplyRolePermissionRequest = z.infer<typeof schemas.ApplyRolePermissionRequestSchema>;
export type PermissionCheckRequest = z.infer<typeof schemas.PermissionCheckRequestSchema>;
export type PermissionCheckResponse = z.infer<typeof schemas.PermissionCheckResponseSchema>;
export type AuthUser = z.infer<typeof schemas.AuthUserSchema>;
export type LoginRequest = z.infer<typeof schemas.LoginRequestSchema>;
export type LoginResponse = z.infer<typeof schemas.LoginResponseSchema>;

// ============================================================================
// 6. 质检报告打印与多模板引擎 DTOs
// ============================================================================
export type ReportSection = z.infer<typeof schemas.ReportSectionEnum>;
export type ReportItemDecision = z.infer<typeof schemas.ReportItemDecisionEnum>;
export type ReportTemplateScope = z.infer<typeof schemas.ReportTemplateScopeEnum>;
export type QualityReportTemplate = z.infer<typeof schemas.QualityReportTemplateSchema>;
export type AppearanceSectionItem = z.infer<typeof schemas.AppearanceSectionItemSchema>;
export type DimensionSectionItem = z.infer<typeof schemas.DimensionSectionItemSchema>;
export type MechanicalSectionItem = z.infer<typeof schemas.MechanicalSectionItemSchema>;
export type ChemicalElementItem = z.infer<typeof schemas.ChemicalElementItemSchema>;
export type QualityReportData = z.infer<typeof schemas.QualityReportDataSchema>;
export type GenerateReportRequest = z.infer<typeof schemas.GenerateReportRequestSchema>;
export type BatchExportReportRequest = z.infer<typeof schemas.BatchExportReportRequestSchema>;

// ============================================================================
// 7. 高级通用查询 DSL DTOs
// ============================================================================
export type FilterOperator = z.infer<typeof schemas.FilterOperatorEnum>;
export type FilterCondition = z.infer<typeof schemas.FilterConditionSchema>;
export type AdvancedQueryDsl = z.infer<typeof schemas.AdvancedQueryDslSchema>;

// ============================================================================
// 8. 不可变操作审计与度量统计 DTOs
// ============================================================================
export type AuditAction = z.infer<typeof schemas.AuditActionEnum>;
export type AuditStatus = z.infer<typeof schemas.AuditStatusEnum>;
export type AuditLog = z.infer<typeof schemas.AuditLogSchema>;
export type AuditStatsResponse = z.infer<typeof schemas.AuditStatsResponseSchema>;

// ============================================================================
// 9. RFC 7807 统一错误模型与 Outbox 事件 DTOs
// ============================================================================
export type InvalidParamDetail = z.infer<typeof schemas.InvalidParamDetailSchema>;
export type ProblemDetails = z.infer<typeof schemas.ProblemDetailsSchema>;
export type OutboxStatus = z.infer<typeof schemas.OutboxStatusEnum>;
export type OutboxEvent = z.infer<typeof schemas.OutboxEventSchema>;

// 前端页面别名兼容
export type MrbReviewRecord = MRBReview;
export type BatchTraceNode = TraceNode;
export type ChainStageState = z.infer<typeof schemas.ChainStageStateEnum>;
export type ChainStatusBlockedBy = z.infer<typeof schemas.ChainStatusBlockedBySchema>;
export type ChainStatusStage = z.infer<typeof schemas.ChainStatusStageSchema>;
export type ChainStatusSummary = z.infer<typeof schemas.ChainStatusSummarySchema>;
export type ChainStatusResponse = z.infer<typeof schemas.ChainStatusResponseSchema>;
