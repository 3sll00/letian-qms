/**
 * MES 委外回厂/验收单同步（syncMesOutsourceReturns）回归测试（真实 PostgreSQL）
 *
 * 覆盖：
 *   1. 单据字段直接携带 WWJG 号 -> 命中 outsource_no，回填 return_date/process_type；
 *   2. work_no(SCRW) -> 注入的 ERP 行级来源链 -> WWJG；
 *   3. 无任何链接键 -> unmatched 且不更新；
 *   4. 已有人工登记的 return_date 一律不覆盖；
 *   5. 一张 WWJG 多物料行时按 materielCode 消歧。
 *
 * 运行：npx tsx src/__tests__/mes-outsource-returns.test.ts（需 .env 指向可用 PostgreSQL）
 */
import assert from 'node:assert';
import { db } from '../database/connection.js';
import {
  syncMesOutsourceReturns,
  type MesOutsourceDispatchRow,
} from '../adapters/mes-sync-service.js';

const TAG = 'TEST-MESOT';
const WWJG_A = 'WWJG-2099-01-01-00001';
const WWJG_B = 'WWJG-2099-01-02-00001';
const SCRW_X = 'SCRW-20990101-001';
const MAT_A = 'TEST-MAT-A';
const MAT_B = 'TEST-MAT-B';

function dispatch(over: Partial<MesOutsourceDispatchRow>): MesOutsourceDispatchRow {
  return {
    id: 'd-1',
    bill_no: 'OT20990100001',
    bill_date: null,
    check_status: '1',
    check_date: '2099-02-01T05:00:00.000Z',
    finished_date: null,
    finish_end_date: null,
    invoice_no: null,
    production_order: null,
    task_id: 't-1',
    task_body_id: null,
    template_field: null,
    task_bill_no: null,
    work_no: null,
    erp_bill_no: null,
    materiel_code: null,
    supplier_name: null,
    ...over,
  };
}

