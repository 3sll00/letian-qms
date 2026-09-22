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
  PlanStatsSchema,
  MRBReviewSchema,
  ProblemDetailsSchema,
  TraceabilityGraphResponseSchema,
  TraceBatchSearchResponseSchema,
  TraceOrderChainResponseSchema,
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

  /** 本次测试新建的质检方案版本行主键，结束时清理（分类兜底 / 生效周期用例专用） */
  const createdPlanIds: string[] = [];

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
      // 排掉"分类通用方案"（material_code 为空串）：它不是某个物料的方案，
      // 用它去建检验单会因 materialCode 为空被契约拒下 400
      .where('materialCode', '!=', '')
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
      tag: string,
      /** 追加写入的台账快照列（入库单号 / 入库日期 / 规格型号 …），用于验证复检单沿承口径（见 2.3.2） */
      extra: Record<string, unknown> = {}
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
          ...extra,
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

    // 2.3.2 MRB 返工处置 -> 复检单：单据标识快照必须整体沿承原单（docs/26 §5.2）
    //       回归点：复检单此前只透传物料名称 / 供应商名称，入库单号 / 入库日期等台账列在复检行上
    //       一律为空 —— 同一批货「原单有入库单号、复检行显示 -」的链路断点。
    const reinspectInboundNo = `RK-E2E-REINSPECT-${stamp}`;
    const reinspectExplicitSpec = `Φ5.0mm / 盘圆 / 304HC-E2E-${stamp}`;
    const reinspectOrder = await createOrder('REINSPECT', {
      inboundNo: reinspectInboundNo,
      inboundDate: '2026-08-20',
      // 刻意给与存货档案不同的规格 / 单位：复检单若回查主数据而不是沿承原单，下面的断言必然失败
      specification: reinspectExplicitSpec,
      unit: 'E2E-UNIT',
      customerName: '端到端验收客户',
      processType: '委外-E2E',
      vendorName: '端到端验收外协厂',
    });
    const reinspectNumeric = reinspectOrder.items.find((item) => item.dataType === 'NUMERIC');
    assert.ok(reinspectNumeric, '验收用方案应至少包含一个数值型指标');
    const reinspectFailRes = await app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${reinspectOrder.id}/submit-measurements`,
      headers: authHeader,
      payload: {
        items: reinspectOrder.items.map((item) =>
          item.itemCode === reinspectNumeric.itemCode
            ? {
                itemCode: item.itemCode,
                measuredVal:
                  (reinspectNumeric.nominalValue as number) + (reinspectNumeric.upperTolerance ?? 0) + 1,
              }
            : item.dataType === 'NUMERIC'
              ? { itemCode: item.itemCode, measuredVal: item.nominalValue as number }
              : {
                  itemCode: item.itemCode,
                  measuredText: ((item.standardText ?? '合格').split(/[,，/|]/)[0] ?? '合格').trim(),
                }
        ),
        isDraft: false,
      },
    });
    assert.equal(reinspectFailRes.statusCode, 200, `越界录入应被受理，实际: ${reinspectFailRes.body}`);
    assert.equal(
      (JSON.parse(reinspectFailRes.body) as { status: string }).status,
      'FAILED',
      '越界录入后返工源单应判定为 FAILED'
    );

    const reinspectPoolRes = await app.inject({
      method: 'GET',
      url: '/api/v1/mrb/pending-pool',
      headers: authHeader,
    });
    assert.equal(reinspectPoolRes.statusCode, 200, '待审核池查询应返回 200');
    const reinspectPoolItem = (
      JSON.parse(reinspectPoolRes.body) as {
        items: Array<{ id: string; inspectionOrderId: string }>;
      }
    ).items.find((item) => item.inspectionOrderId === reinspectOrder.id);
    assert.ok(reinspectPoolItem, '判定为 FAILED 的返工源单必须进入待审核池');

    const reinspectInitiateRes = await app.inject({
      method: 'POST',
      url: '/api/v1/mrb/pending-pool/initiate',
      headers: authHeader,
      payload: {
        pendingDefectId: reinspectOrder.id,
        urgencyLevel: 'NORMAL',
        reviewNotes: '复检单快照沿承回归',
      },
    });
    assert.equal(
      reinspectInitiateRes.statusCode,
      201,
      `发起评审应返回 201，实际: ${reinspectInitiateRes.body}`
    );
    const reinspectMrb = JSON.parse(reinspectInitiateRes.body) as { id: string; mrbNo: string };

    const reworkRes = await app.inject({
      method: 'POST',
      url: `/api/v1/mrb/records/${reinspectMrb.id}/disposition`,
      headers: authHeader,
      payload: {
        disposition: 'REWORK',
        dispositionReason: '返工后复检：验证复检单沿承原单单据快照',
      },
    });
    assert.equal(reworkRes.statusCode, 200, `返工处置应返回 200，实际: ${reworkRes.body}`);
    const reworkBody = JSON.parse(reworkRes.body) as {
      disposition?: string;
      reinspectionOrderId?: string;
      reinspectionOrderNo?: string;
    };
    assert.equal(reworkBody.disposition, 'REWORK', 'MRB 处置结论应落库为 REWORK');
    // 处置响应必须回吐连带生成的复检单标识（契约 DisposeMRBResponse）：
    // 此前用例已算出这两个值、控制器却只回吐 MRB 单据本体，页面拿不到「复检单号」可展示。
    assert.equal(
      reworkBody.reinspectionOrderNo,
      `${reinspectOrder.orderNo}-R2`,
      '返工处置响应必须回吐复检单号（页面据此显示「已生成复检单 {单号}」）'
    );
    assert.equal(
      typeof reworkBody.reinspectionOrderId,
      'string',
      '返工处置响应必须回吐复检单 UUID'
    );

    // 返工处置必须生成复检单，且复检行必须逐字段沿承原单的批次凭证快照
    const reinspectionRow = await db
      .selectFrom('inspectionOrders')
      .select([
        'id',
        'orderNo',
        'orderType',
        'status',
        'materialName',
        'specification',
        'unit',
        'inboundNo',
        'inboundDate',
        'customerName',
        'processType',
        'vendorName',
      ])
      .where('batchNo', '=', reinspectOrder.batchNo)
      // 必须锚定原单号前缀：批次内可能同时存在原单与复检单，且原单号本身含 '-R'（REINSPECT）
      .where('orderNo', 'like', `${reinspectOrder.orderNo}-R%`)
      .executeTakeFirst();
    assert.ok(reinspectionRow, 'MRB 返工处置必须生成复检单');
    if (reinspectionRow) {
      // 先登记主键再做断言，保证断言失败时也会被 finally 清理
      createdOrderIds.push(reinspectionRow.id);
      assert.equal(
        reinspectionRow.orderNo,
        `${reinspectOrder.orderNo}-R2`,
        '复检单号应按 {原单号}-R{轮次} 生成'
      );
      // 响应回吐的复检标识必须与真正落库的那张复检单指向同一行（杜绝两套口径）
      assert.equal(
        reinspectionRow.id,
        reworkBody.reinspectionOrderId,
        '处置响应回吐的复检单 UUID 必须等于落库复检行的主键'
      );
      assert.equal(
        reinspectionRow.orderNo,
        reworkBody.reinspectionOrderNo,
        '处置响应回吐的复检单号必须等于落库复检行的单号'
      );
      assert.equal(reinspectionRow.orderType, pickedPlan.inspectionStage, '复检单必须与原单同检验类型');
      assert.equal(reinspectionRow.status, 'PENDING', '新建复检单初始状态应为 PENDING');
      assert.equal(reinspectionRow.materialName, '端到端验收物料', '复检单应沿承原单物料名称快照');
      assert.equal(
        reinspectionRow.specification,
        reinspectExplicitSpec,
        '复检单应沿承原单规格型号快照（不得回查存货档案覆盖）'
      );
      assert.equal(reinspectionRow.unit, 'E2E-UNIT', '复检单应沿承原单计量单位快照');
      assert.equal(
        reinspectionRow.inboundNo,
        reinspectInboundNo,
        '复检单应沿承原单入库单号（来料检验台账「入库单号」列不得为空）'
      );
      assert.equal(
        reinspectionRow.inboundDate
          ? new Date(reinspectionRow.inboundDate).toISOString().slice(0, 10)
          : '-',
        '2026-08-20',
        '复检单应沿承原单入库日期'
      );
      assert.equal(reinspectionRow.customerName, '端到端验收客户', '复检单应沿承原单客户快照');
      assert.equal(reinspectionRow.processType, '委外-E2E', '复检单应沿承原单工艺分类快照');
      assert.equal(reinspectionRow.vendorName, '端到端验收外协厂', '复检单应沿承原单外协厂商快照');

      // 接口侧闭环：台账查询接口（前端来料检验台账同源）返回的复检行也必须带出这三列
      const reinspectListRes = await app.inject({
        method: 'GET',
        url: `/api/v1/inspections?type=${pickedPlan.inspectionStage}&docKeyword=${encodeURIComponent(
          reinspectOrder.orderNo
        )}&page=1&pageSize=50`,
        headers: authHeader,
      });
      assert.equal(reinspectListRes.statusCode, 200, `台账查询应返回 200，实际: ${reinspectListRes.body}`);
      const reinspectListRow = (
        JSON.parse(reinspectListRes.body) as {
          list: Array<{ orderNo: string; inboundNo?: string; inboundDate?: string; specification?: string }>;
        }
      ).list.find((row) => row.orderNo === `${reinspectOrder.orderNo}-R2`);
      assert.ok(reinspectListRow, '台账查询接口必须返回复检行');
      assert.equal(
        reinspectListRow?.inboundNo,
        reinspectInboundNo,
        '台账接口返回的复检行入库单号不得为空'
      );
      assert.equal(
        String(reinspectListRow?.inboundDate ?? '').slice(0, 10),
        '2026-08-20',
        '台账接口返回的复检行入库日期不得为空'
      );
      assert.equal(
        reinspectListRow?.specification,
        reinspectExplicitSpec,
        '台账接口返回的复检行规格型号不得为空'
      );
    }

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
    // 2.8 省略 planVersionId -> 服务端按「物料编码 + 检验类型」自动匹配已启用方案
    //     回归点：自动匹配分支的 plan_id 必须是真实版本行 UUID（历史缺陷：曾写入字符串 AUTO_MATCHED）
    const autoMatchRes = await app.inject({
      method: 'POST',
      url: '/api/v1/inspections',
      headers: authHeader,
      payload: {
        orderNo: `E2E-AUTOMATCH-INS-${stamp}`,
        inspectionType: pickedPlan.inspectionStage,
        materialCode: pickedPlan.materialCode,
        materialName: '端到端验收物料',
        batchNo: `E2E-AUTOMATCH-${stamp}`,
        sampleQty: 5,
      },
    });
    assert.equal(
      autoMatchRes.statusCode,
      201,
      `省略 planVersionId 时服务端应自动匹配方案并建单，实际: ${autoMatchRes.body}`
    );
    const autoMatched = JSON.parse(autoMatchRes.body) as {
      id: string;
      planVersionId: string;
      planSnapshot: { planId: string; planCode: string; items: unknown[] };
      items: unknown[];
    };
    createdOrderIds.push(autoMatched.id);

    const autoMatchedPlanRow = await db
      .selectFrom('inspectionPlans')
      .select(['id', 'materialCode', 'inspectionStage', 'versionStatus'])
      .where('id', '=', autoMatched.planVersionId)
      .executeTakeFirst();
    assert.ok(autoMatchedPlanRow, '自动匹配绑定的方案版本必须真实存在于 inspection_plans');
    assert.equal(autoMatchedPlanRow.versionStatus, 'ACTIVE', '自动匹配只能命中已启用 (ACTIVE) 版本');
    assert.equal(autoMatchedPlanRow.materialCode, pickedPlan.materialCode, '自动匹配必须命中同一物料编码');
    assert.equal(
      autoMatchedPlanRow.inspectionStage,
      pickedPlan.inspectionStage,
      '自动匹配必须命中同一检验类型'
    );
    assert.equal(
      autoMatched.planSnapshot.planId,
      autoMatched.planVersionId,
      'planSnapshot.planId 必须回填命中版本行 UUID，不得写入非 UUID 占位串'
    );
    assert.ok(autoMatched.planSnapshot.items.length > 0, '自动匹配必须带出方案的指标清单');

    const autoMatchedPersisted = await db
      .selectFrom('inspectionOrders')
      .select(['planId', 'planVersionId'])
      .where('id', '=', autoMatched.id)
      .executeTakeFirst();
    assert.ok(autoMatchedPersisted, '自动匹配新建的检验单必须已落库');
    assert.equal(autoMatchedPersisted.planId, autoMatched.planVersionId, '落库 plan_id 必须是版本行 UUID');

    // 2.8.1 物料名称 / 规格型号 / 计量单位：请求体省略时按 materialCode 从存货档案补齐（docs/26 §5.1）
    //       回归点：此前这三列在建单用例里纯透传，调用方不带 specification 就落 NULL，
    //       台账「规格型号」列对新单会再次空掉（迁移 023 只负责存量数据，本条守门负责新单）
    const specMaterial = await db
      .selectFrom('materials')
      .innerJoin('inspectionPlans', 'inspectionPlans.materialCode', 'materials.materialCode')
      .select([
        'materials.materialCode',
        'materials.materialName',
        'materials.specModel',
        'materials.unit',
        'inspectionPlans.inspectionStage',
      ])
      .where('materials.specModel', 'is not', null)
      .where('inspectionPlans.versionStatus', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!specMaterial) {
      throw new Error('演示数据应至少存在一个「有规格型号 + 已启用方案」的物料，无法验证主数据兜底');
    }

    const specRes = await app.inject({
      method: 'POST',
      url: '/api/v1/inspections',
      headers: authHeader,
      payload: {
        orderNo: `E2E-SPECSNAP-INS-${stamp}`,
        inspectionType: specMaterial.inspectionStage,
        materialCode: specMaterial.materialCode,
        batchNo: `E2E-SPECSNAP-${stamp}`,
        sampleQty: 5,
        // 刻意不传 materialName / specification / unit：三列必须由服务端从存货档案补齐
      },
    });
    assert.equal(
      specRes.statusCode,
      201,
      `省略物料名称 / 规格型号 / 计量单位时应能按存货档案建单，实际: ${specRes.body}`
    );
    const specCreated = JSON.parse(specRes.body) as {
      id: string;
      materialName: string;
      specification?: string;
      unit?: string;
    };
    createdOrderIds.push(specCreated.id);
    assert.equal(specCreated.materialName, specMaterial.materialName, '省略物料名称时应按存货档案补齐');
    assert.equal(specCreated.specification, specMaterial.specModel, '省略规格型号时应按存货档案补齐');
    assert.equal(specCreated.unit, specMaterial.unit, '省略计量单位时应按存货档案补齐');

    const specPersisted = await db
      .selectFrom('inspectionOrders')
      .select(['materialName', 'specification', 'unit'])
      .where('id', '=', specCreated.id)
      .executeTakeFirst();
    assert.equal(
      specPersisted?.materialName,
      specMaterial.materialName,
      '落库 material_name 必须等于存货档案名称'
    );
    assert.equal(
      specPersisted?.specification,
      specMaterial.specModel,
      '落库 specification 必须等于存货档案规格型号'
    );
    assert.equal(specPersisted?.unit, specMaterial.unit, '落库 unit 必须等于存货档案计量单位');

    // 2.9 无任何已启用方案的物料 -> 400 明确报错（绝不静默降级为其它方案）
    const noPlanRes = await app.inject({
      method: 'POST',
      url: '/api/v1/inspections',
      headers: authHeader,
      payload: {
        orderNo: `E2E-NOPLAN-INS-${stamp}`,
        inspectionType: 'IQC',
        materialCode: `NO-PLAN-MATERIAL-${stamp}`,
        materialName: '无方案物料',
        batchNo: `E2E-NOPLAN-${stamp}`,
        sampleQty: 5,
      },
    });
    assert.equal(noPlanRes.statusCode, 400, '按物料匹配不到启用方案应返回 400');
    assert.equal(JSON.parse(noPlanRes.body).code, ErrorCode.INSPECTION_PLAN_NOT_FOUND);

    // 2.10 方案匹配只读接口：命中返回指标清单与版本行 UUID，未命中返回 404
    const matchRes = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/match?materialCode=${encodeURIComponent(pickedPlan.materialCode)}&inspectionType=${pickedPlan.inspectionStage}`,
      headers: authHeader,
    });
    assert.equal(matchRes.statusCode, 200, `按物料匹配方案应返回 200，实际: ${matchRes.body}`);
    const matchedBody = JSON.parse(matchRes.body) as {
      planVersionId: string;
      versionNo: string;
      items: Array<{ itemCode: string }>;
      matchedAt: string;
    };
    assert.ok(matchedBody.items.length > 0, '方案匹配接口必须返回待检指标清单');
    assert.equal(
      matchedBody.planVersionId,
      autoMatched.planVersionId,
      '匹配接口与建单自动匹配必须命中同一个版本行（口径唯一）'
    );

    const matchMissRes = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/match?materialCode=NO-PLAN-MATERIAL-${stamp}&inspectionType=IQC`,
      headers: authHeader,
    });
    assert.equal(matchMissRes.statusCode, 404, '无启用方案时匹配接口应返回 404');
    assert.equal(JSON.parse(matchMissRes.body).code, ErrorCode.INSPECTION_PLAN_NOT_FOUND);
    console.log('✔ 方案自动匹配（建单自动匹配 / 匹配接口 / 无方案 400 与 404）均符合预期');

    // 2.11 分类级兜底 + 生效周期 + 优先级（TBD-01 / TBD-02 回归）
    //      场景物料 MAT-316L-04（分类 CAT-RAW-WIRE）在种子数据中无专属方案：
    //      ① 无任何方案 -> 404；② 只有过期分类方案 -> 仍 404（生效周期生效）；
    //      ③ 补上有效分类方案 -> 命中 MATERIAL_CATEGORY；④ 建单可自动绑定该分类方案；
    //      ⑤ 再补物料专属方案 -> 优先级切换为 MATERIAL。
    const fallbackMaterial = 'MAT-316L-04';
    const fallbackCategory = 'CAT-RAW-WIRE';
    const fallbackOrderIdsBefore = createdOrderIds.length;

    const insertActivePlanRow = async (params: {
      planCode: string;
      planName: string;
      materialCode: string;
      samplingConfig?: Record<string, unknown>;
    }): Promise<string> => {
      const id = crypto.randomUUID();
      createdPlanIds.push(id);
      await db
        .insertInto('inspectionPlans')
        .values({
          id,
          planCode: params.planCode,
          planName: params.planName,
          materialCode: params.materialCode,
          categoryCode: fallbackCategory,
          version: 'v1.0.0',
          versionStatus: 'ACTIVE',
          inspectionStage: 'IQC',
          items: JSON.stringify([
            {
              itemCode: 'FALLBACK-DIA-001',
              name: '直径',
              dataType: 'NUMERIC',
              metricCategory: 'DIMENSION',
              standardText: 'Φ4.00±0.02mm',
              nominalValue: 4,
              upperTolerance: 0.02,
              lowerTolerance: 0.02,
              unit: 'mm',
              isMandatory: true,
            },
          ]),
          samplingConfig: JSON.stringify({
            samplingScheme: 'GB_T_2828',
            aqlLevel: 'II',
            strictness: 'NORMAL',
            ...(params.samplingConfig ?? {}),
          }),
          createdBy: '11000000-0000-4000-8000-000000000001',
        })
        .execute();
      return id;
    };

    const matchFallbackMaterial = async (): Promise<{ statusCode: number; body: string }> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/plans/match?materialCode=${fallbackMaterial}&inspectionType=IQC`,
        headers: authHeader,
      });
      return { statusCode: res.statusCode, body: res.body };
    };

    // ① 物料无专属方案、分类也无通用方案 -> 404
    const noAnyPlan = await matchFallbackMaterial();
    assert.equal(noAnyPlan.statusCode, 404, `无任何方案时应返回 404，实际: ${noAnyPlan.body}`);

    // ② 只有已过期的分类通用方案 -> 依然 404（生效周期过滤，避免换版期间命中过期方案）
    const expiredPlanId = await insertActivePlanRow({
      planCode: `QP-TEST-EXPIRED-${stamp}`,
      planName: '【测试】已过期分类通用方案',
      materialCode: '',
      samplingConfig: { effectiveEndDate: '2020-01-01' },
    });
    assert.ok(expiredPlanId, '过期分类方案应已写入');
    const expiredOnly = await matchFallbackMaterial();
    assert.equal(
      expiredOnly.statusCode,
      404,
      `仅存在已过期方案时必须返回 404（不得命中过期方案），实际: ${expiredOnly.body}`
    );

    // ③ 补上生效期内的分类通用方案 -> 命中 MATERIAL_CATEGORY
    const categoryPlanId = await insertActivePlanRow({
      planCode: `QP-TEST-CATEGORY-${stamp}`,
      planName: '【测试】CAT-RAW-WIRE 分类通用方案',
      materialCode: '',
      samplingConfig: { effectiveStartDate: '2020-01-01', effectiveEndDate: '2099-12-31' },
    });
    const categoryMatched = await matchFallbackMaterial();
    assert.equal(categoryMatched.statusCode, 200, `分类通用方案应被命中，实际: ${categoryMatched.body}`);
    const categoryMatchedBody = JSON.parse(categoryMatched.body) as {
      matchSource: string;
      planVersionId: string;
      items: unknown[];
    };
    assert.equal(
      categoryMatchedBody.matchSource,
      'MATERIAL_CATEGORY',
      '兜底命中分类通用方案时 matchSource 必须为 MATERIAL_CATEGORY'
    );
    assert.equal(categoryMatchedBody.planVersionId, categoryPlanId, '必须命中生效期内的那份分类方案');
    assert.ok(categoryMatchedBody.items.length > 0, '分类兜底方案同样必须返回指标清单');

    // ④ 建单省略 planVersionId -> 自动绑定分类通用方案
    const fallbackCreateRes = await app.inject({
      method: 'POST',
      url: '/api/v1/inspections',
      headers: authHeader,
      payload: {
        orderNo: `E2E-CATFALLBACK-INS-${stamp}`,
        inspectionType: 'IQC',
        materialCode: fallbackMaterial,
        materialName: '316L 不锈钢线材 Φ4.0mm',
        batchNo: `E2E-CATFALLBACK-${stamp}`,
        sampleQty: 5,
      },
    });
    assert.equal(
      fallbackCreateRes.statusCode,
      201,
      `分类兜底应能自动匹配方案建单，实际: ${fallbackCreateRes.body}`
    );
    const fallbackCreated = JSON.parse(fallbackCreateRes.body) as { id: string; planVersionId: string };
    createdOrderIds.push(fallbackCreated.id);
    assert.equal(
      fallbackCreated.planVersionId,
      categoryPlanId,
      '建单必须绑定分类兜底命中的方案版本'
    );

    // ⑤ 补上物料专属方案 -> 优先级切换到物料级
    const specificPlanId = await insertActivePlanRow({
      planCode: `QP-TEST-SPECIFIC-${stamp}`,
      planName: '【测试】MAT-316L-04 专属方案',
      materialCode: fallbackMaterial,
    });
    const specificMatched = await matchFallbackMaterial();
    assert.equal(specificMatched.statusCode, 200, '物料专属方案应被命中');
    const specificMatchedBody = JSON.parse(specificMatched.body) as { matchSource: string; planVersionId: string };
    assert.equal(specificMatchedBody.matchSource, 'MATERIAL', '物料专属方案命中时 matchSource 必须为 MATERIAL');
    assert.equal(specificMatchedBody.planVersionId, specificPlanId, '物料专属方案优先级必须高于分类通用方案');
    assert.equal(createdOrderIds.length > fallbackOrderIdsBefore, true, '分类兜底建单应纳入清理清单');
    console.log('✔ 质检方案分类兜底 / 生效周期 / 物料优先于分类 均符合预期');

    // 2.12 只读回看的数据源（TBD-04 回归）：GET /inspections/{id} 必须自带
    //      「本单快照的判定基准 + 实测值 + 落库判定」，让前端回看无需再按物料调 /plans/match 取"当前生效方案"。
    const readbackRes = await app.inject({
      method: 'GET',
      url: `/api/v1/inspections/${passOrder.id}`,
      headers: authHeader,
    });
    assert.equal(readbackRes.statusCode, 200, `只读回看详情应可读取，实际: ${readbackRes.body}`);
    const readback = JSON.parse(readbackRes.body) as {
      id: string;
      planVersionId: string;
      planSnapshot: {
        versionId: string;
        snapshotAt: string;
        items: Array<{ itemCode: string; standardText?: string; nominalValue?: number }>;
      };
      items: Array<{
        itemCode: string;
        standardText?: string;
        nominalValue?: number;
        measuredVal?: number;
        result: string;
      }>;
    };
    assert.equal(readback.id, passOrder.id);
    assert.equal(
      readback.planSnapshot.versionId,
      readback.planVersionId,
      '详情返回的快照版本必须与工单绑定的 planVersionId 一致（回看提示"本单方案快照"的依据）'
    );
    assert.ok(
      readback.planSnapshot.snapshotAt.length > 0,
      '详情必须带方案快照生成时间，回看页要如实告知判定基准的固化时点'
    );
    assert.equal(
      readback.planSnapshot.items.length,
      readback.items.length,
      '工单实测项必须与方案快照指标项一一对应'
    );
    for (const item of readback.items) {
      const snapshotItem = readback.planSnapshot.items.find((snapshot) => snapshot.itemCode === item.itemCode);
      assert.ok(snapshotItem, `实测项 ${item.itemCode} 必须能在本单快照里找到判定基准`);
      assert.equal(
        item.standardText,
        snapshotItem?.standardText,
        `回看标准语必须取自本单快照，而不是当前生效方案 (${item.itemCode})`
      );
      assert.equal(item.result, 'PASSED', `回看单项判定必须是工单落库判定 (${item.itemCode})`);
      if (snapshotItem?.nominalValue !== undefined) {
        assert.equal(
          item.nominalValue,
          snapshotItem.nominalValue,
          `回看数值基准必须取自本单快照 (${item.itemCode})`
        );
        assert.equal(
          typeof item.measuredVal,
          'number',
          `回看必须自带实测值，前端不得自行重算 (${item.itemCode})`
        );
      }
    }
    console.log('✔ 只读回看数据源（本单快照自带判定基准 / 实测值 / 落库判定）符合预期');

    // 2.13 定性项「可接受值清单」(TBD-06)：
    //      判定基准必须是方案侧结构化配置的 acceptableValues，而不是从 standardText 猜分隔符；
    //      清单成员即便不在标准语里也必须放行，清单之外的取值一律不合格。
    const acceptableValuesMaterial = `MAT-E2E-TBD06-${stamp}`;
    const acceptableValuesPlanId = crypto.randomUUID();
    createdPlanIds.push(acceptableValuesPlanId);
    const acceptableValuesList = ['无裂纹', '无肉眼可见裂纹'];
    await db
      .insertInto('inspectionPlans')
      .values({
        id: acceptableValuesPlanId,
        planCode: `QP-TEST-TBD06-${stamp}`,
        planName: '【测试】TBD-06 定性项可接受值清单',
        materialCode: acceptableValuesMaterial,
        categoryCode: fallbackCategory,
        version: 'v1.0.0',
        versionStatus: 'ACTIVE',
        inspectionStage: 'IQC',
        // 标准语只写一个值，清单里多给一个 —— 判定必须只认清单
        items: JSON.stringify([
          {
            itemCode: 'TBD06-APP-001',
            name: '表面裂纹',
            dataType: 'QUALITATIVE',
            metricCategory: 'APPEARANCE',
            standardText: '无裂纹',
            acceptableValues: acceptableValuesList,
            unit: '外观',
            isMandatory: true,
          },
        ]),
        samplingConfig: JSON.stringify({
          samplingScheme: 'GB_T_2828',
          aqlLevel: 'II',
          strictness: 'NORMAL',
        }),
        createdBy: '11000000-0000-4000-8000-000000000001',
      })
      .execute();

    const createAcceptableValuesOrder = async (
      tag: string
    ): Promise<{ id: string; itemCode: string }> => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/inspections',
        headers: authHeader,
        payload: {
          orderNo: `E2E-TBD06-${tag}-INS-${stamp}`,
          inspectionType: 'IQC',
          materialCode: acceptableValuesMaterial,
          materialName: 'TBD-06 可接受值清单验收物料',
          batchNo: `E2E-TBD06-${tag}-${stamp}`,
          sampleQty: 3,
        },
      });
      assert.equal(createRes.statusCode, 201, `TBD-06 建单应返回 201，实际: ${createRes.body}`);
      const created = JSON.parse(createRes.body) as {
        id: string;
        planVersionId: string;
        items: Array<{ itemCode: string; standardText?: string; acceptableValues?: string[] }>;
      };
      createdOrderIds.push(created.id);
      assert.equal(
        created.planVersionId,
        acceptableValuesPlanId,
        'TBD-06 建单必须绑定含可接受值清单的方案版本'
      );
      const orderItem = created.items[0];
      assert.ok(orderItem, 'TBD-06 工单必须携带方案快照的指标项');
      assert.deepEqual(
        orderItem.acceptableValues,
        acceptableValuesList,
        '可接受值清单必须随建单固化进本单快照（回看与判定都读它）'
      );
      assert.equal(orderItem.standardText, '无裂纹', '标准语同样应固化进快照');

      const persisted = await db
        .selectFrom('inspectionOrders')
        .select(['items'])
        .where('id', '=', created.id)
        .executeTakeFirst();
      const persistedItems = (persisted?.items ?? []) as Array<{ acceptableValues?: string[] }>;
      assert.deepEqual(
        persistedItems[0]?.acceptableValues,
        acceptableValuesList,
        '可接受值清单必须真实落到 inspection_orders.items 物理列'
      );
      return { id: created.id, itemCode: orderItem.itemCode };
    };

    // ① 只写在清单里的取值（标准语里没有它）-> PASSED，证明清单优先于标准语
    const listOnlyOrder = await createAcceptableValuesOrder('LIST');
    const listOnlyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${listOnlyOrder.id}/submit-measurements`,
      headers: authHeader,
      payload: {
        items: [{ itemCode: listOnlyOrder.itemCode, measuredText: '无肉眼可见裂纹' }],
        isDraft: false,
      },
    });
    assert.equal(listOnlyRes.statusCode, 200, `TBD-06 录入应返回 200，实际: ${listOnlyRes.body}`);
    const listOnlyBody = JSON.parse(listOnlyRes.body) as {
      items: Array<{ itemCode: string; result: string }>;
    };
    assert.equal(
      listOnlyBody.items[0]?.result,
      'PASSED',
      '清单里明写的取值必须判 PASSED（判定只认清单，不按标准语分隔符猜）'
    );

    // ② 清单之外的自由描述 -> FAILED，证明清单不是放行后门
    const offListOrder = await createAcceptableValuesOrder('OFFLIST');
    const offListRes = await app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${offListOrder.id}/submit-measurements`,
      headers: authHeader,
      payload: {
        items: [{ itemCode: offListOrder.itemCode, measuredText: '表面无肉眼可见裂纹' }],
        isDraft: false,
      },
    });
    assert.equal(offListRes.statusCode, 200, `TBD-06 录入应返回 200，实际: ${offListRes.body}`);
    const offListBody = JSON.parse(offListRes.body) as {
      items: Array<{ itemCode: string; result: string }>;
    };
    assert.equal(
      offListBody.items[0]?.result,
      'FAILED',
      '清单之外的自由描述仍必须判 FAILED（TBD-06 只改判定基准来源，不放宽判定口径）'
    );
    console.log('✔ 定性项可接受值清单（快照固化 / 清单优先判标 / 清单外仍不合格）符合预期');

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

    // -----------------------------------------------------------------------
    // 4.5 追溯看板新增能力：影响面统计 / 批次检索 / 订单检验环节
    //     影响面必须与独立推导一致 —— 这里不调用任何被测代码，
    //     直接遍历 batch_trace_relations / batch_trace_nodes 自行算一遍（docs/24 §8 验收口径 2）。
    // -----------------------------------------------------------------------
    const relationRows = await db
      .selectFrom('batchTraceRelations')
      .select(['parentBatch', 'childBatch'])
      .execute();
    const traceNodeRows = await db
      .selectFrom('batchTraceNodes')
      .select(['batchNo', 'orderNo', 'supplierOrCustomer'])
      .execute();

    /** 只沿 parent -> child 方向闭包；深度上限与接口 maxDepth 保持一致 */
    const walkDirection = (root: string, maxDepth: number, forward: boolean): Set<string> => {
      const seen = new Set<string>();
      const queue: Array<{ batchNo: string; depth: number }> = [{ batchNo: root, depth: 0 }];
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || current.depth >= maxDepth) continue;
        for (const edge of relationRows) {
          const from = forward ? edge.parentBatch : edge.childBatch;
          const to = forward ? edge.childBatch : edge.parentBatch;
          if (from === current.batchNo && !seen.has(to)) {
            seen.add(to);
            queue.push({ batchNo: to, depth: current.depth + 1 });
          }
        }
      }
      return seen;
    };

    const rootBatchNo = 'LOT-2026-FN-01';
    const expectedDownstream = walkDirection(rootBatchNo, 10, true);
    const expectedUpstream = walkDirection(rootBatchNo, 10, false);
    const uniqueSorted = (values: string[]): string[] => Array.from(new Set(values)).sort();
    const expectedDownstreamOrderNos = uniqueSorted(
      traceNodeRows
        .filter((node) => expectedDownstream.has(node.batchNo) && node.orderNo !== null)
        .map((node) => node.orderNo as string)
    );
    const expectedDownstreamParties = uniqueSorted(
      traceNodeRows
        .filter((node) => expectedDownstream.has(node.batchNo) && node.supplierOrCustomer !== null)
        .map((node) => node.supplierOrCustomer as string)
    );

    const graphBody = JSON.parse(traceRes.body) as {
      impact: {
        downstreamBatchCount: number;
        upstreamBatchCount: number;
        downstreamOrderCount: number;
        downstreamPartyCount: number;
        downstreamOrderNos: string[];
        downstreamParties: string[];
      };
    };
    assert.equal(graphBody.impact.downstreamBatchCount, expectedDownstream.size, '下游批次数必须与独立推导一致');
    assert.equal(graphBody.impact.upstreamBatchCount, expectedUpstream.size, '上游批次数必须与独立推导一致');
    assert.deepEqual(graphBody.impact.downstreamOrderNos, expectedDownstreamOrderNos, '下游关联单据清单必须与独立推导一致');
    assert.deepEqual(graphBody.impact.downstreamParties, expectedDownstreamParties, '下游单位清单必须与独立推导一致');
    assert.equal(graphBody.impact.downstreamOrderCount, graphBody.impact.downstreamOrderNos.length, '下游单据计数必须等于清单长度');
    assert.equal(graphBody.impact.downstreamPartyCount, graphBody.impact.downstreamParties.length, '下游单位计数必须等于清单长度');

    // 批次检索：追溯主键是批次号，订单号只是检索条件 —— 按客户采购订单号必须回到该订单的出货批次
    const batchSearchRes = await app.inject({
      method: 'GET',
      url: '/api/v1/traceability/batches?orderNo=PO-B-002',
      headers: authHeader,
    });
    assert.equal(batchSearchRes.statusCode, 200, '批次检索应返回 200');
    const batchSearchParsed = TraceBatchSearchResponseSchema.safeParse(JSON.parse(batchSearchRes.body));
    assert.equal(
      batchSearchParsed.success,
      true,
      `批次检索响应必须满足 TraceBatchSearchResponseSchema: ${JSON.stringify(
        batchSearchParsed.success ? '' : batchSearchParsed.error.issues
      )}`
    );
    const batchSearchBody = JSON.parse(batchSearchRes.body) as {
      total: number;
      items: Array<{ batchNo: string; sources: string[]; relatedOrderNos: string[] }>;
    };
    assert.ok(batchSearchBody.total >= 1, '按客户采购订单号 PO-B-002 必须命中最少 1 个批次');
    const pOBatch = batchSearchBody.items.find((item) => item.batchNo === 'LOT-20260706-0002');
    assert.ok(pOBatch !== undefined, 'PO-B-002 的出货批次 LOT-20260706-0002 必须出现在检索结果里');
    assert.ok(pOBatch.sources.includes('INSPECTION_ORDER'), '该批次只有检验台账、尚无血缘节点，来源应标为 INSPECTION_ORDER');
    assert.ok(pOBatch.relatedOrderNos.includes('OQC-SH-20260706-0002'), '检索行必须带出该批次的检验单号清单');

    // 特采（让步接收）节点必须如实呈现，并能举证 MRB 单号与客户书面授权件
    const concessionRes = await app.inject({
      method: 'GET',
      url: '/api/v1/traceability/graph/B20231011-92',
      headers: authHeader,
    });
    assert.equal(concessionRes.statusCode, 200, '特采批次图谱应返回 200');
    const concessionBody = JSON.parse(concessionRes.body) as {
      nodes: Array<{
        batchNo: string;
        nodeStatus: string;
        mrbNo?: string;
        concessionAttachmentUrl?: string;
        furnaceHeatBatchNo?: string;
        materialCode?: string;
      }>;
    };
    const concessionRoot = concessionBody.nodes.find((node) => node.batchNo === 'B20231011-92');
    assert.ok(concessionRoot !== undefined, '特采批次必须是图谱根节点');
    assert.equal(concessionRoot.nodeStatus, 'CONCESSION', 'IQC 特采放行的批次必须如实标记为 CONCESSION，不得压成 PASSED');
    assert.equal(concessionRoot.mrbNo, 'MRB-20231011-01', '特采节点必须能按 batch_no 反查真实 MRB 单号');
    assert.equal(
      typeof concessionRoot.concessionAttachmentUrl,
      'string',
      '特采节点必须携带客户书面授权件地址'
    );
    assert.equal(concessionRoot.furnaceHeatBatchNo, '230910-112', '节点必须带出炉批号');
    assert.equal(concessionRoot.materialCode, 'MAT-35CRMO-08', '节点必须带出物料编码');

    // 订单检验环节：按工单号命中同一轮生产的下料/滚丝/成品检，且按工艺序位排序
    const orderChainRes = await app.inject({
      method: 'GET',
      url: '/api/v1/traceability/orders/WO-20231012-01',
      headers: authHeader,
    });
    assert.equal(orderChainRes.statusCode, 200, '订单检验环节应返回 200');
    const orderChainParsed = TraceOrderChainResponseSchema.safeParse(JSON.parse(orderChainRes.body));
    assert.equal(
      orderChainParsed.success,
      true,
      `订单检验环节响应必须满足 TraceOrderChainResponseSchema: ${JSON.stringify(
        orderChainParsed.success ? '' : orderChainParsed.error.issues
      )}`
    );
    const orderChainBody = JSON.parse(orderChainRes.body) as {
      matchedBy: string;
      batchNos: string[];
      stages: Array<{ seq: number; stageName: string; orderType: string; sourceDocNo?: string }>;
    };
    assert.equal(orderChainBody.matchedBy, 'WORK_ORDER_NO', 'WO-20231012-01 必须按工单号命中');
    assert.equal(orderChainBody.stages.length, 3, '同一工单应关联下料检/滚丝检/成品检三个环节');
    const stageSeqs = orderChainBody.stages.map((stage) => stage.seq);
    assert.deepEqual(stageSeqs, [...stageSeqs].sort((a, b) => a - b), '环节必须按工艺序位升序（不是按时间排序）');
    assert.deepEqual(
      orderChainBody.stages.map((stage) => stage.orderType),
      ['IPQC_CT', 'IPQC_RL', 'IPQC_FN'],
      '三环节必须按「下料 -> 滚丝 -> 成品检」排列'
    );
    for (const stage of orderChainBody.stages) {
      assert.equal(stage.sourceDocNo, 'WO-20231012-01', '来源单据必须是真实 MES 工单号，而不是拿批次号顶替');
    }

    const missingOrderRes = await app.inject({
      method: 'GET',
      url: '/api/v1/traceability/orders/PO-NOT-EXIST',
      headers: authHeader,
    });
    assert.equal(missingOrderRes.statusCode, 404, '不存在的订单号必须返回 404');

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

    // 来料检验台账筛选下沉回归：docKeyword（检验单号 OR 入库单号）与
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
          const inboundNo = String(row.inboundNo ?? '');
          return orderNo.includes(iqcProbe.orderNo) || inboundNo.includes(iqcProbe.orderNo);
        }),
        '按 docKeyword 筛选命中的每一条都必须命中 order_no 或 inbound_no'
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
      // 取数必须确定性：无 ORDER BY 时 PG 返回顺序不定，且会命中
      // 测试自建的"分类通用方案"（material_code 空串）而建单 400
      .where('materialCode', '!=', '')
      .orderBy('planCode', 'asc')
      .orderBy('version', 'asc')
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
        // 同上：确定性取数 + 排掉分类通用方案，避免偶发取到 material_code 空串的方案
        .where('materialCode', '!=', '')
        .orderBy('planCode', 'asc')
        .orderBy('version', 'asc')
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

    // 2.1.0b 来料检验 (IQC) 006 字段写路径：inboundNo / inboundDate / specification / unit
    //        此前 create 契约声明了这些字段，但控制器与用例都未透传，调用方传了也会被静默丢弃
    //        （与 §2.1.0 的单号缺口同属「读通了、写没通」一类问题）。
    {
      const iqcPlan = await db
        .selectFrom('inspectionPlans')
        .select(['id', 'materialCode'])
        .where('versionStatus', '=', 'ACTIVE')
        .where('inspectionStage', '=', 'IQC')
        // 本用例前面建过 material_code 空串的 IQC 分类通用方案，
        // 无 ORDER BY 的 executeTakeFirst 会偶发命中它 → 建单 400
        .where('materialCode', '!=', '')
        .orderBy('planCode', 'asc')
        .orderBy('version', 'asc')
        .executeTakeFirst();

      if (iqcPlan) {
        const inboundStamp = Date.now();
        const inboundNo = `RK-E2E-${inboundStamp}`;
        const createIqcRes = await app.inject({
          method: 'POST',
          url: '/api/v1/inspections',
          headers: authHeader,
          payload: {
            inspectionType: 'IQC',
            materialCode: iqcPlan.materialCode,
            materialName: '端到端来料检验物料',
            batchNo: `E2E-IQC-006-${inboundStamp}`,
            sampleQty: 5,
            planVersionId: iqcPlan.id,
            inboundNo,
            inboundDate: '2026-07-06',
            specification: 'Φ20mm',
            unit: '件',
          },
        });
        assert.equal(createIqcRes.statusCode, 201, `创建来料检验单应返回 201，实际: ${createIqcRes.body}`);
        const createdIqc = JSON.parse(createIqcRes.body) as { id: string; orderNo: string };
        createdOrderIds.push(createdIqc.id);

        const persistedIqc = await db
          .selectFrom('inspectionOrders')
          .select(['inboundNo', 'inboundDate', 'specification', 'unit'])
          .where('id', '=', createdIqc.id)
          .executeTakeFirstOrThrow();
        assert.equal(persistedIqc.inboundNo, inboundNo, '入库单号必须落库');
        assert.equal(persistedIqc.specification, 'Φ20mm', '规格型号必须落库');
        assert.equal(persistedIqc.unit, '件', '计量单位必须落库');
        assert.ok(persistedIqc.inboundDate instanceof Date, '入库日期应以 timestamp 落库');
        assert.equal(
          persistedIqc.inboundDate.toISOString().slice(0, 10),
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
        assert.equal(readBack.inboundNo, inboundNo, 'DTO 应回读入库单号');
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

    // 字段链路核对（docs/20-质检方案设计页数据字段与接口打通设计.md）：
    // 页面 10 列必须全部能追溯到库表或接口派生字段，值必须与真实库一致（不能被前端/接口二次加工）。
    type PlanListItem = {
      planCode: string;
      materialCode?: string | null;
      categoryCode?: string | null;
      materialName?: string;
      categoryName?: string;
      status?: string;
      versions?: Array<{ status: string; createdBy: string; createdByName?: string }>;
    };
    const planItems = plansBody.list as unknown as PlanListItem[];
    const materialNameRows = await db
      .selectFrom('materials')
      .select(['materialCode', 'materialName'])
      .execute();
    const employeeNameRows = await db.selectFrom('employees').select(['id', 'name']).execute();
    const categoryNameRows = await db
      .selectFrom('inventoryCategories')
      .select(['categoryCode', 'categoryName'])
      .execute();
    const materialNameByCode = new Map(materialNameRows.map((row) => [row.materialCode, row.materialName]));
    const employeeNameById = new Map(employeeNameRows.map((row) => [row.id, row.name]));
    const categoryNameByCode = new Map(categoryNameRows.map((row) => [row.categoryCode, row.categoryName]));

    for (const plan of planItems) {
      const materialCode = plan.materialCode ?? '';
      const categoryCode = plan.categoryCode ?? null;
      const versions = plan.versions ?? [];
      assert.ok(versions.length > 0, `方案 [${plan.planCode}] 必须携带版本行`);

      // 状态列：接口给出的方案级状态必须等于由版本行派生的唯一口径
      const expectedStatus = versions.some((version) => version.status === 'ACTIVE')
        ? 'ENABLED'
        : versions.some((version) => version.status === 'DRAFT')
          ? 'PENDING_APPROVAL'
          : 'DISABLED';
      assert.equal(
        plan.status,
        expectedStatus,
        `方案 [${plan.planCode}] 的 status 必须由版本状态派生（库中版本状态: ${versions
          .map((version) => version.status)
          .join(',')}）`
      );

      // 适用产品列：物料专属方案必须回带物料主数据名称，且与库中 materials 完全一致
      assert.equal(
        plan.materialName,
        materialNameByCode.get(materialCode),
        `方案 [${plan.planCode}] 的 materialName 必须等于 materials 中 ${materialCode} 的名称`
      );

      // 检验类别列 / 创建人列：创建人姓名必须等于 users 主数据（employees.id -> name）
      const effectiveVersion =
        versions.find((version) => version.status === 'ACTIVE') ?? versions[versions.length - 1];
      assert.ok(effectiveVersion !== undefined, `方案 [${plan.planCode}] 必须有生效或最新版本`);
      assert.equal(
        effectiveVersion?.createdByName,
        employeeNameById.get(effectiveVersion?.createdBy ?? ''),
        `方案 [${plan.planCode}] 的 createdByName 必须等于 employees 中 ${effectiveVersion?.createdBy} 的姓名`
      );

      // 分类名读时派生：有 category_code 的方案必须能解析出分类名
      if (categoryCode !== null) {
        assert.equal(
          plan.categoryName,
          categoryNameByCode.get(categoryCode),
          `方案 [${plan.planCode}] 的 categoryName 必须等于 inventory_categories 中 ${categoryCode} 的名称`
        );
      }
    }

    // KPI 卡片：必须来自服务端全量聚合（不受分页影响），且与库中真实状态一致
    const planStatsRes = await app.inject({ method: 'GET', url: '/api/v1/plans/stats', headers: authHeader });
    assert.equal(planStatsRes.statusCode, 200, `质检方案 KPI 应可访问，实际: ${planStatsRes.body}`);
    const planStats = JSON.parse(planStatsRes.body) as {
      total: number;
      enabled: number;
      pending: number;
      productCount: number;
    };
    const statsParsed = PlanStatsSchema.safeParse(planStats);
    assert.equal(
      statsParsed.success,
      true,
      `质检方案 KPI 必须满足 PlanStatsSchema: ${JSON.stringify(
        statsParsed.success ? '' : statsParsed.error.issues.slice(0, 3)
      )}`
    );

    const statsRows = await db
      .selectFrom('inspectionPlans')
      .select(['planCode', 'versionStatus', 'materialCode'])
      .execute();
    const statsCodes = [...new Set(statsRows.map((row) => row.planCode))];
    const expectedEnabled = statsCodes.filter((code) =>
      statsRows.some((row) => row.planCode === code && row.versionStatus === 'ACTIVE')
    ).length;
    const expectedPending = statsCodes.filter(
      (code) =>
        !statsRows.some((row) => row.planCode === code && row.versionStatus === 'ACTIVE') &&
        statsRows.some((row) => row.planCode === code && row.versionStatus === 'DRAFT')
    ).length;
    const expectedProducts = new Set(
      statsRows.map((row) => row.materialCode).filter((code) => code !== '')
    ).size;
    assert.equal(planStats.total, statsCodes.length, 'KPI 方案总数应等于库中去重方案编码数');
    assert.equal(planStats.enabled, expectedEnabled, 'KPI 已启用数应等于库中存在 ACTIVE 版本的方案数');
    assert.equal(planStats.pending, expectedPending, 'KPI 待审批数应等于库中"有草稿无生效"的方案数');
    assert.equal(planStats.productCount, expectedProducts, 'KPI 覆盖产品数应等于库中去重物料编码数');

    // ----------------------------------------------------------------------
    // 质检方案设计页「新建方案」链路（TBD-08）：
    //   1. POST /plans 的请求体不得要求调用方伪造 planId / createdBy（两者由服务端派生），
    //      否则页面新建方案会被 400 挡在门外（界面无法为尚不存在的版本行编造 UUID）；
    //   2. 版本生效周期必须真实落到 sampling_config 并能在读侧回放，
    //      方案列表的「未生效 / 已过期」提示才有真实依据；
    //   3. 首个版本一律以 DRAFT 落库（待审批后启用），请求体里写 ACTIVE 也不生效。
    // ----------------------------------------------------------------------
    const periodStamp = Date.now();
    const periodPlanCode = `QP-PERIOD-${periodStamp}`;
    const createPlanRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeader,
      payload: {
        planCode: periodPlanCode,
        planName: `生效周期探针方案 ${periodStamp}`,
        inspectionType: 'IQC',
        versions: [
          {
            versionNo: 'V1.0',
            samplingScheme: 'GB_T_2828',
            aqlLevel: 'II',
            strictness: 'NORMAL',
            status: 'ACTIVE',
            effectiveStartDate: '2099-01-01',
            effectiveEndDate: '2099-12-31',
            items: [
              {
                seq: 1,
                itemCode: 'PERIOD-01',
                name: '生效周期探针指标',
                dataType: 'NUMERIC',
                metricCategory: 'DIMENSION',
                nominalValue: 10,
                upperTolerance: 0.1,
                lowerTolerance: -0.1,
                unit: 'mm',
                sampleSize: 5,
              },
            ],
          },
        ],
      },
    });
    assert.equal(
      createPlanRes.statusCode,
      201,
      `方案设计页的建方案请求体（不含 planId / createdBy）必须被接受，实际: ${createPlanRes.statusCode} ${createPlanRes.body}`
    );
    const createdPeriodPlan = JSON.parse(createPlanRes.body) as {
      versions: Array<{
        id: string;
        status: string;
        effectiveStartDate?: string;
        effectiveEndDate?: string;
      }>;
    };
    createdPlanIds.push(...createdPeriodPlan.versions.map((version) => version.id));

    const createdPlanRows = await db
      .selectFrom('inspectionPlans')
      .select(['versionStatus', 'samplingConfig'])
      .where('planCode', '=', periodPlanCode)
      .execute();
    const [createdPlanRow] = createdPlanRows;
    assert.ok(createdPlanRow !== undefined, '新建方案应落 1 行版本记录');
    assert.equal(createdPlanRows.length, 1, '新建方案应落 1 行版本记录');
    assert.equal(
      createdPlanRow.versionStatus,
      'DRAFT',
      '新建方案的首个版本一律以 DRAFT 落库（请求体写 ACTIVE 也必须被忽略）'
    );
    const storedSamplingConfig = createdPlanRow.samplingConfig as {
      effectiveStartDate?: string;
      effectiveEndDate?: string;
    };
    assert.equal(
      storedSamplingConfig.effectiveStartDate,
      '2099-01-01',
      '生效起始日必须真实落到 sampling_config，不能只停在请求体里'
    );
    assert.equal(
      storedSamplingConfig.effectiveEndDate,
      '2099-12-31',
      '生效截止日必须真实落到 sampling_config'
    );
    const [createdVersion] = createdPeriodPlan.versions;
    assert.ok(createdVersion !== undefined, '新建方案的响应体应回吐首个版本');
    assert.equal(
      createdVersion.effectiveStartDate,
      '2099-01-01',
      '读侧必须回放生效周期，方案列表的未生效 / 已过期提示才有真实依据'
    );
    assert.equal(
      createdVersion.effectiveEndDate,
      '2099-12-31',
      '读侧必须回放生效截止日'
    );

    // 空草稿必须被拒：契约允许省略 versions，但领域规则 PLAN_EMPTY_ITEMS 要求版本至少 1 个指标项，
    // 该口径问题必须收敛为 400（而不是冒成 500 系统内部异常）
    const emptyPlanRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeader,
      payload: {
        planCode: `QP-EMPTY-${periodStamp}`,
        planName: `空草稿探针方案 ${periodStamp}`,
        inspectionType: 'IQC',
      },
    });
    assert.equal(
      emptyPlanRes.statusCode,
      400,
      `缺少指标项的新建方案必须返回 400 语义化错误（而非 500），实际: ${emptyPlanRes.statusCode} ${emptyPlanRes.body}`
    );
    const emptyPlanProblem = JSON.parse(emptyPlanRes.body) as {
      code: string;
      detail: string;
      invalidParams?: Array<{ name: string; reason: string }>;
    };
    assert.equal(
      emptyPlanProblem.code,
      ErrorCode.VALIDATION_FAILED,
      '空草稿的 400 必须收敛为契约字典内的 validation-failed'
    );
    assert.equal(
      emptyPlanProblem.detail.includes('PLAN_EMPTY_ITEMS'),
      true,
      '400 详情必须回显领域规则原因，便于页面直接提示用户'
    );
    assert.equal(
      (emptyPlanProblem.invalidParams ?? []).length > 0,
      true,
      '400 必须携带 invalidParams，页面可据此定位到具体版本'
    );
    const orphanEmptyRows = await db
      .selectFrom('inspectionPlans')
      .select('id')
      .where('planCode', '=', `QP-EMPTY-${periodStamp}`)
      .execute();
    assert.equal(orphanEmptyRows.length, 0, '被拒绝的空草稿不得留下任何版本行');

    // ----------------------------------------------------------------------
    // 质检方案设计页「版本启停（审批）」链路（TBD-01）：
    //   新建方案一律以 DRAFT 落库，而建单侧的方案匹配（/plans/match）只认 ACTIVE 版本，
    //   因此必须存在一条审批路由把版本从「待审批」推到「已启用」，
    //   否则方案永远停在草稿态，生效周期配置在真实系统里根本用不上。
    //   守门点：
    //   1. 角色门禁：检验员无权启停（配置变更类动作归质量主管），必须 403；
    //   2. 参数守门：非契约动作 400、不存在的版本 UUID 404（严禁静默回退到别的版本）；
    //   3. 审批启用：DRAFT -> ACTIVE，方案级状态随之 ENABLED，且真实落库；
    //   4. 单激活态：同方案审批新版本时，旧 ACTIVE 版本必须自动转 INACTIVE；
    //   5. 停用：ACTIVE -> INACTIVE，方案级状态回到 DISABLED；
    //   6. KPI 口径同步：/plans/stats 的 已启用 / 待审批 必须跟着版本状态变化。
    // ----------------------------------------------------------------------
    const periodVersionId = createdVersion.id;

    const statsBeforeToggleRes = await app.inject({
      method: 'GET',
      url: '/api/v1/plans/stats',
      headers: authHeader,
    });
    assert.equal(statsBeforeToggleRes.statusCode, 200);
    const statsBeforeToggle = JSON.parse(statsBeforeToggleRes.body) as {
      enabled: number;
      pending: number;
    };

    // 1. 角色门禁：检验员（INSPECTOR）无权审批 / 停用方案版本
    const inspectorToggleRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/versions/${periodVersionId}/status`,
      headers: {
        authorization: `Bearer ${generateTestToken({ role: 'INSPECTOR', permissions: [] })}`,
      },
      payload: { action: 'ACTIVATE' },
    });
    assert.equal(
      inspectorToggleRes.statusCode,
      403,
      `检验员不得启停方案版本，实际: ${inspectorToggleRes.statusCode} ${inspectorToggleRes.body}`
    );
    const inspectorToggleProblem = JSON.parse(inspectorToggleRes.body) as { code: string };
    assert.equal(inspectorToggleProblem.code, ErrorCode.FORBIDDEN, '403 必须携带 forbidden 错误码');

    // 2. 参数守门：非契约动作 / 不存在的版本 UUID
    const badActionRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/versions/${periodVersionId}/status`,
      headers: authHeader,
      payload: { action: 'ENABLE' },
    });
    assert.equal(
      badActionRes.statusCode,
      400,
      `非契约动作必须被 400 拒绝，实际: ${badActionRes.statusCode} ${badActionRes.body}`
    );
    assert.equal(
      (JSON.parse(badActionRes.body) as { code: string }).code,
      ErrorCode.VALIDATION_FAILED,
      '非契约动作的 400 必须走契约的 validation-failed 口径（而非自定义大写码）'
    );
    // DRAFT 版本不可直接停用（只有 ACTIVE 才可停用）
    const deactivateDraftRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/versions/${periodVersionId}/status`,
      headers: authHeader,
      payload: { action: 'DEACTIVATE' },
    });
    assert.equal(
      deactivateDraftRes.statusCode,
      400,
      `DRAFT 版本不可停用，实际: ${deactivateDraftRes.statusCode} ${deactivateDraftRes.body}`
    );
    assert.equal(
      (JSON.parse(deactivateDraftRes.body) as { code: string }).code,
      'plan-toggle-failed',
      '启停失败必须携带小写短横线错误码 plan-toggle-failed（RFC 7807 type URI 口径）'
    );
    const missingVersionRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans/versions/00000000-0000-4000-8000-0000000000ff/status',
      headers: authHeader,
      payload: { action: 'ACTIVATE' },
    });
    assert.equal(
      missingVersionRes.statusCode,
      404,
      `对不存在的版本 UUID 启停必须 404，实际: ${missingVersionRes.statusCode} ${missingVersionRes.body}`
    );
    assert.equal(
      (JSON.parse(missingVersionRes.body) as { code: string }).code,
      'plan-not-found',
      '未找到版本行的 404 必须携带小写短横线错误码 plan-not-found'
    );

    // 3. 审批启用：DRAFT -> ACTIVE
    const activateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/versions/${periodVersionId}/status`,
      headers: authHeader,
      payload: { action: 'ACTIVATE' },
    });
    assert.equal(
      activateRes.statusCode,
      200,
      `质量主管启用 DRAFT 版本必须成功，实际: ${activateRes.statusCode} ${activateRes.body}`
    );
    const activatedPlan = JSON.parse(activateRes.body) as {
      status?: string;
      versions?: Array<{ id?: string; status: string }>;
    };
    const activatedParsed = InspectionPlanSchema.safeParse(activatedPlan);
    assert.equal(
      activatedParsed.success,
      true,
      `启停响应必须满足 InspectionPlanSchema: ${JSON.stringify(
        activatedParsed.success ? '' : activatedParsed.error.issues.slice(0, 3)
      )}`
    );
    assert.equal(activatedPlan.status, 'ENABLED', '启用后方案级状态必须为 ENABLED');
    assert.equal(
      (activatedPlan.versions ?? []).find((version) => version.id === periodVersionId)?.status,
      'ACTIVE',
      '被审批的版本必须转 ACTIVE'
    );
    const afterActivateRows = await db
      .selectFrom('inspectionPlans')
      .select(['version', 'versionStatus'])
      .where('planCode', '=', periodPlanCode)
      .execute();
    const [afterActivateRow] = afterActivateRows;
    assert.ok(afterActivateRow !== undefined, '启用后版本行必须仍在库中');
    assert.equal(afterActivateRows.length, 1, '启用不应产生额外版本行');
    assert.equal(afterActivateRow.versionStatus, 'ACTIVE', '启用必须真实落库，而不是只改内存');

    const statsAfterActivateRes = await app.inject({
      method: 'GET',
      url: '/api/v1/plans/stats',
      headers: authHeader,
    });
    const statsAfterActivate = JSON.parse(statsAfterActivateRes.body) as {
      enabled: number;
      pending: number;
    };
    assert.equal(
      statsAfterActivate.enabled,
      statsBeforeToggle.enabled + 1,
      '审批启用后 KPI 已启用数必须 +1（该方案由待审批转入已启用）'
    );
    assert.equal(
      statsAfterActivate.pending,
      statsBeforeToggle.pending - 1,
      '审批启用后 KPI 待审批数必须 -1'
    );

    // 4. 单激活态：同方案追加 V2.0 并审批启用，旧 ACTIVE（V1.0）必须自动转 INACTIVE
    const secondVersionRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeader,
      payload: {
        planCode: periodPlanCode,
        planName: `生效周期探针方案 ${periodStamp}`,
        inspectionType: 'IQC',
        versions: [
          {
            versionNo: 'V2.0',
            samplingScheme: 'GB_T_2828',
            aqlLevel: 'II',
            strictness: 'NORMAL',
            items: [
              {
                seq: 1,
                itemCode: 'PERIOD-01',
                name: '生效周期探针指标',
                dataType: 'NUMERIC',
                metricCategory: 'DIMENSION',
                nominalValue: 10,
                upperTolerance: 0.1,
                lowerTolerance: -0.1,
                unit: 'mm',
                sampleSize: 5,
              },
            ],
          },
        ],
      },
    });
    assert.equal(
      secondVersionRes.statusCode,
      201,
      `同方案追加新版本必须成功，实际: ${secondVersionRes.statusCode} ${secondVersionRes.body}`
    );
    const secondVersionPlan = JSON.parse(secondVersionRes.body) as {
      versions: Array<{ id: string; status: string }>;
    };
    const [secondVersion] = secondVersionPlan.versions;
    assert.ok(secondVersion !== undefined, '追加版本响应应回吐新版本行');
    createdPlanIds.push(secondVersion.id);

    const activateSecondRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/versions/${secondVersion.id}/status`,
      headers: authHeader,
      payload: { action: 'ACTIVATE' },
    });
    assert.equal(
      activateSecondRes.statusCode,
      200,
      `启用新版本必须成功，实际: ${activateSecondRes.statusCode} ${activateSecondRes.body}`
    );
    const afterSecondRows = await db
      .selectFrom('inspectionPlans')
      .select(['version', 'versionStatus'])
      .where('planCode', '=', periodPlanCode)
      .orderBy('version', 'asc')
      .execute();
    const [firstRow, secondRow] = afterSecondRows;
    assert.ok(firstRow !== undefined, '同方案应有两行版本');
    assert.ok(secondRow !== undefined, '同方案应有两行版本');
    assert.equal(afterSecondRows.length, 2, '同方案应有两行版本');
    assert.equal(firstRow.versionStatus, 'INACTIVE', '单激活态：旧 ACTIVE 版本必须转 INACTIVE');
    assert.equal(secondRow.versionStatus, 'ACTIVE', '单激活态：新审批版本必须为 ACTIVE');

    // 5. 停用：ACTIVE -> INACTIVE，方案级状态回到 DISABLED（无 ACTIVE 也无 DRAFT）
    const deactivateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/versions/${secondVersion.id}/status`,
      headers: authHeader,
      payload: { action: 'DEACTIVATE' },
    });
    assert.equal(
      deactivateRes.statusCode,
      200,
      `停用 ACTIVE 版本必须成功，实际: ${deactivateRes.statusCode} ${deactivateRes.body}`
    );
    const deactivatedPlan = JSON.parse(deactivateRes.body) as { status?: string };
    assert.equal(deactivatedPlan.status, 'DISABLED', '全部版本停用后方案级状态必须为 DISABLED');
    const afterDeactivateRows = await db
      .selectFrom('inspectionPlans')
      .select(['versionStatus'])
      .where('planCode', '=', periodPlanCode)
      .execute();
    assert.equal(
      afterDeactivateRows.every((row) => row.versionStatus === 'INACTIVE'),
      true,
      '停用必须真实落库为 INACTIVE'
    );

    // 6. KPI 口径同步：停用后该方案既非已启用也非待审批
    const statsAfterToggleRes = await app.inject({
      method: 'GET',
      url: '/api/v1/plans/stats',
      headers: authHeader,
    });
    assert.equal(statsAfterToggleRes.statusCode, 200);
    const statsAfterToggle = JSON.parse(statsAfterToggleRes.body) as {
      enabled: number;
      pending: number;
    };
    assert.equal(
      statsAfterToggle.enabled,
      statsBeforeToggle.enabled,
      '探针方案停用后已启用数应回到启用前基线'
    );
    assert.equal(
      statsAfterToggle.pending,
      statsBeforeToggle.pending - 1,
      '探针方案停用后不再计入待审批（无 DRAFT 版本）'
    );

    // ----------------------------------------------------------------------
    // 质检方案设计页「版本升版」链路（TBD-14）：
    //   方案一经审批启用，改动就必须走"升版"而不是就地编辑：新建一个 DRAFT 版本行，
    //   既有版本行原样不动（否则历史检验单的 plan_snapshot 会被追溯改写）。
    //   本用例接在启停链路之后，此刻该探针方案的 V1.0 / V2.0 均为 INACTIVE 且无草稿。
    //   守门点：
    //   1. 省略 versionNo -> 服务端按现有最大版本号自动升位（V2.0 -> V2.1），与 plan_code 取号同口径；
    //   2. 升版只产 DRAFT，不改变任何既有版本行的激活状态；
    //   3. 省略指标项 / 抽样参数 -> 沿用 URL 指向的模板版本行；生效周期**不**继承；
    //   4. 已有草稿时再次升版必须 400（validation-failed），且不落第二行草稿；
    //   5. 显式 versionNo 优先于自动升位；
    //   6. URL 版本行不属于该方案 -> 404，严禁静默回退到别的版本。
    // ----------------------------------------------------------------------
    const upgradeTemplateId = secondVersion.id;

    const upgradeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/versions/${upgradeTemplateId}/upgrade`,
      headers: authHeader,
      payload: {},
    });
    assert.equal(
      upgradeRes.statusCode,
      201,
      `升版必须返回 201 并回吐新草稿方案，实际: ${upgradeRes.statusCode} ${upgradeRes.body}`
    );
    const upgradedPlan = JSON.parse(upgradeRes.body) as {
      status?: string;
      versions: Array<{
        id: string;
        versionNo: string;
        status: string;
        items: Array<{ itemCode: string }>;
        effectiveStartDate?: string;
        effectiveEndDate?: string;
      }>;
    };
    const upgradedVersion = upgradedPlan.versions.find((version) => version.status === 'DRAFT');
    assert.ok(upgradedVersion !== undefined, '升版必须产出一个 DRAFT 版本行');
    createdPlanIds.push(upgradedVersion.id);
    assert.equal(
      upgradedVersion.versionNo,
      'V2.1',
      '省略 versionNo 时必须在现有最大版本号 V2.0 上自动升位为 V2.1'
    );
    assert.equal(
      upgradedVersion.effectiveStartDate,
      undefined,
      '生效周期不继承模板版本行（照抄旧周期会让新草稿"出生即过期"）'
    );
    assert.equal(upgradedVersion.effectiveEndDate, undefined, '生效截止日同样不继承');
    assert.equal(
      upgradedVersion.items.some((item) => item.itemCode === 'PERIOD-01'),
      true,
      '省略 items 时必须沿用模板版本行的指标项'
    );
    assert.equal(
      upgradedPlan.status,
      'PENDING_APPROVAL',
      '升版后方案级状态应为待审批（有 DRAFT、无 ACTIVE 版本）'
    );

    const afterUpgradeRows = await db
      .selectFrom('inspectionPlans')
      .select(['version', 'versionStatus'])
      .where('planCode', '=', periodPlanCode)
      .orderBy('version', 'asc')
      .execute();
    assert.deepEqual(
      afterUpgradeRows.map((row) => `${row.version}:${row.versionStatus}`),
      ['V1.0:INACTIVE', 'V2.0:INACTIVE', 'V2.1:DRAFT'],
      '升版必须物理新增 1 行 DRAFT，且既有版本行的激活状态原样不动'
    );

    // 已有草稿时再次升版必须被拒：同一方案同时只允许一个草稿，否则「升级版本」按钮连点会造出多份待审批版本
    const duplicateUpgradeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/versions/${upgradeTemplateId}/upgrade`,
      headers: authHeader,
      payload: {},
    });
    assert.equal(
      duplicateUpgradeRes.statusCode,
      400,
      `已有草稿时再次升版必须返回 400，实际: ${duplicateUpgradeRes.statusCode} ${duplicateUpgradeRes.body}`
    );
    const duplicateUpgradeProblem = JSON.parse(duplicateUpgradeRes.body) as {
      code: string;
      detail: string;
      invalidParams?: Array<{ name: string; reason: string }>;
    };
    assert.equal(
      duplicateUpgradeProblem.code,
      ErrorCode.VALIDATION_FAILED,
      '重复升版必须收敛为契约字典内的 validation-failed（而非 500）'
    );
    assert.equal(
      duplicateUpgradeProblem.detail.includes('PLAN_DRAFT_ALREADY_EXISTS'),
      true,
      '400 详情必须回显领域规则原因，页面可直接提示用户'
    );
    const afterDuplicateRows = await db
      .selectFrom('inspectionPlans')
      .select('id')
      .where('planCode', '=', periodPlanCode)
      .execute();
    assert.equal(afterDuplicateRows.length, 3, '被拒绝的升版不得留下多余版本行');

    // 升版产出的草稿必须能被正常审批启用，然后才轮到「显式 versionNo」场景
    const activateUpgradedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/versions/${upgradedVersion.id}/status`,
      headers: authHeader,
      payload: { action: 'ACTIVATE' },
    });
    assert.equal(
      activateUpgradedRes.statusCode,
      200,
      `升版草稿应可正常审批启用，实际: ${activateUpgradedRes.statusCode} ${activateUpgradedRes.body}`
    );

    const explicitUpgradeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/versions/${upgradedVersion.id}/upgrade`,
      headers: authHeader,
      payload: { versionNo: 'V9.9' },
    });
    assert.equal(
      explicitUpgradeRes.statusCode,
      201,
      `显式版本号升版必须成功，实际: ${explicitUpgradeRes.statusCode} ${explicitUpgradeRes.body}`
    );
    const explicitUpgradedPlan = JSON.parse(explicitUpgradeRes.body) as {
      versions: Array<{ id: string; versionNo: string; status: string }>;
    };
    const explicitDraft = explicitUpgradedPlan.versions.find((version) => version.status === 'DRAFT');
    assert.ok(explicitDraft !== undefined, '显式版本号升版应产出 DRAFT 版本行');
    createdPlanIds.push(explicitDraft.id);
    assert.equal(
      explicitDraft.versionNo,
      'V9.9',
      '显式 versionNo 必须优先于自动升位（不得被改写成 V2.2）'
    );
    const afterExplicitRows = await db
      .selectFrom('inspectionPlans')
      .select(['version', 'versionStatus'])
      .where('planCode', '=', periodPlanCode)
      .orderBy('version', 'asc')
      .execute();
    assert.deepEqual(
      afterExplicitRows.map((row) => `${row.version}:${row.versionStatus}`),
      ['V1.0:INACTIVE', 'V2.0:INACTIVE', 'V2.1:ACTIVE', 'V9.9:DRAFT'],
      '升版不得改动既有版本行的激活状态（单激活态只由 …/status 改变）'
    );

    const missingVersionUpgradeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans/versions/00000000-0000-4000-8000-0000000000fe/upgrade',
      headers: authHeader,
      payload: {},
    });
    assert.equal(
      missingVersionUpgradeRes.statusCode,
      404,
      '对不存在的版本行升版必须返回 404，严禁静默回退到别的版本'
    );
    assert.equal(
      (JSON.parse(missingVersionUpgradeRes.body) as { code: string }).code,
      'plan-not-found',
      '未找到版本行的 404 必须携带小写短横线错误码 plan-not-found（与 …/status 启停路由同一口径）'
    );

    // ----------------------------------------------------------------------
    // 质检方案「编码服务端取号」链路（TBD-11）：
    //   接口口径统一：POST /plans 的 planCode 为可选 ——
    //   字段缺席时由服务端按 `QP-{YYYYMMDD}-{NNN}` 取号（本地当日、3 位左补零、同日自增），
    //   调用方仍可显式指定编码（如种子里的语义化编码 QP-IQC-304SS）并保持原值；
    //   但传空串（planCode: ''）必须 400 —— 空串是脏编码，不能被当成"请服务端取号"。
    //   守门点：
    //   1. 省略 planCode -> 201，回吐编码满足 QP-{YYYYMMDD}-{NNN} 且日期键 = 本地当日；
    //   2. 编码真实落库（inspection_plans.plan_code 与响应一致）；
    //   3. 取号池 inspection_plan_code_sequences 落行，(QP, 日期键) 的 last_seq >= 本次序号；
    //   4. 同日紧邻的第二次取号严格 +1（不重号靠库侧原子 upsert，而不是内存计数）；
    //   5. 显式 planCode 仍按原值生效，不被自动取号覆盖；空串则被 400 拒绝。
    // ----------------------------------------------------------------------
    const expectedDayKey = toInspectionOrderNoDayKey(new Date());
    const buildSeqPlanPayload = (suffix: string): Record<string, unknown> => ({
      planName: `取号探针方案 ${periodStamp}-${suffix}`,
      inspectionType: 'IQC',
      versions: [
        {
          versionNo: 'V1.0',
          samplingScheme: 'GB_T_2828',
          aqlLevel: 'II',
          strictness: 'NORMAL',
          items: [
            {
              seq: 1,
              itemCode: 'AUTO-CODE-01',
              name: '取号探针指标',
              dataType: 'NUMERIC',
              metricCategory: 'DIMENSION',
              nominalValue: 10,
              upperTolerance: 0.1,
              lowerTolerance: -0.1,
              unit: 'mm',
              sampleSize: 5,
            },
          ],
        },
      ],
    });

    // 1. 省略 planCode：服务端取号
    const autoCodePlanRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeader,
      payload: buildSeqPlanPayload('A'),
    });
    assert.equal(
      autoCodePlanRes.statusCode,
      201,
      `省略 planCode 的新建方案必须由服务端取号成功，实际: ${autoCodePlanRes.statusCode} ${autoCodePlanRes.body}`
    );
    const autoCodePlan = JSON.parse(autoCodePlanRes.body) as {
      planCode?: string;
      versions?: Array<{ id: string }>;
    };
    const autoCodePlanCode = autoCodePlan.planCode ?? '';
    const autoCodeMatch = /^QP-(\d{8})-(\d{3})$/.exec(autoCodePlanCode);
    assert.ok(
      autoCodeMatch !== null,
      `服务端取号必须满足 QP-{YYYYMMDD}-{NNN}，实际: [${autoCodePlanCode}]`
    );
    const autoCodeDayKey = autoCodeMatch[1] ?? '';
    const autoCodeSeq = Number(autoCodeMatch[2] ?? '');
    assert.equal(
      autoCodeDayKey,
      expectedDayKey,
      '取号日期键必须为本地当日（东八区上午不能用 UTC 日界取到"昨天"）'
    );
    assert.ok(Number.isInteger(autoCodeSeq) && autoCodeSeq >= 1, `取号流水必须从 1 起，实际: ${autoCodeSeq}`);
    const [autoCodeVersion] = autoCodePlan.versions ?? [];
    assert.ok(autoCodeVersion !== undefined, '取号方案的响应体应回吐首个版本行');
    createdPlanIds.push(autoCodeVersion.id);

    // 2. 编码真实落库
    const autoCodeRows = await db
      .selectFrom('inspectionPlans')
      .select(['planCode'])
      .where('planCode', '=', autoCodePlanCode)
      .execute();
    const [autoCodeRow] = autoCodeRows;
    assert.ok(autoCodeRow !== undefined, '服务端取号的方案必须真实落库，而不是只回吐响应');
    assert.equal(autoCodeRow.planCode, autoCodePlanCode, '落库编码必须与响应回吐的编码一致');

    // 3. 取号池落行：last_seq 必须 >= 本次序号（回填的历史编码也计入同一行）
    const seqRows = await db
      .selectFrom('inspectionPlanCodeSequences')
      .select('lastSeq')
      .where('prefix', '=', 'QP')
      .where('dayKey', '=', expectedDayKey)
      .execute();
    const [seqRow] = seqRows;
    assert.ok(seqRow !== undefined, '取号必须在 inspection_plan_code_sequences 落行');
    const storedSeq = Number(seqRow.lastSeq);
    assert.ok(
      Number.isInteger(storedSeq) && storedSeq >= autoCodeSeq,
      `取号池 last_seq (${String(seqRow.lastSeq)}) 必须 >= 本次序号 (${autoCodeSeq})`
    );

    // 4. 同日紧邻第二次取号：必须严格 +1（并发安全靠库侧原子 upsert）
    const autoCodePlanRes2 = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeader,
      payload: buildSeqPlanPayload('B'),
    });
    assert.equal(
      autoCodePlanRes2.statusCode,
      201,
      `第二次取号必须成功，实际: ${autoCodePlanRes2.statusCode} ${autoCodePlanRes2.body}`
    );
    const autoCodePlan2 = JSON.parse(autoCodePlanRes2.body) as {
      planCode?: string;
      versions?: Array<{ id: string }>;
    };
    const autoCodeMatch2 = /^QP-(\d{8})-(\d{3})$/.exec(autoCodePlan2.planCode ?? '');
    assert.ok(autoCodeMatch2 !== null, `第二次取号必须满足 QP-{YYYYMMDD}-{NNN}，实际: [${autoCodePlan2.planCode ?? ''}]`);
    assert.equal(
      Number(autoCodeMatch2[2] ?? ''),
      autoCodeSeq + 1,
      '同日两次取号必须严格递增 +1，不允许重号或跳号'
    );
    const [autoCodeVersion2] = autoCodePlan2.versions ?? [];
    assert.ok(autoCodeVersion2 !== undefined, '第二次取号响应应回吐首个版本行');
    createdPlanIds.push(autoCodeVersion2.id);

    // 5a. 显式 planCode：按原值使用，不被自动取号覆盖
    const explicitPlanCode = `QP-EXPLICIT-${periodStamp}`;
    const explicitCodeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeader,
      payload: { ...buildSeqPlanPayload('C'), planCode: explicitPlanCode },
    });
    assert.equal(
      explicitCodeRes.statusCode,
      201,
      `显式传入 planCode 的新建方案必须成功，实际: ${explicitCodeRes.statusCode} ${explicitCodeRes.body}`
    );
    const explicitCodePlan = JSON.parse(explicitCodeRes.body) as {
      planCode?: string;
      versions?: Array<{ id: string }>;
    };
    assert.equal(
      explicitCodePlan.planCode,
      explicitPlanCode,
      '显式传入的 planCode 必须按原值使用（语义化编码不被自动取号改写）'
    );
    const [explicitCodeVersion] = explicitCodePlan.versions ?? [];
    assert.ok(explicitCodeVersion !== undefined, '显式编码方案的响应体应回吐首个版本行');
    createdPlanIds.push(explicitCodeVersion.id);

    // 5b. 空串 planCode：必须 400（空串不等于"请服务端取号"）
    const blankCodeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeader,
      payload: { ...buildSeqPlanPayload('D'), planCode: '' },
    });
    assert.equal(
      blankCodeRes.statusCode,
      400,
      `planCode 传空串必须被 400 拒绝（留空只能"不传字段"），实际: ${blankCodeRes.statusCode} ${blankCodeRes.body}`
    );
    assert.equal(
      (JSON.parse(blankCodeRes.body) as { code: string }).code,
      ErrorCode.VALIDATION_FAILED,
      '空串 planCode 的 400 必须走契约的 validation-failed 口径'
    );
    const blankCodeRows = await db
      .selectFrom('inspectionPlans')
      .select('id')
      .where('planCode', '=', '')
      .execute();
    assert.equal(blankCodeRows.length, 0, '被拒绝的空串编码请求不得留下任何版本行');

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

    // =======================================================================
    // 7. 评审流程定义：字段回吐 + 启停真实落库 + 客户端错不冒充 500（docs/21 §10）
    // =======================================================================
    console.log('7. 验证评审流程定义字段回吐与启停落库...');

    const flowsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/review-flows',
      headers: authHeader,
    });
    assert.equal(flowsRes.statusCode, 200, '评审流程清单应返回 200');
    const flowsBody = JSON.parse(flowsRes.body) as {
      total: number;
      items: Array<{
        id: string;
        flowCode: string;
        description?: string;
        isActive: boolean;
        nodes: Array<{
          nodeLevel: number;
          roleName?: string;
          isRequired: boolean;
          allowConcession: boolean;
        }>;
      }>;
    };
    assert.ok(flowsBody.items.length >= 1, '演示库应至少有一条评审流程定义');
    for (const flow of flowsBody.items) {
      // 019 打通前：契约与物理表都没有 description，用户提交的流程说明被 Zod 静默剥离，
      // 界面「流程说明」恒显示占位文案。「非空」是最小可证伪断言。
      assert.ok(
        typeof flow.description === 'string' && flow.description.length > 0,
        `流程 ${flow.flowCode} 必须回吐非空 description（review_flows.description）`
      );
      for (const node of flow.nodes) {
        assert.ok(
          typeof node.roleName === 'string' && node.roleName.length > 0,
          `流程 ${flow.flowCode} 节点 roleName 不得为空（缺省读侧应回退 roleCode）`
        );
        assert.equal(typeof node.isRequired, 'boolean', '节点 isRequired 必须落库回吐（不得缺列）');
        assert.equal(
          typeof node.allowConcession,
          'boolean',
          '节点 allowConcession 必须落库回吐（不得缺列）'
        );
      }
    }
    // 节点顺序唯一取 nodeLevel；让步接收（特采）裁决权归终审层级（PRD §3.6）
    const flowWithNodes = flowsBody.items[0]!;
    const maxNodeLevel = Math.max(...flowWithNodes.nodes.map((node) => node.nodeLevel));
    assert.ok(
      flowWithNodes.nodes.every((node) => node.allowConcession === (node.nodeLevel === maxNodeLevel)),
      `仅终审层级（nodeLevel=${String(maxNodeLevel)}）应具特采裁决权`
    );

    const isActiveInDb = async (flowCode: string): Promise<boolean | undefined> =>
      (
        await db
          .selectFrom('reviewFlows')
          .select('isActive')
          .where('flowCode', '=', flowCode)
          .executeTakeFirst()
      )?.isActive;
    // 启停必须真实写回 is_active；往返切回原值，避免污染演示数据
    const toggleTarget = flowsBody.items.find((flow) => flow.isActive) ?? flowWithNodes;
    const toggleUrl = `/api/v1/review-flows/${toggleTarget.id}/toggle-active`;
    const activeBefore = await isActiveInDb(toggleTarget.flowCode);
    const toggleRes = await app.inject({
      method: 'POST',
      url: toggleUrl,
      headers: { ...authHeader, 'content-type': 'application/json' },
      payload: {},
    });
    assert.equal(toggleRes.statusCode, 200, '启停应返回 200');
    assert.equal(
      JSON.parse(toggleRes.body).isActive,
      !activeBefore,
      '响应 isActive 应为翻转后的值'
    );
    assert.equal(
      await isActiveInDb(toggleTarget.flowCode),
      !activeBefore,
      '启停必须真实写回 review_flows.is_active（此前前端打错路径导致状态从未落库）'
    );
    const restoreRes = await app.inject({
      method: 'POST',
      url: toggleUrl,
      headers: { ...authHeader, 'content-type': 'application/json' },
      payload: {},
    });
    assert.equal(restoreRes.statusCode, 200, '回切应返回 200');
    assert.equal(await isActiveInDb(toggleTarget.flowCode), activeBefore, '回切后必须还原原值');

    // 客户端错不得冒充服务端错：声明 application/json 却提交空体是调用方写错了请求，
    // 必须按 400 validation-failed 回吐（此前落到 errorHandler 的 500 兜底分支）。
    const emptyBodyRes = await app.inject({
      method: 'POST',
      url: toggleUrl,
      headers: { ...authHeader, 'content-type': 'application/json' },
    });
    assert.equal(emptyBodyRes.statusCode, 400, '空 JSON 体应返回 400，而不是 500 系统内部错误');
    assert.equal(JSON.parse(emptyBodyRes.body).code, ErrorCode.VALIDATION_FAILED);
    console.log('✔ 评审流程字段回吐 / 启停落库 / 客户端错 400 口径一致');
  } finally {
    // 清理本次新建的检验单，保证测试可重复执行；
    // 审计日志 / Outbox 事件为 append-only 留痕，按设计保留，不随业务数据回滚。
    if (createdOrderIds.length > 0) {
      // 池条目 / MRB 工单的 source_order_id 指向检验单（迁移 015），必须与检验单同批清理，
      // 否则会留下"源单已删"的孤儿池条目：列表里可见但发起评审永远 404。
      const deletedPool = await db
        .deleteFrom('pendingMrbItems')
        .where('sourceOrderId', 'in', createdOrderIds)
        .executeTakeFirst();
      // mrb_reviews 只存检验单号（无外键列），按单号回溯删除本次产生的评审工单
      const createdOrderRows = await db
        .selectFrom('inspectionOrders')
        .select(['orderNo'])
        .where('id', 'in', createdOrderIds)
        .execute();
      const deletedMrb =
        createdOrderRows.length > 0
          ? await db
              .deleteFrom('mrbReviews')
              .where(
                'sourceOrderNo',
                'in',
                createdOrderRows.map((row) => row.orderNo)
              )
              .executeTakeFirst()
          : undefined;
      console.log(
        `清理：删除本次新建检验单关联的 MRB 工单 ${String(deletedMrb?.numDeletedRows ?? 0)} 条 / 待审核池条目 ${String(deletedPool.numDeletedRows)} 条`
      );
      // 返工复检会在批次追溯 DAG 上留下 {原单号}:FAIL -> {复检单号} 的拓扑边（按批次号字符串关联，
      // 无外键）。源检验单删除后必须一并清理，否则追溯图里会残留指向已删批次号的孤儿边。
      let deletedTraceEdges = 0;
      for (const row of createdOrderRows) {
        const deletedEdge = await db
          .deleteFrom('batchTraceRelations')
          .where('childBatch', 'like', `${row.orderNo}-R%`)
          .executeTakeFirst();
        deletedTraceEdges += Number(deletedEdge.numDeletedRows ?? 0);
      }
      console.log(`清理：删除本次新建检验单关联的批次追溯边 ${deletedTraceEdges} 条`);
      const deleted = await db
        .deleteFrom('inspectionOrders')
        .where('id', 'in', createdOrderIds)
        .executeTakeFirst();
      console.log(
        `清理：删除本次新建的检验单 ${String(deleted.numDeletedRows)} / ${createdOrderIds.length} 条`
      );
    }
    // 清理本次新建的质检方案版本行（分类兜底 / 生效周期用例专用）
    if (createdPlanIds.length > 0) {
      const deletedPlans = await db
        .deleteFrom('inspectionPlans')
        .where('id', 'in', createdPlanIds)
        .executeTakeFirst();
      console.log(
        `清理：删除本次新建的质检方案版本行 ${String(deletedPlans.numDeletedRows)} / ${createdPlanIds.length} 条`
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
