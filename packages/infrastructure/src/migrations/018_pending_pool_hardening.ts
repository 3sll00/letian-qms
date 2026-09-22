import { Kysely, sql } from 'kysely';

/**
 * 迁移 018：待审核池外键完整性加固（`docs/21-MRB不合格品处置数据字段与接口打通设计.md` §9 遗留闭环）
 *
 * **孤儿池条目防治**：`pending_mrb_items.source_order_id` 在 004 建表时是 `VARCHAR(64)`，
 * 与 `inspection_orders.id`（UUID）之间没有外键 —— 源检验单被删除后池条目会残留：
 * 界面里看得见，点「发起评审」永远 404（docs/21 §3.2 D10 实测复现）。
 * 本迁移先把列类型对齐 UUID，再补 `fk_pending_mrb_source_order`（`ON DELETE CASCADE`），
 * 让「检验单删除 ⇒ 池条目同步撤销」成为**数据库约束**，而不是靠调用方自觉。
 *
 * 说明：PBAC 三维过滤的分类维度不需要新增冗余列 —— 池表已有 `material_code`，
 * 分类归属由 `materials.category_code` 子查询提供（与 inspection_orders / mrb_reviews
 * 读侧完全同一口径，见 `repositories/pbac-sql-translator.ts`）。
 *
 * 幂等约定：列类型转换用 DO 块判断当前类型后执行；约束一律 DROP IF EXISTS + ADD。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 历史脏数据清理：非 UUID 的 source_order_id 无法与检验单建立外键，
  //    属不可追溯记录（源单号仍留在 source_order_no 列，便于人工核查）。
  await sql`
    DELETE FROM pending_mrb_items
    WHERE source_order_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  `.execute(db);

  // 2. 列类型 VARCHAR(64) -> UUID（已是 uuid 时跳过，避免无谓的全表重写）
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'pending_mrb_items'
          AND column_name = 'source_order_id'
          AND data_type <> 'uuid'
      ) THEN
        ALTER TABLE pending_mrb_items
          ALTER COLUMN source_order_id TYPE UUID USING source_order_id::uuid;
      END IF;
    END $$;
  `.execute(db);

  // 3. 外键：删除检验单时同批撤销其池条目（不再产生"源单已删"的孤儿待办）
  await sql`ALTER TABLE pending_mrb_items DROP CONSTRAINT IF EXISTS fk_pending_mrb_source_order`.execute(
    db
  );
  await sql`
    ALTER TABLE pending_mrb_items ADD CONSTRAINT fk_pending_mrb_source_order
      FOREIGN KEY (source_order_id) REFERENCES inspection_orders(id) ON DELETE CASCADE
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE pending_mrb_items DROP CONSTRAINT IF EXISTS fk_pending_mrb_source_order`.execute(
    db
  );
  await sql`
    ALTER TABLE pending_mrb_items
      ALTER COLUMN source_order_id TYPE VARCHAR(64) USING source_order_id::text
  `.execute(db);
}
