import type {
  InspectionPlanRepository,
  InspectionOrderRepository,
  MRBReviewRepository,
  BatchTraceRepository,
  ReviewFlowRepository,
} from '@letian/domain';
import type { IOutboxRepository } from './outbox.js';
import type { ILockPort } from './lock-port.js';
import type { AuditLog, Material, MaterialPermission } from '@letian/contracts';

/**
 * 物料主数据只读查询端口：PBAC 三维校验需要把物料编码解析为真实分类编码
 */
export interface IMaterialLookupPort {
  getMaterialByCode(materialCode: string): Promise<Material | null>;
  getMaterialByName(materialName: string): Promise<Material | null>;
}

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
  /** 用户在全部角色下的生效规则（一人多角色多条规则，评估为 OR 语义） */
  findByUserId(userId: string): Promise<readonly MaterialPermission[]>;
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
  /** 物料主数据只读查询（PBAC 校验解析物料分类） */
  readonly materials: IMaterialLookupPort;
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
