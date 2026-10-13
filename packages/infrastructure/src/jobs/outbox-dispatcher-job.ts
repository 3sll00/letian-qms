import { Kysely } from 'kysely';
import type { Database } from '../database/schema.js';
import type { OutboxEventRecord } from '@letian/application';
import { KyselyOutboxRepository } from '../repositories/outbox-repository.js';
import {
  DeadLetterWebhookAdapter,
  type DeadLetterAlertPayload,
  type IDeadLetterAlertNotifier,
} from './dead-letter-webhook-adapter.js';
import { HttpOutboxDispatcher } from './http-outbox-dispatcher.js';

export interface EventDispatcher {
  dispatch(event: {
    id: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface OutboxDispatcherJobOptions {
  batchSize?: number;
  /** 最大投递次数；第 maxRetries 次失败后进入 DEAD_LETTER（默认 5） */
  maxRetries?: number;
  /** 各失败次数后的退避毫秒；首个值对应第 1 次失败 */
  backoffScheduleMs?: number[];
  intervalMs?: number;
  runOnStart?: boolean;
  unref?: boolean;
  webhookAdapter?: IDeadLetterAlertNotifier;
  dispatcher?: EventDispatcher;
  sleepFn?: (ms: number) => Promise<void>;
  logger?: (message: string) => void;
}

export interface OutboxDispatcherRunResult {
  processed: number;
  skippedLocked: number;
  successCount: number;
  failedCount: number;
  deadLetterCount: number;
  deadLetterAlertCount: number;
}

export const DEFAULT_OUTBOX_BATCH_SIZE = 50;
export const DEFAULT_OUTBOX_INTERVAL_MS = 5000;
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
export const DEFAULT_BACKOFF_SCHEDULE_MS = [
  1000,   // 1s
  2000,   // 2s
  4000,   // 4s
  8000,   // 8s
  16000,  // 16s
];

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

/** 从环境变量读取 Outbox 调度配置 */
export function readOutboxDispatcherOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): OutboxDispatcherJobOptions & { enabled: boolean } {
  return {
    enabled: boolOr(env.OUTBOX_DISPATCHER_ENABLED, true),
    batchSize: numOr(env.OUTBOX_BATCH_SIZE, DEFAULT_OUTBOX_BATCH_SIZE),
    maxRetries: numOr(env.OUTBOX_MAX_ATTEMPTS, DEFAULT_OUTBOX_MAX_ATTEMPTS),
    intervalMs: numOr(env.OUTBOX_POLL_INTERVAL_MS, DEFAULT_OUTBOX_INTERVAL_MS),
    runOnStart: boolOr(env.OUTBOX_RUN_ON_START, true),
    unref: boolOr(env.OUTBOX_UNREF, true),
  };
}

/**
 * Outbox 派发任务：批量拉取到期事件投递给外部 Sink。
 *
 * 可靠性口径：
 * - at-least-once：Sink 成功才置 PUBLISHED；状态写库失败仍会重试，下游按事件 id 去重；
 * - FAILED 事件按 next_retry_at 到期后重试；
 * - 第 5 次（或配置的最后一次）失败置 DEAD_LETTER；
 * - 死信告警成功送达前 dead_letter_alerted_at 保持 NULL，后续轮次补发；
 * - 同一事件由 advisory lock 串行化，多实例部署不会并发重复投递。
 */
export class OutboxDispatcherJob {
  private readonly outboxRepo: KyselyOutboxRepository;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly backoffScheduleMs: number[];
  private readonly webhookAdapter: IDeadLetterAlertNotifier;
  private readonly dispatcher: EventDispatcher;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly options: OutboxDispatcherJobOptions = {}
  ) {
    this.outboxRepo = new KyselyOutboxRepository(db);
    this.batchSize = options.batchSize ?? DEFAULT_OUTBOX_BATCH_SIZE;
    this.maxRetries = Math.max(1, options.maxRetries ?? DEFAULT_OUTBOX_MAX_ATTEMPTS);
    this.backoffScheduleMs = options.backoffScheduleMs ?? DEFAULT_BACKOFF_SCHEDULE_MS;
    this.webhookAdapter = options.webhookAdapter ?? new DeadLetterWebhookAdapter();
    this.dispatcher = options.dispatcher ?? new HttpOutboxDispatcher();
    this.sleepFn = options.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  public get isRunning(): boolean {
    return !this.stopped;
  }

  public getBackoffDelayMs(retryCount: number): number {
    if (this.backoffScheduleMs.length === 0) {
      return 0;
    }
    const idx = Math.max(0, Math.min(retryCount, this.backoffScheduleMs.length - 1));
    return this.backoffScheduleMs[idx] ?? 0;
  }

  /** 启动周期派发（幂等，重复调用无效） */
  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.log(`[Outbox投递] 已启动：周期 ${this.options.intervalMs ?? DEFAULT_OUTBOX_INTERVAL_MS}ms`);
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
    this.log('[Outbox投递] 已停止');
  }

  /** 单轮派发：先补发遗留死信告警，再处理到期 PENDING/FAILED 事件 */
  public async processBatch(now = new Date()): Promise<OutboxDispatcherRunResult> {
    const deadLetterAlertCount = await this.processPendingDeadLetterAlerts();
    const events = await this.outboxRepo.findPendingEvents(this.batchSize, now);

    let successCount = 0;
    let failedCount = 0;
    let deadLetterCount = 0;
    let skippedLocked = 0;

    for (const event of events) {
      const acquired = await this.outboxRepo.tryAcquireEventLock(event.id);
      if (!acquired) {
        skippedLocked++;
        continue;
      }

      try {
        const outcome = await this.processEvent(event);
        if (outcome === 'SUCCESS') {
          successCount++;
        } else if (outcome === 'DEAD_LETTER') {
          deadLetterCount++;
        } else {
          failedCount++;
        }
      } finally {
        await this.outboxRepo.releaseEventLock(event.id).catch(() => undefined);
      }
    }

    return {
      processed: events.length,
      skippedLocked,
      successCount,
      failedCount,
      deadLetterCount,
      deadLetterAlertCount,
    };
  }

  public async runOnce(): Promise<OutboxDispatcherRunResult> {
    return this.processBatch();
  }

  public async processEvent(
    event: OutboxEventRecord
  ): Promise<'SUCCESS' | 'FAILED' | 'DEAD_LETTER'> {
    // 兼容存量数据：已失败 maxRetries 次但仍是 FAILED 的事件不再调用下游，直接转死信
    if (event.retryCount >= this.maxRetries) {
      await this.markDeadLetter(
        event,
        event.errorReason ?? `Outbox 已达到最大投递次数 ${this.maxRetries}`,
        event.retryCount
      );
      return 'DEAD_LETTER';
    }

    try {
      await this.dispatcher.dispatch({
        id: event.id,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
      });
      await this.outboxRepo.markAsPublished([event.id]);
      return 'SUCCESS';
    } catch (error: unknown) {
      const errorReason = toErrorMessage(error);
      const nextRetryCount = event.retryCount + 1;

      if (nextRetryCount >= this.maxRetries) {
        await this.markDeadLetter(event, errorReason, nextRetryCount);
        return 'DEAD_LETTER';
      }

      await this.outboxRepo.markAsFailed(
        event.id,
        errorReason,
        this.nextRetryAt(nextRetryCount)
      );
      return 'FAILED';
    }
  }

  /** 供测试/人工探测使用的退避等待；调度本身通过 next_retry_at 实现，不在进程内睡眠 */
  public async waitBeforeRetry(retryCount: number): Promise<void> {
    await this.sleepFn(this.getBackoffDelayMs(retryCount));
  }

  private nextRetryAt(nextRetryCount: number): Date {
    return new Date(Date.now() + this.getBackoffDelayMs(nextRetryCount - 1));
  }

  private async markDeadLetter(
    event: OutboxEventRecord,
    errorReason: string,
    retryCount: number
  ): Promise<void> {
    await this.outboxRepo.markAsDeadLetter(event.id, errorReason, retryCount);
    try {
      await this.sendDeadLetterAlert({
        eventId: event.id,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        retryCount,
        errorReason,
        failedAt: new Date(),
        payload: event.payload,
      });
    } catch {
      // 死信状态必须先成立；告警失败保留 dead_letter_alerted_at=NULL，
      // 由 processPendingDeadLetterAlerts 在下一轮补发。
    }
  }

  /** 补发存量死信告警：Webhook 临时失败不会让告警永远丢失 */
  private async processPendingDeadLetterAlerts(): Promise<number> {
    const pendingAlerts = await this.outboxRepo.findDeadLettersPendingAlert(this.batchSize);
    let alerted = 0;

    for (const event of pendingAlerts) {
      const acquired = await this.outboxRepo.tryAcquireEventLock(event.id);
      if (!acquired) continue;

      try {
        await this.sendDeadLetterAlert({
          eventId: event.id,
          eventType: event.eventType,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          retryCount: event.retryCount,
          errorReason: event.errorReason ?? 'OUTBOX_DEAD_LETTER',
          failedAt: event.occurredAt,
          payload: event.payload,
        });
        alerted++;
      } catch (error: unknown) {
        this.log(`[Outbox投递] 死信告警补发失败 ${event.id}: ${toErrorMessage(error)}`);
      } finally {
        await this.outboxRepo.releaseEventLock(event.id).catch(() => undefined);
      }
    }

    return alerted;
  }

  private async sendDeadLetterAlert(payload: DeadLetterAlertPayload): Promise<void> {
    try {
      await this.webhookAdapter.sendAlert(payload);
      await this.outboxRepo.markDeadLetterAlerted(payload.eventId, payload.failedAt);
    } catch (error: unknown) {
      this.log(`[Outbox投递] 死信告警发送失败 ${payload.eventId}: ${toErrorMessage(error)}`);
      throw error;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      void this.tick();
    }, this.options.intervalMs ?? DEFAULT_OUTBOX_INTERVAL_MS);
    if (this.options.unref ?? true) {
      timer.unref();
    }
    this.timer = timer;
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.processBatch();
      this.log(
        `[Outbox投递] 完成：取回 ${result.processed}，成功 ${result.successCount}，` +
          `失败 ${result.failedCount}，死信 ${result.deadLetterCount}，` +
          `补发告警 ${result.deadLetterAlertCount}，锁冲突跳过 ${result.skippedLocked}`
      );
    } catch (error: unknown) {
      // 单轮失败只记日志：下一轮继续，绝不让后台任务打挂 API 进程
      this.log(`[Outbox投递] 异常：${toErrorMessage(error)}`);
    }
    this.scheduleNext();
  }

  private log(message: string): void {
    (this.options.logger ?? console.log)(message);
  }
}
