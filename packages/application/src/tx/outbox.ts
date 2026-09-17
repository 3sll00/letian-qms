/**
 * Outbox 事务内事件记录
 */
export interface OutboxEventRecord {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  traceId: string;
  occurredAt: Date;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  retryCount: number;
}

export interface IOutboxRepository {
  /**
   * 在当前事务内将事件持久化到 outbox 表中
   */
  append(event: OutboxEventRecord): Promise<void>;
  appendBatch(events: OutboxEventRecord[]): Promise<void>;
  findPendingEvents(limit: number): Promise<OutboxEventRecord[]>;
  markAsPublished(ids: string[]): Promise<void>;
  markAsFailed(id: string, errorReason: string): Promise<void>;
}
