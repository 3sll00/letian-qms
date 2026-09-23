import { Kysely, sql } from 'kysely';

/**
 * 迁移 030：委外检验「录入页业务事实」字段落库（docs/36）
 *
 * 背景：委外检验录入表单（`OutsourceInspectionForm.tsx`）上有三栏是检验员真的会填的业务事实，
 * 但此前**没有任何物理列**，提交时被契约 zod 白名单静默丢弃 —— 重新打开单据或重导证书即丢失：
 *
 *  - material_grade:  材质牌号 / 强度等级（如 10.9级 / 35CrMo / ML40Cr）
 *  - tech_standard:   执行技术标准与工艺规范（如 GB/T 3098.1-2010 / ISO 10683）。
 *                     它是制造证书 `Specification (执行规范)` 行的唯一来源。
 *  - inspected_date:  检验日期 YYYY-MM-DD（检验动作真实发生日，制造证书 Issue Date 的真实来源）
 *
 * 设计口径（与 docs/32 §2.2 / docs/34 §3 一致）：
 *  1. **不回填历史行**：三列对历史数据都没有可信来源（牌号不能从物料名称猜、标准号不能用方案号顶替、
 *     检验日期已知的只有建单时间），故刻意留 NULL，读侧为空即不输出该键、界面留空。
 *  2. **不建索引**：三列均不参与台账筛选（台账原型无对应列），建索引只增写放大。
 *  3. **幂等**：ADD COLUMN IF NOT EXISTS；down() 用 DROP COLUMN IF EXISTS 还原。
 *  4. 009 的四个委外台账列（outsource_no / process_type / return_date / vendor_name）语义不变，本迁移不碰。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE inspection_orders
      ADD COLUMN IF NOT EXISTS material_grade VARCHAR(64),
      ADD COLUMN IF NOT EXISTS tech_standard VARCHAR(255),
      ADD COLUMN IF NOT EXISTS inspected_date VARCHAR(32);
  `.execute(db);

  console.log(
    '[030] 已为 inspection_orders 补委外录入页业务事实列（material_grade / tech_standard / inspected_date），历史行留 NULL'
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE inspection_orders
      DROP COLUMN IF EXISTS material_grade,
      DROP COLUMN IF EXISTS tech_standard,
      DROP COLUMN IF EXISTS inspected_date;
  `.execute(db);
}
