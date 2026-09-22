/**
 * 【委外加工单号】形态守门校验（只读，直连本地 PostgreSQL）
 *
 * 对应 docs/35 §2（M1）/ §3（M2）：`inspection_orders.outsource_no` 是 ERP `DlyndxSC.Number`
 * （VchType=181 委外加工单）的镜像列，形态口径的**单一真相**是
 * `packages/domain/src/services/outsource-reference.ts`（本脚本按同一规则判定；domain 侧有单测钉住）。
 *
 * 判定口径：
 *   EMPTY      NULL / 空串           —— 2023 两条历史行（ERP 无对账单，不补号），**不算失败**，但打印行数
 *   ERP_NUMBER WWJG-{YYYYMMDD}-{NNN} —— 合规（迁移 028 之后的库内形态）
 *   DERIVED    WWJG-{VchCode}        —— 前缀合规、流水段待 ERP 样例核对，**不算失败**，但打印行数
 *   LEGACY     WW-*                  —— 失败（迁移 028 之前的旧形态，库内应为 0 行）
 *   UNKNOWN    其它非空值            —— 失败（来源不明，需人工核对）
 *
 * 用法：node scripts/testing/outsource-no-check.cjs   （或 pnpm verify:outsource-no）
 * 环境变量：DATABASE_URL 覆盖默认连接串。
 */
const fs = require('node:fs');
const path = require('node:path');

/** pg 依赖解析：仓库用 pnpm 隔离式 node_modules，scripts/ 不是工作区包，回退到 .pnpm 存储目录 */
function resolvePg() {
  try {
    return require('pg');
  } catch {
    const store = path.join(__dirname, '..', '..', 'node_modules', '.pnpm');
    const entry = fs
      .readdirSync(store)
      .filter((name) => name.startsWith('pg@'))
      .sort()
      .pop();
    if (entry === undefined) throw new Error('未找到 pg 依赖，无法执行委外单号形态校验');
    return require(path.join(store, entry, 'node_modules', 'pg'));
  }
}

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://letian_user:letian_secure_pass_2026@127.0.0.1:5432/letian_qms_db';

const PREFIX = 'WWJG-';
const LEGACY_PREFIX = 'WW-';
/** 与 domain 的 outsource-reference.ts 同规则 */
const ERP_NUMBER_PATTERN = /^(\d{8})-(\d+)$/;
const DERIVED_PATTERN = /^(\d+)$/;
/** 委外七分类里的三类委外检验单（只有这些单才带委外加工单号） */
const OUTSOURCE_ORDER_TYPES = ['OQC_SF', 'OQC_MACH', 'OQC_HEAT'];

function classify(value) {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  if (raw === '') return { raw: '', shape: 'EMPTY' };
  if (raw.startsWith(PREFIX)) {
    const rest = raw.slice(PREFIX.length);
    if (ERP_NUMBER_PATTERN.test(rest)) return { raw, shape: 'ERP_NUMBER' };
    if (DERIVED_PATTERN.test(rest)) return { raw, shape: 'DERIVED' };
    return { raw, shape: 'UNKNOWN' };
  }
  if (raw.startsWith(LEGACY_PREFIX)) return { raw, shape: 'LEGACY' };
  return { raw, shape: 'UNKNOWN' };
}

(async () => {
  const { Client } = resolvePg();
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const { rows } = await client.query(
    'SELECT order_no, order_type, outsource_no FROM inspection_orders ORDER BY order_no'
  );

  const buckets = { EMPTY: [], ERP_NUMBER: [], DERIVED: [], LEGACY: [], UNKNOWN: [] };
  for (const row of rows) {
    const { shape } = classify(row.outsource_no);
    buckets[shape].push(row);
  }

  console.log('[委外加工单号形态校验] inspection_orders.outsource_no');
  console.log(`  总行数 ${rows.length}`);
  for (const shape of ['ERP_NUMBER', 'EMPTY', 'DERIVED', 'LEGACY', 'UNKNOWN']) {
    console.log(`  ${shape.padEnd(11)} ${buckets[shape].length}`);
  }
  if (buckets.DERIVED.length > 0) {
    console.log('  ↳ DERIVED（前缀已对齐、流水段待 ERP 样例核对，docs/34 §9 M1）：');
    for (const row of buckets.DERIVED) console.log(`      ${row.order_no} -> ${row.outsource_no}`);
  }
  // 空值分两类：委外类检验单的空号 = docs/34 §3 的两条 2023 历史行口径（不补号）；
  // 非委外类检验单（IQC / IPQC / 普通 OQC）本来就没有委外加工单，不算口径命中。
  const outsourceEmpty = buckets.EMPTY.filter((row) => OUTSOURCE_ORDER_TYPES.includes(row.order_type));
  if (outsourceEmpty.length > 0) {
    console.log('  ↳ EMPTY（委外类检验单：ERP 无委外加工单的历史导入行，口径=不补号，docs/34 §3）：');
    for (const row of outsourceEmpty) console.log(`      ${row.order_no} (${row.order_type})`);
  }
  console.log(
    `  （其余 EMPTY ${buckets.EMPTY.length - outsourceEmpty.length} 行为非委外类检验单，本列本就为空）`
  );
  const failures = [...buckets.LEGACY, ...buckets.UNKNOWN];
  if (failures.length > 0) {
    console.log('  ✗ 形态不合规（需人工核对来源）：');
    for (const row of failures) {
      console.log(`      ${row.order_no} -> ${String(row.outsource_no)} [${classify(row.outsource_no).shape}]`);
    }
    await client.end();
    console.error(`\n[FAIL] 委外加工单号形态校验未通过：${failures.length} 行不合规`);
    process.exit(1);
  }

  await client.end();
  console.log(
    `\n[PASS] 委外加工单号形态校验通过：ERP_NUMBER ${buckets.ERP_NUMBER.length} 行、` +
      `EMPTY ${buckets.EMPTY.length} 行（既定口径）、DERIVED ${buckets.DERIVED.length} 行（待 ERP 样例）`
  );
})().catch((err) => {
  console.error('[FAIL] 校验脚本执行失败：', err.message);
  process.exit(1);
});