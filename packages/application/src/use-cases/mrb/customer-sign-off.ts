import type {
  ConcessionSignOff,
  MRBReview as MRBReviewDTO,
} from '@letian/contracts';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface CustomerSignOffCommand extends Partial<ConcessionSignOff> {
  mrbId: string;
  customerName: string;
  customerSigner?: string;
  signOffDocumentUrl?: string;
  agreed: boolean;
  operatorId: string;
  operatorName?: string;
  remark?: string;
}

/**
 * 特采 (CONCESSION) 客户签核编排用例
 */
export class CustomerSignOffUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: CustomerSignOffCommand,
    securityCtx?: ISecurityContext
  ): Promise<MRBReviewDTO> {
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

      if (review.disposition !== 'CONCESSION') {
        throw new ApplicationError(
          'INVALID_DISPOSITION_FOR_SIGNOFF',
          `只有特采/让步接收 (CONCESSION) 处置才需要客户签核，当前处置方式为 [${review.disposition}]`,
          400
        );
      }

      if (review.status === 'DISPOSED' || review.status === 'REJECTED') {
        throw new ApplicationError(
          'MRB_ALREADY_FINISHED',
          `MRB 评审单已处于终态 [${review.status}]，无法签核`,
          400
        );
      }

      // 锁定批次
      await ctx.locks.acquireXactLock(review.batchNo);

      const updatedReview: MRBReviewDTO = {
        ...review,
        ...(cmd.signOffDocumentUrl !== undefined ? { concessionAttachmentUrl: cmd.signOffDocumentUrl } : {}),
        status: cmd.agreed ? review.status : 'REJECTED',
        updatedAt: new Date().toISOString(),
      };

      await ctx.mrbReviews.save(updatedReview);

      await ctx.outbox.append({
        id: crypto.randomUUID(),
        aggregateType: 'MRBReview',
        aggregateId: review.id,
        eventType: 'MRBCustomerSignedOff',
        payload: {
          mrbId: review.id,
          customerName: cmd.customerName,
          customerSigner: cmd.customerSigner,
          agreed: cmd.agreed,
          documentUrl: cmd.signOffDocumentUrl,
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
        userName: cmd.operatorName ?? '系统操作员',
        action: 'STATUS_CHANGE',
        resourceType: 'MRB_REVIEW',
        resourceId: review.id,
        status: 'SUCCESS',
        diffPatch: {
          customerName: cmd.customerName,
          customerSigner: cmd.customerSigner,
          agreed: cmd.agreed,
          docUrl: cmd.signOffDocumentUrl,
          remark: cmd.remark,
        },
        createdAt: new Date().toISOString(),
      });

      return updatedReview;
    });
  }
}
