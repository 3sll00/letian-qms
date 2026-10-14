import { randomUUID } from 'node:crypto';
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
    /** 炉批号继承来源标记（docs/47 §3.6）：草稿暂存同样保留带出 / 人工来源 */
    inheritedFrom?: 'OUTSOURCE_HEAT_TREATMENT' | 'IQC_RAW_MATERIAL' | 'MANUAL_ENTRY';
    inheritedHeatValue?: number | string;
    isManuallyModified?: boolean;
    modificationReason?: string;
    /** 不解检（EXEMPT）标记：草稿暂存同样保留 */
    isExempt?: boolean;
    exemptReason?: string;
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
        // 同 record-measurements：未开检的工单有两类 —— 初始态 PENDING 的新建单，与 MRB 返工回边后的
        // 复检轮次 RE_INSPECTING（见 docs/21 §11）。聚合根只允许 INSPECTING / DRAFT 录入，
        // 故首次暂存草稿时按状态机允许的边推进（PENDING / RE_INSPECTING -> INSPECTING），再写入草稿实测值。
        const currentStatus = order.getStatus();
        if (currentStatus === 'PENDING' || currentStatus === 'RE_INSPECTING') {
          order.startInspection();
        }

        for (const item of cmd.items) {
          // 与 record-measurements 同口径：免检标记先落、后录实测值，
          // 免检行本身不携带实测值则跳过录入。
          if (item.isExempt !== undefined) {
            order.markItemExempt({
              itemCode: item.itemCode,
              isExempt: item.isExempt,
              ...(item.exemptReason !== undefined ? { exemptReason: item.exemptReason } : {}),
            });
          }
          if (item.isExempt === true) continue;
          order.recordItemMeasurement({
            itemCode: item.itemCode,
            ...(item.measuredVal !== undefined ? { measuredVal: item.measuredVal } : {}),
            ...(item.measuredText !== undefined ? { measuredText: item.measuredText } : {}),
            ...(item.inheritedFrom !== undefined ? { inheritedFrom: item.inheritedFrom } : {}),
            ...(item.inheritedHeatValue !== undefined
              ? { inheritedHeatValue: item.inheritedHeatValue }
              : {}),
            ...(item.isManuallyModified !== undefined
              ? { isManuallyModified: item.isManuallyModified }
              : {}),
            ...(item.modificationReason !== undefined
              ? { modificationReason: item.modificationReason }
              : {}),
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApplicationError('DRAFT_SAVE_FAILED', msg, 400);
      }

      const updatedOrderDto = order.toDTO();
      await ctx.inspectionOrders.save(updatedOrderDto);

      await ctx.auditLogs.insert({
        id: randomUUID(),
        traceId: securityCtx?.traceId ?? randomUUID(),
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
