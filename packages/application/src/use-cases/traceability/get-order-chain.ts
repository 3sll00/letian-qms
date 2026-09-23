import type { InspectionOrder, TraceOrderChainResponse, TraceOrderChainStage } from '@letian/contracts';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';
import { ORDER_TYPE_STAGE, resolveInspectionSourceDocNo, toTraceNodeStatus } from './inspection-stage.js';

export interface GetOrderTraceChainCommand {
  /** 订单标识：客户采购订单号 / 销售出库单号 / 工单号 / 检验单号 */
  orderNo: string;
}

/** 来源单据号：真实上游单据优先，缺失时回落批次号（本视图的既有展示口径；节点登记侧不回落） */
function resolveSourceDocNo(order: InspectionOrder): string | undefined {
  return resolveInspectionSourceDocNo(order) ?? order.batchNo;
}

/** 耗时：仅在既有建单时间又有终检时间时给出，否则留空（界面显示 —），不拿状态值占位 */
function resolveDurationMinutes(order: InspectionOrder): number | undefined {
  const startedAt = order.createdAt;
  const completedAt = order.completedAt;
  if (completedAt === undefined || startedAt === undefined) {
    return undefined;
  }
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }
  return Math.round((end - start) / 60_000);
}

/**
 * 订单维度检验环节用例
 *
 * 产出的是「本订单的检验环节台账」，**不是血缘链路**：同一订单下多条检验环节彼此并列，
 * 批次之间的上下游关系只由 `batch_trace_relations` 表达（见 `PenetrateBatchDagUseCase`）。
 * 因此界面标题固定为「本订单检验环节」，不得写「完整质量追溯链路」（docs/24 §4 R5）。
 */
export class GetOrderTraceChainUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: GetOrderTraceChainCommand,
    securityCtx?: ISecurityContext
  ): Promise<TraceOrderChainResponse> {
    const key = cmd.orderNo.trim();

    return await this.uow.execute(async (ctx) => {
      const orders = await ctx.inspectionOrders.findByOrderKey(key);
      if (orders.length === 0) {
        throw new ApplicationError(
          'TRACE_ORDER_NOT_FOUND',
          `未找到订单号 [${key}] 对应的检验单`,
          404
        );
      }

      // 头部信息取「信息最全」的一张：优先带销售出库单号（出货检验），否则取首张
      const header = orders.find((order) => order.salesOrderNo !== undefined) ?? orders[0];
      if (!header) {
        throw new ApplicationError(
          'TRACE_ORDER_NOT_FOUND',
          `未找到订单号 [${key}] 对应的检验单`,
          404
        );
      }

      // PBAC：订单维度是详情视图，未授权直接 403（fail-closed），与批次图谱口径一致。
      // 用头部（成品）物料做三维校验：分类解析不到时取 UNKNOWN，任何白名单规则都不命中。
      if (securityCtx) {
        const material = await ctx.materials.getMaterialByCode(header.materialCode);
        securityCtx.assertAccess({
          targetCategory: material?.categoryCode ?? 'UNKNOWN',
          targetMaterialCode: material?.materialCode ?? header.materialCode,
        });
      }

      const stages: TraceOrderChainStage[] = orders
        .map((order) => {
          const stage = ORDER_TYPE_STAGE[order.inspectionType];
          const sourceDocNo = resolveSourceDocNo(order);
          const durationMinutes = resolveDurationMinutes(order);
          const occurredAt = order.completedAt ?? order.createdAt;
          return {
            seq: stage.seq,
            stageName: stage.stageName,
            orderNo: order.orderNo,
            orderType: order.inspectionType,
            batchNo: order.batchNo,
            status: toTraceNodeStatus(order.status, order.overallDecision),
            ...(sourceDocNo !== undefined ? { sourceDocNo } : {}),
            ...(order.overallDecision !== undefined ? { judgment: order.overallDecision } : {}),
            ...(order.inspectorName !== undefined ? { inspectorName: order.inspectorName } : {}),
            ...(occurredAt !== undefined ? { occurredAt } : {}),
            ...(durationMinutes !== undefined ? { durationMinutes } : {}),
          };
        })
        .sort((left, right) => (left.seq === right.seq ? left.orderNo.localeCompare(right.orderNo) : left.seq - right.seq));

      const batchNos = Array.from(new Set(orders.map((order) => order.batchNo))).sort();

      return {
        orderNo: key,
        matchedBy: GetOrderTraceChainUseCase.detectMatchedBy(orders, key),
        ...(header.customerName !== undefined ? { customerName: header.customerName } : {}),
        ...(header.erpStatus !== undefined ? { erpStatus: header.erpStatus } : {}),
        ...(header.salesOrderNo !== undefined ? { salesOrderNo: header.salesOrderNo } : {}),
        ...(header.salesOrderPoNo !== undefined ? { salesOrderPoNo: header.salesOrderPoNo } : {}),
        batchNos,
        materialCode: header.materialCode,
        materialName: header.materialName,
        ...(header.totalQty !== undefined ? { totalQty: header.totalQty } : {}),
        stages,
      };
    });
  }

  /**
   * 判定查询键命中的是哪个订单字段。
   *
   * 顺序即优先级：客户采购订单号 → 销售出库单号 → 检验单号 → 工单号。
   * 检验单号排在工单号之前，是因为仓储对 `workOrderNo` 有「缺失时回落批次号」的兼容口径，
   * 单凭 DTO 无法区分真实工单号与回落值，用 orderNo 先行校验更可靠。
   */
  private static detectMatchedBy(
    orders: readonly InspectionOrder[],
    key: string
  ): 'SALES_ORDER_PO_NO' | 'SALES_ORDER_NO' | 'WORK_ORDER_NO' | 'ORDER_NO' {
    if (orders.some((order) => order.salesOrderPoNo === key)) {
      return 'SALES_ORDER_PO_NO';
    }
    if (orders.some((order) => order.salesOrderNo === key)) {
      return 'SALES_ORDER_NO';
    }
    if (orders.some((order) => order.orderNo === key)) {
      return 'ORDER_NO';
    }
    return 'WORK_ORDER_NO';
  }
}
