import { Kysely, sql } from 'kysely';

/**
 * 迁移 020：追溯节点血缘标识字段打通（`docs/24-质量追溯看板界面评审与改造建议.md` §5.1）
 *
 * **E1 节点缺"批次标识"，卡片回不到实物**：`batch_trace_nodes` 只有 `batch_no` 与 `order_no`，
 * 没有 `material_code` / `furnace_heat_batch_no` / `inspection_order_no`；而 PRD §3.1 与
 * `docs/09-界面与开源组件.md` 的原型索引都把「炉批号」列为追溯第一标识，界面原型也一直渲染
 * 「炉批号」「检验单号」两行 → 本迁移补列。
 *
 * **E2 特采节点无法如实落库**：`batch_trace_nodes_node_status_check` 只允许 5 个取值，
 * 而 MRB 侧的处置结论已含 `CONCESSION`（特采 / 让步接收）。特采放行的批次在追溯链上必须能
 * 如实标记为特采，否则只能被塞进 `PASSED`，等于口径造假 → 本迁移放宽为 6 个取值。
 * `CONCESSION` 与 `MRBDispositionEnum.CONCESSION` 同名同义，不新造术语。
 *
 * 幂等约定：`ADD COLUMN IF NOT EXISTS`；CHECK 约束先 `DROP CONSTRAINT IF EXISTS` 再重建；
 * 回填只更新「值仍为 NULL」的行，重复执行为空操作。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 血缘标识列
  await sql`
    ALTER TABLE batch_trace_nodes
      ADD COLUMN IF NOT EXISTS material_code VARCHAR(64),
      ADD COLUMN IF NOT EXISTS furnace_heat_batch_no VARCHAR(64),
      ADD COLUMN IF NOT EXISTS inspection_order_no VARCHAR(64)
  `.execute(db);

  // 2. 回填检验单号：历史种子把检验单号直接写在 order_no 里（如 INS-20231012-005）
  await sql`
    UPDATE batch_trace_nodes
       SET inspection_order_no = order_no
     WHERE inspection_order_no IS NULL
       AND order_no IS NOT NULL
       AND order_no ~ '^(INS|IQC|IPQC|OQC)-'
  `.execute(db);

  // 3. 回填物料编码：按物料名称在 materials 主数据里精确匹配；未建档的保持 NULL（前端显示 —）
  await sql`
    UPDATE batch_trace_nodes n
       SET material_code = m.material_code
      FROM materials m
     WHERE n.material_code IS NULL
       AND m.material_name = n.material_name
  `.execute(db);

  // 4. 放宽节点状态 CHECK：新增 CONCESSION（特采 / 让步接收）
  await sql`
    ALTER TABLE batch_trace_nodes DROP CONSTRAINT IF EXISTS batch_trace_nodes_node_status_check
  `.execute(db);

  await sql`
    ALTER TABLE batch_trace_nodes
      ADD CONSTRAINT batch_trace_nodes_node_status_check
      CHECK (
        (node_status)::text = ANY (
          (ARRAY[
            'PASSED'::character varying,
            'FAILED'::character varying,
            'INSPECTING'::character varying,
            'PENDING'::character varying,
            'STORED'::character varying,
            'CONCESSION'::character varying
          ])::text[]
        )
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // 1. 先拆约束：存量 CONCESSION 行必须先归一到 FAILED，否则重建 5 值约束会失败
  await sql`
    ALTER TABLE batch_trace_nodes DROP CONSTRAINT IF EXISTS batch_trace_nodes_node_status_check
  `.execute(db);

  await sql`
    UPDATE batch_trace_nodes SET node_status = 'FAILED' WHERE node_status = 'CONCESSION'
  `.execute(db);

  await sql`
    ALTER TABLE batch_trace_nodes
      ADD CONSTRAINT batch_trace_nodes_node_status_check
      CHECK (
        (node_status)::text = ANY (
          (ARRAY[
            'PASSED'::character varying,
            'FAILED'::character varying,
            'INSPECTING'::character varying,
            'PENDING'::character varying,
            'STORED'::character varying
          ])::text[]
        )
      )
  `.execute(db);

  // 2. 回退血缘标识列
  await sql`
    ALTER TABLE batch_trace_nodes
      DROP COLUMN IF EXISTS material_code,
      DROP COLUMN IF EXISTS furnace_heat_batch_no,
      DROP COLUMN IF EXISTS inspection_order_no
  `.execute(db);
}
