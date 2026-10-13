import { Kysely, sql } from 'kysely';

/**
 * 迁移 039：质检方案「检验类型多选」支持列 `inspection_plans.inspection_types`
 *
 * 背景：新建质检方案弹窗的「质检类型」由单选改为可单选可多选——
 * 同一套检验指标项可以服务多个检验环节/工序类型（对应 ERP 方案主表
 * `T_Inf_PtypeCheckingSchemeNdx.GxTypeId` 一对多场景的扩展）。
 *
 * 口径：
 *   inspection_stage    保留不动 —— 仍是方案的**主类型**（多选集合的第一个），
 *                       既有 CHECK 约束、历史数据、展示口径全部向后兼容；
 *   inspection_types    jsonb 数组 = 方案适用的检验类型全集（含主类型），
 *                       方案匹配 / 列表筛选按「数组包含检验类型」判定（? 运算符）。
 *
 * 存量回填：inspection_types = [inspection_stage]，回填后该列与主类型等价，
 * 因此可直接置 NOT NULL 并把匹配谓词统一到新列上（不存在 NULL 歧义行）。
 *
 * 安全边界：加列 + 回填 + 约束，不改既有列；down 仅删新列。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE inspection_plans
      ADD COLUMN IF NOT EXISTS inspection_types JSONB;
  `.execute(db);

  // 存量行回填：全集 = [主类型]，保证新谓词 `inspection_types ? :type` 对老数据同样成立
  await sql`
    UPDATE inspection_plans
       SET inspection_types = jsonb_build_array(inspection_stage)
     WHERE inspection_types IS NULL;
  `.execute(db);

  await sql`
    ALTER TABLE inspection_plans
      ALTER COLUMN inspection_types SET NOT NULL,
      ADD CONSTRAINT inspection_plans_types_is_array
        CHECK (jsonb_typeof(inspection_types) = 'array');
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE inspection_plans
      DROP CONSTRAINT IF EXISTS inspection_plans_types_is_array,
      DROP COLUMN IF EXISTS inspection_types;
  `.execute(db);
}
