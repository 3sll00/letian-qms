import assert from 'node:assert/strict';
import { buildApp } from '../../src/app';
import { createApiContainer, type ApiContainer } from '../../src/container';
import { generateTestToken } from '../../src/plugins/auth';

/**
 * 检验环节自动登记追溯节点回归测试（真实 PostgreSQL）
 *
 * 覆盖 docs/41-检验环节自动登记追溯节点设计.md：
 * 1. 建单后（未终判）该批次**没有**追溯节点：`GET /traceability/graph/{batch}` 返回 404、
 *    批次检索行 `sources` 仅 `INSPECTION_ORDER`（这正是用户看到「最近环节 — / 点开查不到节点详情」的状态）；
 * 2. 终判后**同一事务**登记节点：图谱 200，且节点字段（批次 / 环节名 / 状态 / 检验单号 / 物料编码 /
 *    来源单据 / 执行人）逐项正确；
 * 3. 批次检索行升级为 `TRACE_NODE` 数据源：`stageName` / `nodeStatus` / `inspectionOrderNo` 不再为空；
 * 4. 幂等：重复终判仍是同一批次一行节点（`batch_trace_nodes.batch_no` UNIQUE + upsert）；
 * 5. 合格终判同样登记，且状态是 `PASSED`（不得一律写成 FAILED）；
 * 6. 收尾清理：节点**不随检验单级联删除**（无外键），测试自行删除以便可重复运行。
 */

const STAMP = Date.now().toString().slice(-8);
const FAIL_BATCH = `TRACE-NODE-FAIL-${STAMP}`;
const PASS_BATCH = `TRACE-NODE-PASS-${STAMP}`;
const MEASURE_BATCH = `TRACE-NODE-MEASURE-${STAMP}`;
const INBOUND_NO = `RK-TRACENODE-${STAMP}`;

