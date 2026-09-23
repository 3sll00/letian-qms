import { Kysely, sql } from 'kysely';

/**
 * 迁移 022：检验台账「供应商」名称快照回填（suppliers 主数据 -> inspection_orders.supplier_name）
 *
 * 背景：`inspection_orders.supplier_name` 是「供应商」展示列的名称快照列（006 迁移新增），
 * 但历史库中存在大量「只有 supplier_code、supplier_name 为空」的行（本机库 24/24 行为空）。
 * 读取侧按文档化的兜底链回落到 supplier_code 本身，界面「供应商」列因此直接显示内部编码
 * （如 SUP-001）而不是厂商全称，与「供应商」这一展示列的业务语义不符。
 *
 * 口径（与 011 迁移对「加工商」的做法同构，二者共同构成「快照列 + 主数据兜底」双保险）：
 *  1. 仅回填 supplier_name 为 NULL 或空白的行，不覆盖任何已有快照值；
 *  2. 名称一律取 suppliers.supplier_name（供应商主数据是名称的唯一权威来源）；
 *  3. supplier_code 为空或匹配不到主数据的行保持原样（不做猜测）；
 *  4. 池表 pending_mrb_items.supplier_name 同属「来源检验单供应商」快照，来源单回填后
 *     按 source_order_id 补齐为空的行，保证池与台账的展示口径同源。
 *
 * 说明：本迁移与种子数据（seeds/runner.ts 的 supplierNameOf()）是双保险——种子数据负责
 * 新写入的行，本迁移负责把已存在的历史库一次性对齐，二者口径一致。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 台账：按供应商编码回查主数据，补齐名称快照
  await sql`
    UPDATE inspection_orders AS o
    SET supplier_name = s.supplier_name
    FROM suppliers AS s
    WHERE o.supplier_code = s.supplier_code
      AND (o.supplier_name IS NULL OR btrim(o.supplier_name) = '');
  `.execute(db);

  // 2. 池表：来源单已具备名称快照时同步补齐（OQC_SH 等无供应商的来源单保持为空，不做猜测）
  await sql`
    DO $$
    BEGIN
      IF to_regclass('pending_mrb_items') IS NOT NULL THEN
        UPDATE pending_mrb_items AS p
        SET supplier_name = o.supplier_name
        FROM inspection_orders AS o
        WHERE p.source_order_id = o.id
          AND (p.supplier_name IS NULL OR btrim(p.supplier_name) = '')
          AND o.supplier_name IS NOT NULL
          AND btrim(o.supplier_name) <> '';
      END IF;
    END $$;
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // 数据对齐类迁移不可逆：被回填的行原本是「供应商编码兜底」这一非展示口径，
  // 无法逐行区分哪些名称是本迁移写入的，保留空实现让 down 流程正常推进（与 011 一致）。
}
