import type {
  TraceabilityGraphResponse,
  TraceNode,
  TraceEdge,
} from '@letian/contracts';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface QueryBatchTraceDagCommand {
  batchNo: string;
  direction?: 'UPSTREAM' | 'DOWNSTREAM' | 'BOTH';
  maxDepth?: number;
  operatorId?: string;
  operatorName?: string;
}

/**
 * 批次追溯正反向穿透与成环保护用例
 *
 * 核心功能：
 * 1. 支持正向（原材料 -> 成品 -> 发货）与反向（销售出库 -> 生产工序 -> 原材料批次）拓扑穿透
 * 2. 成环检测：只把**有向闭环**（A->B->C->A 这类真实工艺倒流）标记为环，
 *    与 domain 层 BatchTraceDag.detectCycles 的判定语义保持一致；
 * 3. 严格遵循六边形架构通过 UnitOfWork / BatchTraceRepository 聚合数据
 * 4. 记录穿透查询审计追踪日志
 */
export class PenetrateBatchDagUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  /** 边在遍历去重时使用的键（与 edgeMap 的键一致） */
  private static edgeKeyOf(edge: TraceEdge): string {
    return `${edge.sourceBatchNo}->${edge.targetBatchNo}-${edge.relationType}`;
  }

  /**
   * 有向图成环检测：DFS + 回溯栈（back edge）语义，与 domain 层
   * BatchTraceDag.detectCycles 一致。
   *
   * 注意：不能按"下一跳批次是否已在当前路径上"判定成环。双向穿透(direction=BOTH)
   * 会把同一条关系边从两端各走一次，此时沿来路回退也会命中间隔为 0 的路径节点，
   * 于是链式工艺路线会被整体误判成环。只有沿边的自身方向(source -> target)
   * 走到仍在回溯栈中的节点，才是真正的有向闭环。
   */
  private static detectCycleEdges(edges: readonly TraceEdge[]): {
    cycleEdgeKeys: Set<string>;
    hasCycle: boolean;
  } {
    const adjacency = new Map<string, TraceEdge[]>();
    for (const edge of edges) {
      const list = adjacency.get(edge.sourceBatchNo) ?? [];
      list.push(edge);
      adjacency.set(edge.sourceBatchNo, list);
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();
    const parentEdge = new Map<string, TraceEdge>();
    const cycleEdgeKeys = new Set<string>();
    let hasCycle = false;

    const walk = (batchNo: string): void => {
      visited.add(batchNo);
      inStack.add(batchNo);

      for (const edge of adjacency.get(batchNo) ?? []) {
        const next = edge.targetBatchNo;
        if (!visited.has(next)) {
          parentEdge.set(next, edge);
          walk(next);
          continue;
        }
        if (!inStack.has(next)) {
          continue;
        }

        // 命中 back edge：这条边本身在环上，沿 parentEdge 链回溯的整条环路也一并标记
        hasCycle = true;
        cycleEdgeKeys.add(PenetrateBatchDagUseCase.edgeKeyOf(edge));
        let cursor = batchNo;
        while (cursor !== next) {
          const onPath = parentEdge.get(cursor);
          if (!onPath) break;
          cycleEdgeKeys.add(PenetrateBatchDagUseCase.edgeKeyOf(onPath));
          cursor = onPath.sourceBatchNo;
        }
      }

      inStack.delete(batchNo);
    };

    const allBatches = new Set<string>();
    for (const edge of edges) {
      allBatches.add(edge.sourceBatchNo);
      allBatches.add(edge.targetBatchNo);
    }
    for (const batchNo of allBatches) {
      if (!visited.has(batchNo)) {
        walk(batchNo);
      }
    }

    return { cycleEdgeKeys, hasCycle };
  }

  public async execute(
    cmd: QueryBatchTraceDagCommand,
    securityCtx?: ISecurityContext
  ): Promise<TraceabilityGraphResponse> {
    const direction = cmd.direction ?? 'BOTH';
    const maxDepth = cmd.maxDepth ?? 10;

    return await this.uow.execute(async (ctx) => {
      // 1. 获取目标根批次节点
      const rootNode = await ctx.traceDags.findNode(cmd.batchNo);
      if (!rootNode) {
        throw new ApplicationError(
          'TRACE_ROOT_NOT_FOUND',
          `未找到批次号 [${cmd.batchNo}] 的追溯根节点`,
          404
        );
      }

      // 2. PBAC 权限校验 (若安全上下文存在)
      // 追溯节点只携带物料名称：按名称反查主数据得到真实编码与分类；
      // 查不到时以名称占位编码、分类取 UNKNOWN（任何白名单规则都不命中，fail-closed）
      if (securityCtx) {
        const material = await ctx.materials.getMaterialByName(rootNode.materialName);
        securityCtx.assertAccess({
          targetCategory: material?.categoryCode ?? 'UNKNOWN',
          targetMaterialCode: material?.materialCode ?? rootNode.materialName,
        });
      }

      // 3. 广度优先穿透构建连通图（成环标记在第 4 步统一计算）
      const visitedBatches = new Set<string>();
      const nodeMap = new Map<string, TraceNode>();
      const edgeMap = new Map<string, TraceEdge>();

      nodeMap.set(rootNode.batchNo, rootNode);

      // 广度遍历队列: [batchNo, currentDepth]；visitedBatches 保证每个批次只展开一次，
      // 即使图中有环也不会无限扩张。
      const queue: Array<{ batchNo: string; depth: number }> = [
        { batchNo: cmd.batchNo, depth: 0 },
      ];

      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        const { batchNo, depth } = item;

        if (depth >= maxDepth) {
          continue;
        }

        visitedBatches.add(batchNo);

        // 获取当前节点相连的所有边 (上游或下游)
        const connectedEdges = await ctx.traceDags.findEdges(batchNo, direction);

        for (const edge of connectedEdges) {
          const edgeKey = PenetrateBatchDagUseCase.edgeKeyOf(edge);

          // 判断这条边指向的下一跳批次号
          const isForward = edge.sourceBatchNo === batchNo;
          const nextBatchNo = isForward ? edge.targetBatchNo : edge.sourceBatchNo;

          // 首次见到该边时记录（双向穿透下同一条边会从两端各命中一次，保留先到的 depth）
          if (!edgeMap.has(edgeKey)) {
            edgeMap.set(edgeKey, {
              ...edge,
              depth: depth + 1,
              isCycle: false,
              hasCycleWarning: false,
            });
          }

          // 获取下一跳节点数据并加入映射
          if (!nodeMap.has(nextBatchNo)) {
            const nextNode = await ctx.traceDags.findNode(nextBatchNo);
            if (nextNode) {
              nodeMap.set(nextBatchNo, nextNode);
            }
          }

          // 未曾展开过的批次入队继续展开
          if (!visitedBatches.has(nextBatchNo)) {
            queue.push({ batchNo: nextBatchNo, depth: depth + 1 });
          }
        }
      }

      // 4. 成环标记：按有向边做 DFS back-edge 检测，命中的整条环路都打标
      const { cycleEdgeKeys, hasCycle: graphHasCycle } = PenetrateBatchDagUseCase.detectCycleEdges(
        Array.from(edgeMap.values())
      );
      for (const [edgeKey, edge] of edgeMap) {
        if (cycleEdgeKeys.has(edgeKey)) {
          edgeMap.set(edgeKey, { ...edge, isCycle: true, hasCycleWarning: true });
        }
      }

      // 4.5 影响面统计：沿 parent_batch → child_batch（生产流向）递归闭包，
      //     与查询方向解耦 —— 反向查客诉时同样要能看到「本批原料流向哪里」（docs/24 §5.3）。
      const impact = await ctx.traceDags.countImpact(cmd.batchNo, maxDepth);

      // 5. 记录审计日志 (查询穿透)
      if (cmd.operatorId) {
        await ctx.auditLogs.insert({
          id: crypto.randomUUID(),
          traceId: securityCtx?.traceId ?? crypto.randomUUID(),
          userId: cmd.operatorId,
          userName: cmd.operatorName ?? '系统操作员',
          action: 'STATUS_CHANGE', // 统一审计动作
          resourceType: 'BATCH_TRACE',
          resourceId: cmd.batchNo,
          status: 'SUCCESS',
          diffPatch: {
            direction,
            nodeCount: nodeMap.size,
            edgeCount: edgeMap.size,
            hasCycle: graphHasCycle,
          },
          createdAt: new Date().toISOString(),
        });
      }

      return {
        batchNo: cmd.batchNo,
        hasCycle: graphHasCycle,
        nodes: Array.from(nodeMap.values()),
        edges: Array.from(edgeMap.values()),
        impact: {
          downstreamBatchCount: impact.downstreamBatchCount,
          upstreamBatchCount: impact.upstreamBatchCount,
          downstreamOrderCount: impact.downstreamOrderNos.length,
          downstreamPartyCount: impact.downstreamParties.length,
          downstreamOrderNos: impact.downstreamOrderNos,
          downstreamParties: impact.downstreamParties,
        },
      };
    });
  }
}
