import { Kysely, sql } from 'kysely';

/**
 * 迁移 034：出货检验「炉批号」数据关联（docs/47）—— 溯源留痕列 + 归一化索引
 *
 * 背景（docs/47 §2 断链清单 D1）：
 *   炉批号的物理列 `inspection_orders.furnace_heat_batch_no` 早已由迁移 004 建好，
 *   但全仓**没有任何写入路径**，列恒为 NULL —— 服务端 `HeatBatchTraceService` 的
 *   三级关联算法（委外热处理 -> 来料检验 -> NONE）因此恒走空态，客户需求 R1/R2/R4 全部不可见。
 *
 * 本次动作（**复用既有炉批号列，不新造同义列**）：
 *   1. 新增两列溯源留痕：`heat_source_type` / `heat_source_order_no`
 *      —— 记录「本单的炉批号数据带出自哪张上游检验单」，支撑 docs/47 §3.6 R5 的
 *      「继承可追溯」（EN 10204 3.1 证书对炉号与实测值来源可追溯的要求）；
 *   2. 新增**生成列** `furnace_heat_batch_no_norm`：由 SQL 侧统一归一
 *      （trim / 大写 / 去空格与连字符、下划线、全角空格），写入无需应用层参与，
 *      **原值仍落在 `furnace_heat_batch_no`**（比较用归一值、展示与证书用原值）；
 *   3. 归一列上建 btree 索引，供 `findByFurnaceHeatNo` 走等值查询（docs/47 §4.4）。
 *
 * 归一化口径（唯一真相，TS 侧同式实现在 @letian/domain 的 normalizeHeatBatchNo）：
 *   upper(regexp_replace(原值, '[\s\-_\u3000]', '', 'g'))
 *
 * 转义口径（本轮实测踩过两次坑，写死在这里防复发）：
 *   - 字符类只能用**标准字符串字面量 + 反斜杠成对转义**（TS 源码写 `'[\\s\\-_\\u3000]'`），
 *     此时 PostgreSQL 的 `standard_conforming_strings = on`（默认）会把反斜杠原样交给正则引擎；
 *   - 写成 TS 单反斜杠 `'[\s\-_　]'`：JS 字符串会先把 `\s` 吃掉 -> SQL 里退化成 `[s-_　]`（非法区间）；
 *   - 写成 E-string `E'[\s\-_\u3000]'`：PostgreSQL 的 E-string 解析器同样把 `\s` 当未知转义吃掉 -> 同样退化。
 *
 * 安全边界：**纯新增列与索引**；不修改、不删除任何既有行，不回填真实单据的炉批号
 * （真实炉批号只能来自现场单据与 MTC，QMS 不得凭空生成 —— 同 docs/46 的「不编造」红线；
 *  演示 / 联调数据另走 `pnpm db:demo:heat-trace`，且一律带 TEST2609- 前缀，见 docs/47 §3.8）。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 溯源留痕两列（可空：未发生带出即为 NULL，不用空串占位）
  await sql`
    ALTER TABLE inspection_orders
      ADD COLUMN IF NOT EXISTS heat_source_type VARCHAR(32),
      ADD COLUMN IF NOT EXISTS heat_source_order_no VARCHAR(64);
  `.execute(db);

  // 2. 归一化生成列（GENERATED ALWAYS ... STORED：写入侧零改动，读侧可等值比较）
  //
  //    字符类必须把反斜杠**成对转义**（源码 `\\s` -> SQL `\s`）：`\s` = 任意空白（含制表符），
  //    `\u3000` = 全角空格。两种错误写法（单反斜杠 / E-string）都会静默退化成非法区间，见文件头说明。
  await sql`
    ALTER TABLE inspection_orders
      ADD COLUMN IF NOT EXISTS furnace_heat_batch_no_norm VARCHAR(64)
        GENERATED ALWAYS AS (upper(regexp_replace(furnace_heat_batch_no, '[\\s\\-_\\u3000]', '', 'g'))) STORED;
  `.execute(db);

  // 3. 索引：归一列 btree（等值查询）+ 原列 btree（按原值对账 / 台账筛选）
  await sql`
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_heat_norm
      ON inspection_orders (furnace_heat_batch_no_norm);
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_heat_raw
      ON inspection_orders (furnace_heat_batch_no);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_inspection_orders_heat_norm;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_inspection_orders_heat_raw;`.execute(db);
  await sql`
    ALTER TABLE inspection_orders
      DROP COLUMN IF EXISTS furnace_heat_batch_no_norm,
      DROP COLUMN IF EXISTS heat_source_type,
      DROP COLUMN IF EXISTS heat_source_order_no;
  `.execute(db);
}
