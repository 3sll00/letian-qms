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
        // 从物料主数据解析真实分类；查不到时 UNKNOWN 不命中任何白名单（fail-closed）
        const material = await ctx.materials.getMaterialByCode(origOrder.materialCode);
        securityCtx.assertAccess({
          targetCategory: material?.categoryCode ?? 'UNKNOWN',
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
        // 规格型号 / 计量单位沿用原单快照：复检针对同一批物料，规格不应变化，
        // 且原单快照本身取自存货档案，比重新回查更稳定（与 supplierName 同口径）。
        // 历史断链：此前只透传 materialName，复检单的「规格型号」列必然是空的。
        ...(origOrder.specification !== undefined ? { specification: origOrder.specification } : {}),
        ...(origOrder.unit !== undefined ? { unit: origOrder.unit } : {}),
        batchNo: origOrder.batchNo,
        batchQty: origDTO.sampleQty,
        sampleQty: origDTO.sampleQty,
        // 台账「数量」列（报检批量 total_qty）沿承原单：复检针对同一批次，批量不因复检而归零。
        // 此前复检单该列为 NULL，台账「数量」显示 --（见 docs/29 §5.3）。
        ...(origDTO.totalQty !== undefined ? { totalQty: origDTO.totalQty } : {}),
        supplierCode: origOrder.supplierCode,
        // 复检单沿用原单的「供应商」名称快照：原单名称来自建单时的供应商主数据，
        // 这里不重新回查，保证复检单与原单的供应商展示口径完全一致
        ...(origOrder.supplierName !== undefined ? { supplierName: origOrder.supplierName } : {}),
        // 单据标识快照整体沿承（入库单号/入库日期、客户/销售出库、委外工艺等台账列）：
        // 复检对象与原单是「同一批来料、同一张出入库单据」，这些列描述的是批次的来源凭证，
        // 不因返工复检而改变，必须与原单逐字段一致（与 supplierName 同口径，均不回查主数据）。
        // 历史断链：此前这里既不透传 inboundNo/inboundDate，也不透传 OQC 台账列，复检行在
        // 来料检验台账的「入库单号 / 入库日期」永远是 `-`（见 docs/26 §5.2）。
        ...(origOrder.inboundNo !== undefined ? { inboundNo: origOrder.inboundNo } : {}),
        ...(origOrder.inboundDate !== undefined ? { inboundDate: origOrder.inboundDate } : {}),
        ...(origOrder.customerCode !== undefined ? { customerCode: origOrder.customerCode } : {}),
        ...(origOrder.customerName !== undefined ? { customerName: origOrder.customerName } : {}),
        ...(origOrder.salesOrderNo !== undefined ? { salesOrderNo: origOrder.salesOrderNo } : {}),
        ...(origOrder.dispatchDate !== undefined ? { dispatchDate: origOrder.dispatchDate } : {}),
        ...(origOrder.salesOrderPoNo !== undefined ? { salesOrderPoNo: origOrder.salesOrderPoNo } : {}),
        ...(origOrder.erpStatus !== undefined ? { erpStatus: origOrder.erpStatus } : {}),
        ...(origOrder.processType !== undefined ? { processType: origOrder.processType } : {}),
        ...(origOrder.vendorName !== undefined ? { vendorName: origOrder.vendorName } : {}),
        // 委外加工单号 / 回厂日期：沿承原单的真实列值（仅当原单确有值时复制）。
        // 原口径「刻意不沿承」的依据是「读侧 mapRow 会回落 batchNo / 建单日期」，该兜底已于
        // 2026-09-22 废止（见 docs/32 §2.2 与 docs/36 §1.2）：兜底不存在后，不沿承的直接后果是
        // 复检行的「委外加工单号 / 回厂日期」恒为空，而这两列描述的是批次来源凭证
        // （与 inboundNo / dispatchDate 同性质），不因返工复检而改变。
        ...(origOrder.outsourceNo !== undefined ? { outsourceNo: origOrder.outsourceNo } : {}),
        ...(origOrder.returnDate !== undefined ? { returnDate: origOrder.returnDate } : {}),
        // 030 录入页业务事实字段：材质牌号 / 执行技术标准同为「本批工件的事实」，复检沿承；
        // 检验日期不沿承 —— 复检是新的检验周期，沿承原单检验日期等于伪造（与 inspectorName 同口径）
        ...(origOrder.materialGrade !== undefined ? { materialGrade: origOrder.materialGrade } : {}),
        ...(origOrder.techStandard !== undefined ? { techStandard: origOrder.techStandard } : {}),
        isMandatoryGate: origOrder.isMandatoryGate,
        // 复检轮的「检验人」由调用方指定：复检是新的检验周期，沿承原单检验人等于伪造，
        // 未传时保持 undefined，由读侧按员工主数据补齐（见 docs/30 §3）
        ...(cmd.inspectorId !== undefined ? { inspectorId: cmd.inspectorId } : {}),
        ...(cmd.inspectorName !== undefined ? { inspectorName: cmd.inspectorName } : {}),
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
