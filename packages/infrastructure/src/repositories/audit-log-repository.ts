import { Kysely } from 'kysely';
import type { AuditLogRepository as IAuditLogDomainRepository } from '@letian/domain';
import type { IAuditLogRepository } from '@letian/application';
import type { AuditAction, AuditLog, AuditStatus } from '@letian/contracts';
import type { AuditLogInsert, AuditLogRow, Database } from '../database/schema.js';

const DEFAULT_QUERY_LIMIT = 50;
const DEFAULT_QUERY_OFFSET = 0;

/** 契约 AuditActionEnum 的 8 个合法取值 */
const AUDIT_ACTIONS: readonly string[] = [
  'CREATE',
  'UPDATE',
  'STATUS_CHANGE',
  'DISPOSE',
  'GATE_BLOCKED',
  'AUTH_FAILED',
  'VALIDATION_REJECTED',
  'SYNC_TRIGGER',
];

/** 契约 AuditStatusEnum 的 3 个合法取值 */
const AUDIT_STATUSES: readonly string[] = ['SUCCESS', 'REJECTED', 'FAILED'];

function toAuditAction(value: string): AuditAction {
  if (!AUDIT_ACTIONS.includes(value)) {
    throw new Error(`AUDIT_ACTION_INVALID: 审计日志表中出现非法动作值 [${value}]`);
  }
  return value as AuditAction;
}

function toAuditStatus(value: string): AuditStatus {
  if (!AUDIT_STATUSES.includes(value)) {
    throw new Error(`AUDIT_STATUS_INVALID: 审计日志表中出现非法状态值 [${value}]`);
  }
  return value as AuditStatus;
}

/**
 * 审计日志仓储 (Kysely + PostgreSQL)
 *
 * 同时实现领域端口 AuditLogRepository 与应用端口 IAuditLogRepository。
 * 表是 append-only：本类不提供任何 UPDATE / DELETE。
 * client_ip / user_agent 由 API 层从 HTTP 上下文采集，不属于契约 DTO，
 * 因此这里一律写 NULL，不做任何写入。
 */
