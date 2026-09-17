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

  const inspectorToken = generateTestToken({
    userId: '11111111-1111-1111-1111-111111111111',
    userName: '测试质检员',
    role: 'INSPECTOR',
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
      unauthRes.headers['content-type']?.includes('application/problem+json'),
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
      .select(['status', 'judgment', 'items'])
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
      .select(['batchNo', 'orderNo', 'orderType', 'status', 'judgment'])
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
          res.headers['content-type']?.includes('application/problem+json'),
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
      exportRes.headers['content-type']?.includes('text/csv'),
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
  console.error('集成测试失败:', err);
  process.exit(1);
});
