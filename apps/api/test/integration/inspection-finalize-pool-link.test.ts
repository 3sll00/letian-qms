import assert from 'node:assert/strict';
import { buildApp } from '../../src/app';
import { createApiContainer, type ApiContainer } from '../../src/container';
import { generateTestToken } from '../../src/plugins/auth';

/**
 * 检验单终判「判不合格 -> 自动入池 -> 自动创建 MRB 单 -> MRB 页可见」回归测试（真实 PostgreSQL）
 *
 * 覆盖 docs/39-不合格判定自动入池与MRB页可见性打通设计.md +
 *      docs/43-不合格判定自动发起MRB评审设计.md：
 * 1. `POST /inspections/:id/status` 终判不合格后，`pending_mrb_items` 必须同事务生成台账条目
 *    （此前该路由直接写读侧仓储，入池链路从未发生，MRB 页面看不到记录 = docs/39 D1）；
 * 2. **同事务自动创建 MRB 评审单**：`mrb_reviews` 落 `PENDING_REVIEW`、来源类型按检验环节映射
 *    （IQC -> INCOMING_FAIL）、拟定处置落库、自动绑定生效评审流程（docs/43 §3，**无人工发起环节**）；
 * 3. 台账条目即时转 `INITIATED` 并回填 `mrb_review_id`，不再停留在「待发起」中间态；
 * 4. 检验单在同一事务内转 `IN_MRB_REVIEW`，终判响应回吐的即是最终态；
 * 5. 重复终判幂等：台账条目与 MRB 单都只 1 条（`source_order_no` 天然键）；
 * 6. 合格终判不入池、不建 MRB 单；
 * 7. 三维限定用户（IQC 检验员陈静：分类 + 编码 + 供应商）在台账中能看到该单，
 *    而规则不覆盖该物料的用户（OQC 检验员刘芳）看不到 —— 修的是「误导伤」，不是「放大可见范围」（docs/39 D2）；
 * 8. 非法状态 / 非法判定结论返回 400（契约校验前移到用例层）。
 */

/** 三维限定用户的台账可见性探针 */
const CHEN_JING = { userId: '11000000-0000-4000-8000-000000000008', userName: '陈静', role: 'IQC_INSPECTOR' };
const LIU_FANG = { userId: '11000000-0000-4000-8000-000000000003', userName: '刘芳', role: 'OQC_INSPECTOR' };

