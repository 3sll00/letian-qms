/**
 * 来料检验 (IQC) / 委外检验 / 出货检验 (OQC) 台账端到端渲染校验（CDP 驱动，只读）
 *
 * 验证目标（对应"字段是否真的与数据库/接口打通"这条主线）：
 *   1. 与后端 `GET /inspections` 的命中总数一致（页面条数必须是接口口径，不是前端二次过滤后的长度）；
 *   2. 列表列值只来自库中真实字段：缺失显示 '-'，
 *      **不得出现由其它字段推导出来的伪造值**（如来料检验的 `RK-` + 检验单号）；
 *   3. 表头列名符合台账规范。
 *
 * 仅做导航 + 读取 DOM + 调用只读接口，不写库、不改接口。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// 截图/日志统一输出到仓库 logs/（已被 .gitignore 忽略），避免写到仓库外
const OUT_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = 9335;
const WEB = 'http://127.0.0.1:5200/';
const API = 'http://127.0.0.1:3100/api/v1';
const LOG = path.join(OUT_DIR, 'inspections-verify.log');
fs.writeFileSync(LOG, '');
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
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

/** 调用真实接口取命中总数，用来和页面显示条数对账 */
async function apiTotal(token, qs) {
  const res = await httpJson(`${API}/inspections?${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.body.total;
}

(async () => {
  // 1. 先拿一个真实接口的命中总数作为对账基准
  const login = await httpJson(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '11000000-0000-4000-8000-000000000001' }),
  });
  const token = login.body.token;
  const expectedIqc = await apiTotal(token, 'type=IQC&pageSize=1');
  const expectedOutsource = await apiTotal(token, 'inspectionType=OQC_SF&pageSize=1');
  log('api baseline:', { expectedIqc, expectedOutsource });

  const userDataDir = path.join(OUT_DIR, 'chrome-profile-inspections');
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
    '--window-size=1780,1100',
    'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await httpJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); }
  }
  if (!version) throw new Error('Chrome CDP not reachable');

  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.body.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1780, height: 1100, deviceScaleFactor: 1, mobile: false });

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    log('SHOT:', file);
  };

  await cdp.send('Page.navigate', { url: WEB });
  await sleep(7000);
  await evalJs(cdp, `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('进入系统'));
    if (b) { b.click(); return true; } return false;
  })()`);
  await sleep(7000);

  // 侧栏是状态式导航（无 URL 路由），必须点中"最深"的那个节点：
  // 外层容器（如 <li>/<div>）的 innerText 也会以导航名开头，点到它不会跳转。
  const clickNav = async (label) => evalJs(cdp, `(() => {
    const matches = [...document.querySelectorAll('button,a,div,span,li')]
      .filter((e) => e.innerText && e.innerText.trim().startsWith(${JSON.stringify(label)}));
    if (matches.length === 0) return null;
    const deep = matches.reduce((best, e) =>
      e.innerText.trim().length <= best.innerText.trim().length ? e : best);
    const target = deep.closest('a,button') || deep;
    target.click();
    return target.innerText.trim();
  })()`);

  const readTable = async () => evalJs(cdp, `(() => {
    const heads = [...document.querySelectorAll('th')].map((t) => t.innerText.trim());
    const rows = [...document.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()));
    const text = document.body.innerText;
    const m = text.match(/共(?:查询到)?\\s*(\\d+)\\s*条/);
    return { heads, rows, statedTotal: m ? Number(m[1]) : null, url: location.href };
  })()`);

  // ============ 来料检验 (IQC) ============
  log('nav IQC:', await clickNav('来料检验'));
  await sleep(6000);
  const iqc = await readTable();
  log('IQC heads:', iqc.heads);
  log('IQC rows:', iqc.rows.length, 'statedTotal:', iqc.statedTotal);

  const docIdx = iqc.heads.indexOf('检验单号');
  const receiptIdx = iqc.heads.indexOf('采购入库单号');
  check('IQC 表头含「检验单号」', docIdx >= 0, iqc.heads);
  check('IQC 表头含「采购入库单号」', receiptIdx >= 0, iqc.heads);
  check('IQC 页面条数 = 接口命中总数', iqc.statedTotal === expectedIqc, {
    statedTotal: iqc.statedTotal, expectedIqc,
  });

  if (docIdx >= 0 && receiptIdx >= 0) {
    // 核心回归：入库单号不得是由检验单号推导出来的伪造值（历史实现会拼 `RK-<单号去 IQC- 前缀>`）
    const fabricated = iqc.rows
      .map((r) => ({ docNo: r[docIdx], receiptNo: r[receiptIdx] }))
      .filter(({ docNo, receiptNo }) =>
        receiptNo && receiptNo !== '-' && receiptNo === 'RK-' + String(docNo).replace(/^IQC-/, ''));
    check('IQC 采购入库单号不是由检验单号伪造推导的值', fabricated.length === 0, fabricated);

    const badValues = iqc.rows.map((r) => r[receiptIdx]).filter((v) => v !== '-' && !/^RK-/.test(v));
    check('IQC 采购入库单号列取值合规（真实入库单号或 -）', badValues.length === 0, badValues);
  }
  await shot('iqc-list-after-wiring.png');

  // ============ 委外检验（表面处理） ============
  log('nav 委外:', await clickNav('委外检验'));
  await sleep(6000);
  const os = await readTable();
  log('OUTSOURCE heads:', os.heads);
  log('OUTSOURCE rows:', os.rows.length);

  const oDocIdx = os.heads.indexOf('检验单号');
  const oOutIdx = os.heads.indexOf('委外加工单号');
  check('委外 表头含「检验单号」', oDocIdx >= 0, os.heads);
  check('委外 表头含「委外加工单号」', oOutIdx >= 0, os.heads);
  check('委外 表面处理列表非空', os.rows.length > 0, os.rows.length);
  check('委外 页面条数 = 接口命中总数', os.statedTotal === expectedOutsource, {
    statedTotal: os.statedTotal, expectedOutsource,
  });
  if (oOutIdx >= 0) {
    const emptyOut = os.rows.map((r) => r[oOutIdx]).filter((v) => !v || v === '');
    check('委外加工单号列无空值（缺失应显示 -）', emptyOut.length === 0, emptyOut);
  }
  await shot('outsource-list-after-wiring.png');

  const failed = results.filter((r) => !r.ok);
  log(`SUMMARY: ${results.length - failed.length}/${results.length} passed`);
  await cdp.send('Browser.close').catch(() => {});
  await sleep(500);
  chrome.kill();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { log('FAIL:', String(e && e.stack ? e.stack : e)); process.exit(2); });
