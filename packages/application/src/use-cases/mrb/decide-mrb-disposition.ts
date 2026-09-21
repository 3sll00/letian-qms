import type {
  MRBDispositionDecisionRequest,
  MRBDisposition,
  MRBReview as MRBReviewDTO,
} from '@letian/contracts';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';
import { CreateReinspectionUseCase } from '../inspections/create-reinspection.js';

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
        ...(cmd.dispositionReason !== undefined ? { dispositionNotes: cmd.dispositionReason } : {}),
        updatedAt: new Date().toISOString(),
      };

      await ctx.mrbReviews.save(updatedReview);

      let reinspectionOrderId: string | undefined;
      let reinspectionOrderNo: string | undefined;

      // 关键规则：返工决策必须触发复检轮次生成
      if (cmd.disposition === 'REWORK') {
        const sourceOrder = await ctx.inspectionOrders.findByOrderNo(review.sourceOrderNo);
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
