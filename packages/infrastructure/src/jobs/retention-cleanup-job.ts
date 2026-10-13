import { Kysely } from 'kysely';
import type { Database } from '../database/schema.js';
import { IdempotencyManager } from '../idempotency/idempotency-manager.js';
import { KyselyAuthorizationLogRepository } from '../repositories/authorization-log-repository.js';

export interface RetentionCleanupJobOptions {
  /** 清理周期，默认 1 小时 */
  intervalMs?: number;
  /** 权限校验日志保留天数，默认 180 天 */
  authorizationLogRetentionDays?: number;
  /** 幂等键保留小时数，默认 24 小时 */
  idempotencyRetentionHours?: number;
  /** 每批删除行数，默认 1000 */
  batchSize?: number;
  /** 单轮最多批次数，防止历史堆积时一次事务/查询跑太久，默认 20 */
  maxBatchesPerKind?: number;
  runOnStart?: boolean;
  unref?: boolean;
  logger?: (message: string) => void;
}

export interface RetentionCleanupRunResult {
  authorizationLogsDeleted: number;
  idempotencyKeysDeleted: number;
}

export const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_AUTHORIZATION_LOG_RETENTION_DAYS = 180;
export const DEFAULT_IDEMPOTENCY_RETENTION_HOURS = 24;
export const DEFAULT_RETENTION_BATCH_SIZE = 1000;
export const DEFAULT_RETENTION_MAX_BATCHES = 20;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolOr(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

/** 从环境变量读取保留期清理配置 */
export function readRetentionCleanupOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): RetentionCleanupJobOptions & { enabled: boolean } {
  return {
    enabled: boolOr(env.RETENTION_CLEANUP_ENABLED, true),
    intervalMs: numOr(env.RETENTION_CLEANUP_INTERVAL_MS, DEFAULT_RETENTION_INTERVAL_MS),
    authorizationLogRetentionDays: numOr(
      env.AUTHORIZATION_LOG_RETENTION_DAYS,
      DEFAULT_AUTHORIZATION_LOG_RETENTION_DAYS
    ),
    idempotencyRetentionHours: numOr(
      env.IDEMPOTENCY_RETENTION_HOURS,
      DEFAULT_IDEMPOTENCY_RETENTION_HOURS
    ),
    batchSize: numOr(env.RETENTION_BATCH_SIZE, DEFAULT_RETENTION_BATCH_SIZE),
    maxBatchesPerKind: numOr(env.RETENTION_MAX_BATCHES, DEFAULT_RETENTION_MAX_BATCHES),
    runOnStart: boolOr(env.RETENTION_RUN_ON_START, false),
    unref: boolOr(env.RETENTION_UNREF, true),
  };
}

/**
 * 运维保留期清理作业。
 *
 * - authorization_logs：保留 180 天（QMS-009 验收口径）；
 * - idempotency_keys：created_at 超过 24h 或已到期即清理；
 * - audit_logs：数据库触发器明确禁止 UPDATE/DELETE，是业务审计不可变留痕，不在本作业范围内。
 */
export class RetentionCleanupJob {
  private readonly authorizationLogs: KyselyAuthorizationLogRepository;
  private readonly idempotency: IdempotencyManager;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly options: RetentionCleanupJobOptions = {}
  ) {
    this.authorizationLogs = new KyselyAuthorizationLogRepository(db);
    this.idempotency = new IdempotencyManager(db);
  }

  public get isRunning(): boolean {
    return !this.stopped;
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.log(
      `[保留期清理] 已启动：周期 ${this.options.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS}ms，` +
        `权限日志 ${this.options.authorizationLogRetentionDays ?? DEFAULT_AUTHORIZATION_LOG_RETENTION_DAYS} 天，` +
        `幂等键 ${this.options.idempotencyRetentionHours ?? DEFAULT_IDEMPOTENCY_RETENTION_HOURS} 小时`
    );
    if (this.options.runOnStart ?? false) {
      void this.tick();
    } else {
      this.scheduleNext();
    }
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log('[保留期清理] 已停止');
  }

  public async runOnce(now = new Date()): Promise<RetentionCleanupRunResult> {
    const batchSize = this.options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
    const maxBatches = this.options.maxBatchesPerKind ?? DEFAULT_RETENTION_MAX_BATCHES;
    const authorizationRetentionDays =
      this.options.authorizationLogRetentionDays ?? DEFAULT_AUTHORIZATION_LOG_RETENTION_DAYS;
    const idempotencyRetentionHours =
      this.options.idempotencyRetentionHours ?? DEFAULT_IDEMPOTENCY_RETENTION_HOURS;

    const authorizationCutoff = new Date(
      now.getTime() - authorizationRetentionDays * 24 * 60 * 60 * 1000
    );

    let authorizationLogsDeleted = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const deleted = await this.authorizationLogs.purgeOlderThan(
        authorizationCutoff,
        batchSize
      );
      authorizationLogsDeleted += deleted;
      if (deleted < batchSize) break;
    }

    let idempotencyKeysDeleted = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const deleted = await this.idempotency.purgeOlderThan(
        idempotencyRetentionHours,
        batchSize,
        now
      );
      idempotencyKeysDeleted += deleted;
      if (deleted < batchSize) break;
    }

    return { authorizationLogsDeleted, idempotencyKeysDeleted };
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      void this.tick();
    }, this.options.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS);
    if (this.options.unref ?? true) {
      timer.unref();
    }
    this.timer = timer;
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.runOnce();
      this.log(
        `[保留期清理] 完成：权限日志 -${result.authorizationLogsDeleted}，` +
          `幂等键 -${result.idempotencyKeysDeleted}`
      );
    } catch (error: unknown) {
      this.log(`[保留期清理] 异常：${toErrorMessage(error)}`);
    }
    this.scheduleNext();
  }

  private log(message: string): void {
    (this.options.logger ?? console.log)(message);
  }
}
