import type { Kysely } from 'kysely';
import type { AuthorizationDecision, AuthorizationLog } from '@letian/contracts';
import type { AuthorizationLogInsert, AuthorizationLogRow, Database } from '../database/schema.js';

/** 权限校验日志追加参数（id 与 createdAt 由数据库生成） */
export interface AuthorizationLogAppendInput {
  userId: string;
  userName: string;
  roleCode?: string | undefined;
  resourceType: string;
  resourceId?: string | undefined;
  materialCode?: string | undefined;
  materialCategory?: string | undefined;
  supplierCode?: string | undefined;
  action: string;
  decision: AuthorizationDecision;
  matchedRuleId?: string | undefined;
  detail?: string | undefined;
}

/** 权限校验日志分页查询条件 */
export interface AuthorizationLogQuery {
  userId?: string;
  decision?: AuthorizationDecision;
  resourceType?: string;
  page: number;
  pageSize: number;
}

/** 权限校验日志分页结果 */
export interface AuthorizationLogListResult {
  total: number;
  items: AuthorizationLog[];
  list: AuthorizationLog[];
}

/**
 * 权限校验日志仓储 (Kysely + PostgreSQL)
 *
 * PRD 要求：记录每次敏感数据查询时的行级过滤与拦截情况，
 * authorization_logs 只增不改，保留周期至少 180 天。
 */
export class KyselyAuthorizationLogRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** 追加一条校验日志（fire-and-forget 调用方自行 catch，不阻塞业务响应） */
  public async append(input: AuthorizationLogAppendInput): Promise<void> {
    const values: AuthorizationLogInsert = {
      userId: input.userId,
      userName: input.userName,
      roleCode: input.roleCode ?? null,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      materialCode: input.materialCode ?? null,
      materialCategory: input.materialCategory ?? null,
      supplierCode: input.supplierCode ?? null,
      action: input.action,
      decision: input.decision,
      matchedRuleId: input.matchedRuleId ?? null,
      detail: input.detail ?? null,
    };

    await this.db.insertInto('authorizationLogs').values(values).execute();
  }

  /**
   * 分批删除超过保留期的权限校验日志。
   * 注意：这里只清理 authorization_logs；audit_logs 由数据库触发器保证 append-only，
   * 任何业务/后台任务都不能物理删除。
   */
  public async purgeOlderThan(cutoff: Date, limit = 1000): Promise<number> {
    const rows = await this.db
      .selectFrom('authorizationLogs')
      .select('id')
      .where('createdAt', '<', cutoff)
      .orderBy('createdAt', 'asc')
      .limit(limit)
      .execute();

    const ids = rows.map((row) => row.id);
    if (ids.length === 0) {
      return 0;
    }

    const result = await this.db
      .deleteFrom('authorizationLogs')
      .where('id', 'in', ids)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  }

  /** 分页查询校验日志（别名兼容） */
  public async listLogs(query: AuthorizationLogQuery): Promise<AuthorizationLogListResult> {
    return this.queryList(query);
  }

  /** 分页查询校验日志（倒序） */
  public async queryList(query: AuthorizationLogQuery): Promise<AuthorizationLogListResult> {
    let listQuery = this.db.selectFrom('authorizationLogs').selectAll();
    let countQuery = this.db.selectFrom('authorizationLogs').select((eb) => eb.fn.countAll().as('total'));

    if (query.userId !== undefined) {
      listQuery = listQuery.where('userId', '=', query.userId);
      countQuery = countQuery.where('userId', '=', query.userId);
    }
    if (query.decision !== undefined) {
      listQuery = listQuery.where('decision', '=', query.decision);
      countQuery = countQuery.where('decision', '=', query.decision);
    }
    if (query.resourceType !== undefined) {
      listQuery = listQuery.where('resourceType', '=', query.resourceType);
      countQuery = countQuery.where('resourceType', '=', query.resourceType);
    }

    const rows = await listQuery
      .orderBy('createdAt', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();

    const countRow = await countQuery.executeTakeFirst();
    const items = rows.map((row) => this.mapRow(row));
    return {
      total: countRow ? Number(countRow.total) : 0,
      items,
      list: items,
    };
  }

  private mapRow(row: AuthorizationLogRow): AuthorizationLog {
    return {
      id: row.id,
      userId: row.userId,
      userName: row.userName,
      resourceType: row.resourceType,
      action: row.action,
      decision: row.decision,
      createdAt: row.createdAt.toISOString(),
      // 可空列一律用条件展开省略，绝不写入 undefined
      ...(row.roleCode !== null ? { roleCode: row.roleCode } : {}),
      ...(row.resourceId !== null ? { resourceId: row.resourceId } : {}),
      ...(row.materialCode !== null ? { materialCode: row.materialCode } : {}),
      ...(row.materialCategory !== null ? { materialCategory: row.materialCategory } : {}),
      ...(row.supplierCode !== null ? { supplierCode: row.supplierCode } : {}),
      ...(row.matchedRuleId !== null ? { matchedRuleId: row.matchedRuleId } : {}),
      ...(row.detail !== null ? { detail: row.detail } : {}),
    };
  }
}
