/**
 * 真库形态自检（dev-mode check）—— 我起的这个前端，是「真连后端写库」还是「离线 Mock 演示」？
 *
 * 为什么需要：本机有两种前端启动方式，界面长得一模一样，但「保存」的去向完全不同：
 *   pnpm dev:all / pnpm dev             -> Vite :31100 把 /api 反代到真实 API :3100 -> 写真库（MSW 关闭）
 *   pnpm dev:mock（vite --mode mock）   -> 载入 apps/web/.env.mock（VITE_USE_MOCK=true）-> MSW 拦截 -> 只写浏览器内存
 * 两者**端口相同**（.env.mock 里 VITE_PORT 也是 31100），因此端口号不能作为判据；docs/35 §R7 记过一次真实事故：
 * 探针打到了"看起来一样"的真实后端代理实例，把库里一条 MRB 从 UNDER_REVIEW 改成了 DISPOSED。
 *
 * 本脚本**只读**（不写库、不改业务数据、不点保存），四条结论全部来自运行期证据，而不是读配置文件：
 *   ① 形态：取 dev server 下发的 GET /src/mocks/browser.ts（Vite 转换后的**真实模块**），解析其中被注入的
 *      import.meta.env = {...} 字面量 —— MODE / VITE_USE_MOCK 一眼可判；
 *   ② MSW：同一个模块里 isMockEnabled() 的判据值（VITE_USE_MOCK 缺失或非 'true' 即不会启用 MSW）；
 *   ③ 代理：经前端同源发 GET /api/v1/inspections（不带令牌）→ 必须是真实后端的 401 + application/problem+json；
 *   ④ 落库：登录后取接口返回的单号集合，与 PostgreSQL 直查的单号集合对账（接口返回的单号必须都在库里）。
 * 另附加：扫描 :31100/:31101/:31102 上**所有**在跑的前端实例并逐个标注形态 —— 误起 Mock 时立刻能看见。
 *
 * 用法：pnpm verify:dev-mode
 *      $env:WEB_BASE="http://127.0.0.1:31101"; pnpm verify:dev-mode     # 指定实例
 * 退出码：0 = 所选实例为真库形态且 ①②③④ 全通过；1 = 存在 FAIL（例如这就是 Mock 实例）；3 = 没有前端 dev server 在跑。
 */
const fs = require('node:fs');
const path = require('node:path');

const OUT_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(OUT_DIR, { recursive: true });
const LOG = path.join(OUT_DIR, 'dev-mode-check.log');
fs.writeFileSync(LOG, '');

const log = (...args) => {
  const line = args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};

const PORTS = [31100, 31101, 31102];
const TIMEOUT_MS = 6000;
const DB_URL =
  process.env.DATABASE_URL || 'postgresql://letian_user:letian_secure_pass_2026@127.0.0.1:5433/letian_qms_db';
/** 张强 · QA_MANAGER（读取范围最宽，用于把接口返回与库内行对账） */
const MAIN_USER = '11000000-0000-4000-8000-000000000001';
const PROBE_TYPE = process.env.PROBE_TYPE || 'OQC_SH';

