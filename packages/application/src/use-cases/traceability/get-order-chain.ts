import type {
  InspectionOrder,
  InspectionStatus,
  InspectionType,
  OverallDecision,
  TraceNodeStatus,
  TraceOrderChainResponse,
  TraceOrderChainStage,
} from '@letian/contracts';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface GetOrderTraceChainCommand {
  /** 订单标识：客户采购订单号 / 销售出库单号 / 工单号 / 检验单号 */
  orderNo: string;
}

/**
 * 检验类型 → 工艺序位 + 环节简称。
 *
 * 用 `Record<InspectionType, ...>` 而不是松散对象：契约新增检验类型时此处编译期报错，
 * 不会静默漏掉一个环节。序位按**工艺先后**排，不按时间排 —— 现场的时间戳可能因补录而乱序。
 */
const ORDER_TYPE_STAGE: Readonly<Record<InspectionType, { seq: number; stageName: string }>> = {
  IQC: { seq: 1, stageName: '来料检验' },
  IPQC_CT: { seq: 2, stageName: '下料检' },
  IPQC_RL: { seq: 3, stageName: '滚丝检' },
  IPQC_FN: { seq: 4, stageName: '成品检' },
  OQC_SF: { seq: 5, stageName: '委外表面处理检' },
  OQC_HEAT: { seq: 5, stageName: '委外热处理检' },
  OQC_BLACK: { seq: 5, stageName: '委外发黑检' },
  OQC_ZINC: { seq: 5, stageName: '委外镀锌检' },
  OQC_NICKEL: { seq: 5, stageName: '委外镀镍检' },
  OQC_PHOSPH: { seq: 5, stageName: '委外磷化检' },
  OQC_DACRO: { seq: 5, stageName: '委外达克罗检' },
  OQC_MACH: { seq: 5, stageName: '委外机加工检' },
  OQC_SH: { seq: 6, stageName: '出货检验' },
};

/**
 * 检验单状态 + 终判 → 追溯节点状态。
 *
 * 终判优先：`CONCESSION`（特采）必须如实呈现，不得被压成 `PASSED`。
 * 已结单却没有终判属于口径异常：按「检验中」展示，**不冒充合格**。
 */
function toNodeStatus(status: InspectionStatus, judgment: OverallDecision | undefined): TraceNodeStatus {
  if (judgment === 'CONCESSION') return 'CONCESSION';
  if (judgment === 'FAILED') return 'FAILED';
  if (judgment === 'PASSED') return 'PASSED';

  switch (status) {
    case 'FAILED':
      return 'FAILED';
    case 'PASSED':
      return 'PASSED';
    case 'PENDING':
      return 'PENDING';
    default:
      // INSPECTING / DRAFT / RE_INSPECTING / IN_MRB_REVIEW / COMPLETED(无终判)
      return 'INSPECTING';
  }
}

/** 来源单据号：按环节类型取该环节真正对应的上游单据，避免把批次号当单据号展示 */
function resolveSourceDocNo(order: InspectionOrder): string | undefined {
  if (order.inspectionType === 'OQC_SH') {
    return order.salesOrderNo ?? order.batchNo;
  }
  if (order.inspectionType.startsWith('OQC_')) {
    return order.outsourceNo ?? order.batchNo;
  }
  if (order.inspectionType === 'IQC') {
    return order.inboundNo ?? order.batchNo;
  }
  return order.workOrderNo ?? order.batchNo;
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
            status: toNodeStatus(order.status, order.overallDecision),
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
