/**
 * 最近落库行速查（db:recent）—— 点完「保存」立刻确认数据是不是真进了 PostgreSQL。
 *
 * 用法：
 *   pnpm db:recent               # 最近 5 条检验单
 *   pnpm db:recent 20            # 最近 20 条
 *   pnpm db:recent 5 OQC_SH      # 只看某一类（order_type：IQC / IPQC_CT / IPQC_RL / IPQC_FN / OQC_SF / OQC_MACH / OQC_HEAT / OQC_SH）
 *
 * 判据：真入库的新行，`created_at` 会落在「现在」前几秒内（页面上点保存 -> 这里立刻能看到）；
 *      更新既有单时 `updated_at` 前移而 `created_at` 不动。
 * 与页面写入的是**同一个库**（DATABASE_URL 可覆盖）；本脚本**只读**，不做任何写操作。
 */
const fs = require('node:fs');
const path = require('node:path');

const DB_URL =
  process.env.DATABASE_URL || 'postgresql://letian_user:letian_secure_pass_2026@127.0.0.1:5432/letian_qms_db';

const positional = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const limit = Number.isFinite(Number(positional[0])) ? Number(positional[0]) : 5;
const orderType = positional[1];

/** pg 依赖解析：scripts/ 不是工作区包，回退到 pnpm 存储目录（与其它脚本同一写法） */
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
    if (entry === undefined) throw new Error('未找到 pg 依赖，无法查询数据库');
    return require(path.join(store, entry, 'node_modules', 'pg'));
  }
}

const pad = (value, width) => {
  const text = value === null || value === undefined ? '-' : String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
};

const ageOf = (date) => {
  if (date === null || date === undefined) return '-';
  const seconds = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s 前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min 前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h 前`;
  return `${Math.round(seconds / 86400)}d 前`;
};

(async () => {
  const { Client } = resolvePg();
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    const params = [];
    let where = '';
    if (orderType !== undefined) {
      params.push(orderType);
      where = `WHERE order_type = $${params.length}`;
    }
    params.push(limit);
    const rows = (
      await db.query(
        `SELECT order_no, order_type, material_code, status, judgment, created_at, updated_at
           FROM inspection_orders ${where}
          ORDER BY created_at DESC
          LIMIT $${params.length}`,
        params
      )
    ).rows;

    const totals = (
      await db.query('SELECT order_type, count(*)::int AS n FROM inspection_orders GROUP BY 1 ORDER BY 1')
    ).rows;

    console.log(`库：${DB_URL.replace(/:[^:@/]+@/, ':***@')}`);
    console.log(`现在：${new Date().toISOString()}${orderType ? `   过滤：order_type = ${orderType}` : ''}`);
    console.log('');
    console.log(
      pad('order_no', 24) + pad('order_type', 12) + pad('material_code', 22) + pad('status', 14) + pad('judgment', 12) + pad('created_at', 26) + 'age'
    );
    console.log('-'.repeat(126));
    for (const row of rows) {
      console.log(
        pad(row.order_no, 24) +
          pad(row.order_type, 12) +
          pad(row.material_code, 22) +
          pad(row.status, 14) +
          pad(row.judgment, 12) +
          pad(new Date(row.created_at).toISOString(), 26) +
          ageOf(row.created_at)
      );
    }
    console.log('');
    console.log('各类型总行数：' + totals.map((t) => `${t.order_type}=${t.n}`).join('  '));
    if (rows.length > 0) {
      console.log(`最新一行：${rows[0].order_no}（created_at ${ageOf(rows[0].created_at)}）`);
      console.log('若这条的 age 是「几秒前」，说明页面上的「保存」确实写进了这个库。');
    }
  } finally {
    await db.end();
  }
})().catch((err) => {
  console.error('查询失败：' + err.message);
  process.exit(1);
});
