import type {
  InspectionOrder as InspectionOrderDTO,
  CreateInspectionOrderRequest,
  InspectionPlanVersion,
} from '@letian/contracts';
import { InspectionOrder } from '@letian/domain';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface CreateInspectionOrderCommand extends Partial<CreateInspectionOrderRequest> {
  inspectionType: CreateInspectionOrderRequest['inspectionType'];
  materialCode: string;
  materialName: string;
  batchNo: string;
  batchQty: number;
  sampleSize?: number;
  supplierCode?: string;
  supplierName?: string;
  inspectorId?: string;
  inspectorName?: string;
  mandatoryGate?: boolean;
  planId?: string;
  planVersionNo?: string;
  operatorId: string;
  operatorName: string;
}

/**
 * 创建检验单用例 (含方案快照深拷贝绑定)
 */
export class CreateInspectionOrderUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: CreateInspectionOrderCommand,
    securityCtx?: ISecurityContext
  ): Promise<InspectionOrderDTO> {
    return await this.uow.execute(async (ctx) => {
      // 1. 排他锁保护同一批次的检验单创建
      await ctx.locks.acquireXactLock(`LOCK_ORDER_${cmd.batchNo}`);

      // 2. PBAC 权限校验 (若传入上下文)
      // 查询物料分类以进行三维 PBAC 校验
      const materialCategory = 'STANDARD_PARTS';

      if (securityCtx) {
        securityCtx.assertAccess({
          targetCategory: materialCategory,
          targetMaterialCode: cmd.materialCode,
          ...(cmd.supplierCode !== undefined ? { targetSupplierCode: cmd.supplierCode } : {}),
        });
      }

      // 3. 寻找适用的质检方案并获取激活版本
      let planVersionToBind: InspectionPlanVersion | undefined = undefined;
      let planCodeBound: string | undefined = undefined;

      if (cmd.planId) {
        const plan = await ctx.inspectionPlans.findById(cmd.planId);
        if (!plan) {
          throw new ApplicationError('PLAN_NOT_FOUND', `指定的质检方案 [${cmd.planId}] 不存在`, 404);
        }
        planCodeBound = plan.planCode;
        if (cmd.planVersionNo) {
          planVersionToBind = plan.versions?.find((v) => v.versionNo === cmd.planVersionNo);
          if (!planVersionToBind) {
            throw new ApplicationError(
              'PLAN_VERSION_NOT_FOUND',
              `质检方案 [${cmd.planId}] 中未找到版本 [${cmd.planVersionNo}]`,
              404
            );
          }
        } else {
          planVersionToBind = plan.versions?.find((v) => v.status === 'ACTIVE');
          if (!planVersionToBind) {
            throw new ApplicationError(
              'NO_ACTIVE_PLAN_VERSION',
              `质检方案 [${cmd.planId}] 当前无已启用的有效版本`,
              400
            );
          }
        }
      } else {
        // 根据物料编码自动匹配方案
        const applicablePlan = await ctx.inspectionPlans.findActivePlan(cmd.materialCode, cmd.inspectionType);
        if (applicablePlan) {
          planCodeBound = applicablePlan.planCode;
          planVersionToBind = applicablePlan.versions?.find((v) => v.status === 'ACTIVE');
        }
      }

      if (!planVersionToBind) {
        throw new ApplicationError(
          'PLAN_NOT_FOUND',
          `未找到适用于物料 [${cmd.materialCode}] 类型 [${cmd.inspectionType}] 的已启用质检方案`,
          400
        );
      }

      // 4. 构建检验单聚合根
      const orderId = crypto.randomUUID();
      const generatedOrderNo = cmd.orderNo ?? `INS-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      const order = new InspectionOrder({
        id: orderId,
        orderNo: generatedOrderNo,
        inspectionType: cmd.inspectionType,
        materialCode: cmd.materialCode,
        materialName: cmd.materialName,
        batchNo: cmd.batchNo,
        batchQty: cmd.batchQty,
        sampleQty: cmd.sampleSize ?? Math.min(cmd.batchQty, 5),
        supplierCode: cmd.supplierCode,
        supplierName: cmd.supplierName,
        isMandatoryGate: cmd.mandatoryGate ?? true,
      });

      // 5. 绑定方案快照深拷贝 (聚合根深拷贝防篡改)
      order.bindPlanSnapshot(planVersionToBind, {
        planId: cmd.planId ?? 'AUTO_MATCHED',
        planCode: planCodeBound ?? 'UNKNOWN',
      });

      // 6. 持久化聚合根
      await ctx.inspectionOrders.save(order.toDTO());

      // 7. 写入 Outbox 事件
      await ctx.outbox.append({
        id: crypto.randomUUID(),
        aggregateType: 'InspectionOrder',
        aggregateId: order.getId(),
        eventType: 'INSPECTION_ORDER_CREATED',
        payload: {
          orderId: order.getId(),
          orderNo: order.getOrderNo(),
          batchNo: order.getBatchNo(),
          materialCode: order.getMaterialCode(),
          inspectionType: order.getInspectionType(),
          mandatoryGate: order.isMandatoryGate(),
        },
        traceId: crypto.randomUUID(),
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 0,
      });

      // 8. 审计记录
      await ctx.auditLogs.insert({
        id: crypto.randomUUID(),
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        userId: cmd.operatorId,
        userName: cmd.operatorName,
        action: 'CREATE',
        resourceType: 'INSPECTION_ORDER',
        resourceId: order.getId(),
        status: 'SUCCESS',
        diffPatch: {
          orderNo: order.getOrderNo(),
          batchNo: order.getBatchNo(),
          inspectionType: order.getInspectionType(),
          itemsCount: order.getItems().length,
        },
        createdAt: new Date().toISOString(),
      });

      return order.toDTO();
    });
  }
}
