import { Kysely, sql, Transaction } from 'kysely';
import type { IUnitOfWork, IUnitOfWorkContext, ILockPort } from '@letian/application';
import type { Database } from '../database/schema.js';
import { KyselyInspectionPlanRepository } from '../repositories/inspection-plan-repository.js';
import { KyselyInspectionOrderRepository } from '../repositories/inspection-order-repository.js';
import { KyselyMRBReviewRepository } from '../repositories/mrb-review-repository.js';
import { KyselyPendingDefectPoolRepository } from '../repositories/pending-defect-pool-repository.js';
import { KyselyReviewFlowRepository } from '../repositories/review-flow-repository.js';
import { KyselyBatchTraceRepository } from '../repositories/batch-trace-repository.js';
import { KyselyOutboxRepository } from '../repositories/outbox-repository.js';
import { KyselyAuditLogRepository } from '../repositories/audit-log-repository.js';
import { KyselyMaterialPermissionRepository } from '../repositories/material-permission-repository.js';
import { KyselyMasterDataRepository } from '../repositories/master-data-repository.js';
import { KyselyTransferOverrideRepository } from '../repositories/transfer-override-repository.js';

/**
 * PostgreSQL 事务级咨询锁实现
 *
 * 使用 pg_advisory_xact_lock 语义：锁由数据库绑定在当前事务生命周期上，
 * 事务 COMMIT/ROLLBACK 时自动释放，不需要（也无法）手动 unlock，
 * 因此不会因为业务异常路径漏解锁而留下悬挂锁。
 */
export class PostgresAdvisoryLockPort implements ILockPort {
  constructor(private readonly executor: Kysely<Database> | Transaction<Database>) {}

  public async acquireXactLock(lockKey: string): Promise<void> {
    // hashtext 返回 int4，会自动隐式转换为 pg_advisory_xact_lock(bigint) 所需的 int8
    await sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`.execute(this.executor);
  }

  public async acquireXactLock2(classId: number, objId: number): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(${classId}, ${objId})`.execute(this.executor);
  }
}

/**
 * 基于 Kysely 事务的工作单元 (Unit of Work)
 *
 * 一次 execute() = 一个 PostgreSQL 事务；若传入已有事务，则复用该事务：
 * - 事务内构造的全部仓储共享同一个 Transaction 连接，因此读到的都是本事务未提交的写入；
 * - 业务回调抛异常时整个事务回滚（仓储写入、Outbox、审计一并撤销）；
 * - 咨询锁随事务结束自动释放。
 */
export class KyselyUnitOfWork implements IUnitOfWork {
  constructor(private readonly db: Kysely<Database> | Transaction<Database>) {}

  public async execute<T>(work: (ctx: IUnitOfWorkContext) => Promise<T>): Promise<T> {
    if (this.db instanceof Transaction) return work(this.createContext(this.db));
    return this.db.transaction().execute((trx) => work(this.createContext(trx)));
  }

  private createContext(trx: Transaction<Database>): IUnitOfWorkContext {
    return {
      inspectionPlans: new KyselyInspectionPlanRepository(trx),
      inspectionOrders: new KyselyInspectionOrderRepository(trx),
      mrbReviews: new KyselyMRBReviewRepository(trx),
      pendingDefects: new KyselyPendingDefectPoolRepository(trx),
      reviewFlows: new KyselyReviewFlowRepository(trx),
      traceDags: new KyselyBatchTraceRepository(trx),
      outbox: new KyselyOutboxRepository(trx),
      locks: new PostgresAdvisoryLockPort(trx),
      auditLogs: new KyselyAuditLogRepository(trx),
      permissions: new KyselyMaterialPermissionRepository(trx),
      materials: new KyselyMasterDataRepository(trx),
      suppliers: new KyselyMasterDataRepository(trx),
      transferOverrides: new KyselyTransferOverrideRepository(trx),
    };
  }
}

export function createUnitOfWork(db: Kysely<Database> | Transaction<Database>): IUnitOfWork {
  return new KyselyUnitOfWork(db);
}
