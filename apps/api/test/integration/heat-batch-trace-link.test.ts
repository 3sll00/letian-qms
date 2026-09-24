import assert from 'node:assert/strict';
import { FurnaceHeatTraceResponseSchema } from '@letian/contracts';
import { buildApp } from '../../src/app';
import { createApiContainer, type ApiContainer } from '../../src/container';
import { generateTestToken } from '../../src/plugins/auth';

/**
 * 炉批号三级关联链路集成测试（docs/47 §4.6 / R1~R5，真实 PostgreSQL）
 *
 * 覆盖客户验收口径：
 *   1. L1 委外热处理优先：同炉批号 IQC 与 OQC_HEAT 均有时，只命中 OQC_HEAT（不混合带出）；
 *   2. L2 回退：只有 IQC 时带出该单白名单实测值（化学成分 / 力学性能 / 硬度），非白名单项不带；
 *   3. L3 空态：两处均无 -> NONE + 0 项 + 无异常提示；
 *   4. 多命中取最近一次终判：同炉两张 OQC_HEAT，后终判者胜出；
 *   5. 跨物料回落：同物料无命中时跨物料带出并回 matchScope=GLOBAL + 源物料编码；
 *   6. FAILED 源单不参与带出：NONE + UPSTREAM_FAILED 提示（TBD-01）；
 *   7. PATCH /inspections/{id}/header：炉批号落库 + 服务端重解析溯源留痕；
 *   8. inheritedFrom 真写入：带出标记 / 带出原值 / 手工修改标记随 submit-measurements 落库回读；
 *   9. 契约形状：响应逐字段通过 FurnaceHeatTraceResponseSchema 校验（防 D9 漂移重演）。
 */

/** 来料检验物料：QP-IQC-35CRMO（含白名单项 CHE-002 / TEN-002 / HAR-002 + 非白名单 DIA-002） */
const IQC_MATERIAL = 'MAT-35CRMO-08';
/** 委外热处理物料：QP-OQC-HEAT-FAMILY-BOLT 族级方案（QUALITATIVE 项，无白名单实测项） */
const HEAT_MATERIAL = 'MAT-BLT-109-M10';

