/**
 * 修复兜底方案 `standardText` 误判（P0）
 * ───────────────────────────────────────────────────────────────────────────
 * 问题：
 *   兜底方案 `QP-IQC-GENERIC`（material_code='' & category_code=''，覆盖所有无专属/
 *   分类方案的物料）是迁移脚本手写硬插的种子数据，其 25 项指标的 `standardText`
 *   被统一填成了「按产品标准」，且 `acceptableValues` 未配置。
 *
 *   而判定器 `packages/domain/src/services/tolerance-evaluator.ts:72-82` 的逻辑是：
 *     TEXT / QUALITATIVE 项录入 measuredText 后，若 acceptableValues 为空，
 *     就回落拿 standardText 按 [,，/|] 拆分当「可接受值清单」逐字比对。
 *   于是候选值只有「按产品标准」一项 —— 检验员不管录入什么都会 return 'FAILED'。
 *
 *   这正是既有硬口径要防的事：**文字要求必须落 remark，standardText 留空**，
 *   无基准的文本项判定器返回 PENDING 挂起人工确认，绝不静默判不合格。
 *
 * 修法（与新建弹窗 CreatePlanModal 同口径，见其 :324-328）：
 *   把这些项的 `standardText` 删掉；「按产品标准」原样落到 `remark` 供检验员参考。
 *   只处理 dataType 为 TEXT / QUALITATIVE 且 standardText 恰好等于「按产品标准」的项，
 *   NUMERIC 项（走公差带判定）一律不动。
 *
 * 安全模型：默认 dryRun（只统计并抽样打印，不落库）；`--commit` 才真正 UPDATE。
 *   落库前先把被改行的原 items 全量备份到 `qms_standard_text_fix_backup`，
 *   ON CONFLICT DO NOTHING 保证重跑不覆盖首次备份（幂等，可回滚）。
 *
 * 运行（Git Bash，直接调 tsx，绕过 pnpm）：
 *   cd D:/乐天/letian-qms
 *   node node_modules/tsx/dist/cli.mjs packages/infrastructure/src/scripts/fix-generic-plan-standard-text.ts
 *   node node_modules/tsx/dist/cli.mjs packages/infrastructure/src/scripts/fix-generic-plan-standard-text.ts --commit
 */

import dotenv from 'dotenv';
dotenv.config();
import { sql } from 'kysely';
import { db } from '../database/connection.js';

/** 兜底方案种子数据里被误填进 standardText 的说明语 */
const PLACEHOLDER = '按产品标准';

/** 只有非数值项会回落比对 standardText，故只处理这两种 */
const TEXTUAL_DATA_TYPES = "('TEXT','QUALITATIVE')";

type TargetTable = 'inspection_plans' | 'inspection_orders';
const TARGET_TABLES: readonly TargetTable[] = ['inspection_plans', 'inspection_orders'];

interface CliArgs {
  commit: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  return { commit: argv.includes('--commit') };
}

/**
 * 注意：Kysely 默认把 snake_case 列别名映射为 camelCase，
 * 故这里按 `affectedRows` / `affectedItems` 取值（SQL 里仍写 affected_rows）。
 */
interface ImpactRow {
  tableName: string;
  affectedRows: number;
  affectedItems: number;
}

/** 「命中待修」的判定谓词，供统计/备份/更新三处复用，保证口径一致 */
function hitPredicate(alias: string): string {
  return `(
    ${alias}->>'dataType' IN ${TEXTUAL_DATA_TYPES}
    AND btrim(COALESCE(${alias}->>'standardText', '')) = '${PLACEHOLDER}'
    AND COALESCE(
          CASE WHEN jsonb_typeof(${alias}->'acceptableValues') = 'array'
               THEN jsonb_array_length(${alias}->'acceptableValues')
               ELSE 0 END, 0) = 0
  )`;
}

