/**
 * ERP `TestItem` -> `test_items` 单向同步（ERP -> QMS，只写 QMS 镜像表）。
 *
 * 口径（与 ERP 检验方案表 T_Inf_PtypeCheckingSchemeDly.TITypeId 的参照表一致）：
 *   TestItem.TypeID        -> test_items.test_item_code
 *   TestItem.FullName      -> test_items.name
 *   TestItem.NamePY        -> test_items.name_py
 *   TestItem.TestStandard  -> test_items.test_standard
 *   TestItem.bBuy          -> test_items.applies_to_buy     （来料 IQC 环节可选）
 *   TestItem.bProduce      -> test_items.applies_to_produce （过程 IPQC·FQC 环节可选）
 *   TestItem.bConsign      -> test_items.applies_to_consign （委外·出货 OQC 环节可选）
 *
 * 幂等：按 test_item_code upsert（UNIQUE 约束），重复执行不产生新行。
 * 缺 typeId 的行跳过并记账，绝不写猜测值（与 ptype-sync 同一纪律）。
 */
import type { Kysely } from 'kysely';
import type { Database } from '../database/schema.js';
import type { ErpSource, ErpTestItemRow } from './erp-source.js';

export interface TestItemSyncOptions {
  limit?: number;
  dryRun?: boolean;
}

export interface TestItemSyncSkip {
  typeId: string;
  reason: string;
}

export interface TestItemSyncOutcome {
  source: string;
  dryRun: boolean;
  scanned: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: readonly TestItemSyncSkip[];
}

interface TestItemMirrorRow {
  testItemCode: string;
  name: string;
  namePy: string | null;
  testStandard: string | null;
  appliesToBuy: boolean;
  appliesToProduce: boolean;
  appliesToConsign: boolean;
  sortNo: number;
}

function toMirrorRow(row: ErpTestItemRow, sortNo: number): TestItemMirrorRow {
  return {
    testItemCode: row.typeId.trim(),
    name: row.fullName.trim() || row.typeId.trim(),
    namePy: row.namePy,
    testStandard: row.testStandard,
    appliesToBuy: row.bBuy,
    appliesToProduce: row.bProduce,
    appliesToConsign: row.bConsign,
    sortNo,
  };
}

export async function syncTestItemsToDb(
  db: Kysely<Database>,
  source: ErpSource,
  options: TestItemSyncOptions = {}
): Promise<TestItemSyncOutcome> {
  const rows = await source.fetchTestItems(options.limit ?? 500);
  const skipped: TestItemSyncSkip[] = [];
  const planned: TestItemMirrorRow[] = [];

  rows.forEach((row, index) => {
    if (row.typeId.trim() === '') {
      skipped.push({ typeId: String(index + 1), reason: '缺少 TypeID，无法落库' });
      return;
    }
    planned.push(toMirrorRow(row, index + 1));
  });

  const codes = planned.map((row) => row.testItemCode);
  const existing =
    codes.length === 0
      ? []
      : await db
          .selectFrom('testItems')
          .select([
            'testItemCode',
            'name',
            'namePy',
            'testStandard',
            'appliesToBuy',
            'appliesToProduce',
            'appliesToConsign',
          ])
          .where('testItemCode', 'in', codes)
          .execute();
  const byCode = new Map(existing.map((row) => [row.testItemCode, row]));

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const row of planned) {
    const prev = byCode.get(row.testItemCode);
    if (prev === undefined) {
      inserted++;
    } else if (
      prev.name === row.name &&
      prev.namePy === row.namePy &&
      prev.testStandard === row.testStandard &&
      prev.appliesToBuy === row.appliesToBuy &&
      prev.appliesToProduce === row.appliesToProduce &&
      prev.appliesToConsign === row.appliesToConsign
    ) {
      unchanged++;
      continue;
    } else {
      updated++;
    }

    if (options.dryRun === true) continue;
    await db
      .insertInto('testItems')
      .values({ ...row })
      .onConflict((oc) =>
        oc.column('testItemCode').doUpdateSet({
          name: row.name,
          namePy: row.namePy,
          testStandard: row.testStandard,
          appliesToBuy: row.appliesToBuy,
          appliesToProduce: row.appliesToProduce,
          appliesToConsign: row.appliesToConsign,
          sortNo: row.sortNo,
          updatedAt: new Date(),
        })
      )
      .execute();
  }

  return {
    source: source.name,
    dryRun: options.dryRun === true,
    scanned: rows.length,
    inserted,
    updated,
    unchanged,
    skipped,
  };
}
