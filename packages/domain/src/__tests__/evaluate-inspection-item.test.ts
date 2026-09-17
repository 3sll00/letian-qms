import { evaluateInspectionItem } from '../services/tolerance-evaluator';
import { DataType } from '@letian/contracts';

/**
 * 检验项实测值判定回归基线（三态 PASSED / FAILED / PENDING）。
 * 锁定核心安全规则：实测缺失或标准缺失一律 PENDING，严禁静默放行；
 * 公差区间闭区间判定；EPS=1e-9 浮点防护既不错杀浮点误差、也不吞真实超差。
 */

type EvalInput = Parameters<typeof evaluateInspectionItem>[0];

function makeItem(overrides: Partial<EvalInput> = {}): EvalInput {
  return {
    dataType: 'NUMERIC',
    measuredVal: undefined,
    measuredText: undefined,
    nominalValue: undefined,
    upperTolerance: undefined,
    lowerTolerance: undefined,
    standardText: undefined,
    ...overrides,
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

export function runEvaluateInspectionItemTests(): { total: number; passed: number } {
  let passed = 0;
  let total = 0;

  function test(name: string, fn: () => void): void {
    total++;
    try {
      fn();
      passed++;
    } catch (e) {
      console.error(`❌ [Evaluate Test Failed]: ${name}`, e);
      throw e;
    }
  }

  // ===================== 1. 数值型（NUMERIC） =====================

  test('NUMERIC: 公差带内判 PASSED（含上下限边界，闭区间）', () => {
    const base = { nominalValue: 10.0, upperTolerance: 0.2, lowerTolerance: 0.2 };
    assert(evaluateInspectionItem(makeItem({ ...base, measuredVal: 10.1 })) === 'PASSED', '带内应 PASSED');
    assert(evaluateInspectionItem(makeItem({ ...base, measuredVal: 10.2 })) === 'PASSED', '恰好上限应 PASSED');
    assert(evaluateInspectionItem(makeItem({ ...base, measuredVal: 9.8 })) === 'PASSED', '恰好下限应 PASSED');
    assert(evaluateInspectionItem(makeItem({ ...base, measuredVal: 10.0 })) === 'PASSED', '恰好基准值应 PASSED');
  });

  test('NUMERIC: 超出公差带判 FAILED（上下两个方向）', () => {
    const base = { nominalValue: 10.0, upperTolerance: 0.2, lowerTolerance: 0.2 };
    assert(evaluateInspectionItem(makeItem({ ...base, measuredVal: 10.200001 })) === 'FAILED', '超上限应 FAILED');
    assert(evaluateInspectionItem(makeItem({ ...base, measuredVal: 9.799999 })) === 'FAILED', '超下限应 FAILED');
    assert(evaluateInspectionItem(makeItem({ ...base, measuredVal: 11.0 })) === 'FAILED', '严重超上限应 FAILED');
  });

  test('NUMERIC: 单侧公差 —— 缺失的公差缺省为 0（下偏差缺失即不允许低于基准）', () => {
    // lowerTolerance 缺省 0 -> 下限即 nominalValue，低于基准一律 FAILED
    assert(
      evaluateInspectionItem(makeItem({ nominalValue: 10.0, upperTolerance: 0.1, measuredVal: 10.05 })) === 'PASSED',
      '上偏差内应 PASSED'
    );
    assert(
      evaluateInspectionItem(makeItem({ nominalValue: 10.0, upperTolerance: 0.1, measuredVal: 9.95 })) === 'FAILED',
      '下偏差缺省 0，低于基准应 FAILED'
    );
    // upperTolerance 缺省 0 -> 上限即 nominalValue
    assert(
      evaluateInspectionItem(makeItem({ nominalValue: 10.0, lowerTolerance: 0.1, measuredVal: 9.95 })) === 'PASSED',
      '下偏差内应 PASSED'
    );
    assert(
      evaluateInspectionItem(makeItem({ nominalValue: 10.0, lowerTolerance: 0.1, measuredVal: 10.05 })) === 'FAILED',
      '上偏差缺省 0，高于基准应 FAILED'
    );
    // 公差全缺省 -> 仅恰好等于基准值放行
    assert(
      evaluateInspectionItem(makeItem({ nominalValue: 10.0, measuredVal: 10.0 })) === 'PASSED',
      '无公差带时恰等于基准应 PASSED'
    );
    assert(
      evaluateInspectionItem(makeItem({ nominalValue: 10.0, measuredVal: 10.0000001 })) === 'FAILED',
      '无公差带时任何偏离应 FAILED'
    );
  });

  test('NUMERIC: 实测值未录入（undefined / null / NaN）一律 PENDING，严禁放行', () => {
    const base = { nominalValue: 10.0, upperTolerance: 0.2, lowerTolerance: 0.2 };
    assert(evaluateInspectionItem(makeItem({ ...base })) === 'PENDING', '未录入实测值应 PENDING');
    assert(
      evaluateInspectionItem(makeItem({ ...base, measuredVal: null as unknown as number })) === 'PENDING',
      'null 实测值应 PENDING'
    );
    assert(evaluateInspectionItem(makeItem({ ...base, measuredVal: NaN })) === 'PENDING', 'NaN 实测值应 PENDING');
  });

  test('NUMERIC: 缺少标准基准 nominalValue 一律 PENDING（有实测也无法评定）', () => {
    assert(
      evaluateInspectionItem(makeItem({ measuredVal: 10.0, upperTolerance: 0.2, lowerTolerance: 0.2 })) === 'PENDING',
      '缺 nominalValue 应 PENDING'
    );
    assert(
      evaluateInspectionItem(
        makeItem({ measuredVal: 10.0, nominalValue: null as unknown as number, upperTolerance: 0.2 })
      ) === 'PENDING',
      'null nominalValue 应 PENDING'
    );
  });

  test('NUMERIC: EPS=1e-9 浮点防护 —— 浮点运算误差不错杀（0.1+0.7 vs 0.8）', () => {
    // IEEE754 下 0.1 + 0.7 = 0.7999999999999999，与实测 0.8 的偏差 ~1.1e-16，
    // 无 EPS 防护会误判 FAILED；EPS 内必须判 PASSED
    assert(
      evaluateInspectionItem(makeItem({ nominalValue: 0.1, upperTolerance: 0.7, measuredVal: 0.8 })) === 'PASSED',
      '浮点误差范围内应 PASSED'
    );
    assert(
      evaluateInspectionItem(makeItem({ nominalValue: 0.1, lowerTolerance: 0.7, measuredVal: -0.6 })) === 'PASSED',
      '负向浮点误差范围内应 PASSED（0.1-0.7=-0.5999999999999999）'
    );
  });

  test('NUMERIC: EPS 不吞真实超差 —— 偏差明显大于 1e-9 仍判 FAILED', () => {
    assert(
      evaluateInspectionItem(makeItem({ nominalValue: 0.1, upperTolerance: 0.7, measuredVal: 0.800001 })) === 'FAILED',
      '真实超差必须 FAILED（EPS 不得放宽公差带）'
    );
  });

  // ===================== 2. 文本/定性型（TEXT / QUALITATIVE） =====================

  test('TEXT/QUALITATIVE: 两类型行为一致 —— 标准化匹配（去空白+忽略大小写）判 PASSED', () => {
    for (const dataType of ['TEXT', 'QUALITATIVE'] as const) {
      assert(
        evaluateInspectionItem(makeItem({ dataType, standardText: '无裂纹', measuredText: '无裂纹' })) === 'PASSED',
        `${dataType}: 精确匹配应 PASSED`
      );
      assert(
        evaluateInspectionItem(makeItem({ dataType, standardText: 'OK', measuredText: '  ok  ' })) === 'PASSED',
        `${dataType}: 忽略大小写与首尾空白应 PASSED`
      );
    }
  });

  test('TEXT: 多选标准值匹配（支持 , ， / | 分隔符且选项去空白）', () => {
    const standardText = '合格, OK，通过/Pass';
    assert(evaluateInspectionItem(makeItem({ dataType: 'TEXT', standardText, measuredText: '合格' })) === 'PASSED', '中文逗号选项应 PASSED');
    assert(evaluateInspectionItem(makeItem({ dataType: 'TEXT', standardText, measuredText: 'OK' })) === 'PASSED', '英文逗号选项（含空白）应 PASSED');
    assert(evaluateInspectionItem(makeItem({ dataType: 'TEXT', standardText, measuredText: '通过' })) === 'PASSED', '斜杠选项应 PASSED');
    assert(evaluateInspectionItem(makeItem({ dataType: 'TEXT', standardText, measuredText: 'pass' })) === 'PASSED', '竖线选项忽略大小写应 PASSED');
    assert(evaluateInspectionItem(makeItem({ dataType: 'TEXT', standardText, measuredText: 'NG' })) === 'FAILED', '非标准选项必须 FAILED');
  });

  test('TEXT/QUALITATIVE: 实测文本缺失或纯空白一律 PENDING', () => {
    for (const dataType of ['TEXT', 'QUALITATIVE'] as const) {
      assert(
        evaluateInspectionItem(makeItem({ dataType, standardText: '无裂纹' })) === 'PENDING',
        `${dataType}: 未录入实测文本应 PENDING`
      );
      assert(
        evaluateInspectionItem(makeItem({ dataType, standardText: '无裂纹', measuredText: '   ' })) === 'PENDING',
        `${dataType}: 纯空白实测文本应 PENDING`
      );
    }
  });

  test('TEXT/QUALITATIVE: 标准判定语缺失或纯空白一律 PENDING（严禁无标准放行）', () => {
    for (const dataType of ['TEXT', 'QUALITATIVE'] as const) {
      assert(
        evaluateInspectionItem(makeItem({ dataType, measuredText: '无裂纹' })) === 'PENDING',
        `${dataType}: 缺 standardText 应 PENDING`
      );
      assert(
        evaluateInspectionItem(makeItem({ dataType, standardText: '  ', measuredText: '无裂纹' })) === 'PENDING',
        `${dataType}: 空 standardText 应 PENDING`
      );
    }
  });

  test('TEXT/QUALITATIVE: 实测与标准不符判 FAILED', () => {
    assert(
      evaluateInspectionItem(makeItem({ dataType: 'QUALITATIVE', standardText: '无毛刺', measuredText: '有明显毛刺' })) === 'FAILED',
      '定性不符应 FAILED'
    );
  });

  // ===================== 3. 兜底分支 =====================

  test('未知 dataType 一律 PENDING（fail-safe，严禁静默 PASSED）', () => {
    const bogusType = 'OTHER' as unknown as DataType;
    assert(
      evaluateInspectionItem(makeItem({ dataType: bogusType, measuredVal: 10.0, nominalValue: 10.0 })) === 'PENDING',
      '未识别的数据类型必须落入 PENDING 兜底'
    );
  });

  return { total, passed };
}

// 自动自执行能力：任一用例失败即抛错，进程以非零退出码失败
const res = runEvaluateInspectionItemTests();
console.log(`[PASS] Evaluate Inspection Item Tests: ${res.passed}/${res.total}`);
