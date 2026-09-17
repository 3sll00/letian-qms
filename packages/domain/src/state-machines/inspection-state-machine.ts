import { InspectionStatus } from '@letian/contracts';

/**
 * 检验单状态机 (InspectionStateMachine)
 * 严格按照《系统架构设计说明书》第 2.2 节状态转移矩阵与回边规则落地：
 * 
 * 8态闭环：
 * - PENDING: 待检 (初始态)
 * - INSPECTING: 检验中
 * - DRAFT: 暂存草稿
 * - PASSED: 合格放行
 * - FAILED: 检验不合格
 * - IN_MRB_REVIEW: MRB评审中
 * - RE_INSPECTING: 复检/返工中 (MRB REWORK 返工回边)
 * - COMPLETED: 已结单归档 (终态)
 */
export class InspectionStateMachine {
  /**
   * 严格状态转移规则矩阵
   */
  private static readonly ALLOWED_TRANSITIONS: Record<InspectionStatus, readonly InspectionStatus[]> = {
    PENDING: ['INSPECTING', 'DRAFT'],
    INSPECTING: ['PASSED', 'FAILED', 'DRAFT'],
    DRAFT: ['INSPECTING', 'PENDING'],
    PASSED: ['COMPLETED'],
    FAILED: ['IN_MRB_REVIEW', 'COMPLETED'], // 可发起 MRB 评审，或直接判退/报废归档
    IN_MRB_REVIEW: ['PASSED', 'FAILED', 'RE_INSPECTING', 'COMPLETED'], // 会签通过(特采放行)/驳回维持原判/返工复检/直接结单
    RE_INSPECTING: ['INSPECTING', 'PASSED', 'FAILED'], // 返工重检进入新一轮判定
    COMPLETED: [], // 终态，不可再流转
  };

  /**
   * 校验状态转移是否合法
   */
  public static canTransition(from: InspectionStatus, to: InspectionStatus): boolean {
    if (from === to) {
      return true; // 允许同状态幂等
    }
    const allowed = this.ALLOWED_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
  }

  /**
   * 断言状态转移，若非法则抛出领域特定异常
   */
  public static assertTransition(from: InspectionStatus, to: InspectionStatus): void {
    if (!this.canTransition(from, to)) {
      throw new Error(
        `INVALID_INSPECTION_TRANSITION: 非法的质检单状态转移: [${from}] -> [${to}]。当前状态只允许流转至: [${(this.ALLOWED_TRANSITIONS[from] ?? []).join(', ')}]`
      );
    }
  }

  /**
   * 获取某状态的全部后继状态
   */
  public static getNextStates(from: InspectionStatus): readonly InspectionStatus[] {
    return this.ALLOWED_TRANSITIONS[from] ?? [];
  }
}
