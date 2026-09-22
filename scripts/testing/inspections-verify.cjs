/**
 * 来料检验 (IQC) / 委外检验 / 出货检验 (OQC) 台账端到端渲染校验（CDP 驱动，只读）
 *
 * 验证目标（对应"字段是否真的与数据库/接口打通"这条主线）：
 *   1. 与后端 `GET /inspections` 的命中总数一致（页面条数必须是接口口径，不是前端二次过滤后的长度）；
 *   2. 列表列值只来自库中真实字段：缺失显示 '-'，
 *      **不得出现由其它字段推导出来的伪造值**（如来料检验的 `RK-` + 检验单号）；
 *   3. 表头列名符合台账规范（来料检验第 2 列为「入库单号」，旧的「采购入库单号」已按迁移 021 收敛）；
 *   4. 来料检验「检验单号 / 入库单号」两列与接口字段 `orderNo` / `inboundNo` **逐行一致**（真打通，而非看起来有值）。
 *   5. 来料检验「规格型号」列取自库中真实列 `specification`（快照自物料主数据 `spec_model`）：
 *      逐行非空、与接口 `specification` 逐行一致，且**不得与同行「物料名称」同值**（防止规格型号再次串进名称列）。
 *   6. 来料检验「物料名称」列必须逐行等于接口 `materialName`（库列 `material_name`）。
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
const WEB_CANDIDATES = process.env.WEB_BASE
  ? [process.env.WEB_BASE]
  : ['http://127.0.0.1:5200/', 'http://127.0.0.1:5201/', 'http://127.0.0.1:5202/'];
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3100/api/v1';

/** 多会话环境下 vite dev 端口会自增（5200 -> 5201 -> 5202），故自动探测，避免跑错实例 */
/** 端口探测：只看 HTTP 状态码（首页返回 HTML，不能按 JSON 解析） */
function probeHttp(url) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').get(url, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) resolve(res.statusCode);
      else reject(new Error('status ' + res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}
async function resolveWebBase() {
  for (const base of WEB_CANDIDATES) {
    try {
      const res = await probeHttp(new URL('/', base).href);
      if (res) return base;
    } catch { /* 试下一个 */ }
  }
  throw new Error('前端未监听，候选地址均不可用: ' + WEB_CANDIDATES.join(', '));
}
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
  const res = await httpJson(`${API_BASE}/inspections?${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.body.total;
}

/** 调用真实接口取当页数据，用来和页面列值逐行对账 */
async function apiList(token, qs) {
  const res = await httpJson(`${API_BASE}/inspections?${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.body;
}

(async () => {
  // 1. 先拿一个真实接口的命中总数作为对账基准
  const login = await httpJson(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '11000000-0000-4000-8000-000000000001' }),
  });
  const token = login.body.token;
  const expectedIqc = await apiTotal(token, 'type=IQC&pageSize=1');
  const expectedOutsource = await apiTotal(token, 'inspectionType=OQC_SF&pageSize=1');
  // 来料检验第 1 页真实行：用于和页面「检验单号 / 入库单号」两列逐行对账
  const iqcApi = await apiList(token, 'type=IQC&page=1&pageSize=50');
  const iqcApiRows = Array.isArray(iqcApi.list)
    ? iqcApi.list
    : Array.isArray(iqcApi.items)
      ? iqcApi.items
      : [];
  log('api baseline:', { expectedIqc, expectedOutsource, iqcApiRows: iqcApiRows.length });

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
    // headless=new 下 Page.captureScreenshot 可能返回上一帧已合成画面（首帧丢弃可强制重新合成），
    // 否则连续两次截图会得到字节完全相同的「上一页」图像，证据链失真
    await cdp.send('Page.captureScreenshot', { format: 'png' });
    await sleep(400);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    log('SHOT:', file);
  };

  const webBase = await resolveWebBase();
  log('web base:', webBase);
  await cdp.send('Page.navigate', { url: webBase });
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
  const inboundIdx = iqc.heads.indexOf('入库单号');
  check('IQC 表头含「检验单号」', docIdx >= 0, iqc.heads);
  check('IQC 表头含「入库单号」', inboundIdx >= 0, iqc.heads);
  check(
    'IQC 表头不再出现旧列名「采购入库单号」',
    iqc.heads.indexOf('采购入库单号') < 0,
    iqc.heads
  );
  check('IQC 页面条数 = 接口命中总数', iqc.statedTotal === expectedIqc, {
    statedTotal: iqc.statedTotal, expectedIqc,
  });

  if (docIdx >= 0 && inboundIdx >= 0) {
    // 核心回归：入库单号不得是由检验单号推导出来的伪造值（历史实现会拼 `RK-<单号去 IQC- 前缀>`）
    const fabricated = iqc.rows
      .map((r) => ({ docNo: r[docIdx], inboundNo: r[inboundIdx] }))
      .filter(({ docNo, inboundNo }) =>
        inboundNo && inboundNo !== '-' && inboundNo === 'RK-' + String(docNo).replace(/^IQC-/, ''));
    check('IQC 入库单号不是由检验单号伪造推导的值', fabricated.length === 0, fabricated);

    // 核心回归：页面两列必须逐行等于接口字段（页面与接口/库字段名不一致会立刻暴露）
    const mismatched = [];
    iqc.rows.forEach((row, index) => {
      const apiRow = iqcApiRows[index];
      if (!apiRow) return;
      const expectedDoc = apiRow.orderNo ?? '-';
      const expectedInbound = apiRow.inboundNo ?? '-';
      if (row[docIdx] !== expectedDoc || row[inboundIdx] !== expectedInbound) {
        mismatched.push({
          row: index + 1,
          page: [row[docIdx], row[inboundIdx]],
          api: [expectedDoc, expectedInbound],
        });
      }
    });
    check('IQC 检验单号/入库单号列与接口逐行一致', mismatched.length === 0, mismatched);
  }

  // 核心回归：「供应商」列必须展示供应商主数据全称，不得回落成内部编码（如 SUP-001）。
  // 历史缺陷是库中 supplier_name 全空、前端按兜底链回落 supplier_code，列值看起来"有值"其实不是厂商名。
  const supplierIdx = iqc.heads.indexOf('供应商');
  check('IQC 表头含「供应商」', supplierIdx >= 0, iqc.heads);
  if (supplierIdx >= 0) {
    const badSupplier = [];
    iqc.rows.forEach((row, index) => {
      const apiRow = iqcApiRows[index];
      if (!apiRow) return;
      const expected = apiRow.supplierName ?? apiRow.supplierCode ?? '-';
      const actual = row[supplierIdx];
      if (actual !== expected || /^SUP-\d+$/.test(actual)) {
        badSupplier.push({ row: index + 1, page: actual, api: expected });
      }
    });
    check(
      'IQC 供应商列为主数据厂商全称（非内部编码）且与接口逐行一致',
      badSupplier.length === 0,
      badSupplier
    );
  }

  // 规格型号：迁移 023 起 inspection_orders.specification 由物料主数据 spec_model 回填，
  // 页面第 6 列必须逐行等于接口 specification，且不得与同行「物料名称」同值（那正是本次要消除的串列）
  const specIdx = iqc.heads.indexOf('规格型号');
  const nameIdx = iqc.heads.indexOf('物料名称');
  check('IQC 表头含「规格型号」', specIdx >= 0, iqc.heads);
  if (specIdx >= 0 && nameIdx >= 0) {
    const blankSpec = iqc.rows
      .map((r, index) => ({ row: index + 1, spec: r[specIdx] }))
      .filter((x) => !x.spec || x.spec === '-');
    check('IQC 规格型号列逐行非空（快照自物料主数据 spec_model）', blankSpec.length === 0, blankSpec);

    const specMismatch = [];
    const sameAsName = [];
    iqc.rows.forEach((row, index) => {
      const apiRow = iqcApiRows[index];
      if (apiRow) {
        const expected = apiRow.specification ?? apiRow.spec ?? '-';
        if (row[specIdx] !== expected) {
          specMismatch.push({ row: index + 1, page: row[specIdx], api: expected });
        }
      }
      if (row[specIdx] && row[specIdx] === row[nameIdx]) {
        sameAsName.push({ row: index + 1, value: row[specIdx] });
      }
    });
    check('IQC 规格型号列与接口 specification 逐行一致', specMismatch.length === 0, specMismatch);
    check('IQC 规格型号列取值不与物料名称列同值（不得串列）', sameAsName.length === 0, sameAsName);
  }
  // 「物料名称」列同样必须逐行等于接口 materialName（该列此前从未与接口对账过）
  if (nameIdx >= 0) {
    const nameMismatch = [];
    iqc.rows.forEach((row, index) => {
      const apiRow = iqcApiRows[index];
      if (!apiRow) return;
      const expected = apiRow.materialName ?? '-';
      if (row[nameIdx] !== expected) {
        nameMismatch.push({ row: index + 1, page: row[nameIdx], api: expected });
      }
    });
    check('IQC 物料名称列与接口 materialName 逐行一致', nameMismatch.length === 0, nameMismatch);
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
