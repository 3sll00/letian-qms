import assert from 'node:assert/strict';
import { createDatabaseConnection } from '@letian/infrastructure';

/**
 * MRB「不合格数量」白盒对账断言（只读 / 直连 PostgreSQL）
 *
 * 设计前提（重要）：**不假设库是静止的**。并行会话 / 探针 / 人工操作都可能改库，
 * 因此本断言只做**可重复的只读对账**，任何时刻跑都应得到该时刻的真实结论；
 * 它不写库、不做清理、不依赖「上次跑完之后没人动过」。
 *
 * 与同目录 `mrb-defect-qty-parity.test.ts` 的分工（互补，不重复）：
 * - `mrb-defect-qty-parity.test.ts`：**黑盒 / 写路径** —— 走 HTTP 建单 → 录值 → 终判，验「新写入是否写对」，自带造数与清理；
 * - **本文件**：**白盒 / 存量全库** —— 直接对账库里**已有全部行**，能抓历史脏数据与绕过写路径的裸 SQL 造数。
 *
 * 断言规则（5 条）：
 * - R1 源单可解析：每条 MRB 单 / 不合格台账条目都必须能命中源检验单（无孤儿行）
 * - R2 MRB 单「不合格数量」== 源检验单 `fail_qty`
 * - R3 不合格台账「不合格数量」== 源检验单 `fail_qty`
 * - R4 台账条目已关联 MRB 单时，两处「不合格数量」一致（关联指向的 MRB 单必须存在）
 * - R5 上述数量均为非负数（且不得为 NULL）
 *
 * 豁免口径（有据）：源单 `fail_qty` 为 `0`/`NULL` 视为「检验员未填写」，
 * 按 docs/21 §14 口径③ **保留既有值、不回退成 0** —— 该情形豁免 R2/R3 的严格相等，但其数量仍必须非 NULL。
 *
 * 豁免阈值（防豁免被滥用 —— 豁免一旦泛滥，R2/R3 就退化成空转）：
 * - `MRB_PARITY_EXEMPT_WARN`（默认 `0`）：豁免数 **> 该值** 即打印 ⚠ 告警（不失败），并**列出被豁免的行**供人工核查；
 * - `MRB_PARITY_EXEMPT_MAX`（默认不设）：显式设置后成为**硬上限**，豁免数 > 该值即失败（退出码 1），供 CI 收紧；
 * - **空转保护（默认生效，硬失败）**：某条规则的豁免数 == 检查数（100% 被豁免）时，该规则已无任何约束力 —— 直接判失败，
 *   不允许「全绿」建立在「什么都没检查」之上。
 *
 * 运行：
 *   pnpm verify:mrb-parity
 *   MRB_PARITY_EXEMPT_MAX=0 pnpm verify:mrb-parity
 * 前置：本机 PostgreSQL 已启动（`pnpm db:local:start`）且已执行迁移。退出码 0 = 通过；1 = 存在违反项或触发硬阈值。
 */

const MAX_DETAILS = 10;

/** 豁免告警阈值：豁免数 > 该值即告警（默认 0 —— 只要有豁免就提醒） */
const EXEMPT_WARN_THRESHOLD = readOptionalIntEnv('MRB_PARITY_EXEMPT_WARN') ?? 0;
/** 豁免硬上限：显式设置后生效（未设置 = 不因豁免数量失败，仅告警 + 空转保护） */
const EXEMPT_HARD_MAX = readOptionalIntEnv('MRB_PARITY_EXEMPT_MAX');

function readOptionalIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`环境变量 ${name} 必须是非负整数，实际收到：${raw}`);
  }
  return value;
}

/** 源单未填写不合格数量（0 或 NULL）—— 豁免严格相等，但要求 MRB / 台账侧仍有值 */
function isUnfilled(srcFailQty: number | null): boolean {
  return srcFailQty === null || Number(srcFailQty) === 0;
}

function fmt(value: number | string | null): string {
  return value === null ? 'NULL' : String(value);
}

interface Violation {
  readonly rule: string;
  readonly key: string;
  readonly detail: string;
}

/** 被豁免的行（必须可核查，不允许「静默豁免」） */
interface ExemptItem {
  readonly rule: string;
  readonly key: string;
  readonly detail: string;
}

interface RuleStat {
  readonly rule: string;
  readonly checked: number;
  readonly mismatch: number;
  readonly exempt: number;
  readonly note: string;
}

