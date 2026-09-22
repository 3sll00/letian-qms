import type {
  InspectionOrder as InspectionOrderDTO,
  CreateInspectionOrderRequest,
  InspectionPlanVersion,
} from '@letian/contracts';
import { ErrorCode } from '@letian/contracts';
import {
  InspectionOrder,
  formatInspectionOrderNo,
  resolveInspectionOrderNoPrefix,
  toInspectionOrderNoDayKey,
} from '@letian/domain';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

/**
 * 007 过程检验 (IPQC) 工序追溯字段（下料检验 / 滚丝检验 / 成品检）。
 *
 * 单独成组的原因：契约 `CreateInspectionOrderRequest` 里的 `operatorName` / `operatorId` 指的是
 * **机台作业员**，而命令顶层的 `operatorName` / `operatorId` 是**当前登录操作人**（用于审计与
 * Outbox），两者同名但语义完全不同 —— 平铺传递必然互相覆盖，故收拢为 `ipqcProcess` 分组。
 */
export interface IpqcProcessFields {
  /** MES 生产工单号（台账「MES工单号」列） */
  workOrderNo?: string;
  /** 断料长度 mm（下料检验专有，台账「断料长度」列） */
  blankingLength?: number;
  /** 机台作业员姓名（台账「操作员」列） */
  operatorName?: string;
  /** 机台作业员工号 */
  operatorId?: string;
  /** 机台设备编号（台账「设备」列） */
  equipmentCode?: string;
  /** 机台设备名称 */
  equipmentName?: string;
  /** 牙纹/螺纹规格（滚丝检验专有） */
  threadSpec?: string;
  /** 终检班组（成品检专有） */
  inspectionTeam?: string;
  /** 工序阶段（自动断料 / 手工滚牙 / 检测入库） */
  processStep?: string;
  /** 该工序报工/报检登记时间（台账「完成时间」列） */
  completedAt?: string;
}

export interface CreateInspectionOrderCommand extends Partial<CreateInspectionOrderRequest> {
  inspectionType: CreateInspectionOrderRequest['inspectionType'];
  materialCode: string;
  /** 物料名称；省略或传空白时由用例按 materialCode 从存货档案补齐（见 docs/26 §5.1） */
  materialName?: string;
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
  /** 007 过程检验工序追溯字段（见 IpqcProcessFields） */
  ipqcProcess?: IpqcProcessFields;
  operatorId: string;
  operatorName: string;
}

/**
 * 创建检验单用例 (含方案快照深拷贝绑定)
 */

/**
 * 空串与纯空白一律视作「未提供」：交由存货档案兜底，避免把空值当成快照落库
 * （`specification` / `unit` 是台账展示列，落空串与落 NULL 在界面上无法区分，但口径上必须唯一）。
 */
