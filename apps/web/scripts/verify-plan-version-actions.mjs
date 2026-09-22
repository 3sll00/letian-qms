/**
 * 「质检方案设计」页操作列口径校验（TBD-14 / TBD-15 回归守门）
 *
 * 口径唯一真相：docs/17-检验录入界面说明与质检方案匹配口径.md §7.5.6 / §7.5.8 与 docs/09-界面与开源组件.md §2.6
 *
 * 为什么需要它：`审批` 究竟批哪个版本行，**类型检查发现不了** —— 升版后方案同时有 `ACTIVE`（旧版本）
 * 与 `DRAFT`（新草稿）时，若沿用 `effectiveVersion`（优先 `ACTIVE`）作审批目标，接口照样返回 200、
 * 列表照样刷新，只是新草稿永远批不下来。同理，若按钮可见性另起一套判断，就会出现
 * 「按钮给了但动作打空」或「动作可行却没有入口」。这里用真实前端源码把这两条口径钉死。
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
  const { effectiveVersion, hasDraftVersion, approvalTargetVersion, planVersionActionVisibility } =
    await server.ssrLoadModule('/src/lib/planVersionActions.ts');

  console.log('TBD-14 审批目标版本：必须打到待审批草稿');
  const enabledWithDraft = plan('ACTIVE', 'DRAFT');
  check(
    '「已启用 + 新草稿」时审批目标 = 草稿（不能是 ACTIVE 旧版本）',
    approvalTargetVersion(enabledWithDraft)?.status === 'DRAFT',
    `实际 ${approvalTargetVersion(enabledWithDraft)?.status}`
  );
  check(
    '同一集合下 effectiveVersion 仍取 ACTIVE（两个函数必须各司其职，不可互相替代）',
    effectiveVersion(enabledWithDraft)?.status === 'ACTIVE'
  );
  check('仅草稿时审批目标 = 草稿', approvalTargetVersion(plan('DRAFT'))?.status === 'DRAFT');
  check('仅 INACTIVE 时审批目标回落到最后一行（重新启用历史版本）', approvalTargetVersion(plan('INACTIVE'))?.versionNo === 'V1.0');
  check('空版本集合不抛错、返回 undefined', approvalTargetVersion(plan()) === undefined);

  console.log('\n操作列按钮可见性：按钮出现 ⟺ 动作真能执行');
  const onlyDraft = planVersionActionVisibility(plan('DRAFT'));
  check(
    '待审批行：审批 ✅ / 停用 ❌ / 启用 ❌ / 升版 ❌（已有草稿，升版必然 400）',
    onlyDraft.approve && !onlyDraft.deactivate && !onlyDraft.reactivate && !onlyDraft.upgrade
  );
  const enabledOnly = planVersionActionVisibility(plan('ACTIVE'));
  check(
    '已启用行：审批 ❌ / 停用 ✅ / 启用 ❌ / 升版 ✅',
    !enabledOnly.approve && enabledOnly.deactivate && !enabledOnly.reactivate && enabledOnly.upgrade
  );
  const enabledWithDraftActions = planVersionActionVisibility(enabledWithDraft);
  check(
    '已启用 + 新草稿（升版后的常态）：审批 ✅ / 停用 ✅ / 升版 ❌ —— 草稿必须有入口能被批掉',
    enabledWithDraftActions.approve && enabledWithDraftActions.deactivate && !enabledWithDraftActions.upgrade
  );
  const disabled = planVersionActionVisibility(plan('INACTIVE', 'INACTIVE'));
  check(
    '已停用行：启用 ✅ / 停用 ❌ / 审批 ❌ / 升版 ✅（TBD-15：全部停用后仍可重新启用）',
    disabled.reactivate && !disabled.deactivate && !disabled.approve && disabled.upgrade
  );
  check('hasDraftVersion 与可见性同源', hasDraftVersion(enabledWithDraft) === enabledWithDraftActions.approve);

  console.log('\n异常载荷兜底：版本集合缺席时不静默吞掉入口');
  const noVersions = planVersionActionVisibility({ planCode: 'QP-PROBE', planName: '空载荷', inspectionType: 'IQC', status: 'PENDING_APPROVAL' });
  check(
    'versions 缺席 + 服务端状态=待审批 -> 仍给【审批】（回落状态，入口不消失）',
    noVersions.approve && !noVersions.deactivate
  );
  const noVersionsNoStatus = planVersionActionVisibility({ planCode: 'QP-PROBE', planName: '空载荷', inspectionType: 'IQC' });
  check('versions 与 status 都缺席 -> 按已停用兜底给【启用】', noVersionsNoStatus.reactivate && !noVersionsNoStatus.approve);
} finally {
  await server.close();
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
