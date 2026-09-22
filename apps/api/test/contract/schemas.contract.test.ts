import assert from 'node:assert/strict';
import {
  AuditLogSchema,
  AuditStatsResponseSchema,
  ProblemDetailsSchema,
  CreateInspectionOrderRequestSchema,
  MatchedInspectionPlanSchema,
  CreateInspectionPlanRequestSchema,
  BatchRecordInspectionItemsRequestSchema,
  TogglePlanVersionStatusRequestSchema,
  UpgradePlanVersionRequestSchema,
  InspectionOrderSchema,
  CreateMRBReviewRequestSchema,
  SubmitNodeReviewRequestSchema,
  MRBReviewSchema,
  TraceabilityGraphResponseSchema,
  TraceBatchSearchResponseSchema,
  TraceOrderChainResponseSchema,
  ErrorCode,
} from '@letian/contracts';
import {
  MOCK_AUDIT_LOGS,
  MOCK_INSPECTION_ORDERS,
  MOCK_MRB_RECORDS,
} from '@letian/infrastructure';

/**
 * @letian/contracts 契约自检
 *
 * 两层含义：
 * 1. 契约 Schema 自身的正/反向用例（合法数据必须通过，非法数据必须被拒绝）
 * 2. Mock 数据源与契约的一致性 —— 内存 Mock 是当前 API 的真实数据来源，
 *    一旦它与契约漂移，接口就会返回契约无法解析的数据
 */

type Parseable = { safeParse: (v: unknown) => { success: boolean } };

function expectPass(schema: Parseable, value: unknown, label: string) {
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, true, `${label} 应当通过校验`);
}

function expectFail(schema: Parseable, value: unknown, label: string) {
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, false, `${label} 必须被契约拒绝`);
}

console.log('--- 开始 @letian/contracts Zod 契约模式校验测试 ---');

// ============================================================================
// 1. 错误码字典与 RFC 7807 规范
// ============================================================================
console.log('1. 校验错误码字典与 RFC 7807 问题详情契约...');

for (const [name, value] of Object.entries(ErrorCode)) {
  assert.match(
    value,
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    `错误码 ${name} = "${value}" 必须为小写短横线格式，才能拼装出合法的 RFC 7807 type URI`
  );
}

const validProblem = {
  type: 'https://letian-qms.com/errors/gate-not-inspected',
  title: '成品检强制关卡拦截',
  status: 409,
  detail: '批次未送检',
  instance: '/api/v1/release-gates/BATCH-001',
  code: ErrorCode.GATE_NOT_INSPECTED,
  traceId: 'req-20260706-0001',
  invalidParams: [{ name: 'batchNo', reason: '不能为空' }],
};
expectPass(ProblemDetailsSchema, validProblem, '合法 RFC 7807 问题详情');
expectFail(
  ProblemDetailsSchema,
  { ...validProblem, traceId: undefined },
  '缺少 traceId 的问题详情（链路追踪不可缺失）'
);
expectFail(
  ProblemDetailsSchema,
  { ...validProblem, invalidParams: [{ name: 'batchNo' }] },
  'invalidParams 缺少 reason 的问题详情'
);

// ============================================================================
// 2. 审计契约
// ============================================================================
console.log('2. 校验审计日志与统计卡片契约...');

expectPass(
  AuditStatsResponseSchema,
  { totalLogs: 100, successCount: 95, failedCount: 5, todayCount: 20 },
  '合法审计统计卡片'
);
expectFail(
  AuditStatsResponseSchema,
  { totalLogs: 100, successCount: 95, todayCount: 20 },
  '缺少 failedCount 的统计卡片'
);
expectFail(
  AuditLogSchema,
  {
    traceId: 'req-1',
    userId: '00000000-0000-0000-0000-000000000000',
    userName: 'system',
    action: 'INSERT',
    resourceType: 'X',
    resourceId: '1',
    createdAt: '2026-07-06T08:00:00Z',
  },
  '使用 INSERT 等非契约动作的审计日志（契约只承认 8 类关键动作）'
);

// ============================================================================
// 3. 检验单与质检方案契约
// ============================================================================
console.log('3. 校验检验单、方案快照与录入请求契约...');