async function measure(runner: typeof db, table: TargetTable): Promise<ImpactRow> {
  const result = await sql<ImpactRow>`
    SELECT '${sql.raw(table)}'::text AS table_name,
           count(*)::int AS affected_rows,
           COALESCE(sum(t.hit), 0)::int AS affected_items
    FROM (
      SELECT (
        SELECT count(*)::int
        FROM jsonb_array_elements(p.items) AS e
        WHERE ${sql.raw(hitPredicate('e'))}
      ) AS hit
      FROM ${sql.raw(table)} AS p
      WHERE p.items IS NOT NULL
    ) AS t
    WHERE t.hit > 0
  `.execute(runner);
  return result.rows[0] ?? { tableName: table, affectedRows: 0, affectedItems: 0 };
}

async function backup(runner: typeof db, table: TargetTable): Promise<number> {
  const result = await sql<{ ok: number }>`
    INSERT INTO qms_standard_text_fix_backup (source_table, source_id, items_before)
    SELECT '${sql.raw(table)}'::text, p.id::text, p.items
    FROM ${sql.raw(table)} AS p
    WHERE p.items IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(p.items) AS e WHERE ${sql.raw(hitPredicate('e'))}
      )
    ON CONFLICT (source_table, source_id) DO NOTHING
    RETURNING 1 AS ok
  `.execute(runner);
  return result.rows.length;
}

async function applyFix(runner: typeof db, table: TargetTable): Promise<number> {
  const result = await sql<{ ok: number }>`
    UPDATE ${sql.raw(table)} AS p
    SET items = (
      SELECT COALESCE(jsonb_agg(s.patched ORDER BY s.ord), '[]'::jsonb)
      FROM (
        SELECT t.ord,
               CASE
                 WHEN ${sql.raw(hitPredicate('t.elem'))}
                 THEN jsonb_set(
                        t.elem - 'standardText',
                        '{remark}',
                        to_jsonb(
                          CASE WHEN btrim(COALESCE(t.elem->>'remark','')) = ''
                               THEN '${sql.raw(PLACEHOLDER)}'::text
                               ELSE t.elem->>'remark' END
                        ),
                        true
                      )
                 ELSE t.elem
               END AS patched
        FROM jsonb_array_elements(p.items) WITH ORDINALITY AS t(elem, ord)
      ) AS s
    ),
    updated_at = now()
    WHERE p.items IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(p.items) AS e WHERE ${sql.raw(hitPredicate('e'))}
      )
    RETURNING 1 AS ok
  `.execute(runner);
  return result.rows.length;
}

async function main(): Promise<void> {
  const { commit } = parseArgs(process.argv.slice(2));
  console.log(
    `[fix-standard-text] commit=${commit ? 'YES(真实写入)' : 'NO(仅预览)'} placeholder=${PLACEHOLDER}`,
  );

  if (commit) {
    await sql`
      CREATE TABLE IF NOT EXISTS qms_standard_text_fix_backup (
        id BIGSERIAL PRIMARY KEY,
        source_table TEXT NOT NULL,
        source_id TEXT NOT NULL,
        items_before JSONB NOT NULL,
        backed_up_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT qms_standard_text_fix_backup_uc UNIQUE (source_table, source_id)
      )
    `.execute(db);
    await sql`
      COMMENT ON TABLE qms_standard_text_fix_backup IS
      '修复兜底方案 standardText 误判前的 items 原始快照（2026-10-12，供回滚与审计）'
    `.execute(db);
    console.log('[fix-standard-text] 备份表就绪');
  }

  for (const table of TARGET_TABLES) {
    const before = await measure(db, table);
    console.log(
      `[fix-standard-text] ${table}: 待修 ${before.affectedRows} 行 / ${before.affectedItems} 项`,
    );

    if (commit && before.affectedRows > 0) {
      const backedUp = await backup(db, table);
      const updated = await applyFix(db, table);
      const after = await measure(db, table);
      console.log(
        `[fix-standard-text] ${table}: 已备份 ${backedUp} 行，已更新 ${updated} 行，残留待修 ${after.affectedRows} 行`,
      );
    }
  }

  if (!commit) {
    console.log('[fix-standard-text] 预览结束，未写入任何数据。确认无误后加 --commit 执行。');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('[fix-standard-text] 执行失败：', error);
    process.exit(1);
  });
