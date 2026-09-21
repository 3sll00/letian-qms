import type {
  InspectionOrder as InspectionOrderDTO,
  CreateInspectionOrderRequest,
  InspectionPlanVersion,
} from '@letian/contracts';
import {
  InspectionOrder,
  formatInspectionOrderNo,
  resolveInspectionOrderNoPrefix,
  toInspectionOrderNoDayKey,
} from '@letian/domain';
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
  /** 009 委外检验 (OQC 七分类) 台账字段 */
  outsourceNo?: string;
  processType?: string;
  returnDate?: string;
  vendorName?: string;
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
      // 从物料主数据解析真实分类编码；查不到时按 UNKNOWN 处理（任何白名单规则都不会命中，fail-closed）
      const material = await ctx.materials.getMaterialByCode(cmd.materialCode);
      const materialCategory = material?.categoryCode ?? 'UNKNOWN';

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
      // 检验单号：调用方显式传入时以其为准（兼容 ERP/MES 下发的外部单号与存量历史数据）；
      // 未传时按领域编号规则 `{PREFIX}-{YYYYMMDD}-{NNNN}` 申请当日流水号
      // （出货检验 OQC_SH => `OQC-SH-20260706-0001`）。
      // 取号在 UoW 事务内原子完成，并发建单不重号；事务回滚则流水号一并回滚（见迁移 012）。
      let generatedOrderNo = cmd.orderNo;
      if (!generatedOrderNo) {
        const now = new Date();
        const dayKey = toInspectionOrderNoDayKey(now);
        const seq = await ctx.inspectionOrders.allocateOrderNoSequence(
          resolveInspectionOrderNoPrefix(cmd.inspectionType),
          dayKey
        );
        generatedOrderNo = formatInspectionOrderNo(cmd.inspectionType, dayKey, seq);
      }

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
        // 006 来料检验 (IQC) 采购入库/规格字段：由请求体透传（create 契约已声明），
        // specification 缺省时回落到契约别名 spec，保证只传一个字段也能落库
        receiptNo: cmd.receiptNo,
        receiptDate: cmd.receiptDate,
        specification: cmd.specification ?? cmd.spec,
        unit: cmd.unit,
        // 008 出货检验 (OQC_SH) 销售出库台账字段：由请求体透传（create 契约已声明）
        customerName: cmd.customerName,
        salesOrderNo: cmd.salesOrderNo,
        dispatchDate: cmd.dispatchDate,
        salesOrderPoNo: cmd.salesOrderPoNo,
        erpStatus: cmd.erpStatus,
        outsourceNo: cmd.outsourceNo,
        processType: cmd.processType,
        returnDate: cmd.returnDate,
        vendorName: cmd.vendorName,
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
