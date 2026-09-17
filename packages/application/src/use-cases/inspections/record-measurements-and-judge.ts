import type {
  InspectionOrder as InspectionOrderDTO,
  BatchRecordInspectionItemsRequest,
} from '@letian/contracts';
import { InspectionOrder } from '@letian/domain';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface RecordMeasurementsAndJudgeCommand
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
  overallRemark?: string;
  operatorId: string;
  operatorName: string;
}

/**
 * 实测录入并执行综合判定用例
 * 若判定不合格，根据状态机规则自动触发后续处理与 Outbox 事件
 */
export class RecordMeasurementsAndJudgeUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: RecordMeasurementsAndJudgeCommand,
    securityCtx?: ISecurityContext
  ): Promise<InspectionOrderDTO> {
    return await this.uow.execute(async (ctx) => {
      const orderDto = await ctx.inspectionOrders.findById(cmd.orderId);
      if (!orderDto) {
        throw new ApplicationError('ORDER_NOT_FOUND', `未找到检验工单 [${cmd.orderId}]`, 404);
      }

      // 排他事务锁：防止同一批次或工单并发录入判定（直接读 DTO 字段）
      await ctx.locks.acquireXactLock(`LOCK_ORDER_${orderDto.batchNo}`);

      if (securityCtx) {
        securityCtx.assertAccess({
          targetCategory: 'STANDARD_PARTS',
          targetMaterialCode: orderDto.materialCode,
          ...(orderDto.supplierCode !== undefined ? { targetSupplierCode: orderDto.supplierCode } : {}),
        });
      }

      // 需要执行领域行为：包装为聚合根
      // 契约 DTO 未包含批量总数，domain 构造必填，以 sampleQty 占位（sampleQty 恒存在，不影响流程计算与输出）
      const order = new InspectionOrder({
        ...orderDto,
        id: orderDto.id ?? cmd.orderId,
        batchQty: orderDto.sampleQty,
      });

      try {
        // 0. 首次录入实测值即代表"开始检验"：聚合根只允许 INSPECTING / DRAFT 录入，
        //    而新建工单初始态是 PENDING，此处按状态机允许的 PENDING -> INSPECTING 边推进，
        //    否则新建工单永远无法进入录入与判定流程。
        if (order.getStatus() === 'PENDING') {
          order.startInspection();
        }

        // 1. 编排批量录入实测值：逐个调用聚合根原子能力
        for (const item of cmd.items) {
          order.recordItemMeasurement({
            itemCode: item.itemCode,
            ...(item.measuredVal !== undefined ? { measuredVal: item.measuredVal } : {}),
            ...(item.measuredText !== undefined ? { measuredText: item.measuredText } : {}),
          });
        }

        // 2. 触发终检判定原子能力
        order.submitAndEvaluate();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApplicationError('JUDGEMENT_FAILED', msg, 400);
      }

      // 3. 导出 DTO 持久化
      const updatedOrderDto = order.toDTO();
      await ctx.inspectionOrders.save(updatedOrderDto);

      const status = order.getStatus();
      const decision = order.getOverallDecision();

      // 4. 发送领域事件到 Outbox
      await ctx.outbox.append({
        id: crypto.randomUUID(),
        aggregateType: 'InspectionOrder',
        aggregateId: order.getId(),
        eventType: decision === 'PASSED' ? 'INSPECTION_PASSED' : 'INSPECTION_FAILED',
        payload: {
          orderId: order.getId(),
          orderNo: order.getOrderNo(),
          batchNo: order.getBatchNo(),
          decision: decision,
          status: status,
          failedItems: order
            .getItems()
            .filter((it) => it.result === 'FAILED')
            .map((it) => ({
              itemCode: it.itemCode,
              name: it.name,
              ...(it.measuredVal !== undefined ? { measuredVal: it.measuredVal } : {}),
            })),
        },
        traceId: crypto.randomUUID(),
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 0,
      });

      // 5. 不可变审计日志
      await ctx.auditLogs.insert({
        id: crypto.randomUUID(),
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        userId: cmd.operatorId,
        userName: cmd.operatorName,
        action: 'STATUS_CHANGE',
        resourceType: 'INSPECTION_ORDER',
        resourceId: order.getId(),
        status: 'SUCCESS',
        diffPatch: {
          decision,
          status,
          itemCount: cmd.items.length,
          ...(cmd.overallRemark !== undefined ? { remark: cmd.overallRemark } : {}),
        },
        createdAt: new Date().toISOString(),
      });

      return order.toDTO();
    });
  }
}
