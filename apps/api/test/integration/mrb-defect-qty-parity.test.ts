import assert from 'node:assert/strict';
import { buildApp } from '../../src/app';
import { createApiContainer, type ApiContainer } from '../../src/container';
import { generateTestToken } from '../../src/plugins/auth';

/**
 * MRB「不合格数量」口径回归测试（真实 PostgreSQL）
 *
 * 缺陷现场（2026-09-23 客户实测）：【MRB不合格品处置】列表的「不合格数量」列显示成了**检测数**
 * （= 检验单抽样数量），而不是检验员在录入弹窗里填写的「不合格数量」。
 *
 * 根因（docs/21 §14）：录入弹窗的写路径是**两次调用** ——
 *   ① `POST /inspections/:id/submit-measurements`（判定即自动建 MRB 单）；
 *   ② `POST /inspections/:id/status`（把填写值写进检验单 `fail_qty`）。
 * 建单在前、填写值在后：建单那一刻只能取到领域派生兜底值（首次判定时
 * `failQty = sampleQty - passQty - exemptQty` 恒等于整批抽样数），MRB 单便把「检测数」固化成了
 * 「不合格数量」。本用例覆盖修复后的三条口径：
 *   1. 填写值随判定**同事务**落库（第 ① 步就传）=> MRB 取到的就是填写值；
 *   2. 旧时序（第 ① 步没传填写值）=> 第 ② 步复用既有单据时按源单 `fail_qty` **对齐自愈**；
 *   3. `fail_qty = 0` 视为未填写 => 保留既有值，绝不把单据回退成 0。
 */

/** 该物料命中 IPQC_FN 生效方案 QP-FQC-AUTO（4 项均为 NUMERIC 且带 nominalValue，可判 PASSED / FAILED） */
const MATERIAL_CODE = 'MAT-BLT-109-M10';
/** 抽样数量：判定失败时派生兜底值恒等于它 —— 缺陷现象里的「检测数」就是它 */
const SAMPLE_QTY = 10;

