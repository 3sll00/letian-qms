import { InspectionStatusEnum, type InspectionOrder as InspectionOrderDTO } from '@letian/contracts';
import { NotFoundError, ValidationFailedError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork, IUnitOfWorkContext } from '../../tx/unit-of-work.js';
import { collectPendingDefect } from '../mrb/collect-pending-defect.js';
import { autoInitiateMrbReview } from '../mrb/auto-initiate-mrb-review.js';
import { registerInspectionTraceNode } from '../traceability/register-inspection-trace-node.js';
import { reinspectionBaseOf, reinspectionRoundOf } from '@letian/domain';

export interface FinalizeInspectionStatusCommand {
  orderId: string;
  /** 终判目标状态（受契约 InspectionStatusEnum 约束，非法值 400） */
  status: string;
  /** 综合判定结论；让步 / 特采申请场景可省略（仅以 status = FAILED 表示不合格） */
  judgment?: string;
  passQty?: number;
  failQty?: number;
  sampleQty?: number;
  remark?: string;
  inspectionNotes?: string;
  /**
   * 拟定处置（检验员的处置意图，落自动创建的 MRB 单 `disposition` 初值）。
   * 缺省 `REWORK`；来料「不合格退货」传 `RETURN_TO_VENDOR`、让步接收 / 特采传 `CONCESSION`。
   */
  preliminaryDisposition?: string;
  operatorId: string;
  operatorName: string;
}

/**
 * 「判为不合格」的唯一判定式（docs/39 §4.1）：终判后状态或结论任一为 `FAILED`。
 * 覆盖 IQC 退货、委外不合格、OQC 特采（转 MRB 评审）、IPQC 快速终判不合格四种表单口径；
 * `RE_INSPECTING`（MRB 返工回边）与 `COMPLETED`（归档终态）不触发入池。
 */
export function isNonconformingVerdict(status: string, judgment?: string): boolean {
  return status === 'FAILED' || judgment === 'FAILED';
}

/**
 * 返工闭环回写（docs/48 §4.8）：复检单（`{源单号}-R{n}`）终判合格时，把**源单**从 `RE_INSPECTING` 推进到 `COMPLETED`。
 *
 * 三条边界，缺一条就会改错单：
 *   1. 只处理复检单（轮次 > 0）：首检单合格与「返工闭环」无关；
 *   2. 只处理**源单当前确为 `RE_INSPECTING`** 的单：避免把一张早已归档的历史单重新写一遍；
 *   3. 只处理合格结论：复检再判不合格时源单保持 `RE_INSPECTING`（按 TBD-05 新开 MRB 继续处置）。
 *
 * 返回被闭环的源单号（供审计留痕），未发生闭环时返回 undefined。
 */
async function closeReworkLoopIfReinspectionPassed(
  ctx: IUnitOfWorkContext,
  finalizedOrder: InspectionOrderDTO,
  targetStatus: string,
  judgment: string | undefined
): Promise<string | undefined> {
  if (reinspectionRoundOf(finalizedOrder.orderNo) === 0) {
    return undefined;
  }
  const passed = judgment !== 'FAILED' && (targetStatus === 'PASSED' || targetStatus === 'COMPLETED');
  if (!passed) {
    return undefined;
  }

  const baseOrder = await ctx.inspectionOrders.findByOrderNo(reinspectionBaseOf(finalizedOrder.orderNo));
  if (baseOrder === null || baseOrder.id === undefined || baseOrder.status !== 'RE_INSPECTING') {
    return undefined;
  }

  await ctx.inspectionOrders.updateStatus(baseOrder.id, 'COMPLETED');
  return baseOrder.orderNo;
}

/** 需要落 completed_at 的终判状态（与终判路由既有口径一致） */
const FINISHED_STATUSES: readonly string[] = ['PASSED', 'COMPLETED', 'FAILED'];

