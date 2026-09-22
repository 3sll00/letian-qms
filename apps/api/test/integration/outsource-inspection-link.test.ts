import assert from 'node:assert/strict';
import { buildApp } from '../../src/app';
import { createApiContainer, type ApiContainer } from '../../src/container';
import { generateTestToken } from '../../src/plugins/auth';
import { InspectionOrderSchema, InspectionTypeEnum } from '@letian/contracts';

/**
 * 委外七分类 (OQC) 台账接口与数据库对接回归测试
 *
 * 覆盖【委外检验 - 表面处理检验 / 机加工检验 / 热处理检验】三个页签：
 * 1. 契约枚举中全部 7 个委外工艺分类都必须能被 GET /api/v1/inspections 接受，
 *    不得出现仓储层类型白名单漏配导致的 500；
 * 2. 每个分类的 total 必须等于 inspection_orders 中该 order_type 的真实行数；
 * 3. 台账展示的委外加工单号(outsourceNo) / 加工类型(processType) / 加工商(vendorName)
 *    / 回厂日期(returnDate) / 检验人(inspectorName) 必须与数据库列逐条一致。
 */
async function runOutsourceInspectionLinkTests() {
  console.log('--- 委外七分类台账字段与接口打通回归测试（真实 PostgreSQL） ---');

  const container: ApiContainer = createApiContainer();
  const app = await buildApp({ logger: false, container });
  const db = container.db;

  const token = generateTestToken({
    userId: '11000000-0000-4000-8000-000000000001',
    userName: '张强',
    role: 'QA_MANAGER',
  });
  const authHeader = { authorization: `Bearer ${token}` };

  /** 委外七分类（与契约 InspectionTypeEnum 中的 OQC 工艺细分保持一致） */
  const outsourceTypes = InspectionTypeEnum.options.filter(
    (t) => t.startsWith('OQC_') && t !== 'OQC_SH'
  );
  assert.ok(outsourceTypes.length >= 7, '委外工艺分类应至少覆盖 7 类');

  try {
    // 三张台账页签直接使用的三个查询入口必须返回 200
    for (const type of ['OQC_SF', 'OQC_MACH', 'OQC_HEAT'] as const) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/inspections?inspectionType=${type}&pageSize=100`,
        headers: authHeader,
      });
      assert.equal(res.statusCode, 200, `${type} 台账查询必须返回 200，实际 ${res.statusCode}`);
    }

    const rows = await db
      .selectFrom('inspectionOrders')
      .select([
        'orderNo',
        'orderType',
        'batchNo',
        'outsourceNo',
        'processType',
        'returnDate',
        'vendorName',
        'supplierCode',
        'supplierName',
        'inspectorName',
        'inspectorId',
        'createdAt',
      ])
      .where('orderType', 'in', ['OQC_SF', 'OQC_MACH', 'OQC_HEAT'])
      .execute();

    const employeeRows = await db.selectFrom('employees').select(['id', 'name']).execute();
    const employeeNames = new Map(employeeRows.map((e) => [e.id, e.name]));

    // 供应商主数据：用于断言「加工商」列不得直接暴露内部编码（011 迁移的回填口径）
    const supplierRows = await db
      .selectFrom('suppliers')
      .select(['supplierCode', 'supplierName'])
      .execute();
    const supplierNames = new Map(supplierRows.map((s) => [s.supplierCode, s.supplierName]));

    for (const type of outsourceTypes) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/inspections?inspectionType=${type}&pageSize=100`,
        headers: authHeader,
      });
      assert.equal(res.statusCode, 200, `委外分类 ${type} 查询不得失败`);

      const body = JSON.parse(res.body) as {
        total: number;
        items: Array<Record<string, unknown>>;
      };
      const expected = rows.filter((r) => r.orderType === type);
      assert.equal(body.total, expected.length, `${type} 的 total 应等于库中行数`);
      assert.equal(body.items.length, expected.length, `${type} 当页条数应等于库中行数`);

      for (const item of body.items) {
        const parsed = InspectionOrderSchema.safeParse(item);
        assert.equal(parsed.success, true, `${type} 返回项必须满足 InspectionOrderSchema`);

        const dbRow = expected.find((r) => r.orderNo === item.orderNo);
        assert.ok(dbRow, `${type} 返回项 ${String(item.orderNo)} 必须存在于库中`);

        // 委外加工单号 / 回厂日期**只取物理列**：库列为空时接口不得回退
        //（批次号 ≠ 委外加工单号、建单时间 ≠ 回厂时间），见 docs/09 §2.4 与 docs/32 §2.2
        assert.equal(
          item.outsourceNo,
          dbRow.outsourceNo ?? undefined,
          '委外加工单号必须只取库中列（为空即不得回落批次号）'
        );
        assert.equal(item.processType, dbRow.processType ?? undefined, '加工类型必须取库中列');
        assert.equal(item.vendorName, dbRow.vendorName ?? undefined, '加工商必须取库中列');

        // 「加工商」列任何时候都不得直接展示供应商内部编码（如 SUP-004）
        const supplierCode = dbRow.supplierCode;
        if (supplierCode !== null) {
          assert.notEqual(
            item.vendorName,
            supplierCode,
            '加工商列不得直接展示供应商内部编码'
          );
        }

        // 011 迁移口径：库中既无 vendor_name 也无 supplier_name、但 supplier_code 能命中
        // 供应商主数据时，加工商必须解析为供应商名称。库中已有名称快照的行允许与主数据
        // 不同（快照即演示口径），因此这里只在两个名称列都为空时才断言。
        const masterName =
          dbRow.vendorName === null && dbRow.supplierName === null && supplierCode !== null
            ? supplierNames.get(supplierCode)
            : undefined;
        if (masterName !== undefined) {
          assert.equal(
            item.vendorName,
            masterName,
            '加工商不得回落到供应商内部编码，应解析为供应商主数据名称'
          );
        }
        assert.equal(
          item.returnDate,
          dbRow.returnDate ?? undefined,
          '回厂日期必须只取库中列（为空即不得回落建单日期）'
        );

        // 检验人：库快照优先，其次按员工主数据补齐
        const expectedInspector =
          (dbRow.inspectorName as string | null) ??
          (dbRow.inspectorId ? employeeNames.get(dbRow.inspectorId) : undefined);
        assert.equal(
          item.inspectorName,
          expectedInspector ?? undefined,
          '检验人必须与库快照或员工主数据一致'
        );
      }
    }

    console.log('✓ 委外七分类台账 total / 委外单号 / 加工类型 / 加工商 / 回厂日期 / 检验人 均与真实库一致');
  } finally {
    await app.close();
    await db.destroy();
  }
}

runOutsourceInspectionLinkTests()
  .then(() => {
    console.log('=== 委外七分类台账对接回归测试全部通过 ===');
    process.exit(0);
  })
  .catch((err) => {
    console.error('=== 委外七分类台账对接回归测试失败 ===');
    console.error(err);
    process.exit(1);
  });
