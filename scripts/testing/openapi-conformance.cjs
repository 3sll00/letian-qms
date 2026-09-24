#!/usr/bin/env node
/**
 * 「spec × 真实返回」契约一致性探针（docs/49 §11 · TBD-12）
 *
 * 解决什么：`docs/api/letian-qms-openapi.yaml` 是**多会话共享热点**，字段一旦漂移，
 * 前端按 spec 取到的字段就是 undefined，而 Vitest / Playwright 都不会红。
 * 本探针把「spec 声明」与「服务端真实返回」逐字段对账，让漂移当场可见。
 *
 * 只读保证（硬约束）：**只发 GET**（外加一次免鉴权的开发态登录 POST /auth/login）。
 * 不建单、不改状态、不写审计、不清理数据；任何时刻可重复跑。
 * 历史教训（docs/35 §R7）：探针误打到真库 → 把一条 MRB 从 UNDER_REVIEW 改成 DISPOSED。
 *
 * 六层结构（1/5 层离线，空库也有效；2/3/4 层需要服务端）：
 *   ① 规格自检（离线）     ：44 个 schema 全部可编译、$ref 无悬挂、路径参数与模板一致
 *   ② 路由存在性（在线）   ：spec 里登记的每个 GET 都必须真的注册过（不是「Route not found」）
 *   ③ 响应体契约（在线）   ：拿到 2xx 的操作，按 spec 声明的 200 schema 逐字段校验
 *   ④ 焦点回归（在线）     ：§9.5 的 4 个焦点 schema 逐单/逐条计数（12 单明细级）
 *   ⑤ 可证伪性自检（离线） ：用冻结样本 + 口径回退，证明「判绿」不是因为判据失灵
 *   ⑥ 空转保护             ：断言总数为 0 / 数据层 0 例时必须显式告警（可收紧为失败）
 *
 * 已知漂移（`scripts/testing/openapi-known-drift.json`）：已核实、尚未修复的漂移**不判红**，
 * 但必须逐条公示 + 计数（不许静默放行），并提示「登记已可销账」避免僵尸登记；
 * 未登记的新漂移一律判红 —— 门禁不会因为存量债而一上来就红。
 *
 * 用法：
 *   pnpm verify:openapi                        # 本地（服务端未起时自动起 :3100）
 *   API_BASE=http://host:3100/api/v1 pnpm verify:openapi
 *   OPENAPI_CONFORMANCE_MIN_CASES=1 pnpm verify:openapi   # 数据层 0 例即失败（有数据的库用）
 *   OPENAPI_KNOWN_DRIFT_MAX=1 pnpm verify:openapi         # 已知漂移数上限（CI 防登记表悄悄变长）
 *
 * 环境变量：
 *   API_BASE                       默认 http://127.0.0.1:3100/api/v1
 *   OPENAPI_SPEC                   默认 docs/api/letian-qms-openapi.yaml
 *   OPENAPI_AUTOSTART=0            禁止自动拉起服务端（服务端不可用即退出码 2）
 *   OPENAPI_DETAIL_LIMIT=20        明细级遍历的单数上限（0 = 全部）
 *   OPENAPI_CONFORMANCE_MIN_CASES  数据层最少校验例数（默认 0 = 只告警不失败）
 *   OPENAPI_OPERATOR_ID            登录用操作员（默认张强 QA_MANAGER，避免 PBAC 403）
 *   OPENAPI_HEAT_BATCH_NOS         炉批号候选（逗号分隔；缺数据不判红）
 *   OPENAPI_KNOWN_DRIFT_MAX        已知漂移数硬上限（未设 = 只公示不判红）
 *
 * 退出码：0 = 通过；1 = 存在违反项或触发硬阈值；2 = 前置不可用（依赖缺失 / 服务端起不来 / 登录失败）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SPEC_PATH = process.env.OPENAPI_SPEC
  ? path.resolve(process.env.OPENAPI_SPEC)
  : path.join(REPO_ROOT, 'docs', 'api', 'letian-qms-openapi.yaml');
const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:3100/api/v1').replace(/\/+$/, '');
const HEALTH_URL = (process.env.OPENAPI_HEALTH_URL || API_BASE.replace(/\/api\/v1$/, '') + '/health');
const OPERATOR_ID = process.env.OPENAPI_OPERATOR_ID || '11000000-0000-4000-8000-000000000001';
const AUTOSTART = process.env.OPENAPI_AUTOSTART !== '0';
const DETAIL_LIMIT = intEnv('OPENAPI_DETAIL_LIMIT', 0);
const MIN_CASES = intEnv('OPENAPI_CONFORMANCE_MIN_CASES', 0);
/** 已知漂移硬上限：显式设置后生效（CI 用它防止登记表被静默扩容） */
const KNOWN_DRIFT_MAX = optionalIntEnv('OPENAPI_KNOWN_DRIFT_MAX');
const HTTP_TIMEOUT_MS = intEnv('OPENAPI_TIMEOUT_MS', 20000);
const STARTUP_TIMEOUT_MS = intEnv('OPENAPI_STARTUP_TIMEOUT_MS', 90000);
const HEAT_CANDIDATES = (
  process.env.OPENAPI_HEAT_BATCH_NOS || 'TEST-HT-2609-001,TEST-HT-2609-002,TEST-HT-2609-004'
)
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');
/** 用于「业务不存在」分支的哨兵值：故意打不中任何真实行 */
const SENTINEL = '__probe_sentinel__';
/** §9.5 焦点 + 本次新增的关注 schema */
const FOCUS_SCHEMAS = [
  'PaginatedInspectionOrders',
  'InspectionOrder',
  'InspectionOrderItem',
  'FurnaceHeatTraceResponse',
];

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`环境变量 ${name} 必须是非负整数，实际收到：${raw}`);
  }
  return value;
}

function optionalIntEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`环境变量 ${name} 必须是非负整数，实际收到：${raw}`);
  }
  return value;
}

// ---------------------------------------------------------------- 依赖解析

