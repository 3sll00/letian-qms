import type {
  MRBDispositionDecisionRequest,
  MRBDisposition,
  MRBReview as MRBReviewDTO,
  InspectionOrder as InspectionOrderDTO,
} from '@letian/contracts';
import { resolveChainAnchors, successorStagesOf } from '@letian/domain';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork, IUnitOfWorkContext } from '../../tx/unit-of-work.js';
import { CreateReinspectionUseCase } from '../inspections/create-reinspection.js';
import { registerInspectionTraceNode } from '../traceability/register-inspection-trace-node.js';

export interface DecideMrbDispositionCommand extends Partial<MRBDispositionDecisionRequest> {
  mrbId: string;
  disposition: MRBDisposition;
  operatorId: string;
  operatorName?: string;
  dispositionReason?: string;
}

export interface DecideMrbDispositionResult {
  mrbReview: MRBReviewDTO;
  reinspectionOrderId?: string;
  reinspectionOrderNo?: string;
}

/**
 * 4 类处置决策用例 (REWORK / RETURN_TO_VENDOR / CONCESSION / SCRAP)
 * 特别关键规则：返工决策 (REWORK) 必须触发复检轮次生成
 */
export class DecideMrbDispositionUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: DecideMrbDispositionCommand,
    securityCtx?: ISecurityContext
  ): Promise<DecideMrbDispositionResult> {
    return await this.uow.execute(async (ctx) => {
      const review = await ctx.mrbReviews.findById(cmd.mrbId);
      if (!review) {
        throw new ApplicationError('MRB_NOT_FOUND', `未找到 MRB 评审单 [${cmd.mrbId}]`, 404);
      }

      if (securityCtx) {
        // 从物料主数据解析真实分类；查不到时 UNKNOWN 不命中任何白名单（fail-closed）
        const material = await ctx.materials.getMaterialByCode(review.materialCode);
        securityCtx.assertAccess({
          targetCategory: material?.categoryCode ?? 'UNKNOWN',
          targetMaterialCode: review.materialCode,
        });
      }

      if (review.status === 'DISPOSED' || review.status === 'REJECTED') {
        throw new ApplicationError(
          'MRB_ALREADY_CLOSED',
          `MRB 评审单已完结，当前状态为 [${review.status}]`,
          400
        );
      }

      // 锁定批次
      await ctx.locks.acquireXactLock(review.batchNo);

      const effectiveConcessionUrl = cmd.concessionAttachmentUrl || review.concessionAttachmentUrl;
      // 特采让步校验：必须已上传客户书面同意书附件
      if (cmd.disposition === 'CONCESSION') {
        if (!effectiveConcessionUrl) {
          throw new ApplicationError(
            'CONCESSION_NOT_SIGNED_OFF',
            '特采让步接收必须先经过客户书面签核同意，当前未签核或未通过',
            400
          );
        }
      }

      const updatedReview: MRBReviewDTO = {
        ...review,
        disposition: cmd.disposition,
        status: 'DISPOSED',
        concessionAttachmentUrl: effectiveConcessionUrl,
        // 本次共同签署人凭证与会签历史合并落库（契约 approvers 可选，省略时沿用历史）
        approvers: [...review.approvers, ...(cmd.approvers ?? [])],
        // 处置闭环时间与最终裁决人（KPI 与追溯使用，见 docs/20 §4.2）
        disposedAt: new Date().toISOString(),
        disposedBy: cmd.operatorName ?? cmd.operatorId,
        ...(cmd.dispositionReason !== undefined ? { dispositionNotes: cmd.dispositionReason } : {}),
        updatedAt: new Date().toISOString(),
      };

      await ctx.mrbReviews.save(updatedReview);

      // 「合格后传递」链路回写（docs/48 §4.8）——**必须与本门禁同批交付**：
      // 只加门禁不回写，会让让步接收后的批次永久卡死，比不加门禁更糟（§8 硬约束 1）。
      // 三种处置在传递语义上并不同构：让步接收 = 受限解锁；返工 = 条件解锁（等复检）；
      // 退货 / 报废 = 整链终止（下游禁建单 + 已建未终判单冻结）。
      const sourceOrder = await ctx.inspectionOrders.findByOrderNo(review.sourceOrderNo);
      if (sourceOrder !== null && cmd.disposition === 'CONCESSION') {
        const concessionOrderId = sourceOrder.id;
        if (concessionOrderId !== undefined) {
          await applyConcessionWriteBack(ctx, concessionOrderId, review.mrbNo);
        }
      }
      const terminated =
        sourceOrder !== null &&
        (cmd.disposition === 'RETURN_TO_VENDOR' || cmd.disposition === 'SCRAP');
      const frozenOrderNos = terminated
        ? await terminateChainWriteBack(ctx, review, sourceOrder, {
            id: cmd.operatorId,
            name: cmd.operatorName ?? cmd.operatorId,
          })
        : [];

      let reinspectionOrderId: string | undefined;
      let reinspectionOrderNo: string | undefined;

      // 关键规则：返工决策必须触发复检轮次生成
      if (cmd.disposition === 'REWORK') {
        const reinspectionUseCase = new CreateReinspectionUseCase(this.uow);
        const reinspectionDTO = await reinspectionUseCase.execute(
          {
            parentOrderId: sourceOrder?.id ?? review.sourceOrderNo,
            reworkReason: `[MRB处置-${review.mrbNo}] ${cmd.dispositionReason}`,
            operatorId: cmd.operatorId,
          },
          securityCtx
        );
        reinspectionOrderId = reinspectionDTO.id;
        reinspectionOrderNo = reinspectionDTO.orderNo;
      }

      // 产生 Outbox 领域事件
      await ctx.outbox.append({
        id: crypto.randomUUID(),
        aggregateType: 'MRBReview',
        aggregateId: review.id,
        eventType: 'MRBDispositionDecided',
        payload: {
          mrbId: review.id,
          reviewNo: review.mrbNo,
          orderNo: review.sourceOrderNo,
          batchNo: review.batchNo,
          disposition: cmd.disposition,
          disposedBy: cmd.operatorId,
          reinspectionOrderId,
          reinspectionOrderNo,
          // 「合格后传递」链路回写结果：终止时下游系统据此冻结整条链（docs/48 §3-9）
          terminateChain: terminated,
          frozenOrderNos,
        },
        traceId: crypto.randomUUID(),
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 0,
      });

      // 不可变审计日志
      await ctx.auditLogs.insert({
        ...(crypto.randomUUID ? { id: crypto.randomUUID() } : {}),
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        userId: cmd.operatorId,
        userName: cmd.operatorName ?? '系统操作员',
        action: 'DISPOSE',
        resourceType: 'MRB_REVIEW',
        resourceId: review.id,
        status: 'SUCCESS',
        diffPatch: {
          disposition: cmd.disposition,
          reason: cmd.dispositionReason,
          reinspectionOrderId,
          terminateChain: terminated,
          frozenOrderNos,
        },
        createdAt: new Date().toISOString(),
      });

      return {
        mrbReview: updatedReview,
        ...(reinspectionOrderId !== undefined ? { reinspectionOrderId } : {}),
        ...(reinspectionOrderNo !== undefined ? { reinspectionOrderNo } : {}),
      };
    });
  }
}

