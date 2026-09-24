/**
 * 「合格后传递」属性测试（fast-check）—— 设计见 docs/48 §4
 *
 * 与既有 state-machine.test.ts 的分工（互补，不替代）：
 * - 既有基线：手写用例枚举「已知边」，改矩阵即红；
 * - 本文件：穷举 + 随机游走，验证「不变式」，把未枚举到的路径组合交给 fast-check 去撞。
 *
 * 五条性质：
 * - P1  转移接口自洽 + 非法转移必抛领域错误码（穷举 8×8 = 64 个状态对）
 * - P2  合格后不可改判（PASSED 之后只允许出现 COMPLETED）
 * - P2b 合格必经检验（自 PENDING 出发，出现 PASSED 之前必须出现过 INSPECTING）
 * - P3  终态吸收（COMPLETED 无非自身出边，且到达即为路径终点）
 * - P4  不合格不可静默放行（FAILED 之后回到 PASSED，必经 IN_MRB_REVIEW）
 * - P5  无死锁 + 可达性（非终态至少 1 条出边；全部状态自 PENDING 可达）
 *
 * 附加：变异自检（故意注入 7 处缺陷，验证上述护栏「必红」），防止护栏退化为空转。
 *
 * 运行：pnpm --filter @letian/domain exec tsx src/__tests__/inspection-state-machine.property.test.ts
 * 复现：FC_SEED=<失败报告中的 seed> FC_RUNS=400 重跑即可命中同一反例。
 * 失败输出：最小化反例（起点 + 意图序列 + 实际路径）+ 随机种子。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { InspectionStatus } from '@letian/contracts';
import { InspectionStateMachine } from '../state-machines/inspection-state-machine';

/** 8 态全集（与源码状态机注释同序） */
const ALL_STATUSES = [
  'PENDING',
  'INSPECTING',
  'DRAFT',
  'PASSED',
  'FAILED',
  'IN_MRB_REVIEW',
  'RE_INSPECTING',
  'COMPLETED',
] as const satisfies readonly InspectionStatus[];

/** 终态：到达即不可再流转（同态幂等除外） */
const TERMINAL_STATES = ['COMPLETED'] as const satisfies readonly InspectionStatus[];

/** 判定态：检验结论的两个出口 */
const VERDICT_STATES = ['PASSED', 'FAILED'] as const satisfies readonly InspectionStatus[];

/** 「判合格」的合法入口态：须经检验 / MRB 裁决 / 返工复检 */
const VERDICT_ENTRY_STATES = [
  'INSPECTING',
  'IN_MRB_REVIEW',
  'RE_INSPECTING',
] as const satisfies readonly InspectionStatus[];

const DOMAIN_ERROR_CODE = 'INVALID_INSPECTION_TRANSITION';

const NUM_RUNS = Number(process.env.FC_RUNS ?? 400);
const MAX_STEPS = Number(process.env.FC_MAX_STEPS ?? 25);
const SEED = process.env.FC_SEED === undefined ? undefined : Number(process.env.FC_SEED);

/** 状态机最小契约：真实实现与「变异实现」共用同一套性质断言 */
interface MachineLike {
  canTransition(from: InspectionStatus, to: InspectionStatus): boolean;
  getNextStates(from: InspectionStatus): readonly InspectionStatus[];
  assertTransition(from: InspectionStatus, to: InspectionStatus): void;
}

const REAL_MACHINE: MachineLike = {
  canTransition: (from, to) => InspectionStateMachine.canTransition(from, to),
  getNextStates: from => InspectionStateMachine.getNextStates(from),
  assertTransition: (from, to) => InspectionStateMachine.assertTransition(from, to),
};

type Matrix = Record<InspectionStatus, readonly InspectionStatus[]>;

/** 由「转移矩阵」构造状态机实现（仅用于变异自检） */
function machineFromMatrix(matrix: Matrix): MachineLike {
  function canTransition(from: InspectionStatus, to: InspectionStatus): boolean {
    if (from === to) return true; // 同状态幂等
    const allowed = matrix[from];
    return allowed === undefined ? false : allowed.includes(to);
  }

  return {
    canTransition,
    getNextStates: from => matrix[from] ?? [],
    assertTransition: (from, to) => {
      if (!canTransition(from, to)) {
        throw new Error(`INVALID_INSPECTION_TRANSITION: 非法的质检单状态转移: [${from}] -> [${to}]`);
      }
    },
  };
}

