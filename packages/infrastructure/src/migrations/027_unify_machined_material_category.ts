import { Kysely, sql } from 'kysely';

/**
 * 迁移 027：委外机加工成品件的分类归位（新增 `CAT-FIN-MACH`）
 *
 * 背景：`MAT-SLV-45-20-30`（精密轴套）与 `MAT-CON-M12`（连接件）是 009 委外检验「机加工」
 * 页签的受托件成品物料，既不是螺栓也不是螺母，却挂在 `CAT-FIN-BOLT`（高强度螺栓类）上 ——
 * 原型遗留的分类口径错位（docs/32 §5 Q4、docs/33 §4）。
 *
 * 本迁移在同一事务内做四件事：
 *  1. 建留痕表 `material_category_reassignments`（物料编码 -> 原分类 / 新分类，长期留痕 + down 依据）；
 *  2. 新增存货分类 `CAT-FIN-MACH`（机加工成品件，父级 `CAT-FINISH`，幂等）；
 *  3. 按**固定字典**（分类口径是决策，不从数据推导）把 2 条物料的 `category_code` 归位；
 *  4. 同步 PBAC 分类白名单：`pbac-sql-translator.ts` 对分类维度走**精确 IN 匹配**（无父子继承
 *     展开），物料移出 `CAT-FIN-BOLT` 会让原授权角色失去可见性，故把新分类追加进「已覆盖螺栓类」
 *     的授权规则，保证可见范围与迁移前**等价**（docs/18）。
 *
 * 幂等：分类行 `ON CONFLICT DO NOTHING`；留痕 `ON CONFLICT DO NOTHING`；
 * 分类已归位（`IS DISTINCT FROM` 不成立）不留痕、不改写。全新库直接播种新口径种子时，映射为空，
 * 迁移只保证分类行存在，不做任何数据改写。
 */

const NEW_CATEGORY_CODE = 'CAT-FIN-MACH';
const NEW_CATEGORY_NAME = '机加工成品件';
const NEW_CATEGORY_PARENT = 'CAT-FINISH';
const NEW_CATEGORY_LEVEL = 2;

/** 固定字典：待归位的物料编码（目标分类统一为 `CAT-FIN-MACH`） */
const CATEGORY_REASSIGNMENTS: ReadonlyArray<{ materialCode: string; note: string }> = [
  {
    materialCode: 'MAT-SLV-45-20-30',
    note: '精密轴套 Φ20×30mm / 45# 钢 / 精磨外圆：委外机加工成品件，非螺栓',
  },
  {
    materialCode: 'MAT-CON-M12',
    note: '连接件 M12 / 机加工成品：委外机加工成品件，非螺栓',
  },
];

/** 需要追加新分类的 PBAC 规则（刘芳 / OQC 检验员：原白名单已覆盖 `CAT-FIN-BOLT` 成品件） */
const PERMISSION_RULES_TO_EXTEND = ['70000000-0000-4000-8000-000000000003'] as const;

