import { randomUUID } from 'node:crypto';
import { IUnitOfWork } from '../../tx/unit-of-work.js';
import { ISecurityContext } from '../../security/security-context.js';
import {
  CreateTransferOverrideTicketRequest,
  TransferOverrideTicket,
  ErrorCode,
} from '@letian/contracts';
import { ApplicationError } from '../../errors/application-error.js';

export class CreateTransferOverrideTicketUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: CreateTransferOverrideTicketRequest,
    securityCtx?: ISecurityContext
  ): Promise<TransferOverrideTicket> {
    if (!cmd.reason || cmd.reason.trim().length < 5) {
      throw new ApplicationError(
        ErrorCode.VALIDATION_FAILED,
        '豁免原因至少需要5个字符',
        400
      );
    }

    return this.uow.execute(async (ctx) => {
      const ticket = await ctx.transferOverrides.createTicket({
        batchNo: cmd.batchNo,
        materialCode: cmd.materialCode,
        inspectionType: cmd.inspectionType,
        ...(cmd.workOrderNo ? { workOrderNo: cmd.workOrderNo } : {}),
        ...(cmd.furnaceHeatNo ? { furnaceHeatNo: cmd.furnaceHeatNo } : {}),
        ...(cmd.upstreamOrderNo ? { upstreamOrderNo: cmd.upstreamOrderNo } : {}),
        upstreamGateCode: 'UPSTREAM_OVERRIDDEN',
        reason: cmd.reason,
        applicantId: cmd.applicantId,
        applicantName: cmd.applicantName ?? securityCtx?.userName ?? null,
      });

      await ctx.auditLogs.insert({
        id: randomUUID(),
        traceId: securityCtx?.traceId ?? randomUUID(),
        userId: cmd.applicantId,
        userName: cmd.applicantName ?? securityCtx?.userName ?? '一线检验员',
        action: 'CREATE',
        resourceType: 'INSPECTION_ORDER',
        resourceId: ticket.id,
        status: 'SUCCESS',
        diffPatch: {
          ticketNo: ticket.ticketNo,
          batchNo: ticket.batchNo,
          materialCode: ticket.materialCode,
          inspectionType: ticket.inspectionType,
          reason: ticket.reason,
          action: 'CREATE_TRANSFER_OVERRIDE_TICKET',
        },
        createdAt: new Date().toISOString(),
      });

      return {
        id: ticket.id,
        ticketNo: ticket.ticketNo,
        batchNo: ticket.batchNo,
        materialCode: ticket.materialCode,
        inspectionType: ticket.inspectionType as any,
        workOrderNo: ticket.workOrderNo,
        furnaceHeatNo: ticket.furnaceHeatNo,
        upstreamOrderNo: ticket.upstreamOrderNo,
        upstreamGateCode: ticket.upstreamGateCode as any,
        reason: ticket.reason,
        applicantId: ticket.applicantId,
        applicantName: ticket.applicantName,
        status: ticket.status as any,
        reviewerId: ticket.reviewerId,
        reviewerName: ticket.reviewerName,
        reviewNotes: ticket.reviewNotes,
        approvalDocNo: ticket.approvalDocNo,
        consumedOrderId: ticket.consumedOrderId,
        consumedOrderNo: ticket.consumedOrderNo,
        createdAt: ticket.createdAt.toISOString(),
        reviewedAt: ticket.reviewedAt ? ticket.reviewedAt.toISOString() : undefined,
        consumedAt: ticket.consumedAt ? ticket.consumedAt.toISOString() : undefined,
      };
    });
  }
}
