import type {
  InspectionStatus,
  InspectionType,
  MRBDisposition,
  MRBStatus,
  OverallDecision,
} from '@letian/contracts';
import { predecessorTiersOf, stageSeqOf } from '../models/stage-sequence';
import { normalizeHeatBatchNo } from './heat-batch-trace-service';

/**
 * 「合格后传递」传递门禁（docs/48-合格后传递通用链路规则设计与改造方案.md §2）
 *
 * **本文件是传递规则的唯一真相**（纯函数、无 IO）：入参 = 本单环节 + 本单锚点 + 上游候选集 + MRB 结论快照，
 * 出参 = 结构化 `TransferDecision`。建单用例、放行关卡、追溯看板、前端预览只能消费本函数的结果，
 * **不得各写一份 `if`** —— 四处各写一份必然出现「MES 放行而 QMS 阻断」这类口径打架。
 *
 * 分层职责（docs/48 §2.1）：规则在领域（本文件）、执法在应用层用例、数据库只给结构与索引、
 * API 与前端只做呈现；前端禁用只是体验，硬拦截一律以服务端 422 为准。
 */

/** 链路锚点类型：同批次 > 同炉批号 > 同工单（docs/48 §2.2，命中即停、不混合） */
export type ChainAnchorKind = 'BATCH' | 'HEAT' | 'WORK_ORDER';

export interface ChainAnchor {
  kind: ChainAnchorKind;
  value: string;
}

/** 锚点解析优先级（数组顺序即优先级，不得随意调整） */
export const ANCHOR_PRIORITY: readonly ChainAnchorKind[] = ['BATCH', 'HEAT', 'WORK_ORDER'];

export type TransferGateCode =
  | 'UPSTREAM_PASSED'
  | 'UPSTREAM_CONCESSION'
  | 'UPSTREAM_REWORK_PASSED'
  | 'UPSTREAM_OVERRIDDEN'
  | 'UPSTREAM_MISSING'
  | 'UPSTREAM_INSPECTING'
  | 'UPSTREAM_UNDER_MRB'
  | 'UPSTREAM_FAILED'
  | 'UPSTREAM_REINSPECTING'
  | 'CHAIN_TERMINATED'
  | 'NO_PREDECESSOR_STAGE'
  | 'ANCHOR_UNRESOLVED';

/** 放行凭证：三种处置方式的差别不是「能不能继续」，而是「凭不凭得出证据」（docs/48 §4.8） */
export interface TransferPermitEvidence {
  kind: 'NONE' | 'MRB_CONCESSION' | 'REWORK_REINSPECTION';
  mrbNo?: string;
  orderNo?: string;
  /** 是否必须有客户书面授权件才能放行（特采 = true） */
  attachmentRequired: boolean;
}

export interface TransferDecision {
  allowed: boolean;
  code: TransferGateCode;
  /** 本单环节 */
  stage: InspectionType;
  /** 命中的链路锚点值（未命中时回落本单批次号） */
  chainKey: string;
  chainKeyKind: ChainAnchorKind;
  precedentStage?: InspectionType;
  predecessorOrderNo?: string;
  predecessorStatus?: InspectionStatus;
  mrbNo?: string;
  mrbDisposition?: MRBDisposition;
  permitEvidence: TransferPermitEvidence;
  /** 退货 / 报废：整条链终止，下游不得建单、已建未终判单需冻结 */
  terminateChain: boolean;
  /** 中文可读理由，界面与 MES 直接展示（不得只给码让人猜） */
  reason: string;
}

/** 上游检验单的结构化子集（`InspectionOrder` DTO 天然满足，便于单测构造最小入参） */
export interface UpstreamOrderLike {
  orderNo: string;
  inspectionType: InspectionType;
  batchNo: string;
  status: InspectionStatus;
  overallDecision?: OverallDecision | undefined;
  updatedAt?: string | undefined;
  createdAt?: string | undefined;
  id?: string | undefined;
}

