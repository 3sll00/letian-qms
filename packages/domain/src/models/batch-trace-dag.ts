import {
  TraceNode as TraceNodeDTO,
  TraceEdge as TraceEdgeDTO,
  TraceabilityGraphResponse as TraceabilityGraphResponseDTO
} from '@letian/contracts';

/**
 * 批次追溯 DAG 领域图模型 (BatchTraceDAG)
 * 纯内存图论模型，负责批次正向/反向追溯计算、环路检测 (Cycle Detection) 与关键质量路径提取
 */
export class BatchTraceDAG {
  private nodes: Map<string, TraceNodeDTO> = new Map();
  private edges: TraceEdgeDTO[] = [];

  constructor(nodes?: TraceNodeDTO[], edges?: TraceEdgeDTO[]) {
    if (nodes) {
      for (const node of nodes) {
        this.addNode(node);
      }
    }
    if (edges) {
      for (const edge of edges) {
        this.addEdge(edge);
      }
    }
  }

  public addNode(node: TraceNodeDTO): void {
    this.nodes.set(node.batchNo, { ...node });
  }

  public addEdge(edge: TraceEdgeDTO): void {
    this.edges.push({ ...edge });
  }

  public getNode(batchNo: string): TraceNodeDTO | undefined {
    return this.nodes.get(batchNo);
  }

  public getAllNodes(): TraceNodeDTO[] {
    return Array.from(this.nodes.values()).map(n => ({ ...n }));
  }

  public getAllEdges(): TraceEdgeDTO[] {
    return this.edges.map(e => ({ ...e }));
  }

  /**
   * 基于深度优先遍历 (DFS) 的环路检测算法
   * 检测图是否存在环路（如 A->B->C->A 的异常循环追溯）
   */
  public detectCycles(): { hasCycle: boolean; cyclePath?: string[] } {
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const parentMap = new Map<string, string>();

    // 构建邻接表
    const adj = new Map<string, string[]>();
    for (const edge of this.edges) {
      const neighbors = adj.get(edge.sourceBatchNo) ?? [];
      neighbors.push(edge.targetBatchNo);
      adj.set(edge.sourceBatchNo, neighbors);
    }

    const dfs = (node: string): { hasCycle: boolean; cyclePath?: string[] } => {
      visited.add(node);
      recStack.add(node);

      const neighbors = adj.get(node) ?? [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          parentMap.set(neighbor, node);
          const res = dfs(neighbor);
          if (res.hasCycle) return res;
        } else if (recStack.has(neighbor)) {
          // 发现环路，重建环路路径
          const path: string[] = [neighbor, node];
          let curr = node;
          while (parentMap.has(curr) && parentMap.get(curr) !== neighbor) {
            const p = parentMap.get(curr);
            if (p === undefined) break;
            curr = p;
            path.push(curr);
          }
          path.push(neighbor);
          return { hasCycle: true, cyclePath: path.reverse() };
        }
      }

      recStack.delete(node);
      return { hasCycle: false };
    };

    for (const [node] of this.nodes) {
      if (!visited.has(node)) {
        const res = dfs(node);
        if (res.hasCycle) return res;
      }
    }

    return { hasCycle: false };
  }

  /**
   * 正向追溯：查询指定原材料/半成品批次的所有下游衍生产出批次
   */
  public traceForward(rootBatchNo: string): TraceNodeDTO[] {
    const result: TraceNodeDTO[] = [];
    const visited = new Set<string>();
    const queue: string[] = [rootBatchNo];
    visited.add(rootBatchNo);

    // 构建出边邻接表
    const forwardAdj = new Map<string, string[]>();
    for (const edge of this.edges) {
      const list = forwardAdj.get(edge.sourceBatchNo) ?? [];
      list.push(edge.targetBatchNo);
      forwardAdj.set(edge.sourceBatchNo, list);
    }

    while (queue.length > 0) {
      const curr = queue.shift();
      if (curr === undefined) break;
      const node = this.nodes.get(curr);
      if (node && curr !== rootBatchNo) {
        result.push({ ...node });
      }

      const nextBatches = forwardAdj.get(curr) ?? [];
      for (const next of nextBatches) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    return result;
  }

  /**
   * 反向追溯：查询指定成品批次的所有上游来源半成品/原材料批次
   */
  public traceBackward(leafBatchNo: string): TraceNodeDTO[] {
    const result: TraceNodeDTO[] = [];
    const visited = new Set<string>();
    const queue: string[] = [leafBatchNo];
    visited.add(leafBatchNo);

    // 构建入边邻接表
    const backwardAdj = new Map<string, string[]>();
    for (const edge of this.edges) {
      const list = backwardAdj.get(edge.targetBatchNo) ?? [];
      list.push(edge.sourceBatchNo);
      backwardAdj.set(edge.targetBatchNo, list);
    }

    while (queue.length > 0) {
      const curr = queue.shift();
      if (curr === undefined) break;
      const node = this.nodes.get(curr);
      if (node && curr !== leafBatchNo) {
        result.push({ ...node });
      }

      const prevBatches = backwardAdj.get(curr) ?? [];
      for (const prev of prevBatches) {
        if (!visited.has(prev)) {
          visited.add(prev);
          queue.push(prev);
        }
      }
    }

    return result;
  }

  /**
   * 生成指定批次的完整追溯图响应 (TraceabilityGraphResponse)
   */
  public buildSubgraph(targetBatchNo: string): TraceabilityGraphResponseDTO {
    const targetNode = this.nodes.get(targetBatchNo);
    if (!targetNode) {
      throw new Error(`TRACE_NODE_NOT_FOUND: 追溯批次 [${targetBatchNo}] 不存在`);
    }

    // 收集所有关联的上下游批次集合
    const upstream = this.traceBackward(targetBatchNo);
    const downstream = this.traceForward(targetBatchNo);

    const relatedBatchNos = new Set<string>([
      targetBatchNo,
      ...upstream.map(n => n.batchNo),
      ...downstream.map(n => n.batchNo),
    ]);

    const subgraphNodes: TraceNodeDTO[] = [];
    for (const bNo of relatedBatchNos) {
      const n = this.nodes.get(bNo);
      if (n) subgraphNodes.push({ ...n });
    }

    const subgraphEdges = this.edges.filter(
      e => relatedBatchNos.has(e.sourceBatchNo) && relatedBatchNos.has(e.targetBatchNo)
    );

    const cycleInfo = this.detectCycles();

    return {
      batchNo: targetBatchNo,
      nodes: subgraphNodes,
      edges: subgraphEdges,
      hasCycle: cycleInfo.hasCycle,
    };
  }
}
