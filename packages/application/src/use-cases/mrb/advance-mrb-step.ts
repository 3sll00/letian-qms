import type {
  MRBStatus,
  MRBReview as MRBReviewDTO,
} from '@letian/contracts';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface AdvanceMrbStepCommand {
  mrbId: string;
  action: 'APPROVE' | 'REJECT';
  operatorId: string;
  operatorRole: string;
  comment?: string;
  operatorName?: string;
}

/**
 * 可配置多级流程流转用例
 */
export class AdvanceMrbStepUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: AdvanceMrbStepCommand,
    securityCtx?: ISecurityContext
  ): Promise<MRBReviewDTO> {
    return await this.uow.execute(async (ctx) => {
      const review = await ctx.mrbReviews.findById(cmd.mrbId);
      if (!review) {
        throw new ApplicationError('MRB_NOT_FOUND', `未找到 MRB 评审单 [${cmd.mrbId}]`, 404);
      }

      if (securityCtx) {
        securityCtx.assertAccess({
          targetCategory: review.materialCode.split('-')[0] ?? 'STANDARD',
          targetMaterialCode: review.materialCode,
        });
      }

      if (review.status === 'DISPOSED' || review.status === 'REJECTED') {
        throw new ApplicationError(
          'MRB_ALREADY_FINISHED',
          `MRB 评审单已终结，当前状态为 [${review.status}]`,
          400
        );
      }

      // 锁定批次
      await ctx.locks.acquireXactLock(review.batchNo);

      // MRBReview 契约以 approvers 会签记录承载审批历史与签署意见
      const approvalHistory = [...review.approvers];
      approvalHistory.push({
        userId: cmd.operatorId,
        userName: cmd.operatorName ?? cmd.operatorId,
        roleCode: cmd.operatorRole,
        action: cmd.action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        comment: cmd.comment ?? '',
        signedAt: new Date().toISOString(),
      });

      // 步骤推进：当前步序从会签记录数推导，最大步序取自适用评审流定义节点数
      const reviewFlow = await ctx.reviewFlows.findApplicableFlow(review.sourceType);
      const currentStepOrder = review.approvers.length + 1;
      const maxStepOrder = reviewFlow?.nodes.length ?? 1;

      let nextStatus: MRBStatus = review.status;
      let nextStepOrder = currentStepOrder;

      if (cmd.action === 'REJECT') {
        nextStatus = 'REJECTED';
      } else {
        // APPROVE
        if (currentStepOrder >= maxStepOrder) {
          // 若已达到最大步骤，进入 UNDER_REVIEW (等待最终 DispositionDecision 处置)
          nextStatus = 'UNDER_REVIEW';
        } else {
          nextStepOrder = currentStepOrder + 1;
          nextStatus = 'UNDER_REVIEW';
        }
      }

      const updatedReview: MRBReviewDTO = {
        ...review,
        status: nextStatus,
        approvers: approvalHistory,
        updatedAt: new Date().toISOString(),
      };

      await ctx.mrbReviews.save(updatedReview);

      await ctx.outbox.append({
        id: crypto.randomUUID(),
        aggregateType: 'MRBReview',
        aggregateId: review.id,
        eventType: cmd.action === 'APPROVE' ? 'MRBStepApproved' : 'MRBStepRejected',
        payload: {
          mrbId: review.id,
          stepOrder: currentStepOrder,
          decision: cmd.action,
          operatorId: cmd.operatorId,
          operatorRole: cmd.operatorRole,
          nextStepOrder,
          status: nextStatus,
        },
        traceId: crypto.randomUUID(),
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 0,
      });

      await ctx.auditLogs.insert({
        id: crypto.randomUUID(),
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        userId: cmd.operatorId,
        userName: cmd.operatorName ?? cmd.operatorId,
        action: 'STATUS_CHANGE',
        resourceType: 'MRB_REVIEW',
        resourceId: review.id,
        status: 'SUCCESS',
        diffPatch: {
          stepOrder: currentStepOrder,
          action: cmd.action,
          role: cmd.operatorRole,
          comment: cmd.comment,
        },
        createdAt: new Date().toISOString(),
      });

      return updatedReview;
    });
  }
}