/**
 * 本仓是 pnpm 严格依赖：`yaml` / `ajv` 只存在于 `.pnpm` 虚拟 store（裸 require 会 MISS）。
 * 因此按「先常规解析、再扫 .pnpm」的顺序解析，并对版本号做下界约束。
 * 缺失时给出可直接执行的一句话修复（不静默降级成「跳过校验」）。
 */
function resolveFromPnpm(moduleId, minMajor) {
  const pkgName = moduleId.startsWith('@') ? moduleId.split('/').slice(0, 2).join('/') : moduleId.split('/')[0];
  const directRoots = [REPO_ROOT, path.join(REPO_ROOT, 'apps', 'api'), path.join(REPO_ROOT, 'apps', 'web')];
  try {
    return require.resolve(moduleId, { paths: directRoots });
  } catch {
    /* 继续扫虚拟 store */
  }
  const store = path.join(REPO_ROOT, 'node_modules', '.pnpm');
  if (!fs.existsSync(store)) {
    throw new Error(`无法解析依赖 ${moduleId}（且不存在 ${store}）。请先在仓库根执行 pnpm install。`);
  }
  const candidates = fs
    .readdirSync(store)
    .filter((dir) => dir.startsWith(pkgName + '@'))
    .map((dir) => ({ dir: path.join(store, dir), version: dir.slice(pkgName.length + 1) }))
    .filter((item) => /^\d+\.\d+\.\d+/.test(item.version))
    .filter((item) => minMajor === undefined || Number(item.version.split('.')[0]) >= minMajor)
    .sort((a, b) => compareVersions(b.version, a.version));
  for (const item of candidates) {
    try {
      return require.resolve(moduleId, { paths: [path.join(item.dir, 'node_modules')] });
    } catch {
      /* 换下一个版本 */
    }
  }
  const hint = minMajor === undefined ? '' : `（需要 >= ${minMajor}.x）`;
  throw new Error(
    `无法解析依赖 ${moduleId}${hint}。修复：pnpm add -Dw ${pkgName}（**改 package.json，需先报备**）`
  );
}

function compareVersions(a, b) {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// ---------------------------------------------------------------- 断言与统计

const checks = [];
const failures = [];
const coverage = {
  specSchemaCompiled: 0,
  routeProbed: 0,
  routeMissing: [],
  serverErrors: [],
  bodyValidated: 0,
  bodyMismatch: [],
  skippedNoData: [],
  focus: {},
  selfTest: { total: 0, red: 0, detail: [] },
  knownDrift: { hits: [], ids: [] },
};

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) });
  const line = (ok ? 'PASS' : 'FAIL') + ' :: ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail));
  console.log(line);
  if (!ok) failures.push(name);
  return Boolean(ok);
}

function note(text) {
  console.log('      ' + text);
}

// ---------------------------------------------------------------- HTTP

let token = '';
async function httpJson(pathname, options) {
  const res = await fetch(API_BASE + pathname, Object.assign({ signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }, options || {}));
  const text = await res.text();
  let body;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, contentType: res.headers.get('content-type') || '', body };
}

function authed(pathname, options) {
  return httpJson(pathname, Object.assign({ headers: { authorization: 'Bearer ' + token } }, options || {}));
}

/**
 * 区分「路由未注册」与「业务 404」——这是本探针能自称"路由存在性"的判据：
 *   路由未注册：Fastify 默认 404，content-type=application/json，message 含 "Route ... not found"；
 *   业务 404  ：RFC 7807，content-type=application/problem+json（如「检验单不存在」）。
 */
function isRouteMissing(status, contentType, body) {
  if (status !== 404) return false;
  if (/problem\+json/i.test(contentType)) return false;
  const message = body && typeof body === 'object' ? String(body.message || '') : String(body || '');
  return /Route\s+\S+\s+not found/i.test(message);
}

async function waitForHealth() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}
// ---------------------------------------------------------------- 服务端自启（CI 无 dev server 也能跑）

let serverChild = null;

function killServerChild() {
  if (serverChild === null) return;
  const pid = serverChild.pid;
  serverChild = null;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      // spawnSync：进程即将退出，异步 taskkill 可能来不及执行，留下占着 :3100 的孤儿进程
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    /* 进程可能已退出 */
  }
}

/**
 * 服务端不在线时自行拉起（CI 只有 postgres service，没有常驻 dev server）。
 * NODE_ENV 强制 development：生产态下 /auth/login 整组路由不注册（auth.controller.ts:32）。
 */
async function ensureServer() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    if (res.ok) return { started: false, log: '' };
  } catch {
    /* 未在线 */
  }
  if (!AUTOSTART) return { started: false, log: '', unreachable: true };

  const tsxCli = require.resolve('tsx/cli', { paths: [REPO_ROOT] });
  const child = spawn(process.execPath, [tsxCli, path.join('apps', 'api', 'src', 'server.ts')], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { NODE_ENV: process.env.NODE_ENV === 'production' ? 'development' : process.env.NODE_ENV || 'development' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  serverChild = child;
  let log = '';
  const collect = (chunk) => {
    log = (log + String(chunk)).slice(-4000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', () => {
    if (serverChild === child) serverChild = null;
  });
  const healthy = await waitForHealth();
  return { started: true, healthy, log };
}

// ---------------------------------------------------------------- 规格加载

function loadSpec() {
  const YAML = require(resolveFromPnpm('yaml'));
  const raw = fs.readFileSync(SPEC_PATH, 'utf8');
  const spec = YAML.parse(raw);
  if (!spec || typeof spec !== 'object') throw new Error('spec 解析结果不是对象');
  if (!spec.paths || typeof spec.paths !== 'object') throw new Error('spec 缺少 paths');
  if (!spec.components || !spec.components.schemas) throw new Error('spec 缺少 components.schemas');
  return spec;
}

/**
 * 同一份 components 编译出的校验器工厂；id 不同的实例互不干扰（可证伪性自检需要并存两套口径）。
 * byName：按 components.schemas 里的名字取校验器；
 * inline：编译 spec 里**内联**声明的 200 schema（如 /audit/logs），其内部 `#/components/...`
 *         引用要重定基到本 Ajv 实例的 components 文档，否则会被误判成「spec 未声明」。
 */
function makeValidatorFactory(components, id) {
  const Ajv2020 = require(resolveFromPnpm('ajv/dist/2020', 8));
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema({ $id: id, components }, id);
  return {
    byName: (name) => ajv.compile({ $ref: id + '#/components/schemas/' + name }),
    inline: (schema) => ajv.compile(rebaseRefs(schema, id)),
  };
}

/** 把内联 schema 里的本地 JSON-Pointer 引用 `#/...` 重定基到已注册的 components 文档 */
function rebaseRefs(node, id) {
  if (Array.isArray(node)) return node.map((child) => rebaseRefs(child, id));
  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/')) out[key] = id + value;
      else out[key] = rebaseRefs(value, id);
    }
    return out;
  }
  return node;
}

