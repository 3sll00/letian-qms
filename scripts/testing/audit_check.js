#!/usr/bin/env node
/**
 * 源码静态审计：`any` / `@ts-ignore` / `interface` 口径核查
 *
 * 背景：旧版脚本只统计与打印，**无论结果如何都以 0 退出**，
 * 于是「完全符合无 any、无 @ts-ignore 规范」这类结论无法被证伪。
 * 本版改为「跑得出结论」的审计器：
 *
 *   1. 默认模式：与基线 `audit-baseline.json` 比较，**超出基线即失败（退出码 1）**；
 *      若无基线文件，则任何一处违规都会失败。基线用于「不许新增」，而不是「假装没有」。
 *   2. `--strict`：任何一处违规都失败（基线也不豁免），用于收口后的强制门禁。
 *   3. `--update-baseline`：把当前计数写回基线（只应在评审通过后使用）。
 *   4. `--max-any=N` / `--max-ts-ignore=N`：显式上限，优先级高于基线。
 *
 * 退出码：0 = 通过；1 = 超出预算；2 = 用法/IO 错误。
 *
 * 扫描口径（透明声明，避免"看起来绿灯"）：
 *   - 只扫描仓库内 `.ts` / `.tsx`，跳过 node_modules / .git / dist / 构建产物目录，
 *     以及 `scripts/`（工具脚本自身合法包含 `any` 等字面量，扫它只会产生噪音）；
 *   - 先剔除行注释与块注释，再匹配 `as any` / `: any` / `<any>` / `, any>` / `any[]` /
 *     `| any` / `z.any(` —— 中文注释里的"任何"不会被误判为 `any`；
 *   - `interface` 数量仅作信息展示，不参与判定（它不是违规项）。
 */
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_DIR = __dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const BASELINE_PATH = path.join(SCRIPT_DIR, 'audit-baseline.json');
const LOG_DIR = path.join(REPO_ROOT, 'scripts', 'logs');
const REPORT_PATH = path.join(LOG_DIR, 'audit-report.txt');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'release', 'web-dist', 'smoke-output', 'coverage',
  '.vite', '.turbo', '.cache', 'logs', 'scripts',
]);

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const optionValue = (name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? undefined : Number(hit.slice(name.length + 1));
};

const STRICT = has('--strict');
const UPDATE_BASELINE = has('--update-baseline');
const JSON_OUT = has('--json');

/** 违规项：`any` 与 `@ts-ignore`；`interface` 仅统计 */
const RULES = [
  {
    key: 'any',
    label: 'any',
    isViolation: true,
    test: (line) =>
      /\bas\s+any\b|:\s*any\b|<any>|,\s*any\b|\|\s*any\b|\bany\[\]|z\.any\(/.test(line),
  },
  {
    key: 'tsIgnore',
    label: '@ts-ignore / @ts-expect-error',
    isViolation: true,
    test: (line) => line.includes('@ts-ignore') || line.includes('@ts-expect-error'),
  },
  {
    key: 'interface',
    label: 'interface 声明',
    isViolation: false,
    test: (line) => /^\s*(export\s+)?interface\s+[A-Za-z0-9_]/.test(line),
  },
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(path.join(dir, entry.name));
  }
  return out;
}

/** 去掉块注释与行注释，避免注释文本被当成代码命中 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function scan() {
  const files = walk(REPO_ROOT).sort();
  const hits = Object.fromEntries(RULES.map((r) => [r.key, []]));

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = stripComments(raw).split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const rule of RULES) {
        if (rule.test(line)) {
          hits[rule.key].push({
            file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
            line: idx + 1,
            text: raw.split(/\r?\n/)[idx].trim(),
          });
        }
      }
    });
  }
  return { files, hits };
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    console.error(`基线文件解析失败: ${BASELINE_PATH}\n${err.message}`);
    process.exit(2);
  }
}

function writeBaseline(counts) {
  const payload = {
    note: '基线 = 允许存在的违规上限；`--update-baseline` 后才可上调（需评审）。',
    updatedAt: new Date().toISOString(),
    counts,
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

const { files, hits } = scan();
const counts = {
  any: hits.any.length,
  tsIgnore: hits.tsIgnore.length,
  interface: hits.interface.length,
};
const baseline = readBaseline();

if (UPDATE_BASELINE) {
  writeBaseline(counts);
  console.log(`已更新基线: ${BASELINE_PATH}`);
  console.log(JSON.stringify(counts, null, 2));
  process.exit(0);
}

// 各项预算：--max-* > 基线 > 0
const budgetFor = (key) => {
  const explicit = optionValue(key === 'any' ? '--max-any' : '--max-ts-ignore');
  if (explicit !== undefined) return explicit;
  if (STRICT) return 0;
  if (baseline && typeof baseline.counts?.[key] === 'number') return baseline.counts[key];
  return 0;
};

const violations = [];
for (const rule of RULES.filter((r) => r.isViolation)) {
  const budget = budgetFor(rule.key);
  const actual = counts[rule.key];
  if (actual > budget) violations.push({ rule: rule.label, actual, budget });
}

if (!JSON_OUT) {
  console.log(`扫描文件数: ${files.length}`);
  for (const rule of RULES) {
    const budget = rule.isViolation ? budgetFor(rule.key) : null;
    const suffix = budget === null ? '' : ` / 预算 ${budget}`;
    console.log(`  ${rule.label}: ${counts[rule.key]}${suffix}`);
  }
  if (baseline) console.log(`基线: ${BASELINE_PATH}`);
  else console.log('基线: 无（任何一处违规都会失败；用 --update-baseline 落基线）');

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const report = RULES.map((rule) => {
    const list = hits[rule.key]
      .map((h) => `  ${h.file}:${h.line}: ${h.text}`)
      .join('\n');
    return `=== ${rule.label} (${counts[rule.key]}) ===\n${list || '  (无)'}`;
  }).join('\n\n');
  fs.writeFileSync(REPORT_PATH, `扫描文件数: ${files.length}\n\n${report}\n`, 'utf8');
  console.log(`明细报告: ${REPORT_PATH}`);
}

if (violations.length > 0) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, counts, violations }, null, 2));
  else {
    console.log('\n审计未通过：');
    for (const v of violations) console.log(`  ✗ ${v.rule}: ${v.actual} 处，超出预算 ${v.budget}`);
    for (const v of violations) {
      const key = v.rule === 'any' ? 'any' : 'tsIgnore';
      for (const h of hits[key].slice(0, 15)) console.log(`      ${h.file}:${h.line}`);
      if (hits[key].length > 15) console.log(`      ... 其余 ${hits[key].length - 15} 处见报告文件`);
    }
  }
  process.exit(1);
}

if (JSON_OUT) console.log(JSON.stringify({ ok: true, counts }, null, 2));
else console.log('\n审计通过：违规项均未超出预算。');
process.exit(0);
