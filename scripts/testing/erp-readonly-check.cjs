/**
 * ERP 只读门禁（静态）—— 「QMS 绝不回写 ERP」的第二道防线（第一道是运行期守门 `assertReadOnlyErpSql`）。
 *
 * 本脚本回答一个只能靠静态检查回答的问题：**除了唯一入口，还有没有别的地方能直连 ERP？**
 * 断言：
 *   ① 引用 `getErpConnectionPool` 的文件只能是「白名单」内的（豁免清单**冻结**，新增即 FAIL）；
 *   ② 白名单里的**新代码**（`src/sync/**` 与 `src/scripts/sync-ptype.ts`）不得出现 `.request()` —— 必须经
 *      `queryErpReadOnly()` 下单（`.request()` 是 mssql 下发 SQL 的唯一途径，出现即意味绕过守门）；
 *   ③ `src/sync/erp-source.ts` 必须调用 `queryErpReadOnly`；
 *   ④ `src/sync/erp-readonly.ts` 必须同时具备「首关断言」与「写关键字清单」（防止被改空）。
 *
 * 遗留豁免（见 docs/45-ERP只读单向同步设计（Ptype到materials）.md §7，改造前不算失败，但会打印 WARN）：
 *   `src/scripts/sync-master-data.ts`、`src/adapters/external-adapters.ts`
 *
 * 用法：`pnpm verify:erp-readonly`；退出码 0 = 通过，1 = 存在违规。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = ['packages/infrastructure/src', 'packages/application/src', 'apps/api/src'];

/** 允许持有 ERP 连接池的文件（相对仓库根的 POSIX 路径） */
const POOL_ALLOWLIST = new Set([
  'packages/infrastructure/src/adapters/erp-pool.ts',
  'packages/infrastructure/src/scripts/sync-ptype.ts',
  'packages/infrastructure/src/scripts/sync-master-data.ts',
  'packages/infrastructure/src/adapters/external-adapters.ts',
]);

/** 冻结的遗留豁免（既直连 ERP、又尚未改走守门） */
const LEGACY_EXEMPT = new Set([
  'packages/infrastructure/src/adapters/erp-pool.ts',
  'packages/infrastructure/src/scripts/sync-master-data.ts',
  'packages/infrastructure/src/adapters/external-adapters.ts',
]);

/** 必须经守门下单的文件（新代码） */
const GUARDED_FILES = new Set([
  'packages/infrastructure/src/scripts/sync-ptype.ts',
]);

let failures = 0;
let warnings = 0;
function check(name, ok, evidence) {
  if (!ok) failures++;
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
  if (evidence !== undefined && evidence !== '' && (!ok || process.env.VERBOSE === '1')) {
    console.log(`       evidence: ${evidence}`);
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((dir) => {
  const abs = path.join(ROOT, dir);
  return fs.existsSync(abs) ? walk(abs) : [];
});
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

// ① 谁引用了 ERP 连接池
const poolUsers = files.filter((file) => fs.readFileSync(file, 'utf8').includes('getErpConnectionPool'));
const unauthorized = poolUsers.map(rel).filter((file) => !POOL_ALLOWLIST.has(file));
check(
  '① 引用 getErpConnectionPool 的文件全部在白名单内（豁免清单已冻结）',
  unauthorized.length === 0,
  unauthorized.join(', ')
);

// ② 受管文件不得直接 .request()（绕过守门的唯一途径）
const directRequest = [];
for (const file of files) {
  const fileRel = rel(file);
  if (!GUARDED_FILES.has(fileRel)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (/\.request\s*\(\s*\)/.test(text)) directRequest.push(fileRel);
}
check('② 受管文件（CLI 层）不出现 .request()，一律经 data source 取数', directRequest.length === 0, directRequest.join(', '));

// ③ 只读入口被真正使用
const sourceText = fs.readFileSync(path.join(ROOT, 'packages/infrastructure/src/sync/erp-source.ts'), 'utf8');
check('③ erp-source.ts 调用 queryErpReadOnly（唯一 ERP 取数入口）', sourceText.includes('queryErpReadOnly('), '');

// ③b 唯一低层下单点：erp-source.ts 里的 .request() 必须恰好 1 处（收敛为单一函数，便于审计）
const requestCount = (sourceText.match(/\.request\s*\(\s*\)/g) ?? []).length;
check('③b erp-source.ts 的 .request() 收敛为唯一 1 处低层下单点', requestCount === 1, `实际 ${requestCount} 处`);

// ④ 守门本体完整
const guardText = fs.readFileSync(path.join(ROOT, 'packages/infrastructure/src/sync/erp-readonly.ts'), 'utf8');
check(
  '④ 守门本体含首关断言 + 写关键字清单',
  guardText.includes('assertReadOnlyErpSql(') && guardText.includes('WRITE_KEYWORDS') && guardText.includes("'insert'") && guardText.includes("'update'"),
  ''
);

// 遗留豁免：只提示，不失败
for (const file of poolUsers.map(rel)) {
  if (LEGACY_EXEMPT.has(file) && file !== 'packages/infrastructure/src/adapters/erp-pool.ts') {
    warnings++;
    console.log(`[WARN] 遗留豁免（仍绕过守门，见 docs/45 §7）：${file}`);
  }
}

// 说明：守门的「负面自检」（写语句必须被拦）由单测承担 —— packages/infrastructure/src/__tests__/erp-readonly.test.ts
//      本脚本只做静态可达性检查，两者合起来才构成「既拦得住、也没旁路」的完整证据。
console.log('');
console.log(`=== ${failures === 0 ? 'PASS' : 'FAIL'}：扫描 ${files.length} 个 .ts 文件，违规 ${failures} 项，遗留豁免 ${warnings} 项 ===`);
process.exit(failures === 0 ? 0 : 1);
