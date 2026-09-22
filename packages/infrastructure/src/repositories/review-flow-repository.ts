import { Kysely } from 'kysely';
import type { ReviewFlowRepository as IReviewFlowRepository } from '@letian/domain';
import type { MRBFailCategory, ReviewFlow, ReviewFlowNode } from '@letian/contracts';
import type { Database, ReviewFlowInsert, ReviewFlowRow } from '../database/schema.js';

/** 契约 MRBFailCategoryEnum 的 4 个合法取值 */
const MRB_FAIL_CATEGORIES: readonly string[] = [
  'INCOMING_FAIL',
  'PROCESS_FAIL',
  'SHIPMENT_FAIL',
  'SUBCONTRACT_FAIL',
];

function isMrbFailCategory(value: string): value is MRBFailCategory {
  return MRB_FAIL_CATEGORIES.includes(value);
}

/**
 * 节点读侧归一（docs/21 §10.2）：
 * `nodes` 是 JSONB，历史行可能缺 `roleName` / `isRequired` / `allowConcession`
 * （迁移 019 已回填，但读侧仍兜底一次，保证任何存量行都不会渲染成空白列）。
 */
function normalizeNodes(nodes: readonly ReviewFlowNode[]): ReviewFlowNode[] {
  return nodes.map((node) => ({
    ...node,
    roleName: node.roleName !== undefined && node.roleName !== '' ? node.roleName : node.roleCode,
    isRequired: node.isRequired ?? true,
    allowConcession: node.allowConcession ?? false,
  }));
}

/**
 * 可配置评审流程定义仓储 (Kysely + PostgreSQL)
 *
 * 表结构说明：review_flows 的 UNIQUE 约束是 (flow_code, version)，
 * 一行代表流程定义的一个版本；路由时只取 applicable_type 匹配且 is_active 为真的最新一行。
 */
export class KyselyReviewFlowRepository implements IReviewFlowRepository {
  constructor(private readonly db: Kysely<Database>) {}

  public async findApplicableFlow(failCategory: string): Promise<ReviewFlow | null> {
    // 非法分类直接返回 null（等价于"无可用流程"），不抛错，交由调用方决定降级策略
    if (!isMrbFailCategory(failCategory)) {
      return null;
    }

    const row = await this.db
      .selectFrom('reviewFlows')
      .selectAll()
      .where('applicableType', '=', failCategory)
      .where('isActive', '=', true)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  public async save(flow: ReviewFlow): Promise<void> {
    const now = new Date();

    const writable = {
      flowName: flow.flowName,
      description: flow.description ?? null,
      applicableType: flow.applicableType,
      version: flow.version,
      isActive: flow.isActive,
      nodes: JSON.stringify(normalizeNodes(flow.nodes)),
      updatedAt: now,
    };

    const insertValues: ReviewFlowInsert = {
      ...writable,
      flowCode: flow.flowCode,
      ...(flow.id !== undefined ? { id: flow.id } : {}),
    };

    await this.db
      .insertInto('reviewFlows')
      .values(insertValues)
      .onConflict((oc) => oc.columns(['flowCode', 'version']).doUpdateSet(writable))
      .execute();
  }

  
  public async listAll(): Promise<ReviewFlow[]> {
    const rows = await this.db
      .selectFrom('reviewFlows')
      .selectAll()
      .orderBy('createdAt', 'desc')
      .execute();
    return rows.map((r) => this.mapRow(r));
  }

  public async findById(id: string): Promise<ReviewFlow | null> {
    const row = await this.db
      .selectFrom('reviewFlows')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: ReviewFlowRow): ReviewFlow {
    return {
      id: row.id,
      flowCode: row.flowCode,
      flowName: row.flowName,
      ...(row.description !== null && row.description !== undefined
        ? { description: row.description }
        : {}),
      applicableType: row.applicableType,
      version: row.version,
      isActive: row.isActive,
      nodes: normalizeNodes(row.nodes),
    };
  }
}