async function runTraceNodeRegistrationTests() {
  console.log('--- 检验环节自动登记追溯节点回归测试（真实 PostgreSQL） ---');

  const container: ApiContainer = createApiContainer();
  const app = await buildApp({ logger: false, container });
  const db = container.db;

  const headers = {
    authorization: `Bearer ${generateTestToken({
      userId: '11000000-0000-4000-8000-000000000001',
      userName: '张强',
      role: 'QA_MANAGER',
    })}`,
    'content-type': 'application/json',
  };

  const createdOrderIds: string[] = [];
  const touchedBatches: string[] = [];

  const createOrder = async (batchNo: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/inspections',
      headers,
      payload: {
        inspectionType: 'IQC',
        materialCode: 'MAT-304SS-05',
        batchNo,
        inboundNo: INBOUND_NO,
        sampleQty: 20,
        totalQty: 20,
        supplierCode: 'SUP-001',
        inspectorName: '陈静',
      },
    });
    assert.equal(res.statusCode, 201, `建单必须返回 201，实际 ${res.statusCode}：${res.body}`);
    touchedBatches.push(batchNo);
    const order = JSON.parse(res.body) as { id: string; orderNo: string };
    createdOrderIds.push(order.id);
    return order;
  };

  const finalize = (orderId: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/inspections/${orderId}/status`, headers, payload });

  const graphOf = (batchNo: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/traceability/graph/${encodeURIComponent(batchNo)}?direction=BOTH&maxDepth=10`,
      headers,
    });

  const batchRowOf = async (batchNo: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/traceability/batches?batchNo=${encodeURIComponent(batchNo)}&page=1&pageSize=20`,
      headers,
    });
    assert.equal(res.statusCode, 200, `批次检索必须返回 200，实际 ${res.statusCode}：${res.body}`);
    const body = JSON.parse(res.body) as {
      items: Array<{
        batchNo: string;
        stageName?: string;
        nodeStatus?: string;
        inspectionOrderNo?: string;
        sources: string[];
      }>;
    };
    return body.items.find((item) => item.batchNo === batchNo) ?? null;
  };

  try {
    // ==== 1. 建单未终判：该批次尚无追溯节点 ====
    const failOrder = await createOrder(FAIL_BATCH);
    const graphBefore = await graphOf(FAIL_BATCH);
    assert.equal(graphBefore.statusCode, 404, '未终判的批次不得有追溯节点（图谱应以 404 表示尚未建血缘）');
    const rowBefore = await batchRowOf(FAIL_BATCH);
    assert.ok(rowBefore !== null, '批次检索必须命中该批次（仅检验台账数据源）');
    assert.deepEqual(rowBefore.sources, ['INSPECTION_ORDER'], '未终判时数据来源只能是检验台账');
    assert.equal(rowBefore.stageName, undefined, '未终判时不得凭空给出「最近环节」');
    assert.equal(rowBefore.nodeStatus, undefined, '未终判时不得凭空给出节点状态');
    console.log('✔ 建单未终判：图谱 404、批次行仅有检验台账数据源（复现用户看到的现象）');

    // ==== 2. 终判不合格 -> 同事务登记追溯节点 ====
    const failed = await finalize(failOrder.id, {
      status: 'FAILED',
      judgment: 'FAILED',
      failQty: 20,
      inspectionNotes: '整批判退：来料盘条外观划伤，无法投线',
    });
    assert.equal(failed.statusCode, 200, `终判必须返回 200，实际 ${failed.statusCode}：${failed.body}`);

    const graphAfter = await graphOf(FAIL_BATCH);
    assert.equal(graphAfter.statusCode, 200, '终判后该批次必须能开出追溯图（此前恒为 404）');
    const graph = JSON.parse(graphAfter.body) as {
      batchNo: string;
      nodes: Array<Record<string, unknown>>;
    };
    assert.equal(graph.nodes.length, 1, '该批次此时应恰好有 1 个节点（无血缘边）');
    const node = graph.nodes[0] as Record<string, string>;
    assert.equal(node.batchNo, FAIL_BATCH, '节点批次号必须是追溯主键');
    assert.equal(node.stageName, '来料检验 (IQC)', '环节名必须与订单维度视图共用同一映射');
    assert.equal(node.nodeStatus, 'FAILED', '不合格结论必须如实落为 FAILED');
    assert.equal(node.inspectionOrderNo, failOrder.orderNo, '节点必须挂上检验单号（卡片回跳用）');
    assert.equal(node.materialCode, 'MAT-304SS-05', '节点必须带物料编码');
    assert.equal(node.orderNo, INBOUND_NO, '来源单据号取该环节真实上游单据（IQC = 入库单）');
    assert.equal(node.operatorName, '陈静', '执行人优先取检验人，不得编造');
    console.log(`✔ 终判不合格 -> 同事务登记节点（${String(node.stageName)} / ${String(node.nodeStatus)} / 检验单 ${String(node.inspectionOrderNo)}）`);

    // ==== 3. 批次检索行升级为 TRACE_NODE 数据源 ====
    const rowAfter = await batchRowOf(FAIL_BATCH);
    assert.ok(rowAfter !== null, '批次检索仍必须命中该批次');
    assert.ok(rowAfter.sources.includes('TRACE_NODE'), '数据来源必须出现 TRACE_NODE');
    assert.equal(rowAfter.stageName, '来料检验 (IQC)', '「最近环节」不再为空（用户看到的 — 应被填上）');
    assert.equal(rowAfter.nodeStatus, 'FAILED', '批次行状态取节点状态');
    assert.equal(rowAfter.inspectionOrderNo, failOrder.orderNo, '批次行必须带最近一张检验单号');
    console.log('✔ 批次行最近环节 / 状态 / 关联检验单均已由节点提供');

    // ==== 4. 幂等：重复终判不产生重复节点 ====
    const again = await finalize(failOrder.id, { status: 'FAILED', judgment: 'FAILED', failQty: 20 });
    assert.equal(again.statusCode, 200, '重复终判必须返回 200');
    const nodeRows = await db
      .selectFrom('batchTraceNodes')
      .select(['batchNo', 'nodeStatus'])
      .where('batchNo', '=', FAIL_BATCH)
      .execute();
    assert.equal(nodeRows.length, 1, '同批次重复终判只能有一行节点（batch_no UNIQUE + upsert）');
    console.log('✔ 重复终判幂等：同批次仍为 1 行节点');

    // ==== 5. 合格终判同样登记，且状态为 PASSED ====
    const passOrder = await createOrder(PASS_BATCH);
    const passed = await finalize(passOrder.id, {
      status: 'PASSED',
      judgment: 'PASSED',
      passQty: 20,
      failQty: 0,
    });
    assert.equal(passed.statusCode, 200, '合格终判必须返回 200');
    const passGraph = await graphOf(PASS_BATCH);
    assert.equal(passGraph.statusCode, 200, '合格批次同样必须能开出追溯图');
    const passNodes = (JSON.parse(passGraph.body) as { nodes: Array<Record<string, string>> }).nodes;
    assert.equal(passNodes.length, 1, '合格批次应恰好 1 个节点');
    assert.equal(passNodes[0]?.nodeStatus, 'PASSED', '合格结论必须落为 PASSED（不得一律写 FAILED）');
    assert.equal(passNodes[0]?.inspectionOrderNo, passOrder.orderNo, '合格节点同样要挂检验单号');
    console.log('✔ 合格终判同样登记节点，且状态如实为 PASSED');

    const measureOrder = await createOrder(MEASURE_BATCH);
    const itemsRow = await db.selectFrom('inspectionOrders').select('items')
      .where('id', '=', measureOrder.id).executeTakeFirstOrThrow();
    const numericItem = (itemsRow.items as Array<{
      itemCode: string; dataType: string; nominalValue?: number; upperTolerance?: number;
    }>).find((item) => item.dataType === 'NUMERIC' && typeof item.nominalValue === 'number');
    assert.ok(numericItem, '实测终判需要数值检验项');
    const measured = await app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${measureOrder.id}/submit-measurements`,
      headers,
      payload: {
        items: [{
          itemCode: numericItem.itemCode,
          measuredVal: numericItem.nominalValue! + (numericItem.upperTolerance ?? 0) + 1,
        }],
        failQty: 1,
        passQty: 19,
        isDraft: false,
      },
    });
    assert.equal(measured.statusCode, 200, `正式提交实测值应终判成功：${measured.body}`);
    const measureGraph = await graphOf(MEASURE_BATCH);
    assert.equal(measureGraph.statusCode, 200, '实测终判后的批次必须能打开追溯图');
    const measureNodes = (JSON.parse(measureGraph.body) as { nodes: Array<Record<string, string>> }).nodes;
    assert.equal(measureNodes.length, 1);
    assert.equal(measureNodes[0]?.nodeStatus, 'FAILED');
    assert.equal(measureNodes[0]?.inspectionOrderNo, measureOrder.orderNo);
    assert.ok((await batchRowOf(MEASURE_BATCH))?.sources.includes('TRACE_NODE'));
  } finally {
    // 节点表无外键级联，必须显式清理，否则回归测试会污染追溯看板
    if (touchedBatches.length > 0) {
      const deletedNodes = await db
        .deleteFrom('batchTraceNodes')
        .where('batchNo', 'in', touchedBatches)
        .executeTakeFirst();
      // 判定不合格即自动建 MRB 单（docs/43）：mrb_reviews 只存检验单号、无外键级联，
      // 必须按单号与检验单同批清理，否则留下「源单已删」的孤儿评审工单污染 MRB 列表。
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
      const deletedOrders = await db
        .deleteFrom('inspectionOrders')
        .where('id', 'in', createdOrderIds)
        .executeTakeFirst();
      console.log(
        `清理：删除本次新建的追溯节点 ${String(deletedNodes.numDeletedRows)} 条 / 检验单 ${String(
          deletedOrders.numDeletedRows
        )} 条 / 自动建单的 MRB 工单 ${String(deletedMrb?.numDeletedRows ?? 0)} 条`
      );
    }
    await app.close();
    await db.destroy();
  }
}

runTraceNodeRegistrationTests()
  .then(() => {
    console.log('=== 检验环节自动登记追溯节点回归测试全部通过 ===');
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('❌ 追溯节点登记回归测试失败：', error);
    process.exit(1);
  });
