import {
  InspectionOrder,
  InspectionPlan,
  ReviewFlow,
  MRBReview,
  MaterialPermission,
  AuditLog,
  TraceNode,
  TraceEdge,
} from '@letian/contracts';

/**
 * 质检方案仓储端口
 */
export interface InspectionPlanRepository {
  findById(id: string): Promise<InspectionPlan | null>;
  findActivePlan(materialCode: string, inspectionType: string): Promise<InspectionPlan | null>;
  save(plan: InspectionPlan): Promise<void>;
}

/**
 * 检验工单仓储端口
 */
export interface InspectionOrderRepository {
  findById(id: string): Promise<InspectionOrder | null>;
  findByOrderNo(orderNo: string): Promise<InspectionOrder | null>;
  findByBatchNo(batchNo: string): Promise<readonly InspectionOrder[]>;
  save(order: InspectionOrder): Promise<void>;
  updateStatus(id: string, status: string, remark?: string): Promise<void>;
}

/**
 * MRB 评审单仓储端口
 */
export interface MRBReviewRepository {
  findById(id: string): Promise<MRBReview | null>;
  findByReviewNo(reviewNo: string): Promise<MRBReview | null>;
  findByOrderNo(orderNo: string): Promise<MRBReview | null>;
  save(review: MRBReview): Promise<void>;
}

/**
 * 评审流定义仓储端口
 */
export interface ReviewFlowRepository {
  findApplicableFlow(failCategory: string): Promise<ReviewFlow | null>;
  save(flow: ReviewFlow): Promise<void>;
}

/**
 * PBAC 数据权限仓储端口
 */
export interface PBACPermissionRepository {
  findPermissionsByRole(roleCode: string): Promise<readonly MaterialPermission[]>;
  findPermissionsByRoles(roleCodes: readonly string[]): Promise<readonly MaterialPermission[]>;
}

/**
 * 审计日志仓储端口（只增不改）
 */
export interface AuditLogRepository {
  append(log: AuditLog): Promise<void>;
  query(params: {
    targetType?: string;
    targetId?: string;
    operatorId?: string;
    limit?: number;
  }): Promise<readonly AuditLog[]>;
}

/**
 * 批次追溯图拓扑仓储端口
 */
export interface BatchTraceRepository {
  findNode(batchNo: string): Promise<TraceNode | null>;
  findEdges(batchNo: string, direction: 'UPSTREAM' | 'DOWNSTREAM' | 'BOTH'): Promise<readonly TraceEdge[]>;
  saveNode(node: TraceNode): Promise<void>;
  saveEdge(edge: TraceEdge): Promise<void>;
}
