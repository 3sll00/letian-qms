import React, { useState, useEffect } from 'react';
import {
  GitBranch,
  Search,
  Download,
  Layers,
  Box,
} from 'lucide-react';
import { StatusBadge } from '../../components/StatusBadge';
import type { TraceabilityGraphResponse, TraceEdge, TraceNode } from '@letian/contracts';
import { api, errorMessage } from '../../lib/api';

/** 种子库中真实存在的追溯根批次（GET /api/v1/traceability/graph/:batchNo 的默认查询对象） */
const DEFAULT_TRACE_BATCH = 'LOT-2026-FN-01';

/** 预设热点批次：均为种子库真实存在的追溯节点（末节点为故意成环的演示链路） */
const PRESET_TRACE_BATCHES = ['LOT-2026-FN-01', 'COIL-20230925-01', 'CYCLE-A'];

/**
 * 追溯展开层级上限。
 * 服务端 TraceQuerySchema.maxDepth 默认值只有 5，种子数据的完整链路（母卷→拉丝→下料→搓丝→热处理→委外→成品→发货）
 * 最深一级在 depth 6，用默认值会把「原材料母卷」这一节静默截断，而页面标题写的是「全链路」。
 * 这里显式请求服务端允许的最大值 (10)，让页面上的链路与「全链路」表述一致。
 */
const TRACE_MAX_DEPTH = 10;

/**
 * 按追溯边做拓扑排序，得到「上游母料 → … → 下游成品/发货」的链路顺序。
 *
 * 为什么需要它：接口返回的节点顺序是展开顺序，不代表工艺先后。
 * 排序用 Kahn 算法；链路存在环时（如演示批 CYCLE-A）剩余节点入度无法归零，
 * 这些节点按接口原顺序追加在末尾，保证既不丢节点、也不会死循环。
 */
