import type {
  InspectionType,
  MRBReview as MRBReviewDTO,
  TransferDecision,
  TransferPermitItem,
} from '@letian/contracts';
import {
  canTransferToNextStage,
  predecessorStagesOf,
  resolveChainAnchors,
  type MrbSnapshotLike,
  type UpstreamCandidate,
} from '@letian/domain';
import type { IUnitOfWork, IUnitOfWorkContext } from '../../tx/unit-of-work.js';

/**
 * 「合格后传递」传递许可查询（docs/48-合格后传递通用链路规则设计与改造方案.md §4.5）
 *
 * 本文件只做**取数与组装**：锚点解析、上游候选集、MRB 结论快照，然后交给领域纯函数
 * `canTransferToNextStage` 判定。规则本身**不出现在这里**（唯一真相在 `@letian/domain`），
 * 否则就会出现「建单门禁一份、看板预览一份、关卡一份」的三份口径打架（docs/48 §2.1）。
 */
export interface TransferPermitQuery {
  inspectionType: InspectionType;
  batchNo: string;
  /** 物料编码；省略表示不限物料（此时跨物料提示计数不做） */
  materialCode?: string | undefined;
  /** 炉批号（同炉批号锚点 A2） */
  furnaceHeatNo?: string | undefined;
  /** MES 生产工单号（同工单锚点 A3） */
  workOrderNo?: string | undefined;
  /** 调用方持有的单号，仅回显（便于前端对号入座） */
  orderNo?: string | undefined;
  /**
   * **本单**建单传递留痕码（迁移 035 `upstream_gate_code`），来自 `InspectionOrder.transferTrace`。
   *
   * 透传给领域函数用于识别「本单是靠特批豁免建成的」，从而把建单当初那次上游阻断
   * 呈现为已解除，而不是重算出原始阻断码。缺省即无留痕，行为与改造前一致。
   */
  selfOverrideCode?: string | undefined;
}

/**
 * 组装并判定一次传递许可（读侧纯函数 + 三次查询，无任何写入）。
 *
 * 抽成独立函数而不是塞进用例类：建单用例（`CreateInspectionOrderUseCase`）必须在**同一事务内**
 * 复用它，否则「建单门禁」与「看板预览」会各自拼一套取数逻辑，两侧口径必然漂移。
 */
export async function evaluateTransferDecision(
  ctx: IUnitOfWorkContext,
  query: TransferPermitQuery
): Promise<TransferDecision> {
  const anchors = resolveChainAnchors({
    batchNo: query.batchNo,
    ...(query.furnaceHeatNo !== undefined ? { furnaceHeatNo: query.furnaceHeatNo } : {}),
    ...(query.workOrderNo !== undefined ? { workOrderNo: query.workOrderNo } : {}),
  });
  const predecessorStages = predecessorStagesOf(query.inspectionType);

  // 无门禁上游环节（来料检验 IQC）不需要取数：直接由领域函数给出 NO_PREDECESSOR_STAGE
  if (predecessorStages.length === 0) {
    return canTransferToNextStage({
      stage: query.inspectionType,
      anchors,
      candidates: [],
    });
  }

  const materialCode = (query.materialCode ?? '').trim();
  const candidates = await ctx.inspectionOrders.findChainCandidates(anchors, {
    inspectionTypes: predecessorStages,
    ...(materialCode !== '' ? { materialCode } : {}),
    // 客户定稿口径（取代原 TBD-03「跨物料只提示不阻断」）：
    // 同一炉批号（HEAT 锚点）下的跨物料上游**必须参与门禁** —— 紧固件工艺链物料编码必然随工序变化，
    // 若只认同物料，炉批号链路会在最需要它的跨工序场景静默失效。
    // 不传此参数时（即 TBD-03 旧口径）则退化为严格同物料，保持向后兼容。
    crossMaterialAnchorKinds: ['HEAT'],
  });

  // 跨物料提示（兜底）：仅当「连跨物料都没有任何候选」时，提示同锚点存在跨物料单据但不属于本环节门禁上游，
  // 便于现场理解「为什么链路上一张上游单都没有」。HEAT 跨物料上游已直接参与门禁，不在此计数。
  const crossMaterialCandidateCount =
    materialCode !== '' && candidates.length === 0
      ? await ctx.inspectionOrders.countCrossMaterialCandidates(anchors, {
          inspectionTypes: predecessorStages,
          materialCode,
        })
      : 0;

  const mrbByOrderNo = await loadMrbSnapshots(ctx, candidates);

  // 本单建单留痕（特批豁免）：优先用调用方直接给的；调用方只给了单号时回查一次，
  // 保证「台账 / 看板 / 建单前预览」三条读侧对同一张单给出同一个结论 ——
  // 否则会出现「台账说已放行、预览说仍阻断」这种口径打架（docs/48 §2.1 要避免的情形）。
  const selfOverrideCode =
    query.selfOverrideCode ?? (await resolveOverrideTraceOfOrder(ctx, query.orderNo));

  return canTransferToNextStage({
    stage: query.inspectionType,
    anchors,
    candidates,
    mrbByOrderNo,
    crossMaterialCandidateCount,
    ...(selfOverrideCode !== undefined ? { selfOverrideCode } : {}),
  });
}

