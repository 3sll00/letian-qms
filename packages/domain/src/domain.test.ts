import {
  InspectionPlan,
  InspectionOrder,
  ReviewFlowDefinition,
  BatchTraceDAG,
} from './models';
import {
  InspectionPlanItem,
  InspectionPlanVersion,
  TraceNode,
  TraceEdge,
} from '@letian/contracts';

/**
 * 领域聚合根回归基线：覆盖 __tests__ 四套件之外的聚合行为。
 * - InspectionPlan: 草稿版本唯一性、激活单激活态约束、停用幂等
 * - InspectionOrder: 快照深拷贝绑定、录入/提交安全规则（PENDING 阻断）、返工回边全生命周期
 * - ReviewFlowDefinition: 步骤连续性校验、排序、matches 匹配
 * - BatchTraceDAG: 正向/反向追溯、环路检测、子图构建
 */

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

/** 期望抛错并以指定错误码开头/包含；未抛或错误码不符均视为失败 */
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

function makePlanItem(overrides: Partial<InspectionPlanItem> = {}): InspectionPlanItem {
  return {
    seq: 1,
    itemCode: 'OD-01',
    name: '外径',
    dataType: 'NUMERIC',
    metricCategory: 'DIMENSION',
    isMandatory: true,
    nominalValue: 8.0,
    upperTolerance: 0.1,
    lowerTolerance: 0.1,
    ...overrides,
  };
}

function makePlan(): InspectionPlan {
  return new InspectionPlan({
    id: 'plan-001',
    planCode: 'QP-2026-001',
    planName: '高强度螺栓检验方案',
    materialCode: 'MAT-001',
    materialCategory: 'FASTENER',
    inspectionType: 'IQC',
  });
}

function makePlanVersion(overrides: Partial<InspectionPlanVersion> = {}): InspectionPlanVersion {
  return {
    id: 'ver-001',
    planId: 'plan-001',
    versionNo: 'V1.0.0',
    status: 'DRAFT',
    samplingScheme: 'GB_T_2828',
    aqlLevel: 'II',
    strictness: 'NORMAL',
    createdBy: 'u1a8e100-0000-0000-0000-000000000001',
    items: [makePlanItem()],
    ...overrides,
  };
}

type OrderParams = ConstructorParameters<typeof InspectionOrder>[0];

function makeOrder(overrides: Partial<OrderParams> = {}): InspectionOrder {
  return new InspectionOrder({
    id: 'ord-001',
    orderNo: 'IQC-2026-0001',
    inspectionType: 'IQC',
    materialCode: 'MAT-001',
    materialName: '高强度螺栓',
    batchNo: 'BATCH-2026-001',
    batchQty: 500,
    ...overrides,
  });
}

/** 绑定好单指标方案快照且已开始检验的工单 */
function makeInspectingOrder(item: Partial<InspectionPlanItem> = {}): InspectionOrder {
  const order = makeOrder();
  order.bindPlanSnapshot(makePlanVersion({ items: [makePlanItem(item)] }), {
    planId: 'plan-001',
    planCode: 'QP-2026-001',
    planName: '高强度螺栓检验方案',
  });
  order.startInspection();
  return order;
}

function makeTraceNode(batchNo: string, stageName: string): TraceNode {
  return {
    nodeId: `node-${batchNo}`,
    batchNo,
    stageName,
    materialName: '冷镦钢 10B21',
    operatorName: '张检验',
    timestamp: '2026-07-06 09:30',
    nodeStatus: 'PASSED',
  };
}

function makeTraceEdge(sourceBatchNo: string, targetBatchNo: string): TraceEdge {
  return {
    sourceBatchNo,
    targetBatchNo,
    relationType: 'PROCESS_TO_PROCESS',
    depth: 1,
    isCycle: false,
    hasCycleWarning: false,
  };
}