/** 追加的守卫条件：只处理确实覆盖旧分类的规则，避免误改无关授权 */
const EXISTING_CATEGORY_FOR_GUARD = 'CAT-FIN-BOLT';

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 留痕表
  await sql`
    CREATE TABLE IF NOT EXISTS material_category_reassignments (
      material_code VARCHAR(64) PRIMARY KEY,
      old_category_code VARCHAR(64),
      new_category_code VARCHAR(64) NOT NULL,
      note TEXT,
      migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db);

  // 2. 新增分类（幂等）
  await sql`
    INSERT INTO inventory_categories (category_code, category_name, parent_code, level)
    VALUES (${NEW_CATEGORY_CODE}, ${NEW_CATEGORY_NAME}, ${NEW_CATEGORY_PARENT}, ${NEW_CATEGORY_LEVEL})
    ON CONFLICT (category_code) DO NOTHING
  `.execute(db);

  // 3. 记录映射：只为**确实存在且分类不同**的物料留痕（已归位则不留痕，保证 down 不误改）
  let insertCount = 0;
  for (const entry of CATEGORY_REASSIGNMENTS) {
    const result = await sql`
      INSERT INTO material_category_reassignments (material_code, old_category_code, new_category_code, note)
      SELECT m.material_code, m.category_code, ${NEW_CATEGORY_CODE}, ${entry.note}
      FROM materials AS m
      WHERE m.material_code = ${entry.materialCode}
        AND m.category_code IS DISTINCT FROM ${NEW_CATEGORY_CODE}
      ON CONFLICT (material_code) DO NOTHING
    `.execute(db);
    insertCount += Number(result.numAffectedRows ?? 0);
  }

  const { rows: mappedRows } = await sql<{ total: string }>`
    SELECT count(*)::text AS "total" FROM material_category_reassignments
  `.execute(db);
  const mapped = Number(mappedRows[0]?.total ?? '0');

  if (mapped === 0) {
    console.log(
      `[027] 无需归位：主数据中的委外机加工成品件分类已是 ${NEW_CATEGORY_CODE}（本次新增留痕 ${insertCount} 条）`
    );
    return;
  }

  // 4. 主数据归位
  const materialsResult = await sql`
    UPDATE materials AS m
    SET category_code = r.new_category_code
    FROM material_category_reassignments AS r
    WHERE m.material_code = r.material_code
  `.execute(db);

  // 5. PBAC 分类白名单同步（只追加，保持元素顺序与既有白名单不变）
  const extended: string[] = [];
  for (const ruleId of PERMISSION_RULES_TO_EXTEND) {
    const result = await sql`
      UPDATE material_permissions
      SET material_categories = material_categories || to_jsonb(${NEW_CATEGORY_CODE}::text),
          updated_at = now()
      WHERE id = ${ruleId}::uuid
        AND material_categories @> to_jsonb(${EXISTING_CATEGORY_FOR_GUARD}::text)
        AND NOT (material_categories @> to_jsonb(${NEW_CATEGORY_CODE}::text))
    `.execute(db);
    const affected = Number(result.numAffectedRows ?? 0);
    if (affected > 0) {
      extended.push(`${ruleId}=${affected}`);
    }
  }

  const { rows: categoryRows } = await sql<{ total: string }>`
    SELECT count(*)::text AS "total" FROM inventory_categories
  `.execute(db);

  console.log(
    `[027] 委外机加工成品件分类归位 ${mapped} 条（本次新增留痕 ${insertCount} 条，主数据命中 ${Number(
      materialsResult.numAffectedRows ?? 0
    )} 行）；新增分类 ${NEW_CATEGORY_CODE}（${NEW_CATEGORY_NAME}）；` +
      `PBAC 分类白名单同步：${extended.length === 0 ? '无' : extended.join(', ')}；` +
      `分类总数 ${categoryRows[0]?.total ?? '0'}`
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{ total: string }>`
    SELECT count(*)::text AS "total" FROM material_category_reassignments
  `.execute(db);

  if (Number(rows[0]?.total ?? '0') === 0) {
    // 无留痕即无可还原的归位（如全新库直接播种新口径种子）：只清理本轮新增的分类行
    await sql`DELETE FROM inventory_categories WHERE category_code = ${NEW_CATEGORY_CODE}`.execute(db);
    await sql`DROP TABLE IF EXISTS material_category_reassignments`.execute(db);
    return;
  }

  await sql`
    UPDATE materials AS m
    SET category_code = r.old_category_code
    FROM material_category_reassignments AS r
    WHERE m.material_code = r.material_code
      AND r.old_category_code IS NOT NULL
  `.execute(db);

  for (const ruleId of PERMISSION_RULES_TO_EXTEND) {
    await sql`
      UPDATE material_permissions
      SET material_categories = COALESCE(
            (
              SELECT jsonb_agg(e.elem ORDER BY e.ord)
              FROM jsonb_array_elements_text(material_categories) WITH ORDINALITY AS e(elem, ord)
              WHERE e.elem <> ${NEW_CATEGORY_CODE}
            ),
            '[]'::jsonb
          ),
          updated_at = now()
      WHERE id = ${ruleId}::uuid
        AND material_categories @> to_jsonb(${NEW_CATEGORY_CODE}::text)
        AND material_categories @> to_jsonb(${EXISTING_CATEGORY_FOR_GUARD}::text)
    `.execute(db);
  }

  await sql`DROP TABLE IF EXISTS material_category_reassignments`.execute(db);
  await sql`DELETE FROM inventory_categories WHERE category_code = ${NEW_CATEGORY_CODE}`.execute(db);
}
