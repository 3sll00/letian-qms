import { Kysely, sql } from 'kysely';

/**
 * 迁移 047：后台运维任务所需的持久化字段
 *
 * 1. outbox_events.next_retry_at
 *    FAILED 事件不再立即重复投递，而是按指数退避到期后才重新进入派发队列；
 *    原实现把 FAILED 永久排除在 findPendingEvents 之外，事件第一次失败后实际不再重试。
 *
 * 2. outbox_events.dead_letter_alerted_at
 *    DEAD_LETTER 是终局投递状态，但“已死信”与“告警已送达”必须分开：
 *    Webhook 暂时不可达时保留 NULL，让后台任务下一轮补发告警，避免只写日志后告警丢失。
 *
 * 3. mrb_reviews.last_reminded_at / reminder_count
 *    24 小时未裁决自动催办需要持久化去重依据；同一单据按重复间隔续催，
 *    不会在每个调度周期刷告警。
 *
 * 幂等：全部使用 IF NOT EXISTS；down 只回滚本迁移新增对象。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE outbox_events
      ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS dead_letter_alerted_at TIMESTAMPTZ
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_outbox_due_events
      ON outbox_events (status, next_retry_at, created_at)
      WHERE status IN ('PENDING', 'FAILED')
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_outbox_dead_letter_alert
      ON outbox_events (dead_letter_alerted_at, processed_at)
      WHERE status = 'DEAD_LETTER' AND dead_letter_alerted_at IS NULL
  `.execute(db);

  await sql`
    ALTER TABLE mrb_reviews
      ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_mrb_overdue_reviews
      ON mrb_reviews (status, created_at)
      WHERE status IN ('PENDING_REVIEW', 'UNDER_REVIEW')
  `.execute(db);

  await sql`
    COMMENT ON COLUMN outbox_events.next_retry_at IS
      'FAILED 事件下一次允许投递时间；PENDING/到期 FAILED 才会被 Outbox 派发器读取'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN outbox_events.dead_letter_alerted_at IS
      'DEAD_LETTER 告警成功送达时间；NULL 表示死信告警待补发'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN mrb_reviews.last_reminded_at IS
      'MRB 超过裁决时限后的最近一次自动催办时间'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN mrb_reviews.reminder_count IS
      'MRB 自动催办累计次数'
  `.execute(db);

  console.log('[047] 已补齐 Outbox 退避/死信告警与 MRB 催办字段');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_mrb_overdue_reviews`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_outbox_dead_letter_alert`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_outbox_due_events`.execute(db);
  await sql`
    ALTER TABLE mrb_reviews
      DROP COLUMN IF EXISTS last_reminded_at,
      DROP COLUMN IF EXISTS reminder_count
  `.execute(db);
  await sql`
    ALTER TABLE outbox_events
      DROP COLUMN IF EXISTS next_retry_at,
      DROP COLUMN IF EXISTS dead_letter_alerted_at
  `.execute(db);
  console.log('[047] 已回滚后台运维任务字段');
}
