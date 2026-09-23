/**
 * Ptype -> materials 单向同步（ERP -> QMS，只写 QMS 本地镜像表）。
 *
 * 口径（与 docs/26/27/30 的主数据对齐一致）：
 *   `Ptype.UserCode` -> `materials.material_code`
 *   `Ptype.FullName` -> `materials.material_name`
 *   `Ptype.Standard` -> `materials.spec_model`
 *   `Ptype.Unit1`    -> `materials.unit`
 *   **分类不进 ERP**：`materials.category_code` 由 QMS 侧决定（料号前缀 / ERP 分类编码映射表 / 兜底参数），
 *   映射不到就**跳过该行并记账**，绝不写一个猜测值（既有 `sync-master-data.ts` 把全表硬编码成
 *   `FASTENER`，而库内合法分类是 `CAT-*`，属需要修掉的缺陷，见 docs/45 §3.2）。
 *
 * 幂等：按 `material_code` upsert（UNIQUE 约束），重复执行不产生新行、不覆盖无关字段。
 */
import type { Kysely } from 'kysely';
import type { Database } from '../database/schema.js';
import type { ErpPtypeRow, ErpSource } from './erp-source.js';

export interface PtypeSyncOptions {
  limit?: number;
  dryRun?: boolean;
  /** 整批兜底分类（CLI `--category=CAT-xxx`）：映射表未命中时使用 */
  defaultCategoryCode?: string | null;
  /** 分类映射：key 为「料号前缀」或「ERP 分类编码(parentCode)」，`*` 为兜底 */
  categoryMap?: Readonly<Record<string, string>>;
}

export interface PtypeSyncSkip {
  userCode: string;
  reason: string;
}

export interface PtypeSyncOutcome {
  source: string;
  dryRun: boolean;
  scanned: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: readonly PtypeSyncSkip[];
}

export interface MaterialMirrorRow {
  materialCode: string;
  materialName: string;
  specModel: string | null;
  unit: string;
  categoryCode: string;
}

/** 决定 ERP 物料落到哪个 QMS 分类：命中顺序 = parentCode 精确 -> 料号前缀（最长优先）-> `*` -> 兜底参数 */
export function resolveCategoryCode(row: ErpPtypeRow, options: PtypeSyncOptions): string | null {
  const map = options.categoryMap ?? {};
  if (row.parentCode !== null && map[row.parentCode] !== undefined) {
    return map[row.parentCode] ?? null;
  }
  const upper = row.userCode.toUpperCase();
  const prefixHit = Object.keys(map)
    .filter((key) => key !== '*' && upper.startsWith(key.toUpperCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (prefixHit !== undefined) {
    return map[prefixHit] ?? null;
  }
  return map['*'] ?? options.defaultCategoryCode ?? null;
}

export function toMirrorRow(row: ErpPtypeRow, categoryCode: string): MaterialMirrorRow {
  const code = row.userCode.trim();
  return {
    materialCode: code,
    materialName: (row.fullName ?? '').trim() || code,
    specModel: row.standard,
    unit: (row.unitName ?? '').trim() || '件',
    categoryCode,
  };
}

export async function syncPtypeToMaterials(
  db: Kysely<Database>,
  source: ErpSource,
  options: PtypeSyncOptions = {}
): Promise<PtypeSyncOutcome> {
  const rows = await source.fetchPtype(options.limit ?? 500);
  const skipped: PtypeSyncSkip[] = [];
  const planned: MaterialMirrorRow[] = [];

  for (const row of rows) {
    const categoryCode = resolveCategoryCode(row, options);
    if (categoryCode === null) {
      skipped.push({
        userCode: row.userCode,
        reason: '无法确定 category_code（未传兜底分类，映射表也未命中）—— 按口径跳过而不猜',
      });
      continue;
    }
    planned.push(toMirrorRow(row, categoryCode));
  }

  const codes = planned.map((row) => row.materialCode);
  const existing =
    codes.length === 0
      ? []
      : await db
          .selectFrom('materials')
          .select(['materialCode', 'materialName', 'specModel', 'unit', 'categoryCode'])
          .where('materialCode', 'in', codes)
          .execute();
  const byCode = new Map(existing.map((row) => [row.materialCode, row]));

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const row of planned) {
    const prev = byCode.get(row.materialCode);
    if (prev === undefined) {
      inserted++;
    } else if (
      prev.materialName === row.materialName &&
      prev.specModel === row.specModel &&
      prev.unit === row.unit &&
      prev.categoryCode === row.categoryCode
    ) {
      unchanged++;
      continue;
    } else {
      updated++;
    }

    if (options.dryRun === true) {
      continue;
    }
    await db
      .insertInto('materials')
      .values({ ...row })
      .onConflict((oc) =>
        oc.column('materialCode').doUpdateSet({
          materialName: row.materialName,
          specModel: row.specModel,
          unit: row.unit,
          categoryCode: row.categoryCode,
          updatedAt: new Date(),
        })
      )
      .execute();
  }

  return { source: source.name, dryRun: options.dryRun === true, scanned: rows.length, inserted, updated, unchanged, skipped };
}
