
function mapOrderStageToSourceType(stage?: string): MRBFailCategory {
  if (stage === "IQC") return "INCOMING_FAIL";
  if (stage === "IPQC") return "PROCESS_FAIL";
  if (stage === "OQC" || stage === "FQC") return "SHIPMENT_FAIL";
  if (stage === "OUTSOURCE") return "SUBCONTRACT_FAIL";
  return "PROCESS_FAIL";
}
import type {
  MRBReview as MRBReviewDTO,
  CreateMRBReviewRequest,
  MRBDisposition,
  MRBFailCategory,
} from '@letian/contracts';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

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
    return await this.uow.execute(async (ctx) => {
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

      // 幂等检查：是否已存在关联的 MRB 评审单
      const existing = await ctx.mrbReviews.findByOrderNo(orderDTO.orderNo);
      if (existing) {
        return existing;
      }

      // 锁定批次，防止进入下一工序
      await ctx.locks.acquireXactLock(orderDTO.batchNo);

      // 不合格来源类型：显式指定优先，否则按检验环节映射（此前默认值 'CRITICAL_DIMENSION'
      // 不在 MRBFailCategoryEnum 内，导致流程匹配恒失效，见 docs/20 §3.2 D5）
      const sourceType = (
        cmd.sourceType !== undefined &&
        ['INCOMING_FAIL', 'PROCESS_FAIL', 'SHIPMENT_FAIL', 'SUBCONTRACT_FAIL'].includes(
          cmd.sourceType
        )
          ? cmd.sourceType
          : mapOrderStageToSourceType(orderDTO.inspectionType)
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
        userName: '申请人',
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
    });
  }
}
