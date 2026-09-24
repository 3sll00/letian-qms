import assert from 'node:assert/strict';
import { buildApp } from '../../src/app';
import { createApiContainer, type ApiContainer } from '../../src/container';
import { generateTestToken } from '../../src/plugins/auth';

/**
 * 复检轮次（RE_INSPECTING）续录回归测试（真实 PostgreSQL）
 *
 * 缺陷现场（2026-09-23 客户实测）：【过程检验】-【成品检】台账把 `RE_INSPECTING`
 * （MRB 返工回边后的复检轮次，`create-reinspection.ts` 把源单翻成该态）与 `INSPECTING`
 * 同口径展示为「检验中 ->【继续】」（见 docs/09 §2.3、docs/14 §3、docs/17 §7.9），
 * 而写入口只对 `PENDING` 单做了「首次录入即开检」的推进，复检单于是恒定 400：
 * `ORDER_NOT_EDITABLE: 工单当前处于 [RE_INSPECTING] 状态，禁止录入或修改检验指标`。
 *
 * 领域状态机本就允许 `RE_INSPECTING -> INSPECTING`（「返工重检进入新一轮判定」），
 * 故修复口径是**用例层按该边推进到 INSPECTING 再录入**，而不是放宽聚合根的可编辑态
 * （`recordItemMeasurement` 仍只认 INSPECTING / DRAFT）。
 *
 * 覆盖：
 * 1. 复检单续录（`isDraft:true`）-> 200 且状态推进为 INSPECTING（物理落库）：台账【继续】的入口不再卡死；
 * 2. 续录后正式提交（`isDraft:false`）-> 200：服务端复判 + 自动终判一路走到 PASSED，
 *    且合格终判不入池、不建 MRB 单（证明链路是「续录后照常判定」，不是「绕过判定」）；
 * 3. 未经草稿的直接正式提交同样可用（复检单不要求先落一次草稿）；
 * 4. 未开检的 PENDING 单行为不变（回归，防止把「复检特例」写成「全状态可录」）；
 * 5. 反向守门：已终判（PASSED）单仍拒录（400 `ORDER_NOT_EDITABLE`）。
 */

/** 该物料命中 IPQC_FN 生效方案 QP-FQC-AUTO（4 项均为 NUMERIC 且带 nominalValue，可按标称值判 PASSED） */
const MATERIAL_CODE = 'MAT-BLT-109-M10';