/**
 * 按单号回查建单留痕码（迁移 035 `upstream_gate_code`）。
 * 单号未给或查无此单时返回 undefined（= 无留痕，行为与改造前一致）。
 */
async function resolveOverrideTraceOfOrder(
  ctx: IUnitOfWorkContext,
  orderNo: string | undefined
): Promise<string | undefined> {
  if (orderNo === undefined || orderNo.trim() === '') {
    return undefined;
  }
  const row = await ctx.inspectionOrders.findByOrderNo(orderNo);
  return row?.transferTrace?.upstreamGateCode;
}

/**
 * 批量取候选单的 MRB 结论（一次查询，避免逐个候选单 N+1）。
 *
 * 同一来源单可能有多张评审单（返工再判不合格时按 TBD-05 新开）：仓储已按 `updated_at DESC` 排序，
 * 这里「先到先得」即取最新结论 —— **不得**改成后写覆盖，否则会取到最旧一张（docs/47 D6 的同型坑）。
 */
async function loadMrbSnapshots(
  ctx: IUnitOfWorkContext,
  candidates: readonly UpstreamCandidate[]
): Promise<ReadonlyMap<string, MrbSnapshotLike>> {
  const orderNos = [...new Set(candidates.map((candidate) => candidate.order.orderNo))];
  const snapshots = new Map<string, MrbSnapshotLike>();
  if (orderNos.length === 0) {
    return snapshots;
  }

  const reviews: readonly MRBReviewDTO[] = await ctx.mrbReviews.findBySourceOrderNos(orderNos);
  for (const review of reviews) {
    if (snapshots.has(review.sourceOrderNo)) {
      continue;
    }
    snapshots.set(review.sourceOrderNo, {
      mrbNo: review.mrbNo,
      sourceOrderNo: review.sourceOrderNo,
      status: review.status,
      ...(review.disposition !== undefined ? { disposition: review.disposition } : {}),
      ...(review.concessionAttachmentUrl !== undefined
        ? { concessionAttachmentUrl: review.concessionAttachmentUrl }
        : {}),
    });
  }
  return snapshots;
}

/**
 * 传递许可批量预览用例（纯读：不写审计、不写 Outbox、不加排他锁）。
 *
 * 供列表页 / 看板 / 建单前预览 / MES 关卡共用；写入侧的唯一执法点是建单用例与放行关卡，
 * 本用例**只回答「现在能不能传」**，不产生任何副作用。
 */
