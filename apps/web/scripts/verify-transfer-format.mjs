/**
 * 「合格后传递」展示口径校验（回归守门，纯函数、无浏览器）
 *
 * 口径唯一真相：docs/48-合格后传递通用链路规则设计与改造方案.md
 *   §4.7（口径下沉 `lib/transferGateFormat.ts`，由 `apps/web/scripts/verify-*.mjs` 断言）
 *   §8 硬约束 6（**前端禁用不算数**，以服务端 422 为唯一判据）
 *   §7 TBD-01（`UPSTREAM_MISSING` = 放行但上游缺失，必须显式标注，不得显示成"一切正常"）
 *   docs/24 §8 验收口径 1（缺值一律 —，不得用空串 / 占位串）
 *
 * 为什么需要它：这些都是"数据结构完全合法、只是结论错了"的口径问题 ——
 * 类型检查与契约校验都拦不住，一旦被改回"看起来也行"的写法，只能靠现场评审发现。
 *
 * 运行：pnpm --filter @letian/web verify:transfer-format
 * 通过 Vite SSR 加载器跑**真实前端源码**（与构建相同的 @letian/* 别名解析）。
 */
import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

let failed = 0;
function check(label, condition, extra) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${label}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`);
}

try {
  const {
    TRANSFER_GATE_LABEL,
    TRANSFER_GATE_TONE,
    CHAIN_STATE_LABEL,
    CHAIN_STATE_TONE,
    gateUpstreamText,
    permitEvidenceText,
    ledgerTransferBadge,
  } = await server.ssrLoadModule('/src/lib/transferGateFormat.ts');
  const { TransferGateCodeEnum, ChainStageStateEnum, InspectionTypeEnum } = await server.ssrLoadModule(
    '@letian/contracts'
  );

  const gateCodes = TransferGateCodeEnum.options;
  const chainStates = ChainStageStateEnum.options;

  console.log('一、枚举覆盖：新增理由码 / 环节状态时界面不得漏译');
  const missingLabels = gateCodes.filter((code) => typeof TRANSFER_GATE_LABEL[code] !== 'string');
  const missingTones = gateCodes.filter((code) => TRANSFER_GATE_TONE[code] === undefined);
  check(`理由码全覆盖（${gateCodes.length} 个取值，无 undefined 文案）`, missingLabels.length === 0, missingLabels);
  check(`理由码色板全覆盖（无 undefined 徽标样式）`, missingTones.length === 0, missingTones);
  const missingStateLabels = chainStates.filter((state) => typeof CHAIN_STATE_LABEL[state] !== 'string');
  const missingStateTones = chainStates.filter((state) => CHAIN_STATE_TONE[state] === undefined);
  check(`链路状态全覆盖（${chainStates.length} 个取值）`, missingStateLabels.length === 0, missingStateLabels);
  check('链路状态色板全覆盖', missingStateTones.length === 0, missingStateTones);

  console.log('\n二、TBD-01：放行但上游缺失必须显式标注（不得画成"一切正常"）');
  check(
    'UPSTREAM_MISSING 文案含「缺失」二字',
    TRANSFER_GATE_LABEL.UPSTREAM_MISSING.includes('缺失'),
    TRANSFER_GATE_LABEL.UPSTREAM_MISSING
  );
  check(
    'UPSTREAM_MISSING 的色板与「上游合格」不同（灰 vs 绿，不误导为已放行）',
    TRANSFER_GATE_TONE.UPSTREAM_MISSING.badge !== TRANSFER_GATE_TONE.UPSTREAM_PASSED.badge,
    { missing: TRANSFER_GATE_TONE.UPSTREAM_MISSING.badge, passed: TRANSFER_GATE_TONE.UPSTREAM_PASSED.badge }
  );
  check(
    '阻断态色板与放行态不同（不得把阻断画成绿色）',
    TRANSFER_GATE_TONE.UPSTREAM_FAILED.badge !== TRANSFER_GATE_TONE.UPSTREAM_PASSED.badge &&
      CHAIN_STATE_TONE.BLOCKED.badge !== CHAIN_STATE_TONE.RELEASED.badge
  );

  console.log('\n三、缺值纪律：没有判定就是 —，绝不默认「允许」（docs/24 §8 口径 1）');
  check('null -> 不给徽标（界面显示 —）', ledgerTransferBadge(null) === null);
  check('undefined -> 不给徽标', ledgerTransferBadge(undefined) === null);
  check('空对象（旧后端 / withTransfer=false 未回填）-> 不给徽标', ledgerTransferBadge({}) === null);
  check('canTransfer 为 null -> 不给徽标', ledgerTransferBadge({ canTransfer: null }) === null);

  console.log('\n四、未知理由码：原样回显，绝不替服务端猜一个理由');
  const unknown = ledgerTransferBadge({ canTransfer: true, transferCode: 'BRAND_NEW_CODE' });
  check('unknown code -> 文案标明「服务端未给判定码」', unknown !== null && unknown.label.includes('未给判定码'), unknown?.label);
  check('unknown code -> tip 保留原始码（便于对码排查）', unknown !== null && unknown.tip.includes('BRAND_NEW_CODE'), unknown?.tip);
  check('unknown code 且放行 -> 不得误判为阻断', unknown !== null && unknown.blocked === false);

  console.log('\n五、台账徽标：指得出被谁挡 + 前端禁用不算数（硬约束 6）');
  const blocked = ledgerTransferBadge({
    canTransfer: false,
    transferCode: 'UPSTREAM_FAILED',
    chainKey: 'BATCH-TEST-001',
    blockedBy: { code: 'UPSTREAM_FAILED', stage: 'IQC', orderNo: 'IQC-20260923-0001', status: 'FAILED' },
  });
  check('被阻断 -> blocked = true（界面据此置灰）', blocked !== null && blocked.blocked === true);
  check(
    'tip 指出被谁挡：上游环节 + 单号 + 状态',
    blocked !== null &&
      blocked.tip.includes('[IQC]') &&
      blocked.tip.includes('IQC-20260923-0001') &&
      blocked.tip.includes('FAILED'),
    blocked?.tip
  );
  check('tip 给出判定码原文', blocked !== null && blocked.tip.includes('判定码：UPSTREAM_FAILED'));
  check(
    'tip 明示「拦截以服务端 422 为准」（前端置灰只是提示）',
    blocked !== null && blocked.tip.includes('以服务端 422 为准'),
    blocked?.tip
  );
  check('tip 带出链路锚点（便于现场对号）', blocked !== null && blocked.tip.includes('BATCH-TEST-001'));

  const missing = ledgerTransferBadge({ canTransfer: true, transferCode: 'UPSTREAM_MISSING' });
  check(
    'UPSTREAM_MISSING 放行 -> blocked = false 且 tip 说明按 TBD-01 放行留痕',
    missing !== null && missing.blocked === false && missing.tip.includes('TBD-01'),
    missing?.tip
  );

  console.log('\n六、闸门一句话与放行凭证（特采 / 返工必须可举证）');
  const gateBlockedText = gateUpstreamText({
    allowed: false,
    code: 'UPSTREAM_FAILED',
    stage: 'IPQC_CT',
    chainKey: 'BATCH-X',
    chainKeyKind: 'BATCH',
    precedentStage: 'IQC',
    predecessorOrderNo: 'IQC-20260923-0002',
    predecessorStatus: 'FAILED',
    permitEvidence: { kind: 'NONE', attachmentRequired: false },
    terminateChain: false,
    reason: '上游不合格',
  });
  check('阻断文案含「被上游」+ 单号 + 状态 + 「阻断」', gateBlockedText.includes('被上游') && gateBlockedText.includes('IQC-20260923-0002') && gateBlockedText.includes('FAILED') && gateBlockedText.includes('阻断'), gateBlockedText);

  const gateMissingText = gateUpstreamText({
    allowed: true,
    code: 'UPSTREAM_MISSING',
    stage: 'IPQC_CT',
    chainKey: 'BATCH-X',
    chainKeyKind: 'BATCH',
    permitEvidence: { kind: 'NONE', attachmentRequired: false },
    terminateChain: false,
    reason: '未找到上游',
  });
  check('上游缺失放行文案写明「按 TBD-01 放行并留痕」', gateMissingText.includes('TBD-01'), gateMissingText);

  const concession = permitEvidenceText({
    allowed: true,
    code: 'UPSTREAM_CONCESSION',
    stage: 'OQC_SH',
    chainKey: 'BATCH-X',
    chainKeyKind: 'BATCH',
    permitEvidence: { kind: 'MRB_CONCESSION', mrbNo: 'MRB-001', attachmentRequired: true },
    terminateChain: false,
    reason: '让步接收',
  });
  check('特采凭证文案含 MRB 单号 + 「须可举证客户书面授权件」', concession.includes('MRB-001') && concession.includes('客户书面授权件'), concession);

  const rework = permitEvidenceText({
    allowed: true,
    code: 'UPSTREAM_REWORK_PASSED',
    stage: 'OQC_SH',
    chainKey: 'BATCH-X',
    chainKeyKind: 'BATCH',
    permitEvidence: { kind: 'REWORK_REINSPECTION', orderNo: 'INS-20260924-0001-R1', attachmentRequired: false },
    terminateChain: false,
    reason: '返工复检合格',
  });
  check('返工凭证文案含复检单号', rework.includes('INS-20260924-0001-R1'), rework);

  check(
    '无凭证（NONE）不输出空壳文案（界面留白，不写"放行凭证：—"）',
    permitEvidenceText({
      allowed: true,
      code: 'UPSTREAM_PASSED',
      stage: 'OQC_SH',
      chainKey: 'BATCH-X',
      chainKeyKind: 'BATCH',
      permitEvidence: { kind: 'NONE', attachmentRequired: false },
      terminateChain: false,
      reason: '合格',
    }) === ''
  );

  check('契约枚举非空（防止枚举被清空后本脚本假通过）', gateCodes.length === 12 && chainStates.length === 5 && InspectionTypeEnum.options.length >= 13,
    { codes: gateCodes.length, states: chainStates.length, types: InspectionTypeEnum.options.length });
} finally {
  await server.close();
}

console.log(
  failed === 0
    ? '\n== PASS：「合格后传递」展示口径校验全部通过 =='
    : `\n== FAIL：${failed} 条口径断言未通过 ==`
);
process.exit(failed === 0 ? 0 : 1);
