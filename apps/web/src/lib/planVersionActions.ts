import type { InspectionPlan, InspectionPlanVersion } from '@letian/contracts';

/**
 * 「质检方案设计」页的方案版本选择口径（纯函数，便于用脚本钉死）。
 *
 * 口径唯一真相：`docs/17-检验录入界面说明与质检方案匹配口径.md` §7.5.6 / §7.5.8。
 *
 * 产品口径变更（本次）：方案**不再有「草稿 → 审批」链路** —— 新建/导入即启用，
 * 只保留「编辑」与「停用」两个操作。故这里只保留两件事：
 *   1. 取哪个版本展示（指标项 / 生效周期 / 创建人）；
 *   2. 什么时候给【停用】。
 * 「按钮出现 ⟺ 动作真能执行」依旧成立：停用接口（POST /plans/versions/:id/status,
 * action=DEACTIVATE）只接受 ACTIVE 版本，故 hasActiveVersion 就是它的守门条件。
 */

/** 生效版本：优先 `ACTIVE`，其次最后一个版本行（用于取指标项、生效周期与创建人） */
export function effectiveVersion(plan: InspectionPlan): InspectionPlanVersion | undefined {
  const versions = plan.versions ?? [];
  return versions.find((version) => version.status === 'ACTIVE') ?? versions[versions.length - 1];
}

/**
 * 该方案是否存在 `ACTIVE` 版本 —— 即【停用】是否可点。
 *
 * 版本集合缺席（异常载荷）时回落服务端派生状态（`status === 'ENABLED'`），
 * 与服务端「存在 ACTIVE 版本 = 已启用」的派生口径一致。
 */
export function canDeactivatePlan(plan: InspectionPlan): boolean {
  const versions = plan.versions ?? [];
  if (versions.length === 0) return (plan.status ?? 'DISABLED') === 'ENABLED';
  return versions.some((version) => version.status === 'ACTIVE');
}
