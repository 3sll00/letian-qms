/**
 * 单据日期键 (YYYYMMDD) —— 领域内唯一口径
 *
 * 使用**本地时区自然日**：质量单据的"当日"以工厂所在地工作日为准，而非 UTC 日界。
 * 若用 `toISOString()`，东八区上午 08:00 之前会取到"昨天"，当日流水号会串到前一天，
 * 表现为"今天新建的单调号撞上昨天的号"。
 *
 * 检验单号（`inspection-order-number`）与质检方案编码（`inspection-plan-number`）
 * 两套编号规则共用本函数，保证"当日"口径完全一致。
 */

/** 取本地时区自然日键 (YYYYMMDD) */
export function toLocalDayKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}
