import { MRBStatus, MRBDisposition } from '@letian/contracts';

/**
 * MRB 不合格品会签评审状态机 (MRBStateMachine)
 * 4态流转：PENDING_REVIEW -> UNDER_REVIEW -> DISPOSED / REJECTED
 */
export class MRBStateMachine {
  private static readonly ALLOWED_TRANSITIONS: Record<MRBStatus, readonly MRBStatus[]> = {
    PENDING_REVIEW: ['UNDER_REVIEW', 'REJECTED'],
    UNDER_REVIEW: ['DISPOSED', 'REJECTED'],
    DISPOSED: [], // 终态
    REJECTED: ['PENDING_REVIEW'], // 驳回后允许重新提交
  };

  public static canTransition(from: MRBStatus, to: MRBStatus): boolean {
    if (from === to) {
      return true;
    }
    const allowed = this.ALLOWED_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
  }

  public static assertTransition(from: MRBStatus, to: MRBStatus): void {
    if (!this.canTransition(from, to)) {
      throw new Error(
        `INVALID_MRB_TRANSITION: 非法的 MRB 评审状态转移: [${from}] -> [${to}]。允许后继: [${(this.ALLOWED_TRANSITIONS[from] ?? []).join(', ')}]`
      );
    }
  }

  /**
   * 业务强约束判定：当处置方式为特采 (CONCESSION) 时，校验是否满足审批通过准入条件
   */
  public static validateDispositionRules(disposition: MRBDisposition, customerApprovalUrl?: string): void {
    if (disposition === 'CONCESSION') {
      if (!customerApprovalUrl || customerApprovalUrl.trim().length === 0) {
        throw new Error(`MRB_CONCESSION_REQUIRES_CUSTOMER_APPROVAL: 特采放行 (CONCESSION) 必须上传并关联客户代表签核凭证 (customerApprovalUrl)`);
      }
    }
  }
}