function formatErrors(validate, max) {
  const limit = max === undefined ? 4 : max;
  return (validate.errors || []).slice(0, limit).map((err) => {
    const at = err.instancePath === '' ? '/' : err.instancePath;
    const extra = err.params ? JSON.stringify(err.params) : '';
    return at + ' ' + err.message + (extra === '' ? '' : ' ' + extra);
  });
}

function json200Schema(op) {
  const content = op.responses && op.responses['200'] && op.responses['200'].content;
  if (!content || typeof content !== 'object') return null;
  const media = content['application/json'];
  if (!media || !media.schema) return null;
  return media.schema;
}

function schemaRefName(schema) {
  if (schema && typeof schema.$ref === 'string') {
    const parts = schema.$ref.split('/');
    return parts[parts.length - 1];
  }
  return null;
}

// ---------------------------------------------------------------- 请求装配

/** 路径参数的取值来源：能取到真实值就取真实值，取不到用哨兵（此时只验「路由已注册」） */
function pathParamSources(context) {
  return {
    '/release-gates/{batchNo}': { batchNo: () => context.batchNo },
    '/plans/{id}': { id: () => context.planId },
    '/inspections/{id}': { id: () => context.orderId },
    '/traceability/orders/{orderNo}': { orderNo: () => context.orderNo },
    '/traceability/{batchNo}': { batchNo: () => context.batchNo },
  };
}

/** 必填查询参数的取值来源（未列出的必填参数用哨兵，期望业务 4xx） */
function requiredQuerySources(context) {
  return {
    '/inspections/heat-batch-trace': { heatBatchNo: () => context.heatBatchNo },
    '/plans/match': { materialCode: () => context.materialCode, inspectionType: () => context.inspectionType },
    '/traceability/chain-status': { batchNo: () => context.batchNo },
  };
}

/** 列表类接口统一取最小页，避免探针把整套数据搬下来 */
const QUERY_MINIMAL = {
  '/inspections': { pageSize: '1' },
  '/plans': { pageSize: '1' },
  '/mrb/pending-pool': { pageSize: '1' },
  '/mrb/records': { pageSize: '1' },
  '/audit/logs': { pageSize: '1' },
  '/traceability/batches': { pageSize: '1' },
};

function buildRequest(template, pathItem, op, context) {
  const pathSources = pathParamSources(context)[template] || {};
  const querySources = requiredQuerySources(context)[template] || {};
  const params = [].concat(pathItem.parameters || [], op.parameters || []);

  let pathname = template;
  let pathReal = true;
  pathname = pathname.replace(/\{([^}]+)\}/g, (_all, name) => {
    const value = pathSources[name] ? pathSources[name]() : undefined;
    if (value === undefined || value === null || value === '') {
      pathReal = false;
      return SENTINEL;
    }
    return encodeURIComponent(String(value));
  });

  const search = new URLSearchParams();
  const minimal = QUERY_MINIMAL[template] || {};
  for (const [key, value] of Object.entries(minimal)) search.set(key, value);

  const queryReal = [];
  for (const param of params) {
    if (!param || param.in !== 'query' || !param.required) continue;
    const source = querySources[param.name];
    const value = source ? source() : undefined;
    if (value === undefined || value === null || value === '') {
      search.set(param.name, SENTINEL);
      queryReal.push({ name: param.name, real: false });
    } else {
      search.set(param.name, String(value));
      queryReal.push({ name: param.name, real: true });
    }
  }

  const qs = search.toString();
  const allReal = pathReal && queryReal.every((item) => item.real);
  return { url: pathname + (qs === '' ? '' : '?' + qs), allReal };
}
// ---------------------------------------------------------------- ① 规格自检（离线）