/** 以真实状态机的公开 API 重建基矩阵（不复制源码常量，避免双真相） */
const BASE_MATRIX: Matrix = {
  PENDING: InspectionStateMachine.getNextStates('PENDING'),
  INSPECTING: InspectionStateMachine.getNextStates('INSPECTING'),
  DRAFT: InspectionStateMachine.getNextStates('DRAFT'),
  PASSED: InspectionStateMachine.getNextStates('PASSED'),
  FAILED: InspectionStateMachine.getNextStates('FAILED'),
  IN_MRB_REVIEW: InspectionStateMachine.getNextStates('IN_MRB_REVIEW'),
  RE_INSPECTING: InspectionStateMachine.getNextStates('RE_INSPECTING'),
  COMPLETED: InspectionStateMachine.getNextStates('COMPLETED'),
};

function withEdge(base: Matrix, from: InspectionStatus, to: InspectionStatus): Matrix {
  return { ...base, [from]: [...base[from], to] };
}

function withoutEdge(base: Matrix, from: InspectionStatus, to: InspectionStatus): Matrix {
  return { ...base, [from]: base[from].filter(next => next !== to) };
}

function at(list: readonly InspectionStatus[], index: number): InspectionStatus {
  const value = list[index];
  if (value === undefined) {
    throw new Error(`内部错误：路径下标越界 ${index}（长度 ${list.length}）`);
  }
  return value;
}