export class KyselyAuditLogRepository implements IAuditLogDomainRepository, IAuditLogRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** 领域端口：追加一条审计流水 */
  public async append(log: AuditLog): Promise<void> {
    await this.insert(log);
  }

  /** 应用端口：追加一条审计流水（与 append 同语义） */
  public async insert(auditLog: AuditLog): Promise<void> {
    const insertValues: AuditLogInsert = {
      entityName: auditLog.resourceType,
      entityId: auditLog.resourceId,
      action: auditLog.action,
      operatorId: auditLog.userId,
      operatorName: auditLog.userName,
      diffPatch: JSON.stringify(auditLog.diffPatch ?? {}),
      traceId: auditLog.traceId,
      status: auditLog.status ?? 'SUCCESS',
      occurredAt: new Date(auditLog.createdAt),
      ...(auditLog.id !== undefined ? { id: auditLog.id } : {}),
    };

    await this.db.insertInto('auditLogs').values(insertValues).execute();
  }

  /** 领域端口：按目标资源 / 操作人查询 */
  public async query(params: {
    targetType?: string;
    targetId?: string;
    operatorId?: string;
    limit?: number;
  }): Promise<readonly AuditLog[]> {
    let query = this.db.selectFrom('auditLogs').selectAll().orderBy('occurredAt', 'desc');

    if (params.targetType !== undefined) {
      query = query.where('entityName', '=', params.targetType);
    }
    if (params.targetId !== undefined) {
      query = query.where('entityId', '=', params.targetId);
    }
    if (params.operatorId !== undefined) {
      query = query.where('operatorId', '=', params.operatorId);
    }
    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }

    const rows = await query.execute();
    return rows.map((row) => this.mapRow(row));
  }

  /** 应用端口：带分页与总数的查询 */
  public async queryLogs(params: {
    resourceType?: string;
    resourceId?: string;
    action?: string;
    status?: string;
    userId?: string;
    startTime?: string;
    endTime?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: AuditLog[]; total: number }> {
    const startTime = params.startTime !== undefined ? new Date(params.startTime) : undefined;
    const endTime = params.endTime !== undefined ? new Date(params.endTime) : undefined;

    let query = this.db.selectFrom('auditLogs').selectAll().orderBy('occurredAt', 'desc');
    let countQuery = this.db.selectFrom('auditLogs').select((eb) => eb.fn.countAll().as('total'));

    if (params.resourceType !== undefined) {
      query = query.where('entityName', '=', params.resourceType);
      countQuery = countQuery.where('entityName', '=', params.resourceType);
    }
    if (params.resourceId !== undefined) {
      query = query.where('entityId', '=', params.resourceId);
      countQuery = countQuery.where('entityId', '=', params.resourceId);
    }
    if (params.action !== undefined) {
      query = query.where('action', '=', params.action);
      countQuery = countQuery.where('action', '=', params.action);
    }
    if (params.status !== undefined) {
      query = query.where('status', '=', params.status);
      countQuery = countQuery.where('status', '=', params.status);
    }
    if (params.userId !== undefined) {
      query = query.where('operatorId', '=', params.userId);
      countQuery = countQuery.where('operatorId', '=', params.userId);
    }
    if (startTime !== undefined) {
      query = query.where('occurredAt', '>=', startTime);
      countQuery = countQuery.where('occurredAt', '>=', startTime);
    }
    if (endTime !== undefined) {
      query = query.where('occurredAt', '<=', endTime);
      countQuery = countQuery.where('occurredAt', '<=', endTime);
    }

    const rows = await query
      .limit(params.limit ?? DEFAULT_QUERY_LIMIT)
      .offset(params.offset ?? DEFAULT_QUERY_OFFSET)
      .execute();

    const countRow = await countQuery.executeTakeFirst();
    // count(*) 在 pg 中返回 bigint，node-postgres 读成字符串，必须显式转 number
    const total = countRow ? Number(countRow.total) : 0;

    return { items: rows.map((row) => this.mapRow(row)), total };
  }

  /**
   * 读侧投影：审计统计卡片（契约 AuditStatsResponse）
   *
   * failedCount 口径：审计状态非 SUCCESS 的记录数（含 REJECTED 拦截与 FAILED 失败）。
   * todayCount 以数据库会话时区的当日 00:00 为界，与 occurred_at 的写入口径一致。
   */
  public async getStats(): Promise<{
    totalLogs: number;
    successCount: number;
    failedCount: number;
    todayCount: number;
  }> {
    const totalRow = await this.db
      .selectFrom('auditLogs')
      .select((eb) => eb.fn.countAll().as('total'))
      .executeTakeFirst();

    const statusRows = await this.db
      .selectFrom('auditLogs')
      .select((eb) => ['status', eb.fn.countAll().as('count')])
      .groupBy('status')
      .execute();

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayRow = await this.db
      .selectFrom('auditLogs')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('occurredAt', '>=', todayStart)
      .executeTakeFirst();

    let successCount = 0;
    let failedCount = 0;
    for (const row of statusRows) {
      const count = Number(row.count);
      if (row.status === 'SUCCESS') {
        successCount += count;
      } else {
        failedCount += count;
      }
    }

    return {
      totalLogs: totalRow ? Number(totalRow.total) : 0,
      successCount,
      failedCount,
      todayCount: todayRow ? Number(todayRow.total) : 0,
    };
  }

  private mapRow(row: AuditLogRow): AuditLog {
    return {
      id: row.id,
      traceId: row.traceId,
      userId: row.operatorId,
      userName: row.operatorName,
      resourceType: row.entityName,
      resourceId: row.entityId,
      action: toAuditAction(row.action),
      status: toAuditStatus(row.status),
      diffPatch: row.diffPatch,
      createdAt: row.occurredAt.toISOString(),
    };
  }
}
