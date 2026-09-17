import {
  InspectionStatus,
  MRBStatus,
  MRBDisposition,
  PlanVersionStatus,
} from '@letian/contracts';
import { InspectionStateMachine } from '../state-machines/inspection-state-machine';
import { MRBStateMachine } from '../state-machines/mrb-state-machine';
import { PlanVersionStateMachine } from '../state-machines/plan-version-state-machine';

/**
 * 状态机回归基线：全部期望值由当前源码转移矩阵推导（见各 ALLOWED_TRANSITIONS）。
 * 锁定：合法迁移、非法迁移抛领域错误码、同状态幂等（含终态）、返工回边、终态语义。
 */

const ALL_INSPECTION_STATUSES: readonly InspectionStatus[] = [
  'PENDING',
  'INSPECTING',
  'DRAFT',
  'PASSED',
  'FAILED',
  'IN_MRB_REVIEW',
  'RE_INSPECTING',
  'COMPLETED',
];

const INSPECTION_MATRIX: Record<InspectionStatus, readonly InspectionStatus[]> = {
  PENDING: ['INSPECTING', 'DRAFT'],
  INSPECTING: ['PASSED', 'FAILED', 'DRAFT'],
  DRAFT: ['INSPECTING', 'PENDING'],
  PASSED: ['COMPLETED'],
  FAILED: ['IN_MRB_REVIEW', 'COMPLETED'],
  IN_MRB_REVIEW: ['PASSED', 'FAILED', 'RE_INSPECTING', 'COMPLETED'],
  RE_INSPECTING: ['INSPECTING', 'PASSED', 'FAILED'],
  COMPLETED: [],
};

const ALL_MRB_STATUSES: readonly MRBStatus[] = [
  'PENDING_REVIEW',
  'UNDER_REVIEW',
  'DISPOSED',
  'REJECTED',
];

const MRB_MATRIX: Record<MRBStatus, readonly MRBStatus[]> = {
  PENDING_REVIEW: ['UNDER_REVIEW', 'REJECTED'],
  UNDER_REVIEW: ['DISPOSED', 'REJECTED'],
  DISPOSED: [],
  REJECTED: ['PENDING_REVIEW'],
};

const ALL_PLAN_STATUSES: readonly PlanVersionStatus[] = ['DRAFT', 'ACTIVE', 'INACTIVE'];

const PLAN_MATRIX: Record<PlanVersionStatus, readonly PlanVersionStatus[]> = {
  DRAFT: ['ACTIVE', 'INACTIVE'],
  ACTIVE: ['INACTIVE'],
  INACTIVE: [],
};

const ALL_DISPOSITIONS: readonly MRBDisposition[] = [
  'RETURN_TO_VENDOR',
  'REWORK',
  'CONCESSION',
  'SCRAP',
];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

/** 期望抛错并以指定错误码开头/包含；未抛或错误码不符均视为失败 */
function assertThrows(fn: () => void, codePattern: RegExp, label: string): Error {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!codePattern.test(msg)) {
      throw new Error(`${label}: 抛出的错误码不符，期望匹配 [${codePattern}]，实际消息: ${msg}`);
    }
    return e as Error;
  }
  throw new Error(`${label}: 期望抛错 [${codePattern}]，但实际未抛出`);
}

