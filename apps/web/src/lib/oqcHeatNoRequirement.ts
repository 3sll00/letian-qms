/**
 * 出货检验「炉批号是否必填」开关（docs/47 TBD-03）。
 *
 * 背景：界面上的「原材料炉批号 (Heat No)」一直标着 ★，但**客户口径尚未定稿**
 * （TBD-03：出货检验的炉批号是否强制必填）。本轮按「默认必填」实现，同时刻意
 * **不把必填硬编码进提交校验**：判定一律经本模块，客户若确认「不必填」，
 * 只需把 `DEFAULT_OQC_HEAT_NO_REQUIRED` 改成 `false`（或在构建期设
 * `VITE_OQC_HEAT_NO_REQUIRED=false`），校验与界面 ★ 同时失效，回改成本最小。
 *
 * 为什么不直接做成后台配置项：本轮 P0 只打通主链，配置中心尚无「界面校验开关」这一
 * 类目；先落在**单一实现模块**里（与 docs/43、docs/44 的「单点收敛」做法一致），
 * 等口径定稿再决定是删除本模块还是升级成配置中心的一项。
 */

/** 未显式配置时的默认值：必填（与界面 ★ 一致，见 docs/47 §8 TBD-03 的建议默认） */
export const DEFAULT_OQC_HEAT_NO_REQUIRED = true;

/**
 * 是否必填。优先级：
 *   1. 构建期环境变量 `VITE_OQC_HEAT_NO_REQUIRED`（`false` / `0` / `no` / `off` = 非必填）；
 *   2. 未设置 / 无法解析时取默认值（true = 必填）。
 */
export function isOqcHeatNoRequired(): boolean {
  const raw = import.meta.env.VITE_OQC_HEAT_NO_REQUIRED;
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_OQC_HEAT_NO_REQUIRED;
  const normalized = raw.trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  return DEFAULT_OQC_HEAT_NO_REQUIRED;
}

/**
 * 提交前校验炉批号：返回阻断文案；通过则返回 `null`。
 * 同一份实现同时供「新单提交」与「只读回看」使用，避免两处口径漂移。
 */
export function validateOqcHeatNo(heatNo: string): string | null {
  if (!isOqcHeatNoRequired()) return null;
  if (heatNo.trim() !== "") return null;
  return "请先填写原材料炉批号 (Heat No)：出货检验按炉批号关联上游检验记录（委外热处理 / 来料检验）";
}

/** 界面星标：与校验同源，配置关闭后不再显示 ★（改显示「选填」） */
export function oqcHeatNoRequirementMarker(): string {
  return isOqcHeatNoRequired() ? "★" : "（选填）";
}