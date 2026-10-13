/**
 * jsonb 列形状防回归检查（真实 PostgreSQL）
 *
 * 背景：node-postgres 会把 JS 数组渲染成 PG 数组字面量（"{...}"），该文本不是合法 JSON，
 * 直接写 jsonb 列会报 22P02；早期看板聚合也曾把 jsonb 当字符串取用而拿不到值。
 * 这类缺陷在类型层面看不出来（列声明与实际写入形状不一致），只能在真实库上验证，
 * 因此这里对每个 jsonb 列断言"库中所有行的 JSON 类型都符合预期"，并额外要求
 * 相关表确有数据，避免检查在空库上空跑而假通过。
 *
 * 运行：npx tsx src/__tests__/jsonb-shape.test.ts（需 .env 指向可用的 PostgreSQL）
 */
import assert from 'node:assert';
import { sql, type SqlBool } from 'kysely';
import { createDatabaseConnection } from '../database/connection.js';
import { syncMesInspectionOrders } from '../adapters/mes-sync-service.js';

interface JsonShapeCheck {
  /** 检查项标签，失败信息里直接用来定位列 */
  label: string;
  /** 期望的 JSON 类型 */
  expected: 'array' | 'object';
  /** 返回不合规行（含 id 与类型样本）的 SQL；表名/列名均为固定常量，不含外部输入 */
  nonConformingSql: string;
}

const CHECKS: JsonShapeCheck[] = [
  {
    label: 'inspection_orders.items',
    expected: 'array',
    nonConformingSql: `select id, order_no, jsonb_typeof(items) as actual, left(items::text, 200) as sample
                       from inspection_orders where jsonb_typeof(items) is distinct from 'array'`,
  },
  {
    label: 'inspection_orders.plan_snapshot',
    expected: 'object',
    nonConformingSql: `select id, order_no, jsonb_typeof(plan_snapshot) as actual, left(plan_snapshot::text, 200) as sample
                       from inspection_orders where jsonb_typeof(plan_snapshot) is distinct from 'object'`,
  },
  {
    label: 'inspection_plans.items',
    expected: 'array',
    nonConformingSql: `select id, plan_code, jsonb_typeof(items) as actual, left(items::text, 200) as sample
                       from inspection_plans where jsonb_typeof(items) is distinct from 'array'`,
  },
  {
    label: 'inspection_plans.sampling_config',
    expected: 'object',
    nonConformingSql: `select id, plan_code, jsonb_typeof(sampling_config) as actual, left(sampling_config::text, 200) as sample
                       from inspection_plans where jsonb_typeof(sampling_config) is distinct from 'object'`,
  },
  {
    label: 'material_permissions.material_categories',
    expected: 'array',
    nonConformingSql: `select id, jsonb_typeof(material_categories) as actual
                       from material_permissions where jsonb_typeof(material_categories) is distinct from 'array'`,
  },
  {
    label: 'material_permissions.material_codes',
    expected: 'array',
    nonConformingSql: `select id, jsonb_typeof(material_codes) as actual
                       from material_permissions where jsonb_typeof(material_codes) is distinct from 'array'`,
  },
  {
    label: 'material_permissions.supplier_codes',
    expected: 'array',
    nonConformingSql: `select id, jsonb_typeof(supplier_codes) as actual
                       from material_permissions where jsonb_typeof(supplier_codes) is distinct from 'array'`,
  },
  {
    label: 'audit_logs.diff_patch',
    expected: 'object',
    nonConformingSql: `select id, entity_name, jsonb_typeof(diff_patch) as actual, left(diff_patch::text, 200) as sample
                       from audit_logs where diff_patch is not null and jsonb_typeof(diff_patch) is distinct from 'object'`,
  },
  {
    label: 'outbox_events.payload',
    expected: 'object',
    nonConformingSql: `select id, event_type, jsonb_typeof(payload) as actual, left(payload::text, 200) as sample
                       from outbox_events where jsonb_typeof(payload) is distinct from 'object'`,
  },
];

