import { Kysely, sql } from 'kysely';

/**
 * 迁移 044：扩宽 Outbox / 审计日志中承载 order_no 的 varchar(64) 列
 *
 * 背景：领域实体 `InspectionOrder.getId()` 返回的是 `orderNo`（见 packages/domain/src/models/inspection-order.ts:215），
 * 而 `CreateInspectionOrderUseCase` 建单时把 `order.getId()` 同时写进
 *   - `outbox_events.aggregate_id`（Outbox 事件聚合键，用于派发/溯源）
 *   - `audit_logs.entity_id`（审计资源键）
 * ERP 来料检验全量同步后，`order_no` 可能为 ERP 单号#物料编码 的复合长值（见迁移 043，已扩宽到
 * varchar(255)），于是这两个原本 varchar(64) 的列被等长字符串撑爆，导致 143 行建单失败
 * （`value too long for type character varying(64)`）。
 *
 * 处理：把上述两列统一扩宽到 varchar(255)，与 inspection_orders.order_no 对齐。
 * 扩宽 varchar 仅改元数据、无需表重写，对已建索引安全（btree 索引键上限 ~2704 字节）。
 *
 * 幂等：仅当当前确为 varchar(64) 才 ALTER；已扩宽则跳过。
 * down：回缩到 varchar(64)；若已有数据超 64 会报错（属预期）。
 */

const TARGETS: { table: string; column: string; width: number }[] = [
  { table: 'outbox_events', column: 'aggregate_id', width: 255 },
  { table: 'audit_logs', column: 'entity_id', width: 255 },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  let altered = 0;
  for (const { table, column, width } of TARGETS) {
    const cur = await sql<{ len: number | null }>`
      SELECT character_maximum_length AS len
      FROM information_schema.columns
      WHERE table_name = ${table} AND column_name = ${column}
    `.execute(db);
    if (!cur.rows[0] || cur.rows[0].len === null || cur.rows[0].len <= 64) {
      await sql.raw(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE VARCHAR(${width})`,
      ).execute(db);
      console.log(`[044] ${table}.${column}: varchar(${cur.rows[0]?.len ?? '?'}) -> varchar(${width})`);
      altered++;
    } else {
      console.log(`[044] ${table}.${column}: 已是 varchar(${cur.rows[0]?.len})，跳过`);
    }
  }
  console.log(`[044] 完成：扩宽 ${altered} 个承载 order_no 的 id 列 -> varchar(255)`);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const { table, column } of TARGETS) {
    await sql.raw(
      `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE VARCHAR(64)`,
    ).execute(db);
    console.log(`[044] reverted ${table}.${column} -> varchar(64)`);
  }
  console.log(`[044] 回缩完成：${TARGETS.length} 个列恢复 varchar(64)`);
}
