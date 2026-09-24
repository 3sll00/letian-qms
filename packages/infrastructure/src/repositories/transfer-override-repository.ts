import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { Database } from '../database/schema.js';
import type {
  TransferOverrideRepository,
  TransferOverrideTicketRecord,
} from '@letian/domain';

export class KyselyTransferOverrideRepository implements TransferOverrideRepository {
  constructor(private readonly db: Kysely<Database>) {}

  public async createTicket(
    data: Omit<TransferOverrideTicketRecord, 'id' | 'ticketNo' | 'status' | 'createdAt' | 'reviewedAt' | 'consumedAt'>
  ): Promise<TransferOverrideTicketRecord> {
    const id = randomUUID();
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randSuffix = Math.floor(1000 + Math.random() * 9000).toString();
    const ticketNo = `OVR${dateStr}-${randSuffix}`;

    const row = await this.db
      .insertInto('transferOverrideTickets')
      .values({
        id,
        ticketNo,
        batchNo: data.batchNo,
        materialCode: data.materialCode,
        inspectionType: data.inspectionType,
        workOrderNo: data.workOrderNo ?? null,
        furnaceHeatNo: data.furnaceHeatNo ?? null,
        upstreamOrderNo: data.upstreamOrderNo ?? null,
        upstreamGateCode: data.upstreamGateCode,
        reason: data.reason,
        applicantId: data.applicantId,
        applicantName: data.applicantName ?? null,
        status: 'PENDING',
        reviewerId: null,
        reviewerName: null,
        reviewNotes: null,
        approvalDocNo: null,
        consumedOrderId: null,
        consumedOrderNo: null,
        createdAt: new Date(),
        reviewedAt: null,
        consumedAt: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(row);
  }

  public async findById(id: string): Promise<TransferOverrideTicketRecord | null> {
    const row = await this.db
      .selectFrom('transferOverrideTickets')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  public async findByTicketNo(ticketNo: string): Promise<TransferOverrideTicketRecord | null> {
    const row = await this.db
      .selectFrom('transferOverrideTickets')
      .selectAll()
      .where('ticketNo', '=', ticketNo)
      .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  public async findActiveApprovedTicket(params: {
    batchNo: string;
    materialCode: string;
    inspectionType: string;
  }): Promise<TransferOverrideTicketRecord | null> {
    const row = await this.db
      .selectFrom('transferOverrideTickets')
      .selectAll()
      .where('batchNo', '=', params.batchNo)
      .where('materialCode', '=', params.materialCode)
      .where('inspectionType', '=', params.inspectionType)
      .where('status', '=', 'APPROVED')
      .orderBy('reviewedAt', 'desc')
      .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  public async reviewTicket(
    id: string,
    review: {
      status: 'APPROVED' | 'REJECTED';
      reviewerId: string;
      reviewerName?: string;
      reviewNotes?: string;
      approvalDocNo?: string;
    }
  ): Promise<TransferOverrideTicketRecord> {
    const row = await this.db
      .updateTable('transferOverrideTickets')
      .set({
        status: review.status,
        reviewerId: review.reviewerId,
        reviewerName: review.reviewerName ?? null,
        reviewNotes: review.reviewNotes ?? null,
        approvalDocNo: review.approvalDocNo ?? null,
        reviewedAt: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(row);
  }

  public async consumeTicket(
    id: string,
    consumption: { orderId: string; orderNo: string }
  ): Promise<TransferOverrideTicketRecord> {
    const row = await this.db
      .updateTable('transferOverrideTickets')
      .set({
        status: 'CONSUMED',
        consumedOrderId: consumption.orderId,
        consumedOrderNo: consumption.orderNo,
        consumedAt: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(row);
  }

  public async listTickets(params?: {
    batchNo?: string;
    materialCode?: string;
    status?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: TransferOverrideTicketRecord[]; total: number }> {
    const page = params?.page ?? 1;
    const pageSize = params?.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    let query = this.db.selectFrom('transferOverrideTickets');

    if (params?.batchNo) {
      query = query.where('batchNo', '=', params.batchNo);
    }
    if (params?.materialCode) {
      query = query.where('materialCode', '=', params.materialCode);
    }
    if (params?.status) {
      query = query.where('status', '=', params.status as any);
    }

    const countRes = await query
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirst();
    const total = Number(countRes?.total ?? 0);

    const rows = await query
      .selectAll()
      .orderBy('createdAt', 'desc')
      .limit(pageSize)
      .offset(offset)
      .execute();

    return {
      items: rows.map((r) => this.mapRow(r)),
      total,
    };
  }

  private mapRow(row: any): TransferOverrideTicketRecord {
    return {
      id: row.id,
      ticketNo: row.ticketNo,
      batchNo: row.batchNo,
      materialCode: row.materialCode,
      inspectionType: row.inspectionType,
      workOrderNo: row.workOrderNo ?? null,
      furnaceHeatNo: row.furnaceHeatNo ?? null,
      upstreamOrderNo: row.upstreamOrderNo ?? null,
      upstreamGateCode: row.upstreamGateCode,
      reason: row.reason,
      applicantId: row.applicantId,
      applicantName: row.applicantName ?? null,
      status: row.status,
      reviewerId: row.reviewerId ?? null,
      reviewerName: row.reviewerName ?? null,
      reviewNotes: row.reviewNotes ?? null,
      approvalDocNo: row.approvalDocNo ?? null,
      consumedOrderId: row.consumedOrderId ?? null,
      consumedOrderNo: row.consumedOrderNo ?? null,
      createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
      reviewedAt: row.reviewedAt ? (row.reviewedAt instanceof Date ? row.reviewedAt : new Date(row.reviewedAt)) : null,
      consumedAt: row.consumedAt ? (row.consumedAt instanceof Date ? row.consumedAt : new Date(row.consumedAt)) : null,
    };
  }
}
