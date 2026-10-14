/**
 * 来料检验「原厂冶炼炉号是否必填」开关（docs/52 §4 方案 B 定稿）。
 *
 * 背景：ERP（管家婆）实测**没有任何炉号字段**（docs/52 §1.1），IQC 单的炉号物理上
 * 只存在于钢厂质保书（MTC）——检验员录入时必须手工填写，否则炉批号链路在 L2
 * （来料检验）这一级永久断流，出货检验的溯源关联与证书炉号栏全部落空。
 *
 * 实现与出货检验同款单点（`oqcHeatNoRequirement.ts`）：必填判定只在本模块做一次，
 * 若客户日后确认「IQC 可留空」，改 `DEFAULT_IQC_HEAT_NO_REQUIRED` 或构建期设
 * `VITE_IQC_HEAT_NO_REQUIRED=false` 即可整体收回，不必动表单提交链路。
 *
 * 生效范围：只对**提交动作**生效（存量历史单不回算，docs/48 TBD-12 纪律——
 * 旧单回看不受影响，但任何经表单提交/重新提交的 IQC 单都必须带炉号）。
 */

/** 未显式配置时的默认值：必填（docs/52 §4 方案 B：MTC 手工录入是唯一真实来源） */
export const DEFAULT_IQC_HEAT_NO_REQUIRED = true;

/**
 * 是否必填。优先级：
 *   1. 构建期环境变量 `VITE_IQC_HEAT_NO_REQUIRED`（`false` / `0` / `no` / `off` = 非必填）；
 *   2. 未设置 / 无法解析时取默认值（true = 必填）。
 */
export function isIqcHeatNoRequired(): boolean {
  const raw = import.meta.env.VITE_IQC_HEAT_NO_REQUIRED;
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_IQC_HEAT_NO_REQUIRED;
  const normalized = raw.trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  return DEFAULT_IQC_HEAT_NO_REQUIRED;
}

/**
 * 提交前校验原厂冶炼炉号：返回阻断文案；通过则返回 `null`。
 * 与出货检同一口径：校验点收敛在本模块，表单只调用不复制判定。
 */
export function validateIqcHeatNo(heatNo: string): string | null {
  if (!isIqcHeatNoRequired()) return null;
  if (heatNo.trim() !== "") return null;
  return "请先填写原厂冶炼炉号 (Heat No)：来料检验炉号取自供应商质保书(MTC)，是出货检验炉批号溯源的唯一上游来源";
}

/** 界面星标：与校验同源，配置关闭后不再显示 ★（改显示「选填」） */
export function iqcHeatNoRequirementMarker(): string {
  return isIqcHeatNoRequired() ? "★" : "（选填）";
}
