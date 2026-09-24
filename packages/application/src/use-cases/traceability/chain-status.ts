import type {
  ChainStatusResponse,
  ChainStatusStage,
  ChainStageState,
  InspectionOrder as InspectionOrderDTO,
  InspectionType,
  MRBReview as MRBReviewDTO,
} from '@letian/contracts';
import {
  evaluateStageVerdict,
  pickAuthoritativeUpstream,
  resolveChainAnchors,
  stageSeqOf,
  type MrbSnapshotLike,
} from '@letian/domain';
import {
  evaluateTransferDecision,
  transferPermitQueryOfOrder,
} from '../inspections/check-transfer-permit.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork, IUnitOfWorkContext } from '../../tx/unit-of-work.js';

/**
 * 看板「传递链状态」（docs/48-合格后传递通用链路规则设计与改造方案.md §4.6 新增
 * `GET /api/v1/traceability/chain-status?batchNo=`）
 *
 * 一次返回该链路**各环节排序 + 每环节的传递判定**，供看板顶栏与「传递闸门」可视化使用。
 *
 * 三条口径（全部在服务端定，前端不得二次推导）：
 *   ① 环节行**由检验单派生**（`inspection_orders`），不看 `batch_trace_nodes` —— 终判才落节点，
 *      用节点画门禁会把「未终判」的中间态全画成缺失（docs/48 §4.7 看板数据来源提醒）；
 *   ② 环节状态取**该环节权威单**的单张判定（`evaluateStageVerdict`：状态 + MRB 结论），
 *      权威单按 docs/48 §2.4 取（复检轮次最高 -> 最近一次终判）；
 *   ③ 闸门判定取 `evaluateTransferDecision`（= 建单门禁 / 台账徽标的同一份判定），
 *      因此看板上的闸门与现场建单看到的结论**不可能不一致**。
 *
 * 纯读：不写审计、不写 Outbox、不加排他锁（与 `CheckTransferPermitUseCase` 同型）。
 */

export interface ChainStatusQuery {
  batchNo: string;
  /** 物料限定；省略表示整批次（多物料混批时由调用方显式收窄） */
  materialCode?: string | undefined;
  /** 炉批号（同炉批号锚点 A2，供跨批次链路使用） */
  furnaceHeatNo?: string | undefined;
  /** MES 生产工单号（同工单锚点 A3） */
  workOrderNo?: string | undefined;
}

/**
 * 链路总体状态取**最严重者**：终止 > 阻断 > 检验中 > 已放行 > 缺失。
 *
 * 为什么「缺失」排最后：缺失环节是常态（该批次没走委外），不应盖过真实结论；
 * 只有整条链路零单据时 summary 才是 MISSING。
 */
const STATE_SEVERITY: Readonly<Record<ChainStageState, number>> = {
  TERMINATED: 4,
  BLOCKED: 3,
  PENDING: 2,
  RELEASED: 1,
  MISSING: 0,
};

