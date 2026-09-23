import assert from 'node:assert/strict';
import { buildApp } from '../../src/app';
import { createApiContainer, type ApiContainer } from '../../src/container';
import { generateTestToken } from '../../src/plugins/auth';

/**
 * 质检方案域 PBAC 供应商维度口径回归测试（真实 PostgreSQL）
 *
 * 口径见 docs/42-质检方案域PBAC供应商维度错配修复设计.md §3：
 * **方案域对象无供应商属性 => 供应商维度不参与方案域判定；单据域三维判定一字不改。**
 *
 * 真实起因（2026-09-23）：三维限定账号 IQC 检验员陈静（分类 CAT-RAW-WIRE + 编码 MAT-304SS-05 +
 * 供应商 SUP-001/002）打开【来料检验】录入表单恒为空白 —— `GET /plans/match` 恒 403
 * （规则限定供应商而请求不带供应商上下文 => 该规则整条不匹配 => 指标清单拿不到）。
 *
 * 断言：
 * 1. 陈静 `GET /plans/match`（MAT-304SS-05 + IQC）必须 200 且给出指标清单（修复前恒 403）；
 * 2. 方案列表 `GET /plans` 与 KPI `GET /plans/stats` 同口径：陈静的方案库可见（修复前 total = 0）；
 * 3. 物料维度不放宽：不在其白名单的物料仍 403（fail-closed）；
 * 4. 无生效规则的用户（王建国：规则已停用）仍 403 —— 方案域不得把"无规则"变成"放行"；
 * 5. 单据域不放宽：陈静打不开供应商不在其白名单的检验单（本轮只动方案域）。
 */

const CHEN_JING = { userId: '11000000-0000-4000-8000-000000000008', userName: '陈静', role: 'IQC_INSPECTOR' };
const WANG_JIAN_GUO = { userId: '11000000-0000-4000-8000-000000000004', userName: '王建国', role: 'RESTRICTED_VIEWER' };
const ZHANG_QIANG = { userId: '11000000-0000-4000-8000-000000000001', userName: '张强', role: 'QA_MANAGER' };

/** 陈静管辖的物料（三维限定命中） */
const OWNED_MATERIAL = 'MAT-304SS-05';
/** 不在陈静白名单的物料（分类 CAT-FIN-BOLT 不属于其管辖分类） */
const OUT_OF_SCOPE_MATERIAL = 'MAT-BLT-109-M10';