async function runReinspectionResumeTests() {
  console.log('--- 复检轮次（RE_INSPECTING）续录回归测试（真实 PostgreSQL） ---');

  const container: ApiContainer = createApiContainer();
  const app = await buildApp({ logger: false, container });
  const db = container.db;

  const authHeader = {
    authorization: `Bearer ${generateTestToken({
      userId: '11000000-0000-4000-8000-000000000001',
      userName: '张强',
      role: 'QA_MANAGER',
    })}`,
    'content-type': 'application/json',
  };

  const createdOrderIds: string[] = [];
  const createdOrderNos: string[] = [];
  /** 终判会按 batch_no 登记追溯节点（docs/41），节点表无外键级联，必须显式清理 */
  const touchedBatches: string[] = [];

  const createOrder = async (batchNo: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/inspections',
      headers: authHeader,
      payload: {
        inspectionType: 'IPQC_FN',
        materialCode: MATERIAL_CODE,
        batchNo,
        sampleQty: 10,
        totalQty: 10,
      },
    });
    assert.equal(res.statusCode, 201, `成品检建单必须返回 201，实际 ${res.statusCode}：${res.body}`);
    const order = JSON.parse(res.body) as { id: string; orderNo: string };
    createdOrderIds.push(order.id);
    createdOrderNos.push(order.orderNo);
    touchedBatches.push(batchNo);
    return order;
  };

  /** 读取本单方案快照派生的实测项（建单即由快照派生，见 inspection-order.ts） */
  const loadItems = async (orderId: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/inspections/${orderId}`,
      headers: authHeader,
    });
    assert.equal(res.statusCode, 200, `检验单详情必须返回 200，实际 ${res.statusCode}：${res.body}`);
    const detail = JSON.parse(res.body) as {
      status: string;
      items: Array<{ itemCode: string; nominalValue?: number; unit?: string; result: string }>;
    };
    assert.ok(detail.items.length > 0, '本单必须带方案快照派生的实测项，否则用例无从覆盖');
    return detail;
  };

  /**
   * 模拟 MRB 返工回边：与 `create-reinspection.ts` §5 完全同一动作（`updateStatus(id, 'RE_INSPECTING')`）。
   * 不在此处重建「判不合格 -> 入池 -> 评审 -> 返工处置」全链路：那条链路由
   * `inspection-finalize-pool-link.test.ts` 与 `mrb-wiring-verify.cjs` 守门，本用例只钉续录口径。
   */
  const markReInspecting = async (orderId: string) => {
    await container.uow.execute(async (ctx) => {
      await ctx.inspectionOrders.updateStatus(orderId, 'RE_INSPECTING');
    });
  };

  const submitMeasurements = async (
    orderId: string,
    payload: { items: Array<Record<string, unknown>>; isDraft: boolean }
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${orderId}/submit-measurements`,
      headers: authHeader,
      payload,
    });

  const readStatus = async (orderId: string) => {
    const row = await db
      .selectFrom('inspectionOrders')
      .select(['status'])
      .where('id', '=', orderId)
      .executeTakeFirst();
    return row?.status;
  };

  try {
    // ==== 1. 复检单续录（草稿）-> 200，状态推进 INSPECTING ====
    const resumeOrder = await createOrder('VERIFY-REINSPECT-A');
    const resumeDetail = await loadItems(resumeOrder.id);
    await markReInspecting(resumeOrder.id);
    assert.equal(
      await readStatus(resumeOrder.id),
      'RE_INSPECTING',
      '前置动作必须把源单翻成复检中（与 create-reinspection 同口径）'
    );

    const measuredValues = resumeDetail.items.map((item) => ({
      itemCode: item.itemCode,
      measuredVal: item.nominalValue,
      measuredText: String(item.nominalValue),
    }));

    const draftRes = await submitMeasurements(resumeOrder.id, {
      items: measuredValues,
      isDraft: true,
    });
    assert.equal(
      draftRes.statusCode,
      200,
      `复检单续录必须返回 200（此前恒定 400 ORDER_NOT_EDITABLE），实际 ${draftRes.statusCode}：${draftRes.body}`
    );
    const resumed = JSON.parse(draftRes.body) as {
      status: string;
      items: Array<{ itemCode: string; measuredVal?: number; result: string }>;
    };
    assert.equal(
      resumed.status,
      'INSPECTING',
      '复检单首次录入实测值必须按状态机边 RE_INSPECTING -> INSPECTING 推进（草稿不触发终判）'
    );
    assert.equal(
      await readStatus(resumeOrder.id),
      'INSPECTING',
      '推进后的状态必须物理落库（台账「检验中」行不再卡死）'
    );
    for (const item of resumed.items) {
      assert.ok(
        item.measuredVal !== undefined,
        `指标 ${item.itemCode} 的实测值必须落库（录入不再被整体拒绝）`
      );
      assert.equal(
        item.result,
        'PASSED',
        `草稿同样按服务端同一算法做单项判定，但不做整单终判（${item.itemCode}）`
      );
    }
    console.log(`✔ 复检单 ${resumeOrder.orderNo}：续录 200 -> 状态推进 INSPECTING`);

    // ==== 2. 续录后正式提交 -> 200：服务端复判并自动终判；合格不入池、不建 MRB 单 ====
    const submitRes = await submitMeasurements(resumeOrder.id, {
      items: measuredValues,
      isDraft: false,
    });
    assert.equal(
      submitRes.statusCode,
      200,
      `复检单正式提交必须返回 200，实际 ${submitRes.statusCode}：${submitRes.body}`
    );
    const submitted = JSON.parse(submitRes.body) as {
      status: string;
      items: Array<{ itemCode: string; result: string }>;
    };
    assert.equal(
      submitted.status,
      'PASSED',
      '全部指标按标称值录入时，复检单必须与普通单同口径自动终判为 PASSED'
    );
    for (const item of submitted.items) {
      assert.equal(
        item.result,
        'PASSED',
        `指标 ${item.itemCode} 按标称值录入必须判 PASSED（服务端同算法复判）`
      );
    }
    assert.equal(await readStatus(resumeOrder.id), 'PASSED', '自动终判结果必须物理落库');
    const poolAfterPass = await db
      .selectFrom('pendingMrbItems')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('sourceOrderId', '=', resumeOrder.id)
      .executeTakeFirst();
    assert.equal(
      Number(poolAfterPass?.total ?? 0),
      0,
      '合格终判不得入不合格待审核池（续录口径不改变终判口径）'
    );
    const mrbAfterPass = await db
      .selectFrom('mrbReviews')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('sourceOrderNo', '=', resumeOrder.orderNo)
      .executeTakeFirst();
    assert.equal(Number(mrbAfterPass?.total ?? 0), 0, '合格终判不得自动创建 MRB 评审单');
    console.log(`✔ 复检续录 -> 正式提交 PASSED（未入池 / 未建 MRB 单）`);

    // ==== 3. 未经草稿的一次性正式提交同样可用 ====
    const directOrder = await createOrder('VERIFY-REINSPECT-B');
    const directDetail = await loadItems(directOrder.id);
    await markReInspecting(directOrder.id);
    const directRes = await submitMeasurements(directOrder.id, {
      items: directDetail.items.map((item) => ({
        itemCode: item.itemCode,
        measuredVal: item.nominalValue,
        measuredText: String(item.nominalValue),
      })),
      isDraft: false,
    });
    assert.equal(
      directRes.statusCode,
      200,
      `复检单直接正式提交必须返回 200，实际 ${directRes.statusCode}：${directRes.body}`
    );
    assert.equal(
      (JSON.parse(directRes.body) as { status: string }).status,
      'PASSED',
      '复检单未经草稿的一次性提交必须能走完「开检 -> 判定」两步'
    );
    console.log(`✔ 复检单 ${directOrder.orderNo}：未经草稿的一次性提交 200 -> PASSED`);

    // ==== 4. 回归：未开检的 PENDING 单行为不变 ====
    const pendingOrder = await createOrder('VERIFY-REINSPECT-C');
    const pendingDetail = await loadItems(pendingOrder.id);
    assert.equal(await readStatus(pendingOrder.id), 'PENDING', '新建单初始态必须为 PENDING');
    const firstItem = pendingDetail.items[0];
    assert.ok(firstItem !== undefined, '本单必须至少有一个指标项');
    const pendingRes = await submitMeasurements(pendingOrder.id, {
      items: [
        {
          itemCode: firstItem.itemCode,
          measuredVal: firstItem.nominalValue,
          measuredText: String(firstItem.nominalValue),
        },
      ],
      isDraft: true,
    });
    assert.equal(
      pendingRes.statusCode,
      200,
      `PENDING 单首次录入必须返回 200，实际 ${pendingRes.statusCode}：${pendingRes.body}`
    );
    assert.equal(
      (JSON.parse(pendingRes.body) as { status: string }).status,
      'INSPECTING',
      'PENDING -> INSPECTING 的既有开检口径必须保持不变'
    );
    console.log(`✔ PENDING 单 ${pendingOrder.orderNo}：首次录入 200 -> 开检口径不变`);

    // ==== 5. 反向守门：已终判单仍拒录 ====
    const rejected = await submitMeasurements(resumeOrder.id, {
      items: [{ itemCode: 'THR-002', measuredVal: 9.026, measuredText: '9.026' }],
      isDraft: false,
    });
    assert.equal(
      rejected.statusCode,
      400,
      `已终判（PASSED）单仍必须拒录，实际 ${rejected.statusCode}：${rejected.body}`
    );
    assert.match(rejected.body, /ORDER_NOT_EDITABLE/, '拒录理由必须是领域层的 ORDER_NOT_EDITABLE');
    console.log('✔ 已终判单拒录守门保持（400 ORDER_NOT_EDITABLE）');
  } finally {
    if (createdOrderIds.length > 0) {
      // mrb_reviews / 池表与检验单之间只有单号文本关联（无外键），必须显式删除
      const deletedMrb = await db
        .deleteFrom('mrbReviews')
        .where('sourceOrderNo', 'in', createdOrderNos)
        .executeTakeFirst();
      const deletedPool = await db
        .deleteFrom('pendingMrbItems')
        .where('sourceOrderId', 'in', createdOrderIds)
        .executeTakeFirst();
      const deletedNodes = await db
        .deleteFrom('batchTraceNodes')
        .where('batchNo', 'in', touchedBatches)
        .executeTakeFirst();
      const deleted = await db
        .deleteFrom('inspectionOrders')
        .where('id', 'in', createdOrderIds)
        .executeTakeFirst();
      console.log(
        `清理：删除本次新建的检验单 ${String(deleted.numDeletedRows)} / ${createdOrderIds.length} 条` +
          `（关联 MRB 单 ${String(deletedMrb.numDeletedRows)} 条 / 台账条目 ${String(
            deletedPool.numDeletedRows
          )} 条 / 追溯节点 ${String(deletedNodes.numDeletedRows)} 条）`
      );
    }
    await app.close();
    await db.destroy();
  }
}

runReinspectionResumeTests()
  .then(() => {
    console.log('=== 复检轮次续录回归测试全部通过 ===');
    process.exit(0);
  })
  .catch((err) => {
    console.error('=== 复检轮次续录回归测试失败 ===');
    console.error(err);
    process.exit(1);
  });
