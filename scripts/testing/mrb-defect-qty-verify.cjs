/**
 * MRB「不合格数量」白盒 SQL 断言（`pnpm verify:mrb-defect-qty`，只读）
 *
 * 口径唯一真相：`docs/21` §13.2 / §14.3 / §14.7 ——
 *   **MRB 单与不合格台账的「不合格数量」恒取源检验单的 `fail_qty`**；
 *   台账分母取**抽样数** `sample_qty`（不是报检总数，docs/03 §2.3），比率随之重算。
 *
 * 为什么单独一个脚本：这条不变式跨三张表（`mrb_reviews` / `pending_mrb_items` / `inspection_orders`），
 * 界面与接口都只能看到各自那一列；只有直接对库做**白盒 SQL 断言**才能在「写路径再次漂移」的第一时间拦住
 * （§14.2 的缺陷恰恰是写路径的时序问题，页面上看不出来）。
 *
 * 断言（全部只读，不写库）：
 *   A. MRB 单：来源单已终判不合格且 `fail_qty > 0` 时，`defect_qty` 必须等于源单 `fail_qty`；
 *   B. 不合格台账：同上，且 `total_qty` 必须等于源单 `sample_qty`（分母口径）；
 *   C. 无孤儿：每条 MRB / 台账都能命中源单（按 `order_no` / `source_order_id`）；
 *   D. 比率自洽：`defect_rate` ≈ `fail_qty / sample_qty * 100`（保留 4 位）；
 *   E. 可比性清单：来源单「未终判 / 未判不合格」的行**没有口径可派生**，必须显式列出（默认提示，`--strict` 下失败）。
 *   F.（`--self-check`）**变异自检**：在一个事务里注入 5 处「口径被破坏」的假数据，验证 A~D 断言**必须变红**；
 *      结束即 `ROLLBACK`，库内零改动 —— 与 `docs/49` §4.6「注入缺陷、验证护栏必红」同一纪律。
 *
 * 退出码：0 = 断言 A~D 全过；1 = 存在违规（或 `--strict` 下 E 非空）；2 = 用法 / IO / 连库失败。
 */
const fs = require('node:fs');
const path = require('node:path');

const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://letian_user:letian_secure_pass_2026@127.0.0.1:5433/letian_qms_db';

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
    if (entry === undefined) throw new Error('未找到 pg 依赖，无法连接数据库');
    return require(path.join(store, entry, 'node_modules', 'pg'));
  }
}

const OUT_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(OUT_DIR, { recursive: true });
const LOG = path.join(OUT_DIR, 'mrb-defect-qty-verify.log');
fs.writeFileSync(LOG, '');
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
};

/** 断言 A：MRB 单的不合格数量 = 源单 fail_qty */
const SQL_MRB_MISMATCH = `
  SELECT m.mrb_no, m.source_order_no, m.defect_qty, o.fail_qty
    FROM mrb_reviews m
    JOIN inspection_orders o ON o.order_no = m.source_order_no
   WHERE o.judgment = 'FAILED'
     AND o.fail_qty > 0
     AND m.defect_qty IS DISTINCT FROM o.fail_qty
   ORDER BY m.mrb_no`;

/** 断言 B：台账的不合格数量 = 源单 fail_qty，且分母 = 源单 sample_qty */
const SQL_POOL_MISMATCH = `
  SELECT p.source_order_no, p.defect_qty, o.fail_qty, p.total_qty, o.sample_qty
    FROM pending_mrb_items p
    JOIN inspection_orders o ON o.id = p.source_order_id
   WHERE (o.judgment = 'FAILED' AND o.fail_qty > 0 AND p.defect_qty IS DISTINCT FROM o.fail_qty)
      OR p.total_qty IS DISTINCT FROM o.sample_qty
   ORDER BY p.source_order_no`;

/** 断言 C：孤儿（命不中源单） */
const SQL_MRB_ORPHAN = `
  SELECT m.mrb_no, m.source_order_no
    FROM mrb_reviews m
    LEFT JOIN inspection_orders o ON o.order_no = m.source_order_no
   WHERE o.id IS NULL
   ORDER BY m.mrb_no`;
