import { Kysely, sql } from 'kysely';

/**
 * 迁移 017：质检方案编码 (plan_code) 流水号池
 *
 * 背景：`plan_code` 此前完全由调用方传入，页面「复制方案」用的是
 * `{原编码}-C{时间戳后 6 位}`，新建弹窗用的是 `QP-{年份}-{随机数}` —— 既无当日流水段、
 * 也无并发保护（随机数会撞号，且同一方案复制两次可能取到不同形态的编码）。
 * 设计稿与演示数据里方案库的编号形态是 `QP-{YYYYMMDD}-{NNN}`（见 docs/09 §2.6、
 * apps/web/src/mocks/data.ts 的 mockPlans），本迁移即为该形态建立服务端取号池。
 *
 * 做法与迁移 012（检验单号流水号池）完全一致，只做一件事：
 * 建立**按 (前缀, 建单日期) 分配的流水号池表**，供仓储层 `allocatePlanCodeSequence`
 * 以原子 upsert 取号，从而在不引入全局序列锁的前提下保证并发建方案不重号。
 *
 * 同时把库中**已存在的合规方案编码**（形如 `QP-YYYYMMDD-NNN`）回填进池子，避免新编码与历史编码撞号；
 * 人工指定的语义化编码（如 `QP-IQC-304SS`）不参与回填 —— 其文本形态与流水号编码不可能相等。
 *
 * 安全边界：纯新增表 + 只读聚合回填，不修改/删除 inspection_plans 任何既有数据。
 */
export async function up(db: Kysely<any>): Promise<void> {
  // 1. 建流水号池表：主键 (prefix, day_key) 同时充当并发取号的排他锁点
  await sql`
    CREATE TABLE IF NOT EXISTS inspection_plan_code_sequences (
      prefix VARCHAR(32) NOT NULL,
      day_key CHAR(8) NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (prefix, day_key)
    );
  `.execute(db);

  // 2. 回填历史合规方案编码：按 (前缀, 日期) 取已用最大流水号，保证新编码严格递增不撞号
  await sql`
    INSERT INTO inspection_plan_code_sequences (prefix, day_key, last_seq, updated_at)
    SELECT
      'QP' AS prefix,
      substring(plan_code from '([0-9]{8})-[0-9]{3}$') AS day_key,
      MAX((regexp_match(plan_code, '-([0-9]{3})$'))[1]::int) AS last_seq,
      now()
    FROM inspection_plans
    WHERE plan_code ~ '^QP-[0-9]{8}-[0-9]{3}$'
    GROUP BY 1, 2
    ON CONFLICT (prefix, day_key)
    DO UPDATE SET
      last_seq = GREATEST(inspection_plan_code_sequences.last_seq, EXCLUDED.last_seq),
      updated_at = now();
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS inspection_plan_code_sequences;`.execute(db);
}
