import assert from 'node:assert/strict';
import {
  AuditLogSchema,
  AuditStatsResponseSchema,
  ProblemDetailsSchema,
  CreateInspectionOrderRequestSchema,
  BatchRecordInspectionItemsRequestSchema,
  InspectionOrderSchema,
  CreateMRBReviewRequestSchema,
  SubmitNodeReviewRequestSchema,
  MRBReviewSchema,
  TraceabilityGraphResponseSchema,
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
    materialCode: 'CL-001',
    materialName: '圆钢 Φ20',
    batchNo: 'BATCH-20260901-01',
    sampleQty: 50,
    planVersionId: '11111111-1111-1111-1111-111111111111',
  },
  '合法创建检验单请求'
);
expectFail(
  CreateInspectionOrderRequestSchema,
  {
    orderNo: 'IQC-20260901-001',
    inspectionType: 'IQC',
    materialCode: 'CL-001',
    materialName: '圆钢 Φ20',
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
    materialCode: 'CL-001',
    materialName: '圆钢 Φ20',
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
  materialCode: 'CP-001',
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
    materialCode: 'CP-001',
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
    materialCode: 'CP-001',
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
