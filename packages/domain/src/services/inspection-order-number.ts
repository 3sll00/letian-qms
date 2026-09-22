/**
 * 检验单号 (docNo / order_no) 编号规则 —— 领域内唯一口径
 *
 * 规则：`{TYPE_PREFIX}-{YYYYMMDD}-{NNNN}`
 *   - TYPE_PREFIX：检验类型前缀，见 INSPECTION_ORDER_NO_PREFIX
 *   - YYYYMMDD：  建单日期（本地时区自然日）
 *   - NNNN：      当日同前缀流水号，4 位左补零，每日归零
 *
 * 示例：出货检验 (OQC_SH) 在建单日 2026-07-06 的第 1 单 => `OQC-SH-20260706-0001`
 *
 * 口径来源：docs/09-界面与开源组件.md §2.3、docs/16-出货检验OQC数据字段与接口打通设计.md §1
 * 以及种子数据 packages/infrastructure/src/seeds/data.ts 中已落库的历史单号形态。
 */

import { toLocalDayKey } from './day-key.js';

/** 无专属前缀的检验类型统一使用的中性前缀（保留历史 INS- 口径，避免存量单号语义漂移） */
export const DEFAULT_INSPECTION_ORDER_NO_PREFIX = 'INS';

/**
 * 检验类型 -> 单号前缀。
 *
 * 取值原则：**只登记已在库中有真实单号证据的前缀**（种子数据与既有历史单号），
 * 其余类型由类型编码机械推导（下划线换连字符），避免凭空发明缩写造成口径二义：
 *   - 有证据：OQC_SH=OQC-SH、OQC_SF=OQC-SF、OQC_HEAT=OQC-HT、OQC_MACH=OQC-MC
 *   - 机械推导：OQC_BLACK=OQC-BLACK、OQC_ZINC=OQC-ZINC ...
 *   - 无专属区分：IQC / IPQC_CT / IPQC_RL / IPQC_FN 统一 INS-（历史口径）
 */
export const INSPECTION_ORDER_NO_PREFIX: Readonly<Record<string, string>> = {
  IQC: DEFAULT_INSPECTION_ORDER_NO_PREFIX,
  IPQC_CT: DEFAULT_INSPECTION_ORDER_NO_PREFIX,
  IPQC_RL: DEFAULT_INSPECTION_ORDER_NO_PREFIX,
  IPQC_FN: DEFAULT_INSPECTION_ORDER_NO_PREFIX,
  OQC_SH: 'OQC-SH',
  OQC_SF: 'OQC-SF',
  OQC_HEAT: 'OQC-HT',
  OQC_MACH: 'OQC-MC',
  OQC_BLACK: 'OQC-BLACK',
  OQC_ZINC: 'OQC-ZINC',
  OQC_NICKEL: 'OQC-NICKEL',
  OQC_PHOSPH: 'OQC-PHOSPH',
  OQC_DACRO: 'OQC-DACRO',
};

/** 流水号上限：4 位定长，超出即当日该类型单号耗尽，必须显式报错而不是溢出成 5 位 */
export const MAX_INSPECTION_ORDER_NO_SEQ = 9999;

/** 解析检验类型对应的单号前缀；未知类型回落到中性前缀（fail-safe，不抛错以免阻断建单） */
export function resolveInspectionOrderNoPrefix(inspectionType: string): string {
  const mapped = INSPECTION_ORDER_NO_PREFIX[inspectionType];
  if (mapped) {
    return mapped;
  }
  return inspectionType.includes('_')
    ? inspectionType.replace(/_/g, '-')
    : DEFAULT_INSPECTION_ORDER_NO_PREFIX;
}

/**
 * 取建单日期键 (YYYYMMDD)。
 *
 * 实现委托给共用的 `toLocalDayKey`（本地时区自然日），与方案编码取号同口径；
 * 保留本函数名，既有调用方与文档无需变更。
 */
export function toInspectionOrderNoDayKey(date: Date): string {
  return toLocalDayKey(date);
}

/** 按 `{PREFIX}-{YYYYMMDD}-{NNNN}` 组装检验单号 */
export function formatInspectionOrderNo(
  inspectionType: string,
  dayKey: string,
  seq: number
): string {
  if (!/^\d{8}$/.test(dayKey)) {
    throw new Error(`ORDER_NO_DAY_KEY_INVALID: 建单日期键必须为 8 位数字 [${dayKey}]`);
  }
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_INSPECTION_ORDER_NO_SEQ) {
    throw new Error(
      `ORDER_NO_SEQ_INVALID: 流水号必须为 1..${MAX_INSPECTION_ORDER_NO_SEQ} 的整数 [${seq}]`
    );
  }
  return `${resolveInspectionOrderNoPrefix(inspectionType)}-${dayKey}-${String(seq).padStart(4, '0')}`;
}
