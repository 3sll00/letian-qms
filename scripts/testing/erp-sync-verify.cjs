/**
 * ERP -> QMS 只读同步端到端验收（最小闭环：`Ptype` -> `materials`）
 *
 * 回答四个问题（全部用真实执行 + 真实库对账，不看配置、不看代码猜）：
 *   ① 同步真能跑通吗？—— 跑 `pnpm erp:sync:ptype`（本地样例源，无需 ERP 连接），断言 inserted/updated/skipped；
 *   ② 落库值对不对？—— 逐字段与样例源对账（material_code / material_name / spec_model / unit / category_code）；
 *   ③ 重复跑会不会重复建行？—— 第二次必须 unchanged=3、表总行数不变（按 material_code upsert 幂等）；
 *   ④ 改了一个字段会不会更新？—— 第三轮用「改过名字」的临时样例跑，必须 updated=1 且库内值跟着变；
 * 另外断言 CLI 打印的**只读审计**：ERP 查询条数 + 「写语句在下发前即抛错中止」，以及样例源「未访问 ERP」。
 *
 * 前置：本机 PostgreSQL 已启动并迁移到最新（`pnpm db:local:start` / `pnpm db:migrate`）。
 * 本脚本**会写库**，但只碰 `material_code LIKE 'ERP-FIX-%'` 的同步测试行，跑完自动清理。
 * 用法：`pnpm verify:erp-sync`；退出码 0 = 通过，1 = 存在失败，3 = 前置不可达。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'packages', 'infrastructure', 'fixtures', 'erp-ptype.sample.json');
const TMP_FIXTURE = path.join(__dirname, '..', 'logs', 'erp-ptype.verify.tmp.json');
const DB_URL =
  process.env.DATABASE_URL || 'postgresql://letian_user:letian_secure_pass_2026@127.0.0.1:5433/letian_qms_db';
const PREFIX = 'ERP-FIX-%';

let checks = 0;
let failures = 0;
function check(name, ok, evidence) {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
  if (evidence !== undefined && evidence !== '') {
    console.log(`       evidence: ${evidence}`);
  }
}

/** pg 依赖解析：scripts/ 不是工作区包，回退到 pnpm 存储目录 */
function resolvePg() {
  try {
    return require('pg');
  } catch {
    const store = path.join(ROOT, 'node_modules', '.pnpm');
    const entry = fs
      .readdirSync(store)
      .filter((name) => name.startsWith('pg@'))
      .sort()
      .pop();
    if (entry === undefined) throw new Error('未找到 pg 依赖');
    return require(path.join(store, entry, 'node_modules', 'pg'));
  }
}

async function withDb(handler) {
  const { Client } = resolvePg();
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    return await handler(db);
  } finally {
    await db.end();
  }
}

