/**
 * 检验录入页 · 质检方案匹配 / 本单快照 Hook
 *
 * 口径唯一真相：docs/17-检验录入界面说明与质检方案匹配口径.md §7
 *
 * 两种模式，一个 Hook（避免表单各自判断，导致"回看读当前方案"的口径漂移）：
 *   1) MATCH（新建 / 继续录入）：按「物料编码 + 检验类型」问服务端要**当前生效方案**，
 *      未命中即明确失败（404 → not-found），绝不用演示数据顶替真实方案；
 *   2) SNAPSHOT（只读回看，readOnly + orderId）：读 `GET /api/v1/inspections/{id}` 的
 *      **本单方案快照**（§7.3「快照即证据」），实测值与判定取工单落库值，方案改版不影响历史工单。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { InspectionType } from '@letian/contracts';
import {
  fetchInspectionOrder,
  fetchMatchedPlan,
  isPlanNotFoundError,
  orderItemsToIndicatorRows,
  planMatchErrorText,
  snapshotToDisplayMeta,
  toPlanIndicatorRow,
} from '../lib/planMatch';
import type {
  InspectionOrder,
  MatchedPlan,
  PlanDisplayMeta,
  PlanIndicatorRow,
  PlanRowSource,
} from '../lib/planMatch';

/** ready = 方案已命中 / 快照已加载，指标行可渲染 */
export type PlanMatchStatus = 'idle' | 'loading' | 'ready' | 'not-found' | 'error';

export interface MatchedPlanState {
  status: PlanMatchStatus;
  /** 指标行来源：MATCH = 当前生效方案；SNAPSHOT = 本单方案快照 */
  source: PlanRowSource;
  /** 待检 / 回看指标行（status = ready 时有值；其余状态为空数组，绝不渲染演示行） */
  rows: PlanIndicatorRow[];
  /** 提示条展示用的方案元数据（方案编码 / 版本 / 抽样方案等） */
  display: PlanDisplayMeta | null;
  /**
   * 方案版本行 UUID：MATCH 模式下随建单原样回传以固化快照；
   * SNAPSHOT 模式下是工单已绑定的版本（只读回看，不再回传建单）。
   */
  planVersionId: string | null;
  /** 命中来源：只有 MATCH 模式有值；SNAPSHOT 模式恒为 null（当时怎么命中的不编造） */
  matchSource: MatchedPlan['matchSource'] | null;
  /** 只读回看：工单详情本体（单号 / 状态 / 终判 / 备注等回填用），非回看模式为 null */
  order: InspectionOrder | null;
  /** 未命中/失败原因（status = not-found | error 时有值） */
  error: string | null;
  /** 未发起匹配的说明（如缺物料编码），便于页面直白提示 */
  message: string | null;
  /** 人工重试 */
  reload: () => void;
}

export interface UseMatchedPlanOptions {
  /** 工单 ID：只读回看（SNAPSHOT）模式的入口，取自检验台账行的 `id` */
  orderId?: string | null | undefined;
  /** 是否只读回看：为 true 且带 orderId 时走本单快照；否则按物料匹配当前生效方案 */
  readOnly?: boolean | undefined;
}

/**
 * @param materialCode 录入单上的物料编码；缺失时进入 idle 并给出明确提示（不猜物料）
 * @param inspectionType 检验类型（IQC / OQC_SH / OQC_SF / IPQC_* / 委外七分类）；缺失时同样进入 idle
 * @param options 只读回看参数（orderId + readOnly）
 */
export function useMatchedPlan(
  materialCode: string | null | undefined,
  inspectionType: InspectionType | null | undefined,
  options: UseMatchedPlanOptions = {}
): MatchedPlanState {
  const orderId = options.orderId ?? null;
  const readOnly = options.readOnly === true;
  /** 回看模式：必须同时具备只读意图与真实工单 ID，缺一不可（缺 ID 时退回按物料匹配） */
  const snapshotMode = readOnly && orderId !== null && orderId.trim() !== '';

  const [status, setStatus] = useState<PlanMatchStatus>('idle');
  const [plan, setPlan] = useState<MatchedPlan | null>(null);
  const [order, setOrder] = useState<InspectionOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    setPlan(null);
    setOrder(null);
    setError(null);
    setMessage(null);

    // ---------- 模式一：只读回看，读本单方案快照 ----------
    if (snapshotMode) {
      setStatus('loading');
      let cancelled = false;
      void (async () => {
        try {
          const detail = await fetchInspectionOrder(orderId);
          if (cancelled) return;
          setOrder(detail);
          setStatus('ready');
        } catch (caught) {
          if (cancelled) return;
          setError(planMatchErrorText(caught, 'SNAPSHOT'));
          setStatus(isPlanNotFoundError(caught) ? 'not-found' : 'error');
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    // ---------- 模式二：新建 / 继续录入，按物料匹配当前生效方案 ----------
    const code = materialCode?.trim() ?? '';
    if (code === '') {
      setStatus('idle');
      setMessage('本单未带物料编码，无法自动匹配质检方案，请先在检验单上补全物料编码');
      return undefined;
    }
    if (inspectionType === null || inspectionType === undefined) {
      setStatus('idle');
      setMessage('本单未确定检验类型，无法自动匹配质检方案');
      return undefined;
    }

    setStatus('loading');
    let cancelled = false;

    void (async () => {
      try {
        const matched = await fetchMatchedPlan(code, inspectionType);
        if (cancelled) return;
        setPlan(matched);
        setStatus('ready');
      } catch (caught) {
        if (cancelled) return;
        setError(planMatchErrorText(caught));
        setStatus(isPlanNotFoundError(caught) ? 'not-found' : 'error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [materialCode, inspectionType, orderId, snapshotMode, reloadToken]);

  /** 指标行：快照模式取工单实测项（含落库判定），匹配模式由方案指标项生成待检行 */
  const rows = useMemo<PlanIndicatorRow[]>(() => {
    if (order !== null) return orderItemsToIndicatorRows(order);
    if (plan !== null) return plan.items.map(toPlanIndicatorRow);
    return [];
  }, [order, plan]);

  const display = useMemo<PlanDisplayMeta | null>(() => {
    if (order !== null) return snapshotToDisplayMeta(order);
    if (plan !== null) {
      return {
        planVersionId: plan.planVersionId,
        planCode: plan.planCode,
        planName: plan.planName,
        versionNo: plan.versionNo,
        samplingScheme: plan.samplingScheme,
        aqlLevel: plan.aqlLevel,
        strictness: plan.strictness,
        matchSource: plan.matchSource,
      };
    }
    return null;
  }, [order, plan]);

  return {
    status,
    source: snapshotMode ? 'SNAPSHOT' : 'MATCH',
    rows,
    display,
    planVersionId: order?.planVersionId ?? plan?.planVersionId ?? null,
    matchSource: order !== null ? null : (plan?.matchSource ?? null),
    order,
    error,
    message,
    reload,
  };
}
