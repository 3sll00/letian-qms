/**
 * 质检方案编码 (plan_code) 编号规则 —— 领域内唯一口径
 *
 * 规则：`{PREFIX}-{YYYYMMDD}-{NNN}`
 *   - PREFIX：  固定 `QP`（Quality Plan）
 *   - YYYYMMDD：创建日期（本地时区自然日，见 `day-key`）
 *   - NNN：     当日流水号，3 位左补零，每日归零
 *
 * 示例：2026-07-06 创建的第 1 个方案 => `QP-20260706-001`
 *
 * 口径来源：设计稿与演示数据里方案库的实际编号形态
 * （docs/09-界面与开源组件.md §2.6、`apps/web/src/mocks/data.ts` 的 mockPlans `QP-20260706-001` ~ `012`）。
 * 取号机制对齐检验单号的流水号池做法（迁移 `012_inspection_order_no_sequences.ts`）：
 * 按 (前缀, 日期) 在数据库侧原子 upsert 分配，因此并发建方案不重号、事务回滚不跳号。
 *
 * 边界说明：库中既有的 `QP-{检验环节}-{物料}` 形态（如 `QP-IQC-304SS`，见种子数据）
 * 是**人工指定的语义化编码**，仍然完全合法，也不会被本规则改写；
 * 本规则只约束"服务端自动取号"这一条路径（调用方不传 `planCode` 时）。
 */

/** 方案编码统一前缀 */
export const INSPECTION_PLAN_CODE_PREFIX = 'QP';

/** 流水号上限：3 位定长，超出即当日方案号耗尽，必须显式报错而不是溢出成 4 位 */
export const MAX_INSPECTION_PLAN_CODE_SEQ = 999;

/** 按 `{PREFIX}-{YYYYMMDD}-{NNN}` 组装方案编码 */
export function formatInspectionPlanCode(dayKey: string, seq: number): string {
  if (!/^\d{8}$/.test(dayKey)) {
    throw new Error(`PLAN_CODE_DAY_KEY_INVALID: 创建日期键必须为 8 位数字 [${dayKey}]`);
  }
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_INSPECTION_PLAN_CODE_SEQ) {
    throw new Error(
      `PLAN_CODE_SEQ_INVALID: 流水号必须为 1..${MAX_INSPECTION_PLAN_CODE_SEQ} 的整数 [${seq}]`
    );
  }
  return `${INSPECTION_PLAN_CODE_PREFIX}-${dayKey}-${String(seq).padStart(3, '0')}`;
}