function layerSpecSelfCheck(spec) {
  console.log('--- ① 规格自检（离线，不需要服务端）---');
  const schemas = spec.components.schemas;
  const names = Object.keys(schemas);

  let compiled = 0;
  const broken = [];
  let validate;
  try {
    validate = makeValidatorFactory(spec.components, 'conformance.json');
  } catch (err) {
    check('① spec 可作为一份 Ajv 2020 文档加载', false, { error: err.message });
    return { validate: null, names, broken };
  }
  check('① spec 可作为一份 Ajv 2020 文档加载', true, { schemas: names.length });

  for (const name of names) {
    try {
      validate.byName(name);
      compiled += 1;
    } catch (err) {
      broken.push({ schema: name, error: err.message });
    }
  }
  coverage.specSchemaCompiled = compiled;
  check('① 全部 schema 可编译（$ref 无悬挂 / 无非法关键字）', broken.length === 0, {
    编译通过: compiled + '/' + names.length,
    失败: broken.slice(0, 5),
  });

  // 路径参数与模板必须一一对应（防止 {id} 写成 :id 这类「文档与实现各说各话」）
  const paramMismatch = [];
  let getCount = 0;
  for (const [template, item] of Object.entries(spec.paths)) {
    const placeholders = (template.match(/\{[^}]+\}/g) || []).map((x) => x.slice(1, -1));
    for (const [method, op] of Object.entries(item)) {
      if (typeof op !== 'object' || op === null) continue;
      const params = [].concat(item.parameters || [], op.parameters || []);
      const declared = params.filter((p) => p && p.in === 'path').map((p) => p.name);
      const missing = placeholders.filter((name) => !declared.includes(name));
      const extra = declared.filter((name) => !placeholders.includes(name));
      if (missing.length > 0 || extra.length > 0) {
        paramMismatch.push({ path: template, method: method.toUpperCase(), 未声明: missing, 多余声明: extra });
      }
      if (method.toUpperCase() === 'GET') getCount += 1;
    }
  }
  check('① 路径模板 {参数} 与参数声明双向一致', paramMismatch.length === 0, paramMismatch.slice(0, 5));

  // 全局 security 已登记（TBD-03 契约优先的成果，防止有人回退成 --header 硬塞）
  const hasBearer = Boolean(
    spec.security && spec.security.some((entry) => entry && entry.bearerAuth) &&
      spec.components.securitySchemes && spec.components.securitySchemes.bearerAuth
  );
  check('① 全局 security / securitySchemes.bearerAuth 已登记（TBD-03 不回退）', hasBearer);

  console.log('');
  return { validate, names, broken, getCount };
}

// ---------------------------------------------------------------- 已知漂移登记（勿让门禁一上来就红在存量债上）

/**
 * 登记表把「已核实的存量漂移」与「新出现的漂移」分开：
 *   - 已登记：**不判红**，但必须**逐条公示 + 计数**（和 MRB 豁免同一套纪律：不许静默放行）；
 *   - 未登记：判红（退出码 1）。
 * 匹配按 **spec 路径模板 + schema + 字段指针**（`/trendSeries[]/totalCount` 这种数组下标归一化后的形态），
 * 不按行号、不按具体单据 —— 与「按内容匹配、不按行号」的仓库纪律一致。
 */
const KNOWN_DRIFT_PATH = path.join(__dirname, 'openapi-known-drift.json');
let knownDrift = { entries: [] };

function loadKnownDrift() {
  if (!fs.existsSync(KNOWN_DRIFT_PATH)) return { entries: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(KNOWN_DRIFT_PATH, 'utf8'));
  } catch (err) {
    throw new Error('已知漂移登记表解析失败：' + KNOWN_DRIFT_PATH + ' —— ' + err.message);
  }
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.schema !== 'string' || !Array.isArray(entry.fields)) {
      throw new Error('已知漂移登记表条目缺 path / schema / fields：' + JSON.stringify(entry));
    }
  }
  return { entries };
}

/** 错误定位归一化：`/trendSeries/0/totalCount` → `/trendSeries[]/totalCount`（数组下标脱敏，避免登记被行数绑死） */
function errorPointers(validate) {
  const pointers = new Set();
  for (const err of validate.errors || []) {
    // `/0` 整体替换成 `[]`（不能替换成 `/[]`，否则与 missingProperty 拼接后会多一条斜杠）
    const base = String(err.instancePath || '').replace(/\/\d+/g, '[]');
    if (err.keyword === 'required' && err.params && err.params.missingProperty) {
      pointers.add((base === '' ? '' : base) + '/' + err.params.missingProperty);
    } else {
      pointers.add(base === '' ? '/' : base);
    }
  }
  return Array.from(pointers);
}

function matchKnownDrift(item) {
  return knownDrift.entries.find((entry) => {
    if (entry.path !== item.path || entry.schema !== item.schema) return false;
    const declared = new Set(entry.fields);
    // 只有「本次不符的每个字段都已登记」才算已登记；出现新字段 → 仍判红
    return item.pointers.every((pointer) => declared.has(pointer));
  });
}

/** 一处不符 → 已登记（计数公示）或未登记（判红）。返回是否已登记。 */
function registerMismatch(item) {
  const hit = matchKnownDrift(item);
  if (!hit) {
    coverage.bodyMismatch.push(item);
    return false;
  }
  coverage.knownDrift.hits.push({ id: hit.id, path: item.path, schema: item.schema, where: item.where, pointers: item.pointers });
  if (!coverage.knownDrift.ids.includes(hit.id)) coverage.knownDrift.ids.push(hit.id);
  return true;
}

// ---------------------------------------------------------------- ②③ 路由存在性 + 响应体契约（在线）

