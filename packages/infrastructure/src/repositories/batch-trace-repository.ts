import { Kysely, sql } from 'kysely';
import type { BatchTraceRepository as IBatchTraceRepository } from '@letian/domain';
import type { TraceEdge, TraceNode, TraceRelationType } from '@letian/contracts';
import type { BatchTraceNodeRow, BatchTraceRelationRow, Database } from '../database/schema.js';

/** 递归 CTE 的原始行类型（batch_trace_relations 是复合主键表，没有代理 id 列） */
interface ConnectedEdgeSqlRow {
  parentBatch: string;
  childBatch: string;
  relationType: TraceRelationType;
  depth: number;
}

/** PostgreSQL uuid 列不接受非 uuid 文本，节点 id 非 uuid 时交给数据库默认值生成 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 批次追溯图仓储 (Kysely + PostgreSQL)
 *
 * 说明：batch_trace_relations 只存"父子批次 + 关系类型"这一层事实，
 * depth / isCycle / hasCycleWarning 图上语义无法从单行推导，
 * 因此 findEdges 一律返回 depth=1、isCycle=false，真正的层级与成环判定由上层图谱算法负责；
 * 只有 findConnectedEdges 会由递归 CTE 计算出真实的跳数 depth。
 */
export class KyselyBatchTraceRepository implements IBatchTraceRepository {
  constructor(private readonly db: Kysely<Database>) {}

  public async findNode(batchNo: string): Promise<TraceNode | null> {
    const row = await this.db
      .selectFrom('batchTraceNodes')
      .selectAll()
      .where('batchNo', '=', batchNo)
      .executeTakeFirst();

    return row ? this.mapNode(row) : null;
  }

  public async findEdges(
    batchNo: string,
    direction: 'UPSTREAM' | 'DOWNSTREAM' | 'BOTH'
  ): Promise<readonly TraceEdge[]> {
    let query = this.db.selectFrom('batchTraceRelations').selectAll();

    if (direction === 'UPSTREAM') {
      // 向上溯源：本批次是子批次
      query = query.where('childBatch', '=', batchNo);
    } else if (direction === 'DOWNSTREAM') {
      // 向下追踪：本批次是父批次
      query = query.where('parentBatch', '=', batchNo);
    } else {
      query = query.where((eb) => eb.or([eb('childBatch', '=', batchNo), eb('parentBatch', '=', batchNo)]));
    }

    const rows = await query.execute();
    return rows.map((row) => this.mapEdge(row, 1));
  }

  /**
   * 额外方法（非端口契约）：从 rootBatchNo 出发，双向展开整张连通分量。
   * 单条递归 CTE 实现，用累积路径数组做环检测，避免自环/互环导致无限递归。
   */
  public async findConnectedEdges(rootBatchNo: string, maxDepth = 6): Promise<TraceEdge[]> {
    const result = await sql<ConnectedEdgeSqlRow>`
      WITH RECURSIVE walk AS (
        -- 种子层：dir = 1 表示沿下游（父->子）展开，dir = -1 表示沿上游（子->父）展开
        SELECT
          r.parent_batch,
          r.child_batch,
          r.relation_type,
          1 AS depth,
          d.dir AS dir,
          CASE WHEN d.dir = 1
               THEN ARRAY[r.parent_batch, r.child_batch]::text[]
               ELSE ARRAY[r.child_batch, r.parent_batch]::text[]
          END AS path
        FROM batch_trace_relations r
        CROSS JOIN (VALUES (1), (-1)) AS d(dir)
        WHERE (d.dir = 1 AND r.parent_batch = ${rootBatchNo})
           OR (d.dir = -1 AND r.child_batch = ${rootBatchNo})

        UNION ALL

        -- 递归层：沿当前方向继续前进；已出现在 path 中的批次不再展开（环安全）
        SELECT
          r.parent_batch,
          r.child_batch,
          r.relation_type,
          w.depth + 1 AS depth,
          w.dir AS dir,
          w.path || (CASE WHEN w.dir = 1 THEN r.child_batch ELSE r.parent_batch END)::text AS path
        FROM walk w
        JOIN batch_trace_relations r
          ON (w.dir = 1 AND r.parent_batch = w.child_batch)
          OR (w.dir = -1 AND r.child_batch = w.parent_batch)
        WHERE w.depth < ${maxDepth}
          AND NOT (
            CASE WHEN w.dir = 1 THEN r.child_batch ELSE r.parent_batch END = ANY(w.path)
          )
      )
      SELECT
        parent_batch AS "parentBatch",
        child_batch AS "childBatch",
        relation_type AS "relationType",
        MIN(depth) AS "depth"
      FROM walk
      GROUP BY parent_batch, child_batch, relation_type
    `.execute(this.db);

    // 未知根批次不会产生任何种子行，这里自然返回空数组
    return result.rows.map((row) => ({
      sourceBatchNo: row.parentBatch,
      targetBatchNo: row.childBatch,
      relationType: row.relationType,
      depth: Number(row.depth),
      isCycle: false,
      hasCycleWarning: false,
    }));
  }

  public async saveNode(node: TraceNode): Promise<void> {
    const writable = {
      stageName: node.stageName,
      materialName: node.materialName,
      operatorName: node.operatorName,
      nodeStatus: node.nodeStatus,
      orderNo: node.orderNo ?? null,
      supplierOrCustomer: node.supplierOrCustomer ?? null,
      occurredAt: new Date(node.timestamp),
    };

    await this.db
      .insertInto('batchTraceNodes')
      .values({
        ...writable,
        batchNo: node.batchNo,
        ...(UUID_PATTERN.test(node.nodeId) ? { id: node.nodeId } : {}),
      })
      .onConflict((oc) => oc.column('batchNo').doUpdateSet(writable))
      .execute();
  }

  public async saveEdge(edge: TraceEdge): Promise<void> {
    const now = new Date();

    // 契约 TraceEdge 不含 qty / operator：
    // - 冲突时只更新 relation_type，已有行的 qty / operator / operation_time 保持不变，
    //   重复同步不会把人工维护的数量与责任人覆盖掉；
    // - 首次插入时 qty 记 0、operator 记 'SYSTEM'（来源方未知）。
    await this.db
      .insertInto('batchTraceRelations')
      .values({
        parentBatch: edge.sourceBatchNo,
        childBatch: edge.targetBatchNo,
        relationType: edge.relationType,
        qty: 0,
        operator: 'SYSTEM',
        operationTime: now,
      })
      .onConflict((oc) =>
        oc.columns(['parentBatch', 'childBatch']).doUpdateSet({
          relationType: edge.relationType,
        })
      )
      .execute();
  }

  private mapNode(row: BatchTraceNodeRow): TraceNode {
    return {
      nodeId: row.id,
      batchNo: row.batchNo,
      stageName: row.stageName,
      materialName: row.materialName,
      operatorName: row.operatorName,
      timestamp: row.occurredAt.toISOString(),
      nodeStatus: row.nodeStatus,
      ...(row.orderNo !== null ? { orderNo: row.orderNo } : {}),
      ...(row.supplierOrCustomer !== null ? { supplierOrCustomer: row.supplierOrCustomer } : {}),
    };
  }

  private mapEdge(row: BatchTraceRelationRow, depth: number): TraceEdge {
    return {
      sourceBatchNo: row.parentBatch,
      targetBatchNo: row.childBatch,
      relationType: row.relationType,
      depth,
      isCycle: false,
      hasCycleWarning: false,
    };
  }
}
