#!/usr/bin/env node
// make-node14-patches.cjs — 生成 Node 14 语法补丁包
//
// 背景：客户服务器 Windows Server 2008 R2 只能运行 Node 14.21.3（V8 8.4）。
// 部分依赖的官方构建产物使用 ES2021 逻辑赋值语法（??=、||=、&&=），Node 14
// 在 require 这些文件时会直接抛 SyntaxError：
//   - kysely@0.27.6        dist/dialect/sqlite/sqlite-introspector.{js,mjs}（barrel 导出必加载）
//   - openapi3-ts@4.6.1    dist/oas3x.js（@asteasolutions/zod-to-openapi → contracts 全链加载）
// 这里不降级依赖版本（避免行为差异），而是生成语义完全等价的 ES2020 写法补丁：
//   X ??= Y  →  X = X ?? Y；X ||= Y → X = X || Y；X &&= Y → X = X && Y
//
// 用法（仓库根目录）：node scripts/deploy/make-node14-patches.cjs
// 前置：deploy-stage 已由 pnpm deploy 生成（含 .pnpm 锁定版本目录）。
// 产物：scripts/deploy/node14-patches/<pkg>/...，由 assemble.cjs 在 npm 安装后覆盖应用。
// 升级依赖版本后请重新运行本脚本并核对差异。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STAGE = path.join(ROOT, 'deploy-stage', 'node_modules', '.pnpm');
const OUT = path.join(__dirname, 'node14-patches');

function ensureStage() {
  if (fs.existsSync(STAGE)) return;
  console.log('[patch] deploy-stage 不存在，先执行 pnpm deploy ...');
  const { spawnSync } = require('child_process');
  const r = spawnSync('pnpm', ['--filter', '@letian/api', 'deploy', '--prod', 'deploy-stage'], {
    cwd: ROOT, stdio: 'inherit', shell: true,
  });
  if (r.status !== 0) throw new Error('pnpm deploy 失败');
}

// 需要打补丁的包：.pnpm 目录名前缀 → 补丁目标包名
// literals：逐字替换对（Node 14 不可解析的模块别名 / API 改为等价物）
// manualSrc：手工维护的整文件覆盖目录（node14-patches-src/<pkg>/），原样复制
const PATCH_TARGETS = [
  { pnpmDir: 'kysely@0.27.6', pkg: 'kysely' },
  { pnpmDir: 'openapi3-ts@4.6.1', pkg: 'openapi3-ts' },
  {
    pnpmDir: 'tedious@20.0.0',
    pkg: 'tedious',
    // lib/connection.js 两处 request.error ??=（语法改写处理）；
    // @azure/identity 的构建产物是 Node16+ 语法，但其仅在 azure-active-directory
    // 认证分支使用 —— ERP 集成走 SQL 账号认证，改为使用点懒加载，不改变 SQL 认证行为
    literals: [
      [
        'var _identity = require("@azure/identity");\nvar _coreAuth = require("@azure/core-auth");',
        [
          'var _identity = undefined, _coreAuth = undefined;',
          'function _lazyAzure() {',
          '  if (!_identity) { _identity = require("@azure/identity"); _coreAuth = require("@azure/core-auth"); }',
          '  return _identity;',
          '}',
        ].join('\n'),
      ],
      ['(0, _coreAuth.isTokenCredential)(options.credential)', '(0, (_lazyAzure(), _coreAuth.isTokenCredential))(options.credential)'],
      // Node 14 无全局 AbortController（15+ 才有）；initialiseConnection 每次连接都会
      // 执行 new AbortController()，回退到 tedious 依赖树自带的 abort-controller polyfill
      [
        'const timeoutController = new AbortController();',
        "const timeoutController = typeof AbortController !== 'undefined' ? new AbortController() : new (require('abort-controller').AbortController)();",
      ],
      ['new _identity.UsernamePasswordCredential(', 'new (_lazyAzure(), _identity.UsernamePasswordCredential)('],
      ['new _identity.ManagedIdentityCredential(', 'new (_lazyAzure(), _identity.ManagedIdentityCredential)('],
      ['new _identity.DefaultAzureCredential(', 'new (_lazyAzure(), _identity.DefaultAzureCredential)('],
      // keystore-provider-azure-key-vault.js 中的同名调用不打扰（该文件仅 Always Encrypted+AKV 场景由用户显式加载）
      ['new _identity.ClientSecretCredential(', 'new (_lazyAzure(), _identity.ClientSecretCredential)(', 'lib/connection.js'],
    ],
  },
  {
    // mssql 12.7 的 lib/diagnostics.js 在模块加载时调用 dc.tracingChannel
    // （Node 18.19+ API）；覆盖版在缺失时降级为直通调用（见文件头注释）
    pnpmDir: 'mssql@12.7.2',
    pkg: 'mssql',
    manualSrc: 'mssql',
  },
];