async function layerRouteAndBody(spec, validate) {
  console.log('--- ② 路由存在性 + ③ 响应体契约（在线；只发 GET）---');

  // 证伪自检：判别器必须能把「未注册路由」认出来，否则 ② 的「全绿」毫无意义
  const ghost = await httpJson('/__probe_no_such_route__', { headers: { authorization: 'Bearer ' + token } });
  check(
    '② 判别器自检：未注册路由必须被判为「Route not found」',
    isRouteMissing(ghost.status, ghost.contentType, ghost.body),
    { status: ghost.status, contentType: ghost.contentType }
  );

  const context = await buildContext();
  const rows = [];
  for (const [template, item] of Object.entries(spec.paths)) {
    const op = item.get;
    if (!op) continue;
    const request = buildRequest(template, item, op, context);
    const res = await authed(request.url);
    const row = { path: template, url: request.url, allReal: request.allReal, status: res.status };
    coverage.routeProbed += 1;

    if (isRouteMissing(res.status, res.contentType, res.body)) {
      coverage.routeMissing.push(row);
      check('② 路由已注册 ' + template, false, { status: res.status, hint: 'spec 登记了但实现里没有' });
      rows.push(Object.assign(row, { verdict: 'ROUTE_MISSING' }));
      continue;
    }
    if (res.status >= 500) {
      coverage.serverErrors.push(Object.assign({}, row, { body: res.body }));
      check('② 无 5xx ' + template, false, { status: res.status });
      rows.push(Object.assign(row, { verdict: 'SERVER_ERROR' }));
      continue;
    }

    const schema = json200Schema(op);
    const refName = schemaRefName(schema);
    const schemaLabel = refName === null ? '（内联 schema）' : refName;
    if (res.status >= 200 && res.status < 300 && schema) {
      let validateBody;
      try {
        validateBody = refName === null ? validate.inline(schema) : validate.byName(refName);
      } catch (err) {
        check('③ 200 schema 可编译 ' + template, false, { error: err.message });
        rows.push(Object.assign(row, { verdict: 'SCHEMA_UNCOMPILABLE', schema: schemaLabel }));
        continue;
      }
      const ok = validateBody(res.body);
      const mismatch = {
        path: template,
        schema: schemaLabel,
        status: res.status,
        where: template,
        pointers: errorPointers(validateBody),
        errors: formatErrors(validateBody),
      };
      if (ok) {
        coverage.bodyValidated += 1;
        check('③ 响应体符合 ' + schemaLabel + ' ' + template, true, { status: res.status });
        rows.push(Object.assign(row, { verdict: 'BODY_OK', schema: schemaLabel }));
      } else if (registerMismatch(mismatch)) {
        check('③ 响应体不符 ' + schemaLabel + ' ' + template + '（**已知漂移，已登记**）', true, { status: res.status, pointers: mismatch.pointers });
        note('↳ 已登记漂移不判红；修好后请从 scripts/testing/openapi-known-drift.json 销账');
        rows.push(Object.assign(row, { verdict: 'BODY_KNOWN_DRIFT', schema: schemaLabel }));
      } else {
        check('③ 响应体符合 ' + schemaLabel + ' ' + template, false, { status: res.status, errors: mismatch.errors });
        rows.push(Object.assign(row, { verdict: 'BODY_MISMATCH', schema: schemaLabel }));
      }
    } else if (res.status >= 200 && res.status < 300) {
      rows.push(Object.assign(row, { verdict: 'NO_SCHEMA', note: '200 但 spec 未声明 application/json schema' }));
      note('· ' + template + ' → ' + res.status + '（spec 未声明响应 schema，只验「已注册」）');
    } else {
      coverage.skippedNoData.push({ path: template, status: res.status });
      rows.push(Object.assign(row, { verdict: 'NOT_2XX', note: '参数/数据不足，未能校验响应体' }));
      note('· ' + template + ' → ' + res.status + '（' + (request.allReal ? '参数齐全但业务未命中，未覆盖响应体' : '含哨兵参数，未覆盖响应体') + '）');
    }
  }
  console.log('');
  return { context, rows };
}

/**
 * 参数上下文：从真实数据里取「最小可用样本」。
 * 取不到不报错 —— 只是后续那些接口退化为「只验路由已注册」。
 * 注意：全部走公开 GET，没有直连数据库。
 */
async function buildContext() {
  const context = {
    orderId: undefined,
    orderNo: undefined,
    batchNo: undefined,
    planId: undefined,
    materialCode: undefined,
    inspectionType: undefined,
    heatBatchNo: HEAT_CANDIDATES[0],
    orderCount: 0,
    itemCount: 0,
  };

  const list = await authed('/inspections?pageSize=1&page=1');
  if (list.status === 200 && list.body && Array.isArray(list.body.list) && list.body.list.length > 0) {
    const row = list.body.list[0];
    context.orderId = row.id;
    context.orderNo = row.orderNo;
    context.batchNo = row.batchNo;
    context.materialCode = row.materialCode;
    context.inspectionType = row.inspectionType;
    context.orderCount = typeof list.body.total === 'number' ? list.body.total : 0;
  }

  const plans = await authed('/plans?pageSize=1&page=1');
  if (plans.status === 200 && plans.body && Array.isArray(plans.body.list) && plans.body.list.length > 0) {
    context.planId = plans.body.list[0].id;
  }

  const batches = await authed('/traceability/batches?pageSize=1&page=1');
  if (
    batches.status === 200 &&
    batches.body &&
    Array.isArray(batches.body.list) &&
    batches.body.list.length > 0 &&
    context.batchNo === undefined
  ) {
    context.batchNo = batches.body.list[0].batchNo;
  }
  return context;
}
// ---------------------------------------------------------------- ④ 焦点回归（明细级）

/** 焦点层的不符同样先过登记表：已登记的不判红，未登记的进 mismatches 判红 */
function recordFocusMismatch(focus, validate, pathTemplate, schema, where) {
  const item = {
    path: pathTemplate,
    schema,
    where,
    pointers: errorPointers(validate),
    errors: formatErrors(validate),
  };
  if (!registerMismatch(item)) focus.mismatches.push(item);
}

