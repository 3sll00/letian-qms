import {
  FurnaceHeatTraceResponseSchema,
  HeatTraceSourceTypeEnum,
  type InspectionItem,
  type InspectionOrder,
} from '@letian/contracts';
import {
  HEAT_TRACE_SOURCE_TYPES,
  HeatBatchTraceService,
  normalizeHeatBatchNo,
  type HeatBatchTraceRecord,
} from '../services/heat-batch-trace-service';

/**
 * 炉批号三级关联链路口径回归基线（docs/47 §3.1 ~ §3.5）。
 *
 * 锁定七件事，任何一条被改动都会在 `pnpm test` 阶段直接失败：
 *  1. 归一化：大小写 / 前后空格 / 全角空格 / 连字符 / 下划线差异视为同一炉批号（AC-06）；
 *  2. L1 委外热处理（OQC_HEAT）优先级高于 L2 来料检验（IQC），级别之间**不合并**（AC-01 / AC-02）；
 *  3. 仅有 IQC 时回退到 L2（AC-03）；
 *  4. 两处均无 -> NONE 静默空态，不带任何值（AC-04）；
 *  5. 同级别多张单取「最近一次终判」的一张（AC-05）；
 *  6. 未终判 / 判不合格（FAILED）的源单一律不参与带出（AC-07）；
 *  7. 带出项白名单与「只带有实测值的项」口径（R4 / TBD-05）。
 *
 * 夹具只填本用例关心的字段，其余按契约必填项给最小合法值（__tests__ 不参与 tsc 构建，
 * 字段全集见 packages/contracts/src/schemas/inspection.ts 的 InspectionOrderSchema）。
 */

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

function item(
  overrides: Partial<InspectionItem> & { itemCode: string }
): InspectionItem {
  return {
    seq: 1,
    name: overrides.itemCode,
    metricCategory: 'MECHANICAL_PERFORMANCE',
    isMandatory: true,
    isExempt: false,
    isManuallyModified: false,
    ...overrides,
  } as InspectionItem;
}

type OrderFixture = Partial<InspectionOrder> &
  Pick<InspectionOrder, 'orderNo' | 'inspectionType'>;

function order(overrides: OrderFixture): InspectionOrder {
  return {
    materialCode: 'M-001',
    materialName: '测试物料',
    batchNo: 'TEST2609-0001',
    sampleQty: 1,
    passQty: 0,
    failQty: 0,
    isMandatoryGate: false,
    status: 'PASSED',
    planVersionId: '11111111-1111-4111-8111-111111111111',
    planSnapshot: {
      planId: '11111111-1111-4111-8111-111111111111',
      planCode: 'PLAN-001',
      planName: '测试方案',
      versionId: '22222222-2222-4222-8222-222222222222',
      versionNo: 'V1',
      samplingScheme: 'GB_T_2828',
      aqlLevel: 'II',
      strictness: 'NORMAL',
      items: [],
      snapshotAt: '2026-09-01T00:00:00.000Z',
    },
    items: [],
    ...overrides,
  } as InspectionOrder;
}

function resolve(
  heatBatchNo: string,
  historicalOrders: readonly InspectionOrder[],
  materialCode?: string
): HeatBatchTraceRecord {
  return HeatBatchTraceService.resolveHeatBatchData({
    heatBatchNo,
    ...(materialCode !== undefined ? { materialCode } : {}),
    historicalOrders,
  });
}