async function runMrbDefectQtyParityTests() {
  console.log('--- MRB 不合格数量口径回归测试（真实 PostgreSQL） ---');

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
        sampleQty: SAMPLE_QTY,
        totalQty: SAMPLE_QTY,
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
      items: Array<{ itemCode: string; nominalValue?: number }>;
    };
    assert.ok(detail.items.length > 0, '本单必须带方案快照派生的实测项，否则用例无从覆盖');
    return detail.items;
  };

  /**
   * 实测值载荷：第 1 项超差（`nominalValue + 100`，判 FAILED），其余按标称值判 PASSED。
   * 一个超差项即足够让整单判不合格（领域规则：任一 FAILED -> 整单 FAILED），
   * 同时保证「合格数量 / 不合格数量」是检验员现场清点出来的、而不是全部脱靶的极端数据。
   */
  const measuredPayload = (
    items: Array<{ itemCode: string; nominalValue?: number }>,
    overrides: { passQty?: number; failQty?: number } = {}
  ) => ({
    isDraft: false,
    ...overrides,
    items: items.map((item, position) => ({
      itemCode: item.itemCode,
      measuredVal: position === 0 ? (item.nominalValue ?? 0) + 100 : item.nominalValue,
      measuredText: String(position === 0 ? (item.nominalValue ?? 0) + 100 : item.nominalValue),
    })),
  });

  const submitMeasurements = (orderId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${orderId}/submit-measurements`,
      headers: authHeader,
      payload,
    });

  const finalize = (orderId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${orderId}/status`,
      headers: authHeader,
      payload,
    });

  const mrbOf = async (orderNo: string) =>
    db
      .selectFrom('mrbReviews')
      .select(['mrbNo', 'defectQty', 'status'])
      .where('sourceOrderNo', '=', orderNo)
      .executeTakeFirst();

  const poolOf = async (orderId: string) =>
    db
      .selectFrom('pendingMrbItems')
      .select(['defectQty'])
      .where('sourceOrderId', '=', orderId)
      .executeTakeFirst();

  try {
    // ==== 1. 弹窗两步（填写值随判定下发）：MRB 不合格数量 = 填写值，而不是抽样数 ====
    const declaredOrder = await createOrder('VERIFY-MRB-QTY-A');
    const declaredItems = await loadItems(declaredOrder.id);
    const declaredRes = await submitMeasurements(
      declaredOrder.id,
      measuredPayload(declaredItems, { passQty: 3, failQty: 7 })
    );
    assert.equal(
      declaredRes.statusCode,
      200,
      `录入实测值必须返回 200，实际 ${declaredRes.statusCode}：${declaredRes.body}`
    );
    const declaredBody = JSON.parse(declaredRes.body) as { status: string; failQty: number };
    assert.equal(declaredBody.status, 'IN_MRB_REVIEW', '判定不合格必须自动建单并进入 MRB 评审中');
    assert.equal(
      declaredBody.failQty,
      7,
      `检验单不合格数量必须取检验员填写值（不是抽样数 ${String(SAMPLE_QTY)}），实际 ${String(declaredBody.failQty)}`
    );

    const afterDeclared = await finalize(declaredOrder.id, {
      status: 'FAILED',
      judgment: 'FAILED',
      passQty: 3,
      failQty: 7,
    });
    assert.equal(afterDeclared.statusCode, 200, `终判必须返回 200，实际 ${afterDeclared.statusCode}`);
    const declaredMrb = await mrbOf(declaredOrder.orderNo);
    assert.ok(declaredMrb, '判定不合格必须自动创建 MRB 评审单（docs/43）');
    assert.equal(
      Number(declaredMrb?.defectQty),
      7,
      `MRB「不合格数量」必须等于填写的不合格数，实际 ${String(declaredMrb?.defectQty)}`
    );
    assert.equal(
      Number((await poolOf(declaredOrder.id))?.defectQty),
      7,
      '不合格台账条目的不合格数必须与 MRB 单同口径'
    );
    console.log(`✔ 填写值随判定落库：MRB 不合格数量 = 7（抽样数 ${String(SAMPLE_QTY)}，不再串成检测数）`);

    // ==== 2. 旧时序（建单时没有填写值）：复用既有单据时按源单 fail_qty 对齐自愈 ====
    const legacyOrder = await createOrder('VERIFY-MRB-QTY-B');
    const legacyItems = await loadItems(legacyOrder.id);
    const legacyRes = await submitMeasurements(
      legacyOrder.id,
      // 不传 passQty / failQty：复刻缺陷现场 —— 建单只能取派生兜底值（= 抽样数）
      measuredPayload(legacyItems)
    );
    assert.equal(legacyRes.statusCode, 200, `录入实测值必须返回 200，实际 ${legacyRes.statusCode}`);
    const legacyMrbBefore = await mrbOf(legacyOrder.orderNo);
    assert.equal(
      Number(legacyMrbBefore?.defectQty),
      SAMPLE_QTY,
      '不传填写值时派生兜底值恒等于抽样数 —— 这正是客户看到的「不合格数量 = 检测数」'
    );

    const legacyRes2 = await finalize(legacyOrder.id, {
      status: 'FAILED',
      judgment: 'FAILED',
      passQty: 6,
      failQty: 4,
    });
    assert.equal(legacyRes2.statusCode, 200, `终判必须返回 200，实际 ${legacyRes2.statusCode}`);
    const legacyMrbAfter = await mrbOf(legacyOrder.orderNo);
    assert.equal(
      Number(legacyMrbAfter?.defectQty),
      4,
      `复用既有 MRB 单时必须把不合格数量对齐源单 fail_qty，实际 ${String(legacyMrbAfter?.defectQty)}`
    );
    assert.equal(
      Number((await poolOf(legacyOrder.id))?.defectQty),
      4,
      '台账条目的不合格数同样按源单 fail_qty 对齐'
    );
    console.log('✔ 旧时序自愈：先建单（派生 = 抽样数）后落填写值 -> MRB 不合格数量对齐为 4');

    // ==== 3. fail_qty = 0（未填写）不得把既有单据回退成 0 ====
    const zeroOrder = await createOrder('VERIFY-MRB-QTY-C');
    const zeroItems = await loadItems(zeroOrder.id);
    const zeroRes = await submitMeasurements(
      zeroOrder.id,
      measuredPayload(zeroItems, { passQty: 2, failQty: 8 })
    );
    assert.equal(zeroRes.statusCode, 200, `录入实测值必须返回 200，实际 ${zeroRes.statusCode}`);
    assert.equal(Number((await mrbOf(zeroOrder.orderNo))?.defectQty), 8, '建单必须先取到填写值 8');

    const zeroRes2 = await finalize(zeroOrder.id, { status: 'FAILED', judgment: 'FAILED', failQty: 0 });
    assert.equal(zeroRes2.statusCode, 200, `终判必须返回 200，实际 ${zeroRes2.statusCode}`);
    assert.equal(
      Number((await mrbOf(zeroOrder.orderNo))?.defectQty),
      8,
      'fail_qty = 0 视为未填写，保留既有值而不是回退成 0'
    );
    console.log('✔ fail_qty = 0 视为未填写：保留既有值 8，不回退');
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

runMrbDefectQtyParityTests()
  .then(() => {
    console.log('=== MRB 不合格数量口径回归测试全部通过 ===');
    process.exit(0);
  })
  .catch((err) => {
    console.error('=== MRB 不合格数量口径回归测试失败 ===');
    console.error(err);
    process.exit(1);
  });
