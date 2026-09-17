/**
 * 临时验收探针（真实 HTTP + 真实 PostgreSQL，运行结束后删除）：
 * 对"正在运行的后端进程"发真实 HTTP 请求，验证前端经代理会走到的同一批接口。
 * 运行：npx tsx test/_http-acceptance.real.ts
 */
import assert from 'node:assert';
import { createDatabaseConnection } from '@letian/infrastructure';

const BASE = 'http://127.0.0.1:3000/api/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  // 1. 开发态登录取令牌（与浏览器端 lib/api.ts 相同的路径）
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userName: 'HTTP 验收员', roleCode: 'QUALITY_MANAGER' }),
  });
  assert.equal(loginRes.status, 200, `登录应返回 200，实际 ${loginRes.status}`);
  const { token } = (await loginRes.json()) as { token: string };
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  console.log('✔ 开发态登录取得令牌');

  // 2. 未带令牌必须 401（前后端打通后的鉴权底线）
  const noAuth = await fetch(`${BASE}/dashboard/overview`);
  assert.equal(noAuth.status, 401, '未带令牌访问受保护接口必须 401');
  assert.match(noAuth.headers.get('content-type') ?? '', /application\/problem\+json/);
  console.log('✔ 未带令牌 401 + application/problem+json');

  // 3. 看板总览（前端首页数据源）
  const overviewRes = await fetch(`${BASE}/dashboard/overview`, { headers: auth });
  assert.equal(overviewRes.status, 200);
  const overview = (await overviewRes.json()) as {
    totalInspections?: number;
    passRate?: number;
    statusDistribution?: unknown;
    recentActivities?: unknown[];
  };
  assert.ok((overview.totalInspections ?? 0) > 0, `看板总检验数应大于 0，实际 ${overview.totalInspections}`);
  console.log(`✔ 看板总览: totalInspections=${overview.totalInspections} passRate=${overview.passRate}`);

  // 4. 检验台账列表 + 方案列表（前端列表页数据源）
  const listRes = await fetch(`${BASE}/inspections?page=1&pageSize=5`, { headers: auth });
  assert.equal(listRes.status, 200);
  const list = (await listRes.json()) as { total: number; items: unknown[] };
  assert.ok(list.items.length > 0, '检验台账应返回真实数据');

  const plansRes = await fetch(`${BASE}/plans?isActive=true&pageSize=50`, { headers: auth });
  assert.equal(plansRes.status, 200);
  const plans = (await plansRes.json()) as {
    items: Array<{
      id: string;
      planCode: string;
      inspectionType: string;
      materialCode: string;
      versions?: Array<{
        id: string;
        status: string;
        items?: Array<{ itemCode: string; dataType: string; nominalValue?: number; standardText?: string }>;
      }>;
    }>;
  };
  type Picked = {
    planVersionId: string;
    inspectionType: string;
    materialCode: string;
    items: Array<{ itemCode: string; dataType: string; nominalValue?: number; standardText?: string }>;
  };
  let picked: Picked | undefined;
  for (const plan of plans.items) {
    for (const version of plan.versions ?? []) {
      const numeric = (version.items ?? []).filter(
        (item) => item.dataType === 'NUMERIC' && typeof item.nominalValue === 'number'
      );
      if (version.status === 'ACTIVE' && numeric.length > 0) {
        picked = {
          planVersionId: version.id,
          inspectionType: plan.inspectionType,
          materialCode: plan.materialCode,
          items: version.items ?? [],
        };
        break;
      }
    }
    if (picked) break;
  }
  assert.ok(picked, '真实库中应存在启用版本且含数值型指标的质检方案');
  console.log(`✔ 台账 total=${list.total}，选用方案版本 ${picked.planVersionId}`);

  // 5. 写路径：新建工单（关键回归点：检验项 id 必须符合契约 UUID）
  const stamp = Date.now();
  const batchNo = `HTTP-ACC-${stamp}`;
  const createRes = await fetch(`${BASE}/inspections`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      orderNo: `HTTP-ACC-INS-${stamp}`,
      inspectionType: picked.inspectionType,
      materialCode: picked.materialCode,
      materialName: 'HTTP 验收物料',
      batchNo,
      sampleQty: 5,
      planVersionId: picked.planVersionId,
    }),
  });
  const createText = await createRes.text();
  assert.equal(createRes.status, 201, `新建检验单应返回 201，实际 ${createRes.status} ${createText}`);
  const created = JSON.parse(createText) as {
    id: string;
    orderNo: string;
    status: string;
    items: Array<{ id: string; itemCode: string; result: string }>;
  };
  assert.equal(created.status, 'PENDING');
  for (const item of created.items) {
    assert.match(item.id, UUID, `检验项 id 必须为 UUID，实际 ${item.id}`);
    assert.equal(item.result, 'PENDING');
  }
  console.log(`✔ 新建工单 ${created.orderNo}，${created.items.length} 个检验项 id 全为 UUID`);

  // 6. 录入并提交判定（全量按标准基准值 -> PASSED）
  const submitRes = await fetch(`${BASE}/inspections/${created.id}/submit-measurements`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      items: picked.items.map((item) =>
        item.dataType === 'NUMERIC'
          ? { itemCode: item.itemCode, measuredVal: item.nominalValue as number }
          : { itemCode: item.itemCode, measuredText: (item.standardText ?? '合格').split(/[,，/|]/)[0] ?? '合格' }
      ),
      isDraft: false,
    }),
  });
  const submitText = await submitRes.text();
  assert.equal(submitRes.status, 200, `提交判定应返回 200，实际 ${submitRes.status} ${submitText}`);
  const submitted = JSON.parse(submitText) as { status: string; overallDecision?: string };
  assert.equal(submitted.status, 'PASSED');
  console.log(`✔ 实测录入并判定: status=${submitted.status} decision=${submitted.overallDecision}`);

  // 7. 放行关卡（前端放行页数据源）：未结单的合格工单仍应被 409 拦截
  const gateRes = await fetch(`${BASE}/release-gates/${batchNo}`, { headers: auth });
  const gateBody = (await gateRes.json()) as { code?: string; detail?: string };
  assert.equal(gateRes.status, 409, `未结单批次应被放行关卡拦截，实际 ${gateRes.status}`);
  assert.equal(gateBody.code, 'gate-inspecting');
  console.log(`✔ 放行关卡拦截: ${gateBody.code}`);

  // 8. 追溯拓扑（前端追溯页数据源）
  const traceRes = await fetch(`${BASE}/trace/LOT-2026-FN-01?maxDepth=10`, { headers: auth });
  assert.equal(traceRes.status, 200);
  const graph = (await traceRes.json()) as { nodes: unknown[]; edges: unknown[]; hasCycle: boolean };
  assert.equal(graph.hasCycle, false);
  assert.ok(graph.nodes.length >= 8, `追溯图谱节点数应 >= 8，实际 ${graph.nodes.length}`);
  console.log(`✔ 追溯图谱: nodes=${graph.nodes.length} edges=${graph.edges.length}`);

  // 9. CSV 导出（前端导出按钮数据源）
  const exportRes = await fetch(`${BASE}/export/inspections?format=csv`, { headers: auth });
  assert.equal(exportRes.status, 200);
  const csv = await exportRes.text();
  assert.match(csv.split('\n')[0] ?? '', /检验单号/);
  assert.ok(csv.includes(created.orderNo), '导出 CSV 应包含刚创建的工单号');
  console.log(`✔ CSV 导出: ${csv.split('\n').length} 行，含新建工单`);

  // 10. 主数据（前端主数据页数据源）
  const supplierRes = await fetch(`${BASE}/master-data/suppliers`, { headers: auth });
  assert.equal(supplierRes.status, 200);
  const suppliers = (await supplierRes.json()) as unknown[];
  assert.ok(suppliers.length > 0, '主数据供应商应有真实数据');
  console.log(`✔ 主数据供应商 ${suppliers.length} 条`);

  // 清理：删除本次验收创建的工单（审计/发件箱记录保留为留痕）
  const db = createDatabaseConnection();
  try {
    await db.deleteFrom('inspectionOrders').where('id', '=', created.id).execute();
    const left = await db
      .selectFrom('inspectionOrders')
      .select('id')
      .where('id', '=', created.id)
      .executeTakeFirst();
    assert.ok(!left, '验收创建的工单应已清理');
    console.log('✔ 清理验收数据完成');
  } finally {
    await db.destroy();
  }

  console.log('=== 真实 HTTP 验收全部通过 ===');
}

main().catch((err) => {
  console.error('真实 HTTP 验收失败:', err);
  process.exit(1);
});