expectPass(
  CreateInspectionOrderRequestSchema,
  {
    orderNo: 'IQC-20260901-001',
    inspectionType: 'IQC',
    materialCode: 'MAT-35CRMO-08',
    materialName: '35CrMo 合金圆钢 Φ8.0mm',
    batchNo: 'BATCH-20260901-01',
    sampleQty: 50,
    planVersionId: '11111111-1111-1111-1111-111111111111',
  },
  '合法创建检验单请求'
);
expectPass(
  CreateInspectionOrderRequestSchema,
  {
    orderNo: 'IQC-20260901-002',
    inspectionType: 'IQC',
    materialCode: 'MAT-35CRMO-08',
    materialName: '35CrMo 合金圆钢 Φ8.0mm',
    batchNo: 'BATCH-20260901-02',
    sampleQty: 50,
  },
  '省略 planVersionId 的创建请求（服务端按物料 + 检验类型自动匹配已启用方案）'
);

expectPass(
  MatchedInspectionPlanSchema,
  {
    planCode: 'QP-IQC-304SS',
    planName: '304 不锈钢来料检验方案',
    matchSource: 'MATERIAL',
    planVersionId: '11111111-1111-1111-1111-111111111111',
    versionNo: 'v1.0.0',
    inspectionType: 'IQC',
    materialCode: 'MAT-35CRMO-08',
    samplingScheme: 'GB_T_2828',
    aqlLevel: 'II',
    strictness: 'NORMAL',
    items: [
      {
        itemCode: 'ITEM-C-01',
        name: '化学成分 C',
        dataType: 'NUMERIC',
        metricCategory: 'CHEMICAL_COMPOSITION',
        nominalValue: 0.08,
        upperTolerance: 0.02,
        lowerTolerance: 0.02,
      },
    ],
    matchedAt: '2026-09-21T08:00:00Z',
  },
  '质检方案匹配结果（待检指标清单）'
);
expectFail(
  MatchedInspectionPlanSchema,
  {
    planCode: 'QP-IQC-304SS',
    planName: '304 不锈钢来料检验方案',
    matchSource: 'MATERIAL_CATEGORY',
    planVersionId: 'AUTO_MATCHED',
    versionNo: 'v1.0.0',
    inspectionType: 'IQC',
    materialCode: 'MAT-35CRMO-08',
    samplingScheme: 'GB_T_2828',
    aqlLevel: 'II',
    strictness: 'NORMAL',
    items: [],
    matchedAt: '2026-09-21T08:00:00Z',
  },
  'planVersionId 为非 UUID 占位串的方案匹配结果'
);

expectPass(
  CreateInspectionPlanRequestSchema,
  {
    planCode: 'QP-PERIOD-01',
    planName: '带生效周期的新建方案请求',
    inspectionType: 'IQC',
    versions: [
      {
        versionNo: 'V1.0',
        samplingScheme: 'GB_T_2828',
        aqlLevel: 'II',
        strictness: 'NORMAL',
        effectiveStartDate: '2026-09-21',
        effectiveEndDate: '2099-12-31',
        items: [
          {
            itemCode: 'DIM-01',
            name: '外径尺寸',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            nominalValue: 12,
            upperTolerance: 0.1,
            lowerTolerance: -0.1,
          },
        ],
      },
    ],
  },
  '方案设计页新建方案请求体（planId / createdBy / 版本行 id 由服务端派生，不在请求体内）'
);
// planCode 自 TBD-11 起为可选：留空由服务端按 QP-{YYYYMMDD}-{NNN} 取号
expectPass(
  CreateInspectionPlanRequestSchema,
  { planName: '省略 planCode 的新建方案请求', inspectionType: 'IQC' },
  '省略 planCode 的新建方案请求（服务端取号）'
);
expectFail(
  CreateInspectionPlanRequestSchema,
  { planCode: '', planName: 'planCode 传空串的新建方案请求', inspectionType: 'IQC' },
  'planCode 传空串的新建方案请求（留空必须"不传字段"，不能传空串）'
);
expectFail(
  CreateInspectionPlanRequestSchema,
  { planCode: 'QP-20260921-001', planName: '缺少检验类型的新建方案请求' },
  '缺少 inspectionType 的新建方案请求'
);

