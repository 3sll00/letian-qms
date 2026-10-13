/**
 * 039 质检类型多选端到端回归（真实 PostgreSQL + app.inject 全链路）
 *
 * 断言口径：
 *   1. POST /plans 携带 inspectionTypes=[IQC, IPQC_CT] 落库成功，inspectionType=主类型；
 *   2. 激活版本后，GET /plans/match 用【次类型 IPQC_CT】也能命中同一方案；
 *   3. 主类型 IQC 命中依旧（向后兼容）；
 *   4. 集合外类型（OQC_SH）仍然 404 —— 全集边界不放行；
 *   5. 单类型方案（只传 inspectionType）缺省回落 [主类型]，行为与旧版一致；
 *   6. GET /plans?inspectionType=IPQC_CT 列表筛选能搜到多类型方案。
 *
 * 运行：tsx test/integration/plan-multi-type-link.test.ts（结束后清理本次新建方案）
 */
import assert from 'node:assert/strict';
import { buildApp } from '../../src/app';
import { createApiContainer, type ApiContainer } from '../../src/container';
import { generateTestToken } from '../../src/plugins/auth';

const QA = { userId: '11000000-0000-4000-8000-000000000001', userName: '张强', role: 'QA_MANAGER' };

async function main() {
  const container: ApiContainer = await createApiContainer();
  const app = await buildApp({ container, logger: false });
  const headers = {
    authorization: `Bearer ${generateTestToken(QA)}`,
    'content-type': 'application/json',
  };
  const createdPlanCodes: string[] = [];

  try {
    // ==== 1. 建一个双类型方案（主 IQC + 次 IPQC_CT），物料用种子里真实存在的编码 ====
    const materialCode = 'MAT-304SS-05';
    const item = {
      seq: 1,
      itemCode: 'TI-00002',
      name: '尺寸',
      dataType: 'NUMERIC',
      metricCategory: 'DIMENSION',
      standardText: '12.0',
      dif: '±0.1',
      checkWay: '卡尺测量',
      measurementTool: '游标卡尺',
      nominalValue: 12.0,
      upperTolerance: 0.1,
      lowerTolerance: 0.1,
      testItemCode: '00002',
      isMandatory: true,
    };
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers,
      payload: {
        planName: '多类型回归方案-尺寸',
        inspectionType: 'IQC',
        inspectionTypes: ['IQC', 'IPQC_CT'],
        materialCode,
        versions: [
          {
            versionNo: 'V1.0',
            samplingScheme: 'GB_T_2828',
            aqlLevel: 'II',
            strictness: 'NORMAL',
            items: [item],
          },
        ],
      },
    });
    assert.equal(createRes.statusCode, 201, `建多类型方案失败: ${createRes.body}`);
    const created = createRes.json();
    createdPlanCodes.push(created.planCode);
    assert.equal(created.inspectionType, 'IQC');
    assert.deepEqual(created.inspectionTypes, ['IQC', 'IPQC_CT'], 'DTO 应回传适用类型全集');
    console.log(`  ✓ 建单返回 inspectionTypes=${JSON.stringify(created.inspectionTypes)}`);

    // 落库直查：inspection_types 列 = 全集
    const row = await container.db
      .selectFrom('inspectionPlans')
      .select('inspectionTypes')
      .where('planCode', '=', created.planCode)
      .limit(1)
      .executeTakeFirst();
    assert.deepEqual(row?.inspectionTypes, ['IQC', 'IPQC_CT'], '物理列 inspection_types 应落全集');
    console.log('  ✓ inspection_plans.inspection_types 物理列 = 全集');

    // ==== 2. 激活版本，之后才可被匹配 ====
    const versionId = created.versions[0].id;
    const actRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/versions/${versionId}/status`,
      headers,
      payload: { action: 'ACTIVATE' },
    });
    assert.equal(actRes.statusCode, 200, `激活版本失败: ${actRes.body}`);
    console.log('  ✓ 版本已激活');

    // ==== 3. 次类型 IPQC_CT 命中同一方案（本次新增的核心能力） ====
    const matchIpqc = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/match?materialCode=${materialCode}&inspectionType=IPQC_CT`,
      headers,
    });
    assert.equal(matchIpqc.statusCode, 200, `次类型匹配失败: ${matchIpqc.body}`);
    const matchedIpqc = matchIpqc.json();
    assert.equal(matchedIpqc.planCode, created.planCode);
    assert.deepEqual(matchedIpqc.inspectionTypes, ['IQC', 'IPQC_CT']);
    console.log(`  ✓ 次类型 IPQC_CT 命中 ${matchedIpqc.planCode}（match 响应带 inspectionTypes）`);

    // ==== 4. 主类型 IQC 命中依旧 ====
    const matchIqc = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/match?materialCode=${materialCode}&inspectionType=IQC`,
      headers,
    });
    assert.equal(matchIqc.statusCode, 200, `主类型匹配失败: ${matchIqc.body}`);
    assert.equal(matchIqc.json().planCode, created.planCode);
    console.log('  ✓ 主类型 IQC 命中依旧（向后兼容）');

    // ==== 5. 集合外类型 OQC_SH 仍 404（全集边界不放行） ====
    const matchOut = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/match?materialCode=${materialCode}&inspectionType=OQC_SH`,
      headers,
    });
    assert.equal(matchOut.statusCode, 404, `集合外类型应 404，实得 ${matchOut.statusCode}`);
    console.log('  ✓ 集合外类型 OQC_SH 仍 404（不放行）');

    // ==== 6. 单类型方案缺省回落 [主类型] ====
    const singleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers,
      payload: {
        planName: '单类型回归方案',
        inspectionType: 'OQC_SH',
        materialCode,
        versions: [
          {
            versionNo: 'V1.0',
            samplingScheme: 'GB_T_2828',
            aqlLevel: 'II',
            strictness: 'NORMAL',
            items: [item],
          },
        ],
      },
    });
    assert.equal(singleRes.statusCode, 201, `建单类型方案失败: ${singleRes.body}`);
    const single = singleRes.json();
    createdPlanCodes.push(single.planCode);
    assert.deepEqual(single.inspectionTypes, ['OQC_SH'], '未传 inspectionTypes 应回落 [主类型]');
    console.log('  ✓ 单类型方案缺省回落 [主类型]');

    // ==== 7. 列表筛选 ?inspectionType=IPQC_CT 能搜到多类型方案 ====
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/plans?inspectionType=IPQC_CT&page=1&pageSize=50',
      headers,
    });
    assert.equal(listRes.statusCode, 200, `列表查询失败: ${listRes.body}`);
    const listBody = listRes.json();
    const found = (listBody.items ?? listBody.list ?? []).some(
      (plan: { planCode: string }) => plan.planCode === created.planCode
    );
    assert.ok(found, '多类型方案应出现在 IPQC_CT 筛选结果里');
    console.log('  ✓ GET /plans?inspectionType=IPQC_CT 能筛出多类型方案');

    console.log('=== 039 质检类型多选端到端回归全部通过 ===');
  } finally {
    if (createdPlanCodes.length > 0) {
      const del = await container.db
        .deleteFrom('inspectionPlans')
        .where('planCode', 'in', createdPlanCodes)
        .execute();
      console.log(`清理：删除本次新建方案 ${createdPlanCodes.length} 个方案（${del.length} 版本行）`);
    }
    await app.close();
    await container.db.destroy();
  }
}

void main();
