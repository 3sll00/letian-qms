import React, { useState } from 'react';
import { Download, Search } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';

/** 与后端 /traceability/graph/:batchNo 响应对齐（TraceabilityGraphResponse） */
interface GraphNode {
  nodeId: string;
  batchNo: string;
  stageName: string;
  materialName: string;
  operatorName: string;
  timestamp: string;
  nodeStatus: 'PASSED' | 'FAILED' | 'INSPECTING' | 'PENDING' | 'STORED';
  orderNo?: string | undefined;
  supplierOrCustomer?: string | undefined;
}

interface GraphResponse {
  batchNo: string;
  hasCycle: boolean;
  nodes: GraphNode[];
  edges: Array<{ sourceBatchNo: string; targetBatchNo: string; relationType: string; depth: number }>;
}

const NODE_STATUS_LABEL: Record<string, string> = {
  PASSED: '已合格',
  FAILED: '不合格',
  INSPECTING: '检验中',
  PENDING: '待检验',
  STORED: '已入库',
};

const STATUS_TONE: Record<string, { dot: string; badge: string; border: string }> = {
  PASSED: { dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-600', border: 'border-emerald-500' },
  STORED: { dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-600', border: 'border-emerald-500' },
  FAILED: { dot: 'bg-rose-500', badge: 'bg-rose-50 text-rose-600', border: 'border-rose-500' },
  INSPECTING: { dot: 'bg-blue-500', badge: 'bg-blue-50 text-blue-600', border: 'border-blue-500' },
  PENDING: { dot: 'bg-slate-400', badge: 'bg-slate-100 text-slate-600', border: 'border-slate-300' },
};

export function TraceabilityPage() {
  const [batchNo, setBatchNo] = useState('');
  const [materialHint, setMaterialHint] = useState('');
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch() {
    const target = batchNo.trim();
    if (target === '') {
      setError('请输入批次号后查询（种子数据批次形如 LOT-2026-0701，可在检验台账的批次列获取）');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<GraphResponse>(`/traceability/graph/${encodeURIComponent(target)}`, {
        direction: 'BOTH',
        maxDepth: 10,
      });
      setGraph(res);
      if (res.nodes.length === 0) {
        setMaterialHint('');
      } else {
        const hit = res.nodes.find((n) => n.batchNo === target) ?? res.nodes[0];
        setMaterialHint(hit?.materialName ?? '');
      }
    } catch (err) {
      const msg = errorMessage(err);
      // 后端 PBAC 拦截返回 403：明确提示是权限问题，而不是数据不存在
      setError(msg.includes('PBAC') || msg.includes('无权') ? `权限拦截：${msg}` : msg);
      setGraph(null);
    } finally {
      setLoading(false);
    }
  }

  const handleExportReport = () => {
    if (!graph || !graph.nodes || graph.nodes.length === 0) {
      alert('请先在搜索栏输入批次号并点击查询追溯图谱，然后再导出报告。');
      return;
    }

    const printWin = window.open('', '_blank');
    if (!printWin) {
      alert('弹窗已被浏览器拦截，请允许弹窗以导出追溯报告。');
      return;
    }

    const nodesTable = graph.nodes.map((node: any, idx: number) => `
      <tr>
        <td style="padding: 8px; border: 1px solid #cbd5e1; text-align: center;">${idx + 1}</td>
        <td style="padding: 8px; border: 1px solid #cbd5e1; font-weight: bold; color: #1e293b;">${node.stageName || node.stage || '—'}</td>
        <td style="padding: 8px; border: 1px solid #cbd5e1;">${node.materialName || '—'}</td>
        <td style="padding: 8px; border: 1px solid #cbd5e1; font-family: monospace; font-weight: bold; color: #2563eb;">${node.batchNo || '—'}</td>
        <td style="padding: 8px; border: 1px solid #cbd5e1;">${node.orderNo || '—'}</td>
        <td style="padding: 8px; border: 1px solid #cbd5e1;">${node.supplierOrCustomer || '乐天车间'}</td>
        <td style="padding: 8px; border: 1px solid #cbd5e1; text-align: center; font-weight: bold; color: ${node.nodeStatus === 'PASSED' ? '#16a34a' : '#dc2626'};">
          ${node.nodeStatus === 'PASSED' ? '合格 PASS' : node.nodeStatus || '待检'}
        </td>
      </tr>
    `).join('');

    printWin.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>乐天紧固件 - 质量追溯全链路报告 (${graph.batchNo})</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; padding: 32px; color: #0f172a; }
          .header { border-bottom: 2px solid #2563eb; padding-bottom: 16px; margin-bottom: 24px; }
          .title { font-size: 22px; font-weight: bold; color: #0f172a; margin-bottom: 8px; }
          .meta { font-size: 13px; color: #475569; line-height: 1.6; }
          .btn-print { margin: 16px 0; padding: 8px 18px; background: #2563eb; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; font-size: 13px; }
          table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; }
          th { background: #f1f5f9; padding: 10px; border: 1px solid #cbd5e1; text-align: left; font-weight: 600; color: #334155; }
          .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; display: flex; justify-content: space-between; }
          @media print { .btn-print { display: none; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="title">乐天紧固件全链路质量追溯报告 (Quality Traceability Report)</div>
          <div class="meta">
            <strong>目标追溯批次：</strong> ${graph.batchNo} &nbsp;|&nbsp;
            <strong>物料描述：</strong> ${materialHint || '紧固件成品'} &nbsp;|&nbsp;
            <strong>追溯节点总数：</strong> ${graph.nodes.length} &nbsp;|&nbsp;
            <strong>生成时间：</strong> ${new Date().toLocaleString()}
          </div>
        </div>
        <button class="btn-print" onclick="window.print()">🖨️ 点击打印 / 另存为 PDF</button>
        <table>
          <thead>
            <tr>
              <th style="width: 40px; text-align: center;">#</th>
              <th>工序阶段</th>
              <th>物料名称</th>
              <th>追溯/工序批次号</th>
              <th>关联单号</th>
              <th>车间 / 供应商</th>
              <th style="text-align: center;">质检状态</th>
            </tr>
          </thead>
          <tbody>
            ${nodesTable}
          </tbody>
        </table>
        <div class="footer">
          <span>乐天智能质量管理系统 (Letian QMS v2.6.0) 真实数据追溯</span>
          <span>出具单位：质量管理部</span>
        </div>
      </body>
      </html>
    `);
    printWin.document.close();
  };

  return (
    <div className="space-y-4">
      {/* Title + Action Buttons */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-800">质量追溯看板</h1>
          <p className="text-xs text-slate-400 mt-0.5">以物料批次为维度, 展示完整质量链路 · 红色高亮不合格节点 · 受物料权限过滤</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs px-3 py-1.5 rounded flex items-center gap-1.5 shadow-sm"
          >
            <span className="text-rose-500 font-bold text-[10px]">PDF</span>
            <span>导出追溯报告</span>
          </button>
        </div>
      </div>

      {/* Query Filter Bar */}
      <div className="bg-white border border-slate-100 rounded-lg p-4 shadow-sm flex items-center justify-between">
        <div className="flex items-center gap-6 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-600">批次号</span>
            <input
              type="text"
              placeholder="如 LOT-2026-0701"
              value={batchNo}
              onChange={(e) => setBatchNo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleSearch()}
              className="border border-slate-200 rounded px-2.5 py-1 text-slate-700 w-56 bg-white focus:outline-none focus:border-blue-500"
            />
          </div>
          {graph && (
            <div className="flex items-center gap-2 text-slate-500">
              <span>起点物料</span>
              <span className="text-slate-800 font-medium">{materialHint || '—'}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={() => {
              setBatchNo('');
              setGraph(null);
              setError(null);
              setMaterialHint('');
            }}
            className="bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 px-3 py-1 rounded shadow-sm"
          >
            重置
          </button>
          <button
            onClick={() => void handleSearch()}
            disabled={loading}
            className="bg-[#2563EB] hover:bg-blue-700 disabled:opacity-60 text-white px-4 py-1 rounded shadow-sm flex items-center gap-1.5"
          >
            <Search className="w-3 h-3" />
            {loading ? '穿透中...' : '查询追溯链'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs text-rose-700">{error}</div>
      )}

      {/* Order Info Card */}
      {graph && (
        <div className="bg-white border border-slate-100 rounded-lg p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-amber-500 text-sm">📦</span>
              <h2 className="text-[13px] font-semibold text-slate-800">批次追溯概览 — {graph.batchNo}</h2>
            </div>
            <div className="flex items-center gap-2 text-xs">
              {graph.hasCycle ? (
                <span className="bg-amber-50 text-amber-600 border border-amber-200 px-2 py-0.5 rounded text-[11px]">
                  检测到环路
                </span>
              ) : (
                <span className="bg-emerald-50 text-emerald-600 border border-emerald-200 px-2 py-0.5 rounded text-[11px]">
                  链路无环
                </span>
              )}
              <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-[11px]">
                {graph.nodes.length} 个节点 · {graph.edges.length} 条流转
              </span>
            </div>
          </div>
          <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-50">
            节点与关系来自 batch_trace_nodes / batch_trace_relations 真实库双向穿透，
            并已与检验台账使用同一套三维物料权限口径。
          </p>
        </div>
      )}

      {/* Complete Traceability Chain Card */}
      <div className="bg-white border border-slate-100 rounded-lg p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-blue-500 text-sm">🔗</span>
            <h2 className="text-[13px] font-semibold text-slate-800">完整质量追溯链路</h2>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>
              <span className="text-slate-600">已合格</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-rose-500 inline-block"></span>
              <span className="text-slate-600">不合格</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-500 inline-block"></span>
              <span className="text-slate-600">检验中</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-slate-400 inline-block"></span>
              <span className="text-slate-600">待检验</span>
            </div>
          </div>
        </div>

        {!graph && !loading && (
          <div className="py-14 text-center text-xs text-slate-400">
            输入批次号查询质量链路；无权限的批次将被后端 PBAC 拦截（403）
          </div>
        )}
        {loading && <div className="py-14 text-center text-xs text-slate-400">正在双向穿透批次 DAG...</div>}

        {/* Chain Flow Nodes Horizontal Layout */}
        {graph && !loading && graph.nodes.length > 0 && (
          <div className="flex items-center justify-between gap-3 pt-2 overflow-x-auto pb-2">
            {graph.nodes.map((node, index) => {
              const tone = STATUS_TONE[node.nodeStatus] ?? STATUS_TONE.PENDING;
              const handleExportReport = () => {
    if (!graph || !graph.nodes || graph.nodes.length === 0) {
      alert('请先在搜索栏输入批次号并点击查询追溯图谱，然后再导出报告。');
      return;
    }

    const printWin = window.open('', '_blank');
    if (!printWin) {
      alert('弹窗已被浏览器拦截，请允许弹窗以导出追溯报告。');
      return;
    }

    const nodesTable = graph.nodes.map((node: any, idx: number) => `
      <tr>
        <td style="padding: 8px; border: 1px solid #cbd5e1; text-align: center;">${idx + 1}</td>
        <td style="padding: 8px; border: 1px solid #cbd5e1; font-weight: bold; color: #1e293b;">${node.stageName || node.stage || '—'}</td>
        <td style="padding: 8px; border: 1px solid #cbd5e1;">${node.materialName || '—'}</td>
        <td style="padding: 8px; border: 1px solid #cbd5e1; font-family: monospace; font-weight: bold; color: #2563eb;">${node.batchNo || '—'}</td>
        <td style="padding: 8px; border: 1px solid #cbd5e1;">${node.orderNo || '—'}</td>
        <td style="padding: 8px; border: 1px solid #cbd5e1;">${node.supplierOrCustomer || '乐天车间'}</td>
        <td style="padding: 8px; border: 1px solid #cbd5e1; text-align: center; font-weight: bold; color: ${node.nodeStatus === 'PASSED' ? '#16a34a' : '#dc2626'};">
          ${node.nodeStatus === 'PASSED' ? '合格 PASS' : node.nodeStatus || '待检'}
        </td>
      </tr>
    `).join('');

    printWin.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>乐天紧固件 - 质量追溯全链路报告 (${graph.batchNo})</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; padding: 32px; color: #0f172a; }
          .header { border-bottom: 2px solid #2563eb; padding-bottom: 16px; margin-bottom: 24px; }
          .title { font-size: 22px; font-weight: bold; color: #0f172a; margin-bottom: 8px; }
          .meta { font-size: 13px; color: #475569; line-height: 1.6; }
          .btn-print { margin: 16px 0; padding: 8px 18px; background: #2563eb; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; font-size: 13px; }
          table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; }
          th { background: #f1f5f9; padding: 10px; border: 1px solid #cbd5e1; text-align: left; font-weight: 600; color: #334155; }
          .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; display: flex; justify-content: space-between; }
          @media print { .btn-print { display: none; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="title">乐天紧固件全链路质量追溯报告 (Quality Traceability Report)</div>
          <div class="meta">
            <strong>目标追溯批次：</strong> ${graph.batchNo} &nbsp;|&nbsp;
            <strong>物料描述：</strong> ${materialHint || '紧固件成品'} &nbsp;|&nbsp;
            <strong>追溯节点总数：</strong> ${graph.nodes.length} &nbsp;|&nbsp;
            <strong>生成时间：</strong> ${new Date().toLocaleString()}
          </div>
        </div>
        <button class="btn-print" onclick="window.print()">🖨️ 点击打印 / 另存为 PDF</button>
        <table>
          <thead>
            <tr>
              <th style="width: 40px; text-align: center;">#</th>
              <th>工序阶段</th>
              <th>物料名称</th>
              <th>追溯/工序批次号</th>
              <th>关联单号</th>
              <th>车间 / 供应商</th>
              <th style="text-align: center;">质检状态</th>
            </tr>
          </thead>
          <tbody>
            ${nodesTable}
          </tbody>
        </table>
        <div class="footer">
          <span>乐天智能质量管理系统 (Letian QMS v2.6.0) 真实数据追溯</span>
          <span>出具单位：质量管理部</span>
        </div>
      </body>
      </html>
    `);
    printWin.document.close();
  };

  return (
                <React.Fragment key={`${node.nodeId}-${index}`}>
                  <div className={`flex-1 min-w-[210px] rounded-lg p-3.5 border transition-all ${tone.border}`}>
                    <div className="text-xs text-slate-500 font-medium">{node.stageName}</div>
                    <div className="text-xs font-mono font-semibold text-slate-800 mt-1">
                      {node.orderNo ?? node.batchNo}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-2 font-mono">批次: {node.batchNo}</div>
                    <div className="text-[11px] text-slate-600 mt-0.5 whitespace-pre-line">
                      物料: {node.materialName}
                    </div>
                    <div className="text-[11px] text-slate-600 mt-0.5">执行: {node.operatorName}</div>
                    {node.supplierOrCustomer !== undefined && node.supplierOrCustomer !== '' && (
                      <div className="text-[11px] text-slate-600 mt-0.5">{node.supplierOrCustomer}</div>
                    )}
                    <div className="text-[10px] text-slate-400 mt-0.5 font-mono">{node.timestamp}</div>
                    <div className="mt-3">
                      <span className={`inline-block px-2 py-0.5 text-[11px] rounded ${tone.badge}`}>
                        {NODE_STATUS_LABEL[node.nodeStatus] ?? node.nodeStatus}
                      </span>
                    </div>
                  </div>

                  {index < graph.nodes.length - 1 && (
                    <div className="text-slate-400 text-sm shrink-0 px-1">→</div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        )}

        {graph && !loading && graph.nodes.length === 0 && (
          <div className="py-10 text-center text-xs text-slate-400">该批次没有可穿透的追溯节点（或均不在当前账号权限范围内）</div>
        )}
      </div>
    </div>
  );
}

export default TraceabilityPage;
