/**
 * 回补质检方案明细的 ERP 检验项目回链 `testItemCode`
 * ───────────────────────────────────────────────────────────────────────────
 * 背景：
 *   质检方案（检什么 / 怎么检 / 判定标准）主源在 QMS，但**检验项目的基础定义来自 ERP**
 *   （ERP `TestItem` 已镜像进 `test_items` 表，迁移 037）。两者靠 `testItemCode` 软回链。
 *
 *   实库现状：18 个方案里只有 `QP-DIN976-STUD-M24`（ERP 风格 `TI-*` 编码）6/6 带码，
 *   其余 17 个方案 0 项带码 —— 回链覆盖率近乎为零，两层名义打通、实际各干各的。
 *
 * 映射口径（QMS 判定域 metricCategory → ERP 检验项目大类）：
 *   APPEARANCE（外观）        → 00001 外观
 *   DIMENSION （尺寸）        → 00002 尺寸
 *   HARDNESS  （硬度）        → 00004 硬度实测值（5个）
 *   TENSILE_STRENGTH（拉伸）  → 00005 拉伸检测（单号）
 *   CHEMICAL_COMPOSITION      → 00006 光谱试验（单号）
 *   COATING_THICKNESS / MECHANICAL_PERFORMANCE → ERP 字典无对应，**不回链**
 *     （保留空值，避免脏编码污染 ERP 同步与指标统计 —— 与 plan-presets.ts 同口径）
 *
 *   特例优先：名称含「通止 / 通规 / 止规 / 实配」→ 00003 通止（螺纹实配属通止类）。
 *
 * 关键：**不硬编码 ERP 编码**。先读 `test_items` 现表，按名称关键词定位大类 code，
 *   ERP 侧调整字典编码/名称后重跑本脚本即可自动跟随，不会与 ERP 漂移。
 *
 * 安全模型：默认 dryRun（打印逐项映射预览，不落库）；`--commit` 才真正 UPDATE。
 *   落库前先把被改行的原 items 全量备份到 `qms_plan_test_item_code_backup`（幂等，可回滚）。
 *
 * 运行（Git Bash，直接调 tsx，绕过 pnpm）：
 *   cd D:/乐天/letian-qms
 *   node node_modules/tsx/dist/cli.mjs packages/infrastructure/src/scripts/backfill-plan-test-item-code.ts
 *   node node_modules/tsx/dist/cli.mjs packages/infrastructure/src/scripts/backfill-plan-test-item-code.ts --commit
 */

import dotenv from 'dotenv';
dotenv.config();
import { sql } from 'kysely';
import { db } from '../database/connection.js';

/** QMS 判定域 → ERP 字典名称关键词（按此在 test_items 里定位 code） */
const CATEGORY_TO_ERP_NAME_KEYWORD: Record<string, string> = {
  APPEARANCE: '外观',
  DIMENSION: '尺寸',
  HARDNESS: '硬度',
  TENSILE_STRENGTH: '拉伸',
  CHEMICAL_COMPOSITION: '光谱',
};

/** ERP 字典里没有对应大类的判定域：不回链，保持空 */
const UNMAPPED_CATEGORIES = new Set(['COATING_THICKNESS', 'MECHANICAL_PERFORMANCE']);

/** 名称含这些词的项统一归到「通止」（优先于 metricCategory 映射） */
const GO_NOGO_NAME_KEYWORDS = ['通止', '通规', '止规', '实配'];

interface TestItemRow {
  testItemCode: string;
  name: string;
}

interface PlanItem {
  seq: number;
  itemCode: string;
  name: string;
  metricCategory?: string;
  testItemCode?: string;
  [key: string]: unknown;
}

interface PlanRow {
  planCode: string;
  planName: string | null;
  items: PlanItem[] | null;
}

/**
 * 行标识一律用主键 id，不能用 plan_code。
 * 教训：库里存在重复 plan_code 的方案（如 QP-IQC-304SS 有 4 项与 3 项两个版本、
 * QP-OQC-SF-FAMILY-BOLT 同名 2 行），按 plan_code 分组回写会让同一行被
 * 另一个版本的明细覆盖，造成项目丢失。
 */
interface PlanTarget {
  id: string;
  planCode: string;
  planName: string | null;
  items: PlanItem[];
}

/** 从 test_items 读出现有 ERP 检验项目字典 */
async function loadTestItems(runner: typeof db): Promise<TestItemRow[]> {
  const result = await sql<{ test_item_code: string; name: string }>`
    SELECT test_item_code, name FROM test_items ORDER BY sort_no, test_item_code
  `.execute(runner);
  // Kysely 会把 snake_case 别名转驼峰，这里统一取原始列名并做兼容
  return result.rows.map((row) => {
    const anyRow = row as unknown as Record<string, string>;
    return {
      testItemCode: anyRow.testItemCode ?? anyRow.test_item_code ?? '',
      name: anyRow.name ?? '',
    };
  });
}

