import type { InspectionOrder } from '@letian/contracts';
import type { PendingDefectDraft } from '@letian/domain';
import type { IUnitOfWorkContext } from '../../tx/unit-of-work.js';

/**
 * 不合格品自动汇入待审核池（docs/21-MRB不合格品处置数据字段与接口打通设计.md §5、D3）
 *
 * 口径：
 * - **受检数量（不良率分母）**取检验单的抽样数量 `sampleQty`，而非报检总数：
 *   判定是在抽样样本内做出的，用报检总数当分母会把不良率摊薄成假数据；
 * - **不合格描述**优先取检验单备注，缺失时用首个判不合格的指标项拼装；
 * - **供应商**口径对委外工序取加工商 `vendorName`（IQC 取 `supplierName`），客户取 `customerName`；
 * - **入池幂等**由仓储按 `source_order_id` upsert 保证，重复判定不会产生重复条目。
 *
 * `fallbackReason`（可选）供终判路径（`FinalizeInspectionStatusUseCase`）传入：整批判退 / 让步申请
 * 这类**没有超差实测项**的单据，其不合格描述来自检验员的终判结论备注；两者皆空时给出如实描述，
 * 绝不写「实测超出公差判定不合格」这种与事实不符的兜底文案（docs/39 §3）。
 */
export function buildPendingDefectDraft(
  order: InspectionOrder,
  fallbackReason?: string
): PendingDefectDraft {
  const failedItems = (order.items ?? []).filter((item) => item.result === 'FAILED');
  const firstFailed = failedItems[0];

  const defectQty = Number(order.failQty ?? 0);
  const sampleQty = Number(order.sampleQty ?? 0);
  const declaredQty = Number(order.totalQty ?? 0);
  // 分母兜底顺序：抽样数量 -> 报检总数 -> 不良数量（绝不落 0，避免不良率除零失真）
  const totalQty =
    sampleQty > 0 ? sampleQty : declaredQty > 0 ? declaredQty : defectQty > 0 ? defectQty : 1;

  const notes = (order.inspectionNotes ?? '').trim();
  const explicitReason = (fallbackReason ?? '').trim();
  const defectDescription =
    notes !== ''
      ? notes
      : explicitReason !== ''
        ? explicitReason
      : firstFailed !== undefined
        ? `${firstFailed.name ?? firstFailed.itemCode} 超差判定不合格`
        : '检验判定不合格（未录入具体超差项）';

  const supplierName = order.supplierName ?? order.vendorName;

  return {
    inspectionOrderId: order.id ?? order.orderNo,
    orderNo: order.orderNo,
    inspectionType: order.inspectionType,
    batchNo: order.batchNo,
    materialCode: order.materialCode,
    materialName: order.materialName,
    defectQty,
    totalQty,
    defectDescription,
    status: 'PENDING_INITIATE',
    ...(firstFailed !== undefined && firstFailed.itemCode !== undefined
      ? { defectItemCode: firstFailed.itemCode }
      : {}),
    ...(supplierName !== undefined ? { supplierName } : {}),
    ...(order.customerName !== undefined ? { customerName: order.customerName } : {}),
    ...(order.inspectorId !== undefined ? { inspectorId: order.inspectorId } : {}),
    ...(order.inspectorName !== undefined ? { inspectorName: order.inspectorName } : {}),
    failedItems: failedItems.map((item) => ({
      itemCode: item.itemCode,
      name: item.name,
      ...(item.measuredVal !== undefined ? { measuredVal: item.measuredVal } : {}),
      ...(item.measuredText !== undefined ? { measuredText: item.measuredText } : {}),
    })),
  };
}

/**
 * 在判定事务内写池：与检验单状态变更同事务提交，
 * 保证「工单判不合格」与「进入待审核池」要么同时成立、要么同时回滚。
 */
export async function collectPendingDefect(
  ctx: IUnitOfWorkContext,
  order: InspectionOrder,
  fallbackReason?: string
): Promise<void> {
  await ctx.pendingDefects.save(buildPendingDefectDraft(order, fallbackReason));
}
