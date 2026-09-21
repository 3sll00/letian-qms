import assert from 'node:assert/strict';
import { buildApp } from '../../src/app';
import { createApiContainer, type ApiContainer } from '../../src/container';
import { generateTestToken } from '../../src/plugins/auth';
import {
  ErrorCode,
  AuditLogSchema,
  AuditStatsResponseSchema,
  InspectionOrderSchema,
  InspectionPlanSchema,
  MRBReviewSchema,
  ProblemDetailsSchema,
  TraceabilityGraphResponseSchema,
} from '@letian/contracts';
import { toInspectionOrderNoDayKey } from '@letian/domain';

/**
 * 端到端业务与关键约束集成测试（真实 PostgreSQL + 真实 HTTP 层）
 *
 * 与旧版的根本差别：本文件不再引用任何内存 Mock 常量，
 * 所有场景（批次号、状态、MRB 结论）与所有期望值都从真实库现查现算，
 * 因此它验证的是"接口行为 == 数据库真实状态"，而不是"接口 == 另一份 Mock"。
 * 写入路径使用每次运行新生成的工单，运行结束后清理，保证可重复执行。
 *
 * 覆盖：
 * 1. 鉴权与 RFC 7807 401 契约
 * 2. 写路径：新建工单 -> 录入实测值 -> 领域判定 -> 落库（合格 / 不合格 / 未录入阻断 / 草稿 / 方案外指标）
 * 3. release-gates：由真实库推导每一类 409 阻断原因码与放行分支
 * 4. 审计：放行关卡纯只读，追溯查询/导出按实现写审计
 * 5. 读路径：列表 total 等于库中行数，且逐条满足契约 Schema
 * 6. 入参校验与 404 契约
 */