function runHeatBatchTraceTests(): { total: number; passed: number } {
  let total = 0;
  let passed = 0;
  const check = (label: string, fn: () => void): void => {
    total += 1;
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  };

  check('归一化：大小写 / 空格 / 全角空格 / 连字符 / 下划线一律等价', () => {
    assert(normalizeHeatBatchNo('TEST-HT-2609-001') === 'TESTHT2609001', '连字符应被剔除');
    assert(normalizeHeatBatchNo('  test-ht-2609-001  ') === 'TESTHT2609001', '大小写与前后空格应被归一');
    assert(normalizeHeatBatchNo('TEST HT 2609 001') === 'TESTHT2609001', '半角空格应被剔除');
    assert(normalizeHeatBatchNo('TEST_HT_2609_001') === 'TESTHT2609001', '下划线应被剔除');
    assert(normalizeHeatBatchNo('TEST\u3000HT\u30002609\u3000001') === 'TESTHT2609001', '全角空格应被剔除');
    assert(normalizeHeatBatchNo(null) === '' && normalizeHeatBatchNo(undefined) === '', '空值归一为空串');
  });

  check('空炉批号：直接 NONE，不查任何单据', () => {
    const res = resolve('   ', [order({ orderNo: 'OQC-HT-1', inspectionType: 'OQC_HEAT' })]);
    assert(res.sourceType === 'NONE', '空炉批号必须判 NONE');
    assert(res.inheritedItems.length === 0, '空炉批号不得带出任何项');
  });

  check('AC-04：两处均无记录 -> NONE 静默空态（不报错、不带值）', () => {
    const res = resolve('TEST-HT-2609-404', [
      order({ orderNo: 'IQC-1', inspectionType: 'IQC', furnaceHeatNo: 'TEST-HT-2609-001' }),
      order({ orderNo: 'OQC-HT-1', inspectionType: 'OQC_HEAT', furnaceHeatNo: 'TEST-HT-2609-002' }),
    ]);
    assert(res.sourceType === 'NONE', '未命中必须判 NONE');
    assert(res.inheritedItems.length === 0, '未命中不得带出任何项');
    assert(res.sourceOrderNo === undefined, '未命中不得有源单号');
  });

  check('AC-01：仅一条已合格的 OQC_HEAT -> L1 且带出白名单实测值', () => {
    const res = resolve('TEST-HT-2609-001', [
      order({
        orderNo: 'OQC-HT-2609-001',
        inspectionType: 'OQC_HEAT',
        materialCode: 'M-001',
        furnaceHeatNo: 'TEST-HT-2609-001',
        inspectedDate: '2026-09-10',
        items: [
          item({ itemCode: 'TS', name: '抗拉强度', metricCategory: 'TENSILE_STRENGTH', measuredVal: 520, unit: 'MPa' }),
          item({ itemCode: 'HRC', name: '硬度', metricCategory: 'HARDNESS', measuredVal: 32 }),
          item({ itemCode: 'C', name: '碳含量', metricCategory: 'CHEMICAL_COMPOSITION', measuredVal: 0.42 }),
          item({ itemCode: 'LEN', name: '长度', metricCategory: 'DIMENSION', measuredVal: 150 }),
          item({ itemCode: 'EMPTY', name: '未测项', metricCategory: 'HARDNESS' }),
        ],
      }),
    ]);

    assert(res.sourceType === 'OUTSOURCE_HEAT_TREATMENT', `来源应为委外热处理，实际 ${res.sourceType}`);
    assert(res.sourceOrderNo === 'OQC-HT-2609-001', '应回源单号');
    assert(res.inspectedAt === '2026-09-10', 'inspectedAt 应优先取业务检验日期');
    assert(res.matchScope === 'GLOBAL', '未带物料编码时应标 GLOBAL（界面不显示跨物料提示）');
    const codes = res.inheritedItems.map((it) => it.itemCode);
    assert(codes.length === 3, `只带白名单且有实测值的 3 项，实际 [${codes.join(',')}]`);
    assert(codes.includes('TS') && codes.includes('HRC') && codes.includes('C'), '力学 / 硬度 / 化学成分应带出');
    assert(!codes.includes('LEN'), '尺寸类（与炉次无因果关系）默认不带出（TBD-05）');
    assert(!codes.includes('EMPTY'), '源单里没有实测值的项不带出');
  });

  check('AC-02：OQC_HEAT 与 IQC 各一条 -> 只取 L1，不与 IQC 混合', () => {
    const res = resolve('TEST-HT-2609-002', [
      order({
        orderNo: 'IQC-2609-002',
        inspectionType: 'IQC',
        materialCode: 'M-001',
        furnaceHeatNo: 'TEST-HT-2609-002',
        items: [item({ itemCode: 'IQC-ONLY', metricCategory: 'CHEMICAL_COMPOSITION', measuredVal: 0.11 })],
      }),
      order({
        orderNo: 'OQC-HT-2609-002',
        inspectionType: 'OQC_HEAT',
        materialCode: 'M-001',
        furnaceHeatNo: 'TEST-HT-2609-002',
        items: [item({ itemCode: 'HEAT-ONLY', metricCategory: 'MECHANICAL_PERFORMANCE', measuredVal: 800 })],
      }),
    ]);

    assert(res.sourceType === 'OUTSOURCE_HEAT_TREATMENT', 'L1 命中时必须返回委外热处理');
    assert(res.sourceOrderNo === 'OQC-HT-2609-002', '源单号应为 OQC_HEAT 那张');
    assert(
      res.inheritedItems.length === 1 && res.inheritedItems[0]?.itemCode === 'HEAT-ONLY',
      'L1 命中即返回，不得混入 IQC 的指标项'
    );
  });

  check('AC-03：只有 IQC -> 回退到 L2 来料检验', () => {
    const res = resolve('TEST-HT-2609-003', [
      order({
        orderNo: 'IQC-2609-003',
        inspectionType: 'IQC',
        materialCode: 'M-001',
        furnaceHeatNo: 'test ht 2609 003',
        items: [item({ itemCode: 'C', metricCategory: 'CHEMICAL_COMPOSITION', measuredVal: 0.35 })],
      }),
    ]);

    assert(res.sourceType === 'IQC_RAW_MATERIAL', `来源应为来料检验，实际 ${res.sourceType}`);
    assert(res.sourceOrderNo === 'IQC-2609-003', '应回 IQC 源单号');
    assert(res.inheritedItems.length === 1, '应带出 IQC 的实测项');
  });

  check('AC-05：同级别 3 张单取「最近一次终判」的一张（updatedAt 倒序）', () => {
    const res = resolve('TEST-HT-2609-005', [
      order({
        orderNo: 'OQC-HT-2609-005-A',
        inspectionType: 'OQC_HEAT',
        furnaceHeatNo: 'TEST-HT-2609-005',
        updatedAt: '2026-09-01T00:00:00.000Z',
        items: [item({ itemCode: 'A', measuredVal: 1 })],
      }),
      order({
        orderNo: 'OQC-HT-2609-005-C',
        inspectionType: 'OQC_HEAT',
        furnaceHeatNo: 'TEST-HT-2609-005',
        updatedAt: '2026-09-20T00:00:00.000Z',
        items: [item({ itemCode: 'C', measuredVal: 3 })],
      }),
      order({
        orderNo: 'OQC-HT-2609-005-B',
        inspectionType: 'OQC_HEAT',
        furnaceHeatNo: 'TEST-HT-2609-005',
        updatedAt: '2026-09-10T00:00:00.000Z',
        items: [item({ itemCode: 'B', measuredVal: 2 })],
      }),
    ]);

    assert(res.sourceOrderNo === 'OQC-HT-2609-005-C', `应取最近一次终判，实际 ${String(res.sourceOrderNo)}`);
    assert(res.inheritedItems[0]?.itemCode === 'C', '带出值必须来自同一张源单（不跨单拼接）');
  });

  check('排序确定性：updatedAt 相同则按 createdAt / orderNo 收敛（同输入必同输出）', () => {
    const same = '2026-09-15T00:00:00.000Z';
    const first = resolve('TEST-HT-2609-006', [
      order({ orderNo: 'OQC-HT-2609-006-1', inspectionType: 'OQC_HEAT', furnaceHeatNo: 'TEST-HT-2609-006', updatedAt: same, createdAt: same }),
      order({ orderNo: 'OQC-HT-2609-006-2', inspectionType: 'OQC_HEAT', furnaceHeatNo: 'TEST-HT-2609-006', updatedAt: same, createdAt: same }),
    ]);
    const second = resolve('TEST-HT-2609-006', [
      order({ orderNo: 'OQC-HT-2609-006-2', inspectionType: 'OQC_HEAT', furnaceHeatNo: 'TEST-HT-2609-006', updatedAt: same, createdAt: same }),
      order({ orderNo: 'OQC-HT-2609-006-1', inspectionType: 'OQC_HEAT', furnaceHeatNo: 'TEST-HT-2609-006', updatedAt: same, createdAt: same }),
    ]);
    assert(first.sourceOrderNo === 'OQC-HT-2609-006-2', '三级键应收敛到 orderNo 倒序最大者');
    assert(first.sourceOrderNo === second.sourceOrderNo, '输入顺序不得影响结果（幂等可复现）');
  });

  check('AC-07：未终判 / 判不合格 / status FAILED 的源单不参与带出', () => {
    const cases: readonly InspectionOrder[] = [
      order({ orderNo: 'OQC-HT-DRAFT', inspectionType: 'OQC_HEAT', furnaceHeatNo: 'TEST-HT-2609-007', status: 'DRAFT' }),
      order({ orderNo: 'OQC-HT-INSPECTING', inspectionType: 'OQC_HEAT', furnaceHeatNo: 'TEST-HT-2609-007', status: 'INSPECTING' }),
      order({ orderNo: 'OQC-HT-FAILED', inspectionType: 'OQC_HEAT', furnaceHeatNo: 'TEST-HT-2609-007', status: 'FAILED' }),
      order({ orderNo: 'OQC-HT-DECIDED-FAILED', inspectionType: 'OQC_HEAT', furnaceHeatNo: 'TEST-HT-2609-007', status: 'COMPLETED', overallDecision: 'FAILED' }),
    ];
    for (const src of cases) {
      const res = resolve('TEST-HT-2609-007', [src]);
      assert(res.sourceType === 'NONE', `[${src.orderNo}] 不得参与带出，实际 ${res.sourceType}`);
      assert(res.inheritedItems.length === 0, `[${src.orderNo}] 不得带出任何项`);
    }

    // 合格（PASSED / COMPLETED 且未判不合格）仍是有效来源，避免上面的过滤误杀
    for (const status of ['PASSED', 'COMPLETED'] as const) {
      const res = resolve('TEST-HT-2609-007', [
        order({ orderNo: `OQC-HT-${status}`, inspectionType: 'OQC_HEAT', furnaceHeatNo: 'TEST-HT-2609-007', status }),
      ]);
      assert(res.sourceType === 'OUTSOURCE_HEAT_TREATMENT', `[${status}] 属已终判合格，必须参与带出`);
    }
  });

  check('物料维度：同物料优先；同物料无命中才跨物料回落并标 GLOBAL', () => {
    const other = order({
      orderNo: 'OQC-HT-OTHER-MATERIAL',
      inspectionType: 'OQC_HEAT',
      materialCode: 'M-999',
      furnaceHeatNo: 'TEST-HT-2609-008',
      updatedAt: '2026-09-20T00:00:00.000Z',
    });
    const same = order({
      orderNo: 'OQC-HT-SAME-MATERIAL',
      inspectionType: 'OQC_HEAT',
      materialCode: 'M-001',
      furnaceHeatNo: 'TEST-HT-2609-008',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });

    const scoped = resolve('TEST-HT-2609-008', [other, same], 'M-001');
    assert(scoped.matchScope === 'MATERIAL', '同物料命中必须标 MATERIAL');
    assert(scoped.sourceOrderNo === 'OQC-HT-SAME-MATERIAL', '同物料优先，即使跨物料那张更新');

    const fallback = resolve('TEST-HT-2609-008', [other], 'M-001');
    assert(fallback.matchScope === 'GLOBAL', '同物料无命中才放宽到跨物料，且必须标 GLOBAL');
    assert(fallback.sourceMaterialCode === 'M-999', '跨物料命中应回源单物料编码供界面确认归属');
  });

  /**
   * TBD-01（docs/47 §3.9）：同炉批号存在 不合格 / MRB 未结案 / 未终判 记录时，
   * Banner **只提示、不带值、不阻断** —— 六条口径在此锁定，改文案或改归类都会红。
   */
  check('TBD-01：同炉存在不合格单 -> 空态 + UPSTREAM_FAILED 提示（不带值、不报错）', () => {
    const res = resolve('TEST-HT-2609-101', [
      order({
        orderNo: 'OQC-HT-2609-101',
        inspectionType: 'OQC_HEAT',
        furnaceHeatNo: 'TEST-HT-2609-101',
        status: 'FAILED',
        overallDecision: 'FAILED',
        items: [item({ itemCode: 'TS', metricCategory: 'TENSILE_STRENGTH', measuredVal: 300 })],
      }),
    ]);

    assert(res.sourceType === 'NONE', '不合格单不得参与带出');
    assert(res.inheritedItems.length === 0, '不合格单不得带出任何值');
    assert(
      res.upstreamWarning?.code === 'UPSTREAM_FAILED',
      `应报 UPSTREAM_FAILED，实际 ${res.upstreamWarning?.code}`
    );
    assert(
      res.upstreamWarning?.orderNos.join(',') === 'OQC-HT-2609-101',
      `提示必须带出命中单号，实际 ${JSON.stringify(res.upstreamWarning?.orderNos)}`
    );
    const message = res.upstreamWarning?.message ?? '';
    assert(message.includes('该炉批号上游存在不合格记录'), `文案须含客户口径原句，实际：${message}`);
    assert(message.includes('未带出该炉数据'), `空态文案须说明未带出，实际：${message}`);
  });

  check('TBD-01：带出成功也附提示，且 MRB 未结案归 UPSTREAM_UNDER_MRB（不被误归为不合格）', () => {
    const res = resolve('TEST-HT-2609-102', [
      order({
        orderNo: 'OQC-HT-2609-102-A',
        inspectionType: 'OQC_HEAT',
        furnaceHeatNo: 'TEST-HT-2609-102',
        status: 'COMPLETED',
        updatedAt: '2026-09-10T00:00:00.000Z',
        items: [item({ itemCode: 'TS', metricCategory: 'TENSILE_STRENGTH', measuredVal: 510 })],
      }),
      order({
        orderNo: 'OQC-HT-2609-102-B',
        inspectionType: 'OQC_HEAT',
        furnaceHeatNo: 'TEST-HT-2609-102',
        status: 'IN_MRB_REVIEW',
        overallDecision: 'FAILED',
        updatedAt: '2026-09-12T00:00:00.000Z',
      }),
    ]);

    assert(res.sourceOrderNo === 'OQC-HT-2609-102-A', `只允许带出已终判合格的记录，实际 ${res.sourceOrderNo}`);
    assert(res.inheritedItems.length === 1, '带出项数应等于源单白名单实测项数');
    assert(
      res.upstreamWarning?.code === 'UPSTREAM_UNDER_MRB',
      `进 MRB 的单据应归 MRB 未结案（不合格才发起评审，两者同时成立时以 MRB 归类），实际 ${res.upstreamWarning?.code}`
    );
    const message = res.upstreamWarning?.message ?? '';
    assert(message.includes('MRB') && message.includes('OQC-HT-2609-102-B'), `提示须含 MRB 与命中单号，实际：${message}`);
    assert(message.includes('最近终判合格'), `带出时须提示数据来自最近终判合格单，实际：${message}`);
  });

  check('TBD-01：同炉存在未终判记录 -> UPSTREAM_INSPECTING（不阻断带出）', () => {
    const res = resolve('TEST-HT-2609-103', [
      order({
        orderNo: 'OQC-HT-2609-103-A',
        inspectionType: 'OQC_HEAT',
        furnaceHeatNo: 'TEST-HT-2609-103',
        status: 'INSPECTING',
      }),
      order({
        orderNo: 'OQC-HT-2609-103-B',
        inspectionType: 'IQC',
        furnaceHeatNo: 'TEST-HT-2609-103',
        status: 'PASSED',
        items: [item({ itemCode: 'C', metricCategory: 'CHEMICAL_COMPOSITION', measuredVal: 0.4 })],
      }),
    ]);

    assert(res.sourceType === 'IQC_RAW_MATERIAL', '未终判单不得阻断 L2 带出（提示不等于门禁）');
    assert(
      res.upstreamWarning?.code === 'UPSTREAM_INSPECTING',
      `应报 UPSTREAM_INSPECTING，实际 ${res.upstreamWarning?.code}`
    );
    assert((res.upstreamWarning?.message ?? '').includes('尚未终判'), '文案须说明尚未终判');
  });

  check('TBD-01：三类同时存在只报一类（不合格优先），同类单号升序且最多 10 条', () => {
    const failed = Array.from({ length: 12 }, (_value, index) =>
      order({
        orderNo: `OQC-HT-2609-104-F${String(index + 1).padStart(2, '0')}`,
        inspectionType: 'OQC_HEAT',
        furnaceHeatNo: 'TEST-HT-2609-104',
        status: 'FAILED',
        overallDecision: 'FAILED',
      })
    );
    const res = resolve('TEST-HT-2609-104', [
      ...failed,
      order({
        orderNo: 'OQC-HT-2609-104-M1',
        inspectionType: 'OQC_HEAT',
        furnaceHeatNo: 'TEST-HT-2609-104',
        status: 'IN_MRB_REVIEW',
        overallDecision: 'FAILED',
      }),
      order({
        orderNo: 'OQC-HT-2609-104-W1',
        inspectionType: 'OQC_HEAT',
        furnaceHeatNo: 'TEST-HT-2609-104',
        status: 'INSPECTING',
      }),
    ]);

    assert(
      res.upstreamWarning?.code === 'UPSTREAM_FAILED',
      `多类命中应报最严重的一类，实际 ${res.upstreamWarning?.code}`
    );
    const orderNos = res.upstreamWarning?.orderNos ?? [];
    assert(orderNos.length === 10, `同类命中最多列 10 条，实际 ${orderNos.length}`);
    assert(
      [...orderNos].sort((left, right) => left.localeCompare(right)).join(',') === orderNos.join(','),
      '命中单号必须升序'
    );
    assert(!orderNos.includes('OQC-HT-2609-104-M1'), '只列同一类的单号（不混入 MRB / 未终判）');
  });

  check('TBD-01：无异常时不得凭空出现 upstreamWarning 字段', () => {
    const res = resolve('TEST-HT-2609-105', [
      order({
        orderNo: 'OQC-HT-2609-105',
        inspectionType: 'OQC_HEAT',
        furnaceHeatNo: 'TEST-HT-2609-105',
        status: 'COMPLETED',
        items: [item({ itemCode: 'TS', metricCategory: 'TENSILE_STRENGTH', measuredVal: 505 })],
      }),
    ]);

    assert(!('upstreamWarning' in res), '无异常必须真正缺省该字段（不是 undefined 值，避免契约解析出悬挂键）');
  });

  check('TBD-01：提示与带出同一物料维度（带 materialCode 时不报跨物料异常）', () => {
    const otherMaterialFailed = order({
      orderNo: 'OQC-HT-2609-106-OTHER',
      inspectionType: 'OQC_HEAT',
      furnaceHeatNo: 'TEST-HT-2609-106',
      materialCode: 'M-999',
      status: 'FAILED',
      overallDecision: 'FAILED',
    });
    const sameMaterial = order({
      orderNo: 'OQC-HT-2609-106-SAME',
      inspectionType: 'OQC_HEAT',
      furnaceHeatNo: 'TEST-HT-2609-106',
      materialCode: 'M-001',
      status: 'COMPLETED',
      items: [item({ itemCode: 'TS', metricCategory: 'TENSILE_STRENGTH', measuredVal: 512 })],
    });

    const scoped = resolve('TEST-HT-2609-106', [otherMaterialFailed, sameMaterial], 'M-001');
    assert(scoped.sourceOrderNo === 'OQC-HT-2609-106-SAME', '同物料合格单仍是带出源');
    assert(
      scoped.upstreamWarning === undefined,
      '带 materialCode 时跨物料异常不参与本提示（口径与 §3.4 带出维度同源，跨物料信号由 matchScope=GLOBAL 承担）'
    );

    const scopedAll = resolve('TEST-HT-2609-106', [otherMaterialFailed, sameMaterial]);
    assert(scopedAll.upstreamWarning?.code === 'UPSTREAM_FAILED', '未带物料编码时同一异常必须提示');
  });

  check('契约定向：本服务的来源枚举与响应体与 contracts 同源同值', () => {
    assert(
      JSON.stringify([...HEAT_TRACE_SOURCE_TYPES]) === JSON.stringify([...HeatTraceSourceTypeEnum.options]),
      '领域来源枚举必须与契约 HeatTraceSourceTypeEnum 完全一致（防漂移）'
    );

    const res = resolve('TEST-HT-2609-009', [
      order({
        orderNo: 'OQC-HT-2609-009',
        inspectionType: 'OQC_HEAT',
        materialCode: 'M-001',
        furnaceHeatNo: 'TEST-HT-2609-009',
        items: [item({ itemCode: 'TS', metricCategory: 'TENSILE_STRENGTH', measuredVal: 500, unit: 'MPa' })],
      }),
    ]);
    const parsed = FurnaceHeatTraceResponseSchema.safeParse(res);
    assert(parsed.success, '命中结果必须能通过契约 FurnaceHeatTraceResponseSchema 校验');
  });

  return { total, passed };
}

// 自动自执行能力：任一用例失败即抛错，进程以非零退出码失败
const res = runHeatBatchTraceTests();
console.log(`[PASS] Heat Batch Trace Tests: ${res.passed}/${res.total}`);
