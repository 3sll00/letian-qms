import type {
  InspectionOrder as InspectionOrderDTO,
  BatchRecordInspectionItemsRequest,
} from '@letian/contracts';
import { InspectionOrder } from '@letian/domain';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface SaveInspectionDraftCommand
  extends Partial<BatchRecordInspectionItemsRequest> {
  orderId: string;
  items: Array<{
    itemCode: string;
    measuredVal?: number;
    measuredText?: string;
    defectReason?: string;
    remark?: string;
    inspectorRemark?: string;
  }>;
  inspectorRemark?: string;
  operatorId: string;
  operatorName: string;
}

/**
 * 检验草稿暂存用例
 */
export class SaveInspectionDraftUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: SaveInspectionDraftCommand,
    securityCtx?: ISecurityContext
  ): Promise<InspectionOrderDTO> {
    return await this.uow.execute(async (ctx) => {
      const orderDto = await ctx.inspectionOrders.findById(cmd.orderId);
      if (!orderDto) {
        throw new ApplicationError('ORDER_NOT_FOUND', `未找到检验单 [${cmd.orderId}]`, 404);
      }

      if (securityCtx) {
        // 从物料主数据解析真实分类；查不到时 UNKNOWN 不命中任何白名单（fail-closed）
        const material = await ctx.materials.getMaterialByCode(orderDto.materialCode);
        securityCtx.assertAccess({
          targetCategory: material?.categoryCode ?? 'UNKNOWN',
          targetMaterialCode: orderDto.materialCode,
          ...(orderDto.supplierCode !== undefined ? { targetSupplierCode: orderDto.supplierCode } : {}),
        });
      }

      // 草稿只更新实测值并转为 INSPECTING 状态，不完成终判
      if (
        orderDto.status === 'PASSED' ||
        orderDto.status === 'FAILED' ||
        orderDto.status === 'IN_MRB_REVIEW'
      ) {
        throw new ApplicationError(
          'ORDER_IMMUTABLE',
          `检验单当前处于终态 [${orderDto.status}]，无法保存草稿`,
          400
        );
      }

      const order = new InspectionOrder({
        ...orderDto,
        id: orderDto.id ?? cmd.orderId,
        // 契约 DTO 未包含批量总数，domain 构造必填；sampleQty 恒存在，该占位值不影响任何流程计算与输出
        batchQty: orderDto.sampleQty,
        // 草稿由谁暂存，谁就是该工单的检验人（与提交实测值保持同一口径）
        inspectorId: cmd.operatorId,
        inspectorName: cmd.operatorName,
      });

      try {
        // 同 record-measurements：新建工单初始态为 PENDING，聚合根只允许 INSPECTING / DRAFT 录入，
        // 因此首次暂存草稿时按状态机允许的 PENDING -> INSPECTING 边推进，再写入草稿实测值。
        if (order.getStatus() === 'PENDING') {
          order.startInspection();
        }

        for (const item of cmd.items) {
          order.recordItemMeasurement({
            itemCode: item.itemCode,
            ...(item.measuredVal !== undefined ? { measuredVal: item.measuredVal } : {}),
            ...(item.measuredText !== undefined ? { measuredText: item.measuredText } : {}),
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApplicationError('DRAFT_SAVE_FAILED', msg, 400);
      }

      const updatedOrderDto = order.toDTO();
      await ctx.inspectionOrders.save(updatedOrderDto);

      await ctx.auditLogs.insert({
        id: crypto.randomUUID(),
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        userId: cmd.operatorId,
        userName: cmd.operatorName,
        action: 'UPDATE',
        resourceType: 'INSPECTION_ORDER',
        resourceId: order.getId(),
        status: 'SUCCESS',
        diffPatch: {
          itemsUpdated: cmd.items.length,
          status: order.getStatus(),
        },
        createdAt: new Date().toISOString(),
      });

      return updatedOrderDto;
    });
  }
}