export function runDomainTests(): { total: number; passed: number } {
  let passed = 0;
  let total = 0;

  function test(name: string, fn: () => void): void {
    total++;
    try {
      fn();
      passed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ [Domain Test Failed]: ${name} -> ${msg}`);
      throw err;
    }
  }

  // ===================== 1. InspectionPlan 聚合 =====================

  test('InspectionPlan: 新建方案无版本，创建草稿版本成功且带默认抽样参数', () => {
    const plan = makePlan();
    assert(plan.getVersions().length === 0, '新方案不应有版本');
    const draft = plan.createDraftVersion({
      id: 'ver-001',
      versionNo: 'V1.0.0',
      items: [makePlanItem()],
      createdBy: 'u1a8e100-0000-0000-0000-000000000001',
    });
    assert(draft.status === 'DRAFT', '新版本必须为 DRAFT');
    assert(draft.samplingScheme === 'GB_T_2828', '默认抽样方案应为 GB_T_2828');
    assert(draft.aqlLevel === 'II' && draft.strictness === 'NORMAL', '默认水平 II / 正常严格度');
    assert(plan.getVersions().length === 1, '版本应入聚合');
  });

  test('InspectionPlan: 已存在草稿时严禁重复创建（PLAN_DRAFT_ALREADY_EXISTS）', () => {
    const plan = makePlan();
    plan.createDraftVersion({ id: 'ver-001', versionNo: 'V1.0.0', items: [makePlanItem()], createdBy: 'user-1' });
    assertThrows(
      () => plan.createDraftVersion({ id: 'ver-002', versionNo: 'V1.1.0', items: [makePlanItem()], createdBy: 'user-1' }),
      /PLAN_DRAFT_ALREADY_EXISTS/,
      '重复创建草稿'
    );
  });

  test('InspectionPlan: 草稿严禁为空指标（PLAN_EMPTY_ITEMS）', () => {
    const plan = makePlan();
    assertThrows(
      () => plan.createDraftVersion({ id: 'ver-001', versionNo: 'V1.0.0', items: [], createdBy: 'user-1' }),
      /PLAN_EMPTY_ITEMS/,
      '空指标创建草稿'
    );
  });

  test('InspectionPlan: 激活不存在版本抛 PLAN_VERSION_NOT_FOUND', () => {
    const plan = makePlan();
    assertThrows(() => plan.activateVersion('ver-404'), /PLAN_VERSION_NOT_FOUND/, '激活未知版本');
    assertThrows(() => plan.deactivateVersion('ver-404'), /PLAN_VERSION_NOT_FOUND/, '停用未知版本');
  });

  test('InspectionPlan: 激活新版本自动停用旧版本（单激活态保证）', () => {
    const plan = makePlan();
    plan.createDraftVersion({ id: 'ver-001', versionNo: 'V1.0.0', items: [makePlanItem()], createdBy: 'user-1' });
    plan.activateVersion('ver-001');
    assert(plan.getActiveVersion()?.id === 'ver-001', 'ver-001 应为激活版本');

    plan.createDraftVersion({ id: 'ver-002', versionNo: 'V1.1.0', items: [makePlanItem()], createdBy: 'user-1' });
    plan.activateVersion('ver-002');
    const v1 = plan.getVersions().find(v => v.id === 'ver-001');
    const v2 = plan.getVersions().find(v => v.id === 'ver-002');
    assert(v1?.status === 'INACTIVE', '旧版本应自动转 INACTIVE');
    assert(v2?.status === 'ACTIVE', '新版本应为 ACTIVE');
    assert(plan.getActiveVersion()?.id === 'ver-002', 'getActiveVersion 应返回 ver-002');
  });

  test('InspectionPlan: 重复激活已激活版本幂等放行', () => {
    const plan = makePlan();
    plan.createDraftVersion({ id: 'ver-001', versionNo: 'V1.0.0', items: [makePlanItem()], createdBy: 'user-1' });
    plan.activateVersion('ver-001');
    plan.activateVersion('ver-001'); // 严禁抛错
    assert(plan.getVersions().filter(v => v.status === 'ACTIVE').length === 1, '仍应保持单激活态');
  });

  test('InspectionPlan: 停用 ACTIVE 成功且幂等；停用 DRAFT 抛 PLAN_CANNOT_DEACTIVATE', () => {
    const plan = makePlan();
    plan.createDraftVersion({ id: 'ver-001', versionNo: 'V1.0.0', items: [makePlanItem()], createdBy: 'user-1' });
    assertThrows(() => plan.deactivateVersion('ver-001'), /PLAN_CANNOT_DEACTIVATE/, '停用草稿');
    plan.activateVersion('ver-001');
    plan.deactivateVersion('ver-001');
    assert(plan.getVersions().find(v => v.id === 'ver-001')?.status === 'INACTIVE', '应转 INACTIVE');
    plan.deactivateVersion('ver-001'); // 幂等，严禁抛错
  });

  // ===================== 2. InspectionOrder 聚合 =====================

  test('InspectionOrder: 初始为 PENDING，sampleQty 缺省按 min(batchQty, 13) 兜底', () => {
    const order = makeOrder();
    assert(order.getStatus() === 'PENDING', '初始状态必须为 PENDING');
    assert(order.getSampleQty() === 13, '500 件批量缺省样本量应为 13');
    const small = makeOrder({ id: 'ord-small', batchQty: 5 });
    assert(small.getSampleQty() === 5, '小批量缺省样本量不超过批量');
  });

  test('InspectionOrder: 绑定方案快照生成检验项，且深拷贝隔离（改源版本不影响工单）', () => {
    const order = makeOrder();
    const version = makePlanVersion();
    order.bindPlanSnapshot(version, { planId: 'plan-001', planCode: 'QP-2026-001', planName: '高强度螺栓检验方案' });

    assert(order.getPlanVersionId() === 'ver-001', 'planVersionId 应绑定为版本 id');
    const items = order.getItems();
    assert(items.length === 1, '应按方案指标生成 1 个检验项');
    assert(items[0]?.result === 'PENDING', '新检验项判定应为 PENDING');
    assert(items[0]?.nominalValue === 8.0, '标准值应从方案拷贝');

    // 深拷贝隔离：篡改源版本与外部读取的副本，均不得影响工单内部
    version.items[0]!.nominalValue = 999;
    const externalSnapshot = order.getPlanSnapshot();
    externalSnapshot!.items[0]!.nominalValue = 888;
    assert(order.getItems()[0]?.nominalValue === 8.0, '工单检验项必须不受外部篡改影响');
    assert(order.getPlanSnapshot()?.items[0]?.nominalValue === 8.0, '工单快照必须不受外部篡改影响');
  });

  test('InspectionOrder: 空指标版本禁止绑定（ORDER_EMPTY_ITEMS）', () => {
    const order = makeOrder();
    assertThrows(
      () =>
        order.bindPlanSnapshot(makePlanVersion({ items: [] }), {
          planId: 'plan-001',
          planCode: 'QP-2026-001',
        }),
      /ORDER_EMPTY_PLAN_ITEMS/,
      '空指标版本绑定'
    );
  });

  test('InspectionOrder: 非 PENDING/DRAFT 状态禁止重新绑定快照（ORDER_CANNOT_BIND_SNAPSHOT）', () => {
    const order = makeOrder({ status: 'PASSED' });
    assertThrows(
      () =>
        order.bindPlanSnapshot(makePlanVersion(), {
          planId: 'plan-001',
          planCode: 'QP-2026-001',
        }),
      /ORDER_CANNOT_BIND_SNAPSHOT/,
      'PASSED 状态绑定快照'
    );
  });

  test('InspectionOrder: toDTO 未绑定快照抛 ORDER_SNAPSHOT_NOT_BOUND，绑定后输出完整视图', () => {
    const bare = makeOrder();
    assertThrows(() => bare.toDTO(), /ORDER_SNAPSHOT_NOT_BOUND/, '未绑定快照序列化');
    const order = makeInspectingOrder();
    const dto = order.toDTO();
    assert(dto.planVersionId === 'ver-001', 'DTO 应携带 planVersionId');
    assert(dto.planSnapshot.planCode === 'QP-2026-001', 'DTO 应携带快照');
    assert(dto.items.length === 1, 'DTO 应携带检验项');
  });

  test('InspectionOrder: 仅 INSPECTING/DRAFT 可录入实测（ORDER_NOT_EDITABLE），未知项抛 ORDER_ITEM_NOT_FOUND', () => {
    const order = makeOrder();
    order.bindPlanSnapshot(makePlanVersion(), { planId: 'plan-001', planCode: 'QP-2026-001' });
    assertThrows(
      () => order.recordItemMeasurement({ itemCode: 'OD-01', measuredVal: 8.0 }),
      /ORDER_NOT_EDITABLE/,
      'PENDING 状态录入'
    );
    order.startInspection();
    assertThrows(
      () => order.recordItemMeasurement({ itemCode: 'NOPE', measuredVal: 8.0 }),
      /ORDER_ITEM_NOT_FOUND/,
      '未知指标编码'
    );
    const recorded = order.recordItemMeasurement({ itemCode: 'OD-01', measuredVal: 8.05 });
    assert(recorded.result === 'PASSED', '8.05 在 8.0±0.1 内应判 PASSED');
  });

  test('InspectionOrder: 草稿态可录入（DRAFT 属可编辑态）', () => {
    const order = makeOrder();
    order.bindPlanSnapshot(makePlanVersion(), { planId: 'plan-001', planCode: 'QP-2026-001' });
    order.startInspection();
    order.saveDraft();
    assert(order.getStatus() === 'DRAFT', '应进入 DRAFT');
    const recorded = order.recordItemMeasurement({ itemCode: 'OD-01', measuredVal: 8.0 });
    assert(recorded.result === 'PASSED', 'DRAFT 态录入应正常判定');
  });

  test('InspectionOrder: 提交前置校验 —— 非 INSPECTING 抛 ORDER_CANNOT_SUBMIT，无检验项抛 ORDER_HAS_NO_ITEMS', () => {
    const order = makeOrder();
    order.bindPlanSnapshot(makePlanVersion(), { planId: 'plan-001', planCode: 'QP-2026-001' });
    assertThrows(() => order.submitAndEvaluate(), /ORDER_CANNOT_SUBMIT/, 'PENDING 提交');

    const empty = makeOrder({ id: 'ord-empty' });
    empty.startInspection();
    assertThrows(() => empty.submitAndEvaluate(), /ORDER_HAS_NO_ITEMS/, '无检验项提交');
  });

  test('InspectionOrder: 存在 PENDING 项严禁放行 —— 整单判 FAILED（工业安全阻断规则）', () => {
    const order = makeOrder();
    order.bindPlanSnapshot(
      makePlanVersion({
        items: [
          makePlanItem({ itemCode: 'OD-01', seq: 1, name: '外径' }),
          makePlanItem({ itemCode: 'HD-01', seq: 2, name: '硬度', nominalValue: 32.0, upperTolerance: 2.0, lowerTolerance: 2.0 }),
        ],
      }),
      { planId: 'plan-001', planCode: 'QP-2026-001' }
    );
    order.startInspection();
    assert(order.getItems().length === 2, '应生成 2 个检验项');
    order.recordItemMeasurement({ itemCode: 'OD-01', measuredVal: 8.0 }); // 仅录一项，另一项滞留 PENDING
    const decision = order.submitAndEvaluate();
    assert(decision === 'FAILED', '有未录入项时整单必须判 FAILED');
    assert(order.getStatus() === 'FAILED', '状态必须转为 FAILED');
    assert(order.getOverallDecision() === 'FAILED', '总判定必须为 FAILED');
  });

  test('InspectionOrder: 任一指标 FAILED 则整单 FAILED', () => {
    const order = makeInspectingOrder();
    order.recordItemMeasurement({ itemCode: 'OD-01', measuredVal: 8.5 }); // 超差（上限 8.1）
    const decision = order.submitAndEvaluate();
    assert(decision === 'FAILED', '超差必须判 FAILED');
    assert(order.getStatus() === 'FAILED', '状态必须转为 FAILED');
    assert(order.getItems()[0]?.result === 'FAILED', '检验项判定应为 FAILED');
  });

  test('InspectionOrder: 全项 PASSED 整单放行 PASSED，可归档至 COMPLETED 终态', () => {
    const order = makeInspectingOrder();
    order.recordItemMeasurement({ itemCode: 'OD-01', measuredVal: 7.95 });
    const decision = order.submitAndEvaluate();
    assert(decision === 'PASSED', '全项合格应判 PASSED');
    assert(order.getStatus() === 'PASSED', '状态必须转为 PASSED');
    order.complete();
    assert(order.getStatus() === 'COMPLETED', '结单后必须为 COMPLETED 终态');
    assertThrows(() => order.startInspection(), /INVALID_INSPECTION_TRANSITION/, '终态后严禁重新开始检验');
  });

  test('InspectionOrder: 检验员填写的合格 / 不合格数量覆盖派生值，非法值拒绝（docs/21 §14）', () => {
    // 派生兜底：sampleQty 缺省 = min(batchQty 500, 13) = 13；一超差 -> FAILED -> 派生 failQty = 13
    const derived = makeInspectingOrder();
    derived.recordItemMeasurement({ itemCode: 'OD-01', measuredVal: 8.5 });
    derived.submitAndEvaluate();
    assert(derived.getFailQty() === 13, '未填写时按抽样数量派生兜底（首次判定恰等于抽样数，即页面上的检测数）');

    // 填写值优先：抽样 13 里现场清点合格 9 / 不合格 4
    const declared = makeInspectingOrder();
    declared.recordItemMeasurement({ itemCode: 'OD-01', measuredVal: 8.5 });
    assert(
      declared.submitAndEvaluate({ passQty: 9, failQty: 4 }) === 'FAILED',
      '超差仍须判 FAILED（填写数量不改变判定规则）'
    );
    assert(declared.getPassQty() === 9, '填写的合格数量必须覆盖派生值');
    assert(declared.getFailQty() === 4, '填写的不合格数量必须覆盖派生值（不是抽样数 13）');

    // 只给一栏：另一栏保持派生结果
    const halfDeclared = makeInspectingOrder();
    halfDeclared.recordItemMeasurement({ itemCode: 'OD-01', measuredVal: 8.5 });
    halfDeclared.submitAndEvaluate({ failQty: 2 });
    assert(halfDeclared.getFailQty() === 2, '只给不合格数量时应按填写值落库');
    assert(halfDeclared.getPassQty() === 0, '未给合格数量时保持派生结果（首检派生 passQty 为 0）');

    // 非法值 fail-closed：绝不静默改数
    const invalid = makeInspectingOrder();
    invalid.recordItemMeasurement({ itemCode: 'OD-01', measuredVal: 8.5 });
    assertThrows(
      () => invalid.submitAndEvaluate({ failQty: -1 }),
      /ORDER_DECLARED_QTY_INVALID/,
      '负数不合格数量必须拒绝'
    );
    assertThrows(
      () => invalid.submitAndEvaluate({ passQty: Number.NaN }),
      /ORDER_DECLARED_QTY_INVALID/,
      '非有限数合格数量必须拒绝'
    );
  });

  test('InspectionOrder: 返工回边全生命周期 FAILED -> MRB -> RE_INSPECTING -> 重检合格 -> 结单', () => {
    const order = makeInspectingOrder();
    order.recordItemMeasurement({ itemCode: 'OD-01', measuredVal: 8.5 }); // 超差
    order.submitAndEvaluate();
    assert(order.getStatus() === 'FAILED', '首检应 FAILED');

    order.routeToMRB();
    assert(order.getStatus() === 'IN_MRB_REVIEW', '应流转至 MRB 评审');
    order.markReInspecting();
    assert(order.getStatus() === 'RE_INSPECTING', 'MRB 返工应进入 RE_INSPECTING');
    order.startInspection();
    assert(order.getStatus() === 'INSPECTING', '返工后应重回 INSPECTING 重检');

    order.recordItemMeasurement({ itemCode: 'OD-01', measuredVal: 8.0 });
    assert(order.submitAndEvaluate() === 'PASSED', '返工重检合格应判 PASSED');
    order.complete();
    assert(order.getStatus() === 'COMPLETED', '最终应归档 COMPLETED');
  });

  test('InspectionOrder: MRB 路径兼容别名 markInMrb 等价于 routeToMRB', () => {
    const order = makeInspectingOrder();
    order.recordItemMeasurement({ itemCode: 'OD-01', measuredVal: 8.5 });
    order.submitAndEvaluate();
    order.markInMrb();
    assert(order.getStatus() === 'IN_MRB_REVIEW', 'markInMrb 应等价进入 MRB 评审');
  });

  // ===================== 3. ReviewFlowDefinition 聚合 =====================

  const FLOW_STEPS = [
    { stepNo: 2, stepName: '质量经理审批', approverRole: 'QA_MANAGER', isMandatory: true },
    { stepNo: 1, stepName: '技术部工程评审', approverRole: 'TECH_DEPT', isMandatory: true },
  ];

  function makeFlow(overrides: Partial<ConstructorParameters<typeof ReviewFlowDefinition>[0]> = {}): ReviewFlowDefinition {
    return new ReviewFlowDefinition({
      id: 'flow-001',
      flowName: '来料不合格退货评审',
      applicableCategory: 'INCOMING_FAIL',
      applicableDisposition: 'RETURN_TO_VENDOR',
      steps: FLOW_STEPS.map(s => ({ ...s })),
      ...overrides,
    });
  }

  test('ReviewFlowDefinition: 创建成功且步骤按 stepNo 自动排序', () => {
    const flow = makeFlow();
    const steps = flow.getSteps();
    assert(steps.length === 2, '应含 2 个步骤');
    assert(steps[0]?.stepNo === 1 && steps[0]?.stepName === '技术部工程评审', 'stepNo=1 应排首位');
    assert(steps[1]?.stepNo === 2, 'stepNo=2 应排次位');
    assert(flow.isFlowActive(), '默认启用');
  });

  test('ReviewFlowDefinition: 空步骤抛 FLOW_EMPTY_STEPS', () => {
    assertThrows(() => makeFlow({ steps: [] }), /FLOW_EMPTY_STEPS/, '空步骤流程');
  });

  test('ReviewFlowDefinition: 步骤号必须从 1 严格连续递增（FLOW_INVALID_STEP_ORDER）', () => {
    assertThrows(
      () => makeFlow({ steps: [{ stepNo: 1, stepName: 'A', approverRole: 'R1', isMandatory: true }, { stepNo: 3, stepName: 'B', approverRole: 'R2', isMandatory: true }] }),
      /FLOW_INVALID_STEP_ORDER/,
      '跳号步骤 (1,3)'
    );
    assertThrows(
      () => makeFlow({ steps: [{ stepNo: 1, stepName: 'A', approverRole: 'R1', isMandatory: true }, { stepNo: 1, stepName: 'B', approverRole: 'R2', isMandatory: true }] }),
      /FLOW_INVALID_STEP_ORDER/,
      '重复步骤号 (1,1)'
    );
    assertThrows(
      () => makeFlow({ steps: [{ stepNo: 2, stepName: 'A', approverRole: 'R1', isMandatory: true }] }),
      /FLOW_INVALID_STEP_ORDER/,
      '起始非 1 (2)'
    );
  });

  test('ReviewFlowDefinition: matches 按分类+处置+启用态匹配，停用后不匹配', () => {
    const flow = makeFlow();
    assert(flow.matches('INCOMING_FAIL', 'RETURN_TO_VENDOR'), '分类处置均匹配');
    assert(!flow.matches('PROCESS_FAIL', 'RETURN_TO_VENDOR'), '分类不同必须不匹配');
    assert(!flow.matches('INCOMING_FAIL', 'REWORK'), '处置不同必须不匹配');
    flow.deactivate();
    assert(!flow.matches('INCOMING_FAIL', 'RETURN_TO_VENDOR'), '停用后必须不匹配');
    flow.activate();
    assert(flow.matches('INCOMING_FAIL', 'RETURN_TO_VENDOR'), '重新启用后恢复匹配');
  });

  test('ReviewFlowDefinition: toDTO 映射为契约 ReviewFlow（nodes 承载步骤）', () => {
    const dto = makeFlow().toDTO();
    assert(dto.flowCode === 'flow-001', 'flowCode 暂以 id 承载');
    assert(dto.applicableType === 'INCOMING_FAIL', '适用分类应映射 applicableType');
    assert(dto.nodes.length === 2, '步骤应映射为 nodes');
    assert(dto.nodes[0]?.nodeLevel === 1 && dto.nodes[0]?.roleCode === 'TECH_DEPT', '首个节点应为技术评审');
    assert(dto.nodes.every(n => n.requireCustomerSign === false), 'requireCustomerSign 默认 false');
  });

  // ===================== 4. BatchTraceDAG 图模型 =====================

  function makeChainDAG(): BatchTraceDAG {
    const dag = new BatchTraceDAG();
    dag.addNode(makeTraceNode('B-01', '原材料来料检'));
    dag.addNode(makeTraceNode('B-02', '下料'));
    dag.addNode(makeTraceNode('B-03', '滚丝'));
    dag.addNode(makeTraceNode('B-09', '无关批次'));
    dag.addEdge(makeTraceEdge('B-01', 'B-02'));
    dag.addEdge(makeTraceEdge('B-02', 'B-03'));
    return dag;
  }

  test('BatchTraceDAG: 正向追溯 traceForward 覆盖全部下游且不包含根与无关节点', () => {
    const dag = makeChainDAG();
    const downstream = dag.traceForward('B-01');
    const batchNos = downstream.map(n => n.batchNo);
    assert(batchNos.includes('B-02') && batchNos.includes('B-03'), '应包含全部下游批次');
    assert(!batchNos.includes('B-01'), '不得包含根本身');
    assert(!batchNos.includes('B-09'), '不得包含无关联批次');
  });

  test('BatchTraceDAG: 反向追溯 traceBackward 覆盖全部上游', () => {
    const dag = makeChainDAG();
    const upstream = dag.traceBackward('B-03').map(n => n.batchNo);
    assert(upstream.includes('B-01') && upstream.includes('B-02'), '应包含全部上游批次');
    assert(!upstream.includes('B-03'), '不得包含叶子本身');
  });

  test('BatchTraceDAG: 无环图 detectCycles 返回 false，成环后 true 且给出闭环路径', () => {
    const dag = makeChainDAG();
    assert(!dag.detectCycles().hasCycle, '链式图不应成环');
    dag.addEdge(makeTraceEdge('B-03', 'B-01')); // 人为制造 B-01 -> B-02 -> B-03 -> B-01
    const cycle = dag.detectCycles();
    assert(cycle.hasCycle, '闭环必须被检出');
    const path = cycle.cyclePath!;
    assert(path.length >= 4, '环路路径至少含 3 节点 + 回溯起点');
    assert(path[0] === path[path.length - 1], '环路路径首尾应闭合');
    for (const b of ['B-01', 'B-02', 'B-03']) {
      assert(path.includes(b), `环路路径应包含 ${b}`);
    }
  });

  test('BatchTraceDAG: buildSubgraph 聚合上下游节点与内部边，未知批次抛 TRACE_NODE_NOT_FOUND', () => {
    const dag = makeChainDAG();
    const graph = dag.buildSubgraph('B-02');
    const nodeNos = graph.nodes.map(n => n.batchNo);
    assert(nodeNos.length === 3, '子图应含 B-01/B-02/B-03 三个节点');
    assert(!nodeNos.includes('B-09'), '无关批次不得进入子图');
    assert(graph.edges.length === 2, '仅应保留子图内部两条边');
    assert(!graph.hasCycle, '链式子图不应成环');
    assertThrows(() => dag.buildSubgraph('B-404'), /TRACE_NODE_NOT_FOUND/, '未知批次子图');
  });

  test('BatchTraceDAG: getAllNodes/getAllEdges 返回副本，外部篡改不影响内部', () => {
    const dag = makeChainDAG();
    dag.getAllNodes()[0]!.materialName = '篡改';
    dag.getAllEdges()[0]!.relationType = 'FINISH_TO_SHIPMENT' as TraceEdge['relationType'];
    assert(dag.getAllNodes()[0]?.materialName === '冷镦钢 10B21', '节点副本被篡改不得影响内部');
    assert(dag.getAllEdges()[0]?.relationType === 'PROCESS_TO_PROCESS', '边副本被篡改不得影响内部');
    assert(dag.getNode('B-01')?.stageName === '原材料来料检', 'getNode 应按批次号取节点');
  });

  return { total, passed };
}

// 自动自执行能力：任一用例失败即抛错，进程以非零退出码失败
const res = runDomainTests();
console.log(`[PASS] Domain Tests: ${res.passed}/${res.total}`);
