import type { 
  PendingDefectItem, 
  InitiateReviewRequest,
  MRBReview
} from '@letian/contracts';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';
import type { ISecurityContext } from '../../security/security-context.js';
import { NotFoundError, ConflictError } from '../../errors/application-error.js';
import { TriggerMrbReviewUseCase } from './trigger-mrb-review.js';

export interface PendingPoolQuery {
  stage?: string | undefined;
  sourceStage?: string | undefined;
  inspectionType?: string | undefined;
  materialCode?: string | undefined;
  batchNo?: string | undefined;
  status?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface InitiateReviewResult extends MRBReview {
  mrbId: string;
  reviewNo: string;
  success: boolean;
  message: string;
}

export class PendingMRBPoolUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async getPendingList(
    query: PendingPoolQuery,
    security?: ISecurityContext
  ): Promise<{ items: PendingDefectItem[]; total: number }> {
    return await this.uow.execute(async (ctx) => {
      let pendingItems: PendingDefectItem[] = [];

      // 1. 若底层存在专门的 pendingMrbItems 扩展表，优先读取
      if ((ctx as any).db) {
        try {
          let qb = (ctx as any).db.selectFrom('pendingMrbItems').selectAll();
          const targetStage = query.inspectionType ?? query.sourceStage ?? query.stage;
          if (targetStage) {
            qb = qb.where('sourceStage', '=', targetStage);
          }
          if (query.status) {
            qb = qb.where('status', '=', query.status);
          }
          if (query.materialCode) {
            qb = qb.where('materialCode', 'like', `%${query.materialCode}%`);
          }
          if (query.batchNo) {
            qb = qb.where('batchNo', 'like', `%${query.batchNo}%`);
          }
          const rows = await qb.execute();
          if (rows && rows.length > 0) {
            pendingItems = rows.map((r: any) => ({
              id: r.id,
              inspectionOrderId: r.sourceOrderId,
              orderNo: r.sourceOrderNo,
              inspectionType: r.sourceStage,
              batchNo: r.batchNo,
              materialCode: r.materialCode,
              materialName: r.materialName,
              defectQty: Number(r.defectQty ?? 1),
              totalQty: Number(r.totalQty ?? r.defectQty ?? 1),
              defectDescription: r.failReason ?? '实测超出公差判定不合格',
              status: (r.status === 'REVIEWING' || r.status === 'INITIATED' ? 'INITIATED' : 'PENDING_INITIATE') as any,
              mrbId: r.mrbReviewId ?? undefined,
              createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
            }));
          }
        } catch {
          // ignore if table doesn't exist
        }
      }

      // 2. 汇集各环节未发起评审的不合格检验工单 (status = 'FAILED')
      if (pendingItems.length === 0) {
        let orderList: any[] = [];
        if (typeof (ctx.inspectionOrders as any).listOrders === 'function') {
          const res = await (ctx.inspectionOrders as any).listOrders({
            inspectionType: query.inspectionType ?? query.sourceStage ?? query.stage,
            materialCode: query.materialCode,
            batchNo: query.batchNo,
            status: query.status === 'INITIATED' ? 'IN_MRB_REVIEW' : 'FAILED',
            page: 1,
            pageSize: 100,
          });
          orderList = res.list ?? res.items ?? [];
        }

        pendingItems = orderList
          .filter((order: any) => {
            if (query.status === 'INITIATED') return order.status === 'IN_MRB_REVIEW';
            if (query.status === 'PENDING_INITIATE') return order.status === 'FAILED';
            return order.status === 'FAILED';
          })
          .map((order: any) => {
            const items = order.items ?? [];
            const failedItem = items.find((i: any) => i.judgment === 'FAILED' || i.verdict === 'FAILED');
            const defectQty = Number(order.failQty ?? 1);
            const totalQty = Number(order.totalQty ?? order.sampleQty ?? defectQty);

            return {
              id: order.id,
              inspectionOrderId: order.id,
              orderNo: order.orderNo,
              inspectionType: order.inspectionType ?? 'IQC',
              batchNo: order.batchNo,
              materialCode: order.materialCode,
              materialName: order.materialName,
              defectQty,
              totalQty,
              defectDescription: order.inspectionNotes || (failedItem ? `${failedItem.name ?? failedItem.itemCode} 超差判定不合格` : '实测超出公差判定不合格'),
              defectItemCode: failedItem?.itemCode,
              status: order.status === 'IN_MRB_REVIEW' ? ('INITIATED' as const) : ('PENDING_INITIATE' as const),
              inspectorId: order.inspectorId,
              inspectorName: order.inspectorName,
              createdAt: order.createdAt instanceof Date ? order.createdAt.toISOString() : String(order.createdAt),
            };
          });
      }

      // 3. PBAC 权限过滤
      if (security) {
        pendingItems = pendingItems.filter((item) => {
          try {
            security.assertAccess({
              targetCategory: 'MATERIAL',
              targetMaterialCode: item.materialCode,
              operationName: '查看不合格待审核池',
            });
            return true;
          } catch {
            return false;
          }
        });
      }

      const total = pendingItems.length;
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 20;
      const paginated = pendingItems.slice((page - 1) * pageSize, page * pageSize);

      return { items: paginated, total };
    });
  }

