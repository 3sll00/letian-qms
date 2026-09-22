import { nextInspectionPlanVersionNo } from '../services/inspection-plan-version-number';

/**
 * 质检方案版本号升位规则回归基线（TBD-14）。
 *
 * 锁定：以数值最大的现有版本号为基线、递增最后一段、保留前缀写法与段数、
 * 撞号继续递增、不可解析时回退 `V1.0`。这是「升版」路由唯一的编号口径。
 */

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

/** 期望抛错且消息匹配指定错误码；未抛或错误码不符均视为失败 */
function assertThrows(fn: () => void, codePattern: RegExp, label: string): void {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!codePattern.test(msg)) {
      throw new Error(`${label}: 抛出的错误码不符，期望匹配 [${codePattern}]，实际消息: ${msg}`);
    }
    return;
  }
  throw new Error(`${label}: 期望抛错 [${codePattern}]，但实际未抛出`);
}

function runPlanVersionNumberTests(): { total: number; passed: number } {
  let total = 0;
  let passed = 0;
  const check = (label: string, fn: () => void): void => {
    total += 1;
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  };

  check('两段版本号递增最后一段（v2.4 / v2.5 之后为 v2.6，与种子数据同形）', () => {
    assert(
      nextInspectionPlanVersionNo(['v2.4', 'v2.5']) === 'v2.6',
      'v2.5 之后必须为 v2.6'
    );
    assert(nextInspectionPlanVersionNo(['v2.4']) === 'v2.5', '单个 v2.4 之后必须为 v2.5');
    assert(nextInspectionPlanVersionNo(['V1.0']) === 'V1.1', 'V1.0 之后必须为 V1.1');
  });

  check('保留原前缀写法（不得把 V 改写成 v，也不得凭空加前缀）', () => {
    assert(nextInspectionPlanVersionNo(['V1.0']) === 'V1.1', '大写 V 必须保留');
    assert(nextInspectionPlanVersionNo(['v1.0']) === 'v1.1', '小写 v 必须保留');
    assert(nextInspectionPlanVersionNo(['1.0']) === '1.1', '无前缀形态必须保留为无前缀');
  });

  check('三段版本号递增 patch 位', () => {
    assert(nextInspectionPlanVersionNo(['v1.0.0']) === 'v1.0.1', 'v1.0.0 之后必须为 v1.0.1');
    assert(nextInspectionPlanVersionNo(['v1.2.9']) === 'v1.2.10', 'patch 位进位不得跳号');
  });

  check('段数不同时按数值比较取最大（v2 大于 v1.9）', () => {
    assert(
      nextInspectionPlanVersionNo(['v1.9', 'v2']) === 'v3',
      'v2 必须大于 v1.9（短的一方按 0 补位比较）'
    );
    assert(
      nextInspectionPlanVersionNo(['v1.0', 'v1.0.0']) === 'v1.0.1',
      'v1.0.0 与 v1.0 数值相等时必须取段数更多的那条为基线'
    );
  });

  check('输入顺序无关：乱序同样取数值最大者为基线', () => {
    assert(
      nextInspectionPlanVersionNo(['v3.0', 'v1.1', 'v2.5']) === 'v3.1',
      '乱序输入的基线必须是 v3.0'
    );
    assert(nextInspectionPlanVersionNo(['v9']) === 'v10', '单位数段位必须能进位成两位');
  });

  check('结果撞号时继续递增，直到不与现有版本号冲突', () => {
    assert(nextInspectionPlanVersionNo(['V1.0']) === 'V1.1', '回退基线 V1.0 被占用时必须给 V1.1');
    assert(
      nextInspectionPlanVersionNo(['V1.0', 'V1.1']) === 'V1.2',
      '连续占用时必须继续递增到空位'
    );
    assert(
      nextInspectionPlanVersionNo(['v1.0', 'v1.1', 'v1.2']) === 'v1.3',
      '不得与库中已占用的编号重号'
    );
    assert(nextInspectionPlanVersionNo(['v2.5', 'v2.6']) === 'v2.7', '基线已是最大时正常升位');
  });

  check('撞号判定忽略大小写与首尾空白（V1.0 与 v1.0 是同一个版本）', () => {
    assert(
      nextInspectionPlanVersionNo(['v1.0', 'V1.0']) === 'v1.1',
      '同值不同大小写的版本号必须视为已占用，不得产出重复编号'
    );
    assert(
      nextInspectionPlanVersionNo([' V1.0 ']) === 'V1.1',
      '首尾空白必须被忽略，V1.0 仍算已占用'
    );
  });

  check('全部不可解析（人工命名）时从 V1.0 起，且仍做撞号递增', () => {
    assert(nextInspectionPlanVersionNo(['草稿A']) === 'V1.0', '不可解析时必须回退 V1.0');
    assert(nextInspectionPlanVersionNo([]) === 'V1.0', '空列表必须回退 V1.0');
    assert(
      nextInspectionPlanVersionNo(['V1.0', '草稿A']) === 'V1.1',
      '回退值撞号时必须继续递增'
    );
  });

  check('非数组输入显式抛错，不得静默产出脏版本号', () => {
    assertThrows(
      () => nextInspectionPlanVersionNo(undefined as unknown as string[]),
      /PLAN_VERSION_NO_INPUT_INVALID/,
      '非数组输入'
    );
  });

  return { total, passed };
}

// 自动自执行能力：任一用例失败即抛错，进程以非零退出码失败
const res = runPlanVersionNumberTests();
console.log(`[PASS] Plan Version Number Tests: ${res.passed}/${res.total}`);
