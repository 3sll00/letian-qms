import type {
  InitiateReviewRequest,
  MaterialPermission,
  MRBReview,
  PendingDefectItem,
} from '@letian/contracts';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';
import type { ISecurityContext } from '../../security/security-context.js';
import { NotFoundError, ConflictError } from '../../errors/application-error.js';
import { TriggerMrbReviewUseCase } from './trigger-mrb-review.js';

export interface PendingPoolQuery {
  stage?: string | undefined;
  sourceStage?: string | undefined;
  inspectionType?: string | undefined;
  materialCode?: string | undefined;
  batchNo?: string | undefined;
  status?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface InitiateReviewResult extends MRBReview {
  mrbId: string;
  reviewNo: string;
  success: boolean;
  message: string;
}

/**
 * 不合格待审核池用例（docs/21-MRB不合格品处置数据字段与接口打通设计.md §5）
 *
 * 读源单一化：池数据只读 `pending_mrb_items`（迁移 015 已回填存量，运行期由
 * `collectPendingDefect` 在判定不合格时同事务入池），不再回退扫描检验单，
 * 避免"池表 / 检验单"双读源导致同一条不合格品出现两种口径。
 */
export class PendingMRBPoolUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  /**
   * 池查询：过滤条件、三维 PBAC 行级权限与分页**全部下推 SQL**，
   * `total` 与当页数据同口径（此前是"先扫 500 条再在内存里过滤/分页"，
   * 数据量一旦超过扫描上限就会漏数据，见 docs/21 §9 遗留 1）。
   *
   * 状态只接受契约三态 `PendingDefectStatusEnum`：004 建表时的历史词表
   * （`PENDING_REVIEW` / `REVIEWING` / `RESOLVED`）已由迁移 015 归一，
   * 旧值不再被静默映射，由契约校验直接拒绝（400），避免"旧口径悄悄生效"（§9 遗留 3）。
   */
  public async getPendingList(
    query: PendingPoolQuery,
    permissions?: readonly MaterialPermission[]
  ): Promise<{ items: PendingDefectItem[]; total: number }> {
    const stage = query.inspectionType ?? query.sourceStage ?? query.stage;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    return await this.uow.execute(async (ctx) =>
      ctx.pendingDefects.list({
        ...(stage !== undefined && stage !== '' ? { stage } : {}),
        ...(query.materialCode !== undefined && query.materialCode !== ''
          ? { materialCode: query.materialCode }
          : {}),
        ...(query.batchNo !== undefined && query.batchNo !== ''
          ? { batchNo: query.batchNo }
          : {}),
        ...(query.status !== undefined && query.status !== ''
          ? { status: query.status }
          : {}),
        ...(permissions !== undefined ? { permissions } : {}),
        page,
        pageSize,
      })
    );
  }

  public async initiateReview(
    input: InitiateReviewRequest,
    operator?: { userId: string; userName?: string; name?: string },
    security?: ISecurityContext
  ): Promise<InitiateReviewResult> {
    return await this.uow.execute(async (ctx) => {
      // 1. 定位池条目：pendingDefectId 可能是池条目 UUID，也可能是源检验单 UUID/单号
      const poolItem =
        (await ctx.pendingDefects.findById(input.pendingDefectId)) ??
        (await ctx.pendingDefects.findBySourceOrderId(input.pendingDefectId));

      // 2. 定位源检验单
      let order =
        poolItem !== null ? await ctx.inspectionOrders.findById(poolItem.inspectionOrderId) : null;
      if (order === null) {
        order = await ctx.inspectionOrders.findById(input.pendingDefectId);
      }
      if (order === null) {
        order = await ctx.inspectionOrders.findByOrderNo(input.pendingDefectId);
      }
      if (order === null) {
        throw new NotFoundError(`待审核条目或源检验单未找到: ${input.pendingDefectId}`);
      }
      if (order.status === 'IN_MRB_REVIEW') {
        throw new ConflictError(`检验单 ${order.orderNo} 已处于 MRB 评审中，不可重复发起`);
      }

      // 3. 委托 TriggerMrbReviewUseCase 完成强校验与工单生成
      const opId = operator?.userId ?? 'system';
      const opName = operator?.userName ?? operator?.name ?? '质量工程师';
      const trigger = new TriggerMrbReviewUseCase(this.uow);
      const mrb = await trigger.execute(
        {
          inspectionOrderId: order.id ?? input.pendingDefectId,
          applicantId: opId,
          applicantName: opName,
          reason:
            input.reviewNotes ?? `从待审核池发起评审: 检验单 ${order.orderNo} 判定不合格`,
          // 发起弹窗的三个参数全部透传落库（docs/20 §4.2）
          ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
          ...(input.urgencyLevel !== undefined ? { urgencyLevel: input.urgencyLevel } : {}),
          ...(input.reviewNotes !== undefined ? { reviewNotes: input.reviewNotes } : {}),
          // 仅当确认是池条目时才回填外键，避免把检验单 ID 写进 pending_defect_id
          ...(poolItem !== null ? { pendingDefectId: poolItem.id } : {}),
        },
        security
      );

      // 4. 池条目转「已入评审」并回填 MRB 单号（按池条目 ID 或源检验单 ID 定位）
      await ctx.pendingDefects.markInitiated(
        poolItem !== null ? poolItem.id : order.id ?? input.pendingDefectId,
        mrb.id,
        opName
      );

      return {
        ...mrb,
        mrbId: mrb.id,
        reviewNo: mrb.mrbNo,
        success: true,
        message: `已成功从待审核池发起独立评审工单 [${mrb.mrbNo}]`,
      };
    });
  }
}