/**
 * 链路终止时需要冻结的「未终判」状态集合。
 *
 * 只冻结未出结论的单：已终判合格 / 不合格的单保留既有结论（TBD-06：冻结不删除、作废需人工操作），
 * 否则等于用 MRB 结论去改写历史判定，追溯链会失去可解释性。
 */
const FROZEN_STATUSES: readonly string[] = [
  'PENDING',
  'DRAFT',
  'INSPECTING',
  'RE_INSPECTING',
  'IN_MRB_REVIEW',
];

/**
 * 让步接收（特采）回写（docs/48 §4.8）：源单结论置 `CONCESSION` + 追溯节点由 `FAILED` 升为 `CONCESSION`。
 *
 * 三件事缺一不可：
 *   ① 结论置 `CONCESSION` —— 下游门禁据此走**受限放行**（`UPSTREAM_CONCESSION`，要求可举证客户授权件）；
 *   ② 状态归档 `COMPLETED` —— 本环节判定已出即闭环（与 TBD-02「判定合格即可传递」同口径）；
 *   ③ 重写追溯节点 —— 节点表 `batch_no` 唯一且 upsert 覆盖，看板不再停在 `FAILED`，
 *      否则「看板说不合格、门禁说已放行」两套口径同时正确且互相矛盾（docs/48 §4.4 注意 3）。
 */
