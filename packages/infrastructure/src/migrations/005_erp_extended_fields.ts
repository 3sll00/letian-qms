import { Kysely, sql } from 'kysely';

/**
 * 005 —— 管家婆 ERP 扩展字段集成迁移：
 * 1. 客户主表 (customers) 增加 address 字段（对账自 Btype.TelAndAddress）
 * 2. 检验工单表 (inspection_orders) 增加：
 *    - customer_address (客户送货/收货地址)
 *    - project_no (项目编号，对账自 Dlyndx.projectid)
 *    - short_project_no (短项目号，对账自自定义项/编码截取)
 *    - manufacture_date (制造日期，对账自 DlySale.ProduceDate)
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. customers 表扩充 address
  await sql`
    ALTER TABLE customers
      ADD COLUMN IF NOT EXISTS address VARCHAR(255);
  `.execute(db);

  // 2. inspection_orders 扩充客户地址、项目号、短项目号、制造日期
  await sql`
    ALTER TABLE inspection_orders
      ADD COLUMN IF NOT EXISTS customer_address VARCHAR(255),
      ADD COLUMN IF NOT EXISTS project_no VARCHAR(64),
      ADD COLUMN IF NOT EXISTS short_project_no VARCHAR(64),
      ADD COLUMN IF NOT EXISTS manufacture_date TIMESTAMPTZ;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE inspection_orders
      DROP COLUMN IF EXISTS customer_address,
      DROP COLUMN IF EXISTS project_no,
      DROP COLUMN IF EXISTS short_project_no,
      DROP COLUMN IF EXISTS manufacture_date;
  `.execute(db);

  await sql`
    ALTER TABLE customers
      DROP COLUMN IF EXISTS address;
  `.execute(db);
}