// 方案版本启停（审批）请求体：只传动作，目标版本由 URL 的版本行 UUID 指定
expectPass(
  TogglePlanVersionStatusRequestSchema,
  { action: 'ACTIVATE' },
  '方案版本审批启用请求'
);
expectPass(
  TogglePlanVersionStatusRequestSchema,
  { action: 'DEACTIVATE' },
  '方案版本停用请求'
);
expectFail(
  TogglePlanVersionStatusRequestSchema,
  { action: 'ENABLE' },
  '使用非契约启停动作（ENABLE）的方案版本启停请求'
);
expectFail(
  TogglePlanVersionStatusRequestSchema,
  {},
  '缺少 action 的方案版本启停请求'
);

// 方案版本升版请求体：新建的是 DRAFT 草稿版本，目标模板版本由 URL 的版本行 UUID 指定。
// 全部字段可省略 —— 省略 versionNo 由服务端按 max(version) 自动升位（TBD-14），
// 省略指标项 / 抽样参数则沿用 URL 指向的模板版本行。
expectPass(
  UpgradePlanVersionRequestSchema,
  {},
  '全部省略的方案版本升版请求（版本号与指标项均由服务端/模板版本行派生）'
);
expectPass(
  UpgradePlanVersionRequestSchema,
  {
    versionNo: 'V3.0',
    samplingScheme: 'GB_T_2828',
    aqlLevel: 'II',
    strictness: 'NORMAL',
    effectiveStartDate: '2026-10-01',
    effectiveEndDate: '2099-12-31',
    items: [
      {
        itemCode: 'DIM-02',
        name: '外径尺寸',
        dataType: 'NUMERIC',
        metricCategory: 'DIMENSION',
        nominalValue: 12,
        upperTolerance: 0.1,
        lowerTolerance: -0.1,
      },
    ],
  },
  '显式指定版本号与合法指标项的方案版本升版请求'
);
expectFail(
  UpgradePlanVersionRequestSchema,
  { versionNo: '' },
  '版本号传空串的方案版本升版请求（留空必须"不传字段"，不能传空串）'
);
expectFail(
  UpgradePlanVersionRequestSchema,
  { items: [] },
  '指标项传空数组的方案版本升版请求（留空必须"不传字段"，不能传空数组）'
);

expectFail(
  CreateInspectionOrderRequestSchema,
  {
    orderNo: 'IQC-20260901-001',
    inspectionType: 'IQC',
    materialCode: 'MAT-35CRMO-08',
    materialName: '35CrMo 合金圆钢 Φ8.0mm',
    batchNo: 'BATCH-20260901-01',
    sampleQty: 0,
    planVersionId: '11111111-1111-1111-1111-111111111111',
  },
  '抽检数量为 0 的创建请求'
);
expectFail(
  CreateInspectionOrderRequestSchema,
  {
    orderNo: 'IQC-20260901-001',
    // 旧迁移脚本中曾使用的检验类型，不属于契约枚举
    inspectionType: 'OQC',
    materialCode: 'MAT-35CRMO-08',
    materialName: '35CrMo 合金圆钢 Φ8.0mm',
    batchNo: 'BATCH-20260901-01',
    sampleQty: 50,
    planVersionId: '11111111-1111-1111-1111-111111111111',
  },
  '使用旧检验类型 OQC 的创建请求'
);

expectPass(
  BatchRecordInspectionItemsRequestSchema,
  {
    orderId: '11111111-1111-1111-1111-111111111111',
    items: [{ itemCode: 'ITEM-01', measuredVal: 20.02, remark: '合格' }],
  },
  '合法批量录入实测值请求'
);
expectFail(
  BatchRecordInspectionItemsRequestSchema,
  { orderId: '11111111-1111-1111-1111-111111111111', items: [] },
  '空指标列表的录入请求'
);

