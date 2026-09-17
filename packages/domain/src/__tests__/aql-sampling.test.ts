import { calculateAQLSampling, InspectionLevel, SamplingResult } from '../services/aql-sampler';

/**
 * GB/T 2828.1 抽样方案计算回归基线。
 * 所有期望值均按当前源码三张表（样本量字码表 / 样本量表 / Ac-Re 判定表）逐项推导，非照抄历史用例。
 * 锁定：非法批量显式抛错、正常组合的字码/样本量/Ac/Re、默认参数（水平 II / AQL 1.5）、
 * 小批量样本量封顶，以及字码表外组合必须显式失败（AQL_COMBINATION_UNSUPPORTED）。
 */

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

/** 期望抛错且消息匹配指定错误码；未抛或错误码不符均视为失败 */
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

/** 全字段断言抽样结果 */
function assertSampling(
  actual: SamplingResult,
  expected: { codeLetter: string; sampleSize: number; ac: number; re: number },
  label: string
): void {
  const { codeLetter, sampleSize, ac, re } = expected;
  assert(actual.codeLetter === codeLetter, `${label}: codeLetter 期望 [${codeLetter}]，实际 [${actual.codeLetter}]`);
  assert(actual.sampleSize === sampleSize, `${label}: sampleSize 期望 [${sampleSize}]，实际 [${actual.sampleSize}]`);
  assert(actual.ac === ac, `${label}: ac 期望 [${ac}]，实际 [${actual.ac}]`);
  assert(actual.re === re, `${label}: re 期望 [${re}]，实际 [${actual.re}]`);
}

