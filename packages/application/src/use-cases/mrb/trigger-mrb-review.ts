
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

      // 查询适用的评审流配置
      const failCategory = cmd.failCategory ?? 'CRITICAL_DIMENSION';
      const disposition = cmd.preliminaryDisposition ?? 'REWORK';
      const reviewFlow = await ctx.reviewFlows.findApplicableFlow(failCategory);

      const reviewNo = `MRB-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
      const firstStepApproverRole = reviewFlow?.nodes[0]?.roleCode ?? 'QUALITY_MANAGER';

      const mrbRecord: MRBReviewDTO = {
        id: crypto.randomUUID(),
        mrbNo: reviewNo,
        sourceType: (cmd.sourceType && ["INCOMING_FAIL", "PROCESS_FAIL", "SHIPMENT_FAIL", "SUBCONTRACT_FAIL"].includes(cmd.sourceType) ? cmd.sourceType : mapOrderStageToSourceType(orderDTO.inspectionType)) as MRBFailCategory,
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
        approvers: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
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