/**
 * 检验单终判用例（docs/39 §2 D1 闭环）。
 *
 * 背景：`POST /inspections/:id/status` 此前在控制器里直接调读侧仓储写入状态与判定，
 * 既绕过用例层、又没有事务边界，因此「判定不合格 -> 自动汇入不合格待审核池」
 * （PRD §3.7）在这条路径上从未发生：MRB 页面自然看不到记录。
 *
 * 本用例把终判收敛为唯一写入口，在同一事务内完成：
 * 状态流转 -> 数量 / 结论 / 终判时间 -> 回读单据 -> 判不合格即入池（幂等 upsert）
 * -> 追溯节点登记（docs/41）-> **自动创建 MRB 评审单**（docs/43）-> 审计留痕。
 *（此前该路由无任何审计记录。）
 *
 * 客户口径（2026-09-23）：判定不合格**不需要人工发起环节** —— 不合格台账仅作留痕，
 * MRB 评审单在本事务内按不合格来源类型自动绑定生效流程建单，检验单随即转 IN_MRB_REVIEW。
 * 详见 `docs/43-不合格判定自动发起MRB评审设计.md`。
 */
export class FinalizeInspectionStatusUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: FinalizeInspectionStatusCommand,
    securityCtx?: ISecurityContext
  ): Promise<InspectionOrderDTO> {
    const parsedStatus = InspectionStatusEnum.safeParse(cmd.status);
    if (!parsedStatus.success) {
      throw new ValidationFailedError(`非法的检验单状态: [${cmd.status}]`, [
        {
          name: 'status',
          reason: `合法取值为 ${InspectionStatusEnum.options.join(' / ')}`,
        },
      ]);
    }
    const targetStatus = parsedStatus.data;

    if (cmd.judgment !== undefined && !InspectionStatusEnum.safeParse(cmd.judgment).success) {
      throw new ValidationFailedError(`非法的综合判定结论: [${cmd.judgment}]`, [
        {
          name: 'judgment',
          reason: `合法取值为 ${InspectionStatusEnum.options.join(' / ')}`,
        },
      ]);
    }

    return await this.uow.execute(async (ctx) => {
      const existing = await ctx.inspectionOrders.findById(cmd.orderId);
      if (existing === null) {
        throw new NotFoundError(`检验单不存在: ${cmd.orderId}`);
      }

      if (securityCtx) {
        // 与 record-measurements / 草稿暂存同一口径：写侧三维 PBAC fail-closed
        const material = await ctx.materials.getMaterialByCode(existing.materialCode);
        securityCtx.assertAccess({
          targetCategory: material?.categoryCode ?? 'UNKNOWN',
          targetMaterialCode: existing.materialCode,
          ...(existing.supplierCode !== undefined
            ? { targetSupplierCode: existing.supplierCode }
            : {}),
        });
      }

      // 排他事务锁：与实测录入判定共用同一把工单锁，避免并发终判与入池读到中间态
      await ctx.locks.acquireXactLock(`LOCK_ORDER_${existing.batchNo}`);

      const note = cmd.inspectionNotes ?? cmd.remark;
      await ctx.inspectionOrders.updateStatus(cmd.orderId, targetStatus, note);

      const stats: {
        passQty?: number;
        failQty?: number;
        judgment?: string;
        completedAt?: Date;
        inspectionNotes?: string;
      } = {};
      if (cmd.passQty !== undefined) stats.passQty = cmd.passQty;
      if (cmd.failQty !== undefined) stats.failQty = cmd.failQty;
      if (cmd.judgment !== undefined) stats.judgment = cmd.judgment;
      if (note !== undefined) stats.inspectionNotes = note;
      if (FINISHED_STATUSES.includes(targetStatus)) stats.completedAt = new Date();
      await ctx.inspectionOrders.updateStatsAndVerdict(cmd.orderId, stats);

      const updated = await ctx.inspectionOrders.findById(cmd.orderId);
      if (updated === null) {
        throw new NotFoundError(`检验单终判后回读失败: ${cmd.orderId}`);
      }

      // 判不合格 -> 同事务汇入不合格待审核池（幂等：同单 upsert，不产生重复条目）
      const judgment = cmd.judgment ?? updated.overallDecision;
      const collected = isNonconformingVerdict(targetStatus, judgment);
      if (collected) {
        await collectPendingDefect(ctx, updated, note);
      }

      // 追溯节点登记（docs/41 §3）：终判是「本批次该环节检验结论」的唯一落点。
      // 节点表此前只有种子数据写入（saveNode 唯一调用方是 seeds/runner.ts），真实单从不落节点，
      // 于是【质量追溯看板】只有「仅检验台账」一行、点开批次直接 404 —— 这里同事务补上。
      // 幂等：仓储按 batch_no upsert，重复终判只覆盖同一行。
      const traceNode = await registerInspectionTraceNode(ctx, updated, cmd.operatorName);

      // MRB 返工闭环回写（docs/48 §4.8）：复检单终判合格 ⇒ 源单不再停在 `RE_INSPECTING`。
      // 口径：返工已闭环，源单归档 `COMPLETED`（其 FAILED 判定原样保留，供追责与 KPI 统计）。
      // 下游解锁依据始终是**复检单**的结论（§2.4 规则 3：轮次最高者胜），而不是源单结论 ——
      // 这里只负责把源单从「返工中」推进到闭环，绝不改写源单的判定结果。
      const reworkClosedOrderNo = await closeReworkLoopIfReinspectionPassed(
        ctx,
        updated,
        targetStatus,
        cmd.judgment ?? updated.overallDecision
      );

      // 判定不合格 -> 同事务**自动创建 MRB 评审单**（docs/43 §3：「判定即入评审」，无人工发起环节）。
      // 幂等：同一检验单重复终判复用既有 MRB 单；台账条目随之转 INITIATED 并回填 mrb_review_id。
      const auto =
        collected && updated.status === 'FAILED'
          ? await autoInitiateMrbReview(
              ctx,
              updated,
              { id: cmd.operatorId, name: cmd.operatorName },
              {
                ...(cmd.preliminaryDisposition !== undefined
                  ? { preliminaryDisposition: cmd.preliminaryDisposition }
                  : {}),
                ...(note !== undefined ? { reviewNotes: note } : {}),
              },
              securityCtx
            )
          : null;

      // 自动建单会把检验单推进到 IN_MRB_REVIEW，因此回读最终态返回给调用方
      // （此前返回的是 FAILED 中间态，前端列表刷新前会看到与实际不一致的状态）。
      const finalized =
        auto !== null ? (await ctx.inspectionOrders.findById(cmd.orderId)) ?? updated : updated;

      await ctx.auditLogs.insert({
        id: crypto.randomUUID(),
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        userId: cmd.operatorId,
        userName: cmd.operatorName,
        action: 'STATUS_CHANGE',
        resourceType: 'INSPECTION_ORDER',
        resourceId: cmd.orderId,
        status: 'SUCCESS',
        diffPatch: {
          orderNo: updated.orderNo,
          status: targetStatus,
          ...(cmd.judgment !== undefined ? { judgment: cmd.judgment } : {}),
          ...(cmd.passQty !== undefined ? { passQty: cmd.passQty } : {}),
          ...(cmd.failQty !== undefined ? { failQty: cmd.failQty } : {}),
          // 入池结果留痕：让「判不合格却没进池」这类问题在审计日志里可一眼判定
          pendingDefectCollected: collected,
          traceNodeBatchNo: traceNode.batchNo,
          traceNodeStatus: traceNode.nodeStatus,
          // 自动发起留痕：让「判不合格却没有 MRB 单」在审计日志里同样一眼可判
          mrbAutoInitiated: auto !== null,
          ...(auto !== null ? { mrbReviewNo: auto.mrbReview.mrbNo } : {}),
          ...(reworkClosedOrderNo !== undefined ? { reworkClosedSourceOrderNo: reworkClosedOrderNo } : {}),
          ...(cmd.preliminaryDisposition !== undefined
            ? { preliminaryDisposition: cmd.preliminaryDisposition }
            : {}),
          ...(note !== undefined ? { remark: note } : {}),
        },
        createdAt: new Date().toISOString(),
      });

      return finalized;
    });
  }
}