async function layerFocusRegression(validate) {
  console.log('--- ④ 焦点回归（§9.5 焦点 schema：逐单 / 逐条）---');
  const focus = {
    listPages: 0,
    listPagesOk: 0,
    orderChecked: 0,
    orderOk: 0,
    itemChecked: 0,
    itemOk: 0,
    heatChecked: 0,
    heatOk: 0,
    totalReported: 0,
    mismatches: [],
  };

  const orders = [];
  let page = 1;
  while (page <= 50) {
    const res = await authed('/inspections?pageSize=100&page=' + page);
    if (res.status !== 200) {
      check('④ 列表可拉取（page=' + page + '）', false, { status: res.status });
      break;
    }
    const validatePage = validate.byName('PaginatedInspectionOrders');
    const ok = validatePage(res.body);
    focus.listPages += 1;
    if (ok) focus.listPagesOk += 1;
    else recordFocusMismatch(focus, validatePage, '/inspections', 'PaginatedInspectionOrders', 'page=' + page);
    const rows = res.body && Array.isArray(res.body.list) ? res.body.list : [];
    focus.totalReported = res.body && typeof res.body.total === 'number' ? res.body.total : rows.length;
    orders.push(...rows);
    const done = orders.length >= focus.totalReported || rows.length === 0;
    check('④ PaginatedInspectionOrders 第 ' + page + ' 页（total=' + focus.totalReported + '）', ok, ok ? { 本页: rows.length } : { errors: formatErrors(validatePage) });
    if (done) break;
    page += 1;
  }

  const targets = DETAIL_LIMIT > 0 ? orders.slice(0, DETAIL_LIMIT) : orders;
  const validateOrder = validate.byName('InspectionOrder');
  const validateItem = validate.byName('InspectionOrderItem');
  for (const row of targets) {
    const res = await authed('/inspections/' + encodeURIComponent(row.id));
    if (res.status !== 200) {
      note('· 明细 ' + row.orderNo + ' → ' + res.status + '（跳过，不判红）');
      continue;
    }
    focus.orderChecked += 1;
    if (validateOrder(res.body)) {
      focus.orderOk += 1;
    } else {
      recordFocusMismatch(focus, validateOrder, '/inspections/{id}', 'InspectionOrder', res.body.orderNo);
    }
    for (const item of res.body.items || []) {
      focus.itemChecked += 1;
      if (validateItem(item)) {
        focus.itemOk += 1;
      } else {
        recordFocusMismatch(
          focus,
          validateItem,
          '/inspections/{id}',
          'InspectionOrderItem',
          res.body.orderNo + '#' + (item && item.itemCode ? item.itemCode : '?')
        );
      }
    }
  }

  check(
    '④ InspectionOrder（' + focus.orderOk + '/' + focus.orderChecked + ' 单）',
    focus.orderOk === focus.orderChecked,
    focus.orderChecked === 0 ? { 说明: '库内无可遍历单（空转，见 ⑥）' } : undefined
  );
  check(
    '④ InspectionOrderItem（' + focus.itemOk + '/' + focus.itemChecked + ' 条）',
    focus.itemOk === focus.itemChecked,
    focus.itemChecked === 0 ? { 说明: '库内无可遍历条目（空转，见 ⑥）' } : undefined
  );

  const validateTrace = validate.byName('FurnaceHeatTraceResponse');
  for (const heatNo of HEAT_CANDIDATES.concat([SENTINEL])) {
    const res = await authed('/inspections/heat-batch-trace?heatBatchNo=' + encodeURIComponent(heatNo));
    if (res.status !== 200) {
      note('· 炉批号 ' + heatNo + ' → ' + res.status + '（跳过，不判红）');
      continue;
    }
    focus.heatChecked += 1;
    if (validateTrace(res.body)) {
      focus.heatOk += 1;
    } else {
      recordFocusMismatch(focus, validateTrace, '/inspections/heat-batch-trace', 'FurnaceHeatTraceResponse', heatNo);
    }
  }
  check('④ FurnaceHeatTraceResponse（' + focus.heatOk + '/' + focus.heatChecked + ' 组）', focus.heatOk === focus.heatChecked);

  if (focus.mismatches.length > 0) {
    console.log('  ✗ 明细不符（只列前 3 条）：');
    for (const mismatch of focus.mismatches.slice(0, 3)) {
      console.log('    - ' + mismatch.schema + ' @ ' + mismatch.where);
      for (const line of mismatch.errors) console.log('      ' + line);
    }
  }
  console.log('');
  return focus;
}

// ---------------------------------------------------------------- ⑤ 可证伪性自检（离线）

/**
 * 冻结样本：2026-09-24 从真实服务端返回中抓取的**首单首条 item**（字段全量、值真实）。
 * 用途严格限定为**证明判据有牙**（口径回退必须判红）—— 它不代替在线校验，
 * 也不会因为库被并行会话改动而失效（进程内常量，非库内数据）。
 */
const FROZEN_ITEM_SAMPLE = {
  seq: 1,
  name: '包装重量',
  unit: 'kg',
  result: 'PENDING',
  dataType: 'NUMERIC',
  isExempt: false,
  itemCode: 'PKG-001',
  sampleSize: 10,
  nominalValue: 25,
  standardText: '25.0±0.5kg',
  lowerTolerance: 0.5,
  metricCategory: 'DIMENSION',
  upperTolerance: 0.5,
  isManuallyModified: false,
};

function missingPropertiesOf(validate) {
  return (validate.errors || [])
    .filter((err) => err.keyword === 'required')
    .map((err) => err.params && err.params.missingProperty)
    .filter(Boolean);
}