async function runFinalizePoolLinkTests() {
  console.log('--- 检验单终判入池 / 自动发起 MRB 与页可见性回归测试（真实 PostgreSQL） ---');

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
  const headersOf = (user: { userId: string; userName: string; role: string }) => ({
    authorization: `Bearer ${generateTestToken(user)}`,
    'content-type': 'application/json',
  });

  /** 本次测试新建的检验单主键 / 单号，结束时清理，保证回归测试可重复运行 */
  const createdOrderIds: string[] = [];
  const createdOrderNos: string[] = [];

  /**
   * 本次测试涉及的业务批次：终判会按 `batch_no` 登记追溯节点（docs/41），
   * 而节点表**没有外键级联**，必须显式删除 —— 否则回归测试会往追溯看板里堆探针批次。
   */
  const touchedBatches: string[] = [];

  const createOrder = async (batchNo: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/inspections',
      headers: authHeader,
      payload: {
        inspectionType: 'IQC',
        materialCode: 'MAT-304SS-05',
        batchNo,
        sampleQty: 20,
        totalQty: 20,
        supplierCode: 'SUP-001',
      },
    });
    assert.equal(res.statusCode, 201, `建单必须返回 201，实际 ${res.statusCode}：${res.body}`);
    const order = JSON.parse(res.body) as { id: string; orderNo: string };
    createdOrderIds.push(order.id);
    createdOrderNos.push(order.orderNo);
    touchedBatches.push(batchNo);
    return order;
  };

  const finalize = async (
    orderId: string,
    payload: Record<string, unknown>,
    headers = authHeader
  ) => app.inject({ method: 'POST', url: `/api/v1/inspections/${orderId}/status`, headers, payload });

  try {
    // ==== 1. 终判不合格 -> 同事务入池 + 自动创建 MRB 评审单 ====
    const failOrder = await createOrder('VERIFY-FINALIZE-POOL-A');
    const remark = '整批判退：来料盘条外观划伤，无法投线';
    const failRes = await finalize(failOrder.id, {
      status: 'FAILED',
      judgment: 'FAILED',
      passQty: 0,
      failQty: 20,
      remark,
      preliminaryDisposition: 'RETURN_TO_VENDOR',
    });
    assert.equal(failRes.statusCode, 200, `终判必须返回 200，实际 ${failRes.statusCode}：${failRes.body}`);
    const failedOrder = JSON.parse(failRes.body) as {
      status: string;
      overallDecision?: string;
      failQty: number;
      inspectionNotes?: string;
    };
    assert.equal(
      failedOrder.status,
      'IN_MRB_REVIEW',
      '判定不合格后单据必须直接进入 MRB 评审中（docs/43：判定即入评审）'
    );
    assert.equal(failedOrder.overallDecision, 'FAILED', '终判后综合判定必须落库为 FAILED');
    assert.equal(failedOrder.failQty, 20, '不合格数量必须落库');
    assert.equal(failedOrder.inspectionNotes, remark, '终判备注必须落库');

    const poolRows = await db
      .selectFrom('pendingMrbItems')
      .select([
        'sourceOrderNo',
        'status',
        'defectQty',
        'totalQty',
        'failReason',
        'supplierName',
        'sourceStage',
        'mrbReviewId',
      ])
      .where('sourceOrderId', '=', failOrder.id)
      .execute();
    assert.equal(poolRows.length, 1, '判不合格后台账内必须恰有一条记录（docs/39 D1）');
    const poolRow = poolRows[0];
    assert.equal(
      poolRow?.status,
      'INITIATED',
      '自动发起后台账条目必须即时转「已入评审」，不再停留在待发起中间态（docs/43 §4.5）'
    );
    assert.ok(poolRow?.mrbReviewId !== null && poolRow?.mrbReviewId !== undefined, '台账条目必须回填 mrb_review_id');
    assert.equal(poolRow?.sourceStage, 'IQC', '台账条目必须记录检验环节');
    assert.equal(Number(poolRow?.defectQty), 20, '台账条目的不合格数取检验单不合格数');
    assert.equal(Number(poolRow?.totalQty), 20, '台账条目的受检数量取抽样 / 报检数量');
    assert.equal(poolRow?.failReason, remark, '台账条目的不合格描述取终判备注（不得写成与事实不符的兜底文案）');
    assert.ok(
      (poolRow?.supplierName ?? '') !== '',
      '台账条目的供应商名称快照不得为空（IQC 取源单供应商）'
    );

    const mrbRows = await db
      .selectFrom('mrbReviews')
      .select(['id', 'mrbNo', 'sourceType', 'status', 'disposition', 'reviewFlowId', 'defectQty'])
      .where('sourceOrderNo', '=', failOrder.orderNo)
      .execute();
    assert.equal(mrbRows.length, 1, '判定不合格必须自动创建且只创建一张 MRB 评审单（docs/43）');
    const mrbRow = mrbRows[0];
    assert.equal(mrbRow?.sourceType, 'INCOMING_FAIL', 'IQC 不合格必须映射为来料不合格来源类型');
    assert.equal(mrbRow?.status, 'PENDING_REVIEW', '自动创建的 MRB 单必须处于待评审态（直接进入会签流程）');
    assert.equal(mrbRow?.disposition, 'RETURN_TO_VENDOR', '拟定处置必须按终判口径落库（docs/43 §4.4）');
    assert.equal(mrbRow?.id, poolRow?.mrbReviewId, '台账回填的 MRB 单必须等于实际创建的那一张');
    assert.ok(
      mrbRow?.reviewFlowId !== null && mrbRow?.reviewFlowId !== undefined,
      '自动建单必须绑定生效评审流程（IQC -> FLOW-IQC-FAIL）'
    );
    console.log(
      `✔ 终判不合格 -> 同事务入池 + 自动建 MRB 单（${failOrder.orderNo}，${String(mrbRow?.mrbNo)}，流程已绑定）`
    );

    // ==== 2. MRB 处置列表「待评审」必须可见（页面可见性，无需任何人工发起动作）====
    const recordsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/mrb/records?status=PENDING_REVIEW&page=1&pageSize=100',
      headers: authHeader,
    });
    assert.equal(recordsRes.statusCode, 200, 'MRB 列表必须返回 200');
    const recordsBody = JSON.parse(recordsRes.body) as {
      items?: Array<{ sourceOrderNo: string }>;
      list?: Array<{ sourceOrderNo: string }>;
      pendingPoolCount?: number;
    };
    const records = recordsBody.items ?? recordsBody.list ?? [];
    assert.ok(
      records.some((item) => item.sourceOrderNo === failOrder.orderNo),
      '判不合格后 MRB 处置列表「待评审」页签必须直接可见该单（无人工发起环节）'
    );
    const expectedPoolCount = await db
      .selectFrom('pendingMrbItems')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('status', '=', 'PENDING_INITIATE')
      .where('sourceOrderId', '=', failOrder.id)
      .executeTakeFirst();
    assert.equal(
      recordsBody.pendingPoolCount !== undefined,
      true,
      'GET /mrb/records 必须回吐 pendingPoolCount（字段保留，兼容历史消费方）'
    );
    assert.equal(
      Number(expectedPoolCount?.total ?? 0),
      0,
      '自动发起后台账条目不得停留在 PENDING_INITIATE'
    );
    console.log(`✔ MRB 列表「待评审」可见 ${failOrder.orderNo}，台账待发起条数 = 0`);

    // ==== 3. 重复终判幂等 ====
    const again = await finalize(failOrder.id, {
      status: 'FAILED',
      judgment: 'FAILED',
      failQty: 20,
      remark,
    });
    assert.equal(again.statusCode, 200, '重复终判必须返回 200');
    const poolRowsAgain = await db
      .selectFrom('pendingMrbItems')
      .select(['id'])
      .where('sourceOrderId', '=', failOrder.id)
      .execute();
    assert.equal(poolRowsAgain.length, 1, '重复终判必须按 source_order_id upsert，不得产生重复台账条目');
    const mrbRowsAgain = await db
      .selectFrom('mrbReviews')
      .select(['id'])
      .where('sourceOrderNo', '=', failOrder.orderNo)
      .execute();
    assert.equal(mrbRowsAgain.length, 1, '重复终判必须复用既有 MRB 单，不得重复建单');
    console.log('✔ 重复终判幂等：台账条目与 MRB 单仍各 1 条');

    // ==== 4. 合格终判不得入池、不得建单 ====
    const passOrder = await createOrder('VERIFY-FINALIZE-POOL-B');
    const passRes = await finalize(passOrder.id, {
      status: 'PASSED',
      judgment: 'PASSED',
      passQty: 20,
      failQty: 0,
    });
    assert.equal(passRes.statusCode, 200, '合格终判必须返回 200');
    const passBody = JSON.parse(passRes.body) as { status: string };
    assert.equal(passBody.status, 'PASSED', '合格终判不得被推进到 MRB 评审');
    const passPoolRows = await db
      .selectFrom('pendingMrbItems')
      .select(['id'])
      .where('sourceOrderId', '=', passOrder.id)
      .execute();
    assert.equal(passPoolRows.length, 0, '合格终判不得进入不合格台账');
    const passMrbRows = await db
      .selectFrom('mrbReviews')
      .select(['id'])
      .where('sourceOrderNo', '=', passOrder.orderNo)
      .execute();
    assert.equal(passMrbRows.length, 0, '合格终判不得创建 MRB 评审单');
    console.log('✔ 合格终判不入池、不建单');

    // ==== 5. 三维限定用户的台账可见性（D2 修复 + 不放大可见范围）====
    const chenRes = await app.inject({
      method: 'GET',
      url: '/api/v1/mrb/pending-pool?page=1&pageSize=100',
      headers: headersOf(CHEN_JING),
    });
    assert.equal(chenRes.statusCode, 200, '陈静的台账查询必须返回 200');
    const chenBody = JSON.parse(chenRes.body) as { items: Array<{ orderNo: string }>; total: number };
    assert.ok(
      chenBody.items.some((item) => item.orderNo === failOrder.orderNo),
      '三维限定（分类 + 编码 + 供应商）用户必须能看到自己可见范围内的台账条目（此前恒为 0）'
    );
    console.log(`✔ 陈静（三维限定）台账内可见 ${failOrder.orderNo}，可见条数 ${chenBody.total}`);

    const liuRes = await app.inject({
      method: 'GET',
      url: '/api/v1/mrb/pending-pool?page=1&pageSize=100',
      headers: headersOf(LIU_FANG),
    });
    assert.equal(liuRes.statusCode, 200, '刘芳的台账查询必须返回 200');
    const liuBody = JSON.parse(liuRes.body) as { items: Array<{ orderNo: string }> };
    assert.ok(
      !liuBody.items.some((item) => item.orderNo === failOrder.orderNo),
      '规则不覆盖该物料的用户不得看到该台账条目（fail-closed 未被放大）'
    );
    console.log('✔ 规则不覆盖的用户仍看不到（fail-closed 未被放大）');

    // ==== 6. 非法状态 / 非法结论 400 ====
    const badStatus = await finalize(passOrder.id, { status: 'NOT_A_STATUS' });
    assert.equal(badStatus.statusCode, 400, '非法状态必须返回 400');
    const badJudgment = await finalize(passOrder.id, { status: 'FAILED', judgment: 'NOT_A_JUDGMENT' });
    assert.equal(badJudgment.statusCode, 400, '非法判定结论必须返回 400');
    const badDisposition = await finalize(passOrder.id, {
      status: 'PASSED',
      preliminaryDisposition: 'NOT_A_DISPOSITION',
    });
    assert.equal(badDisposition.statusCode, 400, '非法拟定处置必须返回 400');
    console.log('✔ 非法状态 / 非法判定结论 / 非法拟定处置均返回 400');
  } finally {
    if (createdOrderIds.length > 0) {
      // mrb_reviews 与检验单之间只有 source_order_no 文本关联（无外键），必须显式删除
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

runFinalizePoolLinkTests()
  .then(() => {
    console.log('=== 终判入池 / 自动发起 MRB 与页可见性回归测试全部通过 ===');
    process.exit(0);
  })
  .catch((err) => {
    console.error('=== 终判入池 / 自动发起 MRB 与页可见性回归测试失败 ===');
    console.error(err);
    process.exit(1);
  });