async function runMrbDefectQtyDbParityAssertions(): Promise<void> {
  console.log('--- MRB 不合格数量白盒对账断言（只读 / 直连 PostgreSQL）---');

  const db = createDatabaseConnection();

  try {
    const mrbRows = await db
      .selectFrom('mrbReviews as m')
      .leftJoin('inspectionOrders as o', 'o.orderNo', 'm.sourceOrderNo')
      .select([
        'm.id as mrbId',
        'm.mrbNo as mrbNo',
        'm.sourceOrderNo as sourceOrderNo',
        'm.defectQty as mrbQty',
        'o.id as srcId',
        'o.failQty as srcFailQty',
        'o.orderType as orderType',
      ])
      .execute();

    const poolRows = await db
      .selectFrom('pendingMrbItems as p')
      .leftJoin('inspectionOrders as o', 'o.id', 'p.sourceOrderId')
      .select([
        'p.id as poolId',
        'p.sourceOrderNo as sourceOrderNo',
        'p.sourceOrderId as sourceOrderId',
        'p.defectQty as poolQty',
        'p.mrbReviewId as mrbReviewId',
        'o.id as srcId',
        'o.failQty as srcFailQty',
      ])
      .execute();

    const violations: Violation[] = [];
    const exemptItems: ExemptItem[] = [];
    const warnings: string[] = [];
    const stats: RuleStat[] = [];

    // ===== R1 源单可解析（无孤儿行）=====
    const mrbOrphans = mrbRows.filter(row => row.srcId === null);
    const poolOrphans = poolRows.filter(row => row.srcId === null);
    for (const row of mrbOrphans) {
      violations.push({
        rule: 'R1',
        key: row.mrbNo,
        detail: `源检验单不存在：source_order_no = ${row.sourceOrderNo}`,
      });
    }
    for (const row of poolOrphans) {
      violations.push({
        rule: 'R1',
        key: row.sourceOrderNo,
        detail: `源检验单不存在：source_order_id = ${row.sourceOrderId}`,
      });
    }
    stats.push({
      rule: 'R1 源单可解析（无孤儿行）',
      checked: mrbRows.length + poolRows.length,
      mismatch: mrbOrphans.length + poolOrphans.length,
      exempt: 0,
      note: `MRB 单 ${mrbRows.length} 条 / 台账 ${poolRows.length} 条`,
    });

    // ===== R2 MRB 不合格数量 == 源单 fail_qty =====
    let r2Exempt = 0;
    let r2Checked = 0;
    let r2Mismatch = 0;
    for (const row of mrbRows) {
      if (row.srcId === null) continue; // 已由 R1 报出
      r2Checked += 1;
      if (isUnfilled(row.srcFailQty)) {
        r2Exempt += 1;
        exemptItems.push({
          rule: 'R2',
          key: row.mrbNo,
          detail: `源单 ${row.sourceOrderNo}（${row.orderType}）fail_qty = ${fmt(row.srcFailQty)} 视为未填写 ⇒ 豁免，MRB 侧保留 ${fmt(row.mrbQty)}`,
        });
        if (row.mrbQty === null) {
          r2Mismatch += 1;
          violations.push({ rule: 'R2', key: row.mrbNo, detail: '源单未填写不合格数量，但 MRB 侧为 NULL' });
        }
        continue;
      }
      if (Number(row.mrbQty) !== Number(row.srcFailQty)) {
        r2Mismatch += 1;
        violations.push({
          rule: 'R2',
          key: row.mrbNo,
          detail: `MRB 不合格数量 ${fmt(row.mrbQty)} ≠ 源单 fail_qty ${fmt(row.srcFailQty)}（源单 ${row.sourceOrderNo} / ${row.orderType}）`,
        });
      }
    }
    stats.push({
      rule: 'R2 MRB 不合格数量 = 源单 fail_qty',
      checked: r2Checked,
      mismatch: r2Mismatch,
      exempt: r2Exempt,
      note: '',
    });

    // ===== R3 台账不合格数量 == 源单 fail_qty =====
    let r3Exempt = 0;
    let r3Checked = 0;
    let r3Mismatch = 0;
    for (const row of poolRows) {
      if (row.srcId === null) continue; // 已由 R1 报出
      r3Checked += 1;
      if (isUnfilled(row.srcFailQty)) {
        r3Exempt += 1;
        exemptItems.push({
          rule: 'R3',
          key: row.sourceOrderNo,
          detail: `源单 fail_qty = ${fmt(row.srcFailQty)} 视为未填写 ⇒ 豁免，台账侧保留 ${fmt(row.poolQty)}`,
        });
        if (row.poolQty === null) {
          r3Mismatch += 1;
          violations.push({
            rule: 'R3',
            key: row.sourceOrderNo,
            detail: '源单未填写不合格数量，但台账侧为 NULL',
          });
        }
        continue;
      }
      if (Number(row.poolQty) !== Number(row.srcFailQty)) {
        r3Mismatch += 1;
        violations.push({
          rule: 'R3',
          key: row.sourceOrderNo,
          detail: `台账不合格数量 ${fmt(row.poolQty)} ≠ 源单 fail_qty ${fmt(row.srcFailQty)}`,
        });
      }
    }
    stats.push({
      rule: 'R3 台账不合格数量 = 源单 fail_qty',
      checked: r3Checked,
      mismatch: r3Mismatch,
      exempt: r3Exempt,
      note: '',
    });

    // ===== R4 台账 ↔ MRB 同源一致性（关联列 varchar ↔ uuid，在 JS 侧按字符串比对）=====
    const mrbQtyById = new Map<string, number | null>();
    for (const row of mrbRows) {
      mrbQtyById.set(String(row.mrbId), row.mrbQty === null ? null : Number(row.mrbQty));
    }
    let r4Checked = 0;
    let r4Mismatch = 0;
    for (const row of poolRows) {
      if (row.mrbReviewId === null) continue; // 尚未发起评审的台账条目不参与
      r4Checked += 1;
      if (!mrbQtyById.has(row.mrbReviewId)) {
        r4Mismatch += 1;
        violations.push({
          rule: 'R4',
          key: row.sourceOrderNo,
          detail: `台账关联的 MRB 单不存在：mrb_review_id = ${row.mrbReviewId}`,
        });
        continue;
      }
      const mrbQty = mrbQtyById.get(row.mrbReviewId) ?? null;
      if (mrbQty !== null && Number(row.poolQty) !== mrbQty) {
        r4Mismatch += 1;
        violations.push({
          rule: 'R4',
          key: row.sourceOrderNo,
          detail: `台账不合格数量 ${fmt(row.poolQty)} ≠ MRB 不合格数量 ${fmt(mrbQty)}（同一源单两处口径分叉）`,
        });
      }
    }
    stats.push({
      rule: 'R4 台账 ↔ MRB 同源数量一致',
      checked: r4Checked,
      mismatch: r4Mismatch,
      exempt: 0,
      note: `台账 ${poolRows.length} 条中已关联 MRB ${r4Checked} 条`,
    });

    // ===== R5 数量非负且非 NULL =====
    let r5Checked = 0;
    let r5Mismatch = 0;
    const checkQuantity = (rule: string, key: string, label: string, value: number | null): void => {
      r5Checked += 1;
      if (value === null || Number.isNaN(Number(value)) || Number(value) < 0) {
        r5Mismatch += 1;
        violations.push({ rule, key, detail: `${label} = ${fmt(value)}（必须为非负数值）` });
      }
    };
    for (const row of mrbRows) {
      checkQuantity('R5', row.mrbNo, 'MRB 不合格数量', row.mrbQty);
      if (row.srcId !== null) checkQuantity('R5', row.mrbNo, '源单 fail_qty', row.srcFailQty);
    }
    for (const row of poolRows) {
      checkQuantity('R5', row.sourceOrderNo, '台账不合格数量', row.poolQty);
    }
    stats.push({
      rule: 'R5 数量非负且非 NULL',
      checked: r5Checked,
      mismatch: r5Mismatch,
      exempt: 0,
      note: '',
    });

    // ===== 豁免阈值裁决（防豁免被滥用 + 防规则空转）=====
    const exemptRules = stats.filter(stat => stat.exempt > 0);
    for (const stat of exemptRules) {
      // ① 空转保护：整条规则被 100% 豁免 => 无任何约束力 => 硬失败
      if (stat.checked > 0 && stat.exempt === stat.checked) {
        violations.push({
          rule: stat.rule,
          key: '(整条规则)',
          detail: `检查 ${stat.checked} 项全部被豁免 —— 该规则已无约束力（空转），不允许判绿`,
        });
      }
      // ② 硬上限（仅在显式配置时生效）
      if (EXEMPT_HARD_MAX !== undefined && stat.exempt > EXEMPT_HARD_MAX) {
        violations.push({
          rule: stat.rule,
          key: '(豁免硬上限)',
          detail: `豁免数 ${stat.exempt} > 硬上限 MRB_PARITY_EXEMPT_MAX=${EXEMPT_HARD_MAX}`,
        });
      }
      // ③ 告警（不失败）
      if (stat.exempt > EXEMPT_WARN_THRESHOLD) {
        warnings.push(
          `${stat.rule}：豁免 ${stat.exempt} / 检查 ${stat.checked}（告警阈值 > ${EXEMPT_WARN_THRESHOLD}）—— 请人工核查被豁免行是否确为「源单未填写」`
        );
      }
    }

    // ===== 结果输出 =====
    for (const stat of stats) {
      const mark = stat.mismatch === 0 ? '✔' : '✗';
      const exemptText = stat.exempt > 0 ? ` / 豁免 ${stat.exempt}` : '';
      const noteText = stat.note.length > 0 ? `｜${stat.note}` : '';
      console.log(
        `${mark} ${stat.rule}：检查 ${stat.checked} 项，不一致 ${stat.mismatch}${exemptText}${noteText}`
      );
    }

    const totalExempt = stats.reduce((sum, stat) => sum + stat.exempt, 0);
    const totalChecked = stats.reduce((sum, stat) => sum + stat.checked, 0);

    console.log('\n【豁免审计】');
    console.log('  豁免口径：源单 fail_qty 为 0/NULL 视为「检验员未填写」，按 docs/21 §14 口径③ 保留既有值、不回退成 0');
    console.log(
      `  告警阈值：豁免数 > ${EXEMPT_WARN_THRESHOLD}（MRB_PARITY_EXEMPT_WARN）｜` +
        `硬上限：${EXEMPT_HARD_MAX === undefined ? '未设置（MRB_PARITY_EXEMPT_MAX）' : `豁免数 > ${EXEMPT_HARD_MAX} 判失败`}｜` +
        `空转保护：整条规则 100% 被豁免即判失败`
    );
    console.log(`  豁免计数：R2 = ${String(stats[1]?.exempt ?? 0)} / R3 = ${String(stats[2]?.exempt ?? 0)}（合计 ${totalExempt}）`);

    if (exemptItems.length === 0) {
      console.log('  豁免明细：无（R2/R3 全程按严格相等对账）');
    } else {
      console.log(`  豁免明细（最多展示 ${MAX_DETAILS} 条，完整计数见上）：`);
      for (const item of exemptItems.slice(0, MAX_DETAILS)) {
        console.log(`    [${item.rule}] ${item.key}：${item.detail}`);
      }
    }

    // 规模提示：全库 0 行时，R2/R3 的「通过」是空转通过，必须在日志里说清楚（CI 全新库属预期）
    if (r2Checked + r3Checked === 0) {
      warnings.push(
        '库内无可对账行（R2/R3 检查数均为 0）—— 本次运行未覆盖任何数据，属「空转通过」，不可据此判断数据质量（CI 全新迁移库属预期；真实环境出现则说明数据未落库）'
      );
    }

    if (warnings.length > 0) {
      console.log('\n⚠ 告警（不导致失败）：');
      for (const text of warnings) {
        console.log(`  ⚠ ${text}`);
      }
    }

    if (violations.length > 0) {
      console.error(`\n✗ 对账断言未通过：共 ${violations.length} 项不一致（明细最多展示 ${MAX_DETAILS} 条）`);
      for (const item of violations.slice(0, MAX_DETAILS)) {
        console.error(`  [${item.rule}] ${item.key}：${item.detail}`);
      }
      throw new Error(`MRB 不合格数量对账失败：${violations.length} 项不一致（检查 ${totalChecked} 项）`);
    }

    const warnSuffix = warnings.length > 0 ? `，${warnings.length} 条告警` : '';
    console.log(
      `\n=== MRB 不合格数量白盒对账断言全部通过（${stats.length} 条规则 / ${totalChecked} 项检查 / 豁免 ${totalExempt}${warnSuffix}）===`
    );
  } finally {
    await db.destroy();
  }
}

assert.ok(true);

runMrbDefectQtyDbParityAssertions()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('=== MRB 不合格数量白盒对账断言失败 ===');
    console.error(err);
    process.exit(1);
  });