async function main() {
  const plan = await db
    .selectFrom('inspectionOrders')
    .select(['planId', 'planVersionId'])
    .where('orderType', '=', 'OQC_SF')
    .limit(1)
    .executeTakeFirstOrThrow();

  // 先清掉上次可能残留的合成单，再建两条：A 可回填；B 预置人工 return_date
  await db.deleteFrom('inspectionOrders').where('orderNo', 'like', `${TAG}%`).execute();
  const insertBase = {
    planId: plan.planId,
    planVersionId: plan.planVersionId,
    batchNo: 'B-TEST-MESOT',
    materialName: '合成测试物料',
    sampleQty: 1,
    status: 'PENDING' as const,
    planSnapshot: '{}',
    items: '[]',
  };
  await db
    .insertInto('inspectionOrders')
    .values([
      {
        ...insertBase,
        orderNo: `${TAG}-A1`,
        orderType: 'OQC_SF' as const,
        materialCode: MAT_A,
        outsourceNo: WWJG_A,
      },
      {
        ...insertBase,
        orderNo: `${TAG}-A2`,
        orderType: 'OQC_SF' as const,
        materialCode: MAT_B,
        outsourceNo: WWJG_A,
      },
      {
        ...insertBase,
        orderNo: `${TAG}-B1`,
        orderType: 'OQC_SF' as const,
        materialCode: MAT_A,
        outsourceNo: WWJG_B,
        returnDate: '2099-01-15',
      },
    ])
    .execute();

  try {
    // 场景 1：invoice_no 携带 WWJG + template_field 物料消歧（两条 A 行里只命中 MAT_A）
    const r1 = await syncMesOutsourceReturns(db, 10, {
      dispatches: [
        dispatch({
          invoice_no: 'FH-xxx WWJG-2099-01-01-00001',
          template_field: JSON.stringify({
            materielCode: MAT_A,
            planBodySurfaceTreatment: '热镀锌',
            taskBillNo: 'PT20990100001',
          }),
        }),
      ],
    });
    assert.equal(r1.read, 1);
    assert.equal(r1.matched, 1, `场景1应匹配1份: ${JSON.stringify(r1.unmatched)}`);
    assert.equal(r1.updated, 1, '场景1应只更新 MAT_A 那一行');
    const a1 = await db
      .selectFrom('inspectionOrders')
      .select(['returnDate', 'processType'])
      .where('orderNo', '=', `${TAG}-A1`)
      .executeTakeFirstOrThrow();
    assert.equal(a1.returnDate, '2099-02-01');
    assert.equal(a1.processType, '热镀锌');
    const a2 = await db
      .selectFrom('inspectionOrders')
      .select(['returnDate'])
      .where('orderNo', '=', `${TAG}-A2`)
      .executeTakeFirstOrThrow();
    assert.equal(a2.returnDate, null, '未携带该物料编码的行不应被更新');

    // 场景 2：仅 work_no(SCRW)，走注入的 ERP 行级来源链
    const r2 = await syncMesOutsourceReturns(db, 10, {
      dispatches: [
        dispatch({
          id: 'd-2',
          bill_no: 'OT20990100002',
          work_no: SCRW_X,
          materiel_code: MAT_B,
        }),
      ],
      scrwToWwjg: new Map([[SCRW_X, [{ wwjgNo: WWJG_A, userCode: MAT_B }]]]),
    });
    assert.equal(r2.matched, 1, `场景2应匹配1份: ${JSON.stringify(r2.unmatched)}`);
    assert.equal(r2.updated, 1);
    const a2b = await db
      .selectFrom('inspectionOrders')
      .select(['returnDate'])
      .where('orderNo', '=', `${TAG}-A2`)
      .executeTakeFirstOrThrow();
    assert.equal(a2b.returnDate, '2099-02-01', 'SCRW 链命中的行应回填回厂日期');

    // 场景 3：无任何链接键 -> unmatched
    const r3 = await syncMesOutsourceReturns(db, 10, {
      dispatches: [
        dispatch({ id: 'd-3', bill_no: 'OT20990100003', task_bill_no: 'PT20990100003' }),
      ],
      scrwToWwjg: new Map(),
    });
    assert.equal(r3.matched, 0);
    assert.equal(r3.updated, 0);
    assert.equal(r3.unmatchedCount, 1);

    // 场景 4：已有人工登记的 return_date 不覆盖
    const r4 = await syncMesOutsourceReturns(db, 10, {
      dispatches: [
        dispatch({
          id: 'd-4',
          bill_no: 'OT20990100004',
          invoice_no: WWJG_B,
          check_date: '2099-03-01T05:00:00.000Z',
        }),
      ],
    });
    assert.equal(r4.matched, 1);
    assert.equal(r4.updated, 0, '人工已登记的 return_date 不得被覆盖');
    const b1 = await db
      .selectFrom('inspectionOrders')
      .select(['returnDate'])
      .where('orderNo', '=', `${TAG}-B1`)
      .executeTakeFirstOrThrow();
    assert.equal(b1.returnDate, '2099-01-15');

    // 场景 5：SCRW 对应多张委外单且无物料编码 -> 歧义跳过
    const r5 = await syncMesOutsourceReturns(db, 10, {
      dispatches: [dispatch({ id: 'd-5', bill_no: 'OT20990100005', work_no: SCRW_X })],
      scrwToWwjg: new Map([
        [SCRW_X, [{ wwjgNo: WWJG_A, userCode: MAT_A }, { wwjgNo: WWJG_B, userCode: MAT_B }]],
      ]),
    });
    assert.equal(r5.matched, 0);
    assert.equal(r5.unmatchedCount, 1);

    console.log('[OK] mes-outsource-returns 全部场景通过');
  } finally {
    await db.deleteFrom('inspectionOrders').where('orderNo', 'like', `${TAG}%`).execute();
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
