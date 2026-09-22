import React, { useState } from 'react';
import { Download, Search } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api';
import {
  display,
  formatDuration,
  formatTime,
  summarizeGraphStatus,
  FALLBACK_TONE,
  NODE_STATUS_LABEL,
  STATUS_TONE,
  TRACE_STATUS_LEGEND,
  type TraceNodeStatus,
} from '../../lib/traceNodeFormat';

/**
 * 质量追溯看板
 *
 * 口径（`docs/24-质量追溯看板界面评审与改造建议.md`）：
 * 1. **批次号是追溯主键**。订单号 / 物料编码 / 成品名称只是检索条件：
 *    先出「命中批次清单」，再由用户点选某一行以该批次为根开图，
 *    避免把同一订单下**并列**的检验环节串成一条并不存在的血缘链。
 * 2. 订单维度只展示「**本订单检验环节**」（检验台账视图），不使用"完整""全链路"等穷尽性表述；
 *    真正的穷尽性血缘链路由批次图承担。
 * 3. 每张卡片都必须带**批次号 + 炉批号**，缺值显示 `—`（未建档 / 无炉批概念），不用占位字符串。
 * 4. 特采（CONCESSION / 让步接收）节点必须同时给出 MRB 单号与客户书面授权件；缺失即显式提示。
 *
 * 纯展示口径（缺值 `—`、耗时只放时长、概览状态派生）集中在 `lib/traceNodeFormat.ts`，
 * 由 `scripts/verify-trace-format.mjs` 断言，避免这三条口径被"看起来也行"的写法改回去。
 */

/** 与后端 /traceability/graph/:batchNo 响应对齐（TraceabilityGraphResponse） */
interface GraphNode {
  nodeId: string;
  batchNo: string;
  stageName: string;
  materialName: string;
  operatorName: string;
  timestamp: string;
  nodeStatus: TraceNodeStatus;
  orderNo?: string | undefined;
  supplierOrCustomer?: string | undefined;
  materialCode?: string | undefined;
  furnaceHeatBatchNo?: string | undefined;
  inspectionOrderNo?: string | undefined;
  mrbNo?: string | undefined;
  concessionAttachmentUrl?: string | undefined;
}

/** 影响面统计：根批次上下游可达规模（恒按生产流向计算，与查询方向无关） */
interface ImpactSummary {
  downstreamBatchCount: number;
  upstreamBatchCount: number;
  downstreamOrderCount: number;
  downstreamPartyCount: number;
  downstreamOrderNos: string[];
  downstreamParties: string[];
}

interface GraphResponse {
  batchNo: string;
  hasCycle: boolean;
  nodes: GraphNode[];
  edges: Array<{ sourceBatchNo: string; targetBatchNo: string; relationType: string; depth: number }>;
  impact: ImpactSummary;
}

/** 批次检索结果行（两个数据源并集：已建血缘的批次 + 仅有检验台账的批次） */
interface BatchSummary {
  batchNo: string;
  furnaceHeatBatchNo?: string | undefined;
  materialCode?: string | undefined;
  materialName: string;
  stageName?: string | undefined;
  nodeStatus?: GraphNode['nodeStatus'] | undefined;
  timestamp?: string | undefined;
  inspectionOrderNo?: string | undefined;
  orderNo?: string | undefined;
  supplierOrCustomer?: string | undefined;
  sources: Array<'TRACE_NODE' | 'INSPECTION_ORDER'>;
  relatedOrderNos: string[];
}

interface BatchSearchResponse {
  total: number;
  page: number;
  pageSize: number;
  items: BatchSummary[];
}

/** 订单维度的检验环节（并列台账，不是血缘链路） */
interface OrderChainStage {
  seq: number;
  stageName: string;
  orderNo: string;
  orderType: string;
  batchNo: string;
  sourceDocNo?: string | undefined;
  status: GraphNode['nodeStatus'];
  judgment?: 'PASSED' | 'FAILED' | 'CONCESSION' | undefined;
  inspectorName?: string | undefined;
  occurredAt?: string | undefined;
  durationMinutes?: number | undefined;
}