// 工单指标判定缺省值必须是 PENDING，严禁默认放行
const orderWithDefaults = InspectionOrderSchema.parse({
  orderNo: 'OQC-20260901-001',
  inspectionType: 'OQC_SF',
  materialCode: 'MAT-BLT-88-M10',
  materialName: '六角螺栓',
  batchNo: 'LOT-20260901-01',
  sampleQty: 125,
  planVersionId: '11111111-1111-1111-1111-111111111111',
  planSnapshot: {
    planId: '11111111-1111-1111-1111-111111111111',
    planCode: 'PLAN-01',
    planName: '成品检方案',
    versionId: '22222222-2222-2222-2222-222222222222',
    versionNo: 'v1.0.0',
    samplingScheme: 'GB_T_2828',
    aqlLevel: 'II',
    strictness: 'NORMAL',
    items: [],
    snapshotAt: '2026-09-01T08:00:00Z',
  },
  items: [{ itemCode: 'ITEM-01', name: '对边宽度' }],
});
assert.equal(
  orderWithDefaults.items[0]?.result,
  'PENDING',
  '未录入实测值的指标判定缺省值必须为 PENDING'
);
assert.equal(orderWithDefaults.status, 'PENDING', '新建工单缺省状态必须为 PENDING');
assert.equal(orderWithDefaults.isMandatoryGate, false, '强制关卡缺省值必须为 false');

// ============================================================================
// 4. MRB 评审契约
// ============================================================================
console.log('4. 校验 MRB 评审契约...');

expectPass(
  CreateMRBReviewRequestSchema,
  {
    sourceType: 'SHIPMENT_FAIL',
    sourceOrderNo: 'OQC-SF-20260706-0002',
    batchNo: 'LOT-20260706-003',
    materialCode: 'MAT-BLT-88-M10',
    materialName: '六角螺栓 M10×45',
    defectDescription: '对边宽度超上限',
    defectQty: 5,
  },
  '合法创建 MRB 请求'
);
expectFail(
  CreateMRBReviewRequestSchema,
  {
    sourceType: 'IQC_INCOMING',
    sourceOrderNo: 'IQC-001',
    batchNo: 'LOT-001',
    materialCode: 'MAT-BLT-88-M10',
    materialName: '螺栓',
    defectDescription: '缺陷',
    defectQty: 5,
  },
  '使用非契约来源分类的 MRB 请求'
);
expectPass(
  SubmitNodeReviewRequestSchema,
  { action: 'APPROVED', comment: '同意让步接收' },
  '合法节点会签请求'
);
expectFail(
  SubmitNodeReviewRequestSchema,
  { action: 'CONCESSION', comment: '同意' },
  '把处置方式当成会签动作的请求'
);

// ============================================================================
// 5. 批次追溯契约
// ============================================================================
console.log('5. 校验批次追溯拓扑契约...');

const validTrace = {
  batchNo: 'LOT-20260706-002',
  hasCycle: false,
  nodes: [
    {
      nodeId: 'node-1',
      batchNo: 'LOT-20260706-002',
      stageName: '成品出厂检验',
      materialName: '六角螺栓 M10×45',
      operatorName: '张检验',
      timestamp: '2026-07-06T09:00:00Z',
      nodeStatus: 'PASSED',
    },
  ],
  edges: [
    {
      sourceBatchNo: 'RAW-20260701-01',
      targetBatchNo: 'LOT-20260706-002',
      relationType: 'RAW_TO_PROCESS',
    },
  ],
  impact: {
    downstreamBatchCount: 1,
    upstreamBatchCount: 1,
    downstreamOrderCount: 1,
    downstreamPartyCount: 1,
    downstreamOrderNos: ['OQC-SH-20260706-002'],
    downstreamParties: ['客户B制造'],
  },
};
expectPass(TraceabilityGraphResponseSchema, validTrace, '合法追溯图谱');
expectFail(
  TraceabilityGraphResponseSchema,
  {
    ...validTrace,
    edges: [{ ...validTrace.edges[0], relationType: 'MATERIAL_TO_PRODUCT' }],
  },
  '使用非契约追溯关系类型的图谱'
);
expectFail(
  TraceabilityGraphResponseSchema,
  { ...validTrace, nodes: [{ ...validTrace.nodes[0], nodeStatus: 'QUALIFIED' }] },
  '使用旧节点状态 QUALIFIED 的图谱'
);