function layerJudgeSelfTest(spec, validate) {
  console.log('--- ⑤ 可证伪性自检（离线：冻结样本 × 口径回退 / 变异）---');
  note('冻结样本 = 真实返回（2026-09-24 抓取）；本层只证明「判据有牙」，不代表服务端当下的返回');

  const sample = FROZEN_ITEM_SAMPLE;
  const item = spec.components.schemas.InspectionOrderItem;
  // 口径钉：§9.5.1 收敛后必须成立的三件事（若被并行会话回退，这里立刻红）
  const pinnedRequired = ['itemCode', 'name', 'metricCategory', 'dataType', 'result'];
  check(
    '⑤ 口径钉：InspectionOrderItem.required ⊇ §9.5.1 五项',
    Array.isArray(item.required) && pinnedRequired.every((key) => item.required.includes(key)),
    { required: item.required }
  );
  check(
    '⑤ 口径钉：旧名 itemName / decision / targetVal 已不在 properties 中',
    !item.properties.itemName && !item.properties.decision && !item.properties.targetVal,
    { 残留: ['itemName', 'decision', 'targetVal'].filter((key) => item.properties[key]) }
  );

  const validateNow = validate.byName('InspectionOrderItem');
  const nowOk = validateNow(sample);
  coverage.selfTest.total += 1;
  check('⑤ 现行口径 × 冻结样本 → 必须判绿', nowOk, nowOk ? undefined : { errors: formatErrors(validateNow) });

  // 回退到 §9.5.1 落地前的旧口径：改名 + required 回退
  const legacy = JSON.parse(JSON.stringify(spec.components));
  const legacyItem = legacy.schemas.InspectionOrderItem;
  legacyItem.required = ['id', 'itemCode', 'itemName', 'metricCategory', 'dataType', 'decision'];
  if (legacyItem.properties.name) {
    legacyItem.properties.itemName = legacyItem.properties.name;
    delete legacyItem.properties.name;
  }
  if (legacyItem.properties.result) {
    legacyItem.properties.decision = legacyItem.properties.result;
    delete legacyItem.properties.result;
  }
  const validateLegacy = makeValidatorFactory(legacy, 'legacy.json').byName('InspectionOrderItem');
  const legacyOk = validateLegacy(sample);
  const legacyMissing = missingPropertiesOf(validateLegacy);
  coverage.selfTest.total += 1;
  coverage.selfTest.red += legacyOk ? 0 : 1;
  check(
    '⑤ 回退旧口径 → 冻结样本必须判红（判据有牙）',
    !legacyOk && legacyMissing.includes('itemName') && legacyMissing.includes('decision'),
    { 判红: !legacyOk, 缺失字段: legacyMissing }
  );

  // 变异 1：删掉 required 里的 name
  const dropName = Object.assign({}, sample);
  delete dropName.name;
  coverage.selfTest.total += 1;
  const dropOk = validateNow(dropName);
  coverage.selfTest.red += dropOk ? 0 : 1;
  check('⑤ 变异：缺 required 字段 name → 必须判红', !dropOk, dropOk ? undefined : { 缺失字段: missingPropertiesOf(validateNow) });

  // 变异 2：枚举外取值
  const badEnum = Object.assign({}, sample, { result: '__PROBE_INVALID__' });
  coverage.selfTest.total += 1;
  const badOk = validateNow(badEnum);
  coverage.selfTest.red += badOk ? 0 : 1;
  check('⑤ 变异：result 取枚举外值 → 必须判红', !badOk, badOk ? undefined : { errors: formatErrors(validateNow) });

  // 变异 3/4：§9.5.2「覆盖不到 第 1 项」的口径级补位（库内暂无该类数据，但口径本身可验）
  const exemptSample = Object.assign({}, sample, { result: 'EXEMPT', metricCategory: 'MECHANICAL_PERFORMANCE' });
  coverage.selfTest.total += 1;
  const exemptOk = validateNow(exemptSample);
  check('⑤ 口径级补位：result=EXEMPT / metricCategory=MECHANICAL_PERFORMANCE 必须在枚举内', exemptOk, exemptOk ? undefined : { errors: formatErrors(validateNow) });

  console.log('');
  return { sample };
}
// ---------------------------------------------------------------- ⑥ 空转保护与规模提示

function layerIdleGuard(focus) {
  console.log('--- ⑥ 空转保护与规模提示 ---');
  const dataCases = focus.orderChecked + focus.itemChecked + focus.heatChecked;
  check('⑥ 断言总数 > 0（判据未空转）', checks.length > 0, { 断言数: checks.length });

  if (dataCases === 0) {
    console.log('  ⚠ 空转提醒：焦点层 0 例（库内没有可校验的数据）。');
    console.log('    本次绿只证明三件事：spec 自身一致（①）、路由已注册（②）、判据有牙（⑤）；');
    console.log('    它**不证明**服务端真实返回符合 spec —— 明细级约束只在有数据的库（本地 / 预发巡检）成立。');
  } else {
    console.log(
      '  规模提示（时刻快照，库非静止）：列表 total=' +
        focus.totalReported +
        ' 单 / 明细遍历 ' +
        focus.orderChecked +
        ' 单 / ' +
        focus.itemChecked +
        ' 条 / 炉批号 ' +
        focus.heatChecked +
        ' 组'
    );
  }
  if (MIN_CASES > 0) {
    check('⑥ 焦点层校验例数 >= ' + MIN_CASES + '（OPENAPI_CONFORMANCE_MIN_CASES）', dataCases >= MIN_CASES, { 实际: dataCases });
  } else {
    note('（未设 OPENAPI_CONFORMANCE_MIN_CASES：空转只告警不失败；有数据的库建议设 1）');
  }

  // 已知漂移：计数公示 + 销账提示 + 硬上限（不许静默放行，也不许登记表悄悄变长）
  const hits = coverage.knownDrift.hits.length;
  if (hits > 0) {
    console.log('  ⚠ 已知漂移（已登记，不判红）：' + hits + ' 处 —— ' + coverage.knownDrift.ids.join('、'));
    for (const hit of coverage.knownDrift.hits.slice(0, 5)) {
      console.log('    · ' + hit.id + ' @ ' + hit.path + ' ' + hit.schema + ' → ' + hit.pointers.join(' / '));
    }
  }
  const stale = knownDrift.entries.filter((entry) => !coverage.knownDrift.ids.includes(entry.id));
  if (stale.length > 0) {
    console.log(
      '  ⚠ 登记可销账：' + stale.map((entry) => entry.id).join('、') + ' 本轮未被命中（疑似已修好）—— '
        + '确认后从 scripts/testing/openapi-known-drift.json 删除该条，让门禁恢复零容忍'
    );
  }
  if (KNOWN_DRIFT_MAX !== undefined) {
    check('⑥ 已知漂移数 <= ' + KNOWN_DRIFT_MAX + '（OPENAPI_KNOWN_DRIFT_MAX）', hits <= KNOWN_DRIFT_MAX, { 实际: hits });
  }
  console.log('');
  return dataCases;
}

// ---------------------------------------------------------------- 汇总