async function applyConcessionWriteBack(
  ctx: IUnitOfWorkContext,
  orderId: string,
  mrbNo: string
): Promise<void> {
  await ctx.inspectionOrders.updateStatsAndVerdict(orderId, { judgment: 'CONCESSION' });
  await ctx.inspectionOrders.updateStatus(
    orderId,
    'COMPLETED',
    `MRB ${mrbNo} 判定让步接收（特采）放行：本单已闭环，下游须携带特采标记`
  );
  const reread = await ctx.inspectionOrders.findById(orderId);
  if (reread !== null) {
    await registerInspectionTraceNode(ctx, reread);
  }
}

/**
 * 退货 / 报废回写（docs/48 §3-9）：整链终止 —— 下游不得建单，已建未终判单**冻结并打标**（不删除）。
 *
 * 冻结的实现口径（不新增物理列、不新增状态枚举）：
 *   - 备注列追加链路终止说明（`inspection_notes` 仅在为空时写入，绝不覆盖已存在的现场备注）；
 *   - 每个被冻结单写一条审计（`STATUS_CHANGE` + `frozen: true`），让「这批为什么动不了」可查；
 *   - 发一条 `CHAIN_TERMINATED` Outbox，供 ERP / 委外系统消费（TBD-07）。
 * 界面上的「冻结」由传递判定 `CHAIN_TERMINATED` 呈现（台账 / 看板派生字段），不依赖状态枚举。
 */
async function terminateChainWriteBack(
  ctx: IUnitOfWorkContext,
  review: MRBReviewDTO,
  sourceOrder: InspectionOrderDTO,
  operator: { id: string; name: string }
): Promise<readonly string[]> {
  const anchors = resolveChainAnchors({
    batchNo: sourceOrder.batchNo,
    ...(sourceOrder.furnaceHeatNo !== undefined ? { furnaceHeatNo: sourceOrder.furnaceHeatNo } : {}),
    ...(sourceOrder.workOrderNo !== undefined ? { workOrderNo: sourceOrder.workOrderNo } : {}),
  });
  const downstream = await ctx.inspectionOrders.findChainCandidates(anchors, {
    inspectionTypes: successorStagesOf(sourceOrder.inspectionType),
  });
  const frozen = downstream.filter((candidate) => FROZEN_STATUSES.includes(candidate.order.status));
  const frozenOrderNos: string[] = [];

  for (const candidate of frozen) {
    const orderId = candidate.order.id;
    if (orderId === undefined) {
      continue;
    }
    frozenOrderNos.push(candidate.order.orderNo);
    await ctx.inspectionOrders.updateStatus(
      orderId,
      candidate.order.status,
      `链路已终止：MRB ${review.mrbNo} 判定 ${review.disposition ?? '终止'}，本单冻结待人工处理`
    );
    await ctx.auditLogs.insert({
      id: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      userId: operator.id,
      userName: operator.name,
      action: 'STATUS_CHANGE',
      resourceType: 'INSPECTION_ORDER',
      resourceId: orderId,
      status: 'SUCCESS',
      diffPatch: {
        frozen: true,
        chainTerminated: true,
        mrbNo: review.mrbNo,
        disposition: review.disposition ?? null,
        sourceOrderNo: review.sourceOrderNo,
        reason: '上游退货 / 报废导致整条链路终止，本单禁止继续流转',
      },
      createdAt: new Date().toISOString(),
    });
  }

  await ctx.outbox.append({
    id: crypto.randomUUID(),
    aggregateType: 'MRBReview',
    aggregateId: review.id,
    eventType: 'CHAIN_TERMINATED',
    payload: {
      mrbNo: review.mrbNo,
      disposition: review.disposition ?? null,
      sourceOrderNo: review.sourceOrderNo,
      batchNo: review.batchNo,
      materialCode: review.materialCode,
      frozenOrderNos,
    },
    traceId: crypto.randomUUID(),
    occurredAt: new Date(),
    status: 'PENDING',
    retryCount: 0,
  });

  return frozenOrderNos;
}
