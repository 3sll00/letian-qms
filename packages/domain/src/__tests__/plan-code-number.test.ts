import {
  formatInspectionPlanCode,
  INSPECTION_PLAN_CODE_PREFIX,
  MAX_INSPECTION_PLAN_CODE_SEQ,
} from '../services/inspection-plan-number';
import { toLocalDayKey } from '../services/day-key';
import { toInspectionOrderNoDayKey } from '../services/inspection-order-number';

/**
 * 质检方案编码取号规则回归基线（TBD-11）。
 *
 * 锁定：编码形态 `QP-{YYYYMMDD}-{NNN}`（与设计稿 `QP-20260706-001` 同形）、定长补零、
 * 流水号与日期键越界必须显式抛错（不得静默溢出），以及"当日"口径与检验单号完全一致。
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

function runPlanCodeNumberTests(): { total: number; passed: number } {
  let total = 0;
  let passed = 0;
  const check = (label: string, fn: () => void): void => {
    total += 1;
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  };

  check('编码形态为 QP-YYYYMMDD-NNN，与设计稿 QP-20260706-001 同形', () => {
    assert(formatInspectionPlanCode('20260706', 1) === 'QP-20260706-001', '当日第 1 个方案必须为 001');
    assert(
      formatInspectionPlanCode('20260706', 12) === 'QP-20260706-012',
      '当日第 12 个方案必须左补零到 3 位'
    );
    assert(
      formatInspectionPlanCode('20260706', MAX_INSPECTION_PLAN_CODE_SEQ) === 'QP-20260706-999',
      '999 为上限且不得溢出成 4 位'
    );
  });

  check('前缀固定为 QP', () => {
    assert(INSPECTION_PLAN_CODE_PREFIX === 'QP', '方案编码前缀必须为 QP');
    assert(
      formatInspectionPlanCode('20260706', 1).startsWith('QP-'),
      '服务端取号必须以 QP- 开头'
    );
  });

  check('流水号越界必须显式抛错（不静默溢出）', () => {
    assertThrows(
      () => formatInspectionPlanCode('20260706', MAX_INSPECTION_PLAN_CODE_SEQ + 1),
      /PLAN_CODE_SEQ_INVALID/,
      '流水号 1000'
    );
    assertThrows(() => formatInspectionPlanCode('20260706', 0), /PLAN_CODE_SEQ_INVALID/, '流水号 0');
    assertThrows(() => formatInspectionPlanCode('20260706', -1), /PLAN_CODE_SEQ_INVALID/, '负流水号');
    assertThrows(
      () => formatInspectionPlanCode('20260706', 1.5),
      /PLAN_CODE_SEQ_INVALID/,
      '非整数流水号'
    );
  });

  check('日期键必须为 8 位数字', () => {
    assertThrows(() => formatInspectionPlanCode('2026070', 1), /PLAN_CODE_DAY_KEY_INVALID/, '7 位日期键');
    assertThrows(
      () => formatInspectionPlanCode('2026-07-06', 1),
      /PLAN_CODE_DAY_KEY_INVALID/,
      '带分隔符的日期键'
    );
    assertThrows(() => formatInspectionPlanCode('', 1), /PLAN_CODE_DAY_KEY_INVALID/, '空日期键');
  });

  check('本地时区自然日键为定长 YYYYMMDD', () => {
    const key = toLocalDayKey(new Date(2026, 6, 6, 9, 0, 0));
    assert(key === '20260706', `本机 2026-07-06 09:00 必须得到 20260706，实际 [${key}]`);
    assert(key.length === 8, '日期键必须定长 8 位');
  });

  check('同一天不同时刻必须得到同一个日期键（不得退到 UTC 日界）', () => {
    const morning = toLocalDayKey(new Date(2026, 6, 6, 0, 30, 0));
    const noon = toLocalDayKey(new Date(2026, 6, 6, 12, 0, 0));
    const night = toLocalDayKey(new Date(2026, 6, 6, 23, 30, 0));
    assert(morning === '20260706', `本机 00:30 必须仍算 7 月 6 日，实际 [${morning}]`);
    assert(noon === morning, '同一天的正午与凌晨必须得到同一日期键');
    assert(night === morning, '同一天的深夜与凌晨必须得到同一日期键');
    assert(
      toLocalDayKey(new Date(2026, 6, 7, 0, 30, 0)) === '20260707',
      '跨过本地零点后日期键必须递增'
    );
  });

  check('检验单号与方案编码共用同一个日期键口径', () => {
    const d = new Date(2026, 6, 6, 7, 30, 0);
    assert(
      toInspectionOrderNoDayKey(d) === toLocalDayKey(d),
      '两套编号规则的"当日"口径必须完全一致，否则同日两类单据会落在不同日期段'
    );
  });

  return { total, passed };
}

// 自动自执行能力：任一用例失败即抛错，进程以非零退出码失败
const res = runPlanCodeNumberTests();
console.log(`[PASS] Plan Code Number Tests: ${res.passed}/${res.total}`);
