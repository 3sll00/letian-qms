import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE inspection_orders
      ADD COLUMN IF NOT EXISTS receipt_no VARCHAR(64),
      ADD COLUMN IF NOT EXISTS receipt_date TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS specification VARCHAR(255),
      ADD COLUMN IF NOT EXISTS unit VARCHAR(32),
      ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS inspector_name VARCHAR(64);
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_receipt_no
      ON inspection_orders (receipt_no);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS idx_inspection_orders_receipt_no;
  `.execute(db);

  await sql`
    ALTER TABLE inspection_orders
      DROP COLUMN IF EXISTS receipt_no,
      DROP COLUMN IF EXISTS receipt_date,
      DROP COLUMN IF EXISTS specification,
      DROP COLUMN IF EXISTS unit,
      DROP COLUMN IF EXISTS supplier_name,
      DROP COLUMN IF EXISTS inspector_name;
  `.execute(db);
}