async function runHeatBatchTraceLinkTests() {
  console.log('--- 炉批号三级关联链路集成测试（真实 PostgreSQL） ---');

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

  const runId = `${Date.now()}`;
  const createdOrderIds: string[] = [];
  const createdOrderNos: string[] = [];
  /** 终判会按 batch_no 登记追溯节点（docs/41），节点表无外键级联，必须显式清理 */
  const touchedBatches: string[] = [];

  const createOrder = async (params: {
    inspectionType: string;
    materialCode: string;
    batchNo: string;
    furnaceHeatNo?: string;
  }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/inspections',
      headers: authHeader,
      payload: {
        inspectionType: params.inspectionType,
        materialCode: params.materialCode,
        batchNo: params.batchNo,
        sampleQty: 5,
        totalQty: 50,
        ...(params.furnaceHeatNo !== undefined ? { furnaceHeatNo: params.furnaceHeatNo } : {}),
      },
    });
    assert.equal(res.statusCode, 201, `建单必须返回 201，实际 ${res.statusCode}：${res.body}`);
    const order = JSON.parse(res.body) as { id: string; orderNo: string };
    createdOrderIds.push(order.id);
    createdOrderNos.push(order.orderNo);
    touchedBatches.push(params.batchNo);
    return order;
  };

  /** 全项按标称值提交 -> 自动终判 PASSED；override 可按 itemCode 覆盖实测值（造 FAILED 用） */
  const finalizeOrder = async (
    orderId: string,
    override?: Record<string, { measuredVal?: number; measuredText: string }>,
    extraItems?: Array<Record<string, unknown>>
  ) => {
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/inspections/${orderId}`,
      headers: authHeader,
    });
    assert.equal(detail.statusCode, 200, `检验单详情必须返回 200：${detail.body}`);
    const order = JSON.parse(detail.body) as {
      items: Array<{ itemCode: string; nominalValue?: number; result: string }>;
    };
    assert.ok(order.items.length > 0, '本单必须带方案快照派生的实测项');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${orderId}/submit-measurements`,
      headers: authHeader,
      payload: {
        isDraft: false,
        passQty: 5,
        failQty: 0,
        items: [
          ...order.items.map((item) => {
            const over = override?.[item.itemCode];
            return {
              itemCode: item.itemCode,
              ...(over?.measuredVal !== undefined
                ? { measuredVal: over.measuredVal }
                : item.nominalValue !== undefined
                  ? { measuredVal: item.nominalValue }
                  : {}),
              measuredText: over?.measuredText ?? String(item.nominalValue ?? '合格'),
            };
          }),
          ...(extraItems ?? []),
        ],
      },
    });
    return res;
  };

  const trace = async (heatBatchNo: string, materialCode?: string, excludeOrderId?: string) => {
    const qs =
      `heatBatchNo=${encodeURIComponent(heatBatchNo)}` +
      (materialCode !== undefined ? `&materialCode=${encodeURIComponent(materialCode)}` : '') +
      (excludeOrderId !== undefined ? `&excludeOrderId=${encodeURIComponent(excludeOrderId)}` : '');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/inspections/heat-batch-trace?${qs}`,
      headers: authHeader,
    });
    assert.equal(res.statusCode, 200, `heat-batch-trace 必须返回 200，实际 ${res.statusCode}：${res.body}`);
    // 契约逐字段校验（docs/47 D9：前后端字段口径漂移史，响应体必须能通过唯一契约）
    return FurnaceHeatTraceResponseSchema.parse(JSON.parse(res.body));
  };

  try {
    const HEAT_A = `ITEST-HEAT-A-${runId}`;
    const HEAT_B = `ITEST-HEAT-B-${runId}`;
    const HEAT_C = `ITEST-HEAT-C-${runId}`;

    // ==== 场景一：同炉 IQC + OQC_HEAT 都有 -> 只命中 L1 委外热处理（R1 / AC-01 / AC-02） ====
    const iqcOrder = await createOrder({
      inspectionType: 'IQC',
      materialCode: IQC_MATERIAL,
      batchNo: `ITEST-B-IQC-${runId}`,
      furnaceHeatNo: HEAT_A,
    });
    const iqcFinalize = await finalizeOrder(iqcOrder.id);
    assert.equal(iqcFinalize.statusCode, 200, `IQC 终判必须 200：${iqcFinalize.body}`);

    const heatOrder = await createOrder({
      inspectionType: 'OQC_HEAT',
      materialCode: HEAT_MATERIAL,
      batchNo: `ITEST-B-HEAT1-${runId}`,
      furnaceHeatNo: HEAT_A,
    });
    const heatFinalize = await finalizeOrder(heatOrder.id);
    assert.equal(heatFinalize.statusCode, 200, `OQC_HEAT 终判必须 200：${heatFinalize.body}`);

    const l1 = await trace(HEAT_A, HEAT_MATERIAL);
    assert.equal(l1.sourceType, 'OUTSOURCE_HEAT_TREATMENT', '同炉有委外热处理单时必须命中 L1');
    assert.equal(l1.sourceOrderNo, heatOrder.orderNo, '源单号必须是委外热处理单');
    assert.equal(l1.matchScope, 'MATERIAL', '同物料命中必须标 MATERIAL');
    assert.ok(
      (l1.inheritedItems ?? []).every(
        (it) =>
          ['MECHANICAL_PERFORMANCE', 'HARDNESS', 'TENSILE_STRENGTH', 'CHEMICAL_COMPOSITION'].includes(
            it.metricCategory
          )
      ),
      '带出项必须在白名单内（不混入 IQC 的尺寸项、也不跨单拼接）'
    );
    console.log(`✔ L1 命中委外热处理单 ${heatOrder.orderNo}（IQC 同炉单不参与、不混合）`);

    // ==== 场景二：只有 IQC -> 回退 L2，带出白名单实测值（R2 / AC-03） ====
    const iqcOnly = await createOrder({
      inspectionType: 'IQC',
      materialCode: IQC_MATERIAL,
      batchNo: `ITEST-B-IQC2-${runId}`,
      furnaceHeatNo: HEAT_B,
    });
    await finalizeOrder(iqcOnly.id);

    const l2 = await trace(HEAT_B, IQC_MATERIAL);
    assert.equal(l2.sourceType, 'IQC_RAW_MATERIAL', '只有来料检验单时必须回退 L2');
    assert.equal(l2.sourceOrderNo, iqcOnly.orderNo);
    assert.equal(l2.matchScope, 'MATERIAL');
    const l2Codes = (l2.inheritedItems ?? []).map((it) => it.itemCode);
    assert.ok(
      l2Codes.includes('CHE-002') && l2Codes.includes('TEN-002') && l2Codes.includes('HAR-002'),
      `L2 必须带出化学成分 / 力学性能 / 硬度白名单项，实际 ${JSON.stringify(l2Codes)}`
    );
    assert.ok(
      !l2Codes.includes('DIA-002'),
      '尺寸类指标不在白名单（与炉次无因果关系，docs/47 §3.5 / TBD-05）'
    );
    const cheItem = (l2.inheritedItems ?? []).find((it) => it.itemCode === 'CHE-002');
    assert.equal(cheItem?.measuredVal, 1.0, '带出值必须等于源单实测值（CHE-002 标称 1.0）');
    console.log(`✔ L2 回退来料检验单 ${iqcOnly.orderNo}：带出 ${l2Codes.join('/')}（尺寸项不带）`);

    // ==== 场景三：两处均无 -> NONE 静默空态（R3 / AC-04） ====
    const l3 = await trace(HEAT_C, HEAT_MATERIAL);
    assert.equal(l3.sourceType, 'NONE');
    assert.equal((l3.inheritedItems ?? []).length, 0, '查无记录不得带出任何值');
    assert.equal(l3.upstreamWarning, undefined, '无异常记录时不得附提示');
    assert.equal(l3.heatBatchNo, HEAT_C, 'heatBatchNo 必须回显原值');
    console.log('✔ L3 空态：NONE + 0 项 + 无提示');

    // ==== 场景四：同炉两张 OQC_HEAT -> 取最近一次终判（AC-05） ====
    const heatOrder2 = await createOrder({
      inspectionType: 'OQC_HEAT',
      materialCode: HEAT_MATERIAL,
      batchNo: `ITEST-B-HEAT2-${runId}`,
      furnaceHeatNo: HEAT_A,
    });
    await finalizeOrder(heatOrder2.id); // 后终判 -> 成为「最近一次」
    const l1Latest = await trace(HEAT_A, HEAT_MATERIAL);
    assert.equal(
      l1Latest.sourceOrderNo,
      heatOrder2.orderNo,
      '同炉多张同级单必须取最近一次终判（updated_at DESC 优先）'
    );
    console.log(`✔ 多命中取最近终判：${heatOrder2.orderNo} 覆盖 ${heatOrder.orderNo}`);

    // ==== 场景五：跨物料回落 -> matchScope=GLOBAL + 源物料编码（AC-10） ====
    const l2Global = await trace(HEAT_B, HEAT_MATERIAL); // 源单物料是 MAT-35CRMO-08
    assert.equal(l2Global.sourceType, 'IQC_RAW_MATERIAL', '跨物料命中仍按 L2 回退');
    assert.equal(l2Global.matchScope, 'GLOBAL', '同物料无命中必须标 GLOBAL（界面提示确认炉次归属）');
    assert.equal(l2Global.sourceMaterialCode, IQC_MATERIAL, '跨物料命中必须回吐源单物料编码');
    console.log('✔ 跨物料回落：GLOBAL + sourceMaterialCode 回吐');

    // ==== 场景六：FAILED 源单不参与带出 -> NONE + UPSTREAM_FAILED（AC-07 / TBD-01） ====
    const failedOrder = await createOrder({
      inspectionType: 'OQC_HEAT',
      materialCode: HEAT_MATERIAL,
      batchNo: `ITEST-B-FAIL-${runId}`,
      furnaceHeatNo: HEAT_C,
    });
    // QUALITATIVE 项 acceptableValues=['合格']：提交「不合格」文本 -> 单项 FAILED -> 整单 FAILED -> 自动进 MRB
    const failRes = await finalizeOrder(failedOrder.id, {
      'TRC-001': { measuredText: '不合格' },
    });
    assert.equal(failRes.statusCode, 200, `不合格终判提交必须 200：${failRes.body}`);

    const l3Failed = await trace(HEAT_C, HEAT_MATERIAL);
    assert.equal(l3Failed.sourceType, 'NONE', 'FAILED 源单不得参与带出');
    assert.equal((l3Failed.inheritedItems ?? []).length, 0);
    // 真实链路：FAILED 终判自动发起 MRB 评审并入待审池 —— 两者同时成立时按领域规则
    // 以 MRB 未结案归类（「不合格才发起评审」，docs/47 TBD-01 分类优先级），故提示码为 UNDER_MRB。
    assert.equal(l3Failed.upstreamWarning?.code, 'UPSTREAM_UNDER_MRB', '同炉不合格（待 MRB）必须给出异常提示');
    assert.ok(
      (l3Failed.upstreamWarning?.orderNos ?? []).includes(failedOrder.orderNo),
      '提示必须带真实命中单号'
    );
    console.log(`✔ FAILED 源单排除：NONE + UPSTREAM_UNDER_MRB(${failedOrder.orderNo})`);

    // ==== 场景七：PATCH /header 炉批号落库 + 服务端重解析溯源留痕（AC-11） ====
    const targetOrder = await createOrder({
      inspectionType: 'OQC_SH',
      materialCode: HEAT_MATERIAL,
      batchNo: `ITEST-B-SHIP-${runId}`,
    });
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/inspections/${targetOrder.id}/header`,
      headers: authHeader,
      payload: { furnaceHeatNo: ` ${HEAT_A} ` }, // 前后空格 -> 归一后仍命中
    });
    assert.equal(patched.statusCode, 200, `PATCH /header 必须 200：${patched.body}`);
    const patchedBody = JSON.parse(patched.body) as { sourceType: string; sourceOrderNo: string | null };
    assert.equal(patchedBody.sourceType, 'OUTSOURCE_HEAT_TREATMENT', '服务端必须重新解析带出源');
    assert.equal(patchedBody.sourceOrderNo, heatOrder2.orderNo, '留痕源单 = 最近终判的 OQC_HEAT');

    const reopened = await app.inject({
      method: 'GET',
      url: `/api/v1/inspections/${targetOrder.id}`,
      headers: authHeader,
    });
    const reopenedOrder = JSON.parse(reopened.body) as {
      furnaceHeatNo?: string;
      heatSourceType?: string;
      heatSourceOrderNo?: string;
    };
    assert.equal(reopenedOrder.furnaceHeatNo, HEAT_A, '炉批号落库（写侧 trim 规范化存储，归一列用于比较）');
    assert.equal(reopenedOrder.heatSourceType, 'OUTSOURCE_HEAT_TREATMENT', '溯源留痕必须落库');
    assert.equal(reopenedOrder.heatSourceOrderNo, heatOrder2.orderNo);
    console.log('✔ PATCH /header：炉号 + 服务端解析留痕落库回读一致');

    // ==== 场景八：inheritedFrom 真写入（AC-08 / R5 / D10） ====
    const targetDetail = JSON.parse(reopened.body) as {
      items: Array<{ itemCode: string }>;
    };
    const [firstItem, secondItem] = targetDetail.items;
    assert.ok(firstItem !== undefined && secondItem !== undefined, '目标单必须有方案指标行');
    const draftRes = await app.inject({
      method: 'POST',
      url: `/api/v1/inspections/${targetOrder.id}/submit-measurements`,
      headers: authHeader,
      payload: {
        isDraft: true,
        items: [
          {
            itemCode: firstItem.itemCode,
            measuredText: '100.5',
            inheritedFrom: 'OUTSOURCE_HEAT_TREATMENT',
            originalInheritedValue: '100.0',
            isManuallyModified: true,
          },
          {
            itemCode: secondItem.itemCode,
            measuredText: '36.05',
            inheritedFrom: 'IQC_RAW_MATERIAL',
            originalInheritedValue: '36.05',
            isManuallyModified: false,
          },
        ],
      },
    });
    assert.equal(draftRes.statusCode, 200, `带继承标记的草稿必须 200：${draftRes.body}`);
    const reread = await app.inject({
      method: 'GET',
      url: `/api/v1/inspections/${targetOrder.id}`,
      headers: authHeader,
    });
    const rereadItems = (
      JSON.parse(reread.body) as {
        items: Array<{
          itemCode: string;
          inheritedFrom?: string;
          originalInheritedValue?: number | string;
          isManuallyModified?: boolean;
        }>;
      }
    ).items;
    const first = rereadItems.find((it) => it.itemCode === firstItem.itemCode);
    const second = rereadItems.find((it) => it.itemCode === secondItem.itemCode);
    assert.equal(first?.inheritedFrom, 'OUTSOURCE_HEAT_TREATMENT', 'inheritedFrom 必须落库');
    assert.equal(String(first?.originalInheritedValue), '100.0', '带出原值快照必须落库');
    assert.equal(first?.isManuallyModified, true, '手工修改标记必须落库');
    assert.equal(second?.inheritedFrom, 'IQC_RAW_MATERIAL');
    assert.equal(second?.isManuallyModified, false, '未修改的带出项不得标 isManuallyModified');
    console.log('✔ inheritedFrom / 带出原值 / 手工修改标记：落库回读一致');
  } finally {
    if (createdOrderIds.length > 0) {
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

runHeatBatchTraceLinkTests()
  .then(() => {
    console.log('=== 炉批号三级关联链路集成测试全部通过 ===');
    process.exit(0);
  })
  .catch((err) => {
    console.error('=== 炉批号三级关联链路集成测试失败 ===');
    console.error(err);
    process.exit(1);
  });
