/**
 * QMS ↔ ERP 编码映射仓储（迁移 041 的 `qms_erp_code_mapping` 表）。
 *
 * 纯 DB 层：只读写映射表，不连 ERP、不依赖 erp-reads（避免循环依赖）。
 * ERP 自动解析逻辑放在脚本 `build-code-mapping.ts`，写表后再由本模块/回写脚本读取。
 *
 * 解析优先级（回写脚本）：本表命中 → 回退 erp-reads 实时反查 → 最后才用 override。
 */
import type { Kysely } from 'kysely';
import type { Database, QmsErpCodeMappingInsert } from '../database/schema.js';

export type MappingEntityType = 'MATERIAL' | 'SUPPLIER' | 'EMPLOYEE';
export type MappingSource = 'auto' | 'manual';

export interface CodeMappingRecord {
  entityType: MappingEntityType;
  /** materialCode / supplierCode / inspectorName（QMS 侧键） */
  qmsCode: string;
  /** ERP Ptype / Btype / Employee 的 typeId */
  erpTypeId: string;
  erpUserCode: string | null;
  erpFullName: string | null;
  source: MappingSource;
}

export interface UnmappedCodes {
  materials: string[];
  suppliers: string[];
  employees: string[];
}

/** 从映射表批量解析：qmsCode -> erpTypeId（仅返回命中的部分） */
export async function resolveErpTypeIds(
  db: Kysely<Database>,
  entityType: MappingEntityType,
  qmsCodes: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const codes = [...new Set(qmsCodes.map((c) => c.trim()).filter(Boolean))];
  if (codes.length === 0) return result;
  const rows = await db
    .selectFrom('qmsErpCodeMapping')
    .select(['qmsCode', 'erpTypeId'])
    .where('entityType', '=', entityType)
    .where('qmsCode', 'in', codes)
    .execute();
  for (const r of rows) result.set(r.qmsCode, r.erpTypeId);
  return result;
}

/** 单条解析（映射表内，不回退 ERP） */
export async function resolveErpTypeId(
  db: Kysely<Database>,
  entityType: MappingEntityType,
  qmsCode: string,
): Promise<string | null> {
  if (!qmsCode) return null;
  const row = await db
    .selectFrom('qmsErpCodeMapping')
    .select('erpTypeId')
    .where('entityType', '=', entityType)
    .where('qmsCode', '=', qmsCode.trim())
    .executeTakeFirst();
  return row?.erpTypeId ?? null;
}

/** 已存在的映射键集合（entityType|qmsCode），供回填脚本去重 */
export async function loadExistingKeys(db: Kysely<Database>): Promise<Set<string>> {
  const rows = await db.selectFrom('qmsErpCodeMapping').select(['entityType', 'qmsCode']).execute();
  return new Set(rows.map((r) => `${r.entityType}|${r.qmsCode}`));
}

/**
 * 批量写入映射（仅新增；entityType+qmsCode 冲突则跳过，不覆盖已有手工/自动映射）。
 * commit=false 时只返回将要写入的条数，不落库。
 */
export async function insertMappings(
  db: Kysely<Database>,
  recs: readonly CodeMappingRecord[],
  commit: boolean,
): Promise<number> {
  if (recs.length === 0) return 0;
  if (!commit) return recs.length;
  const values: QmsErpCodeMappingInsert[] = recs.map((r) => ({
    entityType: r.entityType,
    qmsCode: r.qmsCode,
    erpTypeId: r.erpTypeId,
    erpUserCode: r.erpUserCode,
    erpFullName: r.erpFullName,
    source: r.source,
  }));
  const res = await db
    .insertInto('qmsErpCodeMapping')
    .values(values)
    .onConflict((oc) => oc.columns(['entityType', 'qmsCode']).doNothing())
    .executeTakeFirst();
  return Number(res.numInsertedOrUpdatedRows ?? 0);
}

/**
 * 扫描 `inspection_orders` 去重编码，返回在映射表中【未命中】的清单（供手工补）。
 * 物料取 materialCode（非空）；供应商取 supplierCode（非空）；检验员取 inspectorName（非空）。
 */
export async function listUnmappedCodes(db: Kysely<Database>): Promise<UnmappedCodes> {
  const mapped = await loadExistingKeys(db);
  const hit = (t: MappingEntityType, c: string) => mapped.has(`${t}|${c.trim()}`);

  const matRows = await db
    .selectFrom('inspectionOrders')
    .select('materialCode')
    .distinct()
    .where('materialCode', 'is not', null)
    .execute();
  const supRows = await db
    .selectFrom('inspectionOrders')
    .select('supplierCode')
    .distinct()
    .where('supplierCode', 'is not', null)
    .execute();
  const empRows = await db
    .selectFrom('inspectionOrders')
    .select('inspectorName')
    .distinct()
    .where('inspectorName', 'is not', null)
    .execute();

  const materials = [...new Set(matRows.map((r) => (r.materialCode ?? '').trim()).filter(Boolean))].filter(
    (c) => !hit('MATERIAL', c),
  );
  const suppliers = [...new Set(supRows.map((r) => (r.supplierCode ?? '').trim()).filter(Boolean))].filter(
    (c) => !hit('SUPPLIER', c),
  );
  const employees = [...new Set(empRows.map((r) => (r.inspectorName ?? '').trim()).filter(Boolean))].filter(
    (c) => !hit('EMPLOYEE', c),
  );

  return { materials, suppliers, employees };
}