export function runStateMachineTests(): { total: number; passed: number } {
  let passed = 0;
  let total = 0;

  function test(name: string, fn: () => void): void {
    total++;
    try {
      fn();
      passed++;
    } catch (e) {
      console.error(`❌ [State Machine Test Failed]: ${name}`, e);
      throw e;
    }
  }

  // ===================== 1. 检验单状态机（8 态闭环） =====================

  test('Inspection: 转移矩阵全覆盖（每态的合法后继与 getNextStates 一致）', () => {
    for (const from of ALL_INSPECTION_STATUSES) {
      const expected = INSPECTION_MATRIX[from];
      const next = InspectionStateMachine.getNextStates(from);
      assert(
        next.length === expected.length && expected.every(s => next.includes(s)),
        `getNextStates(${from}) 应为 [${expected.join(',')}]，实际 [${next.join(',')}]`
      );
      for (const to of ALL_INSPECTION_STATUSES) {
        const allowed = InspectionStateMachine.canTransition(from, to);
        if (to === from) {
          assert(allowed, `canTransition(${from}, ${to}) 同状态幂等必须为 true`);
        } else {
          assert(
            allowed === expected.includes(to),
            `canTransition(${from}, ${to}) 应为 ${expected.includes(to)}，实际 ${allowed}`
          );
        }
      }
    }
  });

  test('Inspection: 同状态幂等断言不抛错（含终态 COMPLETED）', () => {
    for (const s of ALL_INSPECTION_STATUSES) {
      InspectionStateMachine.assertTransition(s, s); // 严禁抛错
    }
  });

  test('Inspection: 常规合格链 PENDING -> INSPECTING -> PASSED -> COMPLETED', () => {
    InspectionStateMachine.assertTransition('PENDING', 'INSPECTING');
    InspectionStateMachine.assertTransition('INSPECTING', 'PASSED');
    InspectionStateMachine.assertTransition('PASSED', 'COMPLETED');
  });

  test('Inspection: 返工回边 FAILED -> IN_MRB_REVIEW -> RE_INSPECTING -> INSPECTING -> PASSED', () => {
    InspectionStateMachine.assertTransition('FAILED', 'IN_MRB_REVIEW');
    InspectionStateMachine.assertTransition('IN_MRB_REVIEW', 'RE_INSPECTING'); // MRB 返工回边
    InspectionStateMachine.assertTransition('RE_INSPECTING', 'INSPECTING'); // 返工后重检
    InspectionStateMachine.assertTransition('INSPECTING', 'PASSED');
  });

  test('Inspection: MRB 各裁决出口（特采放行/驳回维持原判/直接结单）', () => {
    InspectionStateMachine.assertTransition('IN_MRB_REVIEW', 'PASSED'); // 会签通过特采放行
    InspectionStateMachine.assertTransition('IN_MRB_REVIEW', 'FAILED'); // 驳回维持不合格
    InspectionStateMachine.assertTransition('IN_MRB_REVIEW', 'COMPLETED'); // 直接结单
  });

  test('Inspection: FAILED 可不经 MRB 直接判退/报废归档', () => {
    InspectionStateMachine.assertTransition('FAILED', 'COMPLETED');
  });

  test('Inspection: 草稿暂存与回退 PENDING -> DRAFT -> PENDING / DRAFT -> INSPECTING', () => {
    InspectionStateMachine.assertTransition('PENDING', 'DRAFT');
    InspectionStateMachine.assertTransition('DRAFT', 'PENDING');
    InspectionStateMachine.assertTransition('DRAFT', 'INSPECTING');
    InspectionStateMachine.assertTransition('INSPECTING', 'DRAFT');
  });

  test('Inspection: 非法迁移抛 INVALID_INSPECTION_TRANSITION', () => {
    const illegal: Array<[InspectionStatus, InspectionStatus]> = [
      ['PENDING', 'COMPLETED'], // 严禁跳单归档
      ['PENDING', 'PASSED'],
      ['PENDING', 'FAILED'],
      ['PENDING', 'IN_MRB_REVIEW'],
      ['PENDING', 'RE_INSPECTING'],
      ['INSPECTING', 'COMPLETED'],
      ['INSPECTING', 'IN_MRB_REVIEW'],
      ['INSPECTING', 'RE_INSPECTING'],
      ['DRAFT', 'PASSED'],
      ['DRAFT', 'FAILED'],
      ['DRAFT', 'COMPLETED'],
      ['PASSED', 'FAILED'], // 合格单严禁回退不合格
      ['PASSED', 'INSPECTING'],
      ['FAILED', 'PASSED'], // 不合格严禁直接翻供为合格
      ['FAILED', 'RE_INSPECTING'], // 必须经 MRB 评审才能返工
      ['IN_MRB_REVIEW', 'INSPECTING'], // 评审中严禁绕过重检队列
      ['IN_MRB_REVIEW', 'PENDING'],
      ['RE_INSPECTING', 'COMPLETED'], // 重检未完成严禁结单
      ['RE_INSPECTING', 'IN_MRB_REVIEW'],
      ['COMPLETED', 'PENDING'], // 终态不可逆
      ['COMPLETED', 'INSPECTING'],
      ['COMPLETED', 'FAILED'],
    ];
    for (const [from, to] of illegal) {
      assert(
        !InspectionStateMachine.canTransition(from, to),
        `canTransition(${from}, ${to}) 必须为 false`
      );
      const err = assertThrows(
        () => InspectionStateMachine.assertTransition(from, to),
        /INVALID_INSPECTION_TRANSITION/,
        `assertTransition(${from}, ${to})`
      );
      assert(
        err.message.includes(from) && err.message.includes(to),
        `错误消息应包含起止状态 [${from}]->[${to}]，实际: ${err.message}`
      );
    }
  });

  test('Inspection: 终态语义 COMPLETED 无任何后继', () => {
    assert(InspectionStateMachine.getNextStates('COMPLETED').length === 0, 'COMPLETED 后继必须为空');
    for (const to of ALL_INSPECTION_STATUSES) {
      if (to === 'COMPLETED') continue;
      assert(
        !InspectionStateMachine.canTransition('COMPLETED', to),
        `终态 COMPLETED 严禁流转至 ${to}`
      );
    }
  });

  // ===================== 2. MRB 评审状态机（4 态闭环） =====================

  test('MRB: 转移矩阵全覆盖', () => {
    for (const from of ALL_MRB_STATUSES) {
      const expected = MRB_MATRIX[from];
      for (const to of ALL_MRB_STATUSES) {
        const allowed = MRBStateMachine.canTransition(from, to);
        if (to === from) {
          assert(allowed, `canTransition(${from}, ${to}) 同状态幂等必须为 true`);
        } else {
          assert(
            allowed === expected.includes(to),
            `canTransition(${from}, ${to}) 应为 ${expected.includes(to)}，实际 ${allowed}`
          );
        }
      }
    }
  });

  test('MRB: 正常会签链 PENDING_REVIEW -> UNDER_REVIEW -> DISPOSED', () => {
    MRBStateMachine.assertTransition('PENDING_REVIEW', 'UNDER_REVIEW');
    MRBStateMachine.assertTransition('UNDER_REVIEW', 'DISPOSED');
  });

  test('MRB: 驳回-重提回边 UNDER_REVIEW -> REJECTED -> PENDING_REVIEW -> UNDER_REVIEW -> DISPOSED', () => {
    MRBStateMachine.assertTransition('UNDER_REVIEW', 'REJECTED');
    MRBStateMachine.assertTransition('REJECTED', 'PENDING_REVIEW'); // 驳回后允许重新提交
    MRBStateMachine.assertTransition('PENDING_REVIEW', 'UNDER_REVIEW');
    MRBStateMachine.assertTransition('UNDER_REVIEW', 'DISPOSED');
  });

  test('MRB: 待评审可直接驳回 PENDING_REVIEW -> REJECTED', () => {
    MRBStateMachine.assertTransition('PENDING_REVIEW', 'REJECTED');
  });

  test('MRB: 非法迁移抛 INVALID_MRB_TRANSITION（含终态 DISPOSED 不可逆）', () => {
    const illegal: Array<[MRBStatus, MRBStatus]> = [
      ['PENDING_REVIEW', 'DISPOSED'], // 严禁未经会签直接处置
      ['UNDER_REVIEW', 'PENDING_REVIEW'],
      ['DISPOSED', 'PENDING_REVIEW'],
      ['DISPOSED', 'UNDER_REVIEW'],
      ['DISPOSED', 'REJECTED'],
      ['REJECTED', 'UNDER_REVIEW'],
      ['REJECTED', 'DISPOSED'],
    ];
    for (const [from, to] of illegal) {
      assert(!MRBStateMachine.canTransition(from, to), `canTransition(${from}, ${to}) 必须为 false`);
      assertThrows(
        () => MRBStateMachine.assertTransition(from, to),
        /INVALID_MRB_TRANSITION/,
        `assertTransition(${from}, ${to})`
      );
    }
  });

  test('MRB: 特采 CONCESSION 必须附带客户签核凭证，否则抛 MRB_CONCESSION_REQUIRES_CUSTOMER_APPROVAL', () => {
    assertThrows(
      () => MRBStateMachine.validateDispositionRules('CONCESSION', undefined),
      /MRB_CONCESSION_REQUIRES_CUSTOMER_APPROVAL/,
      'CONCESSION 无凭证'
    );
    assertThrows(
      () => MRBStateMachine.validateDispositionRules('CONCESSION', ''),
      /MRB_CONCESSION_REQUIRES_CUSTOMER_APPROVAL/,
      'CONCESSION 空串凭证'
    );
    assertThrows(
      () => MRBStateMachine.validateDispositionRules('CONCESSION', '   '),
      /MRB_CONCESSION_REQUIRES_CUSTOMER_APPROVAL/,
      'CONCESSION 纯空白凭证'
    );
    MRBStateMachine.validateDispositionRules('CONCESSION', '/uploads/customer-sign.pdf'); // 有凭证不抛错
  });

  test('MRB: 非特采处置方式无需客户凭证', () => {
    for (const d of ALL_DISPOSITIONS) {
      if (d === 'CONCESSION') continue;
      MRBStateMachine.validateDispositionRules(d, undefined); // 严禁抛错
    }
  });

  // ===================== 3. 质检方案版本状态机（3 态） =====================

  test('PlanVersion: 转移矩阵全覆盖', () => {
    for (const from of ALL_PLAN_STATUSES) {
      const expected = PLAN_MATRIX[from];
      for (const to of ALL_PLAN_STATUSES) {
        const allowed = PlanVersionStateMachine.canTransition(from, to);
        if (to === from) {
          assert(allowed, `canTransition(${from}, ${to}) 同状态幂等必须为 true`);
        } else {
          assert(
            allowed === expected.includes(to),
            `canTransition(${from}, ${to}) 应为 ${expected.includes(to)}，实际 ${allowed}`
          );
        }
      }
    }
  });

  test('PlanVersion: 发布生效与退役 DRAFT -> ACTIVE -> INACTIVE，终态不可逆', () => {
    PlanVersionStateMachine.assertTransition('DRAFT', 'ACTIVE');
    PlanVersionStateMachine.assertTransition('ACTIVE', 'INACTIVE');
    PlanVersionStateMachine.assertTransition('DRAFT', 'INACTIVE'); // 草稿可直接废弃
    assertThrows(
      () => PlanVersionStateMachine.assertTransition('INACTIVE', 'ACTIVE'),
      /INVALID_PLAN_VERSION_TRANSITION/,
      'INACTIVE -> ACTIVE'
    );
    assertThrows(
      () => PlanVersionStateMachine.assertTransition('ACTIVE', 'DRAFT'),
      /INVALID_PLAN_VERSION_TRANSITION/,
      'ACTIVE -> DRAFT'
    );
  });

  return { total, passed };
}

// 自动自执行能力：任一用例失败即抛错，进程以非零退出码失败
const res = runStateMachineTests();
console.log(`[PASS] State Machine Tests: ${res.passed}/${res.total}`);
