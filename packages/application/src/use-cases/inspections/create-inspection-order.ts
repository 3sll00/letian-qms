import { randomUUID } from 'node:crypto';
import type {
  InspectionOrder as InspectionOrderDTO,
  CreateInspectionOrderRequest,
  InspectionPlanVersion,
  TransferDecision,
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
import { evaluateTransferDecision } from './check-transfer-permit.js';

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
  /** 030 委外检验录入页业务事实字段（docs/36）：材质牌号 / 执行技术标准 / 检验日期 */
  materialGrade?: string;
  techStandard?: string;
  inspectedDate?: string;
  /**
   * 炉批号（Heat No，docs/47 §3.1）：落 `inspection_orders.furnace_heat_batch_no`。
   * 建单即落库 —— 出货检验录入时按它关联上游检验记录（委外热处理 -> 来料检验）。
   */
  furnaceHeatNo?: string;
  mandatoryGate?: boolean;
  planId?: string;
  planVersionNo?: string;
  historicalResult?: {
    source: 'MES';
    occurredAt: Date;
    passQty: number;
    failQty: number;
    judgment: 'PASSED' | 'FAILED';
    notes: string;
  };
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
    if (cmd.historicalResult && (cmd.operatorId !== 'SYS-MES-SYNC' || securityCtx)) {
      throw new ApplicationError(ErrorCode.VALIDATION_FAILED, '历史 MES 实绩仅允许系统同步服务导入', 403);
    }
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

      // 2.05 「合格后传递」门禁（docs/48-合格后传递通用链路规则设计与改造方案.md §4.5）：
      //      本环节的**唯一执法点**。四个检验环节（IQC / IPQC / 委外 / 出货）共用本入口，
      //      因此规则写在这里就自动覆盖全部环节，不需要（也不允许）在各控制器里再写一份 if。
      //
      //      位置：排在排他锁与 PBAC 之后、方案匹配与取号之前 ——
      //        ① 先拿锁：与「同批次并发建单」串行化，避免两单各自看到旧上游；
      //        ② 先判 PBAC：越权请求返回 403 而不是泄露链路状态；
      //        ③ 早于取号：被阻断的单**不消耗**单号流水（否则台账会出现空洞号）。
      //      判定本身是纯函数（唯一真相在 @letian/domain），此处只负责取数与处置。
      const transferWorkOrderNo = nonBlank(cmd.ipqcProcess?.workOrderNo ?? cmd.workOrderNo);
      const transferDecision = await evaluateTransferDecision(ctx, {
        inspectionType: cmd.inspectionType,
        batchNo: cmd.batchNo,
        materialCode: cmd.materialCode,
        ...(nonBlank(cmd.furnaceHeatNo) !== undefined
          ? { furnaceHeatNo: nonBlank(cmd.furnaceHeatNo) }
          : {}),
        ...(transferWorkOrderNo !== undefined ? { workOrderNo: transferWorkOrderNo } : {}),
        ...(cmd.orderNo !== undefined ? { orderNo: cmd.orderNo } : {}),
      });
      let isOverridden = false;
      let resolvedTicketId: string | null = null;
      if (!transferDecision.allowed && !cmd.historicalResult) {
        if (cmd.transferOverride) {
          if (!cmd.transferOverride.reason || cmd.transferOverride.reason.trim().length < 5) {
            throw new ApplicationError(
              ErrorCode.VALIDATION_FAILED,
              '豁免原因至少需要5个字符',
              400
            );
          }
          if (!cmd.transferOverride.approverId) {
            throw new ApplicationError(
              ErrorCode.VALIDATION_FAILED,
              '豁免审批人 ID 不能为空',
              400
            );
          }
          if (!cmd.transferOverride.ticketId && !cmd.transferOverride.ticketNo) {
            throw new ApplicationError(
              ErrorCode.VALIDATION_FAILED,
              '按「一单一核销」口径，豁免建单必须关联一张已审批的豁免工单（ticketId 或 ticketNo）',
              422
            );
          }
          if (cmd.transferOverride.ticketId || cmd.transferOverride.ticketNo) {
            const ticket = cmd.transferOverride.ticketId
              ? await ctx.transferOverrides.findById(cmd.transferOverride.ticketId)
              : await ctx.transferOverrides.findByTicketNo(cmd.transferOverride.ticketNo!);
            if (!ticket) {
              throw new ApplicationError(
                ErrorCode.RESOURCE_NOT_FOUND,
                `未找到指定的豁免申请工单 [${cmd.transferOverride.ticketId ?? cmd.transferOverride.ticketNo}]`,
                404
              );
            }
            if (ticket.status !== 'APPROVED') {
              throw new ApplicationError(
                ErrorCode.VALIDATION_FAILED,
                `豁免申请单 [${ticket.ticketNo}] 状态为 [${ticket.status}]，非 APPROVED 状态不可核销建单`,
                422
              );
            }
            if (
              ticket.batchNo !== cmd.batchNo ||
              ticket.materialCode !== cmd.materialCode ||
              ticket.inspectionType !== cmd.inspectionType
            ) {
              throw new ApplicationError(
                ErrorCode.VALIDATION_FAILED,
                `豁免申请单 [${ticket.ticketNo}] 目标批次/物料/类型与当前建单请求不匹配`,
                422
              );
            }
            resolvedTicketId = ticket.id;
          }
          isOverridden = true;
        } else {
        // 留痕必须写在**独立事务**里：本事务随后就要回滚，写在里面的审计与 Outbox 会一并消失，
        // 于是「客户问这批为什么动不了」将查不到任何记录（docs/48 §8 硬约束 5）。
        // 审计表与 Outbox 表都是纯追加写，不会与在建单事务争锁，跨事务写入是安全的。
        await this.recordTransferBlockedAttempt(cmd, transferDecision, securityCtx);
        throw transferBlockedError(transferDecision, cmd.inspectionType, cmd.batchNo);
        }
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
      let planNameBound: string | undefined = undefined;
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
        planNameBound = plan.planName;
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
        planNameBound = applicablePlan?.planName;
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
      const orderId = randomUUID();
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
        // 030 委外检验录入页业务事实字段：空串/纯空白一律视作「未提供」（nonBlank），
        // 不落 NULL 覆盖既有值（与同文件 specification / unit 的归一化口径一致）
        materialGrade: nonBlank(cmd.materialGrade),
        techStandard: nonBlank(cmd.techStandard),
        inspectedDate: nonBlank(cmd.inspectedDate),
        // 034 炉批号（docs/47 D1/D2）：空串 / 纯空白一律视作「未提供」（nonBlank），
        // 与上面三列同一口径 —— 不允许用空串把库里已有炉号覆盖成空。
        furnaceHeatNo: nonBlank(cmd.furnaceHeatNo),
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
        // 038 证书模板与证书专用字段（docs/51）：操作员「填写检验内容前」选定后随建单一并落库；
        // 缺省保持 undefined，历史单不受影响
        certTemplate: cmd.certTemplate,
        certFields: cmd.certFields,
        isMandatoryGate: cmd.mandatoryGate ?? true,
        ...(cmd.historicalResult ? { createdAt: cmd.historicalResult.occurredAt.toISOString() } : {}),
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
      if (!planCodeBound || !planNameBound) {
        throw new ApplicationError(ErrorCode.INSPECTION_PLAN_NOT_FOUND, '已命中方案缺少编码或名称', 400);
      }
      order.bindPlanSnapshot(planVersionToBind, {
        planId: boundPlanId,
        planCode: planCodeBound,
        planName: planNameBound,
      });

      // 6. 持久化聚合根
      await ctx.inspectionOrders.save(order.toDTO());
      if (cmd.historicalResult) {
        const { occurredAt, passQty, failQty, judgment, notes } = cmd.historicalResult;
        await ctx.inspectionOrders.updateStatsAndVerdict(order.getId(), {
          passQty,
          failQty,
          judgment,
          completedAt: occurredAt,
          inspectionNotes: notes,
        });
        await ctx.inspectionOrders.updateStatus(order.getId(), judgment);
      }

      // 6.1 建单传递留痕（docs/48 §4.1 / 迁移 035）：把**第 1 步那次门禁判定**原样落库。
      //
      //     为什么必须有：上游状态会变（MRB 结案 / 复检终判 / 下游被冻结），只靠实时重算
      //     查不出「这批货当初凭什么放行」，客户问起来只能翻审计日志的中文 payload。
      //     与 docs/47 的 heat_source_* 同型 —— 列建了就必须有人写，否则重演「列建好了却没人写」（docs/47 §2 D1）。
      //
      //     三条纪律：
      //       ① **只作留痕，不作判据**：留痕一旦被读成判据，就会出现「上游已撤销放行、下游仍按旧留痕放行」；
      //       ② 实时建单取 `transferDecision`，MES 历史实绩标记 HISTORICAL_IMPORT（不冒充当年的放行判定）；
      //       ③ 与建单**同一事务**：留痕失败即建单失败，不会留下「单在、留痕丢」的静默状态。
      await ctx.inspectionOrders.recordTransferTrace(order.getId(), {
        chainKey: transferDecision.chainKey,
        chainKeyKind: transferDecision.chainKeyKind,
        ...(transferDecision.predecessorOrderNo !== undefined
          ? { upstreamOrderNo: transferDecision.predecessorOrderNo }
          : {}),
        upstreamGateCode: cmd.historicalResult
          ? 'HISTORICAL_IMPORT'
          : isOverridden
            ? 'UPSTREAM_OVERRIDDEN'
            : transferDecision.code,
      });

      if (isOverridden && cmd.transferOverride) {
        const consumeId = resolvedTicketId ?? cmd.transferOverride.ticketId;
        if (consumeId) {
          await ctx.transferOverrides.consumeTicket(consumeId, {
            orderId: order.getId(),
            orderNo: order.getOrderNo(),
          });
        }
        await ctx.auditLogs.insert({
          id: randomUUID(),
          traceId: securityCtx?.traceId ?? randomUUID(),
          userId: cmd.transferOverride.approverId,
          userName: cmd.transferOverride.approverName ?? '质量主管特批',
          action: 'STATUS_CHANGE',
          resourceType: 'INSPECTION_ORDER',
          resourceId: order.getId(),
          status: 'SUCCESS',
          diffPatch: {
            orderNo: order.getOrderNo(),
            batchNo: order.getBatchNo(),
            materialCode: order.getMaterialCode(),
            inspectionType: order.getInspectionType(),
            originalGateCode: transferDecision.code,
            upstreamOrderNo: transferDecision.predecessorOrderNo ?? null,
            reason: cmd.transferOverride.reason,
            approvalDocNo: cmd.transferOverride.approvalDocNo ?? null,
            ticketId: consumeId ?? null,
          },
          createdAt: new Date().toISOString(),
        });

        await ctx.outbox.append({
          id: randomUUID(),
          aggregateType: 'InspectionOrder',
          aggregateId: order.getId(),
          eventType: 'TRANSFER_GATE_OVERRIDDEN',
          payload: {
            orderId: order.getId(),
            orderNo: order.getOrderNo(),
            batchNo: order.getBatchNo(),
            materialCode: order.getMaterialCode(),
            inspectionType: order.getInspectionType(),
            originalGateCode: transferDecision.code,
            reason: cmd.transferOverride.reason,
            approverId: cmd.transferOverride.approverId,
            approvalDocNo: cmd.transferOverride.approvalDocNo ?? null,
          },
          traceId: securityCtx?.traceId ?? randomUUID(),
          occurredAt: new Date(),
          status: 'PENDING',
          retryCount: 0,
        });
      }

      // 7. 写入 Outbox 事件
      await ctx.outbox.append({
        id: randomUUID(),
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
        traceId: randomUUID(),
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 0,
      });

      // 8. 审计记录
      await ctx.auditLogs.insert({
        id: randomUUID(),
        traceId: securityCtx?.traceId ?? randomUUID(),
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
          ...(cmd.historicalResult ? { historicalSource: cmd.historicalResult.source } : {}),
        },
        createdAt: new Date().toISOString(),
      });

      if (cmd.historicalResult) {
        const persisted = await ctx.inspectionOrders.findById(order.getId());
        if (!persisted) throw new Error(`MES_IMPORT_ORDER_NOT_FOUND: ${order.getId()}`);
        return persisted;
      }
      return order.toDTO();
    });
  }

  /**
   * 传递门禁阻断留痕（审计 `GATE_BLOCKED` + Outbox `TRANSFER_BLOCKED` / `CHAIN_TERMINATED`）。
   *
   * **为什么另开一个事务**：本用例的建单事务在阻断时必然回滚，若把留痕写在同一事务里，
   * 「这次建单为什么被拦」会随建单一起消失 —— 客户来问时查不到任何证据
   * （docs/48 §8 硬约束 5：每次阻断必须留痕）。审计表与 Outbox 表都是纯追加写，
   * 不会与在建单事务争锁，因此跨事务提交是安全的。
   */
  private async recordTransferBlockedAttempt(
    cmd: CreateInspectionOrderCommand,
    decision: TransferDecision,
    securityCtx?: ISecurityContext
  ): Promise<void> {
    const traceId = securityCtx?.traceId ?? randomUUID();
    await this.uow.execute(async (ctx) => {
      await ctx.auditLogs.insert({
        id: randomUUID(),
        traceId,
        userId: cmd.operatorId,
        userName: cmd.operatorName,
        action: 'GATE_BLOCKED',
        resourceType: 'INSPECTION_ORDER',
        resourceId: cmd.batchNo,
        status: 'REJECTED',
        diffPatch: {
          gate: 'TRANSFER',
          code: decision.code,
          downstreamStage: decision.stage,
          precedentStage: decision.precedentStage ?? null,
          predecessorOrderNo: decision.predecessorOrderNo ?? null,
          predecessorStatus: decision.predecessorStatus ?? null,
          mrbNo: decision.mrbNo ?? null,
          mrbDisposition: decision.mrbDisposition ?? null,
          chainKey: decision.chainKey,
          chainKeyKind: decision.chainKeyKind,
          terminateChain: decision.terminateChain,
          batchNo: cmd.batchNo,
          materialCode: cmd.materialCode,
          reason: decision.reason,
        },
        createdAt: new Date().toISOString(),
      });

      await ctx.outbox.append({
        id: randomUUID(),
        aggregateType: 'InspectionOrder',
        aggregateId: cmd.batchNo,
        // 退货 / 报废走 CHAIN_TERMINATED（下游系统据此冻结整条链），其余为普通传递阻断
        eventType: decision.terminateChain ? 'CHAIN_TERMINATED' : 'TRANSFER_BLOCKED',
        payload: {
          batchNo: cmd.batchNo,
          materialCode: cmd.materialCode,
          blockedStage: decision.stage,
          gateCode: decision.code,
          predecessorStage: decision.precedentStage ?? null,
          predecessorOrderNo: decision.predecessorOrderNo ?? null,
          mrbNo: decision.mrbNo ?? null,
          terminateChain: decision.terminateChain,
          reason: decision.reason,
          operatorId: cmd.operatorId,
        },
        traceId,
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 0,
      });
    });
  }
}

/**
 * 传递阻断的统一异常形状（422 + problem+json + 结构化 `details`）。
 *
 * `details.transferDecision` 是**完整判定结果**（含理由码 / 上游单号 / MRB 单号 / 放行凭证），
 * 让 MES 与看板按 `code` 分支而不必解析中文文案；`details.blockedBy` 是给现场看的精简三元组。
 */
function transferBlockedError(
  decision: TransferDecision,
  inspectionType: CreateInspectionOrderCommand['inspectionType'],
  batchNo: string
): ApplicationError {
  return new ApplicationError({
    code: ErrorCode.TRANSFER_BLOCKED,
    title: '传递门禁阻断',
    status: 422,
    detail: decision.reason,
    details: {
      transferDecision: decision,
      blockedBy: {
        code: decision.code,
        stage: decision.precedentStage ?? decision.stage,
        orderNo: decision.predecessorOrderNo ?? null,
        status: decision.predecessorStatus ?? null,
      },
      batchNo,
      downstreamStage: inspectionType,
    },
  });
}
