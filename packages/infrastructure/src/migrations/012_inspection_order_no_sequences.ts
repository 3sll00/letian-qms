import { Kysely, sql } from 'kysely';

/**
 * 迁移 012：检验单号 (order_no) 流水号池
 *
 * 背景：检验单号此前由应用层即席生成（`INS-${Date.now()}-${随机数}`），既无检验类型前缀、
 * 也无日期段与定长流水段，与文档化的编号规则 `{PREFIX}-{YYYYMMDD}-{NNNN}`
 * （如出货检验 `OQC-SH-20260706-0001`，见 docs/09 §2.3、docs/16 §1）不一致，
 * 导致【出货检验】列表首列「检验单号」无法呈现业务可读单号。
 *
 * 本迁移只做一件事：建立**按 (前缀, 建单日期) 分配的流水号池表**，供仓储层
 * `allocateOrderNoSequence` 以原子 upsert 取号，从而在不引入全局序列锁的前提下保证并发不重号。
 *
 * 同时把库中**已存在**的合规单号（形如 `PREFIX-YYYYMMDD-NNNN`）回填进池子，
 * 避免新建单号与历史单号撞号；不合规的历史单号（如三段式 `INS-20231012-006`、
 * 复检后缀 `...-R2`）不参与回填，因其文本形态与 4 位定长新单号不可能相等。
 *
 * 安全边界：纯新增表 + 只读聚合回填，不修改/删除 inspection_orders 任何既有数据。
 */
export async function up(db: Kysely<any>): Promise<void> {
  // 1. 建流水号池表：主键 (prefix, day_key) 同时充当并发取号的排他锁点
  await sql`
    CREATE TABLE IF NOT EXISTS inspection_order_no_sequences (
      prefix VARCHAR(32) NOT NULL,
      day_key CHAR(8) NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (prefix, day_key)
    );
  `.execute(db);

  // 2. 回填历史合规单号：按 (前缀, 日期) 取已用最大流水号，保证新单号严格递增不撞号
  await sql`
    INSERT INTO inspection_order_no_sequences (prefix, day_key, last_seq, updated_at)
    SELECT
      regexp_replace(order_no, '-[0-9]{8}-[0-9]{4}$', '') AS prefix,
      substring(order_no from '([0-9]{8})-[0-9]{4}$') AS day_key,
      MAX((regexp_match(order_no, '-([0-9]{4})$'))[1]::int) AS last_seq,
      now()
    FROM inspection_orders
    WHERE order_no ~ '^[A-Z0-9-]+-[0-9]{8}-[0-9]{4}$'
    GROUP BY 1, 2
    ON CONFLICT (prefix, day_key)
    DO UPDATE SET
      last_seq = GREATEST(inspection_order_no_sequences.last_seq, EXCLUDED.last_seq),
      updated_at = now();
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS inspection_order_no_sequences;`.execute(db);
}
