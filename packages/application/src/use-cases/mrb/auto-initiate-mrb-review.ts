import type { InspectionOrder, MRBReview as MRBReviewDTO } from '@letian/contracts';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWorkContext } from '../../tx/unit-of-work.js';
import { triggerMrbReviewInTransaction } from './trigger-mrb-review.js';

export interface AutoInitiateMrbReviewOptions {
  /** 拟定处置（落 `mrb_reviews.disposition` 初值），缺省 `REWORK` */
  preliminaryDisposition?: string | undefined;
  /** 发起说明（落 `mrb_reviews.review_notes`） */
  reviewNotes?: string | undefined;
}

export interface AutoInitiateMrbReviewResult {
  mrbReview: MRBReviewDTO;
  /** 本次是否新建了 MRB 单（`false` = 复用同一检验单已有评审，幂等分支） */
  created: boolean;
}

/**
 * 「判定不合格 → 自动发起 MRB 评审」唯一入口（docs/43-不合格判定自动发起MRB评审设计.md §3/§4）。
 *
 * 客户口径：判定不合格**不需要人工发起环节**。因此终判用例在判定为不合格时，于**同一事务**内：
 * 1. 幂等查重（`mrb_reviews.source_order_no` 为天然键）：同一检验单重复终判复用既有 MRB 单，
 *    不产生第二张工单；
 * 2. 未建单则按不合格来源类型自动匹配生效评审流程建单（`TriggerMrbReviewUseCase` 的事务内实现），
 *    由 `trigger` 把检验单推进到 `IN_MRB_REVIEW`；
 * 3. 不合格台账条目转 `INITIATED` 并回填 `mrb_review_id`（池是留痕台账，不再承载人工动作）。
 *
 * 前置条件：`order.status === 'FAILED'`。其余状态（合格 / 归档 / 已在 MRB 评审中 / 返工复检中）
 * 一律返回 `null`，由调用方按「未自动建单」处理 —— 绝不把合格单拖进评审。
 *
 * 幂等性由「先查后建 + `source_order_no` 唯一」双重保证：并发下重复调用最多落一条工单。
 */
export async function autoInitiateMrbReview(
  ctx: IUnitOfWorkContext,
  order: InspectionOrder,
  applicant: { id: string; name: string },
  options: AutoInitiateMrbReviewOptions = {},
  securityCtx?: ISecurityContext
): Promise<AutoInitiateMrbReviewResult | null> {
  // 只有终判不合格的单据自动建单（RE_INSPECTING 等回边状态不触发，避免返工轮次自建评审）
  if (order.status !== 'FAILED') {
    return null;
  }

  const orderId = order.id ?? order.orderNo;

  const existing = await ctx.mrbReviews.findByOrderNo(order.orderNo);
  const mrbReview =
    existing ??
    (await triggerMrbReviewInTransaction(
      ctx,
      {
        inspectionOrderId: orderId,
        applicantId: applicant.id,
        applicantName: applicant.name,
        ...(options.preliminaryDisposition !== undefined
          ? { preliminaryDisposition: options.preliminaryDisposition }
          : {}),
        ...(options.reviewNotes !== undefined ? { reviewNotes: options.reviewNotes } : {}),
      },
      securityCtx
    ));

  // 台账条目转「已入评审」并回填 MRB 单号；markInitiated 同时接受池条目 ID 与源检验单 ID（UUID 守卫）
  await ctx.pendingDefects.markInitiated(orderId, mrbReview.id, applicant.name);

  return { mrbReview, created: existing === null };
}