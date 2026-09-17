import { Kysely } from 'kysely';
import type { IOutboxRepository, OutboxEventRecord } from '@letian/application';
import type { Database, OutboxEventInsert, OutboxEventRow } from '../database/schema.js';

/** 应用层 OutboxEventRecord 只承载 3 态；DEAD_LETTER 行不会被读取出来 */
type PendingEventStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

function toRecordStatus(status: OutboxEventRow['status']): PendingEventStatus {
  // SQL 已过滤掉 DEAD_LETTER，这里仅做类型收窄，保持与 OutboxEventRecord 的 3 值域一致
  if (status === 'PUBLISHED' || status === 'FAILED') {
    return status;
  }
  return 'PENDING';
}

/**
 * 事务外发件箱仓储 (Kysely + PostgreSQL)
 *
 * append / appendBatch 都是幂等写入：主键 id 冲突时 DO NOTHING，
 * 因此同一条事件被重复投递（重试、重复提交）不会产生重复行。
 */
export class KyselyOutboxRepository implements IOutboxRepository {
  constructor(private readonly db: Kysely<Database>) {}

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

  public async findPendingEvents(limit: number): Promise<OutboxEventRecord[]> {
    const rows = await this.db
      .selectFrom('outboxEvents')
      .selectAll()
      // 只取 PENDING；DEAD_LETTER 必须留在库中由人工介入，绝不能再次投递
      .where('status', '=', 'PENDING')
      .orderBy('createdAt', 'asc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload,
      traceId: row.traceId ?? '',
      occurredAt: row.createdAt,
      status: toRecordStatus(row.status),
      retryCount: row.retryCount,
    }));
  }

  public async markAsPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db
      .updateTable('outboxEvents')
      .set({ status: 'PUBLISHED', processedAt: new Date() })
      .where('id', 'in', ids)
      .execute();
  }

  public async markAsFailed(id: string, errorReason: string): Promise<void> {
    await this.db
      .updateTable('outboxEvents')
      .set((eb) => ({
        status: 'FAILED',
        errorReason,
        retryCount: eb('retryCount', '+', 1),
      }))
      .where('id', '=', id)
      .execute();
  }

  /** 超过最大重试次数后落死信，等待人工介入重放 */
  public async markAsDeadLetter(id: string, errorReason: string): Promise<void> {
    await this.db
      .updateTable('outboxEvents')
      .set({ status: 'DEAD_LETTER', errorReason })
      .where('id', '=', id)
      .execute();
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
      traceId: event.traceId,
    };
  }
}