export interface UpstreamCandidate {
  order: UpstreamOrderLike;
  /** 该候选单命中的锚点集合（由仓储按锚点取数时标注） */
  matchedAnchors: readonly ChainAnchorKind[];
}

/** MRB 结论快照（`MRBReview` DTO 天然满足） */
export interface MrbSnapshotLike {
  mrbNo: string;
  sourceOrderNo: string;
  status: MRBStatus;
  disposition?: MRBDisposition | undefined;
  concessionAttachmentUrl?: string | undefined;
}

export interface TransferGateInput {
  stage: InspectionType;
  /** 本单锚点（由 `resolveChainAnchors` 产出，按优先级排列） */
  anchors: readonly ChainAnchor[];
  /** 上游候选集（按锚点 + 门禁上游环节类型取回；排序由仓储固定） */
  candidates: readonly UpstreamCandidate[];
  /** 候选单的 MRB 结论（按 sourceOrderNo 建索引，批量预取，避免 N+1） */
  mrbByOrderNo?: ReadonlyMap<string, MrbSnapshotLike>;
  /**
   * 同锚点但**跨物料**命中的上游单数量（TBD-03：跨物料只提示不阻断，仅用于理由文案）。
   */
  crossMaterialCandidateCount?: number;
}

/** 由检验单解析链路锚点（纯函数；缺失锚点不产生空锚点） */
export function resolveChainAnchors(order: {
  batchNo: string;
  furnaceHeatNo?: string | undefined;
  workOrderNo?: string | undefined;
}): ChainAnchor[] {
  const anchors: ChainAnchor[] = [];
  const batchNo = (order.batchNo ?? '').trim();
  if (batchNo !== '') {
    anchors.push({ kind: 'BATCH', value: batchNo });
  }
  const heatNo = normalizeHeatBatchNo(order.furnaceHeatNo ?? '');
  if (heatNo !== '') {
    anchors.push({ kind: 'HEAT', value: heatNo });
  }
  const workOrderNo = (order.workOrderNo ?? '').trim();
  if (workOrderNo !== '') {
    anchors.push({ kind: 'WORK_ORDER', value: workOrderNo });
  }
  return anchors;
}

