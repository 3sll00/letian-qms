import { Kysely, sql } from 'kysely';

/**
 * 迁移 035：「合格后传递」建单留痕列（docs/48 §4.1）
 *
 * 背景（docs/48 §1.5 与 docs/47 §2 同一类断链）：
 *   「合格后传递」的判定与执法在 P0 已落地（领域纯函数 + 建单门禁 + 422 problem+json），
 *   但**建单那一次的判定结果没有任何持久化位置** —— 事后只能按当前上游状态实时重算，
 *   而上游状态是会变的（MRB 结案、复检终判、下游被冻结都会改写它）。
 *   于是「这批货当初凭什么放行」在数据库里查不到，只能看审计日志的自然语言 payload。
 *
 * 本次动作（**只加留痕列，不新建链路实例表**）：
 *   1. `inspection_orders` 新增四列，记录**建单时那一次**的传递判定：
 *      - `chain_key`         命中的链路锚点值（未命中时回落本单批次号）
 *      - `chain_key_kind`    命中的锚点类型：BATCH / HEAT / WORK_ORDER
 *      - `upstream_order_no` 权威上游检验单号（复检轮次时指向复检单）
 *      - `upstream_gate_code` 判定理由码（TransferGateCode）
 *   2. 索引 `(chain_key)` 供按链路对账；`(material_code, inspection_type, batch_no)`
 *      供 §2.2 多锚点候选集一次取回（`work_order_no` 单列索引既有，本次不重复建）。
 *
 * **纪律（写死在这里防误用）**：
 *   - 这四列**只作留痕与展示，永远不作判据**。判据一律由领域纯函数按 §2 实时重算 ——
 *     留痕列一旦被读成判据，就会出现「上游已撤销放行、下游仍按旧留痕放行」的静默错误。
 *     与 `docs/47` 的 `heat_source_type` / `heat_source_order_no` 同型设计。
 *   - **不回填历史行**：历史单据建单时根本没有判定过程，凭空补一个「当时的结论」等于编造
 *     （同 docs/46 的「不编造」红线）；未留痕的历史行四列为 NULL，界面按「—」呈现。
 *   - 不加 CHECK 约束锚点类型取值：取值来自领域枚举 `ChainAnchorKind`，在数据库再固化一份
 *     等于制造第二份口径（docs/48 §4.1「不用 trigger / CHECK 做业务判定」）。
 *
 * 安全边界：**纯新增列与索引**；不修改、不删除任何既有行。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 传递留痕四列（可空：未发生建单门禁的单据 —— 例如 MRB 返工复检单 —— 即为 NULL，不用空串占位）
  await sql`
    ALTER TABLE inspection_orders
      ADD COLUMN IF NOT EXISTS chain_key VARCHAR(64),
      ADD COLUMN IF NOT EXISTS chain_key_kind VARCHAR(16),
      ADD COLUMN IF NOT EXISTS upstream_order_no VARCHAR(64),
      ADD COLUMN IF NOT EXISTS upstream_gate_code VARCHAR(32);
  `.execute(db);

  // 2. 链路对账索引：按锚点值一次取回同链路全部单据
  await sql`
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_chain_key
      ON inspection_orders (chain_key);
  `.execute(db);

  // 3. 多锚点候选集索引（docs/48 §4.2 仓储 findChainCandidates）：
  //    候选集查询形如 material_code = ? AND order_type = ANY(...) AND batch_no = ANY(...)，
  //    既有索引只有单列 material_code / batch_no，复合索引让该查询走一次索引扫描而不是位图合并。
  //
  //    注意列名：检验类型在本表的**物理列是 `order_type`**（契约与 DTO 里叫 `inspectionType`，
  //    映射在仓储 mapRow / save）。本文件第一版按契约名写成 `inspection_type`，
  //    被 PostgreSQL 以 `column "inspection_type" does not exist` 拒绝（42703）——
  //    迁移在事务里回滚、库未留痕，这里写死以免第二次踩。
  await sql`
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_chain_candidates
      ON inspection_orders (material_code, order_type, batch_no);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_inspection_orders_chain_candidates;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_inspection_orders_chain_key;`.execute(db);
  await sql`
    ALTER TABLE inspection_orders
      DROP COLUMN IF EXISTS upstream_gate_code,
      DROP COLUMN IF EXISTS upstream_order_no,
      DROP COLUMN IF EXISTS chain_key_kind,
      DROP COLUMN IF EXISTS chain_key;
  `.execute(db);
}