function orderChainNodes(nodes: TraceNode[], edges: TraceEdge[]): TraceNode[] {
  const byBatchNo = new Map(nodes.map((n) => [n.batchNo, n]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.batchNo, 0);
    adjacency.set(node.batchNo, []);
  }
  for (const edge of edges) {
    if (!inDegree.has(edge.sourceBatchNo) || !inDegree.has(edge.targetBatchNo)) continue;
    adjacency.get(edge.sourceBatchNo)?.push(edge.targetBatchNo);
    inDegree.set(edge.targetBatchNo, (inDegree.get(edge.targetBatchNo) ?? 0) + 1);
  }

  const queue = nodes.filter((n) => (inDegree.get(n.batchNo) ?? 0) === 0).map((n) => n.batchNo);
  const ordered: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    ordered.push(current);
    for (const next of adjacency.get(current) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  const placed = new Set(ordered);
  for (const node of nodes) {
    if (!placed.has(node.batchNo)) ordered.push(node.batchNo);
  }

  return ordered
    .map((batchNo) => byBatchNo.get(batchNo))
    .filter((n): n is TraceNode => Boolean(n));
}

export function TraceabilityPage() {
  const [batchNo, setBatchNo] = useState(DEFAULT_TRACE_BATCH);
  const [queriedBatch, setQueriedBatch] = useState(DEFAULT_TRACE_BATCH);
  const [graph, setGraph] = useState<TraceabilityGraphResponse | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  const queryBatch = (code: string) => {
    api
      .get<TraceabilityGraphResponse>(`/traceability/graph/${encodeURIComponent(code)}`, {
        maxDepth: String(TRACE_MAX_DEPTH),
      })
      .then((data) => {
        setGraph(data);
        setQueriedBatch(code);
        setQueryError(null);
      })
      .catch((err) => {
        // 未命中根节点时后端返回 404 + RFC7807 说明，不能把错误体当图谱渲染
        setGraph(null);
        setQueryError(errorMessage(err));
        console.error('Trace fetch error:', err);
      });
  };

  useEffect(() => {
    queryBatch(batchNo);
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (batchNo) {
      queryBatch(batchNo);
    }
  };

  // 命中节点优先取查询批次；未命中时回退到图谱根节点 (最后一个成品节点)
  const rootNode: TraceNode | undefined = graph
    ? graph.nodes.find((n) => n.batchNo === queriedBatch) ?? graph.nodes[graph.nodes.length - 1]
    : undefined;

  const findNode = (batchNo: string): TraceNode | undefined =>
    graph?.nodes.find((n) => n.batchNo === batchNo);

  const upstreamNodes: TraceNode[] =
    graph && rootNode
      ? graph.edges
          .filter((e) => e.targetBatchNo === rootNode.batchNo)
          .map((e) => findNode(e.sourceBatchNo))
          .filter((n): n is TraceNode => Boolean(n))
      : [];

  const downstreamNodes: TraceNode[] =
    graph && rootNode
      ? graph.edges
          .filter((e) => e.sourceBatchNo === rootNode.batchNo)
          .map((e) => findNode(e.targetBatchNo))
          .filter((n): n is TraceNode => Boolean(n))
      : [];

  // 全链路工序节点顺序 (上游母料 → 下游成品/发货)，用于 DAG Pipeline 面板逐节渲染
  const chainNodes: TraceNode[] = graph ? orderChainNodes(graph.nodes, graph.edges) : [];

  // Full export traceability report
  const handleExportReport = () => {
    if (!graph) return;
    const jsonStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(graph, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', jsonStr);
    downloadAnchor.setAttribute('download', `批次全链路质量追溯报告_${graph.batchNo}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Search */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/80 border border-slate-800 p-5 rounded-xl">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-sky-400" />
            紧固件全生命周期批次追溯 DAG (母卷→下料→冷镦→成品)
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            正向追踪去向 / 反向逆追原材母料 / 工艺倒流自动阻断检测
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportReport}
            className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition"
          >
            <Download className="w-4 h-4 text-slate-400" />
            导出追溯报告 (JSON)
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
        <form onSubmit={handleSearch} className="flex items-center gap-2 flex-1 max-w-xl">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="输入目标生产批次号 (例如: B20231012-01 或 B20231014-04)..."
              value={batchNo}
              onChange={(e) => setBatchNo(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-500"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-1.5 bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs rounded-lg shadow"
          >
            全链路穿透追溯
          </button>
        </form>

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">预设热点追溯批:</span>
          {PRESET_TRACE_BATCHES.map((code) => (
            <button
              key={code}
              onClick={() => {
                setBatchNo(code);
                queryBatch(code);
              }}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] font-mono text-sky-400 border border-slate-700"
            >
              {code}
            </button>
          ))}
        </div>
      </div>

      {queryError !== null && (
        <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-500/40 text-rose-300 text-xs">
          追溯查询失败：{queryError}
        </div>
      )}

      {/* DAG Visualization Container */}
      {graph && rootNode ? (
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 shadow-xl space-y-6">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">追溯目标批次:</span>
                <span className="text-sm font-mono font-bold text-white">{graph.batchNo}</span>
                <StatusBadge status={rootNode.nodeStatus} />
              </div>
              <div className="text-xs text-slate-300 mt-1">
                物料: <span className="font-semibold">{rootNode.materialName}</span> ·
                工单: <span className="font-mono">{rootNode.orderNo ?? '-'}</span>
              </div>
            </div>

            <div className="text-right">
              <div className="text-xs text-slate-400">全链路追溯节点</div>
              <div className="text-lg font-bold font-mono text-sky-400">
                {graph.nodes.length} 个
              </div>
            </div>
          </div>

          {/* DAG Pipeline Diagram
              全部字段来自追溯接口返回的真实节点，按工艺先后排序后逐节渲染。
              早期实现把 Stage 1..4 的批次号 / 实测值 / 判定 / 印章文案写死在 JSX 里
              （例如「IQC 判定: PASS (全格)」「成品印章: QC-SEAL-PASS-99」），
              无论查询哪个批次都会显示同一套「全部合格」的结论 —— 查询不合格批次时
              页面会凭空出现合格印章，属于会误导质量放行判断的显示错误。 */}
          <div>
            <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-4">
              全链路工序节点 (DAG Pipeline Stages) · 共 {chainNodes.length} 道
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {chainNodes.map((node, index) => {
                const isRoot = node.batchNo === rootNode.batchNo;
                return (
                  <div
                    key={node.nodeId}
                    className={`p-4 rounded-xl bg-slate-950/80 border space-y-2 transition ${
                      isRoot
                        ? 'border-sky-500/60 shadow-lg shadow-sky-950/40'
                        : 'border-slate-800 hover:border-sky-500/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[11px] font-mono text-slate-400 uppercase">
                        Stage {index + 1} · {node.stageName}
                      </span>
                      <StatusBadge status={node.nodeStatus} />
                    </div>
                    <div className="text-sm font-bold text-white font-mono break-all">{node.batchNo}</div>
                    <div className="text-[11px] text-slate-300">{node.materialName}</div>
                    <div className="text-xs text-slate-400 space-y-0.5 pt-2 border-t border-slate-800/80">
                      <div>执行人: {node.operatorName}</div>
                      <div className="font-mono break-all">{node.timestamp}</div>
                      {node.orderNo !== undefined && (
                        <div>
                          关联单号: <span className="font-mono text-slate-300">{node.orderNo}</span>
                        </div>
                      )}
                      {node.supplierOrCustomer !== undefined && <div>供方/客户: {node.supplierOrCustomer}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Upstream / Downstream Trace Nodes */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
            {/* Upstream Parents */}
            <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3">
              <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-sky-400" />
                上游血缘祖先节点 (Upstream Parents)
              </h4>
              <div className="space-y-2">
                {upstreamNodes.length > 0 ? (
                  upstreamNodes.map((u) => (
                    <div
                      key={u.nodeId}
                      className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between text-xs"
                    >
                      <div>
                        <div className="font-mono font-bold text-white">{u.batchNo}</div>
                        <div className="text-[11px] text-slate-400">{u.materialName} ({u.stageName})</div>
                      </div>
                      <div className="text-right font-mono">
                        <div className="text-slate-300">{u.operatorName}</div>
                        <StatusBadge status={u.nodeStatus} />
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="p-4 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-lg">
                    当前批次为链路源头 (原始母料入库节点)，无上游血缘
                  </div>
                )}
              </div>
            </div>

            {/* Downstream Children */}
            <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3">
              <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Box className="w-4 h-4 text-cyan-400" />
                下游流向子节点 (Downstream Children)
              </h4>
              <div className="space-y-2">
                {downstreamNodes.length > 0 ? (
                  downstreamNodes.map((d) => (
                    <div
                      key={d.nodeId}
                      className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between text-xs"
                    >
                      <div>
                        <div className="font-mono font-bold text-white">{d.batchNo}</div>
                        <div className="text-[11px] text-slate-400">{d.materialName} ({d.stageName})</div>
                      </div>
                      <div className="text-right font-mono">
                        <div className="text-slate-300">{d.operatorName}</div>
                        <StatusBadge status={d.nodeStatus} />
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="p-4 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-lg">
                    当前批次已作为最高级成品入库，无进一步下游衍生加工
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center h-64 text-slate-400">
          未查询到指定批次追溯链，请输入有效批次号
        </div>
      )}
    </div>
  );
}
