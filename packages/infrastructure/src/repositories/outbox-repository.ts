import { Kysely, sql, Transaction } from 'kysely';
import type { IOutboxRepository, OutboxEventRecord } from '@letian/application';
import type { Database, OutboxEventInsert, OutboxEventRow } from '../database/schema.js';

type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED' | 'DEAD_LETTER';

function toRecordStatus(status: OutboxEventRow['status']): OutboxStatus {
  return status;
}

function toRecord(row: OutboxEventRow): OutboxEventRecord {
  return {
    id: row.id,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    traceId: row.traceId ?? '',
    occurredAt: row.createdAt,
    status: toRecordStatus(row.status),
    retryCount: row.retryCount,
    nextRetryAt: row.nextRetryAt,
    errorReason: row.errorReason,
    deadLetterAlertedAt: row.deadLetterAlertedAt,
  };
}

/**
 * 事务外发件箱仓储 (Kysely + PostgreSQL)
 *
 * append / appendBatch 都是幂等写入：主键 id 冲突时 DO NOTHING；
 * 派发进程之间用事件级 advisory lock 去重，同一事件不会并发投递。
 */
export class KyselyOutboxRepository implements IOutboxRepository {
  constructor(private readonly db: Kysely<Database> | Transaction<Database>) {}

  public async append(event: OutboxEventRecord): Promise<void> {
    await this.db
      .insertInto('outboxEvents')
      .values(this.buildInsert(event))
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }

  public async appendBatch(events: OutboxEventRecord[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await this.db
      .insertInto('outboxEvents')
      .values(events.map((event) => this.buildInsert(event)))
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }

  /**
   * 取当前可投递事件：新建 PENDING + 已到重试时间的 FAILED。
   * DEAD_LETTER 留在库中由人工介入，绝不能再次投递。
   */
  public async findPendingEvents(limit: number, now = new Date()): Promise<OutboxEventRecord[]> {
    const rows = await this.db
      .selectFrom('outboxEvents')
      .selectAll()
      .where('status', 'in', ['PENDING', 'FAILED'])
      .where((eb) =>
        eb.or([
          eb('nextRetryAt', 'is', null),
          eb('nextRetryAt', '<=', now),
        ])
      )
      .orderBy('createdAt', 'asc')
      .limit(limit)
      .execute();

    return rows.map(toRecord);
  }

  /** 已进入死信但告警尚未成功送达的事件（供下一轮补发告警） */
  public async findDeadLettersPendingAlert(limit: number): Promise<OutboxEventRecord[]> {
    const rows = await this.db
      .selectFrom('outboxEvents')
      .selectAll()
      .where('status', '=', 'DEAD_LETTER')
      .where('deadLetterAlertedAt', 'is', null)
      .orderBy('processedAt', 'asc')
      .limit(limit)
      .execute();

    return rows.map(toRecord);
  }

  public async markAsPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db
      .updateTable('outboxEvents')
      .set({
        status: 'PUBLISHED',
        processedAt: new Date(),
        nextRetryAt: null,
      })
      .where('id', 'in', ids)
      .execute();
  }

  public async markAsFailed(
    id: string,
    errorReason: string,
    nextRetryAt?: Date
  ): Promise<void> {
    await this.db
      .updateTable('outboxEvents')
      .set((eb) => ({
        status: 'FAILED',
        errorReason,
        retryCount: eb('retryCount', '+', 1),
        nextRetryAt: nextRetryAt ?? null,
      }))
      .where('id', '=', id)
      .execute();
  }

  /**
   * 达到最大失败次数后落死信。
   * retryCount 传入本次失败次数；未传时兼容旧调用，按现有计数再推进一次。
   */
  public async markAsDeadLetter(
    id: string,
    errorReason: string,
    retryCount?: number
  ): Promise<void> {
    await this.db
      .updateTable('outboxEvents')
      .set({
        status: 'DEAD_LETTER',
        errorReason,
        processedAt: new Date(),
        nextRetryAt: null,
        deadLetterAlertedAt: null,
        ...(retryCount !== undefined
          ? { retryCount }
          : { retryCount: sql<number>`retry_count + 1` }),
      })
      .where('id', '=', id)
      .execute();
  }

  /** 死信告警确认送达后才落标记；Webhook 失败不会写该列，下一轮继续补发 */
  public async markDeadLetterAlerted(id: string, alertedAt = new Date()): Promise<void> {
    await this.db
      .updateTable('outboxEvents')
      .set({ deadLetterAlertedAt: alertedAt })
      .where('id', '=', id)
      .where('status', '=', 'DEAD_LETTER')
      .execute();
  }

  /**
   * 事件级 advisory lock：同一事件只允许一个 worker 正在投递。
   * 使用 hashtextextended 的 int8 key，避免 32 位 hashtext 碰撞导致不同事件互相阻塞。
   */
  public async tryAcquireEventLock(id: string): Promise<boolean> {
    const result = await sql<{ acquired: boolean }>`
      SELECT pg_try_advisory_lock(hashtextextended(${id}, 0)) AS acquired
    `.execute(this.db);
    return result.rows[0]?.acquired === true;
  }

  public async releaseEventLock(id: string): Promise<void> {
    await sql`
      SELECT pg_advisory_unlock(hashtextextended(${id}, 0))
    `.execute(this.db);
  }

  private buildInsert(event: OutboxEventRecord): OutboxEventInsert {
    return {
      id: event.id,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: JSON.stringify(event.payload),
      status: 'PENDING',
      retryCount: 0,
      createdAt: event.occurredAt,
      nextRetryAt: null,
      deadLetterAlertedAt: null,
      traceId: event.traceId,
    };
  }
}
