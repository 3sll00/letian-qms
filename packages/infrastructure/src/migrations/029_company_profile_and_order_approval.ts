import { Kysely, sql } from 'kysely';

/**
 * 迁移 029：企业档案主数据 + 检验单质量负责人签核（docs/35 §5 / §6）
 *
 * 1. `company_profile`：证书抬头「签发主体 / 供货单位 / 产地」此前没有主数据源，两处模板把
 *    企业名与印章文字**硬编码**在组件里（`QualityCertificateTemplate` / `ManufacturingCertTemplate`），
 *    既改不动也无法审计。本迁移建单行主数据表，并把现有硬编码常量**原样迁入**（值不变，
 *    只是从代码搬到数据），`address` / `origin_place` / `phone` / `email` 等未确认信息留 NULL 等业务填写。
 *    单行约束用 `profile_id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (profile_id)`：插 true 两次会撞主键，
 *    插 false 撞 CHECK，结构上不可能出现第二行。
 *
 * 2. `inspection_orders` 签核列：制造证书的「质量负责人」栏此前无任何数据源（永远留白）。
 *    补 `approver_id` / `approver_name` / `approved_at` 三列 + 指向 `employees` 的外键，
 *    由 `POST /inspections/{id}/approve` 写入**真实签核动作**（签核人 = 当前登录用户）。
 *    未签核即三列为 NULL —— 证书留白，不打印任何人名。
 *
 * 幂等：`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` + `DO $$ ... pg_constraint` 建外键；
 * 初始行为 `ON CONFLICT (profile_id) DO NOTHING`（已维护过的库不会被本迁移覆盖）。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 企业档案（单行）
  await sql`
    CREATE TABLE IF NOT EXISTS company_profile (
      profile_id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (profile_id),
      legal_name VARCHAR(128),
      legal_name_en VARCHAR(160),
      short_name VARCHAR(64),
      address VARCHAR(255),
      origin_place VARCHAR(64),
      phone VARCHAR(32),
      email VARCHAR(96),
      quality_stamp VARCHAR(64),
      updated_by VARCHAR(64),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  // 2. 初始行：由模板里的既有硬编码常量迁移而来（不新增任何未经确认的信息）
  await sql`
    INSERT INTO company_profile (profile_id, legal_name, legal_name_en, quality_stamp, updated_by)
    VALUES (
      TRUE,
      '宁波乐天紧固件制造有限公司',
      'NINGBO LETIAN FASTENERS MANUFACTURING CO., LTD.',
      '宁波乐天质检',
      'migration-029'
    )
    ON CONFLICT (profile_id) DO NOTHING
  `.execute(db);

  // 3. 检验单质量负责人签核列
  await sql`
    ALTER TABLE inspection_orders
      ADD COLUMN IF NOT EXISTS approver_id UUID,
      ADD COLUMN IF NOT EXISTS approver_name VARCHAR(64),
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ
  `.execute(db);

  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_inspection_orders_approver'
      ) THEN
        ALTER TABLE inspection_orders
          ADD CONSTRAINT fk_inspection_orders_approver
          FOREIGN KEY (approver_id) REFERENCES employees(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `.execute(db);

  console.log('[029] 已建企业档案表（含硬编码常量迁入的初始行）与检验单签核列（approver_id/approver_name/approved_at）');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // 1. 拆签核列与约束
  await sql`ALTER TABLE inspection_orders DROP CONSTRAINT IF EXISTS fk_inspection_orders_approver`.execute(db);
  await sql`
    ALTER TABLE inspection_orders
      DROP COLUMN IF EXISTS approver_id,
      DROP COLUMN IF EXISTS approver_name,
      DROP COLUMN IF EXISTS approved_at
  `.execute(db);

  // 2. 拆企业档案表（含主数据行；回滚即回到「抬头写在模板里」的旧形态）
  await sql`DROP TABLE IF EXISTS company_profile`.execute(db);

  console.log('[029] 已回滚企业档案表与检验单签核列');
}