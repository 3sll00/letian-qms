/** 设备编码序号上限：CHAR(6) 顺序号，最大 999999 */
export const MAX_EQUIPMENT_SEQ = 999999;

/**
 * 设备台账主码：6 位零填充顺序编码（000001 起）。
 *
 * 纯格式化函数；序号由 qms_equipment_code_sequences 流水池原子发号（迁移 049），
 * 与检验单号/方案编码（inspection-order-number / inspection-plan-number）同构。
 */
export function formatEquipmentCode(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_EQUIPMENT_SEQ) {
    throw new Error(`设备编码序号非法：${seq}（须为 1~${MAX_EQUIPMENT_SEQ} 的整数）`);
  }
  return String(seq).padStart(6, '0');
}
