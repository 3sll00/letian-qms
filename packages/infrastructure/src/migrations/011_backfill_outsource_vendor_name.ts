import { Kysely, sql } from 'kysely';

/**
 * 迁移 011：委外检验台账「加工商」名称回填
 *
 * 背景：009 迁移新增了 `vendor_name`（加工商名称快照）列，但只对**新增/重新写入**的委外工单
 * 生效。历史委外工单（如 INS-20231012-005 / INS-20231013-005）只有 `supplier_code`，
 * 读取侧按文档化的兜底链回落到 `supplier_code` 本身，界面上「加工商」列因此直接显示
 * 内部编码（如 `SUP-004`）而不是厂商全称，与「加工商」这一展示列的业务语义不符。
 *
 * 本迁移把历史委外行（`order_type LIKE 'OQC%'`）的 `vendor_name` 在为空时补齐为
 * `suppliers.supplier_name`：
 *  - 仅处理 `vendor_name IS NULL` 且 `supplier_code` 能匹配到供应商主数据的行；
 *  - **不**覆盖任何已有 `vendor_name`（含种子数据刻意写入的演示厂名）；
 *  - **不**触碰 `process_type` / `outsource_no` / `return_date`（这三个字段无法从主数据推导，
 *    由种子数据与 009 迁移分别负责）；
 *  - `supplier_code` 为空或匹配不到主数据的行保持原样（不做猜测）。
 *
 * 说明：本迁移与种子数据（`seeds/data.ts`）是「双保险」——种子数据会显式写入演示厂名，
 * 本迁移负责把**已存在的历史库**一次性对齐，二者口径一致。
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    UPDATE inspection_orders AS o
    SET vendor_name = s.supplier_name
    FROM suppliers AS s
    WHERE o.supplier_code = s.supplier_code
      AND o.vendor_name IS NULL
      AND o.order_type LIKE 'OQC%';
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // 数据对齐类迁移不可逆：被覆盖的是「供应商编码」这一非展示口径，
  // 无法逐行推断哪些行原本有值、哪些行是本迁移写入的。保留空实现让 down 流程正常推进。
}
