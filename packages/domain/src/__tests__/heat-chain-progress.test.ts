import {
  canTransferToNextStage,
  pickAuthoritativeUpstream,
  resolveChainAnchors,
  type MrbSnapshotLike,
  type TransferGateInput,
  type UpstreamCandidate,
  type UpstreamOrderLike,
} from '../services/transfer-gate-service';
import { predecessorStagesOf, STAGE_SEQUENCE, stageSeqOf } from '../models/stage-sequence';
import { normalizeHeatBatchNo } from '../services/heat-batch-trace-service';

/**
 * 「按炉批号传递进度」链路的领域层回归基线。
 *
 * 用户口径链路：采购入库 → 来料检验(IQC) → 下料检(IPQC_CT) → 滚丝检(IPQC_RL)
 *              → 成品检(IPQC_FN) → 表面处理(OQC_SF) → 出货检(OQC_SH)
 *
 * 与既有 `transfer-gate-service.test.ts` 的分工（不重复）：
 *   - 既有基线锁定「判定矩阵」（上游各种状态 → 放行 / 阻断）；
 *   - 本文件锁定「**链路形状**」：环节阶梯顺序、门禁上游集合、炉批号锚点解析与归一化，
 *     即「这条链到底由哪几个环节、按什么顺序、靠什么键串起来」。
 *
 * 全部使用**真实领域函数**（无 mock）：领域层是纯函数，直接调用即是最真实的单元协作。
 */

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(
    actual === expected,
    `${message} —— 期望 [${String(expected)}]，实际 [${String(actual)}]`
  );
}

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✔ ${name}`);
}

// ---------------------------------------------------------------------------
// 1. 环节阶梯：必须与用户口径的 7 环节一致
// ---------------------------------------------------------------------------
console.log('--- 1. 环节阶梯（采购入库 → 来料 → 下料 → 滚丝 → 成品 → 表面处理 → 出货）---');

test('阶梯序位：IQC(1) < IPQC_CT(2) < IPQC_RL(3) < IPQC_FN(4) < OQC_SF(5) < OQC_SH(6)', () => {
  assertEqual(stageSeqOf('IQC'), 1, '来料检验序位');
  assertEqual(stageSeqOf('IPQC_CT'), 2, '下料检序位');
  assertEqual(stageSeqOf('IPQC_RL'), 3, '滚丝检序位');
  assertEqual(stageSeqOf('IPQC_FN'), 4, '成品检序位');
  assertEqual(stageSeqOf('OQC_SF'), 5, '表面处理（委外）序位');
  assertEqual(stageSeqOf('OQC_SH'), 6, '出货检序位');
});

test('阶梯严格递增（来料 → 下料 → 滚丝 → 成品 → 表面处理 → 出货）', () => {
  const chain = ['IQC', 'IPQC_CT', 'IPQC_RL', 'IPQC_FN', 'OQC_SF', 'OQC_SH'] as const;
  for (let i = 1; i < chain.length; i += 1) {
    assert(
      stageSeqOf(chain[i]!) > stageSeqOf(chain[i - 1]!),
      `${chain[i]} 的序位必须大于 ${chain[i - 1]}`
    );
  }
});

test('委外八类并列（表面处理与热处理/镀锌等互不为上下游）', () => {
  const outsource = ['OQC_SF', 'OQC_HEAT', 'OQC_BLACK', 'OQC_ZINC', 'OQC_NICKEL', 'OQC_PHOSPH', 'OQC_DACRO', 'OQC_MACH'] as const;
  outsource.forEach((type) => assertEqual(stageSeqOf(type), 5, `${type} 应为委外层`));
  // 彼此不互为门禁上游
  outsource.forEach((type) => {
    const preds = predecessorStagesOf(type);
    outsource.forEach((other) => assert(!preds.includes(other), `${type} 的上游不应包含并列的 ${other}`));
  });
});

test('来料检验是链首（无门禁上游，对应「采购入库在 ERP 侧、QMS 不门禁」）', () => {
  assertEqual(predecessorStagesOf('IQC').length, 0, 'IQC 不应有门禁上游环节');
});

test('门禁上游为累计口径（出货检的上游含全部低序位环节）', () => {
  const preds = predecessorStagesOf('OQC_SH');
  ['IQC', 'IPQC_CT', 'IPQC_RL', 'IPQC_FN', 'OQC_SF'].forEach((t) =>
    assert(preds.includes(t as never), `出货检的上游应包含 ${t}`)
  );
  assert(!preds.includes('OQC_SH' as never), '出货检不应把自己列为上游');
});

test('顺序定义单点：STAGE_SEQUENCE 覆盖全部 13 种检验类型', () => {
  assertEqual(Object.keys(STAGE_SEQUENCE).length, 13, '阶梯表应覆盖 13 种检验类型');
});

// ---------------------------------------------------------------------------
// 2. 炉批号锚点：解析与归一化
// ---------------------------------------------------------------------------
console.log('--- 2. 炉批号锚点（A2）解析与归一化 ---');

test('锚点解析：批次 → 炉批号 → 工单，缺失项不产生空锚点', () => {
  const full = resolveChainAnchors({ batchNo: 'B1', furnaceHeatNo: 'HN-1', workOrderNo: 'WO-1' });
  assertEqual(full.length, 3, '三个锚点都应解析出来');
  assertEqual(full[0]!.kind, 'BATCH', '第一优先级是批次');
  assertEqual(full[1]!.kind, 'HEAT', '第二优先级是炉批号');
  assertEqual(full[2]!.kind, 'WORK_ORDER', '第三优先级是工单');
  assertEqual(resolveChainAnchors({ batchNo: 'B1' }).length, 1, '只有批次时不应产生空锚点');
});

test('炉批号归一化：大小写 / 空格 / 连字符写法归一到同一键', () => {
  const variants = ['HN-2026-0001', 'hn-2026-0001', ' HN-2026-0001 ', 'HN 2026 0001', 'hn20260001'];
  const norms = new Set(variants.map((v) => normalizeHeatBatchNo(v)));
  assertEqual(norms.size, 1, `不同写法应归一到同一键，实际得到 ${[...norms].join(' / ')}`);
});

test('炉批号为空时不产生 HEAT 锚点（避免空串把两张无关单据串成一条链）', () => {
  const anchors = resolveChainAnchors({ batchNo: 'B1', furnaceHeatNo: '   ' });
  assertEqual(anchors.length, 1, '空炉批号不应生成锚点');
  assertEqual(anchors[0]!.kind, 'BATCH', '应回落到批次锚点');
});

// ---------------------------------------------------------------------------
// 3. 权威上游取值：三条确定性规则
// ---------------------------------------------------------------------------
console.log('--- 3. 权威上游取值（复检轮次 → 最近终判 → 单号）---');

const order = (
  orderNo: string,
  status: UpstreamOrderLike['status'],
  overallDecision?: UpstreamOrderLike['overallDecision'],
  updatedAt?: string
): UpstreamCandidate => ({
  order: { orderNo, inspectionType: 'IQC', batchNo: 'B1', status, overallDecision, updatedAt, createdAt: updatedAt },
  matchedAnchors: ['HEAT'],
});

test('规则③ 复检轮次最高者胜（即使原单 updatedAt 更新）', () => {
  const picked = pickAuthoritativeUpstream([
    order('IQC-1', 'COMPLETED', 'FAILED', '2026-10-08T10:00:00Z'),
    order('IQC-1-R1', 'COMPLETED', 'PASSED', '2026-10-08T09:00:00Z'),
  ]);
  assertEqual(picked!.order.orderNo, 'IQC-1-R1', '应取复检轮次最高的单');
});

test('规则② 同轮次取最近一次终判（不得取到最旧一条）', () => {
  const picked = pickAuthoritativeUpstream([
    order('IQC-OLD', 'COMPLETED', 'PASSED', '2026-10-08T08:00:00Z'),
    order('IQC-NEW', 'COMPLETED', 'FAILED', '2026-10-08T10:00:00Z'),
  ]);
  assertEqual(picked!.order.orderNo, 'IQC-NEW', '应取最近一次终判');
});

test('空候选集返回 undefined（不得返回 undefined 之外的假值）', () => {
  assertEqual(pickAuthoritativeUpstream([]), undefined, '空候选集应返回 undefined');
});

// ---------------------------------------------------------------------------
// 4. 判定矩阵：沿 7 环节链路逐步推进
// ---------------------------------------------------------------------------
console.log('--- 4. 判定矩阵（沿链路逐环节）---');

function decide(
  stage: UpstreamOrderLike['inspectionType'],
  candidates: UpstreamCandidate[],
  mrbByOrderNo?: ReadonlyMap<string, MrbSnapshotLike>
): ReturnType<typeof canTransferToNextStage> {
  const input: TransferGateInput = {
    stage,
    anchors: [{ kind: 'HEAT', value: 'HN-1' }],
    candidates,
    ...(mrbByOrderNo ? { mrbByOrderNo } : {}),
  };
  return canTransferToNextStage(input);
}

const passedUpstream = order('IQC-1', 'COMPLETED', 'PASSED', '2026-10-08T10:00:00Z');

test('上游合格 → 放行 UPSTREAM_PASSED', () => {
  const d = decide('IPQC_CT', [passedUpstream]);
  assertEqual(d.allowed, true, '应放行');
  assertEqual(d.code, 'UPSTREAM_PASSED', '判定码');
  assertEqual(d.predecessorOrderNo, 'IQC-1', '应指名上游单号');
});

test('链首环节（来料检验）无门禁上游 → NO_PREDECESSOR_STAGE', () => {
  const d = decide('IQC', []);
  assertEqual(d.allowed, true, '链首应放行');
  assertEqual(d.code, 'NO_PREDECESSOR_STAGE', '链首判定码');
});

test('上游检验中 → 阻断 UPSTREAM_INSPECTING', () => {
  const d = decide('IPQC_CT', [order('IQC-1', 'INSPECTING', undefined, '2026-10-08T10:00:00Z')]);
  assertEqual(d.allowed, false, '应阻断');
  assertEqual(d.code, 'UPSTREAM_INSPECTING', '判定码');
});

test('上游不合格且无 MRB → 阻断 UPSTREAM_FAILED', () => {
  const d = decide('IPQC_CT', [order('IQC-1', 'FAILED', 'FAILED', '2026-10-08T10:00:00Z')]);
  assertEqual(d.allowed, false, '应阻断');
  assertEqual(d.code, 'UPSTREAM_FAILED', '判定码');
});

test('无上游单 → 放行但显式标记 UPSTREAM_MISSING（TBD-01）', () => {
  const d = decide('IPQC_CT', []);
  assertEqual(d.allowed, true, '按 TBD-01 放行');
  assertEqual(d.code, 'UPSTREAM_MISSING', '必须显式标记而不是默认合格');
});

test('MRB 让步接收（有授权件）→ 受限放行 UPSTREAM_CONCESSION + 需举证', () => {
  const failed = order('IQC-1', 'IN_MRB_REVIEW', 'FAILED', '2026-10-08T10:00:00Z');
  const mrb = new Map<string, MrbSnapshotLike>([
    ['IQC-1', { mrbNo: 'MRB-1', sourceOrderNo: 'IQC-1', status: 'DISPOSED', disposition: 'CONCESSION', concessionAttachmentUrl: 'https://x/a.pdf' }],
  ]);
  const d = decide('IPQC_CT', [failed], mrb);
  assertEqual(d.allowed, true, '应受限放行');
  assertEqual(d.code, 'UPSTREAM_CONCESSION', '判定码');
  assertEqual(d.permitEvidence.kind, 'MRB_CONCESSION', '凭证类型');
  assertEqual(d.permitEvidence.attachmentRequired, true, '必须要求客户书面授权件');
});

test('MRB 让步接收但缺授权件 → 仍阻断（授权件是放行前提，不是补充说明）', () => {
  const failed = order('IQC-1', 'IN_MRB_REVIEW', 'FAILED', '2026-10-08T10:00:00Z');
  const mrb = new Map<string, MrbSnapshotLike>([
    ['IQC-1', { mrbNo: 'MRB-1', sourceOrderNo: 'IQC-1', status: 'DISPOSED', disposition: 'CONCESSION' }],
  ]);
  const d = decide('IPQC_CT', [failed], mrb);
  assertEqual(d.allowed, false, '缺件应阻断');
  assertEqual(d.code, 'UPSTREAM_FAILED', '判定码');
});

test('MRB 退货 / 报废 → 链路终止 CHAIN_TERMINATED + terminateChain', () => {
  const failed = order('IQC-1', 'IN_MRB_REVIEW', 'FAILED', '2026-10-08T10:00:00Z');
  for (const disposition of ['RETURN_TO_VENDOR', 'SCRAP'] as const) {
    const mrb = new Map<string, MrbSnapshotLike>([
      ['IQC-1', { mrbNo: 'MRB-1', sourceOrderNo: 'IQC-1', status: 'DISPOSED', disposition }],
    ]);
    const d = decide('IPQC_CT', [failed], mrb);
    assertEqual(d.allowed, false, `${disposition} 应阻断`);
    assertEqual(d.code, 'CHAIN_TERMINATED', `${disposition} 判定码`);
    assertEqual(d.terminateChain, true, `${disposition} 应置链路终止标记`);
  }
});

test('复检合格 → UPSTREAM_REWORK_PASSED 且权威上游取复检单（不是原单）', () => {
  const candidates = [
    order('IQC-1', 'RE_INSPECTING', 'FAILED', '2026-10-08T11:00:00Z'),
    order('IQC-1-R1', 'COMPLETED', 'PASSED', '2026-10-08T10:00:00Z'),
  ];
  const d = decide('IPQC_CT', candidates);
  assertEqual(d.allowed, true, '应放行');
  assertEqual(d.code, 'UPSTREAM_REWORK_PASSED', '判定码');
  assertEqual(d.predecessorOrderNo, 'IQC-1-R1', '权威上游必须是复检单');
});

test('多环节上游：任一环节不合格即阻断，且报告最严重理由码', () => {
  const candidates = [
    order('IQC-1', 'COMPLETED', 'PASSED', '2026-10-08T10:00:00Z'),
    { ...order('FN-1', 'FAILED', 'FAILED', '2026-10-08T10:00:00Z'), order: { ...order('FN-1', 'FAILED', 'FAILED').order, inspectionType: 'IPQC_FN' as const } },
  ];
  const d = decide('OQC_SH', candidates);
  assertEqual(d.allowed, false, '任一上游不合格即阻断');
  assertEqual(d.code, 'UPSTREAM_FAILED', '判定码');
});

// ---------------------------------------------------------------------------
// 5. 同炉批号（HEAT）跨物料门禁 —— 用户定稿口径（取代原 TBD-03「只提示不阻断」）
//    紧固件工艺链：盘条 → 毛坯 → 搓丝半成品 → 成品，物料编码随工序变化，
//    所以「按炉批号传递」必须让跨物料上游参与门禁：
//      上游不合格 → 下游不得自动传递；只有 MRB 人工审核放行（让步接收且有授权件）才继续。
// ---------------------------------------------------------------------------
console.log('--- 5. 同炉批号跨物料门禁（HEAT 锚点，物料随工序变化）---');

/** 同炉批号、但物料编码不同的上游候选（crossMaterial=true 由仓储在命中跨物料时标注） */
function crossMaterialUpstream(
  orderNo: string,
  status: UpstreamOrderLike['status'],
  overallDecision?: UpstreamOrderLike['overallDecision'],
  updatedAt: string = '2026-10-08T10:00:00Z'
): UpstreamCandidate {
  return {
    order: { orderNo, inspectionType: 'IQC', batchNo: 'B-DIFF', status, overallDecision, updatedAt, createdAt: updatedAt },
    matchedAnchors: ['HEAT'],
    crossMaterial: true,
  };
}

test('同炉批号跨物料：上游合格 → 放行（跨物料参与了门禁判定）', () => {
  const d = decide('IPQC_CT', [crossMaterialUpstream('IQC-1', 'COMPLETED', 'PASSED')]);
  assertEqual(d.allowed, true, '上游合格应放行');
  assertEqual(d.code, 'UPSTREAM_PASSED', '判定码');
  assertEqual(d.predecessorOrderNo, 'IQC-1', '应指名跨物料上游单');
  assertEqual(d.crossMaterialUpstream, true, '应标注为跨物料上游（可解释性）');
});

test('同炉批号跨物料：上游不合格且无 MRB → 阻断（不再静默放行）', () => {
  const d = decide('IPQC_CT', [crossMaterialUpstream('IQC-1', 'FAILED', 'FAILED')]);
  assertEqual(d.allowed, false, '跨物料上游不合格必须阻断');
  assertEqual(d.code, 'UPSTREAM_FAILED', '判定码');
  assertEqual(d.crossMaterialUpstream, true, '应标注为跨物料上游');
});

test('同炉批号跨物料：上游不合格 + MRB 让步接收（有授权件）→ 受限放行', () => {
  const failed = crossMaterialUpstream('IQC-1', 'IN_MRB_REVIEW', 'FAILED');
  const mrb = new Map<string, MrbSnapshotLike>([
    ['IQC-1', { mrbNo: 'MRB-1', sourceOrderNo: 'IQC-1', status: 'DISPOSED', disposition: 'CONCESSION', concessionAttachmentUrl: 'https://x/a.pdf' }],
  ]);
  const d = decide('IPQC_CT', [failed], mrb);
  assertEqual(d.allowed, true, '人工审核让步接收且有授权件应放行');
  assertEqual(d.code, 'UPSTREAM_CONCESSION', '判定码');
  assertEqual(d.permitEvidence.attachmentRequired, true, '仍须客户书面授权件');
  assertEqual(d.crossMaterialUpstream, true, '应标注为跨物料上游');
});

test('同炉批号跨物料：上游不合格 + MRB 退货/报废 → 链路终止', () => {
  const failed = crossMaterialUpstream('IQC-1', 'IN_MRB_REVIEW', 'FAILED');
  for (const disposition of ['RETURN_TO_VENDOR', 'SCRAP'] as const) {
    const mrb = new Map<string, MrbSnapshotLike>([
      ['IQC-1', { mrbNo: 'MRB-1', sourceOrderNo: 'IQC-1', status: 'DISPOSED', disposition }],
    ]);
    const d = decide('IPQC_CT', [failed], mrb);
    assertEqual(d.allowed, false, `${disposition} 应阻断`);
    assertEqual(d.code, 'CHAIN_TERMINATED', `${disposition} 判定码`);
    assertEqual(d.terminateChain, true, `${disposition} 应置链路终止标记`);
    assertEqual(d.crossMaterialUpstream, true, '应标注为跨物料上游');
  }
});

console.log(`\n[PASS] 按炉批号传递进度 领域层回归基线: ${passed}/${passed}`);
