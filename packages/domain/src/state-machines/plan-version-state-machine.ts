import { PlanVersionStatus } from '@letian/contracts';

/**
 * 质检方案版本状态机 (PlanVersionStateMachine)
 * 3态管理：DRAFT (草稿) -> ACTIVE (激活生效) -> INACTIVE (归档停用)
 */
export class PlanVersionStateMachine {
  private static readonly ALLOWED_TRANSITIONS: Record<PlanVersionStatus, readonly PlanVersionStatus[]> = {
    DRAFT: ['ACTIVE', 'INACTIVE'], // 草稿可直接发布生效或废弃
    ACTIVE: ['INACTIVE'], // 生效版本可退役停用
    INACTIVE: [], // 停用归档后不可逆
  };

  public static canTransition(from: PlanVersionStatus, to: PlanVersionStatus): boolean {
    if (from === to) {
      return true;
    }
    const allowed = this.ALLOWED_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
  }

  public static assertTransition(from: PlanVersionStatus, to: PlanVersionStatus): void {
    if (!this.canTransition(from, to)) {
      throw new Error(
        `INVALID_PLAN_VERSION_TRANSITION: 质检方案版本非法状态流转: [${from}] -> [${to}]。允许后继: [${(this.ALLOWED_TRANSITIONS[from] ?? []).join(', ')}]`
      );
    }
  }
}
