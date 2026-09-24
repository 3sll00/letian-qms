
import type {
  MRBReview as MRBReviewDTO,
  CreateMRBReviewRequest,
  MRBDisposition,
  MRBFailCategory,
} from '@letian/contracts';
import { inspectionTypeToFailCategory } from '@letian/contracts';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork, IUnitOfWorkContext } from '../../tx/unit-of-work.js';

export interface TriggerMrbReviewCommand extends Partial<CreateMRBReviewRequest> {
  inspectionOrderId: string;
  applicantId: string;
  applicantName?: string;
  failCategory?: string;
  preliminaryDisposition?: string;
  reason?: string;
  /** 发起时显式选定的评审流程定义 ID（优先于按来源类型自动匹配） */
  flowId?: string;
  /** 紧急程度：NORMAL / URGENT / CRITICAL */
  urgencyLevel?: string;
  /** 关联的不合格待审核池条目 ID（池发起路径透传，落 mrb_reviews.pending_defect_id） */
  pendingDefectId?: string;
  /** 发起说明（落 mrb_reviews.review_notes，不混入不合格描述文本） */
  reviewNotes?: string;
}

/**
 * 不合格自动触发 MRB 评审单用例
 */
export class TriggerMrbReviewUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: TriggerMrbReviewCommand,
    securityCtx?: ISecurityContext
  ): Promise<MRBReviewDTO> {
    return await this.uow.execute((ctx) => this.runInTransaction(ctx, cmd, securityCtx));
  }

  public async runInTransaction(
    ctx: IUnitOfWorkContext,
    cmd: TriggerMrbReviewCommand,
    securityCtx?: ISecurityContext
  ): Promise<MRBReviewDTO> {
    return await triggerMrbReviewInTransaction(ctx, cmd, securityCtx);
  }
}

/**
 * 「不合格自动触发 MRB 评审单」的事务内实现（docs/43 §4.1）。
 *
 * 终判用例必须在**自己的事务**里建单：`execute()` 会另开一个事务（另一条连接），既破坏
 * 「终判 + 入池 + 建 MRB 单」的原子性，也会与同一批次上的 pg_advisory_xact_lock 叠加成死锁风险。
 * 因此把事务内实现抽为独立函数，`TriggerMrbReviewUseCase.execute()` 与终判用例共用同一段逻辑，
 * 区别只在事务边界由谁提供。
 */