function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

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

      // 2.0 物料名称 / 规格型号 / 计量单位：三列一律以「存货档案」为权威来源。
      //     请求体显式给出时以请求体为准（兼容 ERP/MES 下发），省略（或传空白）时按 material_code
      //     回查主数据补齐 materials.material_name / spec_model / unit。
      //     此前这里是纯透传：调用方不带 specification，新单就落 NULL，台账「规格型号」列会再次空掉
      //     —— 迁移 023 只负责存量数据，本条兜底负责此后所有新建单，二者分工互补（见 docs/26 §5.1）。
      const materialName = nonBlank(cmd.materialName) ?? nonBlank(material?.materialName);
      if (materialName === undefined) {
        throw new ApplicationError(
          ErrorCode.VALIDATION_FAILED,
          `物料名称缺失且无法从存货档案补齐：物料编码 [${cmd.materialCode}] 在 materials 中不存在，请在请求体显式传入 materialName`,
          400
        );
      }
      const specification =
        nonBlank(cmd.specification) ?? nonBlank(cmd.spec) ?? nonBlank(material?.specModel);
      const unit = nonBlank(cmd.unit) ?? nonBlank(material?.unit);

      if (securityCtx) {
        securityCtx.assertAccess({
          targetCategory: materialCategory,
          targetMaterialCode: cmd.materialCode,
          ...(cmd.supplierCode !== undefined ? { targetSupplierCode: cmd.supplierCode } : {}),
        });
      }

      // 2.1 「供应商」名称快照：请求体未显式给出名称时，按供应商编码回查供应商主数据，
      //     让落库的 supplier_name 即为厂商全称，而不是只存内部编码（如 SUP-001）。
      //     主数据查不到（编码不存在 / 尚未接入 ERP）时保持 undefined，读侧仍按编码兜底，不做猜测。
      const supplierName =
        (cmd.supplierName !== undefined && cmd.supplierName !== '' ? cmd.supplierName : undefined) ??
        (cmd.supplierCode !== undefined && cmd.supplierCode !== ''
          ? (await ctx.suppliers.getSupplierByCode(cmd.supplierCode))?.supplierName
          : undefined);

      // 3. 寻找适用的质检方案并获取激活版本
      let planVersionToBind: InspectionPlanVersion | undefined = undefined;
      let planCodeBound: string | undefined = undefined;
      // 方案来源：显式指定 (EXPLICIT) 优先；未指定时按「物料编码 + 检验类型」自动匹配。
      // 自动匹配分两级：物料专属方案 (AUTO_MATERIAL) 与存货分类通用方案兜底 (AUTO_MATERIAL_CATEGORY)。
      // 两条路径共用 inspectionPlans 仓储，匹配规则唯一；匹配不到一律明确报错，绝不猜测方案。
      let planMatchSource: 'EXPLICIT' | 'AUTO_MATERIAL' | 'AUTO_MATERIAL_CATEGORY' = 'EXPLICIT';

      if (cmd.planId) {
        const plan = await ctx.inspectionPlans.findById(cmd.planId);
        if (!plan) {
          throw new ApplicationError(
            ErrorCode.INSPECTION_PLAN_NOT_FOUND,
            `指定的质检方案 [${cmd.planId}] 不存在`,
            404
          );
        }
        planCodeBound = plan.planCode;
        if (cmd.planVersionNo) {
          planVersionToBind = plan.versions?.find((v) => v.versionNo === cmd.planVersionNo);
          if (!planVersionToBind) {
            throw new ApplicationError(
              ErrorCode.INSPECTION_PLAN_NOT_FOUND,
              `质检方案 [${cmd.planId}] 中未找到版本 [${cmd.planVersionNo}]`,
              404
            );
          }
        } else {
          planVersionToBind = plan.versions?.find((v) => v.status === 'ACTIVE');
          if (!planVersionToBind) {
            throw new ApplicationError(
              ErrorCode.INSPECTION_PLAN_NOT_ACTIVE,
              `质检方案 [${cmd.planId}] 当前无已启用的有效版本`,
              400
            );
          }
        }
      } else {
        // 未指定方案：按物料编码 + 检验类型自动匹配已启用方案
        planMatchSource = 'AUTO_MATERIAL';
        // 分类级兜底：物料无专属方案时下沉到该物料所属存货分类的通用方案；
        // 物料主数据查不到时没有可比对的分类，只走第一级，不做无依据的兜底。
        const applicablePlan = await ctx.inspectionPlans.findActivePlan(
          cmd.materialCode,
          cmd.inspectionType,
          material?.categoryCode
        );
        planCodeBound = applicablePlan?.planCode;
        planVersionToBind = applicablePlan?.versions?.find((v) => v.status === 'ACTIVE');
        // 命中分类通用方案时如实记录兜底来源，便于追溯"为什么这一单用了这份方案"
        if (applicablePlan && applicablePlan.materialCode !== cmd.materialCode) {
          planMatchSource = 'AUTO_MATERIAL_CATEGORY';
        }
        // 命中方案但没有任何启用版本：明确报错，不静默降级到其它方案
        if (applicablePlan && !planVersionToBind) {
          throw new ApplicationError(
            ErrorCode.INSPECTION_PLAN_NOT_ACTIVE,
            `质检方案 [${applicablePlan.planCode}] 当前无已启用的有效版本`,
            400
          );
        }
      }

      if (!planVersionToBind) {
        throw new ApplicationError(
          ErrorCode.INSPECTION_PLAN_NOT_FOUND,
          `未找到适用于物料 [${cmd.materialCode}]、检验类型 [${cmd.inspectionType}] 的已启用质检方案`,
          400
        );
      }

      // 空指标版本无法生成任何检验项，必须在建单前拦截（否则聚合根抛错会退化成 500）
      if (!planVersionToBind.items || planVersionToBind.items.length === 0) {
        throw new ApplicationError(
          ErrorCode.INSPECTION_PLAN_NOT_FOUND,
          `质检方案版本 [${planVersionToBind.versionNo}] 不包含任何指标项，无法生成检验项`,
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
        materialName,
        batchNo: cmd.batchNo,
        batchQty: cmd.batchQty,
        sampleQty: cmd.sampleSize ?? Math.min(cmd.batchQty, 5),
        supplierCode: cmd.supplierCode,
        supplierName,
        // 006 来料检验 (IQC) 入库单号 / 入库日期 / 规格字段：由请求体透传（create 契约已声明），
        // specification 缺省时先回落契约别名 spec，仍未提供则按物料编码从存货档案补齐（见上方 2.0）
        inboundNo: cmd.inboundNo,
        inboundDate: cmd.inboundDate,
        specification,
        unit,
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
        // 台账「检验人」列（inspection_orders.inspector_id / inspector_name）：契约可传，缺省保持 undefined，
        // 由读侧按员工主数据补齐；此处不做任何推导（见 docs/30 §3）
        inspectorId: cmd.inspectorId,
        inspectorName: cmd.inspectorName,
        // 007 过程检验工序追溯字段：优先取 ipqcProcess 分组，同时兼容按契约 DTO 平铺传入的调用方
        // （`operatorName` / `operatorId` 只认分组 —— 顶层同名属性是当前操作人，见 IpqcProcessFields）。
        // 历史断链：此前聚合根没有这些属性、控制器也未透传，建单传入的断料长度/操作员/设备被静默丢弃。
        workOrderNo: cmd.ipqcProcess?.workOrderNo ?? cmd.workOrderNo,
        blankingLength: cmd.ipqcProcess?.blankingLength ?? cmd.blankingLength,
        operatorName: cmd.ipqcProcess?.operatorName,
        operatorId: cmd.ipqcProcess?.operatorId,
        equipmentCode: cmd.ipqcProcess?.equipmentCode ?? cmd.equipmentCode,
        equipmentName: cmd.ipqcProcess?.equipmentName ?? cmd.equipmentName,
        threadSpec: cmd.ipqcProcess?.threadSpec ?? cmd.threadSpec,
        inspectionTeam: cmd.ipqcProcess?.inspectionTeam ?? cmd.inspectionTeam,
        processStep: cmd.ipqcProcess?.processStep ?? cmd.processStep,
        completedAt: cmd.ipqcProcess?.completedAt ?? cmd.completedAt,
        // 报检批量（物理列 total_qty，台账「数量」列）：契约显式传入才落库，缺省保持 undefined
        totalQty: cmd.totalQty,
        isMandatoryGate: cmd.mandatoryGate ?? true,
      });

      // 5. 绑定方案快照深拷贝 (聚合根深拷贝防篡改)
      //    inspection_orders.plan_id 是 UUID NOT NULL，必须回填命中版本行的 UUID；
      //    历史缺陷：自动匹配路径曾写入字符串 'AUTO_MATCHED'，落库必然违反 UUID 约束。
      const boundPlanId = planVersionToBind.id ?? cmd.planId;
      if (!boundPlanId) {
        throw new ApplicationError(
          ErrorCode.INSPECTION_PLAN_NOT_FOUND,
          `质检方案版本 [${planVersionToBind.versionNo}] 缺少版本行标识，无法绑定方案快照`,
          400
        );
      }
      order.bindPlanSnapshot(planVersionToBind, {
        planId: boundPlanId,
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
          planMatchSource,
          itemsCount: order.getItems().length,
        },
        createdAt: new Date().toISOString(),
      });

      return order.toDTO();
    });
  }
}