async function main(): Promise<void> {
  const db = createDatabaseConnection();
  try {
    console.log('=== jsonb 列形状防回归检查（真实 PostgreSQL） ===');

    // 1. 先确认检查对象确有数据：空表上的形状断言毫无意义
    const orderCount = await db
      .selectFrom('inspectionOrders')
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirstOrThrow();
    const planCount = await db
      .selectFrom('inspectionPlans')
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirstOrThrow();
    const permissionCount = await db
      .selectFrom('materialPermissions')
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirstOrThrow();

    assert.ok(
      Number(orderCount.count) > 0,
      '`inspection_orders` 无任何数据，jsonb 形状检查会空跑：请先执行 pnpm db:seed 或跑一次写路径'
    );
    assert.ok(Number(planCount.count) > 0, '`inspection_plans` 无任何数据，jsonb 形状检查会空跑：请先执行 pnpm db:seed');
    assert.ok(
      Number(permissionCount.count) > 0,
      '`material_permissions` 无任何数据，jsonb 形状检查会空跑：请先执行 pnpm db:seed'
    );

    // 2. 正向证据：至少有一条检验单的 items 是"非空 JSON 数组"，
    //    证明写入路径确实以数组形态落库（而不是双编码为字符串或写成了对象）
    const nonEmptyItemArrays = await db
      .selectFrom('inspectionOrders')
      .select((eb) => eb.fn.countAll().as('count'))
      .where(sql<SqlBool>`jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0`)
      .executeTakeFirstOrThrow();
    assert.ok(
      Number(nonEmptyItemArrays.count) > 0,
      '库中不存在 items 为非空 JSON 数组的检验单，无法证明写入路径的 jsonb 形状正确'
    );

    // 3. 逐列断言：不允许任何一行的 JSON 类型偏离预期
    for (const check of CHECKS) {
      const result = await sql.raw(check.nonConformingSql).execute(db);
      assert.strictEqual(
        result.rows.length,
        0,
        `[${check.label}] 期望 jsonb_typeof=${check.expected}，却有 ${result.rows.length} 行不合规：` +
          JSON.stringify(result.rows.slice(0, 5))
      );
      console.log(`✔ [${check.label}] 全表 jsonb_typeof=${check.expected}`);
    }

    const rollback = new Error('ROLLBACK_MES_IMPORT_TEST');
    try {
      await db.transaction().execute(async (trx) => {
        const orderNo = `TEST-MES-${crypto.randomUUID()}`;
        const result = await syncMesInspectionOrders(trx, 1, {
          reports: [{
            id: crypto.randomUUID(), bill_no: orderNo,
            bill_date: '2026-10-10T08:30:00Z', check_date: '2026-10-10T09:20:00Z',
            check_qty: 12, qualified_qty: 11, unqualified_qty: 1, is_qualified: '0',
            remarks: '历史实绩', task_bill_no: orderNo, heat_number: null,
            steel_mill: null, cutting_length: null, materiel_code: 'MAT-SCR-M6-25',
            materiel_name: null, materiel_spec: null, procedure_code: 'proc-cd',
            procedure_name: '冷镦成型', inspector_name: '测试检验员',
          }],
        });
        assert.strictEqual(result.inserted, 1);
        const order = await trx.selectFrom('inspectionOrders').selectAll()
          .where('orderNo', '=', orderNo).executeTakeFirstOrThrow();
        assert.strictEqual(order.planSnapshot.planCode, 'QP-IPQC-CUT');
        const sourcePlan = await trx.selectFrom('inspectionPlans').select(['planName', 'items'])
          .where('id', '=', order.planVersionId).executeTakeFirstOrThrow();
        assert.strictEqual(order.planSnapshot.planName, sourcePlan.planName);
        assert.deepStrictEqual(order.planSnapshot.items, sourcePlan.items);
        assert.ok(order.planSnapshot.items.length > 0);
        assert.deepStrictEqual(order.items.map((item) => item.itemCode), order.planSnapshot.items.map((item) => item.itemCode));
        assert.ok(order.items.every((item) => item.result === 'PENDING'));
        assert.strictEqual(order.status, 'FAILED');
        assert.strictEqual(order.judgment, 'FAILED');
        assert.strictEqual(order.passQty, 11);
        assert.strictEqual(order.failQty, 1);
        assert.strictEqual(order.createdAt.toISOString(), '2026-10-10T09:20:00.000Z');
        const missingPlanNo = `TEST-MES-${crypto.randomUUID()}`;
        await assert.rejects(
          syncMesInspectionOrders(trx, 1, {
            reports: [{
              id: crypto.randomUUID(), bill_no: missingPlanNo,
              bill_date: '2026-10-10T08:30:00Z', check_date: '2026-10-10T09:20:00Z',
              check_qty: 12, qualified_qty: 11, unqualified_qty: 1, is_qualified: '0',
              task_bill_no: missingPlanNo, materiel_code: `MAT-NO-PLAN-${crypto.randomUUID()}`,
              materiel_name: '无方案测试物料', procedure_name: '冷镦成型',
            }],
          }),
          /未找到适用于物料/
        );
        assert.strictEqual(await trx.selectFrom('inspectionOrders').select('id')
          .where('orderNo', '=', missingPlanNo).executeTakeFirst(), undefined);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    console.log('=== jsonb 列形状检查全部通过 ===');
  } finally {
    await db.destroy();
  }
}

main().catch((err: any) => {
  if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.message?.includes('ECONNREFUSED'))) {
    console.warn('[SKIP] 本地 PostgreSQL 未启动 (ECONNREFUSED)，跳过真实库 jsonb 形状测试');
    process.exit(0);
  }
  console.error('jsonb 形状检查失败:', err);
  process.exit(1);
});