function printSummary(focus, dataCases) {
  const passed = checks.filter((item) => item.ok).length;
  const failed = checks.length - passed;
  console.log('== 探针汇总 ==');
  console.log('  ① 规格自检    ：' + coverage.specSchemaCompiled + ' 个 schema 全部可编译、路径参数一致、security 已登记');
  console.log(
    '  ② 路由存在性  ：' +
      (coverage.routeProbed - coverage.routeMissing.length) +
      '/' +
      coverage.routeProbed +
      ' 个 GET 已注册' +
      (coverage.routeMissing.length > 0 ? '（**未注册 ' + coverage.routeMissing.length + ' 个**）' : '') +
      (coverage.serverErrors.length > 0 ? '（**5xx ' + coverage.serverErrors.length + ' 个**）' : '')
  );
  console.log(
    '  ③ 响应体契约  ：' +
      coverage.bodyValidated +
      ' 个操作 2xx 且逐字段符合 200 schema' +
      (coverage.bodyMismatch.length > 0 ? '（**不符 ' + coverage.bodyMismatch.length + ' 个**）' : '') +
      (coverage.knownDrift.hits.length > 0 ? '；⚠ 已知漂移 ' + coverage.knownDrift.hits.length + ' 处（已登记，待修）' : '') +
      '；未覆盖响应体 ' +
      coverage.skippedNoData.length +
      ' 个'
  );
  console.log(
    '  ④ 焦点回归    ：PaginatedInspectionOrders ' +
      focus.listPagesOk +
      '/' +
      focus.listPages +
      ' 页；InspectionOrder ' +
      focus.orderOk +
      '/' +
      focus.orderChecked +
      ' 单；InspectionOrderItem ' +
      focus.itemOk +
      '/' +
      focus.itemChecked +
      ' 条；FurnaceHeatTraceResponse ' +
      focus.heatOk +
      '/' +
      focus.heatChecked +
      ' 组'
  );
  console.log('  ⑤ 可证伪性    ：' + coverage.selfTest.red + ' 个反例被判红（判据有牙）');
  console.log('  ⑥ 空转保护    ：焦点层例数 ' + dataCases + (dataCases === 0 ? '（⚠ 空转，见上方提醒）' : ''));
  console.log('  断言合计      ：PASS ' + passed + ' / FAIL ' + failed);
  if (failed > 0) {
    console.log('  失败项        ：');
    for (const name of failures.slice(0, 20)) console.log('    - ' + name);
  }
}

function printUncovered() {
  if (coverage.skippedNoData.length === 0 && coverage.bodyMismatch.length === 0) return;
  console.log('');
  console.log('== 覆盖不到的部分（诚实记录，非失败项）==');
  const byStatus = new Map();
  for (const item of coverage.skippedNoData) {
    const key = item.status + ' ' + (item.status === 403 ? '（PBAC 拦截）' : item.status === 409 ? '（业务关卡拦截）' : '（参数/数据未命中）');
    if (!byStatus.has(key)) byStatus.set(key, []);
    byStatus.get(key).push(item.path);
  }
  for (const [key, paths] of byStatus) {
    console.log('  · ' + key + '：' + paths.join('、'));
  }
  console.log('  · 写路径（POST/PUT/PATCH）不在本探针范围内：只读探针不建单、不改状态');
  console.log('  · additionalProperties 仍为默认 true ⇒ 服务端多返回的字段不会被判红（见 docs/49 §11）');
}

// ---------------------------------------------------------------- main

async function main() {
  console.log('=== Letian QMS 契约一致性探针（spec × 真实返回 · docs/49 §11 / TBD-12）===');
  console.log('  spec : ' + path.relative(REPO_ROOT, SPEC_PATH));
  console.log('  api  : ' + API_BASE);
  console.log('  只读声明：只发 GET（外加一次开发态登录 POST /auth/login），不写库、不清库、可重复跑');
  console.log('');

  const spec = loadSpec();
  const specInfo = layerSpecSelfCheck(spec);
  if (specInfo.validate === null) {
    printSummary({ listPages: 0, listPagesOk: 0, orderOk: 0, orderChecked: 0, itemOk: 0, itemChecked: 0, heatOk: 0, heatChecked: 0, totalReported: 0 }, 0);
    return 1;
  }
  const validate = specInfo.validate;

  knownDrift = loadKnownDrift();
  if (knownDrift.entries.length > 0) {
    console.log(
      '已知漂移登记：' +
        knownDrift.entries.length +
        ' 条（' +
        knownDrift.entries.map((entry) => entry.id).join('、') +
        '）—— 命中不判红，但逐条公示'
    );
    console.log('');
  }

  const server = await ensureServer();
  if (server.unreachable || (server.started && !server.healthy)) {
    console.error('前置失败：服务端不可用（' + HEALTH_URL + ' 未响应）。');
    if (server.started) {
      console.error('自启日志尾部：');
      console.error(server.log.split('\n').slice(-12).join('\n'));
    } else {
      console.error('请先执行 pnpm dev:api，或检查 OPENAPI_AUTOSTART / DATABASE_URL。');
    }
    return 2;
  }
  console.log(server.started ? '服务端：本探针自行拉起（' + HEALTH_URL + ' 已就绪）' : '服务端：复用已在线的实例');
  console.log('');

  const login = await httpJson('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: OPERATOR_ID }),
  });
  token = login.body && login.body.token ? login.body.token : '';
  if (token === '') {
    console.error('前置失败：开发态登录失败（NODE_ENV=production 时 /auth/login 不注册）。响应：' + JSON.stringify(login.body));
    return 2;
  }
  check('前置：开发态登录成功', true, { operatorId: OPERATOR_ID });
  console.log('');

  await layerRouteAndBody(spec, validate);
  const focus = await layerFocusRegression(validate);
  layerJudgeSelfTest(spec, validate);
  const dataCases = layerIdleGuard(focus);

  printSummary(focus, dataCases);
  printUncovered();
  console.log('');
  const failed = checks.filter((item) => !item.ok).length;
  console.log(failed === 0 ? '结论：全部断言通过（退出码 0）' : '结论：存在 ' + failed + ' 项失败（退出码 1）');
  return failed === 0 ? 0 : 1;
}

process.on('SIGINT', () => {
  killServerChild();
  process.exit(130);
});

main()
  .then((code) => {
    killServerChild();
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('PROBE ERROR: ' + (err && err.stack ? err.stack : err));
    killServerChild();
    process.exitCode = 2;
  });
