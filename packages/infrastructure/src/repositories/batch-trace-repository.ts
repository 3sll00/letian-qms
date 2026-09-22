import { Kysely, sql } from 'kysely';
import type {
  BatchTraceCandidate,
  BatchTraceRepository as IBatchTraceRepository,
  BatchTraceSearchFilter,
  TraceImpactCounts,
} from '@letian/domain';
import type { TraceEdge, TraceNode, TraceNodeStatus, TraceRelationType } from '@letian/contracts';
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

/** 批次检索：batch_trace_nodes 数据源行 */
interface NodeCandidateSqlRow {
  batchNo: string;
  furnaceHeatBatchNo: string | null;
  materialCode: string | null;
  materialName: string;
  stageName: string | null;
  nodeStatus: TraceNodeStatus | null;
  occurredAt: Date | string | null;
  inspectionOrderNo: string | null;
  orderNo: string | null;
  supplierOrCustomer: string | null;
  relatedOrderNos: string[] | null;
}

/** 批次检索：inspection_orders 数据源按 batch_no 聚合后的行 */
interface OrderBatchSqlRow {
  batchNo: string;
  furnaceHeatBatchNo: string | null;
  materialCode: string | null;
  materialName: string | null;
  occurredAt: Date | string | null;
  relatedOrderNos: string[] | null;
  supplierOrCustomer: string | null;
}

/** 影响面统计行 */
interface ImpactSqlRow {
  downstreamBatchCount: number | string;
  upstreamBatchCount: number | string;
  downstreamOrderNos: string[] | null;
  downstreamParties: string[] | null;
}

/** 模糊匹配模式：空串 / 全空白视为「该条件不参与过滤」返回 null */
function toLikePattern(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : `%${trimmed}%`;
}

