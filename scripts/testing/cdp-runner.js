/**
 * 七大业务流程前端走查（Chrome DevTools Protocol 驱动）
 *
 * 前置：Web dev server 已启动（默认自动探测 31100 -> 31101 -> 31102，或由 WEB_BASE 指定）。
 * 若 9222 上没有可连接的 Chrome，本脚本会自行以无头模式拉起一个再跑（用完关闭）。
 *
 * 退出码：0 = 7 项用例全部通过且无未捕获运行时异常；1 = 存在失败项或致命异常；2 = 环境不可用。
 *
 * 说明：旧版脚本（仓库外）在任何用例失败时**仍以 0 退出**，因此「7 大业务流全部 PASSED」
 * 这一结论无法被证伪；本版把判定与退出码绑定，并同时把控制台未捕获异常纳入判定。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const OUT_DIR = path.resolve(__dirname, '..', 'logs');
const SHOT_DIR = path.resolve(__dirname, '..', '..', 'docs', 'screenshots');
const LOG = path.join(OUT_DIR, 'cdp-runner.log');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(LOG, '');

const say = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WEB_CANDIDATES = process.env.WEB_BASE
  ? [process.env.WEB_BASE]
  : ['http://127.0.0.1:31100/', 'http://127.0.0.1:31101/', 'http://127.0.0.1:31102/'];

/** 端口探测：只看状态码（首页返回 HTML，不能按 JSON 解析） */
function probeHttp(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 400) resolve(res.statusCode);
      else reject(new Error('status ' + res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

/** CDP 的 HTTP 端点返回 JSON */
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

async function resolveWebBase() {
  for (const base of WEB_CANDIDATES) {
    try { await probeHttp(new URL('/', base).href); return base; } catch { /* 试下一个 */ }
  }
  throw new Error('前端未监听，候选地址均不可用: ' + WEB_CANDIDATES.join(', '));
}

/** 9222 上没有 Chrome 时自行拉起（无头），返回进程句柄以便收尾关闭 */
async function ensureChrome() {
  try {
    await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    say(`[CDP] 复用已存在的调试实例 (127.0.0.1:${CDP_PORT})`);
    return null;
  } catch { /* 需要自行拉起 */ }

  const userDataDir = path.join(OUT_DIR, 'chrome-profile-cdp');
  fs.mkdirSync(userDataDir, { recursive: true });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-crash-reporter',
    '--no-sandbox',
    '--window-size=1780,1100',
    'about:blank',
  ], { stdio: 'ignore' });

  for (let i = 0; i < 60; i++) {
    try { await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`); say('[CDP] 已自行拉起无头 Chrome'); return chrome; }
    catch { await sleep(500); }
  }
  chrome.kill();
  throw new Error(`无法在 127.0.0.1:${CDP_PORT} 建立 Chrome 调试连接`);
}

class CDPClient {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 1; this.callbacks = new Map(); this.events = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        msg.error ? reject(msg.error) : resolve(msg.result);
      } else if (msg.method) {
        (this.events.get(msg.method) || []).forEach((h) => h(msg.params));
      }
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, handler) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(handler);
  }
  close() { if (this.ws) this.ws.close(); }
}

async function main() {
  say('=== 七大业务流程前端走查（CDP） ===');
  const webBase = await resolveWebBase();
  say(`[CDP] 前端地址: ${webBase}`);

  const spawnedChrome = await ensureChrome();

  const targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) throw new Error('未找到可连接的页面 target');

  const client = new CDPClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');
  await client.send('Network.enable');

  const consoleLogs = [];
  const errors = [];
  client.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    consoleLogs.push(`[${p.type}] ${text}`);
    if (p.type === 'error') errors.push(text);
  });
  client.on('Runtime.exceptionThrown', (p) => {
    const text = p.exceptionDetails.text + (p.exceptionDetails.exception ? ': ' + (p.exceptionDetails.exception.description || '') : '');
    errors.push(`[Exception] ${text}`);
  });

  const evalInPage = async (expression) => {
    const res = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'Eval error');
    return res.result ? res.result.value : undefined;
  };

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const takeScreenshot = async (name) => {
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    say(`[CDP 截图] ${file}`);
  };

  say('[CDP] 导航到应用入口并等待就绪...');
  await client.send('Page.navigate', { url: webBase });
  await sleep(6000);

  // 登录（若已在登录页）
  const loginClicked = await evalInPage(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('进入系统'));
    if (b) { b.click(); return true; } return false;
  })()`);
  say('[CDP] 登录页点击:', loginClicked);
  await sleep(6000);

  const results = [];
  const record = (name, passed, detail) => {
    results.push({ name, passed });
    say(`${passed ? 'PASS' : 'FAIL'} :: ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
  };

  /** 侧栏为状态式导航（无 URL 路由），点"最深"匹配节点，避免点到外层容器而原地不动 */
  const clickNav = async (keyword) => evalInPage(`(() => {
    const matches = [...document.querySelectorAll('a,button,li,span,div')]
      .filter((el) => el.innerText && el.innerText.trim().includes(${JSON.stringify(keyword)}));
    if (matches.length === 0) return null;
    const deep = matches.reduce((best, el) => (el.innerText.trim().length <= best.innerText.trim().length ? el : best));
    const target = deep.closest('a,button') || deep;
    target.click();
    return target.innerText.trim();
  })()`);

  const bodyText = () => evalInPage('document.body.innerText');

  // 1. 系统导航与主骨架
  try {
    const title = await evalInPage('document.title');
    const navItems = await evalInPage(`[...document.querySelectorAll('nav a, aside a, aside button, aside div, nav button')].map((a) => a.innerText.trim()).filter(Boolean)`);
    await takeScreenshot('screenshot_01_dashboard');
    record('系统导航与基础架构加载', Boolean(title) && navItems.length >= 10, { title, navCount: navItems.length });
  } catch (err) { record('系统导航与基础架构加载', false, err.message); }

  // 2. 检验进度总览：KPI 卡 + ECharts
  try {
    const text = await bodyText();
    const canvasCount = await evalInPage('document.querySelectorAll("canvas").length');
    const hasKpi = ['总检验单数', '待检验', '合格率', '综合合格率'].some((k) => text.includes(k));
    record('检验进度总览 KPI 与 ECharts 渲染', hasKpi && canvasCount > 0, { canvasCount, hasKpi });
  } catch (err) { record('检验进度总览 KPI 与 ECharts 渲染', false, err.message); }

  // 3. 来料检验 (IQC) 台账
  try {
    const nav = await clickNav('来料检验');
    await sleep(4000);
    const text = await bodyText();
    const heads = await evalInPage(`[...document.querySelectorAll('th')].map((t) => t.innerText.trim())`);
    const rows = await evalInPage('document.querySelectorAll("tbody tr").length');
    await takeScreenshot('screenshot_02_iqc');
    record('来料检验台账模块', nav !== null && heads.includes('检验单号') && heads.includes('入库单号') && rows > 0,
      { nav, rows, headSample: heads.slice(0, 4) });
  } catch (err) { record('来料检验台账模块', false, err.message); }

  // 4. 出货检验 (OQC) 台账
  try {
    const nav = await clickNav('出货检验');
    await sleep(4000);
    const heads = await evalInPage(`[...document.querySelectorAll('th')].map((t) => t.innerText.trim())`);
    const rows = await evalInPage('document.querySelectorAll("tbody tr").length');
    await takeScreenshot('screenshot_03_oqc');
    record('出货检验台账模块', nav !== null && heads[0] === '检验单号' && rows > 0, { nav, rows, firstHead: heads[0] });
  } catch (err) { record('出货检验台账模块', false, err.message); }

  // 5. MRB 不合格品评审与处置
  try {
    const nav = await clickNav('MRB不合格品处置');
    await sleep(4000);
    const text = await bodyText();
    const hasMrb = ['评审', '不合格', 'MRB'].some((k) => text.includes(k));
    await takeScreenshot('screenshot_04_mrb');
    record('MRB 不合格品评审模块', nav !== null && hasMrb, { nav });
  } catch (err) { record('MRB 不合格品评审模块', false, err.message); }

  // 6. 质量追溯看板
  try {
    const nav = await clickNav('质量追溯看板');
    await sleep(4000);
    const hasInput = await evalInPage('document.querySelectorAll("input").length > 0');
    await takeScreenshot('screenshot_05_traceability');
    record('批次双向追溯与血缘模块', nav !== null && hasInput, { nav, hasInput });
  } catch (err) { record('批次双向追溯与血缘模块', false, err.message); }

  // 7. 质检方案设计
  try {
    const nav = await clickNav('质检方案设计');
    await sleep(4000);
    const text = await bodyText();
    const hasPlan = ['方案', '抽样', 'AQL', '版本'].some((k) => text.includes(k));
    await takeScreenshot('screenshot_06_plans');
    record('检验方案与抽样标准模块', nav !== null && hasPlan, { nav });
  } catch (err) { record('检验方案与抽样标准模块', false, err.message); }

  const fatalErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('React DevTools'));
  say('');
  say(`=== 控制台审计 === 日志 ${consoleLogs.length} 条，未捕获异常 ${fatalErrors.length} 条`);
  fatalErrors.forEach((e) => say('  ✗ ' + e));

  const failed = results.filter((r) => !r.passed);
  say('');
  say(`=== 汇总 === ${results.length - failed.length}/${results.length} 通过，未捕获异常 ${fatalErrors.length} 条`);
  failed.forEach((f) => say(`  ✗ ${f.name}`));

  client.close();
  if (spawnedChrome) { spawnedChrome.kill(); }

  const ok = failed.length === 0 && fatalErrors.length === 0;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('走查运行异常:', err && err.stack ? err.stack : err);
  process.exit(2);
});