// 影响面统计是必填：缺失即视为口径不完整（docs/24 §8 验收口径 2）
expectFail(
  TraceabilityGraphResponseSchema,
  {
    batchNo: validTrace.batchNo,
    hasCycle: false,
    nodes: validTrace.nodes,
    edges: validTrace.edges,
  },
  '缺少 impact 影响面统计的图谱'
);

// 特采（让步接收）是合法节点状态，且必须能携带 MRB 单号与客户授权件（docs/24 §4 R4）
expectPass(
  TraceabilityGraphResponseSchema,
  {
    ...validTrace,
    nodes: [
      {
        ...validTrace.nodes[0],
        nodeStatus: 'CONCESSION',
        mrbNo: 'MRB-20231011-01',
        concessionAttachmentUrl: 'https://qms.letian.com/docs/concession/CONC-20231011-01.pdf',
      },
    ],
  },
  '特采（CONCESSION）节点状态的图谱'
);

// 批次检索响应：sources 只允许两个数据源取值
const validBatchSearch = {
  total: 1,
  page: 1,
  pageSize: 20,
  items: [
    {
      batchNo: 'B20231011-92',
      materialName: '35CrMo 合金圆钢 Φ8.0mm',
      materialCode: 'MAT-35CRMO-08',
      furnaceHeatBatchNo: '230910-112',
      nodeStatus: 'CONCESSION',
      sources: ['TRACE_NODE', 'INSPECTION_ORDER'],
      relatedOrderNos: ['INS-20231011-0001'],
    },
  ],
};
expectPass(TraceBatchSearchResponseSchema, validBatchSearch, '合法批次检索响应');
expectFail(
  TraceBatchSearchResponseSchema,
  { ...validBatchSearch, items: [{ ...validBatchSearch.items[0], sources: ['ERP_SYNC'] }] },
  '使用非契约检索来源的批次检索结果'
);

// 订单检验环节响应：stages 是并列台账，不是血缘链路；matchedBy 只允许四个订单字段
const validOrderChain = {
  orderNo: 'WO-20231012-01',
  matchedBy: 'WORK_ORDER_NO',
  batchNos: ['B20231012-02', 'B20231012-03'],
  stages: [
    {
      seq: 2,
      stageName: '下料检',
      orderNo: 'INS-20231012-0002',
      orderType: 'IPQC_CT',
      batchNo: 'B20231012-02',
      sourceDocNo: 'WO-20231012-01',
      status: 'FAILED',
      judgment: 'FAILED',
      durationMinutes: 30,
    },
  ],
};
expectPass(TraceOrderChainResponseSchema, validOrderChain, '合法订单检验环节响应');
expectFail(
  TraceOrderChainResponseSchema,
  { ...validOrderChain, matchedBy: 'BATCH_NO' },
  '使用非契约检索字段的订单检验环节响应'
);

// ============================================================================
// 6. Mock 数据源与契约的一致性
// ============================================================================
console.log('6. 校验内存数据源与契约的一致性...');

for (const order of MOCK_INSPECTION_ORDERS) {
  const parsed = InspectionOrderSchema.safeParse(order);
  assert.equal(
    parsed.success,
    true,
    `Mock 检验单 ${order.orderNo} 必须满足契约: ${JSON.stringify(
      parsed.success ? '' : parsed.error.issues.slice(0, 3)
    )}`
  );
  assert.ok(
    (order.items ?? []).length > 0,
    `Mock 检验单 ${order.orderNo} 必须携带方案快照指标实例，否则实测值录入无法进行`
  );
}

for (const mrb of MOCK_MRB_RECORDS) {
  const parsed = MRBReviewSchema.safeParse(mrb);
  assert.equal(
    parsed.success,
    true,
    `Mock MRB 记录 ${mrb.mrbNo} 必须满足契约: ${JSON.stringify(
      parsed.success ? '' : parsed.error.issues.slice(0, 3)
    )}`
  );
}

for (const log of MOCK_AUDIT_LOGS) {
  const parsed = AuditLogSchema.safeParse(log);
  assert.equal(
    parsed.success,
    true,
    `Mock 审计日志 ${log.resourceId} 必须满足契约: ${JSON.stringify(
      parsed.success ? '' : parsed.error.issues.slice(0, 3)
    )}`
  );
}

console.log('✓ @letian/contracts 契约 Zod Schema 验证全部通过！');