function isTerminal(status: InspectionStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

interface WalkResult {
  /** 按合法边依次前进得到的实际路径（含起点） */
  readonly path: readonly InspectionStatus[];
  /** 被状态机拒绝的操作数（不改变路径，仅计数） */
  readonly rejected: number;
}

interface WalkContext {
  readonly start: InspectionStatus;
  readonly intents: readonly InspectionStatus[];
  readonly path: readonly InspectionStatus[];
}

/**
 * 按意图序列在状态机上「施压」：合法则前进，非法则被拒（计数后跳过），同态视为无操作。
 * 这样既能持续探索合法路径，也不会因单次非法操作中断随机游走。
 */
function walk(
  machine: MachineLike,
  start: InspectionStatus,
  intents: readonly InspectionStatus[]
): WalkResult {
  const path: InspectionStatus[] = [start];
  let current = start;
  let rejected = 0;

  for (const intent of intents) {
    if (intent === current) continue; // 同态幂等：无操作
    if (!machine.canTransition(current, intent)) {
      rejected += 1;
      continue;
    }
    path.push(intent);
    current = intent;
  }

  return { path, rejected };
}

function violation(property: string, detail: string, context: WalkContext): never {
  throw new Error(
    `${property} 违反：${detail}\n` +
      `      起点    : ${context.start}\n` +
      `      意图序列: ${context.intents.join(' -> ')}\n` +
      `      实际路径: ${context.path.join(' -> ')}`
  );
}

/** P1 转移接口自洽（穷举 64 对）+ 非法转移必抛领域错误码 */
function assertP1(machine: MachineLike): number {
  let checked = 0;

  for (const from of ALL_STATUSES) {
    const nextStates = machine.getNextStates(from);

    for (const to of ALL_STATUSES) {
      checked += 1;
      const expected = to === from || nextStates.includes(to);
      const actual = machine.canTransition(from, to);

      if (actual !== expected) {
        throw new Error(
          `P1 转移接口自洽违反：canTransition(${from}, ${to}) 应为 ${expected}，实际 ${actual}（canTransition 与 getNextStates 不一致，存在旁路）`
        );
      }

      let thrown: string | null = null;
      try {
        machine.assertTransition(from, to);
      } catch (e) {
        thrown = e instanceof Error ? e.message : String(e);
      }

      if (expected && thrown !== null) {
        throw new Error(`P1 违反：合法转移 (${from} -> ${to}) 竟抛出：[${thrown}]`);
      }
      if (!expected && thrown === null) {
        throw new Error(`P1 违反：非法转移 (${from} -> ${to}) 未抛出任何错误`);
      }
      if (!expected && thrown !== null && !thrown.includes(DOMAIN_ERROR_CODE)) {
        throw new Error(
          `P1 违反：非法转移 (${from} -> ${to}) 抛出的错误码不含 ${DOMAIN_ERROR_CODE}，实际：[${thrown}]`
        );
      }
    }
  }

  return checked;
}

/** P2 合格后不可改判 */
function assertP2(context: WalkContext, machine: MachineLike): void {
  void machine;
  const firstPassed = context.path.indexOf('PASSED');
  if (firstPassed === -1) return;

  for (let i = firstPassed + 1; i < context.path.length; i += 1) {
    const later = at(context.path, i);
    if (later !== 'COMPLETED') {
      violation('P2 合格后不可改判', `PASSED 之后出现了 [${later}]，只允许 COMPLETED`, context);
    }
  }
}

/** P2b 合格必经检验 */
function assertP2b(context: WalkContext): void {
  if (context.start !== 'PENDING') return;

  const firstPassed = context.path.indexOf('PASSED');
  if (firstPassed === -1) return;

  const firstInspecting = context.path.indexOf('INSPECTING');
  if (firstInspecting === -1 || firstInspecting > firstPassed) {
    violation('P2b 合格必经检验', '未经 INSPECTING 即出现 PASSED（跳过检验直接判合格）', context);
  }
}

/** P3 终态吸收 */
function assertP3(context: WalkContext): void {
  const completedAt = context.path.indexOf('COMPLETED');
  if (completedAt === -1) return;

  if (completedAt !== context.path.length - 1) {
    violation(
      'P3 终态吸收',
      `COMPLETED 之后仍流转到 [${at(context.path, context.path.length - 1)}]`,
      context
    );
  }
}

/** P4 不合格不可静默放行 */
function assertP4(context: WalkContext): void {
  const failedAt = context.path.indexOf('FAILED');
  if (failedAt === -1) return;

  const passedAt = context.path.findIndex(
    (status, index) => index > failedAt && status === 'PASSED'
  );
  if (passedAt === -1) return;

  const mrbAt = context.path.findIndex(
    (status, index) => index > failedAt && index < passedAt && status === 'IN_MRB_REVIEW'
  );
  if (mrbAt === -1) {
    violation('P4 不合格不可静默放行', 'FAILED 之后未经 IN_MRB_REVIEW 即回到 PASSED', context);
  }
}

/** P5 无死锁 + 可达性 */
function assertP5(machine: MachineLike): void {
  for (const status of ALL_STATUSES) {
    if (isTerminal(status)) continue;
    const outgoing = machine.getNextStates(status).filter(next => next !== status);
    if (outgoing.length === 0) {
      throw new Error(`P5 无死锁违反：非终态 [${status}] 没有任何出边，单据将永久卡死`);
    }
  }

  const reachable = new Set<InspectionStatus>(['PENDING']);
  const queue: InspectionStatus[] = ['PENDING'];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const next of machine.getNextStates(current)) {
      if (next === current || reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }

  const unreachable = ALL_STATUSES.filter(status => !reachable.has(status));
  if (unreachable.length > 0) {
    throw new Error(
      `P5 可达性违反：以下状态自 PENDING 不可达（孤岛）-> [${unreachable.join(', ')}]`
    );
  }
  if (!reachable.has('COMPLETED')) {
    throw new Error('P5 可达性违反：PENDING 无法到达终态 COMPLETED，单据无法结单');
  }
}

/** 变异自检：注入的缺陷必须被「指定护栏」拦下，否则该护栏为空转 */
function expectViolation(name: string, expectedMarker: string, run: () => void): void {
  let message: string | null = null;
  try {
    run();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }

  if (message === null) {
    throw new Error(`自检失败：变异「${name}」未被任何护栏拦截 —— 护栏不具备证伪能力`);
  }
  if (!message.includes(expectedMarker)) {
    throw new Error(
      `自检失败：变异「${name}」虽被拦截，但拦截者不是预期护栏 [${expectedMarker}]，实际消息：${message}`
    );
  }
}

/** 诊断（非断言）：判定态入边清单 + 基线显式覆盖缺口 */
function reportDiagnostics(): void {
  console.log('\n【诊断·非断言】判定态入边清单');
  for (const target of VERDICT_STATES) {
    const sources = ALL_STATUSES.filter(
      from => from !== target && InspectionStateMachine.canTransition(from, target)
    );
    const unexpected = sources.filter(from => !VERDICT_ENTRY_STATES.includes(from));
    console.log(`  ${target} 的入边: ${sources.join(', ') || '(无)'}`);
    console.log(
      `    非「检验入口态」来源: ${unexpected.join(', ') || '(无 —— 全部来自检验/MRB/返工态)'}`
    );
  }

  console.log('\n【诊断·非断言】矩阵边 vs 既有基线显式覆盖（state-machine.test.ts）');
  const baselinePath = join(__dirname, 'state-machine.test.ts');
  let baselineSource: string;
  try {
    baselineSource = readFileSync(baselinePath, 'utf8');
  } catch {
    console.log(`  ⚠️ 未找到基线文件 ${baselinePath}，跳过覆盖缺口比对`);
    return;
  }

  const asserted = new Set<string>();
  const pattern = /InspectionStateMachine\.assertTransition\('(\w+)',\s*'(\w+)'\)/g;
  for (const match of baselineSource.matchAll(pattern)) {
    asserted.add(`${match[1]} -> ${match[2]}`);
  }

  const gaps: string[] = [];
  let edges = 0;
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      if (from === to || !InspectionStateMachine.canTransition(from, to)) continue;
      edges += 1;
      const edge = `${from} -> ${to}`;
      if (!asserted.has(edge)) gaps.push(edge);
    }
  }

  console.log(`  矩阵非自反边 ${edges} 条；基线显式覆盖 ${asserted.size} 条`);
  console.log(`  矩阵允许但基线未显式覆盖: ${gaps.length === 0 ? '(无)' : gaps.join(' ; ')}`);
}