// 语义等价改写：仅匹配真实语法位（标识符/成员/带下标左值），不动字符串字面量中的巧合文本
const REWRITES = [
  // X ??= Y / X ||= Y / X &&= Y，X 为 this.a.b、a.b、a、a[i] 形式
  /\b((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\][()]*\])*)\s*(\?\?=|\|\|=|&&=)\s*/g,
];

function rewrite(content, relPath) {
  let count = 0;
  let out = content;
  for (const re of REWRITES) {
    out = out.replace(re, (m, lhs, op) => {
      const logical = op === '??=' ? '??' : op === '||=' ? '||' : '&&';
      count++;
      return `${lhs}=${lhs}${logical} `;
    });
  }
  // 改写后仍残留的逻辑赋值 → 说明命中了本脚本未覆盖的左值形态，必须人工处理
  const leftover = /(\?\?=|\|\|=|&&=)/.exec(out);
  if (leftover) {
    throw new Error(`${relPath} 仍残留 ${leftover[1]}，正则未覆盖该左值形态，请人工改写`);
  }
  return { out, count };
}

function main() {
  ensureStage();
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const t of PATCH_TARGETS) {
    const src = fs
      .readdirSync(STAGE)
      .filter((d) => d.startsWith(t.pnpmDir))
      .map((d) => path.join(STAGE, d, 'node_modules', t.pkg))
      .find((p) => fs.existsSync(p));
    if (!src) throw new Error(`deploy-stage 中未找到 ${t.pnpmDir}，请先 pnpm deploy`);
    if (t.manualSrc) {
      // 手工覆盖：直接复制维护好的文件树，并确认官方包里确实存在同名文件
      const manualRoot = path.join(__dirname, 'node14-patches-src', t.manualSrc);
      let copied = 0;
      const walkManual = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { walkManual(p); continue; }
          const rel = path.relative(manualRoot, p);
          if (!fs.existsSync(path.join(src, rel))) {
            throw new Error(`官方包 ${t.pkg} 中不存在 ${rel}，版本可能已变化，请人工核对`);
          }
          const dst = path.join(OUT, t.pkg, rel);
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(p, dst);
          copied++;
          console.log(`[patch] ${t.pkg}/${rel}：手工覆盖`);
        }
      };
      walkManual(manualRoot);
      if (copied === 0) throw new Error(`${t.pkg} 手工覆盖目录为空`);
      console.log(`[patch] ${t.pkg} 共复制 ${copied} 个手工覆盖文件`);
      continue;
    }
    let patchedFiles = 0;
    let patchedSites = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(js|mjs|cjs)$/.test(e.name)) continue;
        let content = fs.readFileSync(p, 'utf8');
        let changed = false;
        for (const [from, to, scope] of t.literals || []) {
          if (scope && !path.relative(src, p).replace(/\\/g, '/').startsWith(scope)) continue;
          if (!content.includes(from)) continue;
          content = content.split(from).join(to);
          changed = true;
          patchedSites++;
          console.log(`[patch] ${t.pkg}/${path.relative(src, p)}：替换 ${from.split('\n')[0]}`);
        }
        if (/(\?\?=|\|\|=|&&=)/.test(content)) {
          const relInPkg = path.relative(src, p);
          const { out, count } = rewrite(content, `${t.pkg}/${relInPkg}`);
          content = out;
          changed = true;
          patchedSites += count;
          console.log(`[patch] ${t.pkg}/${relInPkg}：语法 ${count} 处`);
        }
        if (!changed) continue;
        const dst = path.join(OUT, t.pkg, path.relative(src, p));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, content);
        patchedFiles++;
      }
    };
    walk(src);
    if (patchedFiles === 0) throw new Error(`${t.pkg} 未发现需要改写的语法，目标版本可能已变化`);
    console.log(`[patch] ${t.pkg} 共 ${patchedFiles} 个文件、${patchedSites} 处 -> ${path.relative(ROOT, OUT)}`);
  }
  fs.writeFileSync(
    path.join(OUT, 'README.md'),
    [
      '# Node 14 语法补丁', '',
      '这些文件覆盖同名依赖包的官方构建产物，把 ES2021 逻辑赋值（??= / ||= / &&=）',
      '改写为语义等价的 ES2020 写法，使包能在 Node 14.21.3（V8 8.4）上加载。', '',
      '| 包 | 官方版本 | 原因 |',
      '|---|---|---|',
      ...PATCH_TARGETS.map((t) => `| ${t.pkg} | ${t.pnpmDir.split('@').slice(1).join('@')} | 产物含 ??=/||= 语法，require 即 SyntaxError |`),
      '', '重新生成：node scripts/deploy/make-node14-patches.cjs（升级依赖后必须重跑并核对差异）', '',
    ].join('\n')
  );
  console.log('[patch] 完成');
}

try {
  main();
} catch (err) {
  console.error('[patch] 失败：', err.message);
  process.exit(1);
}