interface OrderChainResponse {
  orderNo: string;
  matchedBy: 'SALES_ORDER_PO_NO' | 'SALES_ORDER_NO' | 'WORK_ORDER_NO' | 'ORDER_NO';
  customerName?: string | undefined;
  erpStatus?: string | undefined;
  salesOrderNo?: string | undefined;
  salesOrderPoNo?: string | undefined;
  batchNos: string[];
  materialCode?: string | undefined;
  materialName?: string | undefined;
  totalQty?: number | undefined;
  stages: OrderChainStage[];
}

type TraceDirection = 'FORWARD' | 'BACKWARD' | 'BOTH';

const DIRECTION_OPTIONS: ReadonlyArray<{ value: TraceDirection; label: string; hint: string }> = [
  { value: 'FORWARD', label: '正向', hint: '从原材料向下游追到出货（原料缺陷影响面评估）' },
  { value: 'BACKWARD', label: '反向', hint: '从出货向上游倒查炉批号与来料（客户投诉回溯）' },
  { value: 'BOTH', label: '双向', hint: '上下游一次贯通' },
];

const MATCHED_BY_LABEL: Record<OrderChainResponse['matchedBy'], string> = {
  SALES_ORDER_PO_NO: '客户采购订单号',
  SALES_ORDER_NO: '销售出库单号',
  WORK_ORDER_NO: 'MES 生产工单号',
  ORDER_NO: '检验单号',
};