export function runPropertyTests(): { total: number; passed: number } {
  let total = 0;
  let passed = 0;

  function runOptions(): { numRuns: number; seed?: number } {
    return SEED === undefined ? { numRuns: NUM_RUNS } : { numRuns: NUM_RUNS, seed: SEED };
  }

  function test(name: string, fn: () => void): void {
    total += 1;
    try {
      fn();
      passed += 1;
      console.log(`  ✅ ${name}`);
    } catch (e) {
      console.error(`❌ [合格后传递 属性测试失败]: ${name}`);
      if (e instanceof Error) console.error(e.message);
      throw e;
    }
  }

  const statusArbitrary = fc.constantFrom(...ALL_STATUSES);

  test(
    `P1 转移接口自洽 + 非法必抛领域错误码（穷举 ${ALL_STATUSES.length}×${ALL_STATUSES.length} = 64 对）`,
    () => {
      const checked = assertP1(REAL_MACHINE);
      if (checked !== 64) {
        throw new Error(`P1 覆盖数异常：预期 64 个状态对，实际 ${checked}`);
      }
    }
  );

  test(`P2/P2b/P3 自 PENDING 出发随机游走（${NUM_RUNS} 次 × ≤${MAX_STEPS} 步）`, () => {
    fc.assert(
      fc.property(
        fc.array(statusArbitrary, { minLength: 1, maxLength: MAX_STEPS }),
        (intents: readonly InspectionStatus[]) => {
          const result = walk(REAL_MACHINE, 'PENDING', intents);
          const context: WalkContext = { start: 'PENDING', intents, path: result.path };
          assertP2(context, REAL_MACHINE);
          assertP2b(context);
          assertP3(context);
        }
      ),
      runOptions()
    );
  });

  test(`P2/P3/P4 任意起点随机游走（${NUM_RUNS} 次 × ≤${MAX_STEPS} 步）`, () => {
    fc.assert(
      fc.property(
        statusArbitrary,
        fc.array(statusArbitrary, { minLength: 1, maxLength: MAX_STEPS }),
        (start: InspectionStatus, intents: readonly InspectionStatus[]) => {
          const result = walk(REAL_MACHINE, start, intents);
          const context: WalkContext = { start, intents, path: result.path };
          assertP2(context, REAL_MACHINE);
          assertP3(context);
          assertP4(context);
        }
      ),
      runOptions()
    );
  });

  test(`P4 自 FAILED 出发随机游走强化（${NUM_RUNS} 次 × ≤${MAX_STEPS * 2} 步）`, () => {
    fc.assert(
      fc.property(
        fc.array(statusArbitrary, { minLength: 1, maxLength: MAX_STEPS * 2 }),
        (intents: readonly InspectionStatus[]) => {
          const result = walk(REAL_MACHINE, 'FAILED', intents);
          const context: WalkContext = { start: 'FAILED', intents, path: result.path };
          assertP4(context);
          assertP2(context, REAL_MACHINE);
          assertP3(context);
        }
      ),
      runOptions()
    );
  });

  test('P5 无死锁 + 可达性（全部状态自 PENDING 可达、非终态均有出边）', () => {
    assertP5(REAL_MACHINE);
  });

  test('变异自检：注入 7 处缺陷，验证 P1~P5 护栏均「必红」', () => {
    const mtSkipInspection = machineFromMatrix(withEdge(BASE_MATRIX, 'PENDING', 'PASSED'));
    expectViolation('PENDING → PASSED（跳过检验直接判合格）', 'P2b 合格必经检验', () => {
      const result = walk(mtSkipInspection, 'PENDING', ['PASSED']);
      assertP2b({ start: 'PENDING', intents: ['PASSED'], path: result.path });
    });

    const mtPassedRollback = machineFromMatrix(withEdge(BASE_MATRIX, 'PASSED', 'INSPECTING'));
    expectViolation('PASSED → INSPECTING（合格后回退重检）', 'P2 合格后不可改判', () => {
      const result = walk(mtPassedRollback, 'PASSED', ['INSPECTING']);
      assertP2({ start: 'PASSED', intents: ['INSPECTING'], path: result.path }, mtPassedRollback);
    });

    const mtTerminalLeak = machineFromMatrix(withEdge(BASE_MATRIX, 'COMPLETED', 'INSPECTING'));
    expectViolation('COMPLETED → INSPECTING（终态流出）', 'P3 终态吸收', () => {
      const result = walk(mtTerminalLeak, 'COMPLETED', ['INSPECTING']);
      assertP3({ start: 'COMPLETED', intents: ['INSPECTING'], path: result.path });
    });

    const mtFailedToPassed = machineFromMatrix(withEdge(BASE_MATRIX, 'FAILED', 'PASSED'));
    expectViolation('FAILED → PASSED（不合格直接改判合格）', 'P4 不合格不可静默放行', () => {
      const result = walk(mtFailedToPassed, 'FAILED', ['PASSED']);
      assertP4({ start: 'FAILED', intents: ['PASSED'], path: result.path });
    });

    const mtDraftDeadEnd = machineFromMatrix({ ...BASE_MATRIX, DRAFT: [] });
    expectViolation('DRAFT 出边全删（单据卡死）', 'P5 无死锁违反', () => {
      assertP5(mtDraftDeadEnd);
    });

    const mtMrbOrphan = machineFromMatrix(withoutEdge(BASE_MATRIX, 'FAILED', 'IN_MRB_REVIEW'));
    expectViolation('FAILED → IN_MRB_REVIEW 删除（MRB 不可达）', 'P5 可达性违反', () => {
      assertP5(mtMrbOrphan);
    });

    const base = machineFromMatrix(BASE_MATRIX);
    const mtBypass: MachineLike = {
      canTransition: (from, to) =>
        (from === 'PENDING' && to === 'COMPLETED') || base.canTransition(from, to),
      getNextStates: base.getNextStates,
      assertTransition: base.assertTransition,
    };
    expectViolation('PENDING → COMPLETED 旁路（canTransition 与矩阵不一致）', 'P1 转移接口自洽违反', () => {
      assertP1(mtBypass);
    });
  });

  return { total, passed };
}

reportDiagnostics();

const result = runPropertyTests();
console.log(`\n[PASS] 合格后传递 属性测试: ${result.passed}/${result.total}`);
