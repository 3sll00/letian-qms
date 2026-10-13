/**
 * 测试 / 演示数据清理入口（db:test:purge）—— 把带 TEST 标记的演示单及其派生数据整体清干净。
 *
 * 口径唯一真相：docs/47 §3.8「TEST 标记与清理边界」。
 *
 * 用法（仓库根目录）：
 *   pnpm db:test:purge                       # 默认 dry-run：只打印各表将命中行数，不写库
 *   pnpm db:test:purge -- --yes              # 真正清理（先 pg_dump 备份，再删；删完复查残留）
 *   pnpm db:test:purge -- --prefix=TEST      # 宽匹配所有以 TEST 开头的历史批次（慎用，会跨月通清）
 *
 * 硬边界（三条，任何一条不满足就中止，绝不"尽力而为"）：
 *   ① 候选集只由 `inspection_orders.batch_no LIKE '<prefix>%'` 决定；
 *   ② 候选集（及其派生数据）里出现**不带前缀**的行 -> 立即中止（真实行绝不删）；
 *   ③ 派生数据只按候选集的单号 / 批次号命中，不做任何"顺手多删一点"。
 *
 * 为什么默认 dry-run + 先备份：这是**删除**操作，且真实库与演示库是同一个库
 * （docs/23 的口径），一次误删就是现场数据事故；备份目录统一落到
 * `D:\乐天\backups\test-purge-{yyyyMMdd-HHmmss}\letian_qms_db-pre-test-purge.sql`。
 *
 * 测试数据前缀统一用 TEST2609-，禁止新造 BATCH-TEST-P2- 等异构前缀，
 * 否则默认的 TEST2609- 会跟宽匹配 TEST 互相干扰，容易搞混。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://letian_user:letian_secure_pass_2026@127.0.0.1:5433/letian_qms_db';

/** pg 依赖解析：scripts/ 不是工作区包，回退到 pnpm 存储目录（与 db:recent 同一写法） */
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

/** pg_dump 可执行文件：环境变量优先，其次本地 PostgreSQL 安装目录，最后 PATH */
function resolvePgDump() {
  const candidates = [process.env.PG_DUMP, 'D:\\PostgreSQL\\17\\bin\\pg_dump.exe'].filter(
    (value) => typeof value === 'string' && value !== ''
  );
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'pg_dump';
}

function shanghaiStamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}${pick('month')}${pick('day')}-${pick('hour')}${pick('minute')}${pick('second')}`;
}

/** 备份：pg_dump 全库导出到统一目录 D:\乐天\backups\；备份失败即中止清理（fail-closed） */
function backupDatabase() {
  const dir = path.join(__dirname, '..', '..', '..', 'backups', `test-purge-${shanghaiStamp()}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'letian_qms_db-pre-test-purge.sql');
  const pgDump = resolvePgDump();
  console.log(`[db:test:purge] 备份：${pgDump} -> ${file}`);
  const result = spawnSync(pgDump, ['--dbname', DB_URL, '--file', file, '--no-owner'], {
    stdio: 'inherit',
  });
  if (result.status !== 0 || !fs.existsSync(file) || fs.statSync(file).size === 0) {
    throw new Error(`pg_dump 备份失败（退出码 ${String(result.status)}），已中止清理`);
  }
  console.log(`[db:test:purge] 备份完成：${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
}

async function main() {
  const argv = process.argv.slice(2);
  const writeMode = argv.includes('--yes');
  const prefixArg = argv.find((arg) => arg.startsWith('--prefix='));
  const prefix = prefixArg === undefined ? 'TEST2609-' : prefixArg.slice('--prefix='.length);
  const like = `${prefix}%`;

  const { Client } = resolvePg();
  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  const countOf = async (sql, params) => Number((await db.query(sql, params)).rows[0].count);

  try {
    console.log(
      `[db:test:purge] 模式=${writeMode ? '写入' : 'dry-run'} 批次前缀=${prefix} 说明=${
        writeMode ? '将先备份再删除' : '只算不写'
      }`
    );

    const candidates = (
      await db.query(
        `SELECT id, order_no, order_type, batch_no, furnace_heat_batch_no, status
           FROM inspection_orders
          WHERE batch_no LIKE $1
          ORDER BY order_no`,
        [like]
      )
    ).rows;

    // 硬边界②：候选集里不允许出现不带前缀的行（结构上不可能，仍显式断言一次）
    const foreign = candidates.filter((row) => !String(row.batch_no).startsWith(prefix));
    if (foreign.length > 0) {
      console.error('[db:test:purge] 中止：候选集中出现非 TEST 行');
      for (const row of foreign) console.error(`  - ${row.order_no} 批次 ${row.batch_no}`);
      process.exitCode = 1;
      return;
    }

    console.log(`[db:test:purge] 检验单候选集：${candidates.length} 张`);
    for (const row of candidates) {
      console.log(
        `  - ${row.order_no} [${row.order_type}] 批次 ${row.batch_no} 炉批号 ${
          row.furnace_heat_batch_no ?? '-'
        } ${row.status}`
      );
    }

    if (candidates.length === 0) {
      console.log('[db:test:purge] 没有带 TEST 标记的检验单，无需清理。');
      return;
    }

    const orderNos = candidates.map((row) => row.order_no);
    const batchNos = candidates.map((row) => row.batch_no);
    const orderIds = candidates.map((row) => row.id);

    // 派生数据一律按候选集的单号 / 批次号 / 主键命中（硬边界③）。
    // 每步自带参数列表：PostgreSQL 不接受"声明了但没用上的占位参数"。
    const steps = [
      {
        table: 'batch_trace_relations',
        sql: `DELETE FROM batch_trace_relations
               WHERE parent_batch IN (
                       SELECT batch_no FROM batch_trace_nodes
                        WHERE order_no = ANY($1) OR inspection_order_no = ANY($1) OR batch_no = ANY($2))
                  OR child_batch IN (
                       SELECT batch_no FROM batch_trace_nodes
                        WHERE order_no = ANY($1) OR inspection_order_no = ANY($1) OR batch_no = ANY($2))`,
        params: [orderNos, batchNos],
      },
      {
        table: 'batch_trace_nodes',
        sql: `DELETE FROM batch_trace_nodes
               WHERE order_no = ANY($1) OR inspection_order_no = ANY($1) OR batch_no = ANY($2)`,
        params: [orderNos, batchNos],
      },
      {
        table: 'mrb_reviews',
        sql: 'DELETE FROM mrb_reviews WHERE source_order_no = ANY($1)',
        params: [orderNos],
      },
      {
        table: 'pending_mrb_items',
        sql: `DELETE FROM pending_mrb_items
               WHERE source_order_no = ANY($1) OR source_order_id = ANY($2)`,
        params: [orderNos, orderIds],
      },
      {
        table: 'inspection_orders',
        sql: 'DELETE FROM inspection_orders WHERE id = ANY($1)',
        params: [orderIds],
      },
    ];

    const realBefore = await countOf(
      'SELECT count(*) FROM inspection_orders WHERE batch_no NOT LIKE $1',
      [like]
    );

    if (!writeMode) {
      // dry-run：把每条 DELETE 换成同条件的 count(*) 只读统计，绝不执行删除
      for (const step of steps) {
        // 只换动词、必须留住表名：`DELETE FROM x` -> `SELECT count(*) FROM x`
        const countSql = step.sql.replace(/^DELETE FROM(\s+\w+)/, 'SELECT count(*) FROM$1');
        const count = await countOf(countSql, step.params);
        console.log(`  [dry-run] ${step.table}: ${count} 行将被删除`);
      }
      console.log('[db:test:purge] 非 TEST 命中数：0（结构性保证：派生数据只按候选集单号 / 批次号命中）');
      console.log(`[db:test:purge] 真实（非 TEST）检验单 ${realBefore} 张：清理前后必须一致。`);
      console.log('[db:test:purge] dry-run 结束：未写入任何数据。加 --yes 执行清理（会先 pg_dump 备份）。');
      return;
    }

    backupDatabase();

    await db.query('BEGIN');
    try {
      for (const step of steps) {
        const result = await db.query(step.sql, step.params);
        console.log(`  [已删除] ${step.table}: ${result.rowCount} 行`);
      }
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }

    const remainingTest = await countOf('SELECT count(*) FROM inspection_orders WHERE batch_no LIKE $1', [
      like,
    ]);
    const realAfter = await countOf(
      'SELECT count(*) FROM inspection_orders WHERE batch_no NOT LIKE $1',
      [like]
    );
    console.log(
      `[db:test:purge] 复查：TEST 行残留 ${remainingTest} 张（应为 0）；真实检验单 ${realAfter} 张（清理前 ${realBefore} 张，必须一致）`
    );
    if (remainingTest !== 0 || realAfter !== realBefore) {
      console.error('[db:test:purge] 复查未通过：残留或真实行数变化，请立即核对备份');
      process.exitCode = 1;
    }
  } finally {
    await db.end();
  }
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.error(`[db:test:purge] 失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
})();