export class GetChainStatusUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    query: ChainStatusQuery,
    securityCtx?: ISecurityContext
  ): Promise<ChainStatusResponse> {
    return await this.uow.execute(async (ctx) => {
      const anchors = resolveChainAnchors({
        batchNo: query.batchNo,
        ...(query.furnaceHeatNo !== undefined ? { furnaceHeatNo: query.furnaceHeatNo } : {}),
        ...(query.workOrderNo !== undefined ? { workOrderNo: query.workOrderNo } : {}),
      });
      // 锚点优先级 BATCH > HEAT > WORK_ORDER（命中即停）：本接口以批次号为入口，
      // 无批次号时回落 HEAT / WORK_ORDER，与门禁 `selectUpstream` 的取锚口径一致。
      const primaryAnchor = anchors[0] ?? { kind: 'BATCH' as const, value: query.batchNo };

      const allOrders = await ctx.inspectionOrders.findByBatchNo(query.batchNo);
      const materialFilter = (query.materialCode ?? '').trim();
      const scopedOrders =
        materialFilter === ''
          ? allOrders
          : allOrders.filter((order) => order.materialCode === materialFilter);

      // PBAC：链路视图是详情视图，未授权直接 403（fail-closed），与
      // `GetOrderTraceChainUseCase`（订单环节台账）/ 批次图谱同口径。
      // 用工艺序位最靠前的那张单的物料做三维校验：分类解析不到时取 UNKNOWN，
      // 任何白名单规则都不命中（宁可拒绝，不可泄露）。
      const scopedFirst =
        [...scopedOrders].sort(
          (left, right) => stageSeqOf(left.inspectionType) - stageSeqOf(right.inspectionType)
        )[0] ?? undefined;
      if (securityCtx !== undefined && scopedFirst !== undefined) {
        const material = await ctx.materials.getMaterialByCode(scopedFirst.materialCode);
        securityCtx.assertAccess({
          targetCategory: material?.categoryCode ?? 'UNKNOWN',
          targetMaterialCode: material?.materialCode ?? scopedFirst.materialCode,
          ...(scopedFirst.supplierCode !== undefined
            ? { targetSupplierCode: scopedFirst.supplierCode }
            : {}),
        });
      }

      const byStage = new Map<InspectionType, InspectionOrderDTO[]>();
      for (const order of scopedOrders) {
        const list = byStage.get(order.inspectionType) ?? [];
        list.push(order);
        byStage.set(order.inspectionType, list);
      }

      const stages: ChainStatusStage[] = [];
      for (const stage of [...byStage.keys()].sort(
        (left, right) => stageSeqOf(left) - stageSeqOf(right)
      )) {
        const group = byStage.get(stage) ?? [];
        const authoritative = pickAuthoritativeUpstream(group.map((order) => ({ order })))?.order;
        if (authoritative === undefined) {
          continue;
        }

        const mrb = await loadMrbSnapshot(ctx, authoritative);
        const verdict = evaluateStageVerdict(authoritative, mrb);
        const decision = await evaluateTransferDecision(
          ctx,
          transferPermitQueryOfOrder({
            inspectionType: authoritative.inspectionType,
            batchNo: authoritative.batchNo,
            materialCode: authoritative.materialCode,
            ...(authoritative.furnaceHeatNo !== undefined
              ? { furnaceHeatNo: authoritative.furnaceHeatNo }
              : {}),
            ...(authoritative.workOrderNo !== undefined
              ? { workOrderNo: authoritative.workOrderNo }
              : {}),
            orderNo: authoritative.orderNo,
          })
        );

        stages.push({
          stage,
          seq: stageSeqOf(stage),
          state: stageStateOf(verdict.code, verdict.allowed, verdict.terminateChain),
          orderCount: group.length,
          orderNo: authoritative.orderNo,
          ...(authoritative.status !== undefined ? { orderStatus: authoritative.status } : {}),
          ...(authoritative.overallDecision !== undefined
            ? { overallDecision: authoritative.overallDecision }
            : {}),
          ...(verdict.mrbNo !== undefined ? { mrbNo: verdict.mrbNo } : {}),
          ...(verdict.mrbDisposition !== undefined
            ? { mrbDisposition: verdict.mrbDisposition }
            : {}),
          ...(authoritative.updatedAt !== undefined ? { updatedAt: authoritative.updatedAt } : {}),
          stateCode: verdict.code,
          stateReason: verdict.reason,
          decision,
        });
      }

      const releasedCount = stages.filter((stage) => stage.state === 'RELEASED').length;
      const blockedCount = stages.filter((stage) => stage.state === 'BLOCKED').length;
      const pendingCount = stages.filter((stage) => stage.state === 'PENDING').length;
      const terminatedCount = stages.filter((stage) => stage.state === 'TERMINATED').length;

      // 链路总体状态：取最严重环节；零单据 -> MISSING
      const worstStage = stages.reduce<ChainStatusStage | undefined>(
        (worst, current) =>
          worst === undefined ||
          (STATE_SEVERITY[current.state] ?? 0) > (STATE_SEVERITY[worst.state] ?? 0)
            ? current
            : worst,
        undefined
      );
      // 阻断点 = 工艺序位最靠前的「未放行」环节（进行中的环节也要给出，便于现场提前看见）。
      // 理由码取**该环节自身**的判定（`verdict.code`）而不是进入该环节的闸门码（`decision.code`）：
      // 「链路为什么卡在这里」与「这里当初为什么能开始」是两个问题，混用会出现
      // `state=BLOCKED` 却下发 `code=UPSTREAM_MISSING` 的自相矛盾。
      const blockingStage = stages.find((stage) => stage.state !== 'RELEASED');

      return {
        batchNo: query.batchNo,
        ...(materialFilter !== '' ? { materialCode: materialFilter } : {}),
        anchor: primaryAnchor,
        stages,
        summary: {
          state: worstStage === undefined ? 'MISSING' : worstStage.state,
          releasedCount,
          blockedCount,
          pendingCount,
          terminatedCount,
          terminated: terminatedCount > 0,
          ...(blockingStage !== undefined
            ? {
                blockedStage: blockingStage.stage,
                blockedBy: {
                  code: blockingStage.stateCode,
                  stage: blockingStage.stage,
                  orderNo: blockingStage.orderNo ?? null,
                  status: blockingStage.orderStatus ?? null,
                },
              }
            : {}),
        },
        generatedAt: new Date().toISOString(),
      };
    });
  }
}

/**
 * 环节状态（与领域理由码一一对应，不新增第二套判据）：
 *   - 放行 -> `RELEASED`；
 *   - 退货 / 报废 -> `TERMINATED`（整链终止）；
 *   - 「还在检验中 / 返工复检中 / MRB 未结案」-> `PENDING`（等一等，不是不合格）；
 *   - 其余不合格分支（含无放行结论）-> `BLOCKED`。
 */
function stageStateOf(
  code: string,
  allowed: boolean,
  terminateChain: boolean
): ChainStageState {
  if (allowed) {
    return 'RELEASED';
  }
  if (terminateChain) {
    return 'TERMINATED';
  }
  if (
    code === 'UPSTREAM_INSPECTING' ||
    code === 'UPSTREAM_REINSPECTING' ||
    code === 'UPSTREAM_UNDER_MRB' ||
    code === 'UPSTREAM_MISSING'
  ) {
    return 'PENDING';
  }
  return 'BLOCKED';
}

/**
 * 该单的 MRB 结论快照：先按来源单号精确取，再按批次兜底。
 *
 * 批次兜底与 `CheckReleaseGateUseCase` **同一口径**（历史数据的既有做法：MRB 单可能只记了批次），
 * 两处若不同，会出现「关卡说 MRB 已放行、看板说未结案」的矛盾。
 */
async function loadMrbSnapshot(
  ctx: IUnitOfWorkContext,
  order: InspectionOrderDTO
): Promise<MrbSnapshotLike | undefined> {
  const review: MRBReviewDTO | undefined =
    (await ctx.mrbReviews.findByOrderNo(order.orderNo)) ??
    (await ctx.mrbReviews.findByBatchNo(order.batchNo)) ??
    undefined;
  if (review === undefined) {
    return undefined;
  }
  return {
    mrbNo: review.mrbNo,
    sourceOrderNo: review.sourceOrderNo,
    status: review.status,
    ...(review.disposition !== undefined ? { disposition: review.disposition } : {}),
    ...(review.concessionAttachmentUrl !== undefined
      ? { concessionAttachmentUrl: review.concessionAttachmentUrl }
      : {}),
  };
}
