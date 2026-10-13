import { sql, type Expression, type SqlBool } from 'kysely';
import type { MaterialPermission } from '@letian/contracts';
import type { SupplierDimensionMode } from '@letian/domain';

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
 * 5. `supplierDimension = 'NOT_APPLICABLE'`（被过滤对象自身无供应商属性，如方案域）时
 *    供应商维度不参与判定：限定供应商的规则只按物料分类 / 编码生成条件，
 *    物料维度全通配的规则在该域等价于全量放行（与领域层评估器同口径，见 docs/42 §3）。
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
  /**
   * 供应商编码表达式覆盖：业务表**自身没有 supplier_code 列**、但能经关联子查询
   * （如池表按 source_order_id 关联源检验单、MRB 表按 source_order_no = order_no 关联）
   * 取得供应商上下文时传入，供应商维度即可正常参与判定。
   *
   * 省略时取 `${targetRef}.supplier_code`；若业务表既无该列、又未提供本表达式，
   * 限定供应商的规则一律按 fail-closed 跳过（不匹配任何行），不放大可见范围（docs/39 §4.6）。
   */
  supplierCodeExpr?: Expression<unknown>;
  /**
   * 供应商维度判定模式，默认 `'ENFORCE'`（全仓既有行为）。
   *
   * 传 `'NOT_APPLICABLE'` 用于**对象自身无供应商属性**的域（质检方案 / 检验标准）：
   * 该维度不参与判定 —— 不再把"限定供应商"的规则整条跳过，而是按规则的物料维度生成条件。
   * 口径见 docs/42-质检方案域PBAC供应商维度错配修复设计.md §3。
   */
  supplierDimension?: SupplierDimensionMode;
  categoryCodeExpr?: Expression<unknown>;
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
  const supplierDimension = options.supplierDimension ?? 'ENFORCE';
  // 供应商上下文：默认取本表列；业务表无该列时可由调用方传入关联子查询表达式
  const supplierCode = options.supplierCodeExpr ?? sql.ref(`${targetRef}.supplier_code`);

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

    // 业务表没有（也无法换算）供应商上下文时，限定供应商的规则按 fail-closed 语义永不匹配；
    // 但对象自身无供应商属性（supplierDimension='NOT_APPLICABLE'）时该维度不适用，
    // 不整条跳过，改按规则的物料维度参与判定
    if (
      supplierDimension !== 'NOT_APPLICABLE' &&
      !hasSupplierColumn &&
      options.supplierCodeExpr === undefined &&
      !supWild
    ) {
      continue;
    }

    const conds: Expression<SqlBool>[] = [];

    if (!catWild) {
      // 分类维度：物料的分类必须命中白名单（物料不存在于主数据时自然不命中）
      const categories = sql.join(rule.materialCategories.map((value) => sql`${value}`));
      conds.push(options.categoryCodeExpr !== undefined
        ? sql`${options.categoryCodeExpr} IN (${categories})`
        : sql`EXISTS (
          SELECT 1 FROM ${sql.ref(materialsRef)} AS perm_materials
          WHERE perm_materials.material_code = ${sql.ref(`${targetRef}.material_code`)}
            AND perm_materials.category_code IN (${categories})
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

    if (!supWild && supplierDimension !== 'NOT_APPLICABLE') {
      conds.push(
        sql`(${supplierCode} IS NOT NULL AND btrim(${supplierCode}::text) <> '' AND ${supplierCode} IN (${sql.join(
          rule.supplierCodes.map((value) => sql`${value}`)
        )}))`
      );
    }

    if (conds.length > 0) {
      perRule.push(sql`(${sql.join(conds, sql` AND `)})`);
    } else if (supplierDimension === 'NOT_APPLICABLE') {
      // 方案域：物料维度（分类 / 编码）全通配的规则在该域等价于全量放行 —— 与领域层评估器同口径
      perRule.push(sql`1 = 1`);
    }
  }

  // 所有规则都被跳过（例如全表无供应商列且规则全限定供应商）=> 拒绝一切
  if (perRule.length === 0) {
    return sql<SqlBool>`1 = 0`;
  }

  return sql`(${sql.join(perRule, sql` OR `)})`;
}
