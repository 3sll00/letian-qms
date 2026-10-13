import { Kysely, sql } from 'kysely';

/**
 * 迁移 043：扩宽 `inspection_orders` 中 ERP 来料检验同步会写入的 varchar(64) 键列
 *
 * 背景（ERP 来料检验全量同步，见 apps/api 同步端点 /integration/erp/incoming-inspections/sync
 * 与用例 SyncErpIncomingInspectionsUseCase）：
 *  - `order_no`（幂等自然键）= `erpNumber`（base = ERP 送检单号 number，多物料时追加 `#物料编码`、
 *    重复行再追加 `-序号`），而 ERP 的 `ptypeUserCode`（物料编码）本身可长达 ~50 字符，拼上单号后
 *    轻易超过 varchar(64)，导致 133 行 `value too long for type character varying(64)` 失败。
 *  - `batch_no` = `blockNo`（ERP 批号）或回落 `B-<erpNumber>`，同样可能超 64。
 *  - `material_code / supplier_code / inbound_no / operator_id / operator_name` 由同步直接写入，
 *    虽当前多在 64 内，统一扩宽以杜绝未来溢出。
 *
 * 为什么不复选所有 varchar(64) 列：本表存在生成列 `furnace_heat_batch_no_norm`（GENERATED ALWAYS AS
 * (furnace_heat_batch_no ...)），Postgres 禁止 ALTER 被生成列依赖的基列；而该 heat-trace 字段并非
 * 同步写入，故明确排除，只扩宽同步实际写入的列。
 *
 * 处理：
 *   - `order_no`（带 UNIQUE 索引，承载最长复合值）→ varchar(255)
 *   - 其余同步写入列 → varchar(128)
 * 扩宽 varchar 仅改元数据、无需表重写，对已建索引安全（btree 索引键上限 ~2704 字节，远低于 255）。
 *
 * 幂等：仅对「当前确为 varchar(64)」的列做 ALTER；若已扩宽则本轮查不到、自然跳过。
 * down：把上述列回缩到 varchar(64)；若已有数据超 64 会报错（属预期，宽度回缩本就有风险）。
 */

// 同步用例实际写入 inspection_orders 的 varchar 列（见 mapRowToCommand / CreateInspectionOrderCommand）
const SYNC_WRITTEN_COLUMNS: { name: string; width: number }[] = [
  { name: 'order_no', width: 255 },
  { name: 'batch_no', width: 128 },
  { name: 'material_code', width: 128 },
  { name: 'supplier_code', width: 128 },
  { name: 'inbound_no', width: 128 },
  { name: 'operator_id', width: 128 },
  { name: 'operator_name', width: 128 },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  let widened = 0;
  for (const { name, width } of SYNC_WRITTEN_COLUMNS) {
    // 仅当当前确为 varchar(64) 才扩宽（幂等）
    const cur = await sql<{ len: number }>`
      SELECT character_maximum_length AS len
      FROM information_schema.columns
      WHERE table_name = 'inspection_orders' AND column_name = ${name}
    `.execute(db);
    if (!cur.rows[0] || cur.rows[0].len === null || cur.rows[0].len <= 64) {
      await sql.raw(
        `ALTER TABLE inspection_orders ALTER COLUMN "${name}" TYPE VARCHAR(${width})`,
      ).execute(db);
      console.log(`[043] inspection_orders.${name}: varchar(${cur.rows[0]?.len ?? '?'}) -> varchar(${width})`);
      widened++;
    } else {
      console.log(`[043] inspection_orders.${name}: 已是 varchar(${cur.rows[0].len})，跳过`);
    }
  }
  console.log(`[043] 完成：扩宽 ${widened} 个同步写入列（order_no→255，其余→128）`);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const { name } of SYNC_WRITTEN_COLUMNS) {
    await sql.raw(
      `ALTER TABLE inspection_orders ALTER COLUMN "${name}" TYPE VARCHAR(64)`,
    ).execute(db);
    console.log(`[043] reverted inspection_orders.${name} -> varchar(64)`);
  }
  console.log(`[043] 回缩完成：${SYNC_WRITTEN_COLUMNS.length} 个列恢复 varchar(64)`);
}
