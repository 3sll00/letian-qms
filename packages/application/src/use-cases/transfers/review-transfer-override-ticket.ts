import { IUnitOfWork } from '../../tx/unit-of-work.js';
import { ISecurityContext } from '../../security/security-context.js';
import {
  ReviewTransferOverrideTicketRequest,
  TransferOverrideTicket,
  ErrorCode,
} from '@letian/contracts';
import { ApplicationError } from '../../errors/application-error.js';

export class ReviewTransferOverrideTicketUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    ticketId: string,
    cmd: ReviewTransferOverrideTicketRequest,
    securityCtx?: ISecurityContext
  ): Promise<TransferOverrideTicket> {
    return this.uow.execute(async (ctx) => {
      // 入参同时容忍工单 UUID 与工单编号（如 OVR20260924-4967）：
      // 非 UUID 形状直接走编号查询 —— 拿编号去比 UUID 列会吃 PostgreSQL 22P02，
      // 兜底分支永远轮不到（探针 AC-P2-04 抓到的 500 即此）。
      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ticketId);
      let ticket = isUuid ? await ctx.transferOverrides.findById(ticketId) : null;
      if (!ticket) {
        ticket = await ctx.transferOverrides.findByTicketNo(ticketId);
      }
      if (!ticket) {
        throw new ApplicationError(
          ErrorCode.RESOURCE_NOT_FOUND,
          `未找到豁免申请工单 [${ticketId}]`,
          404
        );
      }

      if (ticket.status !== 'PENDING') {
        throw new ApplicationError(
          ErrorCode.VALIDATION_FAILED,
          `豁免申请工单 [${ticket.ticketNo}] 当前状态为 [${ticket.status}]，不可重复审批`,
          422
        );
      }

      const updated = await ctx.transferOverrides.reviewTicket(ticket.id, {
        status: cmd.action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        reviewerId: cmd.reviewerId,
        ...(cmd.reviewerName ? { reviewerName: cmd.reviewerName } : (securityCtx?.userName ? { reviewerName: securityCtx.userName } : {})),
        ...(cmd.reviewNotes ? { reviewNotes: cmd.reviewNotes } : {}),
        ...(cmd.approvalDocNo ? { approvalDocNo: cmd.approvalDocNo } : {}),
      });

      await ctx.auditLogs.insert({
        id: crypto.randomUUID(),
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        userId: cmd.reviewerId,
        userName: cmd.reviewerName ?? securityCtx?.userName ?? '质量负责人',
        action: 'STATUS_CHANGE',
        resourceType: 'INSPECTION_ORDER',
        resourceId: updated.id,
        status: 'SUCCESS',
        diffPatch: {
          ticketNo: updated.ticketNo,
          action: cmd.action,
          approvalDocNo: cmd.approvalDocNo,
          reviewNotes: cmd.reviewNotes,
        },
        createdAt: new Date().toISOString(),
      });

      return {
        id: updated.id,
        ticketNo: updated.ticketNo,
        batchNo: updated.batchNo,
        materialCode: updated.materialCode,
        inspectionType: updated.inspectionType as any,
        workOrderNo: updated.workOrderNo,
        furnaceHeatNo: updated.furnaceHeatNo,
        upstreamOrderNo: updated.upstreamOrderNo,
        upstreamGateCode: updated.upstreamGateCode as any,
        reason: updated.reason,
        applicantId: updated.applicantId,
        applicantName: updated.applicantName,
        status: updated.status as any,
        reviewerId: updated.reviewerId,
        reviewerName: updated.reviewerName,
        reviewNotes: updated.reviewNotes,
        approvalDocNo: updated.approvalDocNo,
        consumedOrderId: updated.consumedOrderId,
        consumedOrderNo: updated.consumedOrderNo,
        createdAt: updated.createdAt.toISOString(),
        reviewedAt: updated.reviewedAt ? updated.reviewedAt.toISOString() : undefined,
        consumedAt: updated.consumedAt ? updated.consumedAt.toISOString() : undefined,
      };
    });
  }
}
