import { Kysely, sql } from 'kysely';

/**
 * 021 来料检验 (IQC) 台账「入库单号」口径统一（采购入库单号 -> 入库单号）
 *
 * 业务口径：台账列【采购入库单号】与【入库单号】指同一个业务对象（ERP 采购入库单），
 * 因此全链路收敛为「入库单号 / 入库日期」，物理列与契约字段同步改名：
 *   inspection_orders.receipt_no   -> inspection_orders.inbound_no
 *   inspection_orders.receipt_date -> inspection_orders.inbound_date
 *   idx_inspection_orders_receipt_no -> idx_inspection_orders_inbound_no
 *
 * 安全性：
 *   1. RENAME COLUMN 只改列名，不重建、不搬数据，存量值原样保留；
 *   2. 所有动作均以 information_schema / pg_class 守卫，重复执行不报错；
 *   3. 旧列不存在（库中已是新列名）时整段为 no-op。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'inspection_orders'
          AND column_name = 'receipt_no'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'inspection_orders'
          AND column_name = 'inbound_no'
      ) THEN
        ALTER TABLE inspection_orders RENAME COLUMN receipt_no TO inbound_no;
      END IF;
    END $$;
  `.execute(db);

  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'inspection_orders'
          AND column_name = 'receipt_date'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'inspection_orders'
          AND column_name = 'inbound_date'
      ) THEN
        ALTER TABLE inspection_orders RENAME COLUMN receipt_date TO inbound_date;
      END IF;
    END $$;
  `.execute(db);

  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_inspection_orders_receipt_no' AND relkind = 'i')
         AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_inspection_orders_inbound_no' AND relkind = 'i')
      THEN
        ALTER INDEX idx_inspection_orders_receipt_no RENAME TO idx_inspection_orders_inbound_no;
      END IF;
    END $$;
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_inspection_orders_inbound_no
      ON inspection_orders (inbound_no);
  `.execute(db);

  await sql`
    COMMENT ON COLUMN inspection_orders.inbound_no
      IS '入库单号（ERP 采购入库单 Dlyndx.Number, VchType=161）';
  `.execute(db);

  await sql`
    COMMENT ON COLUMN inspection_orders.inbound_date
      IS '入库日期（ERP 采购入库制单日期 Dlyndx.Date）';
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_inspection_orders_inbound_no' AND relkind = 'i')
         AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_inspection_orders_receipt_no' AND relkind = 'i')
      THEN
        ALTER INDEX idx_inspection_orders_inbound_no RENAME TO idx_inspection_orders_receipt_no;
      END IF;
    END $$;
  `.execute(db);

  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'inspection_orders'
          AND column_name = 'inbound_no'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'inspection_orders'
          AND column_name = 'receipt_no'
      ) THEN
        ALTER TABLE inspection_orders RENAME COLUMN inbound_no TO receipt_no;
      END IF;
    END $$;
  `.execute(db);

  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'inspection_orders'
          AND column_name = 'inbound_date'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'inspection_orders'
          AND column_name = 'receipt_date'
      ) THEN
        ALTER TABLE inspection_orders RENAME COLUMN inbound_date TO receipt_date;
      END IF;
    END $$;
  `.execute(db);
}
