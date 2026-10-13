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
  status: 'PENDING' | 'PUBLISHED' | 'FAILED' | 'DEAD_LETTER';
  retryCount: number;
  /** 失败事件下一次允许投递的时间；PENDING / 立即重试事件为 null */
  nextRetryAt?: Date | null;
  /** 最近一次投递失败原因 */
  errorReason?: string | null;
  /** 死信告警已成功送达的时间；未送达则下一轮继续补发 */
  deadLetterAlertedAt?: Date | null;
}

export interface IOutboxRepository {
  /**
   * 在当前事务内将事件持久化到 outbox 表中
   */
  append(event: OutboxEventRecord): Promise<void>;
  appendBatch(events: OutboxEventRecord[]): Promise<void>;
  findPendingEvents(limit: number, now?: Date): Promise<OutboxEventRecord[]>;
  markAsPublished(ids: string[]): Promise<void>;
  markAsFailed(id: string, errorReason: string, nextRetryAt?: Date): Promise<void>;
}