export class CheckTransferPermitUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(query: TransferPermitQuery): Promise<TransferPermitItem> {
    return await this.uow.execute(async (ctx) => {
      const decision = await evaluateTransferDecision(ctx, query);
      const item: TransferPermitItem = {
        inspectionType: query.inspectionType,
        batchNo: query.batchNo,
        decision,
        ...(query.materialCode !== undefined ? { materialCode: query.materialCode } : {}),
        ...(query.furnaceHeatNo !== undefined ? { furnaceHeatNo: query.furnaceHeatNo } : {}),
        ...(query.workOrderNo !== undefined ? { workOrderNo: query.workOrderNo } : {}),
        ...(query.orderNo !== undefined ? { orderNo: query.orderNo } : {}),
      };
      return item;
    });
  }

  /**
   * 批量预览（台账整页 / 看板整链路一次取回）。
   *
   * 与逐条调用 `execute` 的区别：**整批共用一个事务**。台账一页最多 100 行，
   * 逐条调用会开 100 个事务（100 次连接往返 + 100 次 BEGIN/COMMIT），
   * 而这里只是一个事务内的若干条查询；两者判定结果完全一致（同一套领域纯函数）。
   */
  public async executeBatch(
    queries: readonly TransferPermitQuery[]
  ): Promise<readonly TransferPermitItem[]> {
    if (queries.length === 0) {
      return [];
    }
    return await this.uow.execute(async (ctx) => {
      return await Promise.all(
        queries.map(async (query) => {
          const decision = await evaluateTransferDecision(ctx, query);
          const item: TransferPermitItem = {
            inspectionType: query.inspectionType,
            batchNo: query.batchNo,
            decision,
            ...(query.materialCode !== undefined ? { materialCode: query.materialCode } : {}),
            ...(query.furnaceHeatNo !== undefined ? { furnaceHeatNo: query.furnaceHeatNo } : {}),
            ...(query.workOrderNo !== undefined ? { workOrderNo: query.workOrderNo } : {}),
            ...(query.orderNo !== undefined ? { orderNo: query.orderNo } : {}),
          };
          return item;
        })
      );
    });
  }
}

/**
 * 由检验单（DTO / 台账行）构造传递许可查询（台账与看板共用，避免两处各拼一套锚点字段）。
 *
 * 注意 `workOrderNo`：读侧在 `work_order_no` 为空时**会用 `batch_no` 兜底**（docs/24 §6 D4 的既定读侧口径），
 * 因此这里拿到的可能是批次号。这不影响判定结果 —— 锚点优先级是 BATCH 先于 WORK_ORDER，
 * 同批次本就命中 BATCH 锚点；传入只是让「无批次号只有工单号」的历史行也能被正确串联。
 */
export function transferPermitQueryOfOrder(order: {
  inspectionType: InspectionType;
  batchNo: string;
  materialCode?: string | undefined;
  furnaceHeatNo?: string | undefined;
  workOrderNo?: string | undefined;
  orderNo?: string | undefined;
  /** 建单传递留痕（迁移 035）；其中 `upstreamGateCode = UPSTREAM_OVERRIDDEN` 表示本单是特批放行建成的 */
  transferTrace?: { upstreamGateCode?: string | undefined } | undefined;
}): TransferPermitQuery {
  const selfOverrideCode = order.transferTrace?.upstreamGateCode;
  return {
    inspectionType: order.inspectionType,
    batchNo: order.batchNo,
    ...(order.materialCode !== undefined ? { materialCode: order.materialCode } : {}),
    ...(order.furnaceHeatNo !== undefined ? { furnaceHeatNo: order.furnaceHeatNo } : {}),
    ...(order.workOrderNo !== undefined ? { workOrderNo: order.workOrderNo } : {}),
    ...(order.orderNo !== undefined ? { orderNo: order.orderNo } : {}),
    ...(selfOverrideCode !== undefined ? { selfOverrideCode } : {}),
  };
}
