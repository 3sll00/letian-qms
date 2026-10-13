import { Kysely, sql } from 'kysely';
import type { Database } from '../database/schema.js';
import { KyselyMRBReviewRepository } from '../repositories/mrb-review-repository.js';
import {
  MrbReminderWebhookAdapter,
  type IMrbReminderNotifier,
} from './mrb-reminder-webhook-adapter.js';

export interface MrbReminderJobOptions {
  /** 检查周期，默认 5 分钟 */
  intervalMs?: number;
  /** 未裁决超过该时长触发催办，默认 24 小时 */
  overdueAfterMs?: number;
  /** 重复催办间隔；传 null 表示每张单只催办一次，默认 24 小时 */
  repeatIntervalMs?: number | null;
  batchSize?: number;
  runOnStart?: boolean;
  unref?: boolean;
  /** 催办时是否把 urgency_level 提升为 CRITICAL（前端据此标红），默认 true */
  escalateToCritical?: boolean;
  notifier?: IMrbReminderNotifier;
  logger?: (message: string) => void;
}

export interface MrbReminderRunResult {
  scanned: number;
  reminded: number;
  failed: number;
  skippedLocked: number;
}

export const DEFAULT_MRB_REMINDER_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_MRB_OVERDUE_AFTER_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MRB_REMINDER_REPEAT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MRB_REMINDER_BATCH_SIZE = 50;

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

/** 从环境变量读取 MRB 催办配置；MRB_TIMEOUT_HOURS 为既有部署变量 */
export function readMrbReminderOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): MrbReminderJobOptions & { enabled: boolean } {
  return {
    enabled: boolOr(env.MRB_REMINDER_ENABLED, true),
    intervalMs: numOr(env.MRB_REMINDER_INTERVAL_MS, DEFAULT_MRB_REMINDER_INTERVAL_MS),
    overdueAfterMs: numOr(env.MRB_TIMEOUT_HOURS, 24) * 60 * 60 * 1000,
    repeatIntervalMs: numOr(env.MRB_REMINDER_REPEAT_MS, DEFAULT_MRB_REMINDER_REPEAT_MS),
    batchSize: numOr(env.MRB_REMINDER_BATCH_SIZE, DEFAULT_MRB_REMINDER_BATCH_SIZE),
    runOnStart: boolOr(env.MRB_REMINDER_RUN_ON_START, true),
    unref: boolOr(env.MRB_REMINDER_UNREF, true),
    escalateToCritical: boolOr(env.MRB_REMINDER_ESCALATE, true),
  };
}

/**
 * MRB 超时催办作业。
 *
 * 候选口径：created_at <= now-24h 且 status 属于 PENDING_REVIEW / UNDER_REVIEW。
 * last_reminded_at 用于持久化去重；发送前对单号取 advisory lock，多实例不重复催办。
 */
export class MrbReminderJob {
  private readonly reviews: KyselyMRBReviewRepository;
  private readonly notifier: IMrbReminderNotifier;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly options: MrbReminderJobOptions = {}
  ) {
    this.reviews = new KyselyMRBReviewRepository(db);
    this.notifier = options.notifier ?? new MrbReminderWebhookAdapter();
  }

  public get isRunning(): boolean {
    return !this.stopped;
  }

  public get overdueAfterMs(): number {
    return this.options.overdueAfterMs ?? DEFAULT_MRB_OVERDUE_AFTER_MS;
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.log(
      `[MRB催办] 已启动：检查周期 ${this.options.intervalMs ?? DEFAULT_MRB_REMINDER_INTERVAL_MS}ms，` +
        `超时 ${this.overdueAfterMs}ms`
    );
    if (this.options.runOnStart ?? true) {
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
    this.log('[MRB催办] 已停止');
  }

  public async runOnce(now = new Date()): Promise<MrbReminderRunResult> {
    const overdueBefore = new Date(now.getTime() - this.overdueAfterMs);
    const repeatIntervalMs = this.options.repeatIntervalMs === undefined
      ? DEFAULT_MRB_REMINDER_REPEAT_MS
      : this.options.repeatIntervalMs;
    const remindAgainBefore =
      repeatIntervalMs === null ? null : new Date(now.getTime() - repeatIntervalMs);

    const candidates = await this.reviews.findOverdueUndecided({
      overdueBefore,
      remindAgainBefore,
      limit: this.options.batchSize ?? DEFAULT_MRB_REMINDER_BATCH_SIZE,
    });

    let reminded = 0;
    let failed = 0;
    let skippedLocked = 0;

    for (const review of candidates) {
      const lockKey = `MRB_REMINDER_${review.id}`;
      const acquired = await this.tryAcquireReminderLock(lockKey);
      if (!acquired) {
        skippedLocked++;
        continue;
      }

      try {
        const remindedAt = new Date();
        await this.notifier.sendReminder({
          mrbId: review.id,
          mrbNo: review.mrbNo,
          sourceOrderNo: review.sourceOrderNo,
          batchNo: review.batchNo,
          materialCode: review.materialCode,
          materialName: review.materialName,
          status: review.status,
          urgencyLevel: review.urgencyLevel,
          overdueHours: (remindedAt.getTime() - review.createdAt.getTime()) / 3600000,
          reminderCount: review.reminderCount + 1,
          defectQty: review.defectQty,
          defectDescription: review.defectDescription,
          remindedAt,
        });

        const marked = await this.reviews.markReminderSent(
          review.id,
          remindedAt,
          this.options.escalateToCritical ?? true
        );
        if (marked) {
          reminded++;
        }
      } catch (error: unknown) {
        failed++;
        this.log(`[MRB催办] ${review.mrbNo} 发送失败：${toErrorMessage(error)}`);
      } finally {
        await this.releaseReminderLock(lockKey).catch(() => undefined);
      }
    }

    return {
      scanned: candidates.length,
      reminded,
      failed,
      skippedLocked,
    };
  }

  private async tryAcquireReminderLock(lockKey: string): Promise<boolean> {
    const result = await sql<{ acquired: boolean }>`
      SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS acquired
    `.execute(this.db);
    return result.rows[0]?.acquired === true;
  }

  private async releaseReminderLock(lockKey: string): Promise<void> {
    await sql`
      SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))
    `.execute(this.db);
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      void this.tick();
    }, this.options.intervalMs ?? DEFAULT_MRB_REMINDER_INTERVAL_MS);
    if (this.options.unref ?? true) {
      timer.unref();
    }
    this.timer = timer;
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.runOnce();
      this.log(
        `[MRB催办] 完成：扫描 ${result.scanned}，已催办 ${result.reminded}，` +
          `失败 ${result.failed}，锁冲突跳过 ${result.skippedLocked}`
      );
    } catch (error: unknown) {
      this.log(`[MRB催办] 异常：${toErrorMessage(error)}`);
    }
    this.scheduleNext();
  }

  private log(message: string): void {
    (this.options.logger ?? console.log)(message);
  }
}
