import type {
  InspectionOrder as InspectionOrderDTO,
} from '@letian/contracts';
import { InspectionOrder } from '@letian/domain';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface CreateReinspectionCommand {
  parentOrderId: string;
  originalOrderId?: string;
  reworkRecordNo?: string;
  reworkReason?: string;
  inspectorId?: string;
  inspectorName?: string;
  operatorId: string;
  operatorName?: string;
}

/**
 * 复检用例（返工回边业务流）
 * 承接返工后批次，自动绑定原检验单的质检方案快照，生成次轮复检工单并建立追溯关联
 */
export class CreateReinspectionUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: CreateReinspectionCommand,
    securityCtx?: ISecurityContext
  ): Promise<InspectionOrderDTO> {
    return await this.uow.execute(async (ctx) => {
      // 1. 获取原工单
      const targetOrderId = cmd.parentOrderId || cmd.originalOrderId;
      if (!targetOrderId) {
        throw new ApplicationError('INVALID_ORDER_ID', '未指定复检原始工单 ID', 400);
      }
      const origOrder = await ctx.inspectionOrders.findById(targetOrderId);
      if (!origOrder) {
        throw new ApplicationError('ORIGINAL_ORDER_NOT_FOUND', `未找到原始检验单 [${targetOrderId}]`, 404);
      }

      // 排他事务锁
      await ctx.locks.acquireXactLock(`LOCK_ORDER_${origOrder.batchNo}`);

      if (securityCtx) {
        securityCtx.assertAccess({
          targetCategory: 'STANDARD_PARTS',
          targetMaterialCode: origOrder.materialCode,
          ...(origOrder.supplierCode !== undefined ? { targetSupplierCode: origOrder.supplierCode } : {}),
        });
      }

      // 原工单状态检查：通常是 FAILED 或在 MRB 流程中被判定为返工处置
      if (origOrder.status !== 'FAILED' && origOrder.status !== 'IN_MRB_REVIEW') {
        throw new ApplicationError(
          'INVALID_ORDER_STATE_FOR_REINSPECTION',
          `只有状态为 FAILED 或 IN_MRB_REVIEW 的工单方可创建复检单，当前为 [${origOrder.status}]`,
          400
        );
      }

      const origDTO = origOrder;
      if (!origDTO.planSnapshot) {
        throw new ApplicationError(
          'NO_PLAN_SNAPSHOT',
          `原检验工单缺少质检方案快照，无法生成复检单`,
          400
        );
      }

      // 2. 检查现有复检轮次
      const batchOrders = await ctx.inspectionOrders.findByBatchNo(origOrder.batchNo);
      const nextRound = batchOrders.length + 1;
      const reinspectionOrderNo = `${origOrder.orderNo}-R${nextRound}`;

      // 3. 构建新的复检单聚合根
      const newOrderId = crypto.randomUUID();
      const reinspectionOrder = new InspectionOrder({
        id: newOrderId,
        orderNo: reinspectionOrderNo,
        inspectionType: origOrder.inspectionType,
        materialCode: origOrder.materialCode,
        materialName: origOrder.materialName,
        batchNo: origOrder.batchNo,
        batchQty: origDTO.sampleQty,
        sampleQty: origDTO.sampleQty,
        supplierCode: origOrder.supplierCode,
        isMandatoryGate: origOrder.isMandatoryGate,
      });

      // 4. 深拷贝原方案快照绑定
      reinspectionOrder.bindPlanSnapshot(
        {
          planId: origDTO.planSnapshot.planId,
          versionNo: origDTO.planSnapshot.versionNo,
          status: 'ACTIVE',
          samplingScheme: origDTO.planSnapshot.samplingScheme,
          aqlLevel: origDTO.planSnapshot.aqlLevel,
          strictness: origDTO.planSnapshot.strictness,
          items: origDTO.planSnapshot.items.map((it) => ({ ...it })),
          createdBy: '',
        },
        {
          planId: origDTO.planSnapshot.planId,
          planCode: origDTO.planSnapshot.planCode,
          planName: origDTO.planSnapshot.planName,
        }
      );

      // 5. 原单状态推进为复检中，并保存复检聚合根
      await ctx.inspectionOrders.updateStatus(origDTO.id ?? targetOrderId, 'RE_INSPECTING');
      await ctx.inspectionOrders.save(reinspectionOrder.toDTO());

      // 6. 在追溯 DAG 中建立返工与复检的拓扑关联边
      await ctx.traceDags.saveEdge({
        sourceBatchNo: `${origOrder.orderNo}:FAIL`,
        targetBatchNo: reinspectionOrder.getOrderNo(),
        relationType: 'PROCESS_TO_PROCESS',
        depth: 1,
        isCycle: false,
        hasCycleWarning: false,
      });

      // 7. 发送复检触发事件到 Outbox
      await ctx.outbox.append({
        id: crypto.randomUUID(),
        aggregateType: 'InspectionOrder',
        aggregateId: reinspectionOrder.getId(),
        eventType: 'REINSPECTION_ORDER_CREATED',
        payload: {
          orderId: reinspectionOrder.getId(),
          orderNo: reinspectionOrder.getOrderNo(),
          originalOrderId: origDTO.id ?? targetOrderId,
          originalOrderNo: origOrder.orderNo,
          batchNo: reinspectionOrder.getBatchNo(),
          round: nextRound,
          reworkRecordNo: cmd.reworkRecordNo,
        },
        traceId: crypto.randomUUID(),
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 0,
      });

      // 8. 记录不可变审计日志
      await ctx.auditLogs.insert({
        id: crypto.randomUUID(),
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        userId: cmd.operatorId,
        userName: cmd.operatorName ?? cmd.operatorId,
        action: 'CREATE',
        resourceType: 'INSPECTION_ORDER',
        resourceId: reinspectionOrder.getId(),
        status: 'SUCCESS',
        diffPatch: {
          originalOrderId: origDTO.id ?? targetOrderId,
          round: nextRound,
          orderNo: reinspectionOrder.getOrderNo(),
          batchNo: reinspectionOrder.getBatchNo(),
          reworkReason: cmd.reworkReason,
        },
        createdAt: new Date().toISOString(),
      });

      return reinspectionOrder.toDTO();
    });
  }
}