export async function triggerMrbReviewInTransaction(
  ctx: IUnitOfWorkContext,
  cmd: TriggerMrbReviewCommand,
  securityCtx?: ISecurityContext
): Promise<MRBReviewDTO> {
  const order = await ctx.inspectionOrders.findById(cmd.inspectionOrderId);
  if (!order) {
    throw new ApplicationError(
      'INSPECTION_ORDER_NOT_FOUND',
      `未找到检验单 [${cmd.inspectionOrderId}]`,
      404
    );
  }

  const orderDTO = order;

  if (securityCtx) {
    // 从物料主数据解析真实分类；查不到时 UNKNOWN 不命中任何白名单（fail-closed）
    const material = await ctx.materials.getMaterialByCode(orderDTO.materialCode);
    securityCtx.assertAccess({
      targetCategory: material?.categoryCode ?? 'UNKNOWN',
      targetMaterialCode: orderDTO.materialCode,
    });
  }

  if (orderDTO.status !== 'FAILED') {
    throw new ApplicationError(
      'ORDER_STATUS_NOT_FAILED',
      `只有判定为 FAILED 不合格的检验单可触发 MRB 评审，当前状态为 [${orderDTO.status}]`,
      400
    );
  }

  // 幂等检查：是否已存在关联的 MRB 评审单。复用分支同时按口径对齐「不合格数量」
  // （见 alignMrbDefectQtyWithSourceOrder）：建单与终判分属两次调用，数量不能停留在建单那一刻的中间态。
  const existing = await ctx.mrbReviews.findByOrderNo(orderDTO.orderNo);
  if (existing) {
    return await alignMrbDefectQtyWithSourceOrder(ctx, existing, orderDTO);
  }

  // 锁定批次，防止进入下一工序
  await ctx.locks.acquireXactLock(orderDTO.batchNo);

  // 不合格来源类型：显式指定优先，否则按检验环节映射（此前默认值 'CRITICAL_DIMENSION'
  // 不在 MRBFailCategoryEnum 内，导致流程匹配恒失效，见 docs/20 §3.2 D5）。
  // 映射口径收敛在契约层 `inspectionTypeToFailCategory`（docs/44 §1）：委外八类 → SUBCONTRACT_FAIL、
  // 出货 → SHIPMENT_FAIL，此前只认精确值 IQC/IPQC/OQC/FQC/OUTSOURCE，让委外与出货都错绑过程流程。
  const sourceType = (
    cmd.sourceType !== undefined &&
    ['INCOMING_FAIL', 'PROCESS_FAIL', 'SHIPMENT_FAIL', 'SUBCONTRACT_FAIL'].includes(
      cmd.sourceType
    )
      ? cmd.sourceType
      : inspectionTypeToFailCategory(orderDTO.inspectionType)
  ) as MRBFailCategory;

  // 评审流配置：优先用发起时选定的流程；未选定时按不合格来源类型自动匹配生效流程
  const failCategory = cmd.failCategory ?? sourceType;
  const disposition = cmd.preliminaryDisposition ?? 'REWORK';
  const reviewFlow =
    cmd.flowId !== undefined
      ? await ctx.reviewFlows.findById(cmd.flowId)
      : await ctx.reviewFlows.findApplicableFlow(failCategory);

  const urgencyLevel: 'NORMAL' | 'URGENT' | 'CRITICAL' =
    cmd.urgencyLevel !== undefined &&
    ['NORMAL', 'URGENT', 'CRITICAL'].includes(cmd.urgencyLevel)
      ? (cmd.urgencyLevel as 'NORMAL' | 'URGENT' | 'CRITICAL')
      : 'NORMAL';

  const reviewNo = `MRB-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
  const firstStepApproverRole = reviewFlow?.nodes[0]?.roleCode ?? 'QUALITY_MANAGER';

  const mrbRecord: MRBReviewDTO = {
    id: crypto.randomUUID(),
    mrbNo: reviewNo,
    sourceType,
    sourceOrderNo: orderDTO.orderNo,
    batchNo: orderDTO.batchNo,
    materialCode: orderDTO.materialCode,
    materialName: orderDTO.materialName,
    defectDescription:
      cmd.defectDescription ??
      cmd.reason ??
      `检验单 [${orderDTO.orderNo}] 判定不合格，自动触发 MRB 评审`,
    defectQty: cmd.defectQty ?? orderDTO.failQty,
    status: 'PENDING_REVIEW',
    disposition: disposition as MRBDisposition,
    urgencyLevel,
    approvers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(reviewFlow !== null && reviewFlow.id !== undefined
      ? { reviewFlowId: reviewFlow.id }
      : {}),
    ...(cmd.pendingDefectId !== undefined ? { pendingDefectId: cmd.pendingDefectId } : {}),
    ...(cmd.reviewNotes !== undefined ? { reviewNotes: cmd.reviewNotes } : {}),
  };

  await ctx.mrbReviews.save(mrbRecord);

  // 将检验单状态更新为 IN_MRB
  await ctx.inspectionOrders.updateStatus(orderDTO.id ?? cmd.inspectionOrderId, 'IN_MRB_REVIEW');

  // 写入 Outbox 事件
  await ctx.outbox.append({
    id: crypto.randomUUID(),
    aggregateType: 'MRBReview',
    aggregateId: mrbRecord.id,
    eventType: 'MRBReviewTriggered',
    payload: {
      mrbId: mrbRecord.id,
      reviewNo: mrbRecord.mrbNo,
      orderNo: orderDTO.orderNo,
      batchNo: orderDTO.batchNo,
      failCategory,
      preliminaryDisposition: disposition,
      currentApproverRole: firstStepApproverRole,
    },
    traceId: crypto.randomUUID(),
    occurredAt: new Date(),
    status: 'PENDING',
    retryCount: 0,
  });

  // 记录不可变审计日志
  await ctx.auditLogs.insert({
    id: crypto.randomUUID(),
    traceId: securityCtx?.traceId ?? crypto.randomUUID(),
    userId: cmd.applicantId,
    userName: cmd.applicantName ?? '申请人',
    action: 'STATUS_CHANGE',
    resourceType: 'MRB_REVIEW',
    resourceId: mrbRecord.id,
    status: 'SUCCESS',
    diffPatch: {
      orderNo: orderDTO.orderNo,
      batchNo: orderDTO.batchNo,
      failCategory,
      disposition,
    },
    createdAt: new Date().toISOString(),
  });

  return mrbRecord;
}

/**
 * 幂等复用既有 MRB 单时，把「不合格数量」对齐到源检验单的 `fail_qty`（docs/21 §13.2 唯一口径）。
 *
 * 为什么必须在复用分支做这件事：口径本身是「MRB 不合格数量 = 源单 `fail_qty`（= 检验员填写的不合格数）」，
 * 但**建单与数量落地分属两次调用** —— 录入弹窗先 `POST /inspections/:id/submit-measurements`
 * （判定即建单，此刻填写值还没随 `POST /inspections/:id/status` 落库，读到的 `fail_qty` 可能是领域
 * 派生的兜底值：首次判定时恒等于整批抽样数），再 `POST /status` 把填写值写进检验单。
 * 建单在前、填写值在后，于是 MRB 单会把**检测数**固化成「不合格数量」，用户实测即为此现象（docs/21 §14）。
 *
 * 对齐规则：源单 `fail_qty > 0`（视为检验员已填写）且与单据现值不一致时以源单为准；
 * `fail_qty = 0` 视为尚未填写 —— 此时保留既有值，绝不把单据回退成 0。
 *
 * 两个复用入口都要走这里：`triggerMrbReviewInTransaction` 自身的幂等分支，以及
 * `autoInitiateMrbReview` 的「先查后建」分支（终判 / 录入用例的实际入口，漏掉它订正就不会发生）。
 */
export async function alignMrbDefectQtyWithSourceOrder(
  ctx: IUnitOfWorkContext,
  existing: MRBReviewDTO,
  order: { failQty?: number | undefined }
): Promise<MRBReviewDTO> {
  const failQty = Number(order.failQty ?? 0);
  if (!(failQty > 0) || existing.defectQty === failQty) {
    return existing;
  }

  const aligned: MRBReviewDTO = {
    ...existing,
    defectQty: failQty,
    updatedAt: new Date().toISOString(),
  };
  await ctx.mrbReviews.save(aligned);
  return aligned;
}
