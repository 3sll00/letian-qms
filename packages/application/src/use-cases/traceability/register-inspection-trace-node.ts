import { randomUUID } from 'node:crypto';
import type { InspectionOrder, TraceNode } from '@letian/contracts';
import type { IUnitOfWorkContext } from '../../tx/unit-of-work.js';
import { ORDER_TYPE_STAGE, resolveInspectionSourceDocNo, toTraceNodeStatus } from './inspection-stage.js';

/**
 * 追溯节点环节名：环节简称 + 检验类型码（与种子数据同一写法，如「原材料入库 (IQC)」）。
 *
 * 为什么带类型码：同一工序在不同检验类型下可能是不同环节（如委外七分类），
 * 只写「委外检」会让追溯卡片失去可判读性。
 */
export function buildTraceStageName(order: InspectionOrder): string {
  return `${ORDER_TYPE_STAGE[order.inspectionType].stageName} (${order.inspectionType})`;
}

/**
 * 由检验单构造批次追溯节点（纯函数，便于单测与复用）。
 *
 * 字段口径（docs/41-检验环节自动登记追溯节点设计.md §4）：
 * - `batchNo`：追溯主键；节点表 `batch_no` 有 UNIQUE 约束 ⇒ **一个批次一个节点**，后写覆盖先写；
 * - `nodeStatus`：终判优先（`CONCESSION` 特采如实呈现、不得压成合格）；未终判按检验中，**不冒充合格**；
 * - `operatorName`：优先检验人；未指派时用终判操作人；仍无则写「未登记」，**不编造人名**；
 * - `orderNo`：真实来源单据号（IQC = 入库单、IPQC = 工单、委外 = 委外单、出货 = 销售出库单），缺失即缺省；
 * - `supplierOrCustomer`：委外取加工商，IQC 取供应商，出货取客户；
 * - `timestamp`：终检时间优先，其次建单时间；
 * - `inspectionOrderNo`：本节点对应的检验单号（020 迁移新增列，卡片回跳用）。
 */
export function buildInspectionTraceNode(
  order: InspectionOrder,
  fallbackOperatorName?: string
): TraceNode {
  const operatorName = order.inspectorName ?? fallbackOperatorName ?? '未登记';
  const supplierOrCustomer = order.supplierName ?? order.vendorName ?? order.customerName;
  const sourceDocNo = resolveInspectionSourceDocNo(order);
  const occurredAt = order.completedAt ?? order.createdAt ?? new Date().toISOString();

  return {
    nodeId: randomUUID(),
    batchNo: order.batchNo,
    stageName: buildTraceStageName(order),
    materialName: order.materialName,
    operatorName,
    timestamp: occurredAt,
    nodeStatus: toTraceNodeStatus(order.status, order.overallDecision),
    inspectionOrderNo: order.orderNo,
    ...(sourceDocNo !== undefined ? { orderNo: sourceDocNo } : {}),
    ...(supplierOrCustomer !== undefined ? { supplierOrCustomer } : {}),
    ...(order.materialCode !== undefined ? { materialCode: order.materialCode } : {}),
  };
}

/**
 * 把「本批次该环节的检验结论」登记为追溯节点（docs/41 §3）。
 *
 * 为什么需要：`batch_trace_nodes` 此前**没有运行时写入方** —— 全仓 `saveNode()` 的唯一调用方是
 * `packages/infrastructure/src/seeds/runner.ts`，真实检验单从不落节点。于是【质量追溯看板】里
 * 新建批次永远只有「仅检验台账」一行：最近环节 / 状态 / 关联检验单全是「—」，
 * 点开批次开图直接 404（图谱以节点表为根）。
 *
 * 幂等：仓储按 `batch_no` upsert（`batch_trace_nodes.batch_no` UNIQUE），重复终判只覆盖同一行，
 * 不会堆出重复节点。异常向上抛：节点写不进去应当让整个终判事务回滚，而不是留下一张"没有追溯"的单。
 */
export async function registerInspectionTraceNode(
  ctx: IUnitOfWorkContext,
  order: InspectionOrder,
  fallbackOperatorName?: string
): Promise<TraceNode> {
  const node = buildInspectionTraceNode(order, fallbackOperatorName);
  await ctx.traceDags.saveNode(node);
  return node;
}