/** 按关键词在 ERP 字典里定位大类编码；定位不到返回 null（不回链） */
function resolveErpCode(
  dictionary: readonly TestItemRow[],
  item: PlanItem
): string | null {
  const name = (item.name ?? '').trim();

  if (GO_NOGO_NAME_KEYWORDS.some((keyword) => name.includes(keyword))) {
    const goNogo = dictionary.find((entry) => entry.name.includes('通止'));
    return goNogo?.testItemCode ?? null;
  }

  const category = item.metricCategory ?? '';
  if (UNMAPPED_CATEGORIES.has(category)) return null;

  const keyword = CATEGORY_TO_ERP_NAME_KEYWORD[category];
  if (keyword === undefined) return null;

  const hit = dictionary.find((entry) => entry.name.includes(keyword));
  return hit?.testItemCode ?? null;
}

interface PlanPatch extends PlanTarget {
  patchedItems: PlanItem[];
  changedCount: number;
  unresolvedCodes: string[];
}

/** 计算每行需要补码的项（不落库） */
async function planPatches(runner: typeof db): Promise<PlanPatch[]> {
  const dictionary = await loadTestItems(runner);
  const plans = await sql<{
    id: string;
    plan_code: string;
    plan_name: string | null;
    items: PlanItem[] | null;
  }>`
    SELECT id, plan_code, plan_name, items FROM inspection_plans ORDER BY plan_code
  `.execute(runner);

  const patches: PlanPatch[] = [];
  for (const row of plans.rows) {
    const anyRow = row as unknown as Record<string, unknown>;
    const id = String(anyRow.id);
    const planCode = String(anyRow.planCode ?? anyRow.plan_code);
    const planName = (anyRow.planName ?? anyRow.plan_name ?? null) as string | null;
    const items = (anyRow.items ?? []) as PlanItem[];

    let changedCount = 0;
    const unresolvedCodes: string[] = [];
    const patchedItems = items.map((item) => {
      if (item.testItemCode !== undefined && item.testItemCode !== '') return item;

      const code = resolveErpCode(dictionary, item);
      if (code === null) {
        if (item.metricCategory !== undefined) {
          unresolvedCodes.push(`${item.itemCode}(${item.metricCategory})`);
        }
        return item;
      }
      changedCount += 1;
      return { ...item, testItemCode: code };
    });

    if (changedCount > 0) {
      patches.push({ id, planCode, planName, items, patchedItems, changedCount, unresolvedCodes });
    }
  }
  return patches;
}

async function backupRow(runner: typeof db, table: string, id: string): Promise<void> {
  await sql`
    INSERT INTO qms_plan_test_item_code_backup (source_table, source_id, items_before)
    VALUES (${sql.lit(table)}::text, ${sql.lit(id)}::text,
            (SELECT items FROM ${sql.raw(table)} WHERE id = ${sql.lit(id)}::uuid))
    ON CONFLICT (source_table, source_id) DO NOTHING
  `.execute(runner);
}

async function main(): Promise<void> {
  const commit = process.argv.slice(2).includes('--commit');
  console.log(`[backfill-tic] commit=${commit ? 'YES(真实写入)' : 'NO(仅预览)'}`);

  const dictionary = await loadTestItems(db);
  console.log(
    `[backfill-tic] ERP 检验项目字典 ${dictionary.length} 条：` +
      dictionary.map((d) => `${d.testItemCode}=${d.name}`).join(' / '),
  );

  const patches = await planPatches(db);
  const totalChanged = patches.reduce((sum, p) => sum + p.changedCount, 0);
  console.log(`[backfill-tic] 待回补方案 ${patches.length} 个，待补码项 ${totalChanged} 项`);

  for (const patch of patches) {
    console.log(
      `  - ${patch.planCode} ${patch.planName ?? ''}：补 ${patch.changedCount} 项` +
        (patch.unresolvedCodes.length > 0
          ? `；ERP 无对应不回链：${patch.unresolvedCodes.join('、')}`
          : ''),
    );
  }

  if (commit && patches.length > 0) {
    await sql`
      CREATE TABLE IF NOT EXISTS qms_plan_test_item_code_backup (
        id BIGSERIAL PRIMARY KEY,
        source_table TEXT NOT NULL,
        source_id TEXT NOT NULL,
        items_before JSONB NOT NULL,
        backed_up_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT qms_plan_test_item_code_backup_uc UNIQUE (source_table, source_id)
      )
    `.execute(db);
    await sql`
      COMMENT ON TABLE qms_plan_test_item_code_backup IS
    '回补方案明细 testItemCode 前的 items 原始快照（2026-10-12，供回滚与审计）'
    `.execute(db);

    let updated = 0;
    for (const patch of patches) {
      await backupRow(db, 'inspection_plans', patch.id);
      await sql`
        UPDATE inspection_plans
        SET items = ${JSON.stringify(patch.patchedItems)}::jsonb, updated_at = now()
        WHERE id = ${sql.lit(patch.id)}::uuid
      `.execute(db);
      updated += 1;
    }
    console.log(`[backfill-tic] 已更新 ${updated} 行`);

    const remaining = await planPatches(db);
    console.log(
      `[backfill-tic] 回补后仍缺码的方案 ${remaining.length} 个 / ` +
        `${remaining.reduce((sum, p) => sum + p.changedCount, 0)} 项`,
    );
  }

  if (!commit) {
    console.log('[backfill-tic] 预览结束，未写入任何数据。确认映射无误后加 --commit 执行。');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('[backfill-tic] 执行失败：', error);
    process.exit(1);
  });
