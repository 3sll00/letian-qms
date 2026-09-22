import { sql, type Expression, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
import type { InspectionPlanRepository as IInspectionPlanRepository } from '@letian/domain';
import { InspectionTypeEnum } from '@letian/contracts';
import type {
  InspectionPlan,
  InspectionPlanVersion,
  InspectionType,
  MaterialPermission,
  PlanStats,
  PlanStatus,
} from '@letian/contracts';
import type {
  Database,
  InspectionPlanInsert,
  InspectionPlanRow,
  PlanSamplingConfig,
} from '../database/schema.js';
import { buildMaterialPermissionWhere } from './pbac-sql-translator.js';

/**
 * 契约 InspectionTypeEnum 的全量合法取值，用于把外部 string 收窄为 InspectionType。
 * 直接从契约取值（而不是抄一份常量），保证委外七分类等新增类型不会在仓储侧被静默拒绝。
 */
const INSPECTION_TYPES: readonly string[] = [...InspectionTypeEnum.options];

/**
 * 方案版本行 + 读时 JOIN 派生的展示字段。
 *
 * 主数据名称（物料名 / 存货分类名 / 创建人姓名）一律读时派生，不在方案表落冗余快照列：
 * 方案是可维护配置（物料改名后应即时反映最新主数据），不同于必须固化"当时检的是什么"的检验工单。
 * 口径与理由见 docs/20-质检方案设计页数据字段与接口打通设计.md §2.3。
 */
type InspectionPlanJoinedRow = InspectionPlanRow & {
  materialName: string | null;
  categoryName: string | null;
  categoryId: string | null;
  createdByName: string | null;
};

/** PostgreSQL uuid 列不接受非 uuid 文本，按 id 查询前先做格式判断避免 22P02 错误 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isInspectionType(value: string): value is InspectionType {
  return INSPECTION_TYPES.includes(value);
}

/** 把外部传入的检验类型字符串收窄为契约枚举，非法取值直接报错而不是静默返回空列表 */
function toInspectionType(value: string): InspectionType {
  if (!isInspectionType(value)) {
    throw new Error(`PLAN_INSPECTION_TYPE_INVALID: 非法的检验类型 [${value}]`);
  }
  return value;
}

/** ILIKE 模式串转义：% 与 _ 是通配符，用户输入必须按字面量匹配 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 质检方案仓储 (Kysely + PostgreSQL)
 *
 * 表结构说明：inspection_plans 的 UNIQUE 约束是 (plan_code, version)，
 * 即一行代表"一个方案版本"；同一 plan_code 的所有行共同构成一个方案聚合。
 */
export class KyselyInspectionPlanRepository implements IInspectionPlanRepository {
  constructor(private readonly db: Kysely<Database>) {}

  public async findById(id: string): Promise<InspectionPlan | null> {
    let matched: InspectionPlanRow | undefined;

    if (UUID_PATTERN.test(id)) {
      matched = await this.db
        .selectFrom('inspectionPlans')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
    }

    // id 查不到（或传入的其实是方案编码）时，回退按 plan_code 取最新版本行
    if (!matched) {
      matched = await this.db
        .selectFrom('inspectionPlans')
        .selectAll()
        .where('planCode', '=', id)
        .orderBy('version', 'asc')
        .orderBy('createdAt', 'asc')
        .executeTakeFirst();
    }

    if (!matched) {
      return null;
    }

    return this.loadPlanByCode(matched);
  }

  /**
   * 读侧投影：按版本行 UUID 精确解析"版本 + 所属方案"。
   *
   * 与 findById 的差别：findById 会把 uuid / plan_code 都接受，并回退到方案的最新版本行，
   * 语义是"取整个方案"；而工单创建需要确定性地绑定被指定的那一个版本，
   * 因此这里不做任何回退——传 uuid 只按 uuid 命中，命中不了就返回 null。
   */
  public async findVersionById(
    id: string
  ): Promise<{ plan: InspectionPlan; version: InspectionPlanVersion } | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }

    const row = await this.db
      .selectFrom('inspectionPlans')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    const plan = await this.loadPlanByCode(row);
    const version = plan.versions?.find((candidate) => candidate.id === row.id);

    if (!version) {
      return null;
    }

    return { plan, version };
  }

  /**
   * 读侧投影：按「物料编码 + 检验类型」解析当前生效的方案（两级兜底，口径见 docs/17 §7.3）
   *
   * 第一级：物料专属方案（material_code 精确相等）；
   * 第二级：该物料所属存货分类的通用方案（material_code 为空串 + category_code 相等）；
   * 两级都要求版本处于 ACTIVE 且在生效周期内（effective_start/end 为空表示不设限）。
   * 命中来源可由调用方按 `plan.materialCode === materialCode` 判定（两级取值互斥，不会歧义）。
   */
  public async findActivePlan(
    materialCode: string,
    inspectionType: string,
    materialCategory?: string
  ): Promise<InspectionPlan | null> {
    // inspection_stage 有 CHECK 约束，非法取值不可能命中任何行
    if (!isInspectionType(inspectionType)) {
      return null;
    }

    // 生效周期存在 sampling_config JSONB 内（与抽样方案 / AQL / 严格度同属版本级属性），
    // 因此这里用原生 SQL 表达式做区间过滤；raw sql 不经过 CamelCasePlugin，列名保持 snake_case。
    const withinEffectivePeriod = sql<SqlBool>`(
      (sampling_config ->> 'effectiveStartDate' IS NULL
        OR (sampling_config ->> 'effectiveStartDate')::date <= CURRENT_DATE)
      AND (sampling_config ->> 'effectiveEndDate' IS NULL
        OR (sampling_config ->> 'effectiveEndDate')::date >= CURRENT_DATE)
    )`;

    const specific = await this.db
      .selectFrom('inspectionPlans')
      .selectAll()
      .where('versionStatus', '=', 'ACTIVE')
      .where('materialCode', '=', materialCode)
      .where('inspectionStage', '=', inspectionType)
      .where(withinEffectivePeriod)
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();

    if (specific) {
      return this.loadPlanByCode(specific);
    }

    // 第二级兜底：物料无专属方案时，下沉到该存货分类的通用方案
    if (materialCategory === undefined || materialCategory === '') {
      return null;
    }

    const categoryFallback = await this.db
      .selectFrom('inspectionPlans')
      .selectAll()
      .where('versionStatus', '=', 'ACTIVE')
      .where('materialCode', '=', '')
      .where('categoryCode', '=', materialCategory)
      .where('inspectionStage', '=', inspectionType)
      .where(withinEffectivePeriod)
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();

    if (!categoryFallback) {
      return null;
    }

    return this.loadPlanByCode(categoryFallback);
  }

  public async save(plan: InspectionPlan): Promise<void> {
    const versions = plan.versions;

    if (!versions || versions.length === 0) {
      throw new Error('PLAN_SAVE_REQUIRES_VERSIONS: 方案 DTO 必须携带至少一个版本才能落库');
    }

    const now = new Date();

    // 一个版本 = 一行；UPSERT 冲突目标为 (plan_code, version)，冲突时不覆盖主键 id
    for (const version of versions) {
      const samplingConfig: PlanSamplingConfig = {
        samplingScheme: version.samplingScheme,
        aqlLevel: version.aqlLevel,
        strictness: version.strictness,
        // 生效周期与抽样方案同属版本级属性，统一落在 sampling_config，避免同一契约对象被拆到两处存储
        ...(version.effectiveStartDate !== undefined
          ? { effectiveStartDate: version.effectiveStartDate }
          : {}),
        ...(version.effectiveEndDate !== undefined ? { effectiveEndDate: version.effectiveEndDate } : {}),
      };

      const insertValues: InspectionPlanInsert = {
        planCode: plan.planCode,
        planName: plan.planName,
        materialCode: plan.materialCode ?? "",
        categoryCode: plan.categoryCode ?? null,
        version: version.versionNo,
        versionStatus: version.status,
        inspectionStage: plan.inspectionType,
        items: JSON.stringify(version.items),
        samplingConfig: JSON.stringify(samplingConfig),
        createdBy: version.createdBy,
        updatedAt: now,
        ...(version.id !== undefined ? { id: version.id } : {}),
      };

      await this.db
        .insertInto('inspectionPlans')
        .values(insertValues)
        .onConflict((oc) =>
          oc.columns(['planCode', 'version']).doUpdateSet({
            planName: plan.planName,
            materialCode: plan.materialCode ?? "",
            categoryCode: plan.categoryCode ?? null,
            inspectionStage: plan.inspectionType,
            versionStatus: version.status,
            items: JSON.stringify(version.items),
            samplingConfig: JSON.stringify(samplingConfig),
            createdBy: version.createdBy,
            updatedAt: now,
          })
        )
        .execute();
    }
  }

  /**
   * 方案编码流水号分配（见 @letian/domain 的 inspection-plan-number 编号规则）。
   *
   * 在 `inspection_plan_code_sequences` 的 (prefix, day_key) 唯一键上做原子 upsert：
   * 首次插入 last_seq=1，后续 `last_seq = last_seq + 1 RETURNING`。
   * 依赖 PostgreSQL 行级锁 + 唯一索引保证并发建方案不重号；
   * 调用方处于 UoW 事务内，因此事务回滚时流水号一并回滚（不留空洞、不跳号）。
   */
  public async allocatePlanCodeSequence(prefix: string, dayKey: string): Promise<number> {
    const result = await sql`
      INSERT INTO inspection_plan_code_sequences (prefix, day_key, last_seq, updated_at)
      VALUES (${prefix}, ${dayKey}, 1, now())
      ON CONFLICT (prefix, day_key)
      DO UPDATE SET last_seq = inspection_plan_code_sequences.last_seq + 1,
                    updated_at = now()
      RETURNING last_seq
    `.execute(this.db);

    // 连接层启用了 Kysely CamelCasePlugin，结果集列名会被转成 camelCase（last_seq -> lastSeq）。
    // 同时兼容两种形态，避免取号逻辑与连接层插件配置耦合：一旦插件被移除或替换，
    // 取号不会静默变成 NaN 而写出脏编码。
    const row = result.rows[0] as
      | { last_seq?: number | string; lastSeq?: number | string }
      | undefined;
    const raw = row?.last_seq ?? row?.lastSeq;
    if (raw === undefined || raw === null) {
      throw new Error(`PLAN_CODE_SEQUENCE_ALLOCATE_FAILED: ${prefix}-${dayKey}`);
    }
    const seq = Number(raw);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new Error(`PLAN_CODE_SEQUENCE_INVALID: ${prefix}-${dayKey} -> [${String(raw)}]`);
    }
    return seq;
  }

  /**
   * 读侧投影：质检方案列表分页（一行=一个版本，按 plan_code 聚合成方案）
   *
   * 过滤条件里的 inspectionType / materialCode / keyword / activeOnly 都作用在版本行上：
   * 只要有任一版本行命中，该 plan_code 的方案就出现在结果里；返回的 versions 仍是该方案的全部版本。
   */
  public async listPlans(query: {
    inspectionType?: string;
    materialCode?: string;
    /** 产品分类（存货分类编码）：按主数据 materials.category_code 精确匹配，与物料编码维度相互独立 */
    categoryCode?: string;
    keyword?: string;
    activeOnly?: boolean;
    /** 三维 PBAC 权限过滤（方案表无供应商列，限定供应商的规则按 fail-closed 不匹配） */
    permissions?: readonly MaterialPermission[];
    page: number;
    pageSize: number;
  }): Promise<{ total: number; list: InspectionPlan[] }> {
    const filter = (eb: ExpressionBuilder<Database, 'inspectionPlans'>): Expression<SqlBool> => {
      const list: Expression<SqlBool>[] = [];
      if (query.inspectionType !== undefined) {
        list.push(eb('inspectionStage', '=', toInspectionType(query.inspectionType)));
      }
      if (query.materialCode !== undefined) {
        list.push(eb('materialCode', 'ilike', `%${escapeLike(query.materialCode)}%`));
      }
      if (query.categoryCode !== undefined) {
        // 分类维度两个来源都要命中，否则 014 引入的"分类通用方案"永远搜不到：
        //   1) 方案自身归属列 inspection_plans.category_code（物料专属方案由 014 回填、分类通用方案由调用方写入）；
        //   2) 主数据 materials 反查（存量方案早于 014、或物料后补主数据的情况）。
        // 两个分支取 OR：同一方案命中多次也只算一行（外层按 plan_code 去重计数）。
        list.push(
          sql<SqlBool>`(
            inspection_plans.category_code = ${query.categoryCode}
            OR EXISTS (
              SELECT 1 FROM materials AS filter_materials
              WHERE filter_materials.material_code = ${sql.ref('inspection_plans.material_code')}
                AND filter_materials.category_code = ${query.categoryCode}
            )
          )`
        );
      }
      if (query.keyword !== undefined && query.keyword !== '') {
        const pattern = `%${escapeLike(query.keyword)}%`;
        list.push(eb.or([eb('planCode', 'ilike', pattern), eb('planName', 'ilike', pattern)]));
      }
      if (query.activeOnly === true) {
        list.push(eb('versionStatus', '=', 'ACTIVE'));
      }
      if (query.permissions !== undefined) {
        list.push(
          buildMaterialPermissionWhere(query.permissions, {
            targetRef: 'inspection_plans',
            hasSupplierColumn: false,
          })
        );
      }
      return list.length > 0 ? eb.and(list) : sql<SqlBool>`1 = 1`;
    };

    const countRow = await this.db
      .selectFrom('inspectionPlans')
      .select((eb) => eb.fn.count('planCode').distinct().as('total'))
      .where(filter)
      .executeTakeFirst();
    const total = countRow ? Number(countRow.total) : 0;

    // 先按 plan_code 分组取出当页的方案编码（按最新版本时间倒序），再逐个装配完整方案
    const codeRows = await this.db
      .selectFrom('inspectionPlans')
      .select('planCode')
      .where(filter)
      .groupBy('planCode')
      .orderBy(sql`max(updated_at)`, 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();

    const list: InspectionPlan[] = [];
    for (const row of codeRows) {
      const plan = await this.findById(row.planCode);
      if (plan) {
        list.push(plan);
      }
    }

    return { total, list };
  }

  /**
   * KPI 聚合（方案总数 / 已启用 / 待审批 / 覆盖产品数，口径见契约 PlanStatsSchema）
   *
   * 一次聚合 SQL 算全量，只施加 PBAC 权限过滤，不受列表筛选条件与分页影响，
   * 避免"用当页数据推算全局 KPI"导致方案数超过一页时数字失真。
   */
  public async getPlanStats(query: {
    permissions?: readonly MaterialPermission[];
  }): Promise<PlanStats> {
    // 未传权限规则时不做行级过滤（调用方显式声明"不过滤"）；传了就与列表同一口径 fail-closed
    const permissionClause =
      query.permissions === undefined
        ? undefined
        : buildMaterialPermissionWhere(query.permissions, {
            targetRef: 'inspection_plans',
            hasSupplierColumn: false,
          });

    let statement = this.db
      .selectFrom('inspectionPlans')
      .select((eb) => [
        eb.fn.count('planCode').distinct().as('total'),
        sql<number>`count(DISTINCT plan_code) FILTER (WHERE version_status = 'ACTIVE')`.as('enabled'),
        // 待审批 = 存在 DRAFT 版本、但整个方案没有任何 ACTIVE 版本（NOT EXISTS 探针按 plan_code 关联）
        sql<number>`count(DISTINCT plan_code) FILTER (
          WHERE version_status = 'DRAFT'
            AND NOT EXISTS (
              SELECT 1 FROM inspection_plans AS active_probe
              WHERE active_probe.plan_code = inspection_plans.plan_code
                AND active_probe.version_status = 'ACTIVE'
            )
        )`.as('pending'),
        // 覆盖产品数：material_code 为空串的是分类通用方案，不构成"覆盖产品"
        sql<number>`count(DISTINCT nullif(material_code, ''))`.as('productCount'),
      ]);
    if (permissionClause !== undefined) {
      statement = statement.where(permissionClause);
    }
    const row = await statement.executeTakeFirst();

    // pg 把 count() 以字符串返回（bigint），统一收敛为 number
    return {
      total: Number(row?.total ?? 0),
      enabled: Number(row?.enabled ?? 0),
      pending: Number(row?.pending ?? 0),
      productCount: Number(row?.productCount ?? 0),
    };
  }

  /**
   * 按 plan_code 取出全部版本行，组装成契约 DTO。
   *
   * 三个 LEFT JOIN 只派生展示字段（物料名 / 存货分类名与 ID / 版本创建人姓名），
   * 不改变方案自身的聚合口径：物料与分类按编码唯一命中，职员表按 id::text 关联
   * （employees.id 是 uuid，inspection_plans.created_by 是 VARCHAR，需显式转型）。
   */
  private async loadPlanByCode(matched: InspectionPlanRow): Promise<InspectionPlan> {
    const rows = await this.db
      .selectFrom('inspectionPlans')
      .leftJoin('materials', 'materials.materialCode', 'inspectionPlans.materialCode')
      .leftJoin(
        'inventoryCategories',
        'inventoryCategories.categoryCode',
        'inspectionPlans.categoryCode'
      )
      .leftJoin('employees', (join) =>
        join.onRef(sql<string>`employees.id::text`, '=', 'inspectionPlans.createdBy')
      )
      .selectAll('inspectionPlans')
      .select([
        'materials.materialName as materialName',
        'inventoryCategories.categoryName as categoryName',
        'inventoryCategories.id as categoryId',
        'employees.name as createdByName',
      ])
      .where('inspectionPlans.planCode', '=', matched.planCode)
      .orderBy('inspectionPlans.version', 'asc')
      .orderBy('inspectionPlans.createdAt', 'asc')
      .execute();

    return this.buildPlanDto(rows, matched);
  }

  private buildPlanDto(rows: readonly InspectionPlanJoinedRow[], matched: InspectionPlanRow): InspectionPlan {
    const activeRow = rows.find((row) => row.versionStatus === 'ACTIVE');
    // 物料名 / 分类名与 ID 都是方案级属性（同一 plan_code 的每个版本行取值相同），取任一行即可
    const first = rows[0];

    // 方案级状态口径与契约 PlanStatusEnum 完全一致：有 ACTIVE=已启用，仅 DRAFT=待审批，否则已停用
    const status: PlanStatus = rows.some((row) => row.versionStatus === 'ACTIVE')
      ? 'ENABLED'
      : rows.some((row) => row.versionStatus === 'DRAFT')
        ? 'PENDING_APPROVAL'
        : 'DISABLED';

    const materialCode = matched.materialCode;

    return {
      // 方案级 DTO 的 id 优先取 ACTIVE 版本行，保证调用方拿到"当前生效版本"的标识
      id: activeRow?.id ?? matched.id,
      planCode: matched.planCode,
      planName: matched.planName,
      inspectionType: matched.inspectionStage,
      materialCode,
      categoryCode: matched.categoryCode,
      status,
      // 分类通用方案（material_code 为空串）没有适用物料名，此时适用产品由 categoryName 兜底
      ...(first !== undefined && first.materialName !== null ? { materialName: first.materialName } : {}),
      ...(first !== undefined && first.categoryName !== null ? { categoryName: first.categoryName } : {}),
      ...(first !== undefined && first.categoryId !== null ? { categoryId: first.categoryId } : {}),
      isCategoryDefault: materialCode === '' && matched.categoryCode !== null,
      versions: rows.map((row) => this.mapVersion(row)),
      createdAt: matched.createdAt.toISOString(),
      updatedAt: matched.updatedAt.toISOString(),
    };
  }

  private mapVersion(row: InspectionPlanJoinedRow): InspectionPlanVersion {
    // sampling_config 语义上是 {} 空对象时各字段缺失，因此必须带兜底默认值
    const config = row.samplingConfig as Partial<PlanSamplingConfig>;

    return {
      id: row.id,
      planId: row.id,
      versionNo: row.version,
      status: row.versionStatus,
      samplingScheme: config.samplingScheme ?? 'GB_T_2828',
      aqlLevel: config.aqlLevel ?? 'II',
      strictness: config.strictness ?? 'NORMAL',
      ...(config.effectiveStartDate !== undefined ? { effectiveStartDate: config.effectiveStartDate } : {}),
      ...(config.effectiveEndDate !== undefined ? { effectiveEndDate: config.effectiveEndDate } : {}),
      items: row.items,
      createdBy: row.createdBy,
      ...(row.createdByName !== null ? { createdByName: row.createdByName } : {}),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
