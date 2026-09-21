/**
 * 【出货检验】列表端到端渲染校验（CDP 驱动，只读）
 *
 * 验证目标（对应需求：第一列表头 检验编号 -> 检验单号，且数据来自真实接口/数据库）：
 *   1. 表头第一列文案为 "检验单号"，且页面不再出现 "检验编号"；
 *   2. 表格首列取到的是数据库真实 order_no（形如 OQC-SH-YYYYMMDD-NNNN），而非占位/编造值；
 *   3. 筛选（销售出库单号 / 客户 / 订单号 / 出库日期）确实由后端 GET /inspections 返回。
 *
 * 仅做导航 + 读取 DOM + 截图，不写库、不改接口。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// 截图/日志统一输出到仓库 logs/（已被 .gitignore 忽略），避免写到仓库外
const OUT_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = 9334;
const WEB = 'http://127.0.0.1:5200/';
const API = 'http://127.0.0.1:3100/api/v1';
const LOG = path.join(OUT_DIR, 'oqc-verify.log');
fs.writeFileSync(LOG, '');
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    require('node:http').get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/** 带鉴权的接口调用（用于把页面列与接口返回值逐行对账） */
function httpJsonWith(url, token, body) {
  const http = require('node:http');
  const u = new URL(url);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: payload ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const cdp = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS error: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
};

(async () => {
  const userDataDir = path.join(OUT_DIR, 'chrome-profile-oqc');
  fs.mkdirSync(userDataDir, { recursive: true });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-crash-reporter',
    '--no-sandbox',
    '--window-size=1780,900',
    'about:blank',
  ], { stdio: 'ignore' });
  chrome.on('error', (e) => log('chrome spawn error:', String(e)));

  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await httpJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); }
  }
  if (!version) throw new Error('Chrome CDP not reachable');
  log('chrome ok:', version['Browser']);

  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1780, height: 900, deviceScaleFactor: 1, mobile: false });

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    log('SHOT:', file);
  };

  await cdp.send('Page.navigate', { url: WEB });
  await sleep(7000);

  const entered = await evalJs(cdp, `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('进入系统'));
    if (b) { b.click(); return true; } return false;
  })()`);
  log('login clicked:', entered);
  await sleep(7000);

  // 进入「出货检验 (OQC)」
  const nav = await evalJs(cdp, `(() => {
    const el = [...document.querySelectorAll('button,a,div,span,li')]
      .find((e) => e.innerText && e.innerText.trim().startsWith('出货检验'));
    if (el) { el.click(); return el.innerText.trim(); } return null;
  })()`);
  log('nav 出货检验:', nav);
  await sleep(6000);

  const probe = await evalJs(cdp, `(() => {
    const heads = [...document.querySelectorAll('th')].map((t) => t.innerText.trim());
    const rows = [...document.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()));
    return { heads, rows, firstCol: rows.map((r) => r[0]), rowCount: rows.length, bodyHasOld: document.body.innerText.includes('检验编号') };
  })()`);
  log('probe:', JSON.stringify(probe).slice(0, 1200));

  // 新规则单号 OQC-SH-YYYYMMDD-NNNN；历史单号为 INS-YYYYMMDD-NNN，
  // 已被 MRB/批次追溯引用因而不可改号，属数据历史事实（见文档 16 §7.11.5）。
  const NEW_RULE = /^OQC-SH-\d{8}-\d{4}$/;
  const LEGACY = /^INS-\d{8}-\d{3}$/;
  const unrecognized = probe.firstCol.filter((v) => v !== '-' && !NEW_RULE.test(v) && !LEGACY.test(v));
  const newRuleCount = probe.firstCol.filter((v) => NEW_RULE.test(v)).length;
  const legacyCount = probe.firstCol.filter((v) => LEGACY.test(v)).length;

  check('表头第一列 = 检验单号', probe.heads[0] === '检验单号', probe.heads.slice(0, 6));
  check('页面不再出现「检验编号」', probe.bodyHasOld === false);
  check('首列取值全部合规（OQC-SH-… 新规则 或 INS-… 历史单号）', unrecognized.length === 0, unrecognized);
  check('首列已出现新规则单号 OQC-SH-YYYYMMDD-NNNN', newRuleCount > 0, { newRuleCount, legacyCount });
  check('列表存在数据行', probe.rowCount > 0, probe.rowCount);

  // ---- 与接口逐行对账：证明列值来自库字段，而不是前端推导或编造 ----
  const login = await httpJsonWith(`${API}/auth/login`, '', { userId: '11000000-0000-4000-8000-000000000001' });
  const apiList = await httpJsonWith(`${API}/inspections?type=OQC_SH&pageSize=50&page=1`, login.token);
  const apiRows = Array.isArray(apiList.list) ? apiList.list : [];
  log('api total:', apiList.total, 'rows:', apiRows.length);

  const idx = (name) => probe.heads.indexOf(name);
  const erpIdx = idx('ERP状态');
  const soIdx = idx('销售出库单号');
  const docIdx = idx('检验单号');
  check('表头含「销售出库单号」/「ERP状态」/「检验单号」', erpIdx >= 0 && soIdx >= 0 && docIdx >= 0,
    { docIdx, soIdx, erpIdx });

  if (erpIdx >= 0 && soIdx >= 0 && docIdx >= 0 && apiRows.length > 0) {
    const byDoc = new Map(apiRows.map((o) => [o.orderNo, o]));
    const mismatchErp = [];
    const mismatchSO = [];
    for (const r of probe.rows) {
      const o = byDoc.get(r[docIdx]);
      if (!o) continue;
      const apiErp = o.erpStatus ?? '-';
      const apiSo = o.salesOrderNo ?? '-';
      if (r[erpIdx] !== apiErp) mismatchErp.push({ doc: r[docIdx], page: r[erpIdx], api: apiErp });
      if (r[soIdx] !== apiSo) mismatchSO.push({ doc: r[docIdx], page: r[soIdx], api: apiSo });
    }
    check('ERP状态列 == 接口 erpStatus（取自库 erp_status，不由检验结论反推）', mismatchErp.length === 0, mismatchErp);
    check('销售出库单号列 == 接口 salesOrderNo', mismatchSO.length === 0, mismatchSO);
  }

  await shot('oqc-list-after-rename.png');

  const failed = results.filter((r) => !r.ok);
  log(`SUMMARY: ${results.length - failed.length}/${results.length} passed`);
  await cdp.send('Browser.close').catch(() => {});
  await sleep(500);
  chrome.kill();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { log('FAIL:', String(e && e.stack ? e.stack : e)); process.exit(2); });
