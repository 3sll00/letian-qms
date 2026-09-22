import {
  LEGACY_OUTSOURCE_NO_PREFIX,
  OUTSOURCE_NO_PREFIX,
  deriveOutsourceNoFromVchCode,
  isConformingOutsourceNo,
  needsErpSampleConfirmation,
  parseOutsourceNo,
  resolveOutsourceNoFromErp,
} from '../services/outsource-reference';

/**
 * 委外加工单号形态口径回归基线（docs/35 §2 / docs/34 §9 M1）。
 *
 * 锁定四件事：
 *  1. 合法形态只有两种（`WWJG-{YYYYMMDD}-{NNN}` 与 `WWJG-{VchCode}`），迁移 028 之前的 `WW-*` 必须判不合规；
 *  2. NULL / 空串属 2023 两条历史行的**既定口径**（ERP 无对账单，不补号），不能判成错误；
 *  3. 适配器对 ERP `DlyndxSC.Number` 只做**原样镜像**，缺失时才按已核对前缀用 VchCode 兜底，且不留编造的单号；
 *  4. 兜底形态必须可被识别出来（`needsErpSampleConfirmation`），便于 ERP 样例到位后定向复核。
 */

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

function runOutsourceReferenceTests(): { total: number; passed: number } {
  let total = 0;
  let passed = 0;
  const check = (label: string, fn: () => void): void => {
    total += 1;
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  };

  check('前缀常量与 ERP 号段一致（WWJG-），旧形态前缀为 WW-', () => {
    assert(OUTSOURCE_NO_PREFIX === 'WWJG-', 'ERP 委外加工单号前缀必须为 WWJG-');
    assert(LEGACY_OUTSOURCE_NO_PREFIX === 'WW-', '迁移 028 之前的旧前缀必须为 WW-');
  });

  check('ERP_NUMBER：WWJG-{YYYYMMDD}-{NNN} 解析出日期段与流水段', () => {
    const parsed = parseOutsourceNo('WWJG-20260706-001');
    assert(parsed.shape === 'ERP_NUMBER', `形态应为 ERP_NUMBER，实际 ${parsed.shape}`);
    assert(parsed.datePart === '20260706', `日期段应为 20260706，实际 ${parsed.datePart}`);
    assert(parsed.sequencePart === '001', `流水段应为 001，实际 ${parsed.sequencePart}`);
    assert(isConformingOutsourceNo('WWJG-20260706-001'), 'ERP 号段形态必须判合规');
    assert(!needsErpSampleConfirmation('WWJG-20260706-001'), '标准号段形态不属待 ERP 核对项');
  });

  check('LEGACY：WW-* 判不合规（迁移 028 之后库内应为 0 行）', () => {
    const parsed = parseOutsourceNo('WW-20260706-001');
    assert(parsed.shape === 'LEGACY', `形态应为 LEGACY，实际 ${parsed.shape}`);
    assert(!isConformingOutsourceNo('WW-20260706-001'), '旧形态必须判不合规');
    assert(parsed.remainder === '20260706-001', `剩余部分应保留原日期与流水段，实际 ${parsed.remainder}`);
  });

  check('EMPTY：NULL / 空串 / 纯空白判合规（2023 历史行既定口径）', () => {
    for (const value of [null, undefined, '', '   ']) {
      assert(parseOutsourceNo(value).shape === 'EMPTY', `[${String(value)}] 应判 EMPTY`);
      assert(isConformingOutsourceNo(value), `[${String(value)}] 必须判合规（属口径允许的空值）`);
    }
  });

  check('DERIVED：WWJG-{VchCode} 前缀合规但标记为待 ERP 样例核对', () => {
    const parsed = parseOutsourceNo('WWJG-1234');
    assert(parsed.shape === 'DERIVED', `形态应为 DERIVED，实际 ${parsed.shape}`);
    assert(parsed.sequencePart === '1234', `流水段应为 VchCode 1234，实际 ${parsed.sequencePart}`);
    assert(parsed.datePart === '', '兜底形态没有日期段，不得凭空补日期');
    assert(isConformingOutsourceNo('WWJG-1234'), '前缀已对齐，应判合规（流水段另计待核对）');
    assert(needsErpSampleConfirmation('WWJG-1234'), '兜底形态必须可被识别为待 ERP 样例核对');
  });

  check('UNKNOWN：前缀对齐但结构不认识的值判不合规（需人工核对来源）', () => {
    for (const value of ['WWJG-ABC', 'WWJG-2026-07', 'XYZ-1', '20260706-001']) {
      assert(parseOutsourceNo(value).shape === 'UNKNOWN', `[${value}] 应判 UNKNOWN`);
      assert(!isConformingOutsourceNo(value), `[${value}] 必须判不合规`);
    }
  });

  check('适配器：ERP Number 原样镜像，绝不改写（含非标准形态）', () => {
    const mirrored = resolveOutsourceNoFromErp({ dispatchNo: 'WWJG-20260706-007', vchCode: '9999' });
    assert(mirrored === 'WWJG-20260706-007', `必须原样镜像 ERP 单号，实际 ${String(mirrored)}`);
    const odd = resolveOutsourceNoFromErp({ dispatchNo: 'WWJG-CUSTOM-1', vchCode: '9999' });
    assert(odd === 'WWJG-CUSTOM-1', `ERP 原值优先于本地拼装，实际 ${String(odd)}`);
  });

  check('适配器：Number 缺失时按 VchCode 兜底，两者都空不编造单号', () => {
    assert(
      resolveOutsourceNoFromErp({ vchCode: '1234' }) === 'WWJG-1234',
      'Number 缺失时应用已核对前缀 + VchCode 兜底'
    );
    assert(resolveOutsourceNoFromErp({}) === null, '两者都空必须返回 null（不编造）');
    assert(resolveOutsourceNoFromErp({ dispatchNo: '  ', vchCode: '  ' }) === null, '纯空白等同缺失');
    assert(deriveOutsourceNoFromVchCode(null) === null, 'VchCode 为 null 必须返回 null');
  });

  check('形态判定对数字段不留隐患（前导零与超长流水都不改写）', () => {
    const parsed = parseOutsourceNo('WWJG-20231010-0003');
    assert(parsed.shape === 'ERP_NUMBER', '流水段前缀零不应影响形态判定');
    assert(parsed.sequencePart === '0003', `流水段必须逐字保留，实际 ${parsed.sequencePart}`);
    assert(parseOutsourceNo('  WWJG-20231010-0003  ').raw === 'WWJG-20231010-0003', '首尾空白应被裁剪');
  });

  return { total, passed };
}

// 自动自执行能力：任一用例失败即抛错，进程以非零退出码失败
const res = runOutsourceReferenceTests();
console.log(`[PASS] Outsource Reference Tests: ${res.passed}/${res.total}`);