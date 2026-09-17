import { sql, RawBuilder } from 'kysely';

/**
 * PBAC 主体上下文（车间范围 / 物料品类范围 / 数据密级上限）。
 * 契约包当前未导出该形状，故在此就地声明并由本模块统一导出。
 */
export interface PbacSubject {
  subjectId: string;
  roles: readonly string[];
  workshops?: readonly string[];
  materialCategories?: readonly string[];
  maxConfidentialityLevel?: number;
}

/**
 * PBAC 表字段映射关系配置
 */
export interface PbacFieldMapping {
  /** 车间字段名，默认为 workshopCode 或 workshop_code */
  workshopField?: string;
  /** 物料类别字段名，默认为 categoryCode 或 category_code */
  categoryField?: string;
  /** 密级字段名，默认为 confidentialityLevel 或 confidentiality_level */
  confidentialityField?: string;
}

export class PbacSqlTranslator {
  /**
   * 将三维 PBAC 主体 (车间范围、物料类别范围、数据密级范围) 翻译为安全底层的 SQL WHERE 条件
   *
   * @param subject PBAC 主体上下文 (含 workshops, materialCategories, maxConfidentialityLevel)
   * @param mapping 当前查询表中的字段名映射配置 (默认为 camelCase 列名，支持 CamelCasePlugin)
   * @returns RawBuilder<boolean> 用于 .where(sql`...`)
   */
  public static buildWhereClause(
    subject: PbacSubject,
    mapping: PbacFieldMapping = {}
  ): RawBuilder<boolean> {
    const workshopCol = mapping.workshopField ?? 'workshopCode';
    const categoryCol = mapping.categoryField ?? 'categoryCode';
    const confidentialityCol = mapping.confidentialityField ?? 'confidentialityLevel';

    const conditions: RawBuilder<boolean>[] = [];

    // 1. 车间维度 (Workshop Scope)
    // 若包含 '*' 则拥有全部车间访问权限；否则必须属于用户的车间列表 (若字段为 NULL 也允许特定全局对象)
    if (subject.workshops && !subject.workshops.includes('*')) {
      if (subject.workshops.length === 0) {
        // 空列表代表没有任何车间权限
        conditions.push(sql`1 = 0`);
      } else {
        const workshopsSql = sql.join(subject.workshops.map((w) => sql`${w}`));
        conditions.push(
          sql`(${sql.ref(workshopCol)} IS NULL OR ${sql.ref(workshopCol)} IN (${workshopsSql}))`
        );
      }
    }

    // 2. 物料类别维度 (Material Category Scope)
    // 若包含 '*' 则拥有全部品类权限；否则必须属于用户的品类列表
    if (subject.materialCategories && !subject.materialCategories.includes('*')) {
      if (subject.materialCategories.length === 0) {
        conditions.push(sql`1 = 0`);
      } else {
        const categoriesSql = sql.join(subject.materialCategories.map((c) => sql`${c}`));
        conditions.push(
          sql`(${sql.ref(categoryCol)} IS NULL OR ${sql.ref(categoryCol)} IN (${categoriesSql}))`
        );
      }
    }

    // 3. 密级维度 (Confidentiality Level Scope)
    // 密级 1-4，用户只能查看 confidentiality_level <= maxConfidentialityLevel 的数据
    if (typeof subject.maxConfidentialityLevel === 'number') {
      conditions.push(
        sql`(${sql.ref(confidentialityCol)} IS NULL OR ${sql.ref(confidentialityCol)} <= ${subject.maxConfidentialityLevel})`
      );
    }

    if (conditions.length === 0) {
      return sql`1 = 1`;
    }

    // 将所有条件用 AND 组合起来
    return sql`(${sql.join(conditions, sql` AND `)})`;
  }
}
