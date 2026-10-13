import { Kysely, sql } from 'kysely';

/**
 * 迁移 042：ERP 回写日志表 `qms_write_log`（重建）
 *
 * ⚠️ 该迁移曾在 2026-10-11 于本库执行并记录进 `kysely_migration`，但其源文件在
 * 后续 ERP 回写功能搁置/整理时被误删，导致 Kysely 报 "corrupted migrations:
 * previously executed migration 042_create_qms_write_log is missing" 而拒绝运行任何新迁移。
 * 此处按原迁移名与用途重建源文件，使迁移提供器完整、可继续推进后续迁移。
 *
 * 用途：记录 QMS → ERP（管家婆）回写的状态机（PENDING→SENT/SUCCESS/FAILED/ROLLED_BACK），
 * 供 `writeback-inspection.ts` 做幂等/可观测的回写审计。表当前无业务代码强依赖（回写功能仍 TODO），
 * 故采用合理默认结构；后续如需扩展字段，走新迁移 ALTER。
 *
 * 幂等：CREATE TABLE IF NOT EXISTS；down 直接 DROP（回写日志属可重建的派生审计数据）。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS qms_write_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_no VARCHAR(255) NOT NULL,        -- 关联 inspection_orders.order_no
      erp_vch_type INTEGER,                  -- ERP 单据类型 146(送检)/147(检验)
      erp_vch_code BIGINT,                   -- ERP 单据号 vchcode
      direction VARCHAR(10) NOT NULL DEFAULT 'OUT',  -- OUT = QMS→ERP
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING/SENT/SUCCESS/FAILED/ROLLED_BACK
      request_json JSONB,                    -- 回写请求体（快照）
      response_json JSONB,                   -- ERP 响应体（快照）
      error_text TEXT,                       -- 失败原因
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_qms_write_log_order ON qms_write_log (order_no)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_qms_write_log_status ON qms_write_log (status)`.execute(db);

  await sql`COMMENT ON TABLE qms_write_log IS 'QMS→ERP 回写日志/状态机（PENDING/SENT/SUCCESS/FAILED/ROLLED_BACK）'`.execute(db);

  console.log('[042] 已确保 qms_write_log（ERP 回写日志表）存在');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS qms_write_log`.execute(db);
  console.log('[042] 已删除 qms_write_log');
}
