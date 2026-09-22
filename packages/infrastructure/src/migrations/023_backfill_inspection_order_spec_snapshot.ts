import { Kysely, sql } from 'kysely';

/**
 * 迁移 023：检验台账「规格型号 / 计量单位」快照回填
 * （materials 主数据 -> inspection_orders.specification / unit）
 *
 * 背景：`inspection_orders.specification` 与 `unit` 是 006 迁移新增的展示快照列，
 * 但历史库中这两列**全表为空**（本机库 24/24 行为空）：`seeds/runner.ts` 建单时只写了
 * `material_name`，从未写入 `specification` / `unit`，而仓储 `save()` 又是「显式传入才写」口径。
 * 界面表现就是「规格型号」列整列为空，而物料名称里带着品名自带的简短规格后缀，
 * 看起来像「规格型号被塞进了物料名称列」。详见 docs/26。
 *
 * 口径（与 011「加工商名称」、022「供应商名称」同构，三者共同构成「快照列 + 主数据兜底」）：
 *  1. 仅回填 specification / unit 为 NULL 或空白的行，不覆盖任何已有快照值；
 *  2. 规格型号一律取 materials.spec_model（ERP Ptype.Standard），计量单位取 materials.unit（ERP Unit1），
 *     物料主数据是这两个字段的唯一权威来源；
 *  3. material_code 为空或匹配不到主数据的行保持原样（**绝不从 material_name 猜规格**，
 *     那正是本次要消除的歧义）；
 *  4. 覆盖全部检验类型（IQC / IPQC / OQC），规格型号不是来料检验独有的展示列。
 *
 * 说明：本迁移与种子数据（seeds/runner.ts 的 materialSpecOf() / materialUnitOf()）是双保险——
 * 种子数据负责新写入的行，本迁移负责把已存在的历史库一次性对齐，二者口径一致。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 规格型号：按物料编码回查主数据 spec_model，补齐空行
  await sql`
    UPDATE inspection_orders AS o
    SET specification = m.spec_model
    FROM materials AS m
    WHERE o.material_code = m.material_code
      AND m.spec_model IS NOT NULL
      AND btrim(m.spec_model) <> ''
      AND (o.specification IS NULL OR btrim(o.specification) = '');
  `.execute(db);

  // 2. 计量单位：同源回填（「数量」列按 `{qty} {unit}` 渲染，unit 为空时单位一并丢失）
  await sql`
    UPDATE inspection_orders AS o
    SET unit = m.unit
    FROM materials AS m
    WHERE o.material_code = m.material_code
      AND m.unit IS NOT NULL
      AND btrim(m.unit) <> ''
      AND (o.unit IS NULL OR btrim(o.unit) = '');
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // 数据对齐类迁移不可逆：被回填的行原本是「空值」这一非展示口径，
  // 无法逐行区分哪些值是本迁移写入的，保留空实现让 down 流程正常推进（与 011 / 022 一致）。
}
