import { type Kysely } from 'kysely';
import type {
  IntegrationConfig,
  IntegrationSyncLog,
  SyncDirection,
  SyncStatus,
  SystemType,
} from '@letian/contracts';
import type {
  Database,
  IntegrationConfigRow,
  IntegrationSyncLogRow,
} from '../database/schema.js';

/**
 * MES/ERP 集成配置与同步流水仓储 (Kysely + PostgreSQL)
 *
 * 表 integration_configs / integration_sync_logs 在领域层没有对应端口
 * （集成配置是运维配置而非领域聚合），因此本类只被 API 层直接使用。
 *
 * 敏感字段策略：auth_secret 落库，但读取时不返回给调用方（IntegrationConfig.authToken 一律省略），
 * 仅允许通过 upsertConfig 写入，避免 GET 接口把密钥回显到浏览器或审计日志里。
 */

/** 同步流水列表查询结果 */
export interface SyncLogListResult {
  total: number;
  items: IntegrationSyncLog[];
}

const SYSTEM_TYPES: readonly string[] = ['MES', 'ERP'];
/** DB 中 system_name 为 NOT NULL，但契约 DTO 没有该字段，插入时按系统类型给出固定名称 */
const SYSTEM_NAMES: Record<SystemType, string> = {
  MES: '制造执行系统',
  ERP: '企业资源计划系统',
};

function toSystemType(value: string): SystemType {
  if (!SYSTEM_TYPES.includes(value)) {
    throw new Error(`SYSTEM_TYPE_INVALID: 非法的外部系统类型 [${value}]`);
  }
  return value as SystemType;
}

export class KyselyIntegrationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** 读取全部集成配置（不含密钥） */
  public async listConfigs(): Promise<IntegrationConfig[]> {
    const rows = await this.db
      .selectFrom('integrationConfigs')
      .selectAll()
      .orderBy('systemCode', 'asc')
      .execute();

    return rows.map((row) => this.mapConfig(row));
  }

  /** 按外部系统类型读取配置（不含密钥） */
  public async findConfig(systemType: string): Promise<IntegrationConfig | null> {
    const row = await this.db
      .selectFrom('integrationConfigs')
      .selectAll()
      .where('systemCode', '=', toSystemType(systemType))
      .executeTakeFirst();

    return row ? this.mapConfig(row) : null;
  }

  /**
   * 新增或更新集成配置（按 system_code 唯一约束 UPSERT）
   *
   * authToken 缺省时保持库中既有密钥不变——前端回显的是脱敏值，
   * 若把脱敏值当新密钥写回，会把真实密钥覆盖成占位符。
   */
  public async upsertConfig(config: IntegrationConfig, systemName?: string): Promise<void> {
    const now = new Date();
    const systemType = config.systemType;

    await this.db
      .insertInto('integrationConfigs')
      .values({
        systemCode: systemType,
        systemName: systemName ?? SYSTEM_NAMES[systemType],
        baseUrl: config.serviceUrl,
        authSecret: config.authToken ?? null,
        isEnabled: config.enabled,
        syncSchedule: config.cronSchedule,
        subscribedWorkshops: JSON.stringify(config.subscribedWorkshops),
        subscribedProcesses: JSON.stringify(config.subscribedProcesses),
        updatedAt: now,
        ...(config.id !== undefined ? { id: config.id } : {}),
      })
      .onConflict((oc) =>
        oc.column('systemCode').doUpdateSet({
          baseUrl: config.serviceUrl,
          isEnabled: config.enabled,
          syncSchedule: config.cronSchedule,
          subscribedWorkshops: JSON.stringify(config.subscribedWorkshops),
          subscribedProcesses: JSON.stringify(config.subscribedProcesses),
          updatedAt: now,
          // 密钥仅在显式传入时覆盖
          ...(config.authToken !== undefined ? { authSecret: config.authToken } : {}),
        })
      )
      .execute();
  }

  /** 写入一条同步流水 */
  public async appendSyncLog(log: IntegrationSyncLog, taskName: string): Promise<void> {
    await this.db
      .insertInto('integrationSyncLogs')
      .values({
        systemCode: log.systemType,
        // task_name 列宽 VARCHAR(64)，防御性截断防 22001
        taskName: taskName.slice(0, 64),
        status: log.status,
        recordsProcessed: log.recordsCount,
        errorMessage: log.errorDetails ?? null,
        batchNo: log.batchNo,
        syncDirection: log.syncDirection,
        createdAt: log.createdAt !== undefined ? new Date(log.createdAt) : new Date(),
        ...(log.id !== undefined ? { id: log.id } : {}),
      })
      .execute();
  }

  /** 同步流水分页查询（按发生时间倒序） */
  public async listSyncLogs(query: {
    systemType?: string;
    page: number;
    pageSize: number;
  }): Promise<SyncLogListResult> {
    const systemType =
      query.systemType !== undefined ? toSystemType(query.systemType) : undefined;

    let listQuery = this.db.selectFrom('integrationSyncLogs').selectAll();
    let countQuery = this.db
      .selectFrom('integrationSyncLogs')
      .select((eb) => eb.fn.countAll().as('total'));

    if (systemType !== undefined) {
      listQuery = listQuery.where('systemCode', '=', systemType);
      countQuery = countQuery.where('systemCode', '=', systemType);
    }

    const rows = await listQuery
      .orderBy('createdAt', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();

    const countRow = await countQuery.executeTakeFirst();

    return {
      total: countRow ? Number(countRow.total) : 0,
      items: rows.map((row) => this.mapSyncLog(row)),
    };
  }

  private mapConfig(row: IntegrationConfigRow): IntegrationConfig {
    return {
      id: row.id,
      systemType: row.systemCode,
      serviceUrl: row.baseUrl,
      subscribedWorkshops: row.subscribedWorkshops,
      subscribedProcesses: row.subscribedProcesses,
      cronSchedule: row.syncSchedule ?? '0 */5 * * * *',
      enabled: row.isEnabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      // authToken 刻意不回显：密钥只允许写、不允许读
    };
  }

  private mapSyncLog(row: IntegrationSyncLogRow): IntegrationSyncLog {
    return {
      id: row.id,
      batchNo: row.batchNo,
      systemType: row.systemCode,
      syncDirection: row.syncDirection as SyncDirection,
      status: row.status as SyncStatus,
      recordsCount: Number(row.recordsProcessed),
      createdAt: row.createdAt.toISOString(),
      ...(row.errorMessage !== null ? { errorDetails: row.errorMessage } : {}),
    };
  }
}