export function TraceabilityPage() {
  const [batchNo, setBatchNo] = useState('');
  const [orderNo, setOrderNo] = useState('');
  const [materialCode, setMaterialCode] = useState('');
  const [productName, setProductName] = useState('');
  const [direction, setDirection] = useState<TraceDirection>('BOTH');

  const [candidates, setCandidates] = useState<BatchSummary[] | null>(null);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [orderChain, setOrderChain] = useState<OrderChainResponse | null>(null);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [activeBatchNo, setActiveBatchNo] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 非致命提示：例如该批次尚无血缘节点，属于可解释的空态而不是错误 */
  const [notice, setNotice] = useState<string | null>(null);

  /** 以批次为根开图；404 视为「该批次尚未建血缘」，给出提示而不是报错 */
  async function loadGraph(target: string, nextDirection: TraceDirection = direction) {
    setActiveBatchNo(target);
    try {
      const res = await api.get<GraphResponse>(`/traceability/graph/${encodeURIComponent(target)}`, {
        direction: nextDirection,
        maxDepth: 10,
      });
      setGraph(res);
      setNotice(null);
    } catch (err) {
      setGraph(null);
      if (err instanceof ApiError && err.status === 404) {
        setNotice(
          `批次 ${target} 尚未建立血缘节点（batch_trace_nodes 无该批次），当前只能查看它的检验台账。`
        );
        return;
      }
      // 后端 PBAC 拦截返回 403：明确提示是权限问题，而不是数据不存在（fail-closed）
      if (err instanceof ApiError && err.status === 403) {
        setError(`权限拦截：${errorMessage(err)}`);
        setActiveBatchNo(null);
        return;
      }
      setError(errorMessage(err));
      setActiveBatchNo(null);
    }
  }

  async function handleSearch() {
    const batchKey = batchNo.trim();
    const orderKey = orderNo.trim();
    const materialKey = materialCode.trim();
    const productKey = productName.trim();

    if (batchKey === '' && orderKey === '' && materialKey === '' && productKey === '') {
      setError('请至少填写一个检索条件：批次号 / 炉批号、订单号、物料编码或成品名称。');
      return;
    }

    setLoading(true);
    setError(null);
    setNotice(null);
    setOrderChain(null);

    try {
      // 1. 订单维度：本订单检验环节（订单号不是追溯主键，这里只出该订单的检验台账）
      if (orderKey !== '') {
        try {
          const chain = await api.get<OrderChainResponse>(`/traceability/orders/${encodeURIComponent(orderKey)}`);
          setOrderChain(chain);
        } catch (err) {
          if (err instanceof ApiError && err.status === 403) {
            setError(`权限拦截：${errorMessage(err)}`);
          }
          // 404 不致命：该标识可能只存在于批次血缘里，没有检验台账
        }
      }

      // 2. 批次检索：命中批次清单（过滤条件全部在服务端 SQL 内完成）
      const search = await api.get<BatchSearchResponse>('/traceability/batches', {
        ...(batchKey !== '' ? { batchNo: batchKey } : {}),
        ...(orderKey !== '' ? { orderNo: orderKey } : {}),
        ...(materialKey !== '' ? { materialCode: materialKey } : {}),
        ...(productKey !== '' ? { productName: productKey } : {}),
        pageSize: 50,
      });
      setCandidates(search.items);
      setCandidateTotal(search.total);

      // 3. 决定是否自动开图：只在「条件唯一命中一个批次」时自动展开，
      //    多个命中一律先让用户看清单再点选，避免默认挑一个造成误读。
      const exact = batchKey !== '' ? search.items.find((item) => item.batchNo === batchKey) : undefined;
      const root = exact ?? (search.items.length === 1 ? search.items[0] : undefined);
      if (root !== undefined) {
        await loadGraph(root.batchNo);
      } else {
        setGraph(null);
        setActiveBatchNo(null);
        if (search.items.length === 0) {
          setNotice('没有匹配到任何批次，请放宽检索条件后重试。');
        }
      }
    } catch (err) {
      setError(errorMessage(err));
      setCandidates(null);
      setGraph(null);
      setActiveBatchNo(null);
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setBatchNo('');
    setOrderNo('');
    setMaterialCode('');
    setProductName('');
    setDirection('BOTH');
    setCandidates(null);
    setCandidateTotal(0);
    setOrderChain(null);
    setGraph(null);
    setActiveBatchNo(null);
    setError(null);
    setNotice(null);
  }

  function handleDirectionChange(next: TraceDirection) {
    setDirection(next);
    if (activeBatchNo !== null) {
      void loadGraph(activeBatchNo, next);
    }
  }

  /**
   * 导出追溯报告：在打印窗口内生成可「另存为 PDF」的表格化报告。
   * 口径与页面一致（节点表带批次号 + 炉批号 + 物料编码），并显式标注
   * 追溯方向与影响面，避免把分支血缘导出成「一条单链」。
   */
  const handleExportReport = (): void => {
    if (graph === null || graph.nodes.length === 0) {
      alert('请先查询出批次追溯链，再导出报告。');
      return;
    }

    const printWin = window.open('', '_blank');
    if (printWin === null) {
      alert('弹窗已被浏览器拦截，请允许弹窗以导出追溯报告。');
      return;
    }

    const sortedNodes = [...graph.nodes].sort((a, b) =>
      String(a.timestamp).localeCompare(String(b.timestamp))
    );
    const directionLabel = DIRECTION_OPTIONS.find((opt) => opt.value === direction)?.label ?? direction;
    const summary = summarizeGraphStatus(graph.nodes);

    const nodesTable = sortedNodes
      .map((node, idx) => {
        const statusText =
          node.nodeStatus === 'CONCESSION'
            ? `特采 ${display(node.mrbNo)}`
            : (NODE_STATUS_LABEL[node.nodeStatus] ?? node.nodeStatus);
        const color =
          node.nodeStatus === 'FAILED' ? '#dc2626' : node.nodeStatus === 'CONCESSION' ? '#b45309' : '#16a34a';
        return `<tr>
        <td style="text-align:center">${idx + 1}</td>
        <td style="font-weight:bold;color:#1e293b">${display(node.stageName)}</td>
        <td style="font-family:monospace">${display(node.inspectionOrderNo)}</td>
        <td style="font-family:monospace;font-weight:bold;color:#2563eb">${display(node.batchNo)}</td>
        <td style="font-family:monospace">${display(node.furnaceHeatBatchNo)}</td>
        <td style="font-family:monospace">${display(node.materialCode)}</td>
        <td>${display(node.materialName)}</td>
        <td style="font-family:monospace">${display(node.orderNo)}</td>
        <td>${display(node.supplierOrCustomer)}</td>
        <td style="text-align:center;font-weight:bold;color:${color}">${statusText}</td>
      </tr>`;
      })
      .join('');

    const edgesTable = graph.edges
      .map(
        (edge, idx) => `<tr>
        <td style="text-align:center">${idx + 1}</td>
        <td style="font-family:monospace">${display(edge.sourceBatchNo)}</td>
        <td style="font-family:monospace">${display(edge.targetBatchNo)}</td>
        <td>${display(edge.relationType)}</td>
        <td style="text-align:center">${edge.depth}</td>
      </tr>`
      )
      .join('');

    printWin.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>乐天紧固件 - 质量追溯报告 (${graph.batchNo})</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; padding: 32px; color: #0f172a; }
          .header { border-bottom: 2px solid #2563eb; padding-bottom: 16px; margin-bottom: 20px; }
          .title { font-size: 22px; font-weight: bold; color: #0f172a; margin-bottom: 8px; }
          .meta { font-size: 13px; color: #475569; line-height: 1.7; }
          .note { margin-top: 10px; font-size: 12px; color: #b45309; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 8px 10px; }
          .btn-print { margin: 16px 0; padding: 8px 18px; background: #2563eb; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; font-size: 13px; }
          h3 { font-size: 14px; color: #334155; margin: 24px 0 0; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 12px; }
          th { background: #f1f5f9; padding: 10px; border: 1px solid #cbd5e1; text-align: left; font-weight: 600; color: #334155; }
          td { padding: 8px; border: 1px solid #cbd5e1; }
          .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; display: flex; justify-content: space-between; }
          @media print { .btn-print { display: none; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="title">乐天紧固件批次血缘质量追溯报告 (Quality Traceability Report)</div>
          <div class="meta">
            <strong>目标追溯批次：</strong> ${graph.batchNo} &nbsp;|&nbsp;
            <strong>追溯方向：</strong> ${directionLabel} &nbsp;|&nbsp;
            <strong>节点数：</strong> ${graph.nodes.length} &nbsp;|&nbsp;
            <strong>流转关系：</strong> ${graph.edges.length} 条 &nbsp;|&nbsp;
            <strong>是否成环：</strong> ${graph.hasCycle ? '是（需人工复核）' : '否'}<br />
            <strong>链路状态：</strong> ${summary.label} &nbsp;|&nbsp;
            <strong>影响面（按生产流向）：</strong> 下游批次 ${graph.impact.downstreamBatchCount} / 上游批次 ${graph.impact.upstreamBatchCount} / 下游关联单据 ${graph.impact.downstreamOrderCount} 张 / 下游单位 ${graph.impact.downstreamPartyCount} 家 &nbsp;|&nbsp;
            <strong>生成时间：</strong> ${new Date().toLocaleString()}
          </div>
          <div class="note">
            本报告以批次号为主键，只呈现数据库中真实存在的血缘节点与流转关系；特采（让步接收）节点必须同时具备 MRB 单号与客户书面授权件，
            缺一不可放行。节点按发生时间排列，分支关系请以「流转关系」表为准。
          </div>
        </div>
        <button class="btn-print" onclick="window.print()">点击打印 / 另存为 PDF</button>
        <h3>一、追溯节点</h3>
        <table>
          <thead>
            <tr>
              <th style="width: 36px; text-align: center;">#</th>
              <th>工序阶段</th>
              <th>检验单号</th>
              <th>批次号</th>
              <th>炉批号</th>
              <th>物料编码</th>
              <th>物料名称</th>
              <th>来源单据</th>
              <th>车间 / 供应商 / 客户</th>
              <th style="text-align: center;">状态</th>
            </tr>
          </thead>
          <tbody>
            ${nodesTable}
          </tbody>
        </table>
        <h3>二、流转关系</h3>
        <table>
          <thead>
            <tr>
              <th style="width: 36px; text-align: center;">#</th>
              <th>上游批次</th>
              <th>下游批次</th>
              <th>关系类型</th>
              <th style="width: 60px; text-align: center;">层级</th>
            </tr>
          </thead>
          <tbody>
            ${edgesTable}
          </tbody>
        </table>
        <div class="footer">
          <span>乐天智能质量管理系统 (Letian QMS) 真实数据追溯</span>
          <span>出具单位：质量管理部</span>
        </div>
      </body>
      </html>
    `);
    printWin.document.close();
  };

  /** 状态徽标：未知状态回退到「待检验」配色，绝不静默丢弃节点 */
  const renderStatus = (status: GraphNode['nodeStatus']) => {
    const tone = STATUS_TONE[status] ?? FALLBACK_TONE;
    return (
      <span className={`inline-block px-2 py-0.5 text-[11px] rounded ${tone.badge}`}>
        {NODE_STATUS_LABEL[status] ?? status}
      </span>
    );
  };

  const directionHint = DIRECTION_OPTIONS.find((opt) => opt.value === direction)?.hint ?? '';
  const graphSummary = graph === null ? null : summarizeGraphStatus(graph.nodes);
  const rootNode =
    graph === null ? undefined : (graph.nodes.find((node) => node.batchNo === graph.batchNo) ?? graph.nodes[0]);
  return (
    <div className="space-y-4">
      {/* 标题 + 导出（导出按钮全局唯一，不在右上角重复挂第二个「查询」按钮） */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-800">质量追溯看板</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            批次号 / 炉批号是追溯主键 · 订单号、物料编码、成品名称只是检索条件 · 不合格与特采分别用红色 / 琥珀色标注 · 结果受物料权限（PBAC）过滤
          </p>
        </div>
        <button
          type="button"
          onClick={handleExportReport}
          className="bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs px-3 py-1.5 rounded flex items-center gap-1.5 shadow-sm"
        >
          <Download className="w-3.5 h-3.5" />
          <span>导出追溯报告</span>
        </button>
      </div>

      {/* 检索栏 */}
      <div className="bg-white border border-slate-100 rounded-lg p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-end gap-4 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">批次号 / 炉批号（追溯主键）</span>
            <input
              type="text"
              placeholder="如 LOT-2026-FN-01"
              value={batchNo}
              onChange={(e) => setBatchNo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleSearch()}
              className="border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 w-52 bg-white focus:outline-none focus:border-blue-500"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">订单号（客户订单 / 出库单 / 工单 / 检验单）</span>
            <input
              type="text"
              placeholder="如 PO-B-002"
              value={orderNo}
              onChange={(e) => setOrderNo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleSearch()}
              className="border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 w-56 bg-white focus:outline-none focus:border-blue-500"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">物料编码</span>
            <input
              type="text"
              placeholder="如 MAT-35CRMO-08"
              value={materialCode}
              onChange={(e) => setMaterialCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleSearch()}
              className="border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 w-40 bg-white focus:outline-none focus:border-blue-500"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">成品名称</span>
            <input
              type="text"
              placeholder="如 风电法兰"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleSearch()}
              className="border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 w-44 bg-white focus:outline-none focus:border-blue-500"
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-slate-500">追溯方向</span>
            <div className="flex items-center rounded border border-slate-200 overflow-hidden">
              {DIRECTION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  title={opt.hint}
                  onClick={() => handleDirectionChange(opt.value)}
                  className={`px-3 py-1.5 ${
                    direction === opt.value
                      ? 'bg-[#2563EB] text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleReset}
              className="bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 px-3 py-1.5 rounded shadow-sm"
            >
              重置
            </button>
            <button
              type="button"
              onClick={() => void handleSearch()}
              disabled={loading}
              className="bg-[#2563EB] hover:bg-blue-700 disabled:opacity-60 text-white px-4 py-1.5 rounded shadow-sm flex items-center gap-1.5"
            >
              <Search className="w-3 h-3" />
              {loading ? '穿透中...' : '查询追溯链'}
            </button>
          </div>
        </div>
        <p className="text-[11px] text-slate-400">追溯方向：{directionHint}</p>
      </div>

      {error !== null && (
        <div className="rounded border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs text-rose-700">{error}</div>
      )}
      {notice !== null && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs text-amber-700">{notice}</div>
      )}

      {/* 首次进入的空态指引 */}
      {candidates === null && orderChain === null && graph === null && !loading && error === null && notice === null && (
        <div className="bg-white border border-slate-100 rounded-lg p-10 text-center text-xs text-slate-400 shadow-sm space-y-1">
          <div>输入批次号 / 炉批号（追溯主键）开图，或用订单号、物料编码、成品名称筛出候选批次后再点选。</div>
          <div>权限不足时提示「权限拦截」，与「查不到数据」分开显示，避免把拦截误读成不存在。</div>
        </div>
      )}

      {/* 订单维度：只叫「本订单检验环节」，它是并列台账而不是血缘链路 */}
      {orderChain !== null && (
        <div className="bg-white border border-slate-100 rounded-lg p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-1 h-4 rounded bg-indigo-500" />
              <h2 className="text-[13px] font-semibold text-slate-800">本订单检验环节 — {orderChain.orderNo}</h2>
            </div>
            <span className="text-[11px] text-slate-400">
              按「{MATCHED_BY_LABEL[orderChain.matchedBy]}」命中 · 并列台账，非血缘链路
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-xs">
            {[
              { label: '客户', value: display(orderChain.customerName) },
              { label: '客户订单号', value: display(orderChain.salesOrderPoNo), mono: true },
              { label: '销售出库单号', value: display(orderChain.salesOrderNo), mono: true },
              { label: 'ERP 状态', value: display(orderChain.erpStatus) },
              { label: '成品编码', value: display(orderChain.materialCode), mono: true },
              { label: '成品名称', value: display(orderChain.materialName) },
              { label: '出货数量', value: orderChain.totalQty === undefined ? '—' : String(orderChain.totalQty) },
              { label: '涉及批次', value: orderChain.batchNos.length === 0 ? '—' : orderChain.batchNos.join('、'), mono: true },
            ].map((item) => (
              <div key={item.label} className="flex items-start gap-2">
                <span className="text-slate-400 shrink-0">{item.label}</span>
                <span className={`text-slate-800 break-all ${item.mono === true ? 'font-mono' : ''}`}>{item.value}</span>
              </div>
            ))}
          </div>
          {orderChain.stages.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-400">该订单尚无检验台账记录。</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-100 text-left">
                    <th className="py-1.5 w-12 text-center font-medium">序号</th>
                    <th className="py-1.5 font-medium">环节</th>
                    <th className="py-1.5 font-medium">检验单号</th>
                    <th className="py-1.5 font-medium">受检批次</th>
                    <th className="py-1.5 font-medium">来源单据</th>
                    <th className="py-1.5 font-medium">状态</th>
                    <th className="py-1.5 font-medium">检验人</th>
                    <th className="py-1.5 font-medium">时间</th>
                    <th className="py-1.5 font-medium">耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {orderChain.stages.map((stage) => (
                    <tr key={`${stage.orderType}-${stage.orderNo}-${stage.batchNo}`} className="border-b border-slate-50">
                      <td className="py-1.5 text-center text-slate-400">{stage.seq}</td>
                      <td className="py-1.5 text-slate-700">{stage.stageName}</td>
                      <td className="py-1.5 font-mono text-slate-700">{stage.orderNo}</td>
                      <td className="py-1.5 font-mono">
                        <button
                          type="button"
                          onClick={() => {
                            setBatchNo(stage.batchNo);
                            void loadGraph(stage.batchNo);
                          }}
                          className="text-blue-600 hover:underline"
                        >
                          {stage.batchNo}
                        </button>
                      </td>
                      <td className="py-1.5 font-mono text-slate-500">{display(stage.sourceDocNo)}</td>
                      <td className="py-1.5">{renderStatus(stage.status)}</td>
                      <td className="py-1.5 text-slate-600">{display(stage.inspectorName)}</td>
                      <td className="py-1.5 font-mono text-slate-500">{formatTime(stage.occurredAt)}</td>
                      <td className="py-1.5 text-slate-500">{formatDuration(stage.durationMinutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 批次检索结果：点选某一行即以该批次为根开图 */}
      {candidates !== null && (
        <div className="bg-white border border-slate-100 rounded-lg p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-slate-800">匹配到的批次 — 共 {candidateTotal} 个</h2>
            <span className="text-[11px] text-slate-400">点击某一行，以该批次为根开图（同订单下的多个批次是并列的，不是一条链）</span>
          </div>
          {candidates.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-400">
              没有命中批次。请放宽检索条件，或确认该批次尚未建立检验台账 / 血缘节点。
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-100 text-left">
                    <th className="py-1.5 font-medium">批次号</th>
                    <th className="py-1.5 font-medium">炉批号</th>
                    <th className="py-1.5 font-medium">物料编码</th>
                    <th className="py-1.5 font-medium">物料名称</th>
                    <th className="py-1.5 font-medium">最近环节</th>
                    <th className="py-1.5 font-medium">状态</th>
                    <th className="py-1.5 font-medium">关联检验单</th>
                    <th className="py-1.5 font-medium">数据来源</th>
                    <th className="py-1.5 font-medium">时间</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((item) => (
                    <tr
                      key={item.batchNo}
                      onClick={() => {
                        setBatchNo(item.batchNo);
                        void loadGraph(item.batchNo);
                      }}
                      className={`border-b border-slate-50 cursor-pointer hover:bg-slate-50 ${
                        activeBatchNo === item.batchNo ? 'bg-blue-50' : ''
                      }`}
                    >
                      <td className="py-1.5 font-mono font-semibold text-blue-600">{item.batchNo}</td>
                      <td className="py-1.5 font-mono text-slate-600">{display(item.furnaceHeatBatchNo)}</td>
                      <td className="py-1.5 font-mono text-slate-600">{display(item.materialCode)}</td>
                      <td className="py-1.5 text-slate-700">{display(item.materialName)}</td>
                      <td className="py-1.5 text-slate-600">{display(item.stageName)}</td>
                      <td className="py-1.5">
                        {item.nodeStatus === undefined ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          renderStatus(item.nodeStatus)
                        )}
                      </td>
                      <td className="py-1.5 font-mono text-slate-600">{display(item.inspectionOrderNo ?? item.orderNo)}</td>
                      <td className="py-1.5 text-slate-500">
                        {item.sources.map((src) => (src === 'TRACE_NODE' ? '已建血缘' : '仅检验台账')).join(' · ')}
                      </td>
                      <td className="py-1.5 font-mono text-slate-500">{formatTime(item.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {/* 批次概览 + 影响面（影响面恒按生产流向计算，与查询方向无关） */}
      {graph !== null && (
        <div className="bg-white border border-slate-100 rounded-lg p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-amber-500 text-sm">📦</span>
              <h2 className="text-[13px] font-semibold text-slate-800">批次追溯概览 — {graph.batchNo}</h2>
            </div>
            <div className="flex items-center gap-2 text-xs">
              {graphSummary !== null && (
                <span className={`px-2 py-0.5 rounded ${graphSummary.tone}`}>{graphSummary.label}</span>
              )}
              {graph.hasCycle ? (
                <span className="bg-amber-50 text-amber-600 border border-amber-200 px-2 py-0.5 rounded">
                  检测到环形流转（数据需人工复核）
                </span>
              ) : (
                <span className="bg-slate-50 text-slate-500 border border-slate-200 px-2 py-0.5 rounded">无环</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-xs">
            {[
              { label: '批次号', value: graph.batchNo, mono: true },
              { label: '炉批号', value: display(rootNode?.furnaceHeatBatchNo), mono: true },
              { label: '物料编码', value: display(rootNode?.materialCode), mono: true },
              { label: '物料名称', value: display(rootNode?.materialName), mono: false },
            ].map((item) => (
              <div key={item.label} className="flex items-start gap-2">
                <span className="text-slate-400 shrink-0">{item.label}</span>
                <span className={`text-slate-800 break-all ${item.mono ? 'font-mono' : ''}`}>{item.value}</span>
              </div>
            ))}
          </div>

          <div className="rounded border border-slate-100 bg-slate-50/60 p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold text-slate-700">影响面</span>
              <span className="text-slate-400">按生产流向统计，与当前查询方向无关</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded">
                下游批次 {graph.impact.downstreamBatchCount}
              </span>
              <span className="bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded">
                上游批次 {graph.impact.upstreamBatchCount}
              </span>
              <span className="bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded">
                下游关联单据 {graph.impact.downstreamOrderCount} 张
              </span>
              <span className="bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded">
                下游单位 {graph.impact.downstreamPartyCount} 家
              </span>
            </div>
            {(graph.impact.downstreamOrderNos.length > 0 || graph.impact.downstreamParties.length > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px] text-slate-600">
                <div className="break-all">
                  <span className="text-slate-400">下游关联单据：</span>
                  {graph.impact.downstreamOrderNos.length === 0 ? '—' : graph.impact.downstreamOrderNos.join('、')}
                </div>
                <div className="break-all">
                  <span className="text-slate-400">下游单位：</span>
                  {graph.impact.downstreamParties.length === 0 ? '—' : graph.impact.downstreamParties.join('、')}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 批次血缘链路（穷尽性追溯由这里承担，「完整」二字只用于批次维度） */}
      {graph !== null && (
        <div className="bg-white border border-slate-100 rounded-lg p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-slate-800">完整质量追溯链路（批次血缘）</h2>
            <span className="text-[11px] text-slate-400">
              根批次 {graph.batchNo} · {graph.nodes.length} 个节点 · {graph.edges.length} 条流转关系
            </span>
          </div>

          {/* 图例：必须覆盖契约枚举的全部 6 个取值，缺项会让「已入库」被读成「已合格」 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-slate-500">
            {TRACE_STATUS_LEGEND.map((item) => (
              <span key={item.status} className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${STATUS_TONE[item.status].dot}`} />
                {item.label}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span className="text-blue-500 font-bold">★</span>
              本次查询的根批次
            </span>
          </div>

          {graph.nodes.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">
              该批次没有可穿透的追溯节点（或均不在当前账号权限范围内）
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-stretch gap-2 pb-1">
                {graph.nodes.map((node) => {
                  const tone = STATUS_TONE[node.nodeStatus] ?? FALLBACK_TONE;
                  const isRoot = node.batchNo === graph.batchNo;
                  return (
                    <div
                      key={node.nodeId}
                      className={`flex-1 min-w-[220px] max-w-[320px] rounded-lg p-3.5 border transition-all ${tone.border} ${
                        isRoot ? 'ring-1 ring-blue-300' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-slate-500 font-medium">{display(node.stageName)}</span>
                        {isRoot && <span className="text-[10px] text-blue-500 shrink-0">★ 根批次</span>}
                      </div>
                      <div className="text-xs font-mono font-semibold text-blue-700 mt-1 break-all">
                        批次号: {display(node.batchNo)}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5 font-mono break-all">
                        炉批号: {display(node.furnaceHeatBatchNo)}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5 font-mono break-all">
                        检验单号: {display(node.inspectionOrderNo)}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono break-all">
                        来源单据: {display(node.orderNo)}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1 font-mono break-all">
                        物料编码: {display(node.materialCode)}
                      </div>
                      <div className="text-[11px] text-slate-600 mt-0.5 break-all">{display(node.materialName)}</div>
                      <div className="text-[11px] text-slate-600 mt-0.5">执行: {display(node.operatorName)}</div>
                      {node.supplierOrCustomer !== undefined && node.supplierOrCustomer !== '' && (
                        <div className="text-[11px] text-slate-600 mt-0.5 break-all">{node.supplierOrCustomer}</div>
                      )}
                      <div className="text-[10px] text-slate-400 mt-0.5 font-mono">{formatTime(node.timestamp)}</div>
                      <div className="mt-3">{renderStatus(node.nodeStatus)}</div>
                      {node.nodeStatus === 'CONCESSION' && (
                        <div className="mt-2 rounded border border-amber-200 bg-amber-50/60 p-2 text-[11px] text-amber-800 space-y-0.5">
                          <div className="break-all">
                            MRB 单号：<span className="font-mono">{display(node.mrbNo)}</span>
                          </div>
                          <div className="break-all">
                            客户授权件：
                            {node.concessionAttachmentUrl === undefined || node.concessionAttachmentUrl === '' ? (
                              <span className="text-rose-600 font-medium">缺客户授权件（不得视为已放行）</span>
                            ) : (
                              <a
                                className="text-blue-600 hover:underline"
                                href={node.concessionAttachmentUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                查看授权件
                              </a>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <p className="text-[11px] text-slate-400">
                节点按发生时间排列；分支链路不可按时间横排理解为单链，真实上下游关系以「流转关系」表为准。
              </p>

              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-700">
                  流转关系（{graph.edges.length} 条）
                </summary>
                <table className="w-full text-xs mt-2">
                  <thead>
                    <tr className="text-slate-400 border-b border-slate-100 text-left">
                      <th className="py-1.5 w-10 text-center font-medium">#</th>
                      <th className="py-1.5 font-medium">上游批次</th>
                      <th className="py-1.5 font-medium">下游批次</th>
                      <th className="py-1.5 font-medium">关系类型</th>
                      <th className="py-1.5 w-16 text-center font-medium">层级</th>
                    </tr>
                  </thead>
                  <tbody>
                    {graph.edges.map((edge, index) => (
                      <tr
                        key={`${edge.sourceBatchNo}-${edge.targetBatchNo}-${index}`}
                        className="border-b border-slate-50"
                      >
                        <td className="py-1.5 text-center text-slate-400">{index + 1}</td>
                        <td className="py-1.5 font-mono text-slate-700">{display(edge.sourceBatchNo)}</td>
                        <td className="py-1.5 font-mono text-slate-700">{display(edge.targetBatchNo)}</td>
                        <td className="py-1.5 text-slate-600">{display(edge.relationType)}</td>
                        <td className="py-1.5 text-center text-slate-500">{edge.depth}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default TraceabilityPage;
