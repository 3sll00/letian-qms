/**
 * 仓库行尾（EOL）门禁：回答「已跟踪文本文件的行尾是否已经收敛」。
 *
 * 为什么要它：仓库长期没有 `.gitattributes`，各编辑器/工具各写各的行尾，
 * 工作区里同时躺着 CRLF 与 LF 的文本文件。`git status` 看不见这种脏 ——
 * `core.autocrlf=true` 会在比对时把 CR 归一，但脚本按字节读文件时 CR 会进字符串，
 * 于是 `includes` / `replace` 这类精确匹配会静默不命中（docs/35 §13 R6 记录过一次真实踩坑）。
 *
 * 判定口径（权威来源 = git 自己）：
 *   1. 必须存在根 `.gitattributes`，且声明 `* text=auto eol=lf`；
 *   2. 所有**文本**文件的**索引 blob** 为 LF（`i/lf`）—— 索引是仓库的存档形态；
 *   3. 所有**文本**文件的**工作区**不得出现 `w/crlf` / `w/mixed`。
 * 二进制文件（git 判为 `-text`）一律不管：它的字节里出现 0x0D 0x0A 是数据，不是行尾。
 *
 * 用法：`pnpm verify:eol`（等价 `node scripts/testing/eol-check.cjs`）
 * 退出码：0 = 收敛；1 = 存在违规（明细在输出与 scripts/logs/eol-check.log）；2 = 环境问题（非 git 仓库 / git 不可用）。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG = path.join(LOG_DIR, 'eol-check.log');

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(LOG, '');
const log = (line) => {
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** 解析 `git ls-files --eol`：`<i/xx> <w/xx> [attr/xx]\t<path>` */
function readEolIndex() {
  const out = git(['-c', 'core.quotepath=false', 'ls-files', '--eol']);
  return out
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => {
      const tab = line.indexOf('\t');
      const meta = line.slice(0, tab).trim().split(/\s+/);
      return { index: meta[0], worktree: meta[1], attr: meta[2] || 'attr/', file: line.slice(tab + 1) };
    });
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    log('EOL 门禁跳过：当前目录不是 git 仓库（无法判断行尾口径）');
    process.exit(2);
  }

  const entries = readEolIndex();
  const text = entries.filter((e) => e.index !== 'i/-text');
  const binary = entries.filter((e) => e.index === 'i/-text');

  const failures = [];
  const attrs = path.join(ROOT, '.gitattributes');
  if (!fs.existsSync(attrs)) {
    failures.push({ kind: '.gitattributes 缺失', file: '.gitattributes', detail: '没有它，core.autocrlf 会把文本文件重新签出成 CRLF' });
  } else {
    const content = fs.readFileSync(attrs, 'utf8');
    if (!/^\s*\*\s+text=auto\s+eol=lf\s*$/m.test(content)) {
      failures.push({ kind: '.gitattributes 未声明 `* text=auto eol=lf`', file: '.gitattributes', detail: '缺少全局 LF 归一规则' });
    }
  }

  const indexCrlf = text.filter((e) => e.index !== 'i/lf');
  const dirty = text.filter((e) => e.worktree === 'w/crlf' || e.worktree === 'w/mixed');

  log(`已跟踪文件 ${entries.length}（文本 ${text.length} / 二进制 ${binary.length}）`);
  log(`索引 blob 非 LF：${indexCrlf.length}`);
  log(`工作区带 CRLF 的文本文件：${dirty.length}（其中全 CRLF ${text.filter((e) => e.worktree === 'w/crlf').length} / 混行 ${text.filter((e) => e.worktree === 'w/mixed').length}）`);

  for (const e of indexCrlf) {
    failures.push({ kind: '索引 blob 不是 LF', file: e.file, detail: e.index });
  }
  for (const e of dirty) {
    failures.push({ kind: '工作区行尾未收敛', file: e.file, detail: e.worktree });
  }

  if (failures.length > 0) {
    log('');
    log(`== FAIL：${failures.length} 项行尾违规 ==`);
    for (const f of failures.slice(0, 80)) log(`  [${f.kind}] ${f.file}  (${f.detail})`);
    if (failures.length > 80) log(`  ... 其余 ${failures.length - 80} 项见 scripts/logs/eol-check.log`);
    log('');
    log('修法：确认 .gitattributes 已声明 `* text=auto eol=lf` 后，把这些文件**整文件写回 LF**');
    log('（逐文件读字节 → 只把 CRLF 还原成 LF → 写回，二进制与含 NUL 的文件跳过），再重跑本门禁。');
    process.exit(1);
  }

  log('');
  log('== PASS：已跟踪文本文件行尾已收敛（索引 LF + 工作区 LF + `.gitattributes` 在位）==');
  process.exit(0);
})().catch((err) => {
  log('EOL 门禁无法执行：' + (err && err.message ? err.message : String(err)));
  process.exit(2);
});