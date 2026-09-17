import { z } from 'zod';
import * as schemas from '../schemas';

// ============================================================================
// 1. 基础主数据与集成 DTOs (ERP / MES)
// ============================================================================
export type Material = z.infer<typeof schemas.MaterialSchema>;
export type InventoryCategory = z.infer<typeof schemas.InventoryCategorySchema>;
export type Supplier = z.infer<typeof schemas.SupplierSchema>;
export type Customer = z.infer<typeof schemas.CustomerSchema>;
export type Workshop = z.infer<typeof schemas.WorkshopSchema>;
export type Employee = z.infer<typeof schemas.EmployeeSchema>;

export type SystemType = z.infer<typeof schemas.SystemTypeEnum>;
export type IntegrationConfig = z.infer<typeof schemas.IntegrationConfigSchema>;
export type SyncDirection = z.infer<typeof schemas.SyncDirectionEnum>;
export type SyncStatus = z.infer<typeof schemas.SyncStatusEnum>;
export type IntegrationSyncLog = z.infer<typeof schemas.IntegrationSyncLogSchema>;
export type TriggerSyncRequest = z.infer<typeof schemas.TriggerSyncRequestSchema>;
export type TriggerSyncResponse = z.infer<typeof schemas.TriggerSyncResponseSchema>;

// ============================================================================
// 2. 检验方案、工单、指标与实测 DTOs
// ============================================================================
export type InspectionType = z.infer<typeof schemas.InspectionTypeEnum>;
export type InspectionStatus = z.infer<typeof schemas.InspectionStatusEnum>;
export type OverallDecision = z.infer<typeof schemas.OverallDecisionEnum>;
export type DataType = z.infer<typeof schemas.DataTypeEnum>;
export type MetricCategory = z.infer<typeof schemas.MetricCategoryEnum>;
export type InspectionItemDecision = z.infer<typeof schemas.InspectionItemDecisionEnum>;

export type InspectionPlanItem = z.infer<typeof schemas.InspectionPlanItemSchema>;
export type PlanVersionStatus = z.infer<typeof schemas.PlanVersionStatusEnum>;
export type InspectionPlanVersion = z.infer<typeof schemas.InspectionPlanVersionSchema>;
export type InspectionPlan = z.infer<typeof schemas.InspectionPlanSchema>;

export type InspectionItem = z.infer<typeof schemas.InspectionItemSchema>;
export type PlanSnapshot = z.infer<typeof schemas.PlanSnapshotSchema>;
export type InspectionPlanSnapshot = z.infer<typeof schemas.InspectionPlanSnapshotSchema>;
export type InspectionOrder = z.infer<typeof schemas.InspectionOrderSchema>;

export type CreateInspectionOrderRequest = z.infer<typeof schemas.CreateInspectionOrderRequestSchema>;
export type RecordInspectionItemRequest = z.infer<typeof schemas.RecordInspectionItemRequestSchema>;
export type BatchRecordInspectionItemsRequest = z.infer<typeof schemas.BatchRecordInspectionItemsRequestSchema>;
export type InspectionProgressOverview = z.infer<typeof schemas.InspectionProgressOverviewSchema>;
export type MandatoryGateCheckResponse = z.infer<typeof schemas.MandatoryGateCheckResponseSchema>;

// ============================================================================
// 3. 不合格品处置 (MRB) 与可配置审批流 DTOs
// ============================================================================
export type MRBStatus = z.infer<typeof schemas.MRBStatusEnum>;
export type MRBDisposition = z.infer<typeof schemas.MRBDispositionEnum>;
export type MRBFailCategory = z.infer<typeof schemas.MRBFailCategoryEnum>;
export type ReviewNodeStatus = z.infer<typeof schemas.ReviewNodeStatusEnum>;

export type ReviewStepConfig = z.infer<typeof schemas.ReviewStepConfigSchema>;
export type ReviewFlowNode = z.infer<typeof schemas.ReviewFlowNodeSchema>;
export type ReviewFlow = z.infer<typeof schemas.ReviewFlowSchema>;
export type MRBReviewNode = z.infer<typeof schemas.MRBReviewNodeSchema>;
export type MRBApproverAction = z.infer<typeof schemas.MRBApproverActionSchema>;
export type ConcessionSignOff = z.infer<typeof schemas.ConcessionSignOffSchema>;
export type MRBReview = z.infer<typeof schemas.MRBReviewSchema>;

export type CreateMRBReviewRequest = z.infer<typeof schemas.CreateMRBReviewRequestSchema>;
export type SubmitNodeReviewRequest = z.infer<typeof schemas.SubmitNodeReviewRequestSchema>;
export type MRBDispositionDecisionRequest = z.infer<typeof schemas.MRBDispositionDecisionRequestSchema>;
export type MRBMetricsOverview = z.infer<typeof schemas.MRBMetricsOverviewSchema>;

// ============================================================================
// 4. 批次全生命周期追溯 (DAG 图谱) DTOs
// ============================================================================
export type TraceRelationType = z.infer<typeof schemas.TraceRelationTypeEnum>;
export type TraceNodeStatus = z.infer<typeof schemas.TraceNodeStatusEnum>;
export type TraceNode = z.infer<typeof schemas.TraceNodeSchema>;
export type TraceEdge = z.infer<typeof schemas.TraceEdgeSchema>;
export type TraceabilityGraphResponse = z.infer<typeof schemas.TraceabilityGraphResponseSchema>;

// ============================================================================
// 5. 基于属性的数据权限控制 (PBAC) DTOs
// ============================================================================
export type MaterialPermission = z.infer<typeof schemas.MaterialPermissionSchema>;
export type UpdateMaterialPermissionRequest = z.infer<typeof schemas.UpdateMaterialPermissionRequestSchema>;

// ============================================================================
// 6. 不可变操作审计与度量统计 DTOs
// ============================================================================
export type AuditAction = z.infer<typeof schemas.AuditActionEnum>;
export type AuditStatus = z.infer<typeof schemas.AuditStatusEnum>;
export type AuditLog = z.infer<typeof schemas.AuditLogSchema>;
export type AuditStatsResponse = z.infer<typeof schemas.AuditStatsResponseSchema>;

// ============================================================================
// 7. RFC 7807 统一错误模型与 Outbox 事件 DTOs
// ============================================================================
export type InvalidParamDetail = z.infer<typeof schemas.InvalidParamDetailSchema>;
export type ProblemDetails = z.infer<typeof schemas.ProblemDetailsSchema>;
export type OutboxStatus = z.infer<typeof schemas.OutboxStatusEnum>;
export type OutboxEvent = z.infer<typeof schemas.OutboxEventSchema>;

// 前端页面别名兼容
export type MrbReviewRecord = MRBReview;
export type BatchTraceNode = TraceNode;

