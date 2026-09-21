import { Kysely, sql } from 'kysely';

/**
 * 迁移 009：委外检验 (OQC 七分类) 与工序检验台账字段扩展
 *
 * 为 inspection_orders 表补齐委外加工单号、加工类型、加工商名称与回厂日期，
 * 使【委外检验 - 表面处理检验 / 机加工检验 / 热处理检验】台账的
 * 检验单号 / 委外加工单号 / 加工类型 / 物料编码 / 物料名称 / 数量 /
 * 加工商 / 回厂日期 / 状态 / 检验人 十列全部落到真实数据库列。
 *
 *  - outsource_no:  ERP 委外加工单号（如 WW-20260706-001），建 B-Tree 索引
 *  - process_type:  加工类型/工艺分类（镀锌/镀镍/发黑/磷化/达克罗/热处理/机加工）
 *  - return_date:   委外件回厂登记日期（YYYY-MM-DD）
 *  - vendor_name:   加工商名称快照（无 supplier_code 时的兜底展示口径）
 */
export async function up(db: Kysely<any>): Promise<void> {
  // 0. 重新断言 order_type 取值域：委外七分类 (OQC_HEAT/OQC_MACH 等) 必须可落库。
  //    历史环境可能存在只允许 6 类的旧约束，这里幂等重建，避免迁移顺序造成的口径漂移。
  await sql`ALTER TABLE inspection_orders DROP CONSTRAINT IF EXISTS inspection_orders_order_type_check`.execute(db);
  await sql`
    ALTER TABLE inspection_orders ADD CONSTRAINT inspection_orders_order_type_check
      CHECK (order_type IN ('IQC', 'IPQC_CT', 'IPQC_RL', 'IPQC_FN', 'OQC_SF', 'OQC_SH', 'OQC_HEAT', 'OQC_BLACK', 'OQC_ZINC', 'OQC_NICKEL', 'OQC_PHOSPH', 'OQC_DACRO', 'OQC_MACH'))
  `.execute(db);

  await sql`
    ALTER TABLE inspection_orders
      ADD COLUMN IF NOT EXISTS outsource_no VARCHAR(64),
      ADD COLUMN IF NOT EXISTS process_type VARCHAR(64),
      ADD COLUMN IF NOT EXISTS return_date VARCHAR(32),
      ADD COLUMN IF NOT EXISTS vendor_name VARCHAR(255);
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_outsource_no
      ON inspection_orders (outsource_no);
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_process_type
      ON inspection_orders (process_type);
  `.execute(db);

  // 历史数据回填：委外单号缺失时以批次号占位，回厂日期以单据创建日期兜底
  await sql`
    UPDATE inspection_orders
    SET
      outsource_no = COALESCE(outsource_no, batch_no),
      return_date = COALESCE(return_date, to_char(created_at, 'YYYY-MM-DD'))
    WHERE order_type LIKE 'OQC%';
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_inspection_orders_process_type;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_inspection_orders_outsource_no;`.execute(db);

  await sql`
    ALTER TABLE inspection_orders
      DROP COLUMN IF EXISTS outsource_no,
      DROP COLUMN IF EXISTS process_type,
      DROP COLUMN IF EXISTS return_date,
      DROP COLUMN IF EXISTS vendor_name;
  `.execute(db);
}
