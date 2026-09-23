/**
 * 质检方案来源提示条（检验录入页 / 检验单回看页通用）
 *
 * 口径唯一真相：docs/17-检验录入界面说明与质检方案匹配口径.md §7
 * 该组件只负责"把指标清单的判定依据直白地告诉质检员"，两种来源必须一眼可分：
 *   1) MATCH（新建 / 继续录入）：亮出命中方案 + 命中来源（物料专属 or 分类兜底）+ 抽样方案 + 指标项数；
 *      未命中 → 引导联系质量工程师配置方案，并提供重试（绝不静默用演示数据顶替）。
 *   2) SNAPSHOT（只读回看）：亮出**本单建单时固化的方案快照**（§7.3「快照即证据」），
 *      明确写清"方案后续改版不影响本单"，绝不再声称"已匹配当前方案"。
 */
import React from 'react';
import { AlertTriangle, ClipboardList, History, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { MatchedPlanState } from '../../hooks/useMatchedPlan';
import { INSPECTION_STATUS_LABELS } from '../../lib/inspectionTypes';
import { matchSourceLabel } from '../../lib/planMatch';
import type { InspectionOrder } from '../../lib/planMatch';

interface PlanMatchBannerProps {
  state: MatchedPlanState;
  /** 当前匹配用的物料编码（仅用于文案展示） */
  materialCode?: string | null;
  /** 当前匹配用的检验类型（仅用于文案展示） */
  inspectionType?: string | null;
  /** 紧凑模式：用于弹窗内等窄容器 */
  compact?: boolean;
}

/** 快照生成时间：只展示到分钟，够回溯即可 */
function snapshotTimeText(snapshotAt: string | undefined): string | null {
  if (snapshotAt === undefined || snapshotAt.trim() === '') return null;
  const parsed = new Date(snapshotAt);
  if (Number.isNaN(parsed.getTime())) return snapshotAt;
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

/** 回看模式下工单的状态与终判：一条都不编造，缺失就不显示 */
function OrderProgress({ order }: { order: InspectionOrder }) {
  const statusLabel = INSPECTION_STATUS_LABELS[order.status] ?? order.status;
  const decisionLabel =
    order.overallDecision === 'PASSED'
      ? '综合判定：合格'
      : order.overallDecision === 'FAILED'
      ? '综合判定：不合格'
      : order.overallDecision === 'CONCESSION'
      ? '综合判定：让步接收'
      : '尚未形成综合判定';
  return (
    <>
      <span className="text-indigo-800">
        工单 <span className="font-mono font-semibold">{order.orderNo}</span>
      </span>
      <span className="px-1.5 py-0.5 rounded bg-white border border-indigo-200 text-[11px] text-indigo-700">
        {statusLabel}
      </span>
      <span className="text-indigo-800">{decisionLabel}</span>
    </>
  );
}

export const PlanMatchBanner: React.FC<PlanMatchBannerProps> = ({
  state,
  materialCode,
  inspectionType,
  compact = false,
}) => {
  const { status, display, error, message, reload, source, order, permissionDenied } = state;
  const isSnapshot = source === 'SNAPSHOT';
  const code = materialCode && materialCode.trim() !== '' ? materialCode.trim() : '—';
  const sourceTag = isSnapshot ? '本单方案快照' : '已匹配质检方案';
  const padded = compact ? 'px-3 py-2' : 'px-4 py-2.5';
  const snapshotAt = snapshotTimeText(display?.snapshotAt);

  if (status === 'ready' && display !== null) {
    return (
      <div
        data-testid="plan-match-banner"
        data-status="ready"
        data-source={source}
        className={`${
          isSnapshot
            ? 'bg-indigo-50/70 border border-indigo-200 text-indigo-900'
            : 'bg-emerald-50/70 border border-emerald-200 text-emerald-900'
        } rounded-lg shadow-sm text-xs ${padded}`}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span
            className={`inline-flex items-center gap-1 font-bold text-white px-2 py-0.5 rounded text-[11px] ${
              isSnapshot ? 'bg-indigo-600' : 'bg-emerald-600'
            }`}
          >
            {isSnapshot ? <History className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            {sourceTag}
          </span>
          <span className="font-semibold">
            {display.planName}
            <span className="ml-1 font-mono text-[11px] opacity-80">{display.planCode}</span>
          </span>
          <span>
            版本 <strong className="font-mono">{display.versionNo}</strong>
          </span>
          {display.matchSource !== undefined && (
            <span className="px-1.5 py-0.5 rounded bg-white border border-emerald-200 text-[11px] text-emerald-700">
              {matchSourceLabel(display.matchSource)}
            </span>
          )}
          <span>
            抽样 {display.samplingScheme} / AQL {display.aqlLevel} / {display.strictness}
          </span>
          <span className="inline-flex items-center gap-1 font-semibold">
            <ClipboardList className="w-3.5 h-3.5" />
            {isSnapshot ? '本单指标' : '待检指标'} {state.rows.length} 项
          </span>
          {order !== null && <OrderProgress order={order} />}
        </div>
        <div className={`mt-1 text-[11px] ${isSnapshot ? 'text-indigo-700/90' : 'text-emerald-700/90'}`}>
          {isSnapshot ? (
            <>
              判定依据：<strong>本单建单时固化的方案快照</strong>
              {snapshotAt !== null && <>，快照时间 <span className="font-mono">{snapshotAt}</span></>}
              ；实测值与单项判定一律取本单落库结果。方案（含标准值）后续改版不会改写本单历史结论
              （<span className="font-mono">§7.3 快照即证据</span>）。
            </>
          ) : (
            <>
              匹配依据：物料 <span className="font-mono">{code}</span> + 检验类型{' '}
              <span className="font-mono">{inspectionType ?? '—'}</span>；方案版本 ID 将随本单一起绑定留档
              （<span className="font-mono">{(display.planVersionId ?? '').slice(0, 8)}…</span>）。
            </>
          )}
        </div>
      </div>
    );
  }

  if (status === 'loading') {
    return (
      <div
        data-testid="plan-match-banner"
        data-status="loading"
        data-source={source}
        className={`bg-blue-50/70 border border-blue-200 rounded-lg shadow-sm text-xs text-blue-800 flex items-center gap-2 ${padded}`}
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        {isSnapshot ? (
          <>正在加载本单方案快照（指标清单与落库判定以工单为准）…</>
        ) : (
          <>
            正在按物料 <span className="font-mono font-semibold">{code}</span> 匹配质检方案…
          </>
        )}
      </div>
    );
  }

  if (status === 'idle') {
    return (
      <div
        data-testid="plan-match-banner"
        data-status="idle"
        data-source={source}
        className={`bg-slate-50 border border-slate-200 rounded-lg shadow-sm text-xs text-slate-600 ${padded}`}
      >
        {message ?? '尚未发起质检方案匹配'}
      </div>
    );
  }

  const isNotFound = status === 'not-found';
  /**
   * PBAC 数据权限拦截（403）：**方案可能就在那里**，与"方案没配"是两种完全不同的失败。
   * 组合状态里 `permissionDenied` 由 Hook 按错误码判定，这里只负责分开文案（docs/42 §2.2）。
   */
  const isPermissionDenied = !isSnapshot && permissionDenied;
  const title = isSnapshot
    ? isNotFound
      ? '未找到该检验单'
      : '检验单方案快照加载失败'
    : isPermissionDenied
    ? '无该物料的数据权限'
    : isNotFound
    ? '未匹配到质检方案'
    : '质检方案匹配失败';
  const hint = isSnapshot ? (
    <>
      回看口径：指标清单与判定依据应取自本单建单时固化的方案快照（
      <span className="font-mono">GET /api/v1/inspections/{'{'}id{'}'}</span>
      ）。为不误导判定，本单不会展示任何按"当前生效方案"重算的指标行。
    </>
  ) : isPermissionDenied ? (
    <>
      本单不展示任何演示指标行。请由管理员在「系统管理 - 物料权限」中核查当前账号的物料数据权限（PBAC）策略：
      需覆盖物料 <span className="font-mono">{code}</span> 或其所属存货分类；若策略已覆盖仍被拦截，
      请把上方拦截详情（用户 / 物料分类 / 物料 / 供应商）一并提供给管理员定位。
    </>
  ) : (
    <>
      匹配依据：物料 <span className="font-mono">{code}</span> + 检验类型{' '}
      <span className="font-mono">{inspectionType ?? '—'}</span>。本单不再展示任何演示指标行，
      请先由质量工程师在「质检方案设计」中为该物料（或其存货分类）建立并启用方案。
    </>
  );

  return (
    <div
      data-testid="plan-match-banner"
      data-status={isNotFound ? 'not-found' : 'error'}
      data-permission-denied={isPermissionDenied ? 'true' : 'false'}
      data-source={source}
      className={`border rounded-lg shadow-sm text-xs flex items-start justify-between gap-3 ${
        isNotFound ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-rose-50 border-rose-300 text-rose-900'
      } ${padded}`}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className={`w-4 h-4 shrink-0 mt-0.5 ${isNotFound ? 'text-amber-500' : 'text-rose-500'}`} />
        <div className="space-y-0.5">
          <div className="font-semibold">{title}</div>
          <div className="text-[11px] leading-relaxed">
            {error ?? '未知原因'}
            <span className="block mt-0.5 opacity-80">{hint}</span>
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={reload}
        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white/70 font-medium hover:bg-white"
      >
        <RefreshCw className="w-3 h-3" /> {isSnapshot ? '重新加载' : '重新匹配'}
      </button>
    </div>
  );
};
