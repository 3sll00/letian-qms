import type { InspectionStatus, InspectionType, MRBDisposition, MRBStatus } from '@letian/contracts';
import { predecessorStagesOf, STAGE_SEQUENCE } from '../models/stage-sequence';
import {
  canTransferToNextStage,
  pickAuthoritativeUpstream,
  reinspectionRoundOf,
  resolveChainAnchors,
  type ChainAnchorKind,
  type MrbSnapshotLike,
  type TransferDecision,
  type TransferGateInput,
  type UpstreamCandidate,
  type UpstreamOrderLike,
} from '../services/transfer-gate-service';

/**
 * 「合格后传递」传递门禁口径回归基线（docs/48 §2 / §3 / §6 的纯函数部分）。
 *
 * 锁定八件事，任何一条被改动都会在 `pnpm test` 阶段直接失败：
 *  1. 上游合格才放行；上游不合格且无 MRB 结论一律阻断（AC-01 / AC-02 / AC-03 / AC-04）；
 *  2. 上游「检验中」阻断，未建单「放行 + 留痕」（AC-05 / AC-06）；
 *  3. MRB 三分支：让步接收受限放行、返工需复检合格、退货/报废整链终止（AC-07 ~ AC-13）；
 *  4. 跨批次（同炉批号）/ 跨工单（同工单号）锚点生效（AC-14 / AC-15）；
 *  5. 同环节多张单取「复检轮次最高 → 最近一次终判」，禁止取到最旧一条（AC-16）。
 *
 * 夹具只填本用例关心的字段；`__tests__` 不参与 tsc 构建，字段全集见
 * packages/contracts/src/schemas/inspection.ts 的 InspectionOrderSchema。
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

function upstreamOrder(
  overrides: Partial<UpstreamOrderLike> & { orderNo: string; inspectionType: InspectionType }
): UpstreamOrderLike {
  return {
    batchNo: 'B-TEST-01',
    status: 'COMPLETED' as InspectionStatus,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function candidate(
  order: UpstreamOrderLike,
  matchedAnchors: readonly ChainAnchorKind[] = ['BATCH']
): UpstreamCandidate {
  return { order, matchedAnchors };
}

function mrb(
  overrides: Partial<MrbSnapshotLike> & { mrbNo: string; sourceOrderNo: string; status: MRBStatus }
): MrbSnapshotLike {
  return { ...overrides };
}

function mrbIndex(...reviews: MrbSnapshotLike[]): ReadonlyMap<string, MrbSnapshotLike> {
  return new Map(reviews.map((review) => [review.sourceOrderNo, review]));
}

/** 构造「同批次」门禁入参 */
function sameBatch(
  stage: InspectionType,
  candidates: readonly UpstreamCandidate[],
  extra: Partial<TransferGateInput> = {}
): TransferDecision {
  return canTransferToNextStage({
    stage,
    anchors: [{ kind: 'BATCH', value: 'B-TEST-01' }],
    candidates,
    ...extra,
  });
}

