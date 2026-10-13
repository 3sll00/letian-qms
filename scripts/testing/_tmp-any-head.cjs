/**
 * 临时：分别统计「HEAD 已提交版本」与「当前工作区」的 any 数量，
 * 用于判断预算超支到底来自既有技术债还是在途改动。
 */
const { execFileSync } = require('node:child_process');

const RE = /\bas\s+any\b|:\s*any\b|<any>|,\s*any\b|\|\s*any\b|\bany\[\]|z\.any\(/;
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'out', 'release', 'web-dist',
  'smoke-output', 'coverage', '.vite', '.turbo', '.cache', 'logs', 'scripts',
]);

function strip(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function count(text) {
  return strip(text).split('\n').filter((l) => RE.test(l)).length;
}

const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\n')
  .filter((f) => f && !f.endsWith('.d.ts'))
  .filter((f) => !SKIP.has(f.split('/')[0]));

let headTotal = 0;
let workTotal = 0;
let dirtyFiles = 0;
const rows = [];

for (const f of files) {
  let headText;
  try {
    headText = execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch {
    continue; // HEAD 里没有（新增未跟踪文件）
  }
  const headN = count(headText);
  let workN = headN;
  try {
    workN = count(require('node:fs').readFileSync(f, 'utf8'));
  } catch {
    /* 未跟踪文件：并入工作区统计 */
  }
  headTotal += headN;
  workTotal += workN;
  if (workN !== headN) dirtyFiles += 1;
  if (workN - headN > 0) rows.push([f, headN, workN, workN - headN]);
}

rows.sort((a, b) => b[3] - a[3]);
process.stdout.write(`已提交代码(HEAD) any 总数: ${headTotal}\n`);
process.stdout.write(`当前工作区 any 总数: ${workTotal}\n`);
process.stdout.write(`预算: 138\n`);
process.stdout.write(`→ 既有技术债超出: ${headTotal - 138} 处\n`);
process.stdout.write(`→ 在途改动新增: ${workTotal - headTotal} 处（分布在 ${dirtyFiles} 个文件）\n\n`);
process.stdout.write('--- 在途新增 any 最多的文件 ---\n');
for (const [f, h, w, d] of rows.slice(0, 10)) {
  process.stdout.write(`  +${String(d).padStart(3)}  (${h}→${w})  ${f}\n`);
}