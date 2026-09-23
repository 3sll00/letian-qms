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
 * 4. 030 迁移新增的委外录入页业务事实列（materialGrade / techStandard / inspectedDate）
 *    在台账上必须只取物理列：库内为空即不得输出该键，更不得用推导值冒充（见 docs/36 §6）；
 * 5. 写路径：委外录入页全字段建单必须真实落库，并可从单证回看接口原样读回
 *    （docs/36 §7 / §7.1）。
 * 6. 三页签建单：表面处理 / 机加工 / 热处理**每个页签**都必须至少有一个可由两级匹配
 *    （docs/17 §7.3：物料专属 → 分类通用兜底）建单的物料，且建单快照必须绑定命中方案
 *    —— 守住 docs/36 §9 补齐的 5 份族级方案这条下限，任一页签退回「能看不能录」即失败。
 */

/** 物理列为空（NULL / 空串）时接口必须省略该键，与仓储 mapRow 的取值口径保持一致 */
function physical(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : value;
}

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

  /** 本次测试新建的委外检验单主键，结束时清理，保证回归测试可重复运行 */
  const createdOrderIds: string[] = [];

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
        // 030 迁移新增的委外录入页业务事实列（docs/36 §3）
        'materialGrade',
        'techStandard',
        'inspectedDate',
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

        // 030 迁移（docs/36 §6）：材质牌号 / 执行技术标准 / 检验日期三列同样**只取物理列**。
        // 库内为空即不得输出该键，更不得用 completedAt / createdAt 等推导值冒充；
        // 「检验日期回落完成时间」只发生在前端展示层，接口既不代为推导也不写回库。
        assert.equal(
          item.materialGrade,
          physical(dbRow.materialGrade),
          '材质牌号必须只取 material_grade 物理列（为空即不得输出该键）'
        );
        assert.equal(
          item.techStandard,
          physical(dbRow.techStandard),
          '执行技术标准必须只取 tech_standard 物理列（为空即不得输出该键）'
        );
        assert.equal(
          item.inspectedDate,
          physical(dbRow.inspectedDate),
          '检验日期必须只取 inspected_date 物理列（为空即不得输出该键）'
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
    console.log(
      '✓ 030 迁移三列（材质牌号 / 执行技术标准 / 检验日期）与库逐条一致，空列不输出该键'
    );

    // =======================================================================
    // 2. 写路径：委外录入页全字段建单 -> 落库 -> 单证回看 -> 台账可见
    //    （docs/36 §7 第 2 / 3 条）
    // =======================================================================
    console.log(
      '2. 委外三页签写路径（自动匹配建单）+ 委外录入页全字段写路径（回厂日期 / 材质牌号 / 执行技术标准 / 检验日期）...'
    );

    const stamp = Date.now();

    // 2.0 委外建单必须由「两级匹配」解析方案（docs/17 §7.3）：物料专属方案优先，
    //     缺专属方案时由分类通用（族级）方案兜底 —— docs/36 §9 补的族级方案必须让
    //     **三个页签都能建单**，任一扫不到的页签就是又回到「能看不能录」。
    const activePlans = await db
      .selectFrom('inspectionPlans')
      .select(['id', 'planCode', 'inspectionStage', 'materialCode', 'categoryCode'])
      .where('versionStatus', '=', 'ACTIVE')
      .where('inspectionStage', 'in', ['OQC_SF', 'OQC_MACH', 'OQC_HEAT'])
      .execute();
    const materialRows = await db
      .selectFrom('materials')
      .select(['materialCode', 'categoryCode'])
      .execute();

    /** 两级匹配的命中预期（与 `GET /plans/match` 同口径）；料号全部取自主数据，不硬编码 */
    const expectMatch = (materialCode: string, stage: string) => {
      const categoryCode = materialRows.find((row) => row.materialCode === materialCode)?.categoryCode;
      return (
        activePlans.find(
          (plan) => plan.materialCode === materialCode && plan.inspectionStage === stage
        ) ??
        activePlans.find(
          (plan) =>
            plan.materialCode === '' &&
            plan.categoryCode === categoryCode &&
            plan.inspectionStage === stage
        )
      );
    };

    // 代表物料：物料级方案用自己的料号；族级方案取同分类下的任一料号（该料号无更精确的方案时）
    const writeCases = new Map<
      string,
      { type: string; materialCode: string; plan: (typeof activePlans)[number] }
    >();
    for (const plan of activePlans) {
      const materialCode =
        plan.materialCode !== ''
          ? plan.materialCode
          : materialRows.find((row) => row.categoryCode === plan.categoryCode)?.materialCode;
      if (materialCode === undefined) continue;
      const hit = expectMatch(materialCode, plan.inspectionStage);
      // 同一料号 + 页签只留一条用例，且只断言真正会被命中的那份方案
      if (hit === undefined || hit.id !== plan.id) continue;
      writeCases.set(`${plan.inspectionStage}:${materialCode}`, {
        type: plan.inspectionStage,
        materialCode,
        plan,
      });
    }

    for (const stage of ['OQC_SF', 'OQC_MACH', 'OQC_HEAT'] as const) {
      assert.ok(
        [...writeCases.values()].some((item) => item.type === stage),
        `${stage} 页签必须有可由两级匹配建单的物料，否则该页签「能看不能录」（docs/36 §9）`
      );
    }
    assert.ok(
      [...writeCases.values()].some((item) => item.plan.materialCode === ''),
      '三页签建单必须覆盖分类通用（族级）兜底路径，否则覆盖不到 docs/36 §9 的族级方案'
    );

    // 2.0 建单（**不传 planVersionId**，由服务端两级匹配选方案）：每个代表物料都必须 201，
    //     且本单快照必须绑定到两级匹配命中的那份方案
    for (const item of writeCases.values()) {
      const autoRes = await app.inject({
        method: 'POST',
        url: '/api/v1/inspections',
        headers: authHeader,
        payload: {
          inspectionType: item.type,
          materialCode: item.materialCode,
          materialName: `委外三页签建单回归物料 ${item.type}`,
          batchNo: `OSLINK-TABS-${stamp}-${item.type}`,
          sampleQty: 8,
        },
      });
      assert.equal(
        autoRes.statusCode,
        201,
        `${item.type} 页签按物料 [${item.materialCode}] 自动匹配建单应返回 201，实际 ${autoRes.statusCode}: ${autoRes.body}`
      );
      const autoCreated = JSON.parse(autoRes.body) as {
        id: string;
        orderNo: string;
        planVersionId: string;
        planSnapshot: { planCode: string };
      };
      // 先登记主键再做断言，保证断言失败时也会被 finally 清理
      createdOrderIds.push(autoCreated.id);
      assert.equal(
        autoCreated.planVersionId,
        item.plan.id,
        `${item.type} 建单必须绑定两级匹配命中的方案版本 [${item.plan.planCode}]`
      );
      assert.equal(
        autoCreated.planSnapshot.planCode,
        item.plan.planCode,
        `${item.type} 建单快照的方案编码必须与命中方案一致`
      );
      console.log(
        `✓ ${item.type} 按物料 [${item.materialCode}] 建单 201，命中 ${item.plan.planCode}` +
          `（${item.plan.materialCode === '' ? '分类通用兜底' : '物料专属'}），单号 ${autoCreated.orderNo}`
      );
    }

    // 7 字段写路径用例取一个代表（物料专属优先，保证断言与方案自身无关）
    const writeCaseList = [...writeCases.values()];
    const writeCase =
      writeCaseList.find((item) => item.plan.materialCode !== '') ?? writeCaseList[0];
    assert.ok(writeCase, '委外录入页全字段写路径必须有一个代表用例');

    const expectedFields = {
      outsourceNo: `WWJG-OSLINK-${stamp}`,
      processType: '镀锌',
      returnDate: '2026-09-22',
      vendorName: '委外写路径回归加工商',
      materialGrade: '10B21',
      techStandard: 'GB/T 3098.1-2010',
      inspectedDate: '2026-09-23',
    } as const;
    const expectedKeys = Object.keys(expectedFields) as Array<keyof typeof expectedFields>;

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/inspections',
      headers: authHeader,
      payload: {
        inspectionType: writeCase.type,
        materialCode: writeCase.materialCode,
        materialName: '委外录入写路径回归物料',
        batchNo: `OSLINK-030-${stamp}`,
        sampleQty: 12,
        planVersionId: writeCase.plan.id,
        ...expectedFields,
      },
    });
    assert.equal(
      createRes.statusCode,
      201,
      `委外录入页全字段建单应返回 201，实际 ${createRes.statusCode}: ${createRes.body}`
    );
    const created = JSON.parse(createRes.body) as { id: string; orderNo: string };
    // 先登记主键再做断言，保证断言失败时也会被 finally 清理
    createdOrderIds.push(created.id);

    // 2.1 物理列落库：请求体 7 个字段与 inspection_orders 逐项一致
    const persisted = await db
      .selectFrom('inspectionOrders')
      .select(['id', ...expectedKeys])
      .where('id', '=', created.id)
      .executeTakeFirst();
    assert.ok(persisted, `新建的委外检验单 [${created.orderNo}] 必须已落库`);
    for (const key of expectedKeys) {
      assert.equal(
        persisted[key],
        expectedFields[key],
        `委外录入页字段 ${key} 必须原样落库（不得被静默丢弃）`
      );
    }

    // 2.2 单证回看：GET /inspections/{id} 返回本单物理列真实值
    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/v1/inspections/${created.id}`,
      headers: authHeader,
    });
    assert.equal(detailRes.statusCode, 200, `单证回看应返回 200，实际 ${detailRes.statusCode}`);
    const detail = JSON.parse(detailRes.body) as Record<string, unknown>;
    for (const key of expectedKeys) {
      assert.equal(detail[key], expectedFields[key], `单证回看 ${key} 必须取本单物理列真实值`);
    }

    // 2.3 台账可见：委外页签按单号检索到该单，7 个字段仍与库一致
    const listRes = await app.inject({
      method: 'GET',
      url:
        `/api/v1/inspections?inspectionType=${writeCase.type}` +
        `&docKeyword=${encodeURIComponent(created.orderNo)}&pageSize=100`,
      headers: authHeader,
    });
    assert.equal(listRes.statusCode, 200, `委外台账按单号检索应返回 200，实际 ${listRes.statusCode}`);
    const listBody = JSON.parse(listRes.body) as { total: number; items: Array<Record<string, unknown>> };
    const listed = listBody.items.find((row) => row.orderNo === created.orderNo);
    assert.ok(listed, `新建的委外检验单 [${created.orderNo}] 必须出现在 ${writeCase.type} 台账`);
    for (const key of expectedKeys) {
      assert.equal(listed[key], expectedFields[key], `台账 ${key} 必须与库一致`);
    }

    console.log(
      `✓ 委外录入页 7 个字段建单落库并可从单证回看 / 台账读回（单号 ${created.orderNo}）`
    );
  } finally {
    // 清理本次新建的检验单，保证回归测试可重复执行。
    // 审计日志 / Outbox 事件为 append-only 留痕，按设计保留，不随业务数据回滚。
    if (createdOrderIds.length > 0) {
      const createdOrderRows = await db
        .selectFrom('inspectionOrders')
        .select(['orderNo'])
        .where('id', 'in', createdOrderIds)
        .execute();
      const deletedPool = await db
        .deleteFrom('pendingMrbItems')
        .where('sourceOrderId', 'in', createdOrderIds)
        .executeTakeFirst();
      const deletedTrace =
        createdOrderRows.length > 0
          ? await db
              .deleteFrom('batchTraceRelations')
              .where(
                'parentBatch',
                'in',
                createdOrderRows.map((row) => row.orderNo)
              )
              .executeTakeFirst()
          : undefined;
      const deleted = await db
        .deleteFrom('inspectionOrders')
        .where('id', 'in', createdOrderIds)
        .executeTakeFirst();
      console.log(
        `清理：删除本次新建的委外检验单 ${String(deleted.numDeletedRows)} / ${createdOrderIds.length} 条` +
          `（关联待审核池条目 ${String(deletedPool.numDeletedRows)} 条 / 批次追溯边 ${String(deletedTrace?.numDeletedRows ?? 0)} 条）`
      );
    }
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