let checks = 0;
let failures = 0;
function check(name, ok, evidence) {
  checks++;
  if (!ok) failures++;
  log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
  if (evidence !== undefined) {
    log(`       evidence: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* HTML / 源码文本保持原样 */
    }
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      body,
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** pg 依赖解析：scripts/ 不是工作区包，回退到 pnpm 存储目录（与其它探针同一写法） */
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
    if (entry === undefined) throw new Error('未找到 pg 依赖，无法执行数据库对账');
    return require(path.join(store, entry, 'node_modules', 'pg'));
  }
}

async function dbOrderNos(type) {
  const { Client } = resolvePg();
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    const res = await db.query('SELECT order_no FROM inspection_orders WHERE order_type = $1', [type]);
    return new Set(res.rows.map((row) => row.order_no));
  } finally {
    await db.end();
  }
}

/**
 * 读一个前端实例的「形态」：取 Vite 下发的 mocks 模块，解析被注入的 import.meta.env 字面量。
 * 这一步看的是**浏览器真正会执行的代码**（dev server 现算的转换结果），不是 .env 文件。
 */
async function inspectInstance(base) {
  const out = { base, reachable: false, mode: null, useMock: null, dev: null, note: '' };
  let res;
  try {
    res = await request(`${base}/src/mocks/browser.ts`);
  } catch (err) {
    out.note = `不可达（${err.message}）`;
    return out;
  }
  out.reachable = true;
  if (res.status !== 200) {
    out.note = `非 Vite dev server（/src/mocks/browser.ts 返回 ${res.status}）；构建产物请改用 build 产物判别法`;
    return out;
  }
  const matched = String(res.text).match(/import\.meta\.env\s*=\s*(\{[^}]*\})/);
  if (matched === null) {
    out.note = '未找到被注入的 import.meta.env 字面量（Vite 版本口径可能变化，需人工确认）';
    return out;
  }
  const env = JSON.parse(matched[1]);
  out.mode = env.MODE ?? null;
  out.useMock = env.VITE_USE_MOCK ?? null;
  out.dev = env.DEV ?? null;
  return out;
}

function verdictOf(instance) {
  if (!instance.reachable) return '未监听';
  if (instance.mode === null) return 'UNKNOWN（需人工确认）';
  if (instance.useMock === 'true' || instance.mode === 'mock') return 'MOCK · 演示模式（只写浏览器内存）';
  return 'REAL · 真库形态（经 :3100 写真库）';
}

(async () => {
  const explicit = process.env.WEB_BASE;
  log('=== 真库形态自检（dev-mode check）===');
  log(`扫描 :${PORTS.join(' / :')}${explicit ? `；WEB_BASE 指定 ${explicit}` : ''}`);
  log('');

  const instances = [];
  for (const port of PORTS) {
    const instance = await inspectInstance(`http://127.0.0.1:${port}`);
    instance.port = port;
    instances.push(instance);
  }

  log('--- 本机前端实例形态一览（逐个标注）---');
  for (const instance of instances) {
    log(
      `  :${instance.port}  MODE=${String(instance.mode)}  VITE_USE_MOCK=${String(instance.useMock)}` +
        `  -> ${verdictOf(instance)}${instance.note ? `  [${instance.note}]` : ''}`
    );
  }
  log('');

  const live = instances.filter((x) => x.reachable);
  if (live.length === 0) {
    log('没有找到任何前端 dev server。正确启动方式：pnpm dev:all（API :3100 + 前端 :31100）');
    process.exit(3);
  }

  let target = live.find((x) => x.base === explicit && explicit !== undefined);
  if (target === undefined) target = live.find((x) => verdictOf(x).startsWith('REAL'));
  if (target === undefined) target = live[0];
  log(`受检实例：${target.base}（${verdictOf(target)}）`);
  log('');

  // ① 形态：MODE 不得是 mock
  check(
    '① 前端形态不是 mock 模式（MODE !== "mock"）',
    target.mode !== null && target.mode !== 'mock',
    `MODE=${String(target.mode)}`
  );
  // ② MSW 未启用：VITE_USE_MOCK 既不能是 'true'，也不能出现在注入的 env 字面量里
  check(
    "② MSW 未启用（VITE_USE_MOCK 不是 'true'）",
    target.useMock !== 'true',
    `VITE_USE_MOCK=${JSON.stringify(target.useMock)}（未设置时为 null）`
  );

  // ③ 经前端同源打到真后端：401 + RFC7807 problem+json
  const denied = await request(`${target.base}/api/v1/inspections?inspectionType=${PROBE_TYPE}&pageSize=1&page=1`);
  const isProblemJson = denied.contentType.includes('problem+json');
  check(
    '③ 经前端同源请求 /api/v1 得到真实后端的 401 + application/problem+json',
    denied.status === 401 && isProblemJson,
    `status=${denied.status} content-type=${denied.contentType} traceId=${
      typeof denied.body === 'object' && denied.body !== null ? denied.body.traceId : 'n/a'
    }`
  );

  // ④ 接口返回的单号必须都在 PostgreSQL 里（Mock 演示单号会在这里露馅）
  const login = await request(`${target.base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: MAIN_USER }),
  });
  if (login.status !== 200 || typeof login.body !== 'object' || login.body === null) {
    check('④ 开发态登录取令牌', false, `status=${login.status} body=${JSON.stringify(login.body).slice(0, 160)}`);
  } else {
    const token = login.body.token;
    const listed = await request(
      `${target.base}/api/v1/inspections?inspectionType=${PROBE_TYPE}&pageSize=100&page=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const items = Array.isArray(listed.body?.items) ? listed.body.items : [];
    const apiOrderNos = items.map((row) => row.orderNo);
    const dbOrderNosSet = await dbOrderNos(PROBE_TYPE);
    const notInDb = apiOrderNos.filter((orderNo) => !dbOrderNosSet.has(orderNo));
    check(
      '④ 接口返回的检验单号全部存在于 PostgreSQL（证明前端 -> API -> 真库同一条链）',
      listed.status === 200 && apiOrderNos.length > 0 && notInDb.length === 0,
      `${PROBE_TYPE}: 接口 ${apiOrderNos.length} 条 / total=${listed.body?.total} / 库内 ${dbOrderNosSet.size} 行` +
        (notInDb.length > 0 ? `；不在库内：${notInDb.slice(0, 5).join(', ')}` : '')
    );
  }

  log('');
  log(`=== ${failures === 0 ? 'PASS' : 'FAIL'}：${checks - failures}/${checks} 通过 ===`);
  const targetIsMock = target.useMock === 'true' || target.mode === 'mock';
  if (targetIsMock) {
    log('提示：受检实例是 MOCK —— 请改用 pnpm dev:all（前端 :31100 + API :3100，真连 PostgreSQL）。');
    log('     离线 Mock 只用于后端未启动时的界面走查，保存不会落库。');
    log('     注意：③④ 在这里通过**不代表页面会写库** —— MSW 只在浏览器里拦截，');
    log('     服务端（本脚本）经 Vite 代理仍会打到真实后端，所以判据只能是 ①② 的模块形态。');
  } else if (failures > 0) {
    log('提示：形态不是 mock 但有断言未通过，请按上面每条的 evidence 排查（③ 多为 API 未启动，④ 多为库未迁移/播种）。');
  } else {
    log('结论：受检实例是真库形态 —— 页面上的「保存」会经 :3100 写进 PostgreSQL。');
    log('      点保存后立刻查库：pnpm db:recent（等价 psql 查 inspection_orders 最近 5 行）。');
  }
  await sleep(50);
  process.exit(failures === 0 ? 0 : 1);
})();
