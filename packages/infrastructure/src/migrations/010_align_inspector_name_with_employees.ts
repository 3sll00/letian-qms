import { Kysely, sql } from 'kysely';

/**
 * 迁移 010：检验人姓名快照与员工主数据对齐
 *
 * 背景：007 迁移为了让 IPQC 台账立即可读，用 `COALESCE(inspector_name, '张强')` 兜底回填了
 * `inspection_orders.inspector_name`。副作用是此后所有未显式写名的工单（含出货检验 OQC_SH）
 * 都被写成了同一个人，与 `inspector_id` 指向的真实检验员不一致——出货检验台账的「检验人」列
 * 因此恒显示同一个姓名。
 *
 * 本迁移只把 `inspector_name` 这一列（可重算的展示快照）在**为空**时补齐为 `employees.name`：
 *  - 仅处理 `inspector_id` 能匹配到员工、且 `inspector_name IS NULL` 的行；
 *  - **不**覆盖任何已有姓名。界面原型（WPS 图片(8)/(9)）里的占位检验人（张检验 / 李检验 /
 *    王检验）与 `inspector_id` 指向的员工姓名并不相同，属于演示数据的刻意口径，
 *    种子数据（seeds/runner.ts）会一并写入，不能被本迁移"纠正"掉；
 *  - **不**修改 `inspector_id`，也**不**触碰任何业务判定/状态字段；
 *  - `inspector_id` 为空的行保持原样（无责任人可归属，不做猜测）。
 */
export async function up(db: Kysely<any>): Promise<void> {
  // inspection_orders.inspector_id 是 VARCHAR(36)，employees.id 是 UUID，
  // 必须显式转换，否则 PostgreSQL 报 42883 (operator does not exist: character varying = uuid)。
  await sql`
    UPDATE inspection_orders AS o
    SET inspector_name = e.name
    FROM employees AS e
    WHERE o.inspector_id = e.id::text
      AND o.inspector_name IS NULL;
  `.execute(db);
}

export async function down(_db: Kysely<any>): Promise<void> {
  // 数据对齐类迁移不可逆：被覆盖的是 007 的统一兜底值（'张强'），本身没有业务语义，
  // 无法推断出每一行的“原值”。此处保留空实现，让 Migrator 的 down 流程可正常推进。
}