function runSync(extraArgs = []) {
  // Windows 上经 cmd.exe 直起（spawnSync 不能直接执行 .cmd；`shell: true` 会触发 DEP0190 且参数转义不透明）
  const args = ['erp:sync:ptype', '--', ...extraArgs];
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/c', 'pnpm', ...args], { cwd: ROOT, encoding: 'utf8' })
      : spawnSync('pnpm', args, { cwd: ROOT, encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** 从 CLI 输出里取出那段 pretty-print 的 JSON 摘要（以单独一行的 `{` 起、单独一行的 `}` 止） */
function extractOutcome(stdout) {
  const start = stdout.indexOf('\n{\n');
  if (start < 0) return null;
  const end = stdout.indexOf('\n}\n', start);
  if (end < 0) return null;
  try {
    return JSON.parse(stdout.slice(start + 1, end + 2));
  } catch {
    return null;
  }
}

const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).map((row) => ({
  materialCode: row.userCode,
  materialName: row.fullName,
  specModel: row.standard,
  unit: row.unitName,
  categoryCode: row.parentCode,
}));

const mirrorRows = () =>
  withDb((db) =>
    db
      .query(
        'SELECT material_code, material_name, spec_model, unit, category_code FROM materials WHERE material_code LIKE $1 ORDER BY material_code',
        [PREFIX]
      )
      .then((res) => res.rows)
  );

const countMaterials = () =>
  withDb((db) => db.query('SELECT count(*)::int AS n FROM materials').then((res) => res.rows[0].n));

const deleteMirror = () =>
  withDb((db) =>
    db.query('DELETE FROM materials WHERE material_code LIKE $1', [PREFIX]).then((res) => res.rowCount)
  );

(async () => {
  console.log('=== ERP -> QMS 只读同步端到端验收（Ptype -> materials）===');

  // 前置 0：库可达
  try {
    await countMaterials();
  } catch (err) {
    console.error(`前置不可达：无法连接 PostgreSQL（${err.message}）—— 请先 pnpm db:local:start / pnpm db:migrate`);
    process.exit(3);
  }

  // 前置 1：清场，保证起点干净
  const cleanedBefore = await deleteMirror();
  check('起点干净：无残留 ERP-FIX 测试行（已清理旧行）', true, `清理 ${cleanedBefore} 行`);

  // ① 首轮：插入
  const baseTotal = await countMaterials();
  const run1 = runSync();
  const outcome1 = extractOutcome(run1.stdout);
  check(
    '① 同步执行成功且摘要可解析（退出码 0）',
    run1.status === 0 && outcome1 !== null,
    `exit=${run1.status} ${outcome1 === null ? run1.stderr.slice(0, 200) : ''}`
  );
  check(
    '① 首轮：3 行全部新增、无跳过',
    outcome1?.inserted === 3 && outcome1?.updated === 0 && outcome1?.skipped?.length === 0,
    JSON.stringify(outcome1)
  );

  // ② 逐字段对账
  const after1 = await mirrorRows();
  const mismatches = [];
  for (const want of expected) {
    const got = after1.find((row) => row.material_code === want.materialCode);
    if (got === undefined) {
      mismatches.push(`${want.materialCode}: 库内缺失`);
      continue;
    }
    for (const key of ['materialName', 'specModel', 'unit', 'categoryCode']) {
      const column = { materialName: 'material_name', specModel: 'spec_model', unit: 'unit', categoryCode: 'category_code' }[key];
      if (got[column] !== want[key]) {
        mismatches.push(`${want.materialCode}.${key}: 源=${want[key]} 库=${got[column]}`);
      }
    }
  }
  check('② 落库值与 ERP 源逐字段一致（3 行 x 4 字段）', after1.length === 3 && mismatches.length === 0, mismatches.join(' | '));
  for (const row of after1) {
    console.log(`       ${row.material_code} | ${row.material_name} | ${row.spec_model} | ${row.unit} | ${row.category_code}`);
  }

  // ③ 幂等：再跑一次
  const totalAfter1 = await countMaterials();
  const run2 = runSync();
  const outcome2 = extractOutcome(run2.stdout);
  const totalAfter2 = await countMaterials();
  check(
    '③ 重复同步幂等：inserted=0 / updated=0 / unchanged=3，且表总行数不变',
    run2.status === 0 && outcome2?.unchanged === 3 && outcome2?.inserted === 0 && totalAfter2 === totalAfter1,
    `unchanged=${outcome2?.unchanged} inserted=${outcome2?.inserted} total=${totalAfter1}->${totalAfter2}`
  );

  // ④ 更新路径：用改过字段的临时样例再跑
  const changedName = `${expected[0].materialName}（ERP 侧改名后）`;
  const tmpRows = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).map((row) =>
    row.userCode === expected[0].materialCode ? { ...row, fullName: changedName } : row
  );
  fs.mkdirSync(path.dirname(TMP_FIXTURE), { recursive: true });
  fs.writeFileSync(TMP_FIXTURE, JSON.stringify(tmpRows, null, 2), 'utf8');
  const run3 = runSync([`--fixture=${TMP_FIXTURE}`]);
  const outcome3 = extractOutcome(run3.stdout);
  const updatedRow = (await mirrorRows()).find((row) => row.material_code === expected[0].materialCode);
  check(
    '④ 源值变化触发 updated=1 且库内同步为新值',
    run3.status === 0 && outcome3?.updated === 1 && outcome3?.inserted === 0 && updatedRow?.material_name === changedName,
    `updated=${outcome3?.updated} 库内=${updatedRow?.material_name}`
  );

  // ⑤ 只读证据（CLI 审计输出）
  const auditOk =
    run1.stdout.includes('本次向 ERP 发出的查询') &&
    run1.stdout.includes('写语句在下发前即抛错中止') &&
    run1.stdout.includes('样例源未访问 ERP：本次没有建立任何 ERP 连接');
  check('⑤ 只读审计行齐全（ERP 查询计数 + 写语句拦截至下发前 + 样例源未连 ERP）', auditOk, '');

  // 清场：只删本次测试前缀的行
  const cleanedAfter = await deleteMirror();
  const residue = (await mirrorRows()).length;
  check('清场：ERP-FIX 测试行已全部删除，库内无残留', cleanedAfter === 3 && residue === 0, `删除 ${cleanedAfter} 行，剩余 ${residue} 行`);
  fs.rmSync(TMP_FIXTURE, { force: true });

  console.log('');
  console.log(`=== ${failures === 0 ? 'PASS' : 'FAIL'}：${checks - failures}/${checks} 通过 ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`${err.name === 'SyntaxError' ? '无法解析同步输出（stderr 见上）' : '探针异常'}：${err.message}`);
  process.exit(1);
});
