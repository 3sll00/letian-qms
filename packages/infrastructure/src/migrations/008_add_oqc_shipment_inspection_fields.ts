import { Kysely, sql } from 'kysely';

/**
 * 迁移 008：出货检验 (OQC) 业务字段扩展
 *
 * 为 inspection_orders 表新增出货检验专属字段：
 *  - sales_order_no: 销售出库单号（如 SO-20260706-01）
 *  - dispatch_date: 出库日期（如 2026-07-06）
 *  - customer_name: 客户全称（如 客户A科技）
 *  - sales_order_po_no: 客户采购订单号/合同号（如 PO-A-001）
 *  - erp_status: ERP同步与审核状态（待审核/已审核/已拦截）
 */
export async function up(db: Kysely<any>): Promise<void> {
  // 1. 扩展 inspection_orders 表字段
  await sql`
    ALTER TABLE inspection_orders
      ADD COLUMN IF NOT EXISTS sales_order_no VARCHAR(64),
      ADD COLUMN IF NOT EXISTS dispatch_date VARCHAR(32),
      ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS sales_order_po_no VARCHAR(64),
      ADD COLUMN IF NOT EXISTS erp_status VARCHAR(32);
  `.execute(db);

  // 2. 建立针对出库单号和客户名称的辅助索引
  await sql`
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_sales_order_no
      ON inspection_orders (sales_order_no);
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_customer_name
      ON inspection_orders (customer_name);
  `.execute(db);

  // 3. 回填现有出货检验 (OQC) 种子与历史数据的出库及对账字段
  await sql`
    UPDATE inspection_orders
    SET
      sales_order_no = COALESCE(sales_order_no, 'SO-' || to_char(created_at, 'YYYYMMDD') || '-01'),
      dispatch_date = COALESCE(dispatch_date, to_char(created_at, 'YYYY-MM-DD')),
      customer_name = COALESCE(customer_name, '客户A科技'),
      sales_order_po_no = COALESCE(sales_order_po_no, 'PO-' || to_char(created_at, 'YYYYMMDD') || '-01'),
      erp_status = COALESCE(erp_status, '已审核')
    WHERE order_type IN ('OQC_SF', 'OQC_SH');
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_inspection_orders_customer_name;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_inspection_orders_sales_order_no;`.execute(db);

  await sql`
    ALTER TABLE inspection_orders
      DROP COLUMN IF EXISTS sales_order_no,
      DROP COLUMN IF EXISTS dispatch_date,
      DROP COLUMN IF EXISTS customer_name,
      DROP COLUMN IF EXISTS sales_order_po_no,
      DROP COLUMN IF EXISTS erp_status;
  `.execute(db);
}
