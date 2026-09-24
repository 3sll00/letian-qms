import type { ChainStageState, TransferDecision, TransferGateCode } from '@letian/contracts';

/**
 * 「合格后传递」展示口径（docs/48-合格后传递通用链路规则设计与改造方案.md §4.6 / §4.7）
 *
 * 三条纪律：
 * 1. **前端只翻译，不判定**：能不能传递永远由服务端 `evaluateTransferDecision` 算出来，
 *    这里只把理由码翻成中文 —— 看板、台账徽标、建单 422 用的是同一份判定，
 *    前端任何二次推导都会制造「界面说行、服务端说不行」的第二套口径。
 * 2. **放行也要给码**：`UPSTREAM_MISSING` 是「放行但上游缺失」（TBD-01），
 *    必须显式标注，不能显示成一切正常 —— 否则现场会把「没查到」读成「没问题」。
 * 3. 缺值统一显示 —（与 `lib/traceNodeFormat` 同口径），不用空串或占位串。
 */

export const TRANSFER_GATE_LABEL: Readonly<Record<TransferGateCode, string>> = {
  UPSTREAM_PASSED: '上游合格',
  UPSTREAM_CONCESSION: '让步接收（受限放行）',
  UPSTREAM_REWORK_PASSED: '返工复检合格',
  UPSTREAM_OVERRIDDEN: '特批豁免放行',
  UPSTREAM_MISSING: '上游环节缺失',
  UPSTREAM_INSPECTING: '上游检验中',
  UPSTREAM_UNDER_MRB: '上游 MRB 评审中',
  UPSTREAM_FAILED: '上游不合格',
  UPSTREAM_REINSPECTING: '返工复检中',
  CHAIN_TERMINATED: '链路已终止',
  NO_PREDECESSOR_STAGE: '无上游环节',
  ANCHOR_UNRESOLVED: '链路锚点未解析',
};

interface Tone {
  badge: string;
  dot: string;
}