/** 复检轮次：`{原单号}-R{n}` → n；非复检单 → 0（`create-reinspection.ts` 的单号规则） */
export function reinspectionRoundOf(orderNo: string): number {
  const matched = /-R(\d+)$/.exec(orderNo);
  if (matched === null) {
    return 0;
  }
  const parsed = Number.parseInt(matched[1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 复检基线单号：`{原单号}-R{n}` → `{原单号}` */
export function reinspectionBaseOf(orderNo: string): string {
  return orderNo.replace(/-R\d+$/, '');
}

/**
 * 同环节多张单 → 权威单（docs/48 §2.4 规则 2 + 规则 3）：
 *   ① 复检轮次最高者胜（复检结论覆盖原结论）；
 *   ② 同轮次取「最近一次终判」：`updatedAt DESC → createdAt DESC → orderNo DESC`（与 docs/47 `pickLatest` 同式）。
 *
 * 禁止调用方用 `Array.find` 或数据库默认顺序取首条 —— docs/47 D6 的教训是「取到了最旧一条」。
 */
export function pickAuthoritativeUpstream<T extends { order: UpstreamOrderLike }>(
  group: readonly T[]
): T | undefined {
  if (group.length === 0) {
    return undefined;
  }
  return [...group].sort((left, right) => {
    const byRound = reinspectionRoundOf(right.order.orderNo) - reinspectionRoundOf(left.order.orderNo);
    if (byRound !== 0) return byRound;
    const byUpdated = timeOf(right.order.updatedAt) - timeOf(left.order.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    const byCreated = timeOf(right.order.createdAt) - timeOf(left.order.createdAt);
    if (byCreated !== 0) return byCreated;
    return right.order.orderNo.localeCompare(left.order.orderNo);
  })[0];
}

function timeOf(iso: string | undefined): number {
  if (iso === undefined || iso === '') return 0;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 理由码严重度：多环节同时命中时，报告最严重的那个（稳定且可解释） */
const CODE_SEVERITY: Readonly<Record<TransferGateCode, number>> = {
  CHAIN_TERMINATED: 100,
  UPSTREAM_FAILED: 90,
  UPSTREAM_UNDER_MRB: 80,
  UPSTREAM_REINSPECTING: 70,
  UPSTREAM_INSPECTING: 60,
  ANCHOR_UNRESOLVED: 20,
  UPSTREAM_MISSING: 10,
  NO_PREDECESSOR_STAGE: 0,
  UPSTREAM_PASSED: 0,
  UPSTREAM_CONCESSION: 0,
  UPSTREAM_REWORK_PASSED: 0,
  UPSTREAM_OVERRIDDEN: 0,
};

/**
 * 传递门禁唯一入口：上游没合格（且 MRB 没给放行结论）⇒ 下游不得开始。
 *
 * 语义边界（docs/48 §3）：
 * - 锚点未命中上游单 → **放行 + 显式标记** `UPSTREAM_MISSING`（TBD-01：不阻断但留痕）；
 * - 上游仍在检验中 → 阻断；上游不合格 → 阻断（除 MRB 放行）；
 * - MRB 让步接收 → 受限放行（缺客户书面授权件仍阻断）；返工 → 复检合格才放行；
 * - 退货 / 报废 → 阻断且 `terminateChain = true`。
 */
export function canTransferToNextStage(input: TransferGateInput): TransferDecision {
  const primaryAnchor = input.anchors[0] ?? { kind: 'BATCH' as ChainAnchorKind, value: '' };
  const base: Omit<TransferDecision, 'allowed' | 'code' | 'reason'> = {
    stage: input.stage,
    chainKey: primaryAnchor.value,
    chainKeyKind: primaryAnchor.kind,
    permitEvidence: { kind: 'NONE', attachmentRequired: false },
    terminateChain: false,
  };

  const tiers = predecessorTiersOf(input.stage);
  if (tiers.length === 0) {
    return {
      ...base,
      allowed: true,
      code: 'NO_PREDECESSOR_STAGE',
      reason: `环节 [${input.stage}] 无门禁上游环节，直接放行`,
    };
  }

  const selection = selectUpstream(input.candidates, input.anchors, tiers);
  if (selection === null) {
    const crossHint =
      (input.crossMaterialCandidateCount ?? 0) > 0
        ? '；同锚点存在跨物料上游单，按 TBD-03 不参与门禁（仅提示）'
        : '';
    return {
      ...base,
      allowed: true,
      code: 'UPSTREAM_MISSING',
      reason: `未找到本链路（锚点：${input.anchors.map((anchor) => `${anchor.kind}=${anchor.value}`).join(' / ') || '无'}）的上游检验单，按 TBD-01 放行并留痕${crossHint}`,
    };
  }

  const mrbByOrderNo = input.mrbByOrderNo ?? new Map<string, MrbSnapshotLike>();
  const subDecisions = selection.groups.map((group) => {
    const order = group.authoritative.order;
    const mrb = mrbByOrderNo.get(order.orderNo);
    return evaluateUpstream(order, mrb, group.authoritative.matchedAnchors);
  });

  const blocked = subDecisions.filter((decision) => !decision.allowed);
  const anchorPatch = { chainKey: selection.anchor.value, chainKeyKind: selection.anchor.kind };

  if (blocked.length > 0) {
    const worst = [...blocked].sort((left, right) => {
      const bySeverity = CODE_SEVERITY[right.code] - CODE_SEVERITY[left.code];
      if (bySeverity !== 0) return bySeverity;
      return stageSeqOf(right.precedentStage) - stageSeqOf(left.precedentStage);
    })[0]!;
    return {
      ...base,
      ...anchorPatch,
      allowed: false,
      code: worst.code,
      ...(worst.precedentStage !== undefined ? { precedentStage: worst.precedentStage } : {}),
      ...(worst.predecessorOrderNo !== undefined
        ? { predecessorOrderNo: worst.predecessorOrderNo }
        : {}),
      ...(worst.predecessorStatus !== undefined ? { predecessorStatus: worst.predecessorStatus } : {}),
      ...(worst.mrbNo !== undefined ? { mrbNo: worst.mrbNo } : {}),
      ...(worst.mrbDisposition !== undefined ? { mrbDisposition: worst.mrbDisposition } : {}),
      permitEvidence: worst.permitEvidence,
      terminateChain: subDecisions.some((decision) => decision.terminateChain),
      reason: worst.reason,
    };
  }

  const lead = subDecisions[0]!;
  const concession = subDecisions.find((decision) => decision.code === 'UPSTREAM_CONCESSION');
  const rework = subDecisions.find((decision) => decision.code === 'UPSTREAM_REWORK_PASSED');
  const code: TransferGateCode =
    concession !== undefined
      ? 'UPSTREAM_CONCESSION'
      : rework !== undefined
        ? 'UPSTREAM_REWORK_PASSED'
        : 'UPSTREAM_PASSED';
  const reported = concession ?? rework ?? lead;
  return {
    ...base,
    ...anchorPatch,
    allowed: true,
    code,
    ...(reported.precedentStage !== undefined ? { precedentStage: reported.precedentStage } : {}),
    ...(reported.predecessorOrderNo !== undefined
      ? { predecessorOrderNo: reported.predecessorOrderNo }
      : {}),
    ...(reported.predecessorStatus !== undefined
      ? { predecessorStatus: reported.predecessorStatus }
      : {}),
    ...(reported.mrbNo !== undefined ? { mrbNo: reported.mrbNo } : {}),
    ...(reported.mrbDisposition !== undefined ? { mrbDisposition: reported.mrbDisposition } : {}),
    permitEvidence: reported.permitEvidence,
    reason:
      code === 'UPSTREAM_CONCESSION'
        ? `上游 [${reported.precedentStage}] ${reported.predecessorOrderNo} 经 MRB 让步接收放行（受限传递），下游须携带特采标记`
        : code === 'UPSTREAM_REWORK_PASSED'
          ? `上游 [${reported.precedentStage}] ${reported.predecessorOrderNo} 返工后复检合格，准予传递`
          : `上游 [${lead.precedentStage}] ${lead.predecessorOrderNo} 已判定合格，准予传递`,
  };
}

interface SelectedUpstream {
  anchor: ChainAnchor;
  groups: readonly { authoritative: UpstreamCandidate }[];
}

/**
 * 单张检验单的传递判定结果（= `canTransferToNextStage` 的最小判定单元）。
 *
 * **为什么把它暴露出来**：总装放行关卡（`GET /release-gates/:batchNo`）判的也是
 * 「这张单合格了没有 / MRB 给没给放行结论」，与传递门禁**同规则、不同入口**。
 * 若关卡自己再写一份 `status === COMPLETED && judgment !== FAILED ...`，就是第二份口径
 * （docs/48 §1.4 的现状：死代码用例与控制器各一份，MES 与 QMS 可能给出相反结论）。
 * 因此把判定单元暴露成纯函数，让门禁与关卡消费同一份实现 —— 关卡只负责挑单与翻译成 HTTP。
 */
export interface StageVerdict {
  /** 是否放行（true = 这张单已具备向下游传递的资格） */
  allowed: boolean;
  /** 理由码（与 `TransferDecision.code` 同源） */
  code: TransferGateCode;
  /** 被判定单的环节 */
  stage: InspectionType;
  /** 被判定单的单号 */
  orderNo: string;
  /** 被判定单的当前状态 */
  status: InspectionStatus;
  mrbNo?: string;
  mrbDisposition?: MRBDisposition;
  permitEvidence: TransferPermitEvidence;
  /** 退货 / 报废：整链终止 */
  terminateChain: boolean;
  reason: string;
}

/**
 * 判定单张检验单是否已放行（纯函数；MRB 结论优先级高于单据状态）。
 *
 * 复检轮次由单号自动识别（`{原单号}-R{n}`），调用方不必传 —— 避免出现「调用方忘了传轮次
 * 而把复检单当首轮单」的静默错误。
 */
export function evaluateStageVerdict(
  order: UpstreamOrderLike,
  mrb?: MrbSnapshotLike
): StageVerdict {
  // 第三个参数是「候选单命中的锚点集合」，只用于给理由文案补上下文；单张单判定不需要，传空数组。
  const sub = evaluateUpstream(order, mrb, []);
  return {
    allowed: sub.allowed,
    code: sub.code,
    stage: sub.precedentStage,
    orderNo: sub.predecessorOrderNo,
    status: sub.predecessorStatus,
    ...(sub.mrbNo !== undefined ? { mrbNo: sub.mrbNo } : {}),
    ...(sub.mrbDisposition !== undefined ? { mrbDisposition: sub.mrbDisposition } : {}),
    permitEvidence: sub.permitEvidence,
    terminateChain: sub.terminateChain,
    reason: sub.reason,
  };
}

/**
 * 选层 + 选权威单（docs/48 §2.2 / §2.4）：
 * ① 锚点按 `BATCH → HEAT → WORK_ORDER` 取第一层有候选的（命中即停、不混合）；
 * ② 该锚点下按门禁上游层级取第一层有候选的层；
 * ③ 层内**每种环节类型各取一张权威单**（同类型多张单按 §2.4 收敛），全部放行才放行。
 */
function selectUpstream(
  candidates: readonly UpstreamCandidate[],
  anchors: readonly ChainAnchor[],
  tiers: readonly (readonly InspectionType[])[]
): SelectedUpstream | null {
  const orderedAnchors = [...anchors].sort(
    (left, right) => ANCHOR_PRIORITY.indexOf(left.kind) - ANCHOR_PRIORITY.indexOf(right.kind)
  );

  for (const anchor of orderedAnchors) {
    const pool = candidates.filter((candidate) => candidate.matchedAnchors.includes(anchor.kind));
    if (pool.length === 0) {
      continue;
    }
    for (const tier of tiers) {
      const tierPool = pool.filter((candidate) => tier.includes(candidate.order.inspectionType));
      if (tierPool.length === 0) {
        continue;
      }
      const byType = new Map<InspectionType, UpstreamCandidate[]>();
      for (const candidate of tierPool) {
        const list = byType.get(candidate.order.inspectionType) ?? [];
        list.push(candidate);
        byType.set(candidate.order.inspectionType, list);
      }
      const groups: { authoritative: UpstreamCandidate }[] = [];
      for (const type of [...byType.keys()].sort((left, right) => stageSeqOf(left) - stageSeqOf(right))) {
        const authoritative = pickAuthoritativeUpstream(byType.get(type) ?? []);
        if (authoritative !== undefined) {
          groups.push({ authoritative });
        }
      }
      if (groups.length > 0) {
        return { anchor, groups };
      }
    }
  }

  return null;
}

interface SubDecision {
  allowed: boolean;
  code: TransferGateCode;
  precedentStage: InspectionType;
  predecessorOrderNo: string;
  predecessorStatus: InspectionStatus;
  mrbNo?: string;
  mrbDisposition?: MRBDisposition;
  permitEvidence: TransferPermitEvidence;
  terminateChain: boolean;
  reason: string;
}

function allow(
  order: UpstreamOrderLike,
  code: TransferGateCode,
  evidence: TransferPermitEvidence,
  reason: string,
  extra: { mrbNo?: string; mrbDisposition?: MRBDisposition } = {}
): SubDecision {
  return {
    allowed: true,
    code,
    precedentStage: order.inspectionType,
    predecessorOrderNo: order.orderNo,
    predecessorStatus: order.status,
    permitEvidence: evidence,
    terminateChain: false,
    reason,
    ...extra,
  };
}

function block(
  order: UpstreamOrderLike,
  code: TransferGateCode,
  reason: string,
  options: {
    mrbNo?: string;
    mrbDisposition?: MRBDisposition;
    terminateChain?: boolean;
  } = {}
): SubDecision {
  return {
    allowed: false,
    code,
    precedentStage: order.inspectionType,
    predecessorOrderNo: order.orderNo,
    predecessorStatus: order.status,
    permitEvidence: { kind: 'NONE', attachmentRequired: false },
    terminateChain: options.terminateChain ?? false,
    reason,
    ...(options.mrbNo !== undefined ? { mrbNo: options.mrbNo } : {}),
    ...(options.mrbDisposition !== undefined ? { mrbDisposition: options.mrbDisposition } : {}),
  };
}

/** 单张上游单的放行判定（MRB 结论优先于检验单状态） */
function evaluateUpstream(
  order: UpstreamOrderLike,
  mrb: MrbSnapshotLike | undefined,
  _matchedAnchors: readonly ChainAnchorKind[]
): SubDecision {
  const round = reinspectionRoundOf(order.orderNo);
  const judgment = order.overallDecision;

  // 1. 结论明确合格（含返工复检轮次合格）
  if (judgment === 'PASSED') {
    return round > 0
      ? allow(
          order,
          'UPSTREAM_REWORK_PASSED',
          { kind: 'REWORK_REINSPECTION', orderNo: order.orderNo, attachmentRequired: false },
          `上游 [${order.inspectionType}] ${order.orderNo} 返工复检合格，准予传递`
        )
      : allow(
          order,
          'UPSTREAM_PASSED',
          { kind: 'NONE', attachmentRequired: false },
          `上游 [${order.inspectionType}] ${order.orderNo} 已判定合格，准予传递`
        );
  }

  // 2. 检验单自身已是特采结论（MRB 回写产物）：
  //    回写结论**不是永久放行凭证** —— 让步接收的授权必须实时可查，
  //    客户授权件被撤销 / MRB 被改判后，回写的 CONCESSION 不得继续解锁（docs/48 §3-7「缺件即阻断」）。
  //    因此这里不单独放行，而是回到 MRB 三分支复核 —— 让步接收规则只有一处实现，避免两套口径打架。
  if (judgment === 'CONCESSION') {
    return evaluateNonconforming(order, mrb, round);
  }

  // 3. 判定不合格 / 状态不合格：必须看 MRB 有没有给放行结论
  const nonconforming = judgment === 'FAILED' || order.status === 'FAILED';
  if (nonconforming) {
    return evaluateNonconforming(order, mrb, round);
  }

  // 4. 已进入 MRB 流程但检验单无终判：按 MRB 结论判定
  if (order.status === 'IN_MRB_REVIEW') {
    if (mrb !== undefined && mrb.status === 'DISPOSED') {
      return evaluateNonconforming(order, mrb, round);
    }
    return block(
      order,
      'UPSTREAM_UNDER_MRB',
      `上游 [${order.inspectionType}] ${order.orderNo} 正在进行 MRB 评审${mrb !== undefined ? `（${mrb.mrbNo}）` : ''}，尚未给出放行结论`,
      { ...(mrb?.mrbNo !== undefined ? { mrbNo: mrb.mrbNo } : {}) }
    );
  }

  // 5. 其余（PENDING / DRAFT / INSPECTING / RE_INSPECTING / COMPLETED 无终判）
  return round > 0
    ? block(
        order,
        'UPSTREAM_REINSPECTING',
        `上游 [${order.inspectionType}] ${order.orderNo} 为返工后复检轮次，尚未终判合格`,
        {}
      )
    : block(
        order,
        'UPSTREAM_INSPECTING',
        `上游 [${order.inspectionType}] ${order.orderNo} 仍处于检验中（${order.status}），未得出合格结论`,
        {}
      );
}

/** 不合格上游单：MRB 三分支（让步接收受限放行 / 返工条件放行 / 退货报废链终止） */
function evaluateNonconforming(
  order: UpstreamOrderLike,
  mrb: MrbSnapshotLike | undefined,
  round: number
): SubDecision {
  const suffix = round > 0 ? `（第 ${round} 轮复检）` : '';
  if (mrb === undefined) {
    return block(
      order,
      'UPSTREAM_FAILED',
      `上游 [${order.inspectionType}] ${order.orderNo}${suffix} 判定不合格，且未建 MRB 评审单，禁止传递`,
      {}
    );
  }

  if (mrb.status === 'PENDING_REVIEW' || mrb.status === 'UNDER_REVIEW') {
    return block(
      order,
      'UPSTREAM_UNDER_MRB',
      `上游 [${order.inspectionType}] ${order.orderNo}${suffix} 不合格，正在 MRB 评审中（${mrb.mrbNo}），尚未给出放行结论`,
      { mrbNo: mrb.mrbNo }
    );
  }

  if (mrb.status === 'REJECTED') {
    return block(
      order,
      'UPSTREAM_FAILED',
      `上游 [${order.inspectionType}] ${order.orderNo}${suffix} 不合格，MRB 评审被驳回（${mrb.mrbNo}），未获得放行结论`,
      { mrbNo: mrb.mrbNo }
    );
  }

  switch (mrb.disposition) {
    case 'CONCESSION': {
      const attachment = (mrb.concessionAttachmentUrl ?? '').trim();
      if (attachment === '') {
        return block(
          order,
          'UPSTREAM_FAILED',
          `上游 [${order.inspectionType}] ${order.orderNo}${suffix} 的让步接收（${mrb.mrbNo}）缺客户书面授权件，不得传递`,
          { mrbNo: mrb.mrbNo, mrbDisposition: 'CONCESSION' }
        );
      }
      return allow(
        order,
        'UPSTREAM_CONCESSION',
        { kind: 'MRB_CONCESSION', mrbNo: mrb.mrbNo, attachmentRequired: true },
        `上游 [${order.inspectionType}] ${order.orderNo}${suffix} 经 MRB 让步接收放行（${mrb.mrbNo}），下游须携带特采标记`,
        { mrbNo: mrb.mrbNo, mrbDisposition: 'CONCESSION' }
      );
    }
    case 'REWORK':
      return block(
        order,
        'UPSTREAM_REINSPECTING',
        `上游 [${order.inspectionType}] ${order.orderNo}${suffix} 判返工（${mrb.mrbNo}），返工后复检尚未判定合格`,
        { mrbNo: mrb.mrbNo, mrbDisposition: 'REWORK' }
      );
    case 'RETURN_TO_VENDOR':
      return block(
        order,
        'CHAIN_TERMINATED',
        `上游 [${order.inspectionType}] ${order.orderNo}${suffix} 判定退货（${mrb.mrbNo}），整条链路终止`,
        { mrbNo: mrb.mrbNo, mrbDisposition: 'RETURN_TO_VENDOR', terminateChain: true }
      );
    case 'SCRAP':
      return block(
        order,
        'CHAIN_TERMINATED',
        `上游 [${order.inspectionType}] ${order.orderNo}${suffix} 判定报废（${mrb.mrbNo}），整条链路终止`,
        { mrbNo: mrb.mrbNo, mrbDisposition: 'SCRAP', terminateChain: true }
      );
    default:
      return block(
        order,
        'UPSTREAM_FAILED',
        `上游 [${order.inspectionType}] ${order.orderNo}${suffix} 不合格，MRB（${mrb.mrbNo}）未给出可传递的处置结论`,
        { mrbNo: mrb.mrbNo }
      );
  }
}
