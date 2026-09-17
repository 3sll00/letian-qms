import type {
  InspectionPlanRepository,
  InspectionOrderRepository,
  MRBReviewRepository,
  BatchTraceRepository,
  ReviewFlowRepository,
} from '@letian/domain';
import type { IOutboxRepository } from './outbox.js';
import type { ILockPort } from './lock-port.js';
import type { AuditLog, MaterialPermission } from '@letian/contracts';

/**
 * 审计日志仓储接口 (写入不可变审计记录)
 */
export interface IAuditLogRepository {
  insert(auditLog: AuditLog): Promise<void>;
  queryLogs(params: {
    resourceType?: string;
    resourceId?: string;
    action?: string;
    userId?: string;
    startTime?: string;
    endTime?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: AuditLog[]; total: number }>;
}

/**
 * PBAC 数据权限规则仓储接口
 */
export interface IMaterialPermissionRepository {
  findByUserId(userId: string): Promise<MaterialPermission | null>;
  save(permission: MaterialPermission): Promise<void>;
  listAllActive(): Promise<MaterialPermission[]>;
}

/**
 * Unit of Work 事务工作单元上下文
 * 在一个事务内包裹所有 Repository 与基础设施端口
 */
export interface IUnitOfWorkContext {
  readonly inspectionPlans: InspectionPlanRepository;
  readonly inspectionOrders: InspectionOrderRepository;
  readonly mrbReviews: MRBReviewRepository;
  readonly reviewFlows: ReviewFlowRepository;
  readonly traceDags: BatchTraceRepository;
  readonly outbox: IOutboxRepository;
  readonly locks: ILockPort;
  readonly auditLogs: IAuditLogRepository;
  readonly permissions: IMaterialPermissionRepository;
}

/**
 * Unit of Work 管理器
 */
export interface IUnitOfWork {
  /**
   * 在统一事务边界内执行业务逻辑
   * 自动支持 pg_advisory_xact_lock、仓储变更、Outbox 写入、不可变审计日志
   */
  execute<T>(work: (ctx: IUnitOfWorkContext) => Promise<T>): Promise<T>;
}
