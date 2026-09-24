import { IUnitOfWork } from '../../tx/unit-of-work.js';
import { TransferOverrideTicket } from '@letian/contracts';

export interface ListTransferOverrideTicketsQuery {
  batchNo?: string;
  materialCode?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface ListTransferOverrideTicketsResult {
  items: TransferOverrideTicket[];
  total: number;
  page: number;
  pageSize: number;
}

export class ListTransferOverrideTicketsUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    query?: ListTransferOverrideTicketsQuery
  ): Promise<ListTransferOverrideTicketsResult> {
    return this.uow.execute(async (ctx) => {
      const page = query?.page ?? 1;
      const pageSize = query?.pageSize ?? 20;

      const res = await ctx.transferOverrides.listTickets({
        ...(query?.batchNo ? { batchNo: query.batchNo } : {}),
        ...(query?.materialCode ? { materialCode: query.materialCode } : {}),
        ...(query?.status ? { status: query.status } : {}),
        page,
        pageSize,
      });

      return {
        items: res.items.map((t) => ({
          id: t.id,
          ticketNo: t.ticketNo,
          batchNo: t.batchNo,
          materialCode: t.materialCode,
          inspectionType: t.inspectionType as any,
          workOrderNo: t.workOrderNo,
          furnaceHeatNo: t.furnaceHeatNo,
          upstreamOrderNo: t.upstreamOrderNo,
          upstreamGateCode: t.upstreamGateCode as any,
          reason: t.reason,
          applicantId: t.applicantId,
          applicantName: t.applicantName,
          status: t.status as any,
          reviewerId: t.reviewerId,
          reviewerName: t.reviewerName,
          reviewNotes: t.reviewNotes,
          approvalDocNo: t.approvalDocNo,
          consumedOrderId: t.consumedOrderId,
          consumedOrderNo: t.consumedOrderNo,
          createdAt: t.createdAt.toISOString(),
          reviewedAt: t.reviewedAt ? t.reviewedAt.toISOString() : undefined,
          consumedAt: t.consumedAt ? t.consumedAt.toISOString() : undefined,
        })),
        total: res.total,
        page,
        pageSize,
      };
    });
  }
}