/** timestamptz 经驱动可能解析为 Date 或原样字符串，统一转 ISO 字符串；null 保持 null */
function toIsoString(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

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

    if (!row) {
      return null;
    }

    const node = this.mapNode(row);

    // 特采节点必须能交出 MRB 单号与客户授权件（docs/24 §4 R4）。
    // 追溯节点表不冗余 MRB 信息，改为按 batch_no 反查已裁决为 CONCESSION 的 MRB 评审单；
    // 查不到即表示该特采尚无立案记录或未取得客户授权，由前端显式提示，不做补默认值。
    if (node.nodeStatus !== 'CONCESSION') {
      return node;
    }

    const mrb = await this.db
      .selectFrom('mrbReviews')
      .select(['mrbNo', 'concessionAttachmentUrl'])
      .where('batchNo', '=', batchNo)
      .where('disposition', '=', 'CONCESSION')
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();

    return {
      ...node,
      ...(mrb ? { mrbNo: mrb.mrbNo } : {}),
      ...(mrb?.concessionAttachmentUrl != null
        ? { concessionAttachmentUrl: mrb.concessionAttachmentUrl }
        : {}),
    };
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
      materialCode: node.materialCode ?? null,
      furnaceHeatBatchNo: node.furnaceHeatBatchNo ?? null,
      inspectionOrderNo: node.inspectionOrderNo ?? null,
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
      ...(row.materialCode != null ? { materialCode: row.materialCode } : {}),
      ...(row.furnaceHeatBatchNo != null ? { furnaceHeatBatchNo: row.furnaceHeatBatchNo } : {}),
      ...(row.inspectionOrderNo != null ? { inspectionOrderNo: row.inspectionOrderNo } : {}),
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

  /**
   * 批次检索（数据源 1）：`batch_trace_nodes`，即已建立血缘关系的批次。
   * 过滤条件全部下沉 SQL；与数据源 2 的并集归并在用例层按 batchNo 完成。
   */
  public async searchNodes(filter: BatchTraceSearchFilter): Promise<readonly BatchTraceCandidate[]> {
    const batchNoPattern = toLikePattern(filter.batchNo);
    const materialCodePattern = toLikePattern(filter.materialCode);
    const productNamePattern = toLikePattern(filter.productName);
    const orderNoPattern = toLikePattern(filter.orderNo);

    const result = await sql<NodeCandidateSqlRow>`
      SELECT
        n.batch_no AS "batchNo",
        n.furnace_heat_batch_no AS "furnaceHeatBatchNo",
        n.material_code AS "materialCode",
        n.material_name AS "materialName",
        n.stage_name AS "stageName",
        n.node_status AS "nodeStatus",
        n.occurred_at AS "occurredAt",
        n.inspection_order_no AS "inspectionOrderNo",
        n.order_no AS "orderNo",
        n.supplier_or_customer AS "supplierOrCustomer",
        COALESCE(agg.related_order_nos, ARRAY[]::text[]) AS "relatedOrderNos"
      FROM batch_trace_nodes n
      LEFT JOIN LATERAL (
        SELECT array_agg(DISTINCT o.order_no) AS related_order_nos
          FROM inspection_orders o
         WHERE o.batch_no = n.batch_no
      ) agg ON TRUE
      WHERE (${batchNoPattern}::text IS NULL
             OR n.batch_no ILIKE ${batchNoPattern}
             OR n.furnace_heat_batch_no ILIKE ${batchNoPattern})
        AND (${materialCodePattern}::text IS NULL OR n.material_code ILIKE ${materialCodePattern})
        AND (${productNamePattern}::text IS NULL OR n.material_name ILIKE ${productNamePattern})
        AND (${orderNoPattern}::text IS NULL
             OR n.order_no ILIKE ${orderNoPattern}
             OR n.inspection_order_no ILIKE ${orderNoPattern}
             OR EXISTS (
                  SELECT 1 FROM inspection_orders o2
                   WHERE o2.batch_no = n.batch_no
                     AND (o2.order_no ILIKE ${orderNoPattern}
                          OR o2.sales_order_po_no ILIKE ${orderNoPattern}
                          OR o2.sales_order_no ILIKE ${orderNoPattern}
                          OR o2.work_order_no ILIKE ${orderNoPattern})
                ))
      ORDER BY n.occurred_at DESC
      LIMIT ${filter.limit}
    `.execute(this.db);

    return result.rows.map((row) => ({
      batchNo: row.batchNo,
      furnaceHeatBatchNo: row.furnaceHeatBatchNo ?? null,
      materialCode: row.materialCode ?? null,
      materialName: row.materialName,
      stageName: row.stageName ?? null,
      nodeStatus: row.nodeStatus ?? null,
      occurredAt: toIsoString(row.occurredAt),
      inspectionOrderNo: row.inspectionOrderNo ?? null,
      orderNo: row.orderNo ?? null,
      supplierOrCustomer: row.supplierOrCustomer ?? null,
      relatedOrderNos: row.relatedOrderNos ?? [],
    }));
  }

  /**
   * 批次检索（数据源 2）：`inspection_orders` 按 `batch_no` 聚合。
   * 覆盖「只有检验台账、尚未建血缘节点」的批次，保证按订单号检索不会漏批次。
   */
  public async searchOrderBatches(filter: BatchTraceSearchFilter): Promise<readonly BatchTraceCandidate[]> {
    const batchNoPattern = toLikePattern(filter.batchNo);
    const materialCodePattern = toLikePattern(filter.materialCode);
    const productNamePattern = toLikePattern(filter.productName);
    const orderNoPattern = toLikePattern(filter.orderNo);

    const result = await sql<OrderBatchSqlRow>`
      SELECT
        o.batch_no AS "batchNo",
        MAX(o.furnace_heat_batch_no) AS "furnaceHeatBatchNo",
        MAX(o.material_code) AS "materialCode",
        MAX(o.material_name) AS "materialName",
        MAX(o.created_at) AS "occurredAt",
        array_agg(DISTINCT o.order_no) AS "relatedOrderNos",
        MAX(COALESCE(o.customer_name, o.supplier_name)) AS "supplierOrCustomer"
      FROM inspection_orders o
      WHERE (${batchNoPattern}::text IS NULL
             OR o.batch_no ILIKE ${batchNoPattern}
             OR o.furnace_heat_batch_no ILIKE ${batchNoPattern})
        AND (${materialCodePattern}::text IS NULL OR o.material_code ILIKE ${materialCodePattern})
        AND (${productNamePattern}::text IS NULL OR o.material_name ILIKE ${productNamePattern})
        AND (${orderNoPattern}::text IS NULL
             OR o.order_no ILIKE ${orderNoPattern}
             OR o.sales_order_po_no ILIKE ${orderNoPattern}
             OR o.sales_order_no ILIKE ${orderNoPattern}
             OR o.work_order_no ILIKE ${orderNoPattern})
      GROUP BY o.batch_no
      ORDER BY MAX(o.created_at) DESC
      LIMIT ${filter.limit}
    `.execute(this.db);

    return result.rows.map((row) => ({
      batchNo: row.batchNo,
      furnaceHeatBatchNo: row.furnaceHeatBatchNo ?? null,
      materialCode: row.materialCode ?? null,
      materialName: row.materialName ?? row.batchNo,
      stageName: null,
      nodeStatus: null,
      occurredAt: toIsoString(row.occurredAt),
      inspectionOrderNo: null,
      orderNo: null,
      supplierOrCustomer: row.supplierOrCustomer ?? null,
      relatedOrderNos: row.relatedOrderNos ?? [],
    }));
  }

  /**
   * 影响面统计：沿 `parent_batch → child_batch`（生产流向）递归闭包。
   * 与图谱穿透解耦，因此不受查询方向（FORWARD / BACKWARD）影响，恒按生产流向计算。
   */
  public async countImpact(batchNo: string, maxDepth = 10): Promise<TraceImpactCounts> {
    const result = await sql<ImpactSqlRow>`
      WITH RECURSIVE down AS (
        SELECT r.child_batch AS batch, 1 AS depth,
               ARRAY[r.parent_batch, r.child_batch]::text[] AS path
          FROM batch_trace_relations r
         WHERE r.parent_batch = ${batchNo}
        UNION ALL
        SELECT r.child_batch, d.depth + 1, d.path || r.child_batch::text
          FROM down d
          JOIN batch_trace_relations r ON r.parent_batch = d.batch
         WHERE d.depth < ${maxDepth}
           AND NOT (r.child_batch = ANY(d.path))
      ),
      up AS (
        SELECT r.parent_batch AS batch, 1 AS depth,
               ARRAY[r.child_batch, r.parent_batch]::text[] AS path
          FROM batch_trace_relations r
         WHERE r.child_batch = ${batchNo}
        UNION ALL
        SELECT r.parent_batch, u.depth + 1, u.path || r.parent_batch::text
          FROM up u
          JOIN batch_trace_relations r ON r.child_batch = u.batch
         WHERE u.depth < ${maxDepth}
           AND NOT (r.parent_batch = ANY(u.path))
      )
      SELECT
        (SELECT count(DISTINCT batch) FROM down) AS "downstreamBatchCount",
        (SELECT count(DISTINCT batch) FROM up) AS "upstreamBatchCount",
        COALESCE((
          SELECT array_agg(DISTINCT n.order_no ORDER BY n.order_no)
            FROM batch_trace_nodes n
           WHERE n.batch_no IN (SELECT batch FROM down) AND n.order_no IS NOT NULL
        ), ARRAY[]::text[]) AS "downstreamOrderNos",
        COALESCE((
          SELECT array_agg(DISTINCT n.supplier_or_customer ORDER BY n.supplier_or_customer)
            FROM batch_trace_nodes n
           WHERE n.batch_no IN (SELECT batch FROM down) AND n.supplier_or_customer IS NOT NULL
        ), ARRAY[]::text[]) AS "downstreamParties"
    `.execute(this.db);

    const row = result.rows[0];
    return {
      downstreamBatchCount: Number(row?.downstreamBatchCount ?? 0),
      upstreamBatchCount: Number(row?.upstreamBatchCount ?? 0),
      downstreamOrderNos: row?.downstreamOrderNos ?? [],
      downstreamParties: row?.downstreamParties ?? [],
    };
  }
}
