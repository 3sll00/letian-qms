import { Kysely, sql } from 'kysely';

/**
 * 迁移 045：扩宽 `inspection_orders` 的 `chain_key` / `upstream_order_no` 列
 *
 * 背景（ERP 来料检验同步，见 create-inspection-order.ts:419 的 recordTransferTrace）：
 * 建单时无论是否命中链路锚点，都会把 `transferDecision.chainKey` 落库到 `chain_key`；
 * 未命中锚点时回落为「本单批次号」`batchNo`（= `B-<erpNumber>`，其中 erpNumber 是
 * `ERP单号#物料编码` 复合串，最长可达 ~255）。于是 `chain_key` 实际承载 `B-` + 最长 255 的串，
 * 即约 257 字符，远超迁移前 varchar(64)，导致长单号订单在 recordTransferTrace 这一步 UPDATE 失败、
 * 整单回滚（这也解释了此前 inspection_orders 里 order_no 最大只到 62：`B-`+62=64 恰好卡在 64 上限）。
 * `upstream_order_no` 存上游单号（同样可能是长复合串），一并扩宽。
 *
 * 处理：
 *   - `chain_key` → varchar(300)（容纳 `B-` + 最长 ~255 的 order_no）
 *   - `upstream_order_no` → varchar(255)（与 order_no 对齐）
 * 扩宽 varchar 仅改元数据、无需表重写，对已建索引安全（btree 索引键上限 ~2704 字节）。
 *
 * 幂等：仅当当前确为 varchar(64) 才 ALTER；已扩宽则跳过。
 * down：回缩到 varchar(64)；若已有数据超 64 会报错（属预期）。
 */

const TARGETS: { table: string; column: string; width: number }[] = [
  { table: 'inspection_orders', column: 'chain_key', width: 300 },
  { table: 'inspection_orders', column: 'upstream_order_no', width: 255 },
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
      console.log(`[045] ${table}.${column}: varchar(${cur.rows[0]?.len ?? '?'}) -> varchar(${width})`);
      altered++;
    } else {
      console.log(`[045] ${table}.${column}: 已是 varchar(${cur.rows[0]?.len})，跳过`);
    }
  }
  console.log(`[045] 完成：扩宽 ${altered} 个链路留痕列`);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const { table, column } of TARGETS) {
    await sql.raw(
      `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE VARCHAR(64)`,
    ).execute(db);
    console.log(`[045] reverted ${table}.${column} -> varchar(64)`);
  }
  console.log(`[045] 回缩完成：${TARGETS.length} 个列恢复 varchar(64)`);
}
