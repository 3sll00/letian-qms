/**
 * 委外加工单号（`inspection_orders.outsource_no`）形态口径 —— 单一真相（docs/35 §2）。
 *
 * 背景：该列是 ERP `DlyndxSC.Number`（VchType=181 委外加工单）的**镜像列**，不是 QMS 自编号。
 * 迁移 028 已把库内旧形态 `WW-*` 统一为 ERP 号段前缀 `WWJG-*`；本机无 ERP 连接，
 * `DlyndxSC.Number` 的**流水段真实形态**尚未核对（docs/34 §9 M1），因此这里把「前缀 / 形态判定」
 * 收敛为纯函数：
 *   - 业务代码不再各处手写 `'WWJG-' + ...` 字符串拼装；
 *   - 适配器镜像 ERP 值时只调 `resolveOutsourceNoFromErp`，兜底路径集中一处且有单测钉住；
 *   - 扫库校验脚本（`scripts/testing/outsource-no-check.cjs`）按同一函数判定形态。
 *
 * 形态取值：
 *   EMPTY      —— NULL / 空串：2023 两条历史行（ERP 无对账单，口径见 docs/34 §3），合规
 *   ERP_NUMBER —— `WWJG-{YYYYMMDD}-{NNN}`：迁移 028 后的库内形态，合规
 *   DERIVED    —— `WWJG-{VchCode}`：ERP 未给 `Number` 时适配器按已核对前缀兜底拼装，
 *                 前缀合规、流水段**待 ERP 样例核对**（`needsErpSampleConfirmation` 为 true）
 *   LEGACY     —— `WW-*`：迁移 028 之前的旧形态，库内应为 0 行
 *   UNKNOWN    —— 其它非空值：判定失败，需人工核对来源
 */

export const OUTSOURCE_NO_PREFIX = 'WWJG-';
export const LEGACY_OUTSOURCE_NO_PREFIX = 'WW-';

/** `WWJG-` 之后：8 位日期段 + `-` + 流水段 */
const ERP_NUMBER_PATTERN = /^(\d{8})-(\d+)$/;
/** `WWJG-` 之后：纯数字（适配器用 VchCode 兜底拼装的形态） */
const DERIVED_PATTERN = /^(\d+)$/;

export type OutsourceNoShape = 'EMPTY' | 'ERP_NUMBER' | 'DERIVED' | 'LEGACY' | 'UNKNOWN';

export interface ParsedOutsourceNo {
  raw: string;
  shape: OutsourceNoShape;
  /** 前缀之后的剩余部分（`WWJG-20260706-001` -> `20260706-001`）；无前缀识别时为原值或空串 */
  remainder: string;
  /** 日期段（仅 ERP_NUMBER 有值，其余为空串） */
  datePart: string;
  /** 流水段（ERP_NUMBER / DERIVED 有值，其余为空串） */
  sequencePart: string;
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

export function parseOutsourceNo(value: unknown): ParsedOutsourceNo {
  const raw = textOf(value);
  if (raw === '') return { raw: '', shape: 'EMPTY', remainder: '', datePart: '', sequencePart: '' };

  if (raw.startsWith(OUTSOURCE_NO_PREFIX)) {
    const remainder = raw.slice(OUTSOURCE_NO_PREFIX.length);
    const erp = ERP_NUMBER_PATTERN.exec(remainder);
    if (erp !== null) {
      return { raw, shape: 'ERP_NUMBER', remainder, datePart: erp[1] ?? '', sequencePart: erp[2] ?? '' };
    }
    const derived = DERIVED_PATTERN.exec(remainder);
    if (derived !== null) {
      return { raw, shape: 'DERIVED', remainder, datePart: '', sequencePart: derived[1] ?? '' };
    }
    return { raw, shape: 'UNKNOWN', remainder, datePart: '', sequencePart: '' };
  }

  if (raw.startsWith(LEGACY_OUTSOURCE_NO_PREFIX)) {
    return {
      raw,
      shape: 'LEGACY',
      remainder: raw.slice(LEGACY_OUTSOURCE_NO_PREFIX.length),
      datePart: '',
      sequencePart: '',
    };
  }

  return { raw, shape: 'UNKNOWN', remainder: raw, datePart: '', sequencePart: '' };
}

/** 前缀合规判定：EMPTY（历史行口径）与两种 `WWJG-` 形态合规，LEGACY / UNKNOWN 不合规 */
export function isConformingOutsourceNo(value: unknown): boolean {
  const shape = parseOutsourceNo(value).shape;
  return shape === 'EMPTY' || shape === 'ERP_NUMBER' || shape === 'DERIVED';
}

/** 是否属「前缀已对齐、流水段待 ERP 样例核对」的兜底形态（docs/34 §9 M1） */
export function needsErpSampleConfirmation(value: unknown): boolean {
  return parseOutsourceNo(value).shape === 'DERIVED';
}

/** ERP 未给单号时按 VchCode 拼装；VchCode 为空即返回 null（不编造单号） */
export function deriveOutsourceNoFromVchCode(vchCode: unknown): string | null {
  const code = textOf(vchCode);
  return code === '' ? null : OUTSOURCE_NO_PREFIX + code;
}

/**
 * ERP 行 -> 委外加工单号：`DlyndxSC.Number` **原样镜像**（绝不改写 ERP 单号），缺失时才走 VchCode 兜底。
 * 适配器 `OutsourceSevenCategoryAdapter` 的唯一入口。
 */
export function resolveOutsourceNoFromErp(row: { dispatchNo?: unknown; vchCode?: unknown }): string | null {
  const mirrored = textOf(row.dispatchNo);
  if (mirrored !== '') return mirrored;
  return deriveOutsourceNoFromVchCode(row.vchCode);
}