const SQL_POOL_ORPHAN = `
  SELECT p.source_order_no
    FROM pending_mrb_items p
    LEFT JOIN inspection_orders o ON o.id = p.source_order_id
   WHERE o.id IS NULL
   ORDER BY p.source_order_no`;

/** 断言 D：比率自洽（保留 4 位，与 §14.7.1 的重算口径一致） */
const SQL_RATE_MISMATCH = `
  SELECT p.source_order_no, p.defect_rate AS stored, o.fail_qty, o.sample_qty
    FROM pending_mrb_items p
    JOIN inspection_orders o ON o.id = p.source_order_id
   WHERE o.judgment = 'FAILED'
     AND o.fail_qty > 0
     AND o.sample_qty > 0
     AND p.defect_rate IS DISTINCT FROM ROUND(o.fail_qty::numeric / o.sample_qty * 100, 4)
   ORDER BY p.source_order_no`;
/** 来源单未终判 / 未判不合格：没有 fail_qty 口径可派生（可比性清单） */
const SQL_UNCOMPARABLE = `
  SELECT m.mrb_no, m.source_order_no, m.defect_qty, o.status, o.judgment, o.fail_qty
    FROM mrb_reviews m
    LEFT JOIN inspection_orders o ON o.order_no = m.source_order_no
   WHERE o.id IS NOT NULL AND (o.judgment IS DISTINCT FROM 'FAILED' OR o.fail_qty IS NULL)
   ORDER BY m.mrb_no`;
const SQL_BASELINE = `
  SELECT (SELECT count(*) FROM inspection_orders)::int AS orders,
         (SELECT count(*) FROM mrb_reviews)::int AS mrb,
         (SELECT count(*) FROM pending_mrb_items)::int AS pool,
         (SELECT count(*) FROM mrb_reviews m JOIN inspection_orders o ON o.order_no = m.source_order_no
           WHERE o.judgment = 'FAILED')::int AS mrb_comparable,
         (SELECT count(*) FROM mrb_reviews)::int AS mrb_total`;

/**
 * 变异自检：逐条注入「口径被破坏」的假数据，验证对应断言**必红**。
 * 全程在一个事务内（`BEGIN` ... `ROLLBACK`），不落任何改动；只在 `--self-check` 时执行。
 */
async function runMutationSelfCheck(db) {
  const mutations = [
    {
      name: 'MRB defect_qty 漂移（+1）',
      sql: `UPDATE mrb_reviews SET defect_qty = defect_qty + 1
             WHERE mrb_no IN (SELECT m.mrb_no FROM mrb_reviews m
                                JOIN inspection_orders o ON o.order_no = m.source_order_no
                               WHERE o.judgment = 'FAILED' AND o.fail_qty > 0
                               ORDER BY m.mrb_no LIMIT 1)`,
      probe: SQL_MRB_MISMATCH,
    },
    {
      name: 'MRB 源单号指向不存在的单（孤儿）',
      sql: `UPDATE mrb_reviews SET source_order_no = 'NO-SUCH-ORDER'
             WHERE mrb_no = (SELECT mrb_no FROM mrb_reviews ORDER BY mrb_no LIMIT 1)`,
      probe: SQL_MRB_ORPHAN,
    },
    {
      name: '台账 defect_qty 漂移（+1）',
      sql: `UPDATE pending_mrb_items SET defect_qty = defect_qty + 1
             WHERE source_order_no = (SELECT source_order_no FROM pending_mrb_items ORDER BY source_order_no LIMIT 1)`,
      probe: SQL_POOL_MISMATCH,
    },
    {
      name: '台账分母退回报检总数（≠ 抽样数）',
      sql: `UPDATE pending_mrb_items SET total_qty = total_qty + 1
             WHERE source_order_no = (SELECT source_order_no FROM pending_mrb_items ORDER BY source_order_no LIMIT 1)`,
      probe: SQL_POOL_MISMATCH,
    },
    {
      name: '台账 defect_rate 未随分母重算（+1）',
      sql: `UPDATE pending_mrb_items SET defect_rate = defect_rate + 1
             WHERE source_order_no = (SELECT source_order_no FROM pending_mrb_items ORDER BY source_order_no LIMIT 1)`,
      probe: SQL_RATE_MISMATCH,
    },
  ];

  await db.query('BEGIN');
  try {
    let caught = 0;
    for (const mutation of mutations) {
      const applied = await db.query(mutation.sql);
      const hits = (await db.query(mutation.probe)).rows.length;
      const red = applied.rowCount > 0 && hits > 0;
      if (red) caught++;
      log(
        `  [变异自检] ${mutation.name}：注入 ${applied.rowCount} 行 -> 断言命中 ${hits} 行 ${
          red ? '（必红成立）' : '（**护栏没拦住**）'
        }`
      );
    }
    check('变异自检：5 处注入全部被断言拦下（证明断言不是空跑）', caught === mutations.length, {
      caught,
      total: mutations.length,
    });
  } finally {
    await db.query('ROLLBACK');
    log('  [变异自检] 事务已 ROLLBACK：库内零改动');
  }
}

