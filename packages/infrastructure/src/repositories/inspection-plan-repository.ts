import { sql, type Expression, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
import type { InspectionPlanRepository as IInspectionPlanRepository } from '@letian/domain';
import type { InspectionPlan, InspectionPlanVersion, InspectionType } from '@letian/contracts';
import type {
  Database,
  InspectionPlanInsert,
  InspectionPlanRow,
  PlanSamplingConfig,
} from '../database/schema.js';

/** 契约 InspectionTypeEnum 的 6 个合法取值，用于把 string 收窄为 InspectionType */
const INSPECTION_TYPES: readonly string[] = ['IQC', 'IPQC_CT', 'IPQC_RL', 'IPQC_FN', 'OQC_SF', 'OQC_SH'];

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

  public async findActivePlan(materialCode: string, inspectionType: string): Promise<InspectionPlan | null> {
    // inspection_stage 有 CHECK 约束，非法取值不可能命中任何行
    if (!isInspectionType(inspectionType)) {
      return null;
    }

    const row = await this.db
      .selectFrom('inspectionPlans')
      .selectAll()
      .where('versionStatus', '=', 'ACTIVE')
      .where('materialCode', '=', materialCode)
      .where('inspectionStage', '=', inspectionType)
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    return this.loadPlanByCode(row);
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
      };

      const insertValues: InspectionPlanInsert = {
        planCode: plan.planCode,
        planName: plan.planName,
        materialCode: plan.materialCode,
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
            materialCode: plan.materialCode,
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
   * 读侧投影：质检方案列表分页（一行=一个版本，按 plan_code 聚合成方案）
   *
   * 过滤条件里的 inspectionType / materialCode / keyword / activeOnly 都作用在版本行上：
   * 只要有任一版本行命中，该 plan_code 的方案就出现在结果里；返回的 versions 仍是该方案的全部版本。
   */
  public async listPlans(query: {
    inspectionType?: string;
    materialCode?: string;
    keyword?: string;
    activeOnly?: boolean;
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
      if (query.keyword !== undefined && query.keyword !== '') {
        const pattern = `%${escapeLike(query.keyword)}%`;
        list.push(eb.or([eb('planCode', 'ilike', pattern), eb('planName', 'ilike', pattern)]));
      }
      if (query.activeOnly === true) {
        list.push(eb('versionStatus', '=', 'ACTIVE'));
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

  /** 按 plan_code 取出全部版本行，组装成契约 DTO */
  private async loadPlanByCode(matched: InspectionPlanRow): Promise<InspectionPlan> {
    const rows = await this.db
      .selectFrom('inspectionPlans')
      .selectAll()
      .where('planCode', '=', matched.planCode)
      .orderBy('version', 'asc')
      .orderBy('createdAt', 'asc')
      .execute();

    return this.buildPlanDto(rows, matched);
  }

  private buildPlanDto(rows: readonly InspectionPlanRow[], matched: InspectionPlanRow): InspectionPlan {
    const activeRow = rows.find((row) => row.versionStatus === 'ACTIVE');

    return {
      // 方案级 DTO 的 id 优先取 ACTIVE 版本行，保证调用方拿到"当前生效版本"的标识
      id: activeRow?.id ?? matched.id,
      planCode: matched.planCode,
      planName: matched.planName,
      inspectionType: matched.inspectionStage,
      materialCode: matched.materialCode,
      versions: rows.map((row) => this.mapVersion(row)),
      createdAt: matched.createdAt.toISOString(),
      updatedAt: matched.updatedAt.toISOString(),
    };
  }

  private mapVersion(row: InspectionPlanRow): InspectionPlanVersion {
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
      items: row.items,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
