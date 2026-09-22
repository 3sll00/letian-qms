import type { InspectionPlan, InspectionPlanVersion } from '@letian/contracts';

/**
 * 「质检方案设计」页**操作列**的版本选择口径（纯函数，便于用脚本钉死）。
 *
 * 口径唯一真相：`docs/17-检验录入界面说明与质检方案匹配口径.md` §7.5.6 / §7.5.8 与 `docs/09-界面与开源组件.md` §2.6。
 *
 * 为什么要单独成模块：`审批` 到底批哪个版本行，是**看代码看不出来、类型检查也发现不了**的口径
 * —— 选错了接口照样 200、界面照旧刷新，只是草稿永远不会生效。故与 `lib/planMatch.ts`
 * 同样以纯函数暴露，由 `scripts/verify-plan-version-actions.mjs` 直接加载前端源码断言。
 */

/** 生效版本：优先 `ACTIVE`，其次最后一个版本行（用于取指标项、生效周期与创建人） */
export function effectiveVersion(plan: InspectionPlan): InspectionPlanVersion | undefined {
  const versions = plan.versions ?? [];
  return versions.find((version) => version.status === 'ACTIVE') ?? versions[versions.length - 1];
}

/**
 * 该方案是否已有草稿版本。
 * 领域规则「同一方案禁止并发多个草稿」（`PLAN_DRAFT_ALREADY_EXISTS`，见
 * `packages/domain/src/models/inspection-plan.ts`）是升版的守门条件，前端按同一口径控制
 * 【升级版本】的可见性，避免给出一个必然 400 的按钮（服务端仍是权威校验）。
 */
export function hasDraftVersion(plan: InspectionPlan): boolean {
  return (plan.versions ?? []).some((version) => version.status === 'DRAFT');
}

/**
 * 审批目标版本：**优先待审批草稿** —— 【审批】的语义就是把草稿推成 `ACTIVE`
 * （领域状态机保证同方案旧 `ACTIVE` 自动转 `INACTIVE`，即"单激活态"）；
 * 没有草稿时才回落到生效版本（此时对已 `ACTIVE` 版本的重复审批是幂等放行）。
 *
 * **绝不能用 `effectiveVersion` 代替**：升版后方案会同时存在 `ACTIVE`（旧版本）与 `DRAFT`
 * （新草稿），而方案级状态仍是「已启用」；`effectiveVersion` 优先取 `ACTIVE`，于是【审批】
 * 只会对已生效版本做一次幂等启用 —— 界面无报错、接口 200、列表照常刷新，但**新草稿永远批不下来**。
 */
export function approvalTargetVersion(plan: InspectionPlan): InspectionPlanVersion | undefined {
  const versions = plan.versions ?? [];
  return versions.find((version) => version.status === 'DRAFT') ?? effectiveVersion(plan);
}

/** 操作列各按钮的可见性（保证「按钮出现 ⟺ 该动作真的可执行」）。 */
export interface PlanVersionActionVisibility {
  /** 【审批】：只要存在待审批草稿就给入口 —— 含「已启用 + 新草稿」（升版后的常态） */
  approve: boolean;
  /** 【停用】：存在 `ACTIVE` 版本才可停用 */
  deactivate: boolean;
  /** 【启用】：全部版本已停用（方案级已停用）时，版本行本身仍可重新启用 */
  reactivate: boolean;
  /** 【升级版本】：无草稿才可升版 */
  upgrade: boolean;
}

/**
 * 由**版本集合**推导按钮可见性（而非另算一份方案级状态），
 * 从而与 `approvalTargetVersion` / `effectiveVersion` 用同一个事实来源，杜绝"按钮给了、动作打空"。
 * 方案级状态本就由服务端按同一集合派生（有 `ACTIVE`=已启用，仅 `DRAFT`=待审批，否则已停用）。
 */
export function planVersionActionVisibility(plan: InspectionPlan): PlanVersionActionVisibility {
  const versions = plan.versions ?? [];
  if (versions.length === 0) {
    // 版本集合缺席（异常载荷）时回落服务端派生状态：宁可按状态给按钮，也不让入口凭空消失
    // （点下去仍会因缺少版本行标识而被显式拦下并提示刷新，而不是"没有按钮也没提示"）
    const status = plan.status ?? 'DISABLED';
    return {
      approve: status === 'PENDING_APPROVAL',
      deactivate: status === 'ENABLED',
      reactivate: status === 'DISABLED',
      upgrade: true,
    };
  }
  const hasActive = versions.some((version) => version.status === 'ACTIVE');
  const hasDraft = versions.some((version) => version.status === 'DRAFT');
  return {
    approve: hasDraft,
    deactivate: hasActive,
    reactivate: !hasActive && !hasDraft,
    upgrade: !hasDraft,
  };
}