  public async initiateReview(
    input: InitiateReviewRequest,
    operator?: { userId: string; userName?: string; name?: string },
    security?: ISecurityContext
  ): Promise<InitiateReviewResult> {
    return await this.uow.execute(async (ctx) => {
      // 1. 定位源检验单
      let order = await ctx.inspectionOrders.findById(input.pendingDefectId);
      if (!order && (ctx as any).db) {
        try {
          const pendingRow = await (ctx as any).db
            .selectFrom('pendingMrbItems')
            .where('id', '=', input.pendingDefectId)
            .selectAll()
            .executeTakeFirst();
          if (pendingRow) {
            order = await ctx.inspectionOrders.findById(pendingRow.sourceOrderId);
          }
        } catch {
          // ignore
        }
      }
      if (!order) {
        order = await ctx.inspectionOrders.findByOrderNo(input.pendingDefectId);
      }
      if (!order) {
        throw new NotFoundError(`待审核条目或源检验单未找到: ${input.pendingDefectId}`);
      }

      const orderDTO = order;
      if (orderDTO.status === 'IN_MRB_REVIEW') {
        throw new ConflictError(`检验单 ${orderDTO.orderNo} 已处于 MRB 评审中，不可重复发起`);
      }

      // 2. 委托 TriggerMrbReviewUseCase 完成强校验与工单生成
      const opId = operator?.userId ?? 'system';
      const opName = operator?.userName ?? operator?.name ?? '质量工程师';
      const trigger = new TriggerMrbReviewUseCase(this.uow);
      const mrb = await trigger.execute(
        {
          inspectionOrderId: orderDTO.id ?? input.pendingDefectId,
          applicantId: opId,
          applicantName: opName,
          reason: input.reviewNotes ?? `从待审核池发起评审: 检验单 ${orderDTO.orderNo} 判定不合格`,
        },
        security
      );

      // 3. 若有 pendingMrbItems 记录，同步更新状态
      if ((ctx as any).db) {
        try {
          await (ctx as any).db
            .updateTable('pendingMrbItems')
            .set({
              status: 'INITIATED',
              mrbReviewId: mrb.id,
              reviewStartedAt: new Date(),
              reviewStartedBy: opName,
            })
            .where((eb: any) =>
              eb.or([
                eb('id', '=', input.pendingDefectId),
                eb('sourceOrderId', '=', orderDTO.id ?? input.pendingDefectId),
              ])
            )
            .execute();
        } catch {
          // ignore
        }
      }

      return {
        ...mrb,
        mrbId: mrb.id,
        reviewNo: mrb.mrbNo,
        success: true,
        message: `已成功从待审核池发起独立评审工单 [${mrb.mrbNo}]`,
      };
    });
  }
}
