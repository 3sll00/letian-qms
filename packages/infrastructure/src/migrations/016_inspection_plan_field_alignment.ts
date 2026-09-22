import { Kysely, sql } from 'kysely';

/**
 * 迁移 016：质检方案字段口径对齐（`docs/20-质检方案设计页数据字段与接口打通设计.md`）
 *
 * 1. **质检类型取值域**：001 建的 CHECK 只允许 IQC/IPQC/FQC/OQC 四类，002 放宽到 6 类，
 *    但契约 `InspectionTypeEnum` 是 13 类（含委外七分类：热处理/发黑/镀锌/镀镍/磷化/达克罗/机加工）。
 *    同库 `inspection_orders.order_type` 已由 009 对齐为 13 类，方案表被漏掉，导致
 *    「委外热处理来料检验」等方案的 `inspection_stage` 落库直接触发 CHECK 违规。
 *    这里按幂等方式重建约束，取值与契约逐字对齐（契约是系统唯一真理源）。
 *
 * 2. **清理 004 遗留的空转列**：`category_id` / `category_name` / `is_category_default` /
 *    `valid_from` / `valid_to` 五列自建立以来无任何代码写入（实测全为空值 / 建表默认 false），
 *    且每一项都存在唯一真相源，留着只会形成"同一语义两个数据源"：
 *      - `category_id` / `category_name` → `category_code` 联表 `inventory_categories`（全库主数据引用统一用编码）；
 *      - `is_category_default`          → 014 的 `material_code = '' + category_code = X` 分类通用方案约定；
 *      - `valid_from` / `valid_to`      → `sampling_config.effectiveStartDate / effectiveEndDate`（014 已定口径）。
 *    展示所需的 `materialName` / `createdByName` / `categoryName` 一律读时 JOIN 派生，不落快照列
 *    （理由见 docs/20 §2.3：方案是可维护配置，不同于必须固化"当时检的是什么"的检验工单）。
 *
 * 幂等约定：约束重建为 DROP + ADD；删列全部带 IF NOT EXISTS/DROP COLUMN IF EXISTS。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. 质检类型对齐契约 InspectionTypeEnum 全量 13 值
  // ---------------------------------------------------------------------------
  await sql`ALTER TABLE inspection_plans DROP CONSTRAINT IF EXISTS inspection_plans_inspection_stage_check`.execute(db);
  await sql`
    ALTER TABLE inspection_plans ADD CONSTRAINT inspection_plans_inspection_stage_check
      CHECK (inspection_stage IN ('IQC', 'IPQC_CT', 'IPQC_RL', 'IPQC_FN', 'OQC_SF', 'OQC_SH', 'OQC_HEAT', 'OQC_BLACK', 'OQC_ZINC', 'OQC_NICKEL', 'OQC_PHOSPH', 'OQC_DACRO', 'OQC_MACH'))
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 2. 删除 004 遗留的 5 个空转列（唯一真相源见文件头注释）
  // ---------------------------------------------------------------------------
  await sql`
    ALTER TABLE inspection_plans
      DROP COLUMN IF EXISTS category_id,
      DROP COLUMN IF EXISTS category_name,
      DROP COLUMN IF EXISTS is_category_default,
      DROP COLUMN IF EXISTS valid_from,
      DROP COLUMN IF EXISTS valid_to;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // 回滚前先确认库里没有委外七分类方案：否则恢复 6 值约束会与既有数据冲突，
  // 这里显式报错中止，而不是静默留下脏数据（与 002 的 SET NOT NULL 处理同一原则）。
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM inspection_plans
        WHERE inspection_stage NOT IN ('IQC', 'IPQC_CT', 'IPQC_RL', 'IPQC_FN', 'OQC_SF', 'OQC_SH')
      ) THEN
        RAISE EXCEPTION '存在委外七分类质检方案，回滚 016 会破坏既有数据，请先清理后再执行';
      END IF;
    END $$;
  `.execute(db);

  await sql`ALTER TABLE inspection_plans DROP CONSTRAINT IF EXISTS inspection_plans_inspection_stage_check`.execute(db);
  await sql`
    ALTER TABLE inspection_plans ADD CONSTRAINT inspection_plans_inspection_stage_check
      CHECK (inspection_stage IN ('IQC', 'IPQC_CT', 'IPQC_RL', 'IPQC_FN', 'OQC_SF', 'OQC_SH'))
  `.execute(db);

  await sql`
    ALTER TABLE inspection_plans
      ADD COLUMN IF NOT EXISTS category_id VARCHAR(64),
      ADD COLUMN IF NOT EXISTS category_name VARCHAR(128),
      ADD COLUMN IF NOT EXISTS is_category_default BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ;
  `.execute(db);
}