async function runIntegrationTests() {
  console.log('--- 启动 Fastify 端到端业务与关键约束集成测试（真实 PostgreSQL） ---');

  const container: ApiContainer = createApiContainer();
  const app = await buildApp({ logger: false, container });
  const db = container.db;

  // 写侧已接入三维 PBAC 校验（fail-closed）：使用配置了全量通配规则的质量主管「张强」，
  // 保证创建/录入类用例对任意种子物料都能放行。
  const inspectorToken = generateTestToken({
    userId: '11000000-0000-4000-8000-000000000001',
    userName: '张强',
    role: 'QA_MANAGER',
  });
  const authHeader = { authorization: `Bearer ${inspectorToken}` };

  /** 本次测试新建的检验单主键，结束时清理，保证可重复运行 */
  const createdOrderIds: string[] = [];

  const countAuditLogs = async (): Promise<number> => {
    const rows = await db.selectFrom('auditLogs').select('id').execute();
    return rows.length;
  };

  try {
    // =======================================================================
    // 1. 鉴权约束
    // =======================================================================
    console.log('1. 测试鉴权约束...');

    const unauthRes = await app.inject({ method: 'GET', url: '/api/v1/inspections' });
    assert.equal(unauthRes.statusCode, 401, '无 Token 应当返回 401');
    assert.equal(
      String(unauthRes.headers['content-type'] ?? '').includes('application/problem+json'),
      true,
      '401 响应必须为 application/problem+json'
    );
    const unauthJson = JSON.parse(unauthRes.body);
    assert.equal(unauthJson.status, 401);
    assert.equal(unauthJson.code, ErrorCode.UNAUTHORIZED);
    assert.equal(typeof unauthJson.traceId, 'string', '问题详情必须携带 traceId');

    const authRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections',
      headers: authHeader,
    });
    assert.equal(authRes.statusCode, 200, '携带有效 Token 应当返回 200');

    const healthRes = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(healthRes.statusCode, 200, '健康检查应免鉴权直接可访问');

    // =======================================================================
    // 2. 写路径：新建工单并录入实测值（真实库 + 真实事务）
    // =======================================================================
    console.log('2. 测试写路径：新建工单 -> 实测录入 -> 领域判定 -> 落库...');

    const planRows = await db
      .selectFrom('inspectionPlans')
      .select(['id', 'planCode', 'version', 'versionStatus', 'inspectionStage', 'materialCode', 'items'])
      .where('versionStatus', '=', 'ACTIVE')
      .orderBy('planCode', 'asc')
      .orderBy('version', 'asc')
      .execute();

    const pickedPlan = planRows.find((row) =>
      (row.items as Array<{ dataType: string; nominalValue?: number }>).some(
        (item) => item.dataType === 'NUMERIC' && typeof item.nominalValue === 'number'
      )
    );
    assert.ok(
      pickedPlan,
      '真实库中应存在"已启用且含数值型标准基准值指标"的质检方案，否则无法验证实测录入与自动判定'
    );

    const stamp = Date.now();
    const createOrder = async (
      tag: string
    ): Promise<{
      id: string;
      orderNo: string;
      batchNo: string;
      status: string;
      items: Array<{
        itemCode: string;
        dataType: string;
        nominalValue?: number;
        upperTolerance?: number;
        standardText?: string;
      }>;
    }> => {
      const batchNo = `E2E-${tag}-${stamp}`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/inspections',
        headers: authHeader,
        payload: {
          orderNo: `E2E-${tag}-INS-${stamp}`,
          inspectionType: pickedPlan.inspectionStage,
          materialCode: pickedPlan.materialCode,
          materialName: '端到端验收物料',
          batchNo,
          sampleQty: 5,
          planVersionId: pickedPlan.id,
        },
      });
      assert.equal(res.statusCode, 201, `新建检验单应返回 201，实际: ${res.body}`);
      const created = JSON.parse(res.body) as {
        id: string;
        orderNo: string;
        batchNo: string;
        status: string;
        planVersionId: string;
        planSnapshot: { versionId: string; items: unknown[] };
        items: Array<{ itemCode: string; dataType: string; nominalValue?: number; result: string }>;
      };
      createdOrderIds.push(created.id);

      // 落库校验：新建工单必须真实写入 inspection_orders，且快照绑定到指定版本
      const persisted = await db
        .selectFrom('inspectionOrders')
        .select(['status', 'planVersionId', 'items'])
        .where('id', '=', created.id)
        .executeTakeFirst();
      assert.ok(persisted, `新建的检验单 [${created.orderNo}] 必须已落库`);
      assert.equal(persisted.planVersionId, pickedPlan.id, '工单必须绑定请求指定的方案版本');
      assert.equal(persisted.status, 'PENDING', '新建工单初始状态应为 PENDING');

      const orderItems = created.items;
      assert.ok(orderItems.length > 0, '新建工单应携带方案快照的指标项');
      for (const item of orderItems) {
        assert.equal(item.result, 'PENDING', `新建工单的指标 ${item.itemCode} 初始判定应为 PENDING`);
      }
      return { ...created, items: orderItems };
    };

    // 2.1 全部指标合格 -> PASSED
    const passOrder = await createOrder('PASS');
    const inSpecItems = passOrder.items.map((item) =>
      item.dataType === 'NUMERIC'
        ? { itemCode: item.itemCode, measuredVal: item.nominalValue as number }
        : {
            itemCode: item.itemCode,
            measuredText: ((item.standardText ?? '合格').split(/[,，/|]/)[0] ?? '合格').trim(),
          }
    );
    const passRes = await app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${passOrder.id}/submit-measurements`,
      headers: authHeader,
      payload: { items: inSpecItems, isDraft: false },
    });
    assert.equal(passRes.statusCode, 200, `按标准基准值录入应返回 200，实际: ${passRes.body}`);
    const passBody = JSON.parse(passRes.body) as {
      status: string;
      overallDecision?: string;
      items: Array<{ itemCode: string; result: string; measuredVal?: number }>;
    };
    for (const item of passBody.items) {
      assert.equal(item.result, 'PASSED', `按标准基准值录入时指标 ${item.itemCode} 应判定合格`);
    }
    assert.equal(passBody.status, 'PASSED', '全部指标合格后工单应推进为 PASSED');
    assert.equal(passBody.overallDecision, 'PASSED', '综合结论应同步为 PASSED');

    const passPersisted = await db
      .selectFrom('inspectionOrders')
      .select(['status', 'judgment', 'items', 'inspectorId', 'inspectorName'])
      .where('id', '=', passOrder.id)
      .executeTakeFirst();
    assert.equal(passPersisted?.status, 'PASSED', '合格结论必须落库为 PASSED');
    assert.equal(passPersisted?.judgment, 'PASSED', '综合判定必须落库为 PASSED');
    for (const item of passPersisted?.items as Array<{ itemCode: string; result: string; measuredVal?: number }>) {
      assert.equal(item.result, 'PASSED', `库中指标 ${item.itemCode} 的判定应为 PASSED`);
      assert.equal(
        typeof item.measuredVal,
        'number',
        `库中指标 ${item.itemCode} 的实测值应已写入且为数值（jsonb 不得退化为字符串）`
      );
    }

    // 2.2 终态不可再录入（防止已合格工单被回改）
    const reSubmitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${passOrder.id}/submit-measurements`,
      headers: authHeader,
      payload: { items: inSpecItems, isDraft: false },
    });
    assert.equal(reSubmitRes.statusCode, 400, '已判定合格的工单再次录入应被拒绝');
    assert.equal(JSON.parse(reSubmitRes.body).code, 'JUDGEMENT_FAILED', '应给出判定阶段失败原因码');
    const afterReSubmit = await db
      .selectFrom('inspectionOrders')
      .select(['status', 'judgment'])
      .where('id', '=', passOrder.id)
      .executeTakeFirst();
    assert.equal(afterReSubmit?.status, 'PASSED', '被拒绝的重复录入不得改变库中状态');

    // 2.3 单个指标越界 -> 整单 FAILED，且仅该指标为 FAILED
    const failOrder = await createOrder('FAIL');
    const firstNumeric = failOrder.items.find((item) => item.dataType === 'NUMERIC');
    assert.ok(firstNumeric, '验收用方案应至少包含一个数值型指标');
    const outOfSpecValue = (firstNumeric.nominalValue as number) + (firstNumeric.upperTolerance ?? 0) + 1;
    const mixedItems = failOrder.items.map((item) =>
      item.itemCode === firstNumeric.itemCode
        ? { itemCode: item.itemCode, measuredVal: outOfSpecValue }
        : item.dataType === 'NUMERIC'
          ? { itemCode: item.itemCode, measuredVal: item.nominalValue as number }
          : {
              itemCode: item.itemCode,
              measuredText: ((item.standardText ?? '合格').split(/[,，/|]/)[0] ?? '合格').trim(),
            }
    );
    const failRes = await app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${failOrder.id}/submit-measurements`,
      headers: authHeader,
      payload: { items: mixedItems, isDraft: false },
    });
    assert.equal(failRes.statusCode, 200, `越界录入应被受理并给出判定，实际: ${failRes.body}`);
    const failBody = JSON.parse(failRes.body) as {
      status: string;
      overallDecision?: string;
      items: Array<{ itemCode: string; result: string }>;
    };
    const failedItem = failBody.items.find((item) => item.itemCode === firstNumeric.itemCode);
    assert.equal(
      failedItem?.result,
      'FAILED',
      `实测值 ${outOfSpecValue} 超出标准上限应判定不合格`
    );
    assert.equal(failBody.status, 'FAILED', '存在不合格指标时工单应推进为 FAILED');
    assert.equal(failBody.overallDecision, 'FAILED', '综合结论应同步为 FAILED');
    const failPersisted = await db
      .selectFrom('inspectionOrders')
      .select(['status', 'judgment'])
      .where('id', '=', failOrder.id)
      .executeTakeFirst();
    assert.equal(failPersisted?.status, 'FAILED', '不合格结论必须落库为 FAILED');

    // 2.3.1 验证不合格待审核池查询与独立发起评审闭环
    const pendingPoolRes = await app.inject({
      method: "GET",
      url: "/api/v1/mrb/pending-pool",
      headers: authHeader,
    });
    assert.equal(pendingPoolRes.statusCode, 200, "待审核池查询应返回 200");
    const pendingPoolBody = JSON.parse(pendingPoolRes.body) as { items: Array<{ id: string; inspectionOrderId: string; orderNo: string }> };
    const poolItem = pendingPoolBody.items.find((item) => item.inspectionOrderId === failOrder.id || item.id === failOrder.id);
    assert.ok(poolItem, "判定为 FAILED 的工单必须进入待审核池");

    const initiateRes = await app.inject({
      method: "POST",
      url: "/api/v1/mrb/pending-pool/initiate",
      headers: authHeader,
      payload: {
        pendingDefectId: failOrder.id,
        urgencyLevel: "URGENT",
        reviewNotes: "E2E集成测试发起评审",
      },
    });
    assert.equal(initiateRes.statusCode, 201, "待审核池发起评审应返回 201");
    const initiateBody = JSON.parse(initiateRes.body) as { mrbNo: string; status: string };
    assert.ok(initiateBody.mrbNo.startsWith("MRB-"), "应生成规范的 MRB 工单编号");
    assert.equal(initiateBody.status, "PENDING_REVIEW", "新发起的 MRB 评审状态应为 PENDING_REVIEW");

    const afterInitiateOrder = await db
      .selectFrom("inspectionOrders")
      .select(["status"])
      .where("id", "=", failOrder.id)
      .executeTakeFirst();
    assert.equal(afterInitiateOrder?.status, "IN_MRB_REVIEW", "发起评审后原工单状态应转为 IN_MRB_REVIEW");

    // 2.4 未录入实测值（仅备注）-> 严禁默认放行
    const blockedOrder = await createOrder('BLOCK');
    const blockedNumeric = blockedOrder.items.find((item) => item.dataType === 'NUMERIC');
    assert.ok(blockedNumeric, '验收用方案应至少包含一个数值型指标');
    const pendingRes = await app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${blockedOrder.id}/submit-measurements`,
      headers: authHeader,
      payload: { items: [{ itemCode: blockedNumeric.itemCode, remark: '待复测' }], isDraft: false },
    });
    assert.equal(pendingRes.statusCode, 200, `仅提交备注应可受理，实际: ${pendingRes.body}`);
    const pendingBody = JSON.parse(pendingRes.body) as {
      status: string;
      overallDecision?: string;
      items: Array<{ itemCode: string; result: string }>;
    };
    const pendingItem = pendingBody.items.find((item) => item.itemCode === blockedNumeric.itemCode);
    assert.equal(pendingItem?.result, 'PENDING', '未录入实测值必须返回 PENDING，严禁默认放行');
    assert.notEqual(
      pendingBody.status,
      'PASSED',
      '存在未录入指标时整单绝不允许判定为合格（不得默认放行）'
    );
    assert.equal(
      pendingBody.overallDecision,
      'FAILED',
      '按当前领域规则，存在未录入指标时整单判定为 FAILED 阻断（该口径已单独记录待业务确认）'
    );
    assert.equal(
      pendingBody.status,
      'FAILED',
      '存在未录入指标时工单状态应为 FAILED（阻断而非放行）'
    );

    // 2.5 草稿暂存：只落库实测值，不做整单终判
    const draftOrder = await createOrder('DRAFT');
    const draftNumeric = draftOrder.items.find((item) => item.dataType === 'NUMERIC');
    assert.ok(draftNumeric, '验收用方案应至少包含一个数值型指标');
    const draftRes = await app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${draftOrder.id}/submit-measurements`,
      headers: authHeader,
      payload: { items: [{ itemCode: draftNumeric.itemCode, measuredVal: draftNumeric.nominalValue }], isDraft: true },
    });
    assert.equal(draftRes.statusCode, 200, `草稿暂存应返回 200，实际: ${draftRes.body}`);
    const draftBody = JSON.parse(draftRes.body) as {
      status: string;
      overallDecision?: string;
      items: Array<{ itemCode: string; result: string }>;
    };
    assert.notEqual(draftBody.status, 'PASSED', '草稿暂存不得给出合格终判');
    assert.equal(draftBody.overallDecision, undefined, '草稿暂存不得写入综合判定结论');
    const draftPersisted = await db
      .selectFrom('inspectionOrders')
      .select(['status', 'judgment', 'items'])
      .where('id', '=', draftOrder.id)
      .executeTakeFirst();
    assert.equal(draftPersisted?.status, 'INSPECTING', '草稿暂存后工单应停留在检验中状态');
    assert.equal(draftPersisted?.judgment, null, '库中综合判定应保持空值');
    const unmeasured = (draftPersisted?.items as Array<{ itemCode: string; result: string }>).find(
      (item) => item.itemCode !== draftNumeric.itemCode
    );
    assert.equal(unmeasured?.result, 'PENDING', '草稿未录入的指标必须保持 PENDING');

    // 2.6 方案外指标编码 -> 400 校验失败，且必须指出具体字段
    const unknownItemRes = await app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${draftOrder.id}/submit-measurements`,
      headers: authHeader,
      payload: { items: [{ itemCode: 'ITEM-NOT-IN-PLAN', measuredVal: 1 }], isDraft: false },
    });
    assert.equal(unknownItemRes.statusCode, 400, '录入方案外指标应返回 400');
    const unknownItemJson = JSON.parse(unknownItemRes.body);
    assert.equal(unknownItemJson.code, ErrorCode.VALIDATION_FAILED);
    assert.ok(
      Array.isArray(unknownItemJson.invalidParams) && unknownItemJson.invalidParams.length > 0,
      '校验失败必须返回定位到具体字段的 invalidParams'
    );
    assert.equal(
      unknownItemJson.invalidParams[0].name,
      'ITEM-NOT-IN-PLAN',
      'invalidParams 必须指出越界的指标编码'
    );

    // 2.7 绑定不存在的方案版本 -> 404（禁止静默降级为自动匹配）
    const badPlanRes = await app.inject({
      method: 'POST',
      url: '/api/v1/inspections',
      headers: authHeader,
      payload: {
        orderNo: `E2E-BADPLAN-${stamp}`,
        inspectionType: pickedPlan.inspectionStage,
        materialCode: pickedPlan.materialCode,
        materialName: '端到端验收物料',
        batchNo: `E2E-BADPLAN-${stamp}`,
        sampleQty: 5,
        planVersionId: '00000000-0000-4000-8000-000000000000',
      },
    });
    assert.equal(badPlanRes.statusCode, 404, '绑定不存在的方案版本应返回 404');
    assert.equal(JSON.parse(badPlanRes.body).code, ErrorCode.RESOURCE_NOT_FOUND);
    console.log('✔ 写路径（合格 / 不合格 / 未录入阻断 / 草稿 / 方案外指标 / 非法方案版本）均符合预期');

    // =======================================================================
    // 3. release-gates：由真实库推导每类阻断与放行
    // =======================================================================
    console.log('3. 测试 release-gates 纯只读与 409 精确阻断原因码...');

    const orderRows = await db
      .selectFrom('inspectionOrders')
      .select(['batchNo', 'orderNo', 'orderType', 'status', 'judgment', 'inspectorId'])
      .execute();
    const mrbRows = await db
      .selectFrom('mrbReviews')
      .select(['batchNo', 'mrbNo', 'status', 'disposition', 'updatedAt'])
      .execute();

    const OQC_TYPES = ['OQC_SF', 'OQC_SH'];
    type GateExpectation =
      | { kind: 'blocked'; code: string }
      | { kind: 'allowed'; overallDecision: string | null; disposition: string | null };

    /**
     * 测试侧独立推导的放行关卡期望（规则来源：release-gates 控制器的放行口径）：
     * 优先取该批次的成品检(OQC)工单；工单必须已结单归档(COMPLETED)，
     * 不合格工单需存在 DISPOSED + CONCESSION 的 MRB 评审单才允许受限放行。
     */
    const expectedGate = (batchNo: string): GateExpectation => {
      const orders = orderRows.filter((row) => row.batchNo === batchNo);
      if (orders.length === 0) return { kind: 'blocked', code: ErrorCode.GATE_NOT_INSPECTED };

      const inspection = orders.find((row) => OQC_TYPES.includes(row.orderType)) ?? orders[0];
      assert.ok(inspection, '批次应至少存在一条检验工单');

      const mrb =
        mrbRows
          .filter((row) => row.batchNo === batchNo)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
      const underReview = mrb !== null && (mrb.status === 'PENDING_REVIEW' || mrb.status === 'UNDER_REVIEW');

      if (inspection.status !== 'COMPLETED') {
        if ((inspection.status === 'FAILED' || inspection.status === 'IN_MRB_REVIEW') && underReview) {
          return { kind: 'blocked', code: ErrorCode.GATE_UNDER_MRB };
        }
        if (inspection.status === 'FAILED' || inspection.status === 'IN_MRB_REVIEW') {
          return { kind: 'blocked', code: ErrorCode.GATE_FAILED };
        }
        return { kind: 'blocked', code: ErrorCode.GATE_INSPECTING };
      }

      if (inspection.judgment === 'FAILED') {
        if (underReview) return { kind: 'blocked', code: ErrorCode.GATE_UNDER_MRB };
        if (mrb !== null && mrb.status === 'DISPOSED' && mrb.disposition === 'CONCESSION') {
          return { kind: 'allowed', overallDecision: 'FAILED', disposition: 'CONCESSION' };
        }
        return { kind: 'blocked', code: ErrorCode.GATE_FAILED };
      }

      return {
        kind: 'allowed',
        overallDecision: inspection.judgment,
        disposition: inspection.judgment === 'CONCESSION' ? 'CONCESSION' : null,
      };
    };

    const batchNos = [...new Set(orderRows.map((row) => row.batchNo))].sort();
    // 未受检批次由构造保证（库中不存在该批次）
    const notInspectedBatch = `E2E-NOT-INSPECTED-${stamp}`;
    const gateTargets = [...batchNos, notInspectedBatch];
    const expectations = new Map<string, GateExpectation>(
      gateTargets.map((batchNo) => [batchNo, expectedGate(batchNo)])
    );

    // 场景覆盖度：每类分支都必须有真实样本，缺失即失败（而不是静默跳过该分支）
    const blockedCodes = new Set(
      [...expectations.values()].filter((e) => e.kind === 'blocked').map((e) => e.code)
    );
    for (const code of [
      ErrorCode.GATE_NOT_INSPECTED,
      ErrorCode.GATE_INSPECTING,
      ErrorCode.GATE_FAILED,
      ErrorCode.GATE_UNDER_MRB,
    ]) {
      assert.ok(
        blockedCodes.has(code),
        `真实库+本次写入数据中缺少 [${code}] 场景样本，该放行阻断分支未被验证`
      );
    }
    assert.ok(
      [...expectations.values()].some((e) => e.kind === 'allowed' && e.disposition === 'CONCESSION'),
      '真实库中缺少"MRB 让步接收后可受限放行"的样本，该放行分支未被验证'
    );
    assert.ok(
      [...expectations.values()].some(
        (e) => e.kind === 'allowed' && e.overallDecision === 'PASSED'
      ),
      '真实库中缺少"合格并已结单归档"的样本，该放行分支未被验证'
    );

    const auditBeforeGates = await countAuditLogs();
    for (const batchNo of gateTargets) {
      const expected = expectations.get(batchNo);
      assert.ok(expected, `批次 [${batchNo}] 应有推导出的放行期望`);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/release-gates/${batchNo}`,
        headers: authHeader,
      });

      if (expected.kind === 'blocked') {
        assert.equal(res.statusCode, 409, `批次 [${batchNo}] 应按期望被阻断（${expected.code}）`);
        assert.equal(
          String(res.headers['content-type'] ?? '').includes('application/problem+json'),
          true,
          '放行关卡阻断响应必须与全局错误处理器一致，使用 application/problem+json'
        );
        const body = JSON.parse(res.body);
        assert.equal(body.code, expected.code, `批次 [${batchNo}] 的阻断原因码应精确匹配`);
        assert.equal(body.batchNo, batchNo, '阻断响应应回显批次号');
        assert.equal(body.requiredGate, 'OQC', '阻断响应应标明受控关卡类型');
        const parsed = ProblemDetailsSchema.safeParse(body);
        assert.equal(
          parsed.success,
          true,
          `放行关卡阻断响应必须满足 RFC 7807 契约: ${JSON.stringify(
            parsed.success ? '' : parsed.error.issues
          )}`
        );
      } else {
        assert.equal(res.statusCode, 200, `批次 [${batchNo}] 应按期望放行`);
        const body = JSON.parse(res.body);
        assert.equal(body.allowed, true, '放行响应 allowed 应为 true');
        assert.equal(body.batchNo, batchNo, '放行响应应回显批次号');
        assert.equal(
          body.overallDecision ?? null,
          expected.overallDecision,
          `批次 [${batchNo}] 的综合结论应与库中一致`
        );
        assert.equal(
          body.dispositionDecision ?? null,
          expected.disposition,
          `批次 [${batchNo}] 的 MRB 处置结论应与库中一致`
        );
        const inspection = orderRows.filter((row) => row.batchNo === batchNo);
        assert.ok(
          inspection.some((row) => row.orderNo === body.inspectionOrderNo),
          '放行响应中的检验单号应存在于库中'
        );
      }
    }

    // 纯只读保证：放行评估绝不写入审计日志
    assert.equal(
      await countAuditLogs(),
      auditBeforeGates,
      'release-gates 接口是纯只读的，绝不产生审计日志副作用'
    );

    // 对照：追溯查询是"读 + 审计留痕"，必须恰好新增 1 条审计
    const auditBeforeTrace = await countAuditLogs();
    const traceAuditRes = await app.inject({
      method: 'GET',
      url: '/api/v1/trace/LOT-2026-FN-01',
      headers: authHeader,
    });
    assert.equal(traceAuditRes.statusCode, 200, '追溯查询应返回 200');
    assert.equal(
      await countAuditLogs(),
      auditBeforeTrace + 1,
      '追溯穿透查询应按实现写入 1 条审计日志'
    );
    console.log('✔ 放行关卡 4 类阻断 + 2 类放行均由真实库推导校验，且为纯只读');

    // =======================================================================
    // 4. 审计统计与追溯响应契约
    // =======================================================================
    console.log('4. 测试审计统计与追溯谱系响应契约...');

    const auditCountBeforeStats = await countAuditLogs();
    const auditStatsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/stats',
      headers: authHeader,
    });
    assert.equal(auditStatsRes.statusCode, 200);
    const auditStatsBody = JSON.parse(auditStatsRes.body);
    const auditStatsParsed = AuditStatsResponseSchema.safeParse(auditStatsBody);
    assert.equal(
      auditStatsParsed.success,
      true,
      `audit/stats 响应必须满足 AuditStatsResponseSchema: ${JSON.stringify(
        auditStatsParsed.success ? '' : auditStatsParsed.error.issues
      )}`
    );
    assert.equal(auditStatsBody.totalLogs, auditCountBeforeStats, '审计总条数应等于库中 audit_logs 行数');
    assert.equal(
      auditStatsBody.successCount + auditStatsBody.failedCount,
      auditStatsBody.totalLogs,
      '成功数 + 失败数应等于总条数'
    );
    assert.ok(auditStatsBody.todayCount <= auditStatsBody.totalLogs, '今日条数不可能超过总条数');

    const traceRes = await app.inject({
      method: 'GET',
      url: '/api/v1/trace/LOT-2026-FN-01?maxDepth=10',
      headers: authHeader,
    });
    assert.equal(traceRes.statusCode, 200, '按批次查询追溯谱系应返回 200');
    const traceParsed = TraceabilityGraphResponseSchema.safeParse(JSON.parse(traceRes.body));
    assert.equal(
      traceParsed.success,
      true,
      `追溯响应必须满足 TraceabilityGraphResponseSchema: ${JSON.stringify(
        traceParsed.success ? '' : traceParsed.error.issues
      )}`
    );

    // =======================================================================
    // 5. 读路径：列表 total 必须等于库中真实行数，逐条满足契约
    // =======================================================================
    console.log('5. 验证读路径列表响应与契约一致性...');

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections?pageSize=100',
      headers: authHeader,
    });
    assert.equal(listRes.statusCode, 200);
    const listBody = JSON.parse(listRes.body);
    assert.equal(listBody.total, orderRows.length, '列表 total 应等于 inspection_orders 行数');
    const orderList = listBody.list as Array<Record<string, unknown>>;
    assert.equal(orderList.length, Math.min(100, orderRows.length), '当页条数应符合分页规则');
    for (const order of orderList) {
      const parsed = InspectionOrderSchema.safeParse(order);
      assert.equal(
        parsed.success,
        true,
        `检验单必须满足 InspectionOrderSchema: ${JSON.stringify(
          parsed.success ? '' : parsed.error.issues.slice(0, 3)
        )}`
      );
    }

    // 过滤条件必须真正作用在数据库上
    const failedListRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections?pageSize=100&status=FAILED',
      headers: authHeader,
    });
    assert.equal(failedListRes.statusCode, 200);
    const failedListBody = JSON.parse(failedListRes.body) as {
      total: number;
      list: Array<{ status: string }>;
    };
    assert.equal(
      failedListBody.total,
      orderRows.filter((row) => row.status === 'FAILED').length,
      '按状态过滤后的 total 应等于库中该状态行数'
    );
    for (const order of failedListBody.list) {
      assert.equal(order.status, 'FAILED', '按状态过滤的结果中不得出现其他状态');
    }

    // 多值筛选（同一字段多个值之间为 OR，后端 SQL 用 IN 实现）：total 必须等于库中并集行数
    const distinctTypes = [...new Set(orderRows.map((row) => row.orderType))];
    if (distinctTypes.length >= 2) {
      const [typeA, typeB] = distinctTypes;
      const multiTypeRes = await app.inject({
        method: 'GET',
        url: `/api/v1/inspections?pageSize=100&inspectionTypes=${encodeURIComponent(`${typeA},${typeB}`)}`,
        headers: authHeader,
      });
      assert.equal(multiTypeRes.statusCode, 200);
      const multiTypeBody = JSON.parse(multiTypeRes.body) as {
        total: number;
        list: Array<{ inspectionType: string }>;
      };
      assert.equal(
        multiTypeBody.total,
        orderRows.filter((row) => row.orderType === typeA || row.orderType === typeB).length,
        '检验类型多选(IN)的 total 应等于库中两个类型的并集行数'
      );
      for (const row of multiTypeBody.list) {
        assert.ok(
          row.inspectionType === typeA || row.inspectionType === typeB,
          '检验类型多选结果中不得出现其它类型'
        );
      }
    }

    const multiStatusRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections?pageSize=100&statuses=FAILED,COMPLETED',
      headers: authHeader,
    });
    assert.equal(multiStatusRes.statusCode, 200);
    const multiStatusBody = JSON.parse(multiStatusRes.body) as {
      total: number;
      list: Array<{ status: string }>;
    };
    assert.equal(
      multiStatusBody.total,
      orderRows.filter((row) => row.status === 'FAILED' || row.status === 'COMPLETED').length,
      '检验状态多选(IN)的 total 应等于库中两个状态的并集行数'
    );
    for (const row of multiStatusBody.list) {
      assert.ok(
        row.status === 'FAILED' || row.status === 'COMPLETED',
        '检验状态多选结果中不得出现其它状态'
      );
    }

    const inspectorIds = [
      ...new Set(orderRows.map((row) => row.inspectorId).filter((id): id is string => id !== null)),
    ];
    if (inspectorIds.length >= 2) {
      const [inspectorA, inspectorB] = inspectorIds;
      const multiInspectorRes = await app.inject({
        method: 'GET',
        url: `/api/v1/inspections?pageSize=100&inspectors=${encodeURIComponent(`${inspectorA},${inspectorB}`)}`,
        headers: authHeader,
      });
      assert.equal(multiInspectorRes.statusCode, 200);
      const multiInspectorBody = JSON.parse(multiInspectorRes.body) as { total: number };
      assert.equal(
        multiInspectorBody.total,
        orderRows.filter((row) => row.inspectorId === inspectorA || row.inspectorId === inspectorB).length,
        '检验人多选(IN)的 total 应等于库中两个检验人的并集行数'
      );
    }

    // OQC 出货检验字段与接口验证（008 迁移脚本 & 销售单/客户/ERP状态）
    const oqcRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections?type=OQC_SH&pageSize=10',
      headers: authHeader,
    });
    assert.equal(oqcRes.statusCode, 200, '按 type=OQC_SH 查询出货检验台账应返回 200');
    const oqcBody = JSON.parse(oqcRes.body) as { total: number; list: Array<Record<string, unknown>> };
    assert.ok(oqcBody.total >= 1, 'OQC 出货检验列表中应包含出货记录');
    const oqcOrder = oqcBody.list[0];
    assert.ok(oqcOrder, 'OQC 出货检验列表应至少返回一条记录');
    assert.ok(oqcOrder.salesOrderNo, '应返回 salesOrderNo 字段');
    assert.ok(oqcOrder.dispatchDate, '应返回 dispatchDate 字段');
    assert.ok(oqcOrder.customerName, '应返回 customerName 字段');
    assert.ok(oqcOrder.erpStatus, '应返回 erpStatus 字段');

    // 测试按销售出库单号检索
    const soRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections?salesOrderNo=' + encodeURIComponent(String(oqcOrder.salesOrderNo)),
      headers: authHeader,
    });
    assert.equal(soRes.statusCode, 200);
    const soBody = JSON.parse(soRes.body) as { total: number };
    assert.ok(soBody.total >= 1, '按 salesOrderNo 查询应能命中');

    // 客户 / 出库日期 / ERP 状态筛选：命中集必须逐条满足筛选值
    const oqcCustomerName = String(oqcOrder.customerName);
    const customerRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections?type=OQC_SH&customerName=' + encodeURIComponent(oqcCustomerName),
      headers: authHeader,
    });
    assert.equal(customerRes.statusCode, 200);
    const customerBody = JSON.parse(customerRes.body) as {
      total: number;
      list: Array<Record<string, unknown>>;
    };
    assert.ok(customerBody.total >= 1, '按 customerName 查询应能命中');
    assert.ok(
      customerBody.list.every((row) => String(row.customerName ?? '').includes(oqcCustomerName)),
      '按 customerName 筛选命中的每一条都应包含该客户名称'
    );

    const oqcDispatchDate = String(oqcOrder.dispatchDate);
    const dispatchRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections?type=OQC_SH&dispatchDate=' + encodeURIComponent(oqcDispatchDate),
      headers: authHeader,
    });
    assert.equal(dispatchRes.statusCode, 200);
    const dispatchBody = JSON.parse(dispatchRes.body) as {
      total: number;
      list: Array<Record<string, unknown>>;
    };
    assert.ok(dispatchBody.total >= 1, '按 dispatchDate 查询应能命中');
    assert.ok(
      dispatchBody.list.every((row) => row.dispatchDate === oqcDispatchDate),
      '按 dispatchDate 精确筛选命中的每一条出库日期都应相等'
    );

    const oqcErpStatus = String(oqcOrder.erpStatus);
    const erpRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections?type=OQC_SH&erpStatus=' + encodeURIComponent(oqcErpStatus),
      headers: authHeader,
    });
    assert.equal(erpRes.statusCode, 200);
    const erpBody = JSON.parse(erpRes.body) as {
      total: number;
      list: Array<Record<string, unknown>>;
    };
    assert.ok(erpBody.total >= 1, '按 erpStatus 查询应能命中');
    assert.ok(
      erpBody.list.every((row) => row.erpStatus === oqcErpStatus),
      '按 erpStatus 精确筛选命中的每一条 ERP 状态都应相等'
    );

    // 来料检验台账筛选下沉回归：docKeyword（检验单号 OR 采购入库单号）与
    // materialKeyword（物料编号 OR 物料名称）必须由后端真正过滤，而不是被 Zod 静默忽略。
    const iqcProbe = await db
      .selectFrom('inspectionOrders')
      .select(['orderNo', 'materialName'])
      .where('orderType', '=', 'IQC')
      .executeTakeFirst();

    if (iqcProbe) {
      const docKeywordRes = await app.inject({
        method: 'GET',
        url: '/api/v1/inspections?type=IQC&docKeyword=' + encodeURIComponent(iqcProbe.orderNo),
        headers: authHeader,
      });
      assert.equal(docKeywordRes.statusCode, 200);
      const docKeywordBody = JSON.parse(docKeywordRes.body) as {
        total: number;
        list: Array<Record<string, unknown>>;
      };
      assert.ok(docKeywordBody.total >= 1, '按 docKeyword 查询应能命中库中真实检验单号');
      assert.ok(
        docKeywordBody.list.every((row) => {
          const orderNo = String(row.orderNo ?? '');
          const receiptNo = String(row.receiptNo ?? '');
          return orderNo.includes(iqcProbe.orderNo) || receiptNo.includes(iqcProbe.orderNo);
        }),
        '按 docKeyword 筛选命中的每一条都必须命中 order_no 或 receipt_no'
      );

      // 反向断言：不存在的关键字必须返回 0 条。若参数被静默忽略（返回全表），本断言会失败，
      // 从而把「筛选参数没打通、页面却看起来正常」这类问题挡在回归网内。
      const noMatchRes = await app.inject({
        method: 'GET',
        url: '/api/v1/inspections?type=IQC&docKeyword=NO_SUCH_DOC_KEYWORD_ZZZ',
        headers: authHeader,
      });
      assert.equal(noMatchRes.statusCode, 200);
      assert.equal(
        (JSON.parse(noMatchRes.body) as { total: number }).total,
        0,
        '不存在的 docKeyword 必须返回 0 条，证明该筛选参数确实生效'
      );

      const materialKeywordRes = await app.inject({
        method: 'GET',
        url: '/api/v1/inspections?type=IQC&materialKeyword=' + encodeURIComponent(iqcProbe.materialName),
        headers: authHeader,
      });
      assert.equal(materialKeywordRes.statusCode, 200);
      const materialKeywordBody = JSON.parse(materialKeywordRes.body) as {
        total: number;
        list: Array<Record<string, unknown>>;
      };
      assert.ok(materialKeywordBody.total >= 1, '按 materialKeyword 查询应能命中库中真实物料');
      assert.ok(
        materialKeywordBody.list.every((row) => {
          const materialCode = String(row.materialCode ?? '');
          const materialName = String(row.materialName ?? '');
          return materialCode.includes(iqcProbe.materialName) || materialName.includes(iqcProbe.materialName);
        }),
        '按 materialKeyword 筛选命中的每一条都必须命中 material_code 或 material_name'
      );
    }

    // 「检验状态」派生口径筛选（docs 16 §5.1）：
    // 台账「检验状态」列由 status + judgment 共同决定，因此筛选结果必须与列上显示的字样一致；
    // 四个语义状态必须互斥且并集覆盖该类型全部单据（否则按「不合格」筛选会一条都查不到）。
    const stateGroups: Record<string, (row: Record<string, unknown>) => boolean> = {
      PENDING: (row) => row.status === 'PENDING' || row.status === 'DRAFT',
      INSPECTING: (row) => row.status === 'INSPECTING' || row.status === 'RE_INSPECTING',
      PASSED: (row) =>
        (row.status === 'COMPLETED' || row.status === 'PASSED') && row.overallDecision !== 'FAILED',
      FAILED: (row) =>
        row.status === 'FAILED' ||
        row.status === 'IN_MRB_REVIEW' ||
        ((row.status === 'COMPLETED' || row.status === 'PASSED') && row.overallDecision === 'FAILED'),
    };
    let stateSum = 0;
    for (const [state, matches] of Object.entries(stateGroups)) {
      const stateRes = await app.inject({
        method: 'GET',
        url: `/api/v1/inspections?type=OQC_SH&pageSize=100&inspectionState=${state}`,
        headers: authHeader,
      });
      assert.equal(stateRes.statusCode, 200, `inspectionState=${state} 应返回 200`);
      const stateBody = JSON.parse(stateRes.body) as {
        total: number;
        list: Array<Record<string, unknown>>;
      };
      stateSum += stateBody.total;
      assert.ok(
        stateBody.list.every(matches),
        `inspectionState=${state} 命中的每一条都应满足该派生状态口径`
      );
    }
    const oqcAllRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections?type=OQC_SH&pageSize=100',
      headers: authHeader,
    });
    const oqcAllTotal = (JSON.parse(oqcAllRes.body) as { total: number }).total;
    assert.equal(
      stateSum,
      oqcAllTotal,
      '四个派生状态（待检验/检验中/已合格/不合格）应互斥且并集覆盖该类型全部单据'
    );

    // 非法语义取值必须被契约拒绝（400），而不是被静默忽略后返回全表
    const badStateRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections?type=OQC_SH&inspectionState=NOT_A_STATE',
      headers: authHeader,
    });
    assert.equal(badStateRes.statusCode, 400, '非法 inspectionState 应被 Zod 契约拒绝');

    // 写入路径：POST /inspections 必须把 008 出库字段真实落库并可反查
    const oqcPlan = await db
      .selectFrom('inspectionPlans')
      .select(['id', 'materialCode'])
      .where('versionStatus', '=', 'ACTIVE')
      .where('inspectionStage', '=', 'OQC_SH')
      .executeTakeFirst();
    if (oqcPlan) {
      const oqcStamp = Date.now();
      const oqcSalesOrderNo = `SO-E2E-OQC-${oqcStamp}`;
      const createOqcRes = await app.inject({
        method: 'POST',
        url: '/api/v1/inspections',
        headers: authHeader,
        payload: {
          orderNo: `E2E-OQC-INS-${oqcStamp}`,
          inspectionType: 'OQC_SH',
          materialCode: oqcPlan.materialCode,
          materialName: '端到端出货检验物料',
          batchNo: `E2E-OQC-${oqcStamp}`,
          sampleQty: 5,
          planVersionId: oqcPlan.id,
          salesOrderNo: oqcSalesOrderNo,
          dispatchDate: '2026-07-06',
          customerName: oqcCustomerName,
          salesOrderPoNo: 'PO-E2E-OQC-001',
          erpStatus: '待审核',
        },
      });
      assert.equal(createOqcRes.statusCode, 201, `创建出货检验单应返回 201，实际: ${createOqcRes.body}`);
      const createdOqc = JSON.parse(createOqcRes.body) as { id: string; orderNo: string };
      createdOrderIds.push(createdOqc.id);

      const persistedOqc = await db
        .selectFrom('inspectionOrders')
        .select(['salesOrderNo', 'dispatchDate', 'customerName', 'salesOrderPoNo', 'erpStatus'])
        .where('id', '=', createdOqc.id)
        .executeTakeFirstOrThrow();
      assert.deepEqual(
        persistedOqc,
        {
          salesOrderNo: oqcSalesOrderNo,
          dispatchDate: '2026-07-06',
          customerName: oqcCustomerName,
          salesOrderPoNo: 'PO-E2E-OQC-001',
          erpStatus: '待审核',
        },
        '新建出货检验单的 008 出库字段必须与请求体一致地落库'
      );

      const reverseRes = await app.inject({
        method: 'GET',
        url: '/api/v1/inspections?salesOrderNo=' + encodeURIComponent(oqcSalesOrderNo),
        headers: authHeader,
      });
      assert.equal(reverseRes.statusCode, 200);
      const reverseBody = JSON.parse(reverseRes.body) as { list: Array<{ orderNo: string }> };
      assert.ok(
        reverseBody.list.some((row) => row.orderNo === createdOqc.orderNo),
        '新建出货检验单应能按其销售出库单号反查命中'
      );
    }

    // 2.1.0 检验单号服务端生成：省略 orderNo 时按 `{PREFIX}-{YYYYMMDD}-{NNNN}` 规则取号
    //       （出货检验 => OQC-SH-YYYYMMDD-NNNN），连续建单流水号严格递增且不重号；
    //       编号规则单一真理源见 @letian/domain 的 services/inspection-order-number.ts
    {
      const seqPlan = await db
        .selectFrom('inspectionPlans')
        .select(['id', 'materialCode'])
        .where('versionStatus', '=', 'ACTIVE')
        .where('inspectionStage', '=', 'OQC_SH')
        .executeTakeFirst();

      if (seqPlan) {
        const seqStamp = Date.now();
        const createWithServerOrderNo = async (tag: string) => {
          const res = await app.inject({
            method: 'POST',
            url: '/api/v1/inspections',
            headers: authHeader,
            payload: {
              // 刻意不传 orderNo：验证服务端按编号规则取号，而不是要求调用方自己编一个单号
              inspectionType: 'OQC_SH',
              materialCode: seqPlan.materialCode,
              materialName: '端到端单号规则物料',
              batchNo: `E2E-OQC-NOSEQ-${tag}-${seqStamp}`,
              sampleQty: 5,
              planVersionId: seqPlan.id,
              dispatchDate: '2026-07-06',
              customerName: '单号规则校验客户',
              salesOrderPoNo: 'PO-E2E-NOSEQ',
            },
          });
          assert.equal(
            res.statusCode,
            201,
            `省略 orderNo 的出货检验单应创建成功，实际: ${res.body}`
          );
          const created = JSON.parse(res.body) as { id: string; orderNo: string };
          // 先登记主键再做断言，保证断言失败时也会被 finally 清理
          createdOrderIds.push(created.id);
          return created;
        };

        const firstSeqOrder = await createWithServerOrderNo('A');
        const secondSeqOrder = await createWithServerOrderNo('B');

        const orderNoPattern = /^OQC-SH-\d{8}-\d{4}$/;
        assert.match(
          firstSeqOrder.orderNo,
          orderNoPattern,
          `服务端生成的出货检验单号必须形如 OQC-SH-YYYYMMDD-NNNN，实际: ${firstSeqOrder.orderNo}`
        );
        assert.match(
          secondSeqOrder.orderNo,
          orderNoPattern,
          `服务端生成的出货检验单号必须形如 OQC-SH-YYYYMMDD-NNNN，实际: ${secondSeqOrder.orderNo}`
        );

        const todayKey = toInspectionOrderNoDayKey(new Date());
        assert.ok(
          firstSeqOrder.orderNo.startsWith(`OQC-SH-${todayKey}-`),
          `单号日期段必须等于建单当日 ${todayKey}，实际: ${firstSeqOrder.orderNo}`
        );

        const firstSeq = Number(firstSeqOrder.orderNo.slice(-4));
        const secondSeq = Number(secondSeqOrder.orderNo.slice(-4));
        assert.equal(
          secondSeq,
          firstSeq + 1,
          '连续建单的当日流水号必须严格 +1（不重号、不跳号）'
        );

        // 落库校验：接口返回的单号必须与库中 order_no 完全一致，而不是展示层拼装出来的
        const persistedSeqRows = await db
          .selectFrom('inspectionOrders')
          .select(['id', 'orderNo'])
          .where('id', 'in', [firstSeqOrder.id, secondSeqOrder.id])
          .execute();
        assert.deepEqual(
          new Map(persistedSeqRows.map((row) => [row.id, row.orderNo])),
          new Map([
            [firstSeqOrder.id, firstSeqOrder.orderNo],
            [secondSeqOrder.id, secondSeqOrder.orderNo],
          ]),
          '服务端生成的检验单号必须真实落库'
        );
      }
    }

    // 2.1.0b 来料检验 (IQC) 006 字段写路径：receiptNo / receiptDate / specification / unit
    //        此前 create 契约声明了这些字段，但控制器与用例都未透传，调用方传了也会被静默丢弃
    //        （与 §2.1.0 的单号缺口同属「读通了、写没通」一类问题）。
    {
      const iqcPlan = await db
        .selectFrom('inspectionPlans')
        .select(['id', 'materialCode'])
        .where('versionStatus', '=', 'ACTIVE')
        .where('inspectionStage', '=', 'IQC')
        .executeTakeFirst();

      if (iqcPlan) {
        const receiptStamp = Date.now();
        const receiptNo = `RK-E2E-${receiptStamp}`;
        const createIqcRes = await app.inject({
          method: 'POST',
          url: '/api/v1/inspections',
          headers: authHeader,
          payload: {
            inspectionType: 'IQC',
            materialCode: iqcPlan.materialCode,
            materialName: '端到端来料检验物料',
            batchNo: `E2E-IQC-006-${receiptStamp}`,
            sampleQty: 5,
            planVersionId: iqcPlan.id,
            receiptNo,
            receiptDate: '2026-07-06',
            specification: 'Φ20mm',
            unit: '件',
          },
        });
        assert.equal(createIqcRes.statusCode, 201, `创建来料检验单应返回 201，实际: ${createIqcRes.body}`);
        const createdIqc = JSON.parse(createIqcRes.body) as { id: string; orderNo: string };
        createdOrderIds.push(createdIqc.id);

        const persistedIqc = await db
          .selectFrom('inspectionOrders')
          .select(['receiptNo', 'receiptDate', 'specification', 'unit'])
          .where('id', '=', createdIqc.id)
          .executeTakeFirstOrThrow();
        assert.equal(persistedIqc.receiptNo, receiptNo, '采购入库单号必须落库');
        assert.equal(persistedIqc.specification, 'Φ20mm', '规格型号必须落库');
        assert.equal(persistedIqc.unit, '件', '计量单位必须落库');
        assert.ok(persistedIqc.receiptDate instanceof Date, '入库日期应以 timestamp 落库');
        assert.equal(
          persistedIqc.receiptDate.toISOString().slice(0, 10),
          '2026-07-06',
          '入库日期必须落库为请求体给出的日期'
        );

        // 读路径回读：接口 DTO 必须原样返回 006 字段（证明读/写两侧字段名一致、没有静默改名）
        const readBackRes = await app.inject({
          method: 'GET',
          url: `/api/v1/inspections/${createdIqc.id}`,
          headers: authHeader,
        });
        assert.equal(readBackRes.statusCode, 200, `回读检验单应返回 200，实际: ${readBackRes.body}`);
        const readBack = JSON.parse(readBackRes.body) as Record<string, unknown>;
        assert.equal(readBack.receiptNo, receiptNo, 'DTO 应回读采购入库单号');
        assert.equal(readBack.specification, 'Φ20mm', 'DTO 应回读规格型号');
        assert.equal(readBack.spec, 'Φ20mm', 'DTO 的 spec 别名应与 specification 一致');
        assert.equal(readBack.unit, '件', 'DTO 应回读计量单位');
      }
    }

    // 2.1.1 检验人落库：承担实测录入的一方必须被记入工单（出货检验台账「检验人」列的真实来源）
    assert.equal(
      passPersisted?.inspectorId,
      '11000000-0000-4000-8000-000000000001',
      '提交实测值的操作人应落库为工单 inspector_id'
    );
    assert.equal(passPersisted?.inspectorName, '张强', '检验人姓名快照应与操作人一致');

    // 筛选候选接口：检验人集合必须与库中真实承担过检验的员工一致
    const filtersRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections/filters',
      headers: authHeader,
    });
    assert.equal(filtersRes.statusCode, 200);
    const filtersBody = JSON.parse(filtersRes.body) as { inspectors: Array<{ id: string; name: string }> };
    assert.deepEqual(
      new Set(filtersBody.inspectors.map((item) => item.id)),
      new Set(inspectorIds),
      '检验人候选应等于库中承担过检验的员工集合'
    );

    const mrbRes = await app.inject({ method: 'GET', url: '/api/v1/mrb/records', headers: authHeader });
    assert.equal(mrbRes.statusCode, 200);
    const mrbBody = JSON.parse(mrbRes.body);
    assert.equal(mrbBody.total, mrbRows.length, 'MRB 列表 total 应等于 mrb_reviews 行数');
    for (const record of mrbBody.list as unknown[]) {
      const parsed = MRBReviewSchema.safeParse(record);
      assert.equal(
        parsed.success,
        true,
        `MRB 记录必须满足 MRBReviewSchema: ${JSON.stringify(
          parsed.success ? '' : parsed.error.issues.slice(0, 3)
        )}`
      );
    }

    const plansRes = await app.inject({ method: 'GET', url: '/api/v1/plans', headers: authHeader });
    assert.equal(plansRes.statusCode, 200, '质检方案列表应可访问');
    const plansBody = JSON.parse(plansRes.body) as {
      total: number;
      pageSize: number;
      list: Array<Record<string, unknown>>;
    };
    const planCodeRows = await db.selectFrom('inspectionPlans').select('planCode').execute();
    const distinctPlanCodes = new Set(planCodeRows.map((row) => row.planCode)).size;
    assert.equal(plansBody.total, distinctPlanCodes, '质检方案 total 应等于库中去重方案编码数');
    assert.equal(plansBody.list.length, Math.min(plansBody.pageSize, distinctPlanCodes), '方案当页条数应符合分页规则');
    for (const plan of plansBody.list) {
      const parsed = InspectionPlanSchema.safeParse(plan);
      assert.equal(
        parsed.success,
        true,
        `质检方案必须满足 InspectionPlanSchema: ${JSON.stringify(
          parsed.success ? '' : parsed.error.issues.slice(0, 3)
        )}`
      );
    }

    const auditLogsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/logs?pageSize=100',
      headers: authHeader,
    });
    assert.equal(auditLogsRes.statusCode, 200);
    const auditLogsBody = JSON.parse(auditLogsRes.body) as { total: number; list: Array<Record<string, unknown>> };
    assert.equal(auditLogsBody.total, await countAuditLogs(), '审计日志列表 total 应等于 audit_logs 行数');
    for (const log of auditLogsBody.list) {
      const parsed = AuditLogSchema.safeParse(log);
      assert.equal(
        parsed.success,
        true,
        `审计日志必须满足 AuditLogSchema: ${JSON.stringify(parsed.success ? '' : parsed.error.issues.slice(0, 3))}`
      );
    }

    const templatesRes = await app.inject({
      method: 'GET',
      url: '/api/v1/process-settings/templates',
      headers: authHeader,
    });
    assert.equal(templatesRes.statusCode, 200);
    const templatesBody = JSON.parse(templatesRes.body) as { total: number; list: unknown[] };
    assert.ok(templatesBody.list.length > 0, '工序模板列表不应为空');
    assert.equal(templatesBody.total, templatesBody.list.length, '工序模板 total 应与返回条数一致');

    const syncHistRes = await app.inject({
      method: 'GET',
      url: '/api/v1/integration/sync/history',
      headers: authHeader,
    });
    assert.equal(syncHistRes.statusCode, 200);
    const syncHist = JSON.parse(syncHistRes.body);
    const syncLogRows = await db.selectFrom('integrationSyncLogs').select('id').execute();
    assert.equal(syncHist.total, syncLogRows.length, '同步历史 total 应等于 integration_sync_logs 行数');
    assert.ok(Array.isArray(syncHist.list));

    // ERP 主数据档案：条数必须等于库中真实行数（前端 master-data 页面依赖这些接口）
    const masterDataExpectations: Array<{ url: string; table: 'suppliers' | 'customers' | 'materials' | 'workshops' | 'employees' }> = [
      { url: '/api/v1/master-data/suppliers', table: 'suppliers' },
      { url: '/api/v1/master-data/customers', table: 'customers' },
      { url: '/api/v1/master-data/inventory', table: 'materials' },
      { url: '/api/v1/master-data/workshops', table: 'workshops' },
      { url: '/api/v1/master-data/employees', table: 'employees' },
    ];
    for (const expectation of masterDataExpectations) {
      const res = await app.inject({ method: 'GET', url: expectation.url, headers: authHeader });
      assert.equal(res.statusCode, 200, `${expectation.url} 应可访问（前端主数据页依赖）`);
      const rows = JSON.parse(res.body) as unknown[];
      assert.ok(Array.isArray(rows), `${expectation.url} 应返回数组`);
      assert.ok(rows.length > 0, `${expectation.url} 不应为空（库中应有种子主数据）`);
      const dbRows = await db
        .selectFrom(expectation.table)
        .select('id')
        .execute();
      assert.equal(rows.length, dbRows.length, `${expectation.url} 条数应等于库中 ${expectation.table} 行数`);
    }

    const categoriesRes = await app.inject({
      method: 'GET',
      url: '/api/v1/master-data/categories',
      headers: authHeader,
    });
    assert.equal(categoriesRes.statusCode, 200, '存货分类树应可访问');
    interface CategoryNode {
      code: string;
      count: number;
      children: CategoryNode[];
    }
    const categoryTree = JSON.parse(categoriesRes.body) as CategoryNode[];
    const flatten = (nodes: CategoryNode[]): CategoryNode[] =>
      nodes.flatMap((node) => [node, ...flatten(node.children)]);
    const flatCategories = flatten(categoryTree);
    const categoryRows = await db.selectFrom('inventoryCategories').select(['categoryCode']).execute();
    assert.equal(flatCategories.length, categoryRows.length, '分类树节点数应等于 inventory_categories 行数');
    const materialRows = await db.selectFrom('materials').select(['categoryCode']).execute();
    for (const node of flatCategories) {
      assert.equal(
        node.count,
        materialRows.filter((row) => row.categoryCode === node.code).length,
        `分类 [${node.code}] 的物料计数应等于库中归属该分类的物料数`
      );
    }

    // 导出：CSV 必须覆盖库中全部检验单（导出本身会留痕，单独校验）
    const auditBeforeExport = await countAuditLogs();
    const exportRes = await app.inject({
      method: 'GET',
      url: '/api/v1/export/inspections',
      headers: authHeader,
    });
    assert.equal(exportRes.statusCode, 200);
    assert.equal(
      String(exportRes.headers['content-type'] ?? '').includes('text/csv'),
      true,
      '导出接口应返回 text/csv'
    );
    assert.ok(exportRes.body.includes('检验单号'), 'CSV 应包含表头');
    for (const row of orderRows) {
      assert.ok(exportRes.body.includes(row.orderNo), `CSV 应包含库中检验单 ${row.orderNo}`);
    }
    assert.equal(
      await countAuditLogs(),
      auditBeforeExport + 1,
      '导出属于关键数据外发动作，应按实现写入 1 条审计留痕'
    );
    
    // 验证主数据新增接口 (POST /master-data/...)
    const testSupplierCode = "SUP-TEST-" + Date.now();
    const createSupRes = await app.inject({
      method: "POST",
      url: "/api/v1/master-data/suppliers",
      headers: authHeader,
      payload: {
        supplierCode: testSupplierCode,
        supplierName: "测试自动化新增供应商",
        contactPerson: "张三",
        phone: "13800000000"
      }
    });
    assert.equal(createSupRes.statusCode, 201, "新增供应商应返回 201");
    await db.deleteFrom("suppliers").where("supplierCode", "=", testSupplierCode).execute();
    console.log("✔ 主数据新增接口 (POST /master-data/...) 校验通过");
console.log('✔ 读路径列表 total / 主数据条数 / 导出内容均与真实库一致');

    // =======================================================================
    // 6. 参数校验与 404 契约
    // =======================================================================
    console.log('6. 验证入参校验契约...');

    const badQueryRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections?inspectionType=NOT_A_TYPE',
      headers: authHeader,
    });
    assert.equal(badQueryRes.statusCode, 400, '非法枚举查询参数应返回 400');
    assert.equal(JSON.parse(badQueryRes.body).code, ErrorCode.VALIDATION_FAILED);

    const notFoundRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections/00000000-0000-4000-8000-000000000000',
      headers: authHeader,
    });
    assert.equal(notFoundRes.statusCode, 404, '不存在的检验单应返回 404');
    assert.equal(JSON.parse(notFoundRes.body).code, ErrorCode.RESOURCE_NOT_FOUND);
    console.log('✔ 入参校验与 404 契约一致');
  } finally {
    // 清理本次新建的检验单，保证测试可重复执行；
    // 审计日志 / Outbox 事件为 append-only 留痕，按设计保留，不随业务数据回滚。
    if (createdOrderIds.length > 0) {
      const deleted = await db
        .deleteFrom('inspectionOrders')
        .where('id', 'in', createdOrderIds)
        .executeTakeFirst();
      console.log(
        `清理：删除本次新建的检验单 ${String(deleted.numDeletedRows)} / ${createdOrderIds.length} 条`
      );
    }
    await app.close();
    await container.dispose();
  }

  console.log('✓ 端到端集成测试全部顺利通过！');
}

runIntegrationTests().catch((err) => {
  const msg = String(err && (err.message || err.code || err));
  if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || (err && err.code === 'ECONNREFUSED')) {
    console.warn('[SKIP] 本地 PostgreSQL 未启动 (' + msg + ')，跳过端到端真实库测试');
    process.exit(0);
  }
  console.error('集成测试失败:', err);
  process.exit(1);
});