/** 与 `lib/traceNodeFormat.STATUS_TONE` 同一套色板（合格=翠绿 / 特采=琥珀 / 不合格=玫红） */
export const TRANSFER_GATE_TONE: Readonly<Record<TransferGateCode, Tone>> = {
  UPSTREAM_PASSED: { badge: 'bg-emerald-50 text-emerald-600', dot: 'bg-emerald-500' },
  UPSTREAM_REWORK_PASSED: { badge: 'bg-emerald-50 text-emerald-600', dot: 'bg-emerald-500' },
  UPSTREAM_CONCESSION: { badge: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' },
  UPSTREAM_OVERRIDDEN: { badge: 'bg-purple-50 text-purple-700', dot: 'bg-purple-500' },
  UPSTREAM_MISSING: { badge: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  UPSTREAM_INSPECTING: { badge: 'bg-blue-50 text-blue-600', dot: 'bg-blue-500' },
  UPSTREAM_REINSPECTING: { badge: 'bg-blue-50 text-blue-600', dot: 'bg-blue-500' },
  UPSTREAM_UNDER_MRB: { badge: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' },
  UPSTREAM_FAILED: { badge: 'bg-rose-50 text-rose-600', dot: 'bg-rose-500' },
  CHAIN_TERMINATED: { badge: 'bg-rose-50 text-rose-600', dot: 'bg-rose-500' },
  NO_PREDECESSOR_STAGE: { badge: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  ANCHOR_UNRESOLVED: { badge: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
};

export const CHAIN_STATE_LABEL: Readonly<Record<ChainStageState, string>> = {
  RELEASED: '已放行',
  BLOCKED: '已阻断',
  PENDING: '检验中',
  TERMINATED: '链路终止',
  MISSING: '零单据',
};

export const CHAIN_STATE_TONE: Readonly<Record<ChainStageState, Tone>> = {
  RELEASED: { badge: 'bg-emerald-50 text-emerald-600', dot: 'bg-emerald-500' },
  BLOCKED: { badge: 'bg-rose-50 text-rose-600', dot: 'bg-rose-500' },
  PENDING: { badge: 'bg-blue-50 text-blue-600', dot: 'bg-blue-500' },
  TERMINATED: { badge: 'bg-rose-50 text-rose-600', dot: 'bg-rose-500' },
  MISSING: { badge: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
};

/** 缺值统一显示为 —（docs/24 §8 验收口径 1） */
function text(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? '—' : value;
}

/**
 * 闸门一行话：**指得出被谁挡**。
 * 阻断 -> 「上游 [IQC] INS-xxx（FAILED）」；放行 -> 上游单号或「无上游单（按 TBD-01 放行并留痕）」。
 */
export function gateUpstreamText(decision: TransferDecision): string {
  if (decision.predecessorOrderNo !== undefined) {
    const stage = decision.precedentStage !== undefined ? `[${decision.precedentStage}] ` : '';
    const status = decision.predecessorStatus !== undefined ? `（${decision.predecessorStatus}）` : '';
    const prefix = decision.allowed ? '上游 ' : '被上游 ';
    return `${prefix}${stage}${decision.predecessorOrderNo}${status}${decision.allowed ? '' : ' 阻断'}`;
  }
  if (decision.allowed) {
    return decision.code === 'UPSTREAM_MISSING'
      ? '无上游单：按 TBD-01 放行并留痕'
      : '无上游环节（本环节为该链首环节）';
  }
  return decision.reason;
}

/** 放行凭证：特采必须能举证客户书面授权件，返工必须能举证复检合格（docs/48 §4.8） */
export function permitEvidenceText(decision: TransferDecision): string {
  const evidence = decision.permitEvidence;
  switch (evidence.kind) {
    case 'MRB_CONCESSION':
      return `放行凭证：让步接收 ${text(evidence.mrbNo)}${evidence.attachmentRequired ? '（须可举证客户书面授权件）' : ''}`;
    case 'REWORK_REINSPECTION':
      return `放行凭证：返工复检合格 ${text(evidence.orderNo)}`;
    default:
      return '';
  }
}

/** 台账 / 详情行携带的传递派生字段（服务端 `withTransferState` 回填；字段缺失 = 未回填，不等于「允许」） */
export interface TransferStateFields {
  canTransfer?: boolean | null;
  transferCode?: string | null;
  predecessorOrderNo?: string | null;
  chainKey?: string | null;
  blockedBy?:
    | {
        code?: string | null;
        stage?: string | null;
        orderNo?: string | null;
        status?: string | null;
      }
    | null;
}

export interface TransferBadge {
  /** 徽标文案（服务端理由码的唯一中文译名；未知码原样回显，绝不猜一个理由） */
  label: string;
  badge: string;
  dot: string;
  /** 悬浮说明：被谁挡、靠什么放行、判定码原文 */
  tip: string;
  /**
   * 服务端明确不允许传递 —— 界面据此置灰。
   * **置灰不是拦截**：docs/48 §8 硬约束 6，唯一判据是服务端 422。
   */
  blocked: boolean;
}

const GATE_LABEL_BY_CODE = TRANSFER_GATE_LABEL as Readonly<Record<string, string>>;
const GATE_TONE_BY_CODE = TRANSFER_GATE_TONE as Readonly<Record<string, Tone>>;

/**
 * 台账徽标：把服务端下发的 `canTransfer` / `transferCode` / `blockedBy` 翻成一个徽标。
 *
 * 返回 `null` = 服务端**没有下发**判定（`withTransfer=false`、离线 Mock 或旧后端），
 * 此时界面显示 —，而不是默认显示「允许」—— 否则「没查到」会被现场读成「没问题」。
 */
export function ledgerTransferBadge(
  state: TransferStateFields | null | undefined
): TransferBadge | null {
  if (state === null || state === undefined) return null;
  const allowed = state.canTransfer;
  if (allowed === null || allowed === undefined) return null;

  const code = state.transferCode ?? null;
  const tone = code !== null ? GATE_TONE_BY_CODE[code] : undefined;
  const label =
    code !== null && GATE_LABEL_BY_CODE[code] !== undefined
      ? GATE_LABEL_BY_CODE[code]
      : allowed
      ? '允许传递（服务端未给判定码）'
      : '不允许传递（服务端未给判定码）';

  const upstream = state.blockedBy ?? null;
  const upstreamOrderNo = upstream?.orderNo ?? state.predecessorOrderNo ?? null;
  const upstreamStage = upstream?.stage ?? null;
  const upstreamStatus = upstream?.status ?? null;

  const lines: string[] = [allowed ? '服务端判定：允许传递' : '服务端判定：不允许传递'];
  if (code !== null) lines.push(`判定码：${code}`);
  if (upstreamOrderNo !== null && upstreamOrderNo !== '') {
    const stage = upstreamStage !== null && upstreamStage !== '' ? `[${upstreamStage}] ` : '';
    const status = upstreamStatus !== null && upstreamStatus !== '' ? `（${upstreamStatus}）` : '';
    lines.push(`上游：${stage}${upstreamOrderNo}${status}`);
  } else if (code === 'UPSTREAM_MISSING') {
    lines.push('未检索到上游环节单据：按 TBD-01 放行并留痕');
  } else if (code === 'NO_PREDECESSOR_STAGE') {
    lines.push('本环节为该链首环节，无上游环节');
  }
  if (code === 'UPSTREAM_CONCESSION') lines.push('放行凭证：客户书面授权件（缺件即阻断）');
  if (code === 'UPSTREAM_REWORK_PASSED') lines.push('放行凭证：返工复检合格单');
  if (code === 'UPSTREAM_OVERRIDDEN') lines.push('放行凭证：质量负责人特批豁免（带审计留痕）');
  if (state.chainKey !== null && state.chainKey !== undefined && state.chainKey !== '') {
    lines.push(`链路锚点：${state.chainKey}`);
  }
  lines.push('界面置灰仅为提示，拦截以服务端 422 为准');

  return {
    label,
    badge: tone?.badge ?? (allowed ? 'bg-slate-100 text-slate-600' : 'bg-rose-50 text-rose-600'),
    dot: tone?.dot ?? (allowed ? 'bg-slate-400' : 'bg-rose-500'),
    tip: lines.join('\n'),
    blocked: allowed === false,
  };
}
