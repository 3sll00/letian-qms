/**
 * leftovers2 离线 Mock（MSW）冒烟：验证 Mock 路由在真实浏览器运行时可用 ——
 *   GET /api/v1/master-data/company-profile（证书抬头数据源）、POST /api/v1/inspections/:id/approve。
 *   `PUT /master-data/company-profile` 的路由保留（与真实 API 同形），但其维护界面已于 2026-09-23 下线
 *   （见 docs/实施进度 §47），故不再有页面调用方，本探针只断侧边栏菜单已消失与 GET 路由仍生效。
 *
 * 前置：`$env:VITE_API_TARGET="http://127.0.0.1:5999"; pnpm --filter @letian/web run dev:mock`
 *   （前端 :5200，不需要数据库；5999 是**未监听**端口 —— 未 mock 的接口若打到真实后端会 401，
 *     前端安全登出会把人踢回登录页，走查结论随即失真）
 * 用法：`pnpm verify:leftovers2:mock`
 * 产物：scripts/logs/leftovers2-mock-probe.log
 * 口径：Mock 数据只活在浏览器内存里，不写数据库，跑完**不需要** `pnpm db:seed` 复位。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = path.join(__dirname, '..', 'logs');
const PORT = 9342;
const WEB = 'http://127.0.0.1:5200/';
const LOG = path.join(OUT_DIR, 'leftovers2-mock-probe.log');
fs.writeFileSync(LOG, '');
const log = (...a) => { const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); fs.appendFileSync(LOG, line + '\n'); console.log(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { reject(e); } }); });
    req.on('error', reject);
  });
}
/** 可达性探测：只关心「端口上有没有服务在应答」，不要求响应体是 JSON（vite dev server 首页是 HTML） */
function httpReachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const cdp = new Cdp(ws);
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && cdp.pending.has(m.id)) { const { resolve, reject } = cdp.pending.get(m.id); cdp.pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
    return cdp;
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
}
async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS error: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}
const results = [];
const check = (name, ok, detail) => { results.push(ok); log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`); };

(async () => {
  // 前置检查：dev:mock 必须在 :5200 上，否则给出明确提示，而不是让 Chrome 空等到超时
  if (!(await httpReachable(WEB))) {
    console.error(`PROBE ERROR: ${WEB} 不可达 —— 请先运行 pnpm --filter @letian/web run dev:mock`);
    process.exit(3);
  }

  const userDataDir = path.join(OUT_DIR, 'chrome-profile-mock-probe');
  fs.mkdirSync(userDataDir, { recursive: true });
  const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-crash-reporter', '--no-sandbox', '--window-size=1780,1400', 'about:blank'], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 60; i++) { try { version = await httpJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); } }
  if (!version) throw new Error('Chrome CDP not reachable');
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.body.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1780, height: 1400, deviceScaleFactor: 1, mobile: false });

  const clickNav = async (label) => evalJs(cdp, `(() => {
    const ms = [...document.querySelectorAll('button,a,div,span,li')].filter((e) => e.innerText && e.innerText.trim().startsWith(${JSON.stringify(label)}));
    if (ms.length === 0) return null;
    const deep = ms.reduce((best, e) => (e.innerText.trim().length <= best.innerText.trim().length ? e : best));
    (deep.closest('a,button') || deep).click();
    return (deep.closest('a,button') || deep).innerText.trim();
  })()`);
  // 从「未登录」起步，理由同真实库探针：浏览器用户目录复用，残留会话会让顶栏身份串台
  try {
    await cdp.send('Storage.clearDataForOrigin', { origin: new URL(WEB).origin, storageTypes: 'all' });
  } catch { /* 忽略 */ }
  await cdp.send('Page.navigate', { url: WEB });
  await sleep(9000);
  log('login:', await evalJs(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('进入系统')); if(b){b.click();return true;} return false; })()`));
  await sleep(9000);
  if (!(await evalJs(cdp, `document.querySelector('header') !== null`))) {
    console.error('PROBE ERROR: 点击「进入系统」后仍停在登录页。');
    console.error('  最常见原因：dev:mock 未隔离真实后端 —— 未被 mock 的接口打到真实 API 后返回 401，');
    console.error('  前端的安全登出逻辑会立刻清掉会话、退回登录页（走查结论因此不可信）。');
    console.error('  正确启动方式（VITE_API_TARGET 指向未监听端口）：');
    console.error('    $env:VITE_API_TARGET="http://127.0.0.1:5999"; pnpm --filter @letian/web run dev:mock');
    process.exit(3);
  }

  // ---------- Mock GET /master-data/company-profile（维护界面已于 2026-09-23 下线） ----------
  // 原「ERP基础档案 → 存货档案 → 企业档案页签」与【系统管理 → 企业档案】菜单均已删除（见 docs/实施进度 §47）；
  // 证书链路仍读这条 Mock 路由，故改为「断菜单已消失 + 页内 fetch 直验 GET 路由」。
  const navSnapshot = await evalJs(cdp, `(() => {
    const navText = [...document.querySelectorAll('aside nav button, aside nav a')].map((e) => e.innerText.trim());
    return { hasCompanyProfile: navText.some((t) => t.includes('企业档案')), hasErpGroup: navText.some((t) => t.includes('ERP基础档案')) };
  })()`);
  check('侧边栏无「企业档案」菜单与「ERP基础档案」分组（维护界面已下线）',
    navSnapshot.hasCompanyProfile === false && navSnapshot.hasErpGroup === false, navSnapshot);

  const mockProfile = await evalJs(cdp, `(async () => {
    const res = await fetch('/api/v1/master-data/company-profile');
    if (!res.ok) return { status: res.status };
    const body = await res.json();
    return { status: res.status, legalName: body === null ? null : body.legalName };
  })()`);
  check('Mock GET /master-data/company-profile 仍生效：返回 mockCompanyProfile 法定名称（证书抬头数据源）',
    mockProfile !== null && mockProfile.status === 200 && mockProfile.legalName === '宁波乐天紧固件制造有限公司', mockProfile);

  // ---------- Mock POST /inspections/:id/approve ----------
  log('nav 来料检验:', await clickNav('来料检验(IQC)'));
  await sleep(4500);
  const opened = await evalJs(cdp, `(() => {
    for (const tr of document.querySelectorAll('table tbody tr')) {
      const b = [...tr.querySelectorAll('button,a')].find((x) => ['检验', '继续'].includes(x.innerText.trim()));
      if (b) { b.click(); return b.innerText.trim(); }
    }
    return 'no-row';
  })()`);
  log('open row:', opened);
  await sleep(5500);
  // 按钮文案随签核状态变化（未签核 = 质量负责人签核 / 已签核 = 重新签核）：按真实文案点击
  const approveClicked = await evalJs(cdp, `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /质量负责人签核|重新签核/.test(x.innerText));
    if (!b) return 'no-button';
    b.click();
    return b.innerText.trim();
  })()`);
  await sleep(3000);
  const approveProbe = await evalJs(cdp, `(() => {
    const s = document.querySelector('[data-testid="approval-state"]');
    const text = s ? s.innerText.trim() : null;
    const m = text === null ? null : /已由\s*([^\s]+)\s*签核/.exec(text);
    const header = document.querySelector('header');
    return { approveState: text, approverName: m ? m[1].trim() : null, headerText: header ? header.innerText.split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean) : [] };
  })()`);
  check('Mock POST /inspections/:id/approve 生效：签核人 = 页面顶栏当前登录用户，且签核时间由服务端回吐',
    (approveClicked === '质量负责人签核' || approveClicked === '重新签核') && typeof approveProbe.approveState === 'string'
      && approveProbe.approverName !== null && approveProbe.headerText.includes(approveProbe.approverName)
      && approveProbe.approveState.includes('签核') && /\d{4}\/\d{1,2}\/\d{1,2}/.test(approveProbe.approveState),
    { approveClicked, ...approveProbe });

  chrome.kill();
  log(`SUMMARY: ${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('PROBE ERROR:', e); process.exit(2); });