(async () => {
  const strict = process.argv.slice(2).includes('--strict');
  const { Client } = resolvePg();
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    log(`--- MRB 不合格数量白盒断言（docs/21 §14.3 / §14.7）模式=${strict ? 'strict' : 'default'} ---`);
    const rows = async (sql) => (await db.query(sql)).rows;

    if (process.argv.slice(2).includes('--self-check')) {
      await runMutationSelfCheck(db);
    }

    const base = (await rows(SQL_BASELINE))[0];
    log(
      `基线：inspection_orders ${base.orders} 行 / mrb_reviews ${base.mrb} 行 / pending_mrb_items ${base.pool} 行 / 可比 MRB ${base.mrb_comparable} 行`
    );
    check('基线非空（样本量 > 0，避免空库"假通过"）', base.mrb > 0 && base.pool > 0, base);

    const mrbMismatch = await rows(SQL_MRB_MISMATCH);
    check('断言 A：MRB 单 defect_qty = 源单 fail_qty（全库 0 违规）', mrbMismatch.length === 0, mrbMismatch.slice(0, 10));
    check('断言 A 覆盖率：来源单已终判不合格的 MRB 全部纳入比对', base.mrb_comparable === base.mrb, {
      comparable: base.mrb_comparable,
      total: base.mrb,
    });

    const poolMismatch = await rows(SQL_POOL_MISMATCH);
    check('断言 B：台账 defect_qty = 源单 fail_qty 且 total_qty = 源单 sample_qty（分母口径）', poolMismatch.length === 0, poolMismatch.slice(0, 10));

    const mrbOrphan = await rows(SQL_MRB_ORPHAN);
    const poolOrphan = await rows(SQL_POOL_ORPHAN);
    check('断言 C：MRB / 台账均有可命中的源检验单（无孤儿）', mrbOrphan.length === 0 && poolOrphan.length === 0, {
      mrb: mrbOrphan.slice(0, 5),
      pool: poolOrphan.slice(0, 5),
    });

    const rateMismatch = await rows(SQL_RATE_MISMATCH);
    check('断言 D：defect_rate = round(fail_qty / sample_qty × 100, 4)', rateMismatch.length === 0, rateMismatch.slice(0, 10));

    const uncomparable = await rows(SQL_UNCOMPARABLE);
    log(
      `提示：来源单未终判 / 未判不合格的 MRB ${uncomparable.length} 条（无 fail_qty 口径可派生，见 docs/21 §14.7.2 走业务动作补做）`
    );
    for (const row of uncomparable) {
      log(`  - ${row.mrb_no} 来源 ${row.source_order_no} 状态 ${row.status} / 判定 ${row.judgment ?? '-'} / MRB 现值 ${row.defect_qty}`);
    }
    check('断言 E：可比性清单为空（或无 --strict 时仅提示）', strict ? uncomparable.length === 0 : true, {
      count: uncomparable.length,
      strict,
    });

    const failed = results.filter((r) => !r.ok);
    log(`\n[${failed.length === 0 ? 'PASS' : 'FAIL'}] MRB 不合格数量白盒断言：${results.length - failed.length}/${results.length}`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await db.end();
  }
})().catch((err) => {
  console.error(`[verify:mrb-defect-qty] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