function run(): void {
  // ---------------------------------------------------------------------------
  // 0. 顺序表与锚点解析
  // ---------------------------------------------------------------------------
  assertEqual(STAGE_SEQUENCE.IQC, 1, 'IQC 序位');
  assertEqual(STAGE_SEQUENCE.OQC_SH, 6, 'OQC_SH 序位');
  assertEqual(STAGE_SEQUENCE.OQC_HEAT, STAGE_SEQUENCE.OQC_SF, '委外八类同序位（彼此并列）');
  assert(
    !predecessorStagesOf('OQC_HEAT').includes('OQC_SF'),
    '委外八类彼此不互为上游（热处理不合格不阻断镀锌）'
  );
  assert(
    predecessorStagesOf('OQC_SH').includes('IQC'),
    '出货检验的门禁上游包含来料检验（累计口径，AC-14 前提）'
  );
  assertEqual(predecessorStagesOf('IQC').length, 0, 'IQC 无门禁上游（TBD-08）');
  assertEqual(reinspectionRoundOf('IQC-20260706-0001-R2'), 2, '复检轮次解析');
  assertEqual(reinspectionRoundOf('IQC-20260706-0001'), 0, '非复检单轮次为 0');

  const anchors = resolveChainAnchors({
    batchNo: 'B-01',
    furnaceHeatNo: ' ht-2609-001 ',
    workOrderNo: 'WO-01',
  });
  assertEqual(anchors.length, 3, '三锚点均可解析');
  assertEqual(anchors[1]!.value, 'HT2609001', '炉批号锚点走归一化（大小写/空格/连字符）');

  // ---------------------------------------------------------------------------
  // AC-01 IQC 合格 → IPQC 可开始
  // ---------------------------------------------------------------------------
  const iqcPassed = candidate(
    upstreamOrder({ orderNo: 'IQC-0001', inspectionType: 'IQC', overallDecision: 'PASSED' })
  );
  const ac01 = sameBatch('IPQC_CT', [iqcPassed]);
  assertEqual(ac01.allowed, true, 'AC-01 上游合格放行');
  assertEqual(ac01.code, 'UPSTREAM_PASSED', 'AC-01 理由码');
  assertEqual(ac01.predecessorOrderNo, 'IQC-0001', 'AC-01 携带上游单号');

  // ---------------------------------------------------------------------------
  // AC-02 IQC 不合格（无 MRB）→ IPQC 阻断
  // ---------------------------------------------------------------------------
  const iqcFailed = candidate(
    upstreamOrder({
      orderNo: 'IQC-0002',
      inspectionType: 'IQC',
      status: 'FAILED',
      overallDecision: 'FAILED',
    })
  );
  const ac02 = sameBatch('IPQC_CT', [iqcFailed]);
  assertEqual(ac02.allowed, false, 'AC-02 上游不合格阻断');
  assertEqual(ac02.code, 'UPSTREAM_FAILED', 'AC-02 理由码');
  assertEqual(ac02.predecessorOrderNo, 'IQC-0002', 'AC-02 携带阻断来源单号');

  // ---------------------------------------------------------------------------
  // AC-03 / AC-04 过程检 → 委外；委外 → 出货
  // ---------------------------------------------------------------------------
  const fnPassed = candidate(
    upstreamOrder({ orderNo: 'IPQC-FN-0001', inspectionType: 'IPQC_FN', overallDecision: 'PASSED' })
  );
  assertEqual(sameBatch('OQC_HEAT', [fnPassed]).allowed, true, 'AC-03 成品检合格 → 委外可开始');
  assertEqual(
    sameBatch('OQC_HEAT', [
      candidate(
        upstreamOrder({
          orderNo: 'IPQC-FN-0002',
          inspectionType: 'IPQC_FN',
          status: 'FAILED',
          overallDecision: 'FAILED',
        })
      ),
    ]).allowed,
    false,
    'AC-03 成品检不合格 → 委外阻断'
  );
  assertEqual(
    sameBatch('OQC_SH', [
      candidate(
        upstreamOrder({
          orderNo: 'OQC-HT-0003',
          inspectionType: 'OQC_HEAT',
          status: 'FAILED',
          overallDecision: 'FAILED',
        })
      ),
    ]).allowed,
    false,
    'AC-04 委外不合格 → 出货阻断'
  );

  // ---------------------------------------------------------------------------
  // AC-05 上游检验中 → 阻断
  // ---------------------------------------------------------------------------
  const ac05 = sameBatch('IPQC_CT', [
    candidate(upstreamOrder({ orderNo: 'IQC-0003', inspectionType: 'IQC', status: 'INSPECTING' })),
  ]);
  assertEqual(ac05.allowed, false, 'AC-05 上游检验中阻断');
  assertEqual(ac05.code, 'UPSTREAM_INSPECTING', 'AC-05 理由码');

  // ---------------------------------------------------------------------------
  // AC-06 上游未建单 → 放行 + 留痕（TBD-01）
  // ---------------------------------------------------------------------------
  const ac06 = sameBatch('IPQC_CT', []);
  assertEqual(ac06.allowed, true, 'AC-06 无上游单放行（TBD-01）');
  assertEqual(ac06.code, 'UPSTREAM_MISSING', 'AC-06 留痕理由码');

  // ---------------------------------------------------------------------------
  // AC-07 上游在 MRB 评审中 → 阻断并带 MRB 单号
  // ---------------------------------------------------------------------------
  const ac07 = sameBatch('IPQC_CT', [iqcFailed], {
    mrbByOrderNo: mrbIndex(
      mrb({ mrbNo: 'MRB-0007', sourceOrderNo: 'IQC-0002', status: 'UNDER_REVIEW' })
    ),
  });
  assertEqual(ac07.allowed, false, 'AC-07 MRB 评审中阻断');
  assertEqual(ac07.code, 'UPSTREAM_UNDER_MRB', 'AC-07 理由码');
  assertEqual(ac07.mrbNo, 'MRB-0007', 'AC-07 携带 MRB 单号');

  // ---------------------------------------------------------------------------
  // AC-08 让步接收 → 受限放行；缺客户授权件 → 仍阻断
  // ---------------------------------------------------------------------------
  const ac08a = sameBatch('IPQC_CT', [iqcFailed], {
    mrbByOrderNo: mrbIndex(
      mrb({
        mrbNo: 'MRB-0008',
        sourceOrderNo: 'IQC-0002',
        status: 'DISPOSED',
        disposition: 'CONCESSION' as MRBDisposition,
        concessionAttachmentUrl: '/uploads/customer-sign.pdf',
      })
    ),
  });
  assertEqual(ac08a.allowed, true, 'AC-08 让步接收解锁下游');
  assertEqual(ac08a.code, 'UPSTREAM_CONCESSION', 'AC-08 理由码');
  assertEqual(ac08a.permitEvidence.kind, 'MRB_CONCESSION', 'AC-08 放行凭证类别');
  assertEqual(ac08a.permitEvidence.attachmentRequired, true, 'AC-08 授权件必填标记');

  const ac08b = sameBatch('IPQC_CT', [iqcFailed], {
    mrbByOrderNo: mrbIndex(
      mrb({
        mrbNo: 'MRB-0008',
        sourceOrderNo: 'IQC-0002',
        status: 'DISPOSED',
        disposition: 'CONCESSION' as MRBDisposition,
      })
    ),
  });
  assertEqual(ac08b.allowed, false, 'AC-08 让步接收缺客户授权件仍阻断');

  // ---------------------------------------------------------------------------
  // AC-09 / AC-10 / AC-11 返工分支
  // ---------------------------------------------------------------------------
  const reworkMrb = mrbIndex(
    mrb({
      mrbNo: 'MRB-0009',
      sourceOrderNo: 'IQC-0002',
      status: 'DISPOSED',
      disposition: 'REWORK' as MRBDisposition,
    })
  );
  const ac09 = sameBatch(
    'IPQC_CT',
    [
      iqcFailed,
      candidate(
        upstreamOrder({
          orderNo: 'IQC-0002-R2',
          inspectionType: 'IQC',
          status: 'INSPECTING',
        })
      ),
    ],
    { mrbByOrderNo: reworkMrb }
  );
  assertEqual(ac09.allowed, false, 'AC-09 返工未闭环仍阻断');
  assertEqual(ac09.code, 'UPSTREAM_REINSPECTING', 'AC-09 理由码');
  assertEqual(ac09.predecessorOrderNo, 'IQC-0002-R2', 'AC-09 指向复检轮次');

  const ac10 = sameBatch(
    'IPQC_CT',
    [
      iqcFailed,
      candidate(
        upstreamOrder({
          orderNo: 'IQC-0002-R2',
          inspectionType: 'IQC',
          status: 'COMPLETED',
          overallDecision: 'PASSED',
          updatedAt: '2026-09-20T00:00:00.000Z',
        })
      ),
    ],
    { mrbByOrderNo: reworkMrb }
  );
  assertEqual(ac10.allowed, true, 'AC-10 返工复检合格解锁');
  assertEqual(ac10.code, 'UPSTREAM_REWORK_PASSED', 'AC-10 理由码');
  assertEqual(ac10.predecessorOrderNo, 'IQC-0002-R2', 'AC-10 上游取复检单而不是原单');

  const ac11 = sameBatch(
    'IPQC_CT',
    [
      iqcFailed,
      candidate(
        upstreamOrder({
          orderNo: 'IQC-0002-R2',
          inspectionType: 'IQC',
          status: 'FAILED',
          overallDecision: 'FAILED',
          updatedAt: '2026-09-21T00:00:00.000Z',
        })
      ),
    ],
    { mrbByOrderNo: reworkMrb }
  );
  assertEqual(ac11.allowed, false, 'AC-11 复检再判不合格仍阻断');
  assertEqual(ac11.code, 'UPSTREAM_FAILED', 'AC-11 理由码');

  // ---------------------------------------------------------------------------
  // AC-12 / AC-13 退货 / 报废 → 整链终止
  // ---------------------------------------------------------------------------
  const ac12 = sameBatch('IPQC_CT', [iqcFailed], {
    mrbByOrderNo: mrbIndex(
      mrb({
        mrbNo: 'MRB-0012',
        sourceOrderNo: 'IQC-0002',
        status: 'DISPOSED',
        disposition: 'RETURN_TO_VENDOR' as MRBDisposition,
      })
    ),
  });
  assertEqual(ac12.allowed, false, 'AC-12 退货阻断');
  assertEqual(ac12.code, 'CHAIN_TERMINATED', 'AC-12 理由码');
  assertEqual(ac12.terminateChain, true, 'AC-12 终止整条链');

  const ac13 = sameBatch('OQC_SH', [iqcFailed], {
    mrbByOrderNo: mrbIndex(
      mrb({
        mrbNo: 'MRB-0013',
        sourceOrderNo: 'IQC-0002',
        status: 'DISPOSED',
        disposition: 'SCRAP' as MRBDisposition,
      })
    ),
  });
  assertEqual(ac13.allowed, false, 'AC-13 报废阻断');
  assertEqual(ac13.code, 'CHAIN_TERMINATED', 'AC-13 理由码');
  assertEqual(ac13.terminateChain, true, 'AC-13 终止整条链');

  // ---------------------------------------------------------------------------
  // AC-14 跨批次（同炉批号）→ 来料不合格阻断出货
  // ---------------------------------------------------------------------------
  const ac14 = canTransferToNextStage({
    stage: 'OQC_SH',
    anchors: [
      { kind: 'BATCH', value: 'X-SH-001' },
      { kind: 'HEAT', value: 'HT-X' },
    ],
    candidates: [
      candidate(
        upstreamOrder({
          orderNo: 'X-IQC-001',
          inspectionType: 'IQC',
          batchNo: 'X-IQC-001',
          status: 'FAILED',
          overallDecision: 'FAILED',
        }),
        ['HEAT']
      ),
    ],
  });
  assertEqual(ac14.allowed, false, 'AC-14 跨批次（同炉批号）仍阻断');
  assertEqual(ac14.code, 'UPSTREAM_FAILED', 'AC-14 理由码');
  assertEqual(ac14.chainKeyKind, 'HEAT', 'AC-14 命中炉批号锚点');
  assertEqual(ac14.predecessorOrderNo, 'X-IQC-001', 'AC-14 指向同炉号来料单');

  // 跨物料命中不参与门禁：候选集为空、仅给出提示计数 → 放行 + 留痕
  const ac14b = canTransferToNextStage({
    stage: 'OQC_SH',
    anchors: [
      { kind: 'BATCH', value: 'X-SH-001' },
      { kind: 'HEAT', value: 'HT-X' },
    ],
    candidates: [],
    crossMaterialCandidateCount: 3,
  });
  assertEqual(ac14b.allowed, true, 'AC-14 跨物料候选不参与门禁（TBD-03）');
  assertEqual(ac14b.code, 'UPSTREAM_MISSING', 'AC-14 跨物料按未命中处理并留痕');
  assert(ac14b.reason.includes('跨物料'), 'AC-14 理由中给出跨物料提示');

  // ---------------------------------------------------------------------------
  // AC-15 跨工单（同工单号）
  // ---------------------------------------------------------------------------
  const ac15 = canTransferToNextStage({
    stage: 'IPQC_RL',
    anchors: [{ kind: 'WORK_ORDER', value: 'WO-20231013-01' }],
    candidates: [
      candidate(
        upstreamOrder({
          orderNo: 'IPQC-CT-0001',
          inspectionType: 'IPQC_CT',
          batchNo: 'B-OTHER',
          status: 'FAILED',
          overallDecision: 'FAILED',
        }),
        ['WORK_ORDER']
      ),
    ],
  });
  assertEqual(ac15.allowed, false, 'AC-15 跨工单仍阻断');
  assertEqual(ac15.chainKeyKind, 'WORK_ORDER', 'AC-15 命中工单锚点');

  // ---------------------------------------------------------------------------
  // AC-16 同环节多张单 → 复检轮次最高 → 最近一次终判（严禁取到最旧一条）
  // ---------------------------------------------------------------------------
  const oldestFailed = candidate(
    upstreamOrder({
      orderNo: 'IQC-0016',
      inspectionType: 'IQC',
      status: 'FAILED',
      overallDecision: 'FAILED',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
    })
  );
  const latestPassed = candidate(
    upstreamOrder({
      orderNo: 'IQC-0016',
      inspectionType: 'IQC',
      overallDecision: 'PASSED',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-10T10:00:00.000Z',
    })
  );
  const ac16a = sameBatch('IPQC_CT', [oldestFailed, latestPassed]);
  assertEqual(ac16a.allowed, true, 'AC-16 取最近一次终判（合格）');
  assertEqual(ac16a.predecessorStatus, 'COMPLETED', 'AC-16 命中的是最近那张单');

  const ac16b = sameBatch('IPQC_CT', [
    candidate(
      upstreamOrder({
        orderNo: 'IQC-0017',
        inspectionType: 'IQC',
        overallDecision: 'PASSED',
        updatedAt: '2026-09-01T10:00:00.000Z',
      })
    ),
    candidate(
      upstreamOrder({
        orderNo: 'IQC-0017',
        inspectionType: 'IQC',
        status: 'FAILED',
        overallDecision: 'FAILED',
        updatedAt: '2026-09-10T10:00:00.000Z',
      })
    ),
  ]);
  assertEqual(ac16b.allowed, false, 'AC-16 最近一次终判为不合格 → 阻断');
  assertEqual(ac16b.code, 'UPSTREAM_FAILED', 'AC-16 理由码');

  // 权威单选取与输入顺序无关（防止调用方依赖数据库默认顺序）
  const ordered = pickAuthoritativeUpstream([oldestFailed, latestPassed]);
  const reversed = pickAuthoritativeUpstream([latestPassed, oldestFailed]);
  assertEqual(ordered?.order.updatedAt, reversed?.order.updatedAt, 'AC-16 权威单与输入顺序无关');

  // ---------------------------------------------------------------------------
  // 补充：无门禁上游环节（IQC）与多环节同时阻断的严重度收敛
  // ---------------------------------------------------------------------------
  const acNoPredecessor = sameBatch('IQC', [iqcFailed]);
  assertEqual(acNoPredecessor.allowed, true, 'IQC 无上游门禁环节，直接放行');
  assertEqual(acNoPredecessor.code, 'NO_PREDECESSOR_STAGE', 'IQC 理由码');

  const multipleBlocked = sameBatch(
    'OQC_SH',
    [
      candidate(
        upstreamOrder({
          orderNo: 'IQC-0018',
          inspectionType: 'IQC',
          status: 'FAILED',
          overallDecision: 'FAILED',
        })
      ),
      candidate(
        upstreamOrder({
          orderNo: 'OQC-HT-0018',
          inspectionType: 'OQC_HEAT',
          status: 'FAILED',
          overallDecision: 'FAILED',
        })
      ),
    ],
    {
      mrbByOrderNo: mrbIndex(
        mrb({
          mrbNo: 'MRB-0018',
          sourceOrderNo: 'OQC-HT-0018',
          status: 'DISPOSED',
          disposition: 'SCRAP' as MRBDisposition,
        })
      ),
    }
  );
  assertEqual(multipleBlocked.code, 'CHAIN_TERMINATED', '多环节同时阻断时报告最严重理由码');
  assertEqual(multipleBlocked.terminateChain, true, '多环节同时阻断时终止标记仍为真');

  console.log('✅ transfer-gate-service.test.ts 全部断言通过');
}

run();

