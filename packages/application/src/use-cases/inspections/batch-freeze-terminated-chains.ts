import { randomUUID } from 'node:crypto';
import { IUnitOfWork } from '../../tx/unit-of-work.js';
import { ISecurityContext } from '../../security/security-context.js';

export interface BatchFreezeTerminatedChainsCommand {
  batchNo?: string;
  dryRun?: boolean;
}

export interface FrozenOrderResult {
  orderId: string;
  orderNo: string;
  batchNo: string;
  inspectionType: string;
  sourceMrbNo: string;
  disposition: string;
  status: string;
}

export interface BatchFreezeTerminatedChainsResult {
  dryRun: boolean;
  scannedMrbCount: number;
  terminatedChainsCount: number;
  frozenOrdersCount: number;
  frozenOrders: FrozenOrderResult[];
  executedAt: string;
}

export class BatchFreezeTerminatedChainsUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: BatchFreezeTerminatedChainsCommand,
    securityCtx?: ISecurityContext
  ): Promise<BatchFreezeTerminatedChainsResult> {
    return this.uow.execute(async (ctx) => {
      // 1. 查询所有退货(RETURN_TO_VENDOR)或报废(SCRAP)的 MRB 评审单
      const terminatedReviews = await ctx.mrbReviews.findTerminatedReviews(cmd.batchNo);

      const frozenOrders: FrozenOrderResult[] = [];
      const visitedOrderIds = new Set<string>();

      for (const review of terminatedReviews) {
        if (!review.batchNo) continue;

        // 2. 查该批次下的所有检验单
        const candidateOrders = await ctx.inspectionOrders.findByBatchNo(review.batchNo);

        for (const order of candidateOrders) {
          if (!order.id) continue;
          const orderId = order.id;
          const status = order.status;
          // 只针对待检(PENDING)、检验中(INSPECTING)、草稿(DRAFT)单据执行安全冻结打标
          if (
            (status === 'PENDING' || status === 'INSPECTING' || status === 'DRAFT') &&
            !visitedOrderIds.has(orderId)
          ) {
            visitedOrderIds.add(orderId);
            frozenOrders.push({
              orderId,
              orderNo: order.orderNo,
              batchNo: order.batchNo,
              inspectionType: order.inspectionType,
              sourceMrbNo: review.mrbNo ?? '',
              disposition: review.disposition ?? 'TERMINATED',
              status,
            });

            if (!cmd.dryRun) {
              const freezeNote = `[链路已终止：上游 MRB-${review.mrbNo} 处置判定 ${review.disposition}，已追加冻结备注；单据状态未变更，仍可录入]`;
              // 幂等口径（docs/48 §8 P2②「幂等执行」）：同一 MRB 的冻结标记已写入过就跳过备注与审计，
              // 重复执行只报告结果、不产生重复痕迹（备注是追加式，不去重会越滚越长）。
              const alreadyFrozen = (order.inspectionNotes ?? '').includes(
                `链路已终止：上游 MRB-${review.mrbNo}`
              );
              if (!alreadyFrozen) {
                await ctx.inspectionOrders.appendNotes(orderId, freezeNote);

                await ctx.auditLogs.insert({
                  id: randomUUID(),
                  traceId: securityCtx?.traceId ?? randomUUID(),
                  userId: securityCtx?.userId ?? '00000000-0000-0000-0000-000000000000',
                  userName: securityCtx?.userName ?? '系统批处理',
                  action: 'STATUS_CHANGE',
                  resourceType: 'INSPECTION_ORDER',
                  resourceId: orderId,
                  status: 'SUCCESS',
                  diffPatch: {
                    frozen: true,
                    chainTerminated: true,
                    sourceMrbNo: review.mrbNo,
                    disposition: review.disposition,
                    noteAppended: true,
                    statusUnchanged: status,
                  },
                  createdAt: new Date().toISOString(),
                });
              }
            }
          }
        }
      }

      return {
        dryRun: Boolean(cmd.dryRun),
        scannedMrbCount: terminatedReviews.length,
        terminatedChainsCount: new Set(terminatedReviews.map((r) => r.batchNo)).size,
        frozenOrdersCount: frozenOrders.length,
        frozenOrders,
        executedAt: new Date().toISOString(),
      };
    });
  }
}