async function runPlanMatchPbacTests() {
  console.log('--- 质检方案域 PBAC 供应商维度口径回归测试（真实 PostgreSQL） ---');

  const container: ApiContainer = createApiContainer();
  const app = await buildApp({ logger: false, container });
  const db = container.db;

  const headersOf = (user: { userId: string; userName: string; role: string }) => ({
    authorization: `Bearer ${generateTestToken(user)}`,
    'content-type': 'application/json',
  });
  const chenHeaders = headersOf(CHEN_JING);
  const adminHeaders = headersOf(ZHANG_QIANG);

  /** 本次测试新建的检验单主键，结束时清理，保证可重复运行 */
  const createdOrderIds: string[] = [];

  try {
    // ==== 1. 陈静按物料匹配方案：必须 200 且给出待检指标清单（本次修复的核心断言） ====
    const matchRes = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/match?materialCode=${OWNED_MATERIAL}&inspectionType=IQC`,
      headers: chenHeaders,
    });
    assert.equal(
      matchRes.statusCode,
      200,
      `三维限定用户按物料匹配方案必须 200（修复前恒 403），实际 ${matchRes.statusCode}：${matchRes.body}`
    );
    const matched = JSON.parse(matchRes.body) as {
      planCode: string;
      planVersionId: string;
      versionNo: string;
      matchSource: string;
      items: Array<{ itemCode: string }>;
    };
    assert.equal(matched.planCode, 'QP-IQC-304SS', '应命中该物料的物料专属方案');
    assert.equal(matched.matchSource, 'MATERIAL', '命中来源应为物料专属方案');
    assert.ok(matched.items.length > 0, '匹配结果必须给出待检指标清单（否则录入页无指标行可渲染）');
    assert.ok(
      typeof matched.planVersionId === 'string' && matched.planVersionId.length > 0,
      '必须给出 planVersionId（建单时原样回传绑定快照）'
    );
    console.log(
      `✔ 陈静（三维限定）按物料匹配方案：200 · ${matched.planCode} ${matched.versionNo} · ` +
        `${String(matched.items.length)} 项待检指标`
    );

    // ==== 2. 方案列表 / KPI 同口径：方案域可见性不再被供应商维度整条作废 ====
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/plans?inspectionType=IQC&page=1&pageSize=100',
      headers: chenHeaders,
    });
    assert.equal(listRes.statusCode, 200, `陈静查询方案列表必须 200，实际 ${listRes.statusCode}`);
    const listed = JSON.parse(listRes.body) as {
      total: number;
      items: Array<{ planCode: string }>;
    };
    assert.ok(listed.total >= 1, `陈静的方案库不应为空（修复前 total = 0），实际 ${String(listed.total)}`);
    assert.ok(
      listed.items.some((plan) => plan.planCode === 'QP-IQC-304SS'),
      '陈静的方案列表应含其管辖物料的方案'
    );

    const statsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/plans/stats',
      headers: chenHeaders,
    });
    assert.equal(statsRes.statusCode, 200, '方案 KPI 必须 200');
    const stats = JSON.parse(statsRes.body) as { total: number };
    assert.ok(stats.total >= 1, `陈静可见方案数应 >= 1（修复前为 0），实际 ${String(stats.total)}`);
    console.log(`✔ 陈静方案列表 / KPI 同口径：total = ${String(listed.total)} / ${String(stats.total)}`);

    // ==== 3. 物料维度不放宽：越权物料仍 403（fail-closed，不因去掉一个维度而放大可见范围） ====
    const outOfScopeRes = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/match?materialCode=${OUT_OF_SCOPE_MATERIAL}&inspectionType=OQC_SH`,
      headers: chenHeaders,
    });
    assert.equal(
      outOfScopeRes.statusCode,
      403,
      `管辖范围外的物料必须 403，实际 ${outOfScopeRes.statusCode}：${outOfScopeRes.body}`
    );
    assert.equal(
      (JSON.parse(outOfScopeRes.body) as { code: string }).code,
      'pbac-permission-denied',
      '越权物料应返回 pbac-permission-denied'
    );
    console.log('✔ 物料维度未放宽：管辖范围外物料仍 403 pbac-permission-denied');

    // ==== 4. 无生效规则的用户仍 fail-closed（方案域不得把"没有规则"变成"放行"） ====
    const noRuleRes = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/match?materialCode=${OWNED_MATERIAL}&inspectionType=IQC`,
      headers: headersOf(WANG_JIAN_GUO),
    });
    assert.equal(
      noRuleRes.statusCode,
      403,
      `无生效规则的用户必须 403（fail-closed），实际 ${noRuleRes.statusCode}：${noRuleRes.body}`
    );
    console.log('✔ 无生效规则用户（王建国 · 规则已停用）仍 fail-closed：403');

    // ==== 5. 单据域不放宽：供应商不在白名单的检验单，陈静打不开 ====
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/inspections',
      headers: adminHeaders,
      payload: {
        inspectionType: 'IQC',
        materialCode: OWNED_MATERIAL,
        batchNo: 'VERIFY-PLAN-PBAC-SUP003',
        sampleQty: 10,
        totalQty: 10,
        // SUP-003 不在陈静的白名单（SUP-001 / SUP-002）内
        supplierCode: 'SUP-003',
      },
    });
    assert.equal(
      createRes.statusCode,
      201,
      `管理员建单必须 201（用于验证单据域不被放宽），实际 ${createRes.statusCode}：${createRes.body}`
    );
    const probeOrder = JSON.parse(createRes.body) as { id: string; orderNo: string };
    createdOrderIds.push(probeOrder.id);

    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/v1/inspections/${probeOrder.id}`,
      headers: chenHeaders,
    });
    assert.equal(
      detailRes.statusCode,
      403,
      `白名单外供应商的检验单详情必须仍 403（单据域三维不放宽），实际 ${detailRes.statusCode}`
    );

    const planStillMatched = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/match?materialCode=${OWNED_MATERIAL}&inspectionType=IQC`,
      headers: chenHeaders,
    });
    assert.equal(
      planStillMatched.statusCode,
      200,
      '方案域不受供应商上下文影响：同一物料读方案仍应 200'
    );
    console.log(
      `✔ 单据域未放宽：${probeOrder.orderNo}（SUP-003）详情仍 403，而同一物料的方案匹配仍 200`
    );
  } finally {
    if (createdOrderIds.length > 0) {
      const deleted = await db
        .deleteFrom('inspectionOrders')
        .where('id', 'in', createdOrderIds)
        .executeTakeFirst();
      console.log(`清理：删除本次新建的检验单 ${String(deleted.numDeletedRows)} 条`);
    }
    await app.close();
    await db.destroy();
  }
}

runPlanMatchPbacTests()
  .then(() => {
    console.log('=== 质检方案域 PBAC 供应商维度口径回归测试全部通过 ===');
    process.exit(0);
  })
  .catch((err) => {
    console.error('=== 质检方案域 PBAC 供应商维度口径回归测试失败 ===');
    console.error(err);
    process.exit(1);
  });