export function runAQLSamplingTests(): { total: number; passed: number } {
  let passed = 0;
  let total = 0;

  function test(name: string, fn: () => void): void {
    total++;
    try {
      fn();
      passed++;
    } catch (e) {
      console.error(`❌ [AQL Test Failed]: ${name}`, e);
      throw e;
    }
  }

  // ===================== 1. 非法入参显式失败 =====================

  test('batchQty <= 0 抛 AQL_INVALID_BATCH_QTY', () => {
    assertThrows(() => calculateAQLSampling({ batchQty: 0 }), /AQL_INVALID_BATCH_QTY/, 'batchQty=0');
    assertThrows(() => calculateAQLSampling({ batchQty: -100 }), /AQL_INVALID_BATCH_QTY/, 'batchQty=-100');
    const err = assertThrows(
      () => calculateAQLSampling({ batchQty: -100 }),
      /AQL_INVALID_BATCH_QTY/,
      '错误消息应回显批量值'
    );
    assert(err.message.includes('-100'), `错误消息应包含批量值 -100，实际: ${err.message}`);
  });

  // ===================== 2. 黄金组合（以当前表为准） =====================

  test('黄金组合: 150 / II / 1.0 -> 字码 F, n=20, [0,1]', () => {
    assertSampling(
      calculateAQLSampling({ batchQty: 150, inspectionLevel: 'II', aql: 1.0 }),
      { codeLetter: 'F', sampleSize: 20, ac: 0, re: 1 },
      '150/II/1.0'
    );
  });

  test('黄金组合: 10000 / II / 1.0 -> 字码 L, n=200, [5,6]', () => {
    assertSampling(
      calculateAQLSampling({ batchQty: 10000, inspectionLevel: 'II', aql: 1.0 }),
      { codeLetter: 'L', sampleSize: 200, ac: 5, re: 6 },
      '10000/II/1.0'
    );
  });

  test('黄金组合: 500 / II / 1.0 -> 字码 H, n=50, [1,2]', () => {
    assertSampling(
      calculateAQLSampling({ batchQty: 500, inspectionLevel: 'II', aql: 1.0 }),
      { codeLetter: 'H', sampleSize: 50, ac: 1, re: 2 },
      '500/II/1.0'
    );
  });

  test('黄金组合: 1200 / II / 1.0 -> 字码 J, n=80, [2,3]', () => {
    assertSampling(
      calculateAQLSampling({ batchQty: 1200, inspectionLevel: 'II', aql: 1.0 }),
      { codeLetter: 'J', sampleSize: 80, ac: 2, re: 3 },
      '1200/II/1.0'
    );
  });

  // ===================== 3. 小批量可用性与样本量封顶 =====================

  test('batchQty=1 可用: 字码 A, 样本量封顶为 1（不超过批量）, [0,1]', () => {
    assertSampling(
      calculateAQLSampling({ batchQty: 1, inspectionLevel: 'II', aql: 1.0 }),
      { codeLetter: 'A', sampleSize: 1, ac: 0, re: 1 },
      '1/II/1.0'
    );
  });

  test('小批量样本量封顶: 2 件与 8 件均字码 A, 样本量 min(批量, 2)', () => {
    assertSampling(
      calculateAQLSampling({ batchQty: 2, inspectionLevel: 'II', aql: 1.0 }),
      { codeLetter: 'A', sampleSize: 2, ac: 0, re: 1 },
      '2/II/1.0'
    );
    assertSampling(
      calculateAQLSampling({ batchQty: 8, inspectionLevel: 'II', aql: 1.0 }),
      { codeLetter: 'A', sampleSize: 2, ac: 0, re: 1 },
      '8/II/1.0（首档上限边界）'
    );
  });

  // ===================== 4. 边界批量（字码表相邻档位分界） =====================

  test('批量边界: 8->A, 9->B, 15->B, 16->C（II 水平）', () => {
    assert(calculateAQLSampling({ batchQty: 8, inspectionLevel: 'II' }).codeLetter === 'A', '8 应为 A');
    assert(calculateAQLSampling({ batchQty: 9, inspectionLevel: 'II' }).codeLetter === 'B', '9 应为 B');
    assert(calculateAQLSampling({ batchQty: 15, inspectionLevel: 'II' }).codeLetter === 'B', '15 应为 B');
    assert(calculateAQLSampling({ batchQty: 16, inspectionLevel: 'II' }).codeLetter === 'C', '16 应为 C');
  });

  test('批量边界: 150->F, 151->G, 35000->M, 35001->N（II 水平，仅断言字码）', () => {
    assert(calculateAQLSampling({ batchQty: 150, inspectionLevel: 'II' }).codeLetter === 'F', '150 应为 F');
    assert(calculateAQLSampling({ batchQty: 151, inspectionLevel: 'II' }).codeLetter === 'G', '151 应为 G');
    assert(calculateAQLSampling({ batchQty: 35000, inspectionLevel: 'II' }).codeLetter === 'M', '35000 应为 M');
    // 35001 字码 N 无判定数，见下方“显式失败”用例
  });

  // ===================== 5. 默认参数与维度行为 =====================

  test('默认参数: 省略 inspectionLevel 与 aql 时按 II / 1.5 计算（150 -> F, n=20, [1,2]）', () => {
    assertSampling(
      calculateAQLSampling({ batchQty: 150 }),
      { codeLetter: 'F', sampleSize: 20, ac: 1, re: 2 },
      '150/默认参数'
    );
  });

  test('检验水平维度: 150 批量下 S-1->B(n=3), I->D(n=8), II->F(n=20), III->G(n=32)，AQL 1.0', () => {
    const levels: Array<[InspectionLevel, string, number]> = [
      ['S-1', 'B', 3],
      ['I', 'D', 8],
      ['II', 'F', 20],
      ['III', 'G', 32],
    ];
    for (const [level, codeLetter, sampleSize] of levels) {
      const res = calculateAQLSampling({ batchQty: 150, inspectionLevel: level, aql: 1.0 });
      assert(res.codeLetter === codeLetter, `150/${level}: 字码期望 ${codeLetter}，实际 ${res.codeLetter}`);
      assert(res.sampleSize === sampleSize, `150/${level}: 样本量期望 ${sampleSize}，实际 ${res.sampleSize}`);
    }
    assertSampling(
      calculateAQLSampling({ batchQty: 150, inspectionLevel: 'III', aql: 1.0 }),
      { codeLetter: 'G', sampleSize: 32, ac: 1, re: 2 },
      '150/III/1.0'
    );
  });

  test('AQL 维度: 150 / II 下 1.0->[0,1], 1.5->[1,2], 2.5->[1,2], 4.0->[2,3]（字码 F 固定）', () => {
    const cases: Array<[number, number, number]> = [
      [1.0, 0, 1],
      [1.5, 1, 2],
      [2.5, 1, 2],
      [4.0, 2, 3],
    ];
    for (const [aql, ac, re] of cases) {
      const res = calculateAQLSampling({ batchQty: 150, inspectionLevel: 'II', aql });
      assert(res.codeLetter === 'F', `AQL ${aql}: 字码应恒为 F，实际 ${res.codeLetter}`);
      assert(res.ac === ac && res.re === re, `AQL ${aql}: Ac/Re 期望 [${ac},${re}]，实际 [${res.ac},${res.re}]`);
    }
  });

  test('返回结构包含 codeLetter / sampleSize / ac / re 四字段', () => {
    const res = calculateAQLSampling({ batchQty: 150, inspectionLevel: 'II', aql: 1.0 });
    for (const key of ['codeLetter', 'sampleSize', 'ac', 're'] as const) {
      assert(res[key] !== undefined, `返回结果缺少字段 [${key}]`);
    }
  });

  // ===================== 6. 表外组合必须显式失败（已知缺口，严禁静默放行） =====================

  test('字码 N~R 超出判定表: 40000 / II -> 字码 N，抛 AQL_COMBINATION_UNSUPPORTED', () => {
    // 已知缺口：AQL_DECISION_TABLE 仅收录字码 A~M。字码 N（II 水平下批量 35001~150000，
    // III 水平下批量 10001~35000 即落到 N/P）及更大字码的 Ac/Re 待按 GB/T 2828.1-2012 表 2-A 补录。
    // 补录前必须显式抛错（严禁静默回退为零缺陷放行，避免大批量批被错误接收）。
    assertThrows(
      () => calculateAQLSampling({ batchQty: 40000, inspectionLevel: 'II', aql: 1.0 }),
      /AQL_COMBINATION_UNSUPPORTED/,
      '40000/II/1.0（字码 N 未收录判定数）'
    );
    assertThrows(
      () => calculateAQLSampling({ batchQty: 40000, inspectionLevel: 'III', aql: 1.0 }),
      /AQL_COMBINATION_UNSUPPORTED/,
      '40000/III/1.0（字码 P 未收录判定数）'
    );
  });

  test('表外 AQL 值: 150 / II / 0.65 抛 AQL_COMBINATION_UNSUPPORTED', () => {
    // 判定表仅收录 AQL 1.0 / 1.5 / 2.5 / 4.0；其余 AQL 值（如 0.65、6.5）为表外组合，
    // 补录前必须显式失败，与字码缺口同理。
    assertThrows(
      () => calculateAQLSampling({ batchQty: 150, inspectionLevel: 'II', aql: 0.65 }),
      /AQL_COMBINATION_UNSUPPORTED/,
      '150/II/0.65'
    );
    assertThrows(
      () => calculateAQLSampling({ batchQty: 150, inspectionLevel: 'II', aql: 6.5 }),
      /AQL_COMBINATION_UNSUPPORTED/,
      '150/II/6.5'
    );
  });

  return { total, passed };
}

// 自动自执行能力：任一用例失败即抛错，进程以非零退出码失败
const res = runAQLSamplingTests();
console.log(`[PASS] AQL Sampling Tests: ${res.passed}/${res.total}`);
