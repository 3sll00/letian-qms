import { Kysely, sql } from 'kysely';

/**
 * 迁移 014：质检方案「分类兜底」与「生效周期」字段链路
 *
 * 背景：docs/17-检验录入界面说明与质检方案匹配口径.md §7.6 记录的两项待办：
 *
 *  1. **分类级兜底 (TBD-01)**：需求要求"根据物料自动匹配质检方案"，但此前只能命中
 *     物料专属方案（`material_code` 精确相等）。新物料 / 通用件首次送检必然匹配不到，
 *     现场只能先停线等工程师建方案。本迁移补 `category_code` 列，使匹配可两级下沉：
 *     第一级 = 物料专属方案，第二级 = 该物料所属存货分类的通用方案（`material_code = ''`）。
 *
 *  2. **生效周期 (TBD-02)**：契约 `InspectionPlanVersionSchema` 早已声明
 *     `effectiveStartDate / effectiveEndDate`，但从未落库、匹配时也不看有效期，
 *     换版期间可能命中已过期方案。方案版本级属性（抽样方案 / AQL / 严格度）统一存放在
 *     `sampling_config` JSONB 中，生效周期与它们同属版本级属性，因此同样落在该 JSONB 内，
 *     不额外开列（避免同一契约对象被拆到两处存储）。
 *
 * 幂等约定：DDL 全部带 IF NOT EXISTS；回填只在 `category_code IS NULL` 时生效，不覆盖既有值。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. 方案分类列（分类兜底匹配的检索键）
  // ---------------------------------------------------------------------------
  await sql`
    ALTER TABLE inspection_plans
      ADD COLUMN IF NOT EXISTS category_code VARCHAR(64);
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 2. 存量回填：物料专属方案按其物料主数据的分类补齐归属
  //    （分类通用方案的 material_code 为空串，无法由物料反查，保持空值由业务侧维护）
  // ---------------------------------------------------------------------------
  await sql`
    UPDATE inspection_plans p
    SET category_code = m.category_code
    FROM materials m
    WHERE p.category_code IS NULL
      AND p.material_code <> ''
      AND m.material_code = p.material_code;
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 3. 分类兜底匹配索引：category_code + inspection_stage + version_status
  // ---------------------------------------------------------------------------
  await sql`
    CREATE INDEX IF NOT EXISTS idx_plans_category_stage_status
      ON inspection_plans (category_code, inspection_stage, version_status);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS idx_plans_category_stage_status;
  `.execute(db);

  await sql`
    ALTER TABLE inspection_plans
      DROP COLUMN IF EXISTS category_code;
  `.execute(db);
}
