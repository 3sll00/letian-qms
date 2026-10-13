import type {
  InspectionOrder as InspectionOrderDTO,
  BatchRecordInspectionItemsRequest,
} from '@letian/contracts';
import { InspectionOrder } from '@letian/domain';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';
import { collectPendingDefect } from '../mrb/collect-pending-defect.js';
import { autoInitiateMrbReview } from '../mrb/auto-initiate-mrb-review.js';
import { registerInspectionTraceNode } from '../traceability/register-inspection-trace-node.js';

export interface RecordMeasurementsAndJudgeCommand
  extends Partial<BatchRecordInspectionItemsRequest> {
  orderId: string;
  items: Array<{
    itemCode: string;
    measuredVal?: number;
    measuredText?: string;
    defectReason?: string;
    remark?: string;
    inspectorRemark?: string;
    /** 炉批号继承来源标记（docs/47 §3.6）：带出 = 上游单据类型，人工填写 = MANUAL_ENTRY */
    inheritedFrom?: 'OUTSOURCE_HEAT_TREATMENT' | 'IQC_RAW_MATERIAL' | 'MANUAL_ENTRY';
    /** 带出时的原始历史值快照（人工修改前的带出值，用于留痕比对） */
    inheritedHeatValue?: number | string;
    /** 带出值是否被质检员手工修改过 */
    isManuallyModified?: boolean;
    modificationReason?: string;
    /** 过程检验「不解检（EXEMPT）」标记：为 true 时该项跳过公差判定、不计入合格率分母 */
    isExempt?: boolean;
    exemptReason?: string;
  }>;
  overallRemark?: string;
  operatorId: string;
  operatorName: string;
}

/**
 * 实测录入并执行综合判定用例
 * 若判定不合格，根据状态机规则自动触发后续处理与 Outbox 事件
 */
export class RecordMeasurementsAndJudgeUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: RecordMeasurementsAndJudgeCommand,
    securityCtx?: ISecurityContext
  ): Promise<InspectionOrderDTO> {
    return await this.uow.execute(async (ctx) => {
      const orderDto = await ctx.inspectionOrders.findById(cmd.orderId);
      if (!orderDto) {
        throw new ApplicationError('ORDER_NOT_FOUND', `未找到检验工单 [${cmd.orderId}]`, 404);
      }

      // 排他事务锁：防止同一批次或工单并发录入判定（直接读 DTO 字段）
      await ctx.locks.acquireXactLock(`LOCK_ORDER_${orderDto.batchNo}`);

      if (securityCtx) {
        // 从物料主数据解析真实分类；查不到时 UNKNOWN 不命中任何白名单（fail-closed）
        const material = await ctx.materials.getMaterialByCode(orderDto.materialCode);
        securityCtx.assertAccess({
          targetCategory: material?.categoryCode ?? 'UNKNOWN',
          targetMaterialCode: orderDto.materialCode,
          ...(orderDto.supplierCode !== undefined ? { targetSupplierCode: orderDto.supplierCode } : {}),
        });
      }

      // 需要执行领域行为：包装为聚合根
      // 契约 DTO 未包含批量总数，domain 构造必填，以 sampleQty 占位（sampleQty 恒存在，不影响流程计算与输出）
      const order = new InspectionOrder({
        ...orderDto,
        id: orderDto.id ?? cmd.orderId,
        batchQty: orderDto.sampleQty,
        // 实际承担检验的操作人即检验人：录入实测值的一方必须被记入工单，
        // 否则「检验人」列只能停留在种子/迁移的兜底值（且 save() 会把 inspector_id 写回 NULL）
        inspectorId: cmd.operatorId,
        inspectorName: cmd.operatorName,
      });

      try {
        // 0. 首次录入实测值即代表"开始检验"：聚合根只允许 INSPECTING / DRAFT 录入，
        //    而未开检的工单有两种来路 —— 新建单初始态 PENDING，以及 MRB 返工回边后的
        //    复检轮次 RE_INSPECTING（create-reinspection.ts 把源单翻成该态，见 docs/21 §11）。
        //    两者都按状态机允许的边推进到 INSPECTING（PENDING / RE_INSPECTING -> INSPECTING），
        //    否则 PENDING 单无法开检、RE_INSPECTING 单无法续录：台账「检验中」行的【继续】
        //    会恒定报 ORDER_NOT_EDITABLE: 工单当前处于 [RE_INSPECTING] 状态，禁止录入或修改检验指标。
        const currentStatus = order.getStatus();
        if (currentStatus === 'PENDING' || currentStatus === 'RE_INSPECTING') {
          order.startInspection();
        }

        // 1. 编排批量录入实测值：逐个调用聚合根原子能力
        //    继承留痕字段（inheritedFrom / 带出原值 / 手工修改标记）随实测值同一事务落库（docs/47 §3.6）
        for (const item of cmd.items) {
          // 不解检（EXEMPT）标记先于实测值写入：evaluate 时 isExempt 恒返回 EXEMPT，
          // 顺序反过来会把免检项按「未录入」判成 PENDING，把整单拖向 FAILED。
          if (item.isExempt !== undefined) {
            order.markItemExempt({
              itemCode: item.itemCode,
              isExempt: item.isExempt,
              ...(item.exemptReason !== undefined ? { exemptReason: item.exemptReason } : {}),
            });
          }
          // 免检项无实测值可录：跳过 recordItemMeasurement，避免把实测字段清成 undefined
          if (item.isExempt === true) continue;
          order.recordItemMeasurement({
            itemCode: item.itemCode,
            ...(item.measuredVal !== undefined ? { measuredVal: item.measuredVal } : {}),
            ...(item.measuredText !== undefined ? { measuredText: item.measuredText } : {}),
            ...(item.inheritedFrom !== undefined ? { inheritedFrom: item.inheritedFrom } : {}),
            ...(item.inheritedHeatValue !== undefined
              ? { inheritedHeatValue: item.inheritedHeatValue }
              : {}),
            ...(item.isManuallyModified !== undefined
              ? { isManuallyModified: item.isManuallyModified }
              : {}),
            ...(item.modificationReason !== undefined
              ? { modificationReason: item.modificationReason }
              : {}),
          });
        }

        // 2. 触发终检判定原子能力：检验员填写的合格 / 不合格数量与判定**同事务**落库（docs/21 §14）。
        //    不能只靠领域派生：首次判定时 `pass_qty` 尚未落地（恒 0），派生的 `failQty` 恒等于
        //    整批抽样数 —— 判定即建单的 MRB 就会把「不合格数量」固化成检测数。未下发时仍按派生值兜底。
        order.submitAndEvaluate({
          ...(cmd.passQty !== undefined ? { passQty: cmd.passQty } : {}),
          ...(cmd.failQty !== undefined ? { failQty: cmd.failQty } : {}),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApplicationError('JUDGEMENT_FAILED', msg, 400);
      }

      // 3. 导出 DTO 持久化
      const updatedOrderDto = order.toDTO();
      await ctx.inspectionOrders.save(updatedOrderDto);

      const status = order.getStatus();
      const decision = order.getOverallDecision();
      const traceNode = await registerInspectionTraceNode(ctx, updatedOrderDto, cmd.operatorName);

      // 4. 判定不合格 -> 汇入不合格台账（与工单状态同事务提交，见 docs/20 §5 D3）
      //    + 同事务自动创建 MRB 评审单（docs/43 §3：判定即入评审，无人工发起环节）。
      //    该路径此前只入池不建单：若不补齐，这些单会留下永远无人发起的孤儿台账条目。
      let mrbReviewNo: string | undefined;
      if (decision === 'FAILED') {
        const failedOrder = order.toDTO();
        await collectPendingDefect(ctx, failedOrder);

        const auto = await autoInitiateMrbReview(
          ctx,
          failedOrder,
          { id: cmd.operatorId, name: cmd.operatorName },
          {
            ...(cmd.overallRemark !== undefined ? { reviewNotes: cmd.overallRemark } : {}),
          },
          securityCtx
        );
        if (auto !== null) {
          mrbReviewNo = auto.mrbReview.mrbNo;
        }
      }

      // 5. 发送领域事件到 Outbox
      await ctx.outbox.append({
        id: crypto.randomUUID(),
        aggregateType: 'InspectionOrder',
        aggregateId: order.getId(),
        eventType: decision === 'PASSED' ? 'INSPECTION_PASSED' : 'INSPECTION_FAILED',
        payload: {
          orderId: order.getId(),
          orderNo: order.getOrderNo(),
          batchNo: order.getBatchNo(),
          decision: decision,
          status: status,
          failedItems: order
            .getItems()
            .filter((it) => it.result === 'FAILED')
            .map((it) => ({
              itemCode: it.itemCode,
              name: it.name,
              ...(it.measuredVal !== undefined ? { measuredVal: it.measuredVal } : {}),
            })),
        },
        traceId: crypto.randomUUID(),
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 0,
      });

      // 6. 不可变审计日志
      await ctx.auditLogs.insert({
        id: crypto.randomUUID(),
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        userId: cmd.operatorId,
        userName: cmd.operatorName,
        action: 'STATUS_CHANGE',
        resourceType: 'INSPECTION_ORDER',
        resourceId: order.getId(),
        status: 'SUCCESS',
        diffPatch: {
          decision,
          status,
          itemCount: cmd.items.length,
          traceNodeBatchNo: traceNode.batchNo,
          traceNodeStatus: traceNode.nodeStatus,
          // 自动发起留痕（docs/43）：让「判不合格却没有 MRB 单」在审计日志里一眼可判
          mrbAutoInitiated: mrbReviewNo !== undefined,
          ...(mrbReviewNo !== undefined ? { mrbReviewNo } : {}),
          ...(cmd.overallRemark !== undefined ? { remark: cmd.overallRemark } : {}),
        },
        createdAt: new Date().toISOString(),
      });

      // 自动建单会把工单推进到 IN_MRB_REVIEW，回读最终态返回（避免前端拿到 FAILED 中间态）
      if (mrbReviewNo !== undefined) {
        return (await ctx.inspectionOrders.findById(order.getId())) ?? order.toDTO();
      }
      return order.toDTO();
    });
  }
}
