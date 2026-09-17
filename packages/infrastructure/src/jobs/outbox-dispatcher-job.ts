import { Kysely } from 'kysely';
import type { Database } from '../database/schema.js';
import type { OutboxEventRecord } from '@letian/application';
import { KyselyOutboxRepository } from '../repositories/outbox-repository.js';
import type { DeadLetterAlertPayload, IDeadLetterAlertNotifier } from './dead-letter-webhook-adapter.js';

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
  maxRetries?: number;
  backoffScheduleMs?: number[];
  webhookAdapter?: IDeadLetterAlertNotifier;
  dispatcher?: EventDispatcher;
  sleepFn?: (ms: number) => Promise<void>;
}

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

/**
 * Outbox 派发任务：批量拉取 PENDING 事件投递给外部系统，
 * 超过最大重试次数后落 DEAD_LETTER 并触发死信告警 Webhook。
 */
export class OutboxDispatcherJob {
  private readonly outboxRepo: KyselyOutboxRepository;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly backoffScheduleMs: number[];
  private readonly webhookAdapter: IDeadLetterAlertNotifier | undefined;
  private readonly dispatcher: EventDispatcher | undefined;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    private readonly db: Kysely<Database>,
    options: OutboxDispatcherJobOptions = {}
  ) {
    this.outboxRepo = new KyselyOutboxRepository(db);
    this.batchSize = options.batchSize ?? 50;
    this.maxRetries = options.maxRetries ?? 5;
    this.backoffScheduleMs = options.backoffScheduleMs ?? DEFAULT_BACKOFF_SCHEDULE_MS;
    this.webhookAdapter = options.webhookAdapter;
    this.dispatcher = options.dispatcher;
    this.sleepFn = options.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  public getBackoffDelayMs(retryCount: number): number {
    if (this.backoffScheduleMs.length === 0) {
      return 0;
    }
    const idx = Math.max(0, Math.min(retryCount, this.backoffScheduleMs.length - 1));
    return this.backoffScheduleMs[idx] ?? 0;
  }

  public async processBatch(): Promise<{
    processed: number;
    successCount: number;
    failedCount: number;
    deadLetterCount: number;
  }> {
    const events = await this.outboxRepo.findPendingEvents(this.batchSize);

    let successCount = 0;
    let failedCount = 0;
    let deadLetterCount = 0;

    for (const event of events) {
      const outcome = await this.processEvent(event);
      if (outcome === 'SUCCESS') {
        successCount++;
      } else if (outcome === 'DEAD_LETTER') {
        deadLetterCount++;
      } else {
        failedCount++;
      }
    }

    return {
      processed: events.length,
      successCount,
      failedCount,
      deadLetterCount,
    };
  }

  public async processEvent(event: OutboxEventRecord): Promise<'SUCCESS' | 'FAILED' | 'DEAD_LETTER'> {
    try {
      if (this.dispatcher) {
        await this.dispatcher.dispatch({
          id: event.id,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          payload: event.payload,
        });
      }
      await this.outboxRepo.markAsPublished([event.id]);
      return 'SUCCESS';
    } catch (error: unknown) {
      const errorReason = toErrorMessage(error);
      const nextRetryCount = event.retryCount + 1;

      if (nextRetryCount >= this.maxRetries) {
        await this.outboxRepo.markAsDeadLetter(event.id, errorReason);

        if (this.webhookAdapter) {
          const webhookPayload: DeadLetterAlertPayload = {
            eventId: event.id,
            eventType: event.eventType,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            retryCount: nextRetryCount,
            errorReason,
            failedAt: new Date(),
            payload: event.payload,
          };

          try {
            await this.webhookAdapter.sendAlert(webhookPayload);
          } catch (webhookErr: unknown) {
            console.error(
              `Failed to send dead letter webhook alert for event ${event.id}:`,
              toErrorMessage(webhookErr)
            );
          }
        }
        return 'DEAD_LETTER';
      }

      await this.outboxRepo.markAsFailed(event.id, errorReason);
      return 'FAILED';
    }
  }

  /** 退避等待：在重试之间按固定节奏 sleep，避免打爆下游 */
  public async waitBeforeRetry(retryCount: number): Promise<void> {
    await this.sleepFn(this.getBackoffDelayMs(retryCount));
  }
}
