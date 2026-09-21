import { sql, type Expression, type SqlBool } from 'kysely';
import type { MaterialPermission } from '@letian/contracts';

/**
 * PBAC 三维权限 → SQL WHERE 翻译器
 *
 * 把用户在 material_permissions 里的三维规则（物料分类 / 物料编码 / 供应商）
 * 翻译成可直接挂在业务查询上的 WHERE 片段，实现读侧行级过滤。
 *
 * 语义与领域层 PBACEvaluator 严格对齐：
 * 1. 没有任何生效规则 => `1 = 0`（fail-closed，什么都看不到）；
 * 2. 任一规则三维全通配（空数组或含 '*'）=> `1 = 1`（全量放行）；
 * 3. 多条规则之间 OR 关系；单条规则内部三维 AND 关系；
 * 4. 供应商维度限定了具体编码时，业务行必须带供应商上下文且命中列表，
 *    否则该规则不匹配（与评估器"无供应商上下文即拒绝"一致）。
 *
 * 物料分类维度通过 materials 主数据子查询换算：业务表普遍只有 material_code，
 * 分类归属由 materials.category_code 提供，不引入冗余列。
 */

export interface PbacWhereOptions {
  /** 业务表引用（含可能的别名），默认 inspection_orders */
  targetRef?: string;
  /** 物料主数据表引用（含可能的别名），默认 materials */
  materialsRef?: string;
  /** 业务表是否具备 supplier_code 列（MRB、方案等表没有），默认 true */
  hasSupplierColumn?: boolean;
}

/** 三维白名单是否为通配：空数组或包含 '*' 都视为不限制 */
function isWildcard(list: readonly string[] | undefined): boolean {
  return list === undefined || list.length === 0 || list.includes('*');
}

/** 规则是否三维全通配（等价于全量放行） */
export function isFullWildcardRule(rule: MaterialPermission): boolean {
  return (
    isWildcard(rule.materialCategories) &&
    isWildcard(rule.materialCodes) &&
    isWildcard(rule.supplierCodes)
  );
}

/** 规则集合里是否存在生效的全通配规则 */
export function hasFullWildcard(permissions: readonly MaterialPermission[]): boolean {
  return permissions.some((rule) => rule.isActive !== false && isFullWildcardRule(rule));
}

/**
 * 生成三维权限过滤条件。
 *
 * @param permissions 用户全部权限规则（未生效规则会被跳过）
 * @param options 业务表引用 / 供应商列有无
 */
export function buildMaterialPermissionWhere(
  permissions: readonly MaterialPermission[],
  options: PbacWhereOptions = {}
): Expression<SqlBool> {
  const targetRef = options.targetRef ?? 'inspection_orders';
  const materialsRef = options.materialsRef ?? 'materials';
  const hasSupplierColumn = options.hasSupplierColumn ?? true;

  const active = permissions.filter((rule) => rule.isActive !== false);

  // fail-closed：无生效规则 = 拒绝一切
  if (active.length === 0) {
    return sql<SqlBool>`1 = 0`;
  }
  // 全通配规则 = 不做任何过滤
  if (active.some((rule) => isFullWildcardRule(rule))) {
    return sql<SqlBool>`1 = 1`;
  }

  const perRule: Expression<SqlBool>[] = [];

  for (const rule of active) {
    const catWild = isWildcard(rule.materialCategories);
    const codeWild = isWildcard(rule.materialCodes);
    const supWild = isWildcard(rule.supplierCodes);

    // 业务表没有供应商上下文时，限定供应商的规则按 fail-closed 语义永不匹配
    if (!hasSupplierColumn && !supWild) {
      continue;
    }

    const conds: Expression<SqlBool>[] = [];

    if (!catWild) {
      // 分类维度：物料的分类必须命中白名单（物料不存在于主数据时自然不命中）
      conds.push(
        sql`EXISTS (
          SELECT 1 FROM ${sql.ref(materialsRef)} AS perm_materials
          WHERE perm_materials.material_code = ${sql.ref(`${targetRef}.material_code`)}
            AND perm_materials.category_code IN (${sql.join(
              rule.materialCategories.map((value) => sql`${value}`)
            )})
        )`
      );
    }

    if (!codeWild) {
      conds.push(
        sql`${sql.ref(`${targetRef}.material_code`)} IN (${sql.join(
          rule.materialCodes.map((value) => sql`${value}`)
        )})`
      );
    }

    if (!supWild) {
      conds.push(
        sql`(${sql.ref(`${targetRef}.supplier_code`)} IS NOT NULL AND ${sql.ref(
          `${targetRef}.supplier_code`
        )} IN (${sql.join(rule.supplierCodes.map((value) => sql`${value}`))}))`
      );
    }

    if (conds.length > 0) {
      perRule.push(sql`(${sql.join(conds, sql` AND `)})`);
    }
  }

  // 所有规则都被跳过（例如全表无供应商列且规则全限定供应商）=> 拒绝一切
  if (perRule.length === 0) {
    return sql<SqlBool>`1 = 0`;
  }

  return sql`(${sql.join(perRule, sql` OR `)})`;
}
