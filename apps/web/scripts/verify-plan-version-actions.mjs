/**
 * 「质检方案设计」页方案版本口径校验（操作列｜编辑 + 停用）
 *
 * 口径唯一真相：`docs/17-检验录入界面说明与质检方案匹配口径.md` §7.5.6 / §7.5.8
 *
 * 为什么需要它：【停用】究竟打哪个版本行、**类型检查发现不了** ——
 * 若按钮可见性另起一套判断，就会出现「按钮给了但动作打空」（接口 400）
 * 或「动作可行却没有入口」。这里用真实前端源码把这两条口径钉死。
 *
 * 产品口径变更（本次）：删除「审核 / 进入草稿 / 升级版本」链路 —— 新建与导入的方案保存即启用，
 * 不再需要的方案直接停用。故这里只校验「取展示版本」与「停用是否可点」两件事。
 *
 * 运行：pnpm --filter @letian/web verify:plan-versions
 * 通过 Vite SSR 加载器跑**真实前端源码**（走与构建完全相同的 @letian/* 别名解析）。
 */
import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

let failed = 0;
function check(label, condition, extra) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${label}${extra === undefined ? '' : ` -> ${extra}`}`);
}

/** 造一个只带版本行集合的方案（其余字段与本用例无关，按契约给最小合法值） */
const plan = (...statuses) => ({
  planCode: 'QP-PROBE',
  planName: '操作列口径探针方案',
  inspectionType: 'IQC',
  versions: statuses.map((status, index) => ({
    id: `0000000${index}-0000-4000-8000-00000000000${index}`,
    planId: '00000000-0000-4000-8000-000000000001',
    versionNo: `V1.${index}`,
    status,
    items: [],
  })),
});

try {
  const { effectiveVersion, canDeactivatePlan } = await server.ssrLoadModule(
    '/src/lib/planVersionActions.ts'
  );

  console.log('展示版本选择：优先 ACTIVE，无 ACTIVE 时回落到最后一行');
  const enabledWithHistory = plan('INACTIVE', 'ACTIVE');
  check(
    '存在 ACTIVE 时取 ACTIVE（指标项 / 生效周期 / 创建人同一版本口径）',
    effectiveVersion(enabledWithHistory)?.status === 'ACTIVE',
    `实际 ${effectiveVersion(enabledWithHistory)?.status}`
  );
  check(
    '全 INACTIVE（已停用）时回落最后一行 V1.1',
    effectiveVersion(plan('INACTIVE', 'INACTIVE'))?.versionNo === 'V1.1',
    `实际 ${effectiveVersion(plan('INACTIVE', 'INACTIVE'))?.versionNo}`
  );
  check('空版本集合不抛错、返回 undefined', effectiveVersion(plan()) === undefined);

  console.log('\n【停用】可见性：按钮出现 ⟺ 停用接口真能执行（只接受 ACTIVE 版本）');
  check('已启用（含 ACTIVE 版本）-> 停用 ✅', canDeactivatePlan(enabledWithHistory));
  check(
    '已启用 + 历史版本并存 -> 停用 ✅',
    canDeactivatePlan(plan('ACTIVE', 'ACTIVE')) === true
  );
  check('已停用（全 INACTIVE）-> 停用 ❌', canDeactivatePlan(plan('INACTIVE', 'INACTIVE')) === false);
  check('仅草稿的历史数据 -> 停用 ❌', canDeactivatePlan(plan('DRAFT')) === false);

  console.log('\n异常载荷兜底：版本集合缺席时按服务端派生状态给按钮');
  check(
    'versions 缺席 + 服务端状态=已启用 -> 仍给【停用】',
    canDeactivatePlan({ planCode: 'QP-PROBE', planName: '空载荷', inspectionType: 'IQC', status: 'ENABLED' })
  );
  check(
    'versions 与 status 都缺席 -> 按已停用兜底，不给【停用】',
    canDeactivatePlan({ planCode: 'QP-PROBE', planName: '空载荷', inspectionType: 'IQC' }) === false
  );
} finally {
  await server.close();
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
