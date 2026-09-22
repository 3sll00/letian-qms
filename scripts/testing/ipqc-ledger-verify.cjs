/**
 * 过程检验（IPQC）三页台账「列集 + 字段 + 接口」端到端回归校验（CDP 驱动，只读主流程 + 建单往返自动清理）
 *
 * 覆盖页面：下料检验 (IPQC_CT) / 滚丝检验 (IPQC_RL) / 成品检 (IPQC_FN)
 * 口径来源：docs/29-过程检验下料检验台账列字段与接口打通设计.md §2、
 *          docs/30-过程检验滚丝与成品检台账列字段与接口打通设计.md §2
 *
 * 每页断言：
 *   1. 表头 = 11 列且顺序与业务确认的设计图（原型 WPS图片(5)/(6)/(7)）逐列一致；
 *   2. 已删除的旧列（工序/关卡、规格型号、检验员、报检/完成时间、报检/抽样数、物料编码与名称）不得回流；
 *   3. 页面「共 N 条记录」= 后端 `GET /inspections?type=<类型>` 的命中总数；
 *   4. 逐行（按检验单号对齐）逐列等于接口字段：
 *      MES工单号=workOrderNo ?? batchNo、数量=totalQty、完成时间=completedAt、
 *      专有列（断料长度=blankingLength / 操作员=operatorName / 设备=equipmentCode / 终检组=inspectionTeam）、
 *      检验人=inspectorName、成品检★=isMandatoryGate；
 *   5. **不得出现伪造值**：接口字段为空时页面必须是 `--`（尤其不允许把 sampleQty 当「数量」）；
 *   6. 「操作」列按状态分派：待检验 -> 检验；成品检「检验中」-> 继续；其余 -> 详情；
 *   7. 台账筛选参数真正落到 SQL（命中 > 0，且用不存在的值探测必须为 0）。
 *
 * 另含一条写路径往返断言（建单 -> 读回）：`POST /inspections` 透传的 inspectorId 必须落库，
 * 并由读侧按员工主数据补齐「检验人」姓名；跑完自动删除该验收单，可反复执行。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = 9337;
const WEB_CANDIDATES = process.env.WEB_BASE
  ? [process.env.WEB_BASE]
  : ['http://127.0.0.1:5200/', 'http://127.0.0.1:5201/', 'http://127.0.0.1:5202/'];
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3100/api/v1';
const DB_URL =
  process.env.DATABASE_URL ??
  'postgresql://letian_user:letian_secure_pass_2026@127.0.0.1:5432/letian_qms_db';

const LOG = path.join(OUT_DIR, 'ipqc-ledger-verify.log');
fs.writeFileSync(LOG, '');
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probeHttp(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
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
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('前端未监听，候选地址均不可用: ' + WEB_CANDIDATES.join(', '));
}

function httpJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('ws error'));
    });
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

/** 台账列展示口径（必须与前端 IpqcViews.tsx 的格式化函数一字不差） */
const pageDate = (value) => {
  if (!value) return '--';
  const m = /^(\d{4}-\d{2}-\d{2})(?:T| )(\d{2}:\d{2})/.exec(String(value));
  return m ? `${m[1]} ${m[2]}` : '--';
};
const pageMm = (value) => {
  if (value === null || value === undefined || value === '') return '--';
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return `${Number.isInteger(num) ? String(num) : num.toFixed(1)} mm`;
};
const pageNum = (value) => (value === null || value === undefined || value === '' ? '--' : String(value));
const pageText = (value) => (value === null || value === undefined || value === '' ? '--' : String(value));
const pageStar = (value) => (value === true ? '★' : '--');

const FMT = { text: pageText, num: pageNum, date: pageDate, mm: pageMm };

const STATUS_LABELS = ['待检验', '检验中', '已合格', '不合格', 'MRB评审'];

/** 三页列集与接口字段对照（第 6 列起为「工序专有列」，是三页唯一分叉点） */
const PAGES = [
  {
    name: '下料检验',
    entry: '进入下料台账',
    type: 'IPQC_CT',
    shot: 'ipqc-blanking-ledger.png',
    heads: ['检验单号', 'MES工单号', '物料编码', '物料名称', '数量', '断料长度', '操作员', '设备', '完成时间', '状态', '操作'],
    specific: [
      { col: '断料长度', field: 'blankingLength', fmt: 'mm' },
      { col: '操作员', field: 'operatorName', fmt: 'text' },
      { col: '设备', field: 'equipmentCode', fmt: 'text' },
    ],
    hasInspector: false,
    hasStar: false,
    probes: [
      { qs: (r) => `type=IPQC_CT&operatorName=${encodeURIComponent(r.operatorName)}`, ok: (t) => t > 0, label: 'operatorName 落到 SQL' },
      { qs: (r) => `type=IPQC_CT&equipmentCode=${encodeURIComponent(r.equipmentCode)}`, ok: (t) => t > 0, label: 'equipmentCode 落到 SQL' },
      { qs: () => 'type=IPQC_CT&operatorName=NOPE-ZZZ', ok: (t) => t === 0, label: '不存在的 operatorName 命中 0' },
    ],
  },
  {
    name: '滚丝检验',
    entry: '进入滚丝台账',
    type: 'IPQC_RL',
    shot: 'ipqc-rolling-ledger.png',
    heads: ['检验单号', 'MES工单号', '物料编码', '物料名称', '数量', '操作员', '设备', '完成时间', '状态', '检验人', '操作'],
    specific: [
      { col: '操作员', field: 'operatorName', fmt: 'text' },
      { col: '设备', field: 'equipmentCode', fmt: 'text' },
    ],
    hasInspector: true,
    hasStar: false,
    probes: [
      { qs: (r) => `type=IPQC_RL&operatorName=${encodeURIComponent(r.operatorName)}`, ok: (t) => t > 0, label: 'operatorName 落到 SQL' },
      { qs: (r) => `type=IPQC_RL&equipmentCode=${encodeURIComponent(r.equipmentCode)}`, ok: (t) => t > 0, label: 'equipmentCode 落到 SQL' },
      { qs: (r) => `type=IPQC_RL&threadSpec=${encodeURIComponent(r.threadSpec)}`, ok: (t) => t > 0, label: 'threadSpec 落到 SQL' },
      { qs: () => 'type=IPQC_RL&operatorName=NOPE-ZZZ', ok: (t) => t === 0, label: '不存在的 operatorName 命中 0' },
    ],
  },
  {
    name: '成品检',
    entry: '进入成品台账',
    type: 'IPQC_FN',
    shot: 'ipqc-finished-ledger.png',
    heads: ['检验单号', '★', 'MES工单号', '物料编码', '物料名称', '数量', '终检组', '完成时间', '状态', '检验人', '操作'],
    specific: [{ col: '终检组', field: 'inspectionTeam', fmt: 'text' }],
    hasInspector: true,
    hasStar: true,
    probes: [
      { qs: (r) => `type=IPQC_FN&inspectionTeam=${encodeURIComponent(r.inspectionTeam)}`, ok: (t) => t > 0, label: 'inspectionTeam 落到 SQL' },
      { qs: () => 'type=IPQC_FN&inspectionTeam=NOPE-ZZZ', ok: (t) => t === 0, label: '不存在的 inspectionTeam 命中 0' },
    ],
  },
];

/**
 * 操作列文案口径：待检验 -> 检验；成品检「检验中」-> 继续；其余 -> 详情；
 * 并在同一列追加**行级证书入口**（docs/35 §8 M9：四个台账统一入口、所有行可点）。
 * 单元格文本按 innerText 取，主操作与证书按钮各占一行，故期望值含换行。
 */
const CERT_ACTION = '证书';
const expectAction = (page, statusLabel) =>
  `${
    statusLabel === '待检验' ? '检验' : page.hasStar && statusLabel === '检验中' ? '继续' : '详情'
  }\n${CERT_ACTION}`;

/** pg 依赖解析：仓库用 pnpm 隔离式 node_modules，scripts/ 不是工作区包，回退到 .pnpm 存储目录 */
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
    if (entry === undefined) throw new Error('未找到 pg 依赖，无法执行数据库清理');
    return require(path.join(store, entry, 'node_modules', 'pg'));
  }
}

(async () => {
  // 1. 接口基线（真实库口径）
  const login = await httpJson(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '11000000-0000-4000-8000-000000000001' }),
  });
  const token = login.body.token;
  const apiGet = (qs) =>
    httpJson(`${API_BASE}/inspections?${qs}`, { headers: { authorization: `Bearer ${token}` } });

  const baselines = {};
  for (const page of PAGES) {
    const res = await apiGet(`type=${page.type}&page=1&pageSize=50`);
    const rows = Array.isArray(res.body.items) ? res.body.items : [];
    baselines[page.type] = { rows, total: res.body.total };
    log(`baseline ${page.type}:`, { total: res.body.total, rows: rows.length });
    check(`${page.name}：接口返回台账行（基线非空）`, rows.length > 0 && rows.length === res.body.total, {
      total: res.body.total,
      rows: rows.length,
    });
  }

  const userDataDir = path.join(OUT_DIR, 'chrome-profile-ipqc-ledger');
  fs.mkdirSync(userDataDir, { recursive: true });
  const chrome = spawn(
    CHROME,
    [
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
    ],
    { stdio: 'ignore' }
  );

  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      version = await httpJson(`http://127.0.0.1:${PORT}/json/version`);
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!version) throw new Error('Chrome CDP not reachable');

  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const target = list.body.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1780,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const shot = async (name) => {
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

  const clickByText = (label) => evalJs(cdp, `(() => {
    const matches = [...document.querySelectorAll('button,a,div,span,li')]
      .filter((e) => e.innerText && e.innerText.trim().startsWith(${JSON.stringify(label)}));
    if (matches.length === 0) return null;
    const deep = matches.reduce((best, e) =>
      e.innerText.trim().length <= best.innerText.trim().length ? e : best);
    const target = deep.closest('a,button') || deep;
    target.click();
    return target.innerText.trim();
  })()`);

  const readTable = () => evalJs(cdp, `(() => {
    const heads = [...document.querySelectorAll('th')].map((t) => t.innerText.trim());
    const rows = [...document.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()));
    const text = document.body.innerText;
    const m = text.match(/共\\s*(\\d+)\\s*条记录/);
    return { heads, rows, statedTotal: m ? Number(m[1]) : null };
  })()`);

  log('nav IPQC:', await clickByText('过程检验(IPQC)'));
  await sleep(4000);

  for (let p = 0; p < PAGES.length; p++) {
    const page = PAGES[p];
    const { rows: apiRows, total: apiTotal } = baselines[page.type];

    if (p > 0) {
      log(`back to overview: ${await clickByText('返回总览')}`);
      await sleep(3000);
    }
    log(`enter ${page.name} ledger: ${await clickByText(page.entry)}`);
    await sleep(5000);

    const table = await readTable();
    log(`[${page.name}] heads:`, table.heads);
    log(`[${page.name}] rows:`, table.rows.length, 'statedTotal:', table.statedTotal);
    await shot(page.shot);

    const legacy = ['工序/关卡', '规格型号', '物料编码与名称', '报检/抽样数', '检验员', '报检/完成时间'];
    const idx = {};
    table.heads.forEach((h, i) => {
      idx[h] = i;
    });

    check(`${page.name}：表头 = 11 列且顺序与设计图一致`, JSON.stringify(table.heads) === JSON.stringify(page.heads), table.heads);
    check(
      `${page.name}：旧列不得回流（${legacy.join(' / ')}）`,
      legacy.every((h) => !table.heads.includes(h)),
      table.heads
    );

    // ============ 条数口径 ============
    check(`${page.name}：页面条数 = 接口命中总数`, table.statedTotal === apiTotal, {
      statedTotal: table.statedTotal,
      apiTotal,
    });

    // ============ 逐行逐列对账（按检验单号对齐，避免排序差异造成误判） ============
    const byOrderNo = new Map(table.rows.map((r) => [r[0], r]));
    const mismatched = [];
    const fabricated = [];
    const actionIssues = [];
    const missingRows = [];
    const cell = (row, col) => (idx[col] === undefined ? undefined : row[idx[col]]);

    apiRows.forEach((api) => {
      const row = byOrderNo.get(api.orderNo);
      if (!row) {
        missingRows.push(api.orderNo);
        return;
      }
      const expected = [
        ['MES工单号', pageText(api.workOrderNo ?? api.batchNo)],
        ['物料编码', pageText(api.materialCode)],
        ['物料名称', pageText(api.materialName)],
        ['数量', pageNum(api.totalQty)],
        ['完成时间', pageDate(api.completedAt)],
        ...page.specific.map((s) => [s.col, FMT[s.fmt](api[s.field])]),
        ...(page.hasInspector ? [['检验人', pageText(api.inspectorName)]] : []),
        ...(page.hasStar ? [['★', pageStar(api.isMandatoryGate)]] : []),
      ];
      expected.forEach(([col, value]) => {
        const actual = cell(row, col);
        if (actual !== value) {
          mismatched.push({ 列: col, 页面: actual, 接口: value, orderNo: api.orderNo });
        }
      });

      // 伪造值守门：接口为空时页面必须 `--`
      const emptyGates = [
        { col: '数量', empty: api.totalQty === null || api.totalQty === undefined, extra: { sampleQty: api.sampleQty } },
        { col: '完成时间', empty: !api.completedAt },
        ...page.specific.map((s) => ({ col: s.col, empty: api[s.field] === null || api[s.field] === undefined || api[s.field] === '' })),
        ...(page.hasInspector ? [{ col: '检验人', empty: !api.inspectorName }] : []),
      ];
      emptyGates.forEach((g) => {
        if (idx[g.col] !== undefined && g.empty && row[idx[g.col]] !== '--') {
          fabricated.push({ 列: g.col, 页面: row[idx[g.col]], orderNo: api.orderNo, ...(g.extra ?? {}) });
        }
      });

      // 状态与操作列联动
      const status = cell(row, '状态');
      const action = cell(row, '操作');
      if (!STATUS_LABELS.includes(status)) {
        actionIssues.push({ orderNo: api.orderNo, 状态: status });
      } else if (action !== expectAction(page, status)) {
        actionIssues.push({ orderNo: api.orderNo, 状态: status, 操作: action, 期望: expectAction(page, status) });
      }
    });

    check(`${page.name}：接口命中的每一行都在页面上呈现`, missingRows.length === 0, missingRows);
    check(
      `${page.name}：逐列等于接口字段（MES工单号/物料编码/物料名称/数量/完成时间/专有列${page.hasInspector ? '/检验人' : ''}${page.hasStar ? '/★' : ''}）`,
      mismatched.length === 0,
      mismatched
    );
    check(`${page.name}：无伪造值（接口为空必须 --，不得用 sampleQty 等顶替）`, fabricated.length === 0, fabricated);
    check(
      `${page.name}：操作列按状态分派 + 行级证书入口（待检验->检验/成品检检验中->继续/其余->详情，均附「证书」）`,
      actionIssues.length === 0,
      actionIssues
    );

    // ============ 4. 筛选参数真正落到 SQL ============
    const probeResults = [];
    for (const probe of page.probes) {
      const qs = probe.qs(apiRows[0]);
      const res = await apiGet(`${qs}&page=1&pageSize=5`);
      const total = res.body.total;
      probeResults.push({ qs, total, ok: probe.ok(total) });
    }
    check(
      `${page.name}：台账筛选参数真正落到 SQL（${page.probes.map((x) => x.label).join(' / ')}）`,
      probeResults.every((r) => r.ok),
      probeResults
    );
  }

  // ============ 5. 写路径往返：建单透传 inspectorId -> 读侧补齐「检验人」 ============
  const inspectorId = '11000000-0000-4000-8000-000000000002'; // 李伟 —— 员工主数据
  const batchNo = `VERIFY-IPQC-LEDGER-${Date.now()}`;
  let createdId = null;
  try {
    const created = await httpJson(`${API_BASE}/inspections`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        inspectionType: 'IPQC_RL',
        materialCode: 'MAT-THRD-M6-25',
        batchNo,
        sampleQty: 32,
        totalQty: 26000,
        threadSpec: 'M6*25 6g',
        operatorName: '验收操作员',
        equipmentCode: 'EQ-RL-99',
        processStep: '手工滚牙',
        inspectorId,
      }),
    });
    createdId = created.body?.id ?? null;
    const roundTrip = await apiGet(`orderNo=${encodeURIComponent(created.body.orderNo)}&page=1&pageSize=5`);
    const row = (roundTrip.body.items ?? [])[0] ?? {};
    log('round-trip:', { orderNo: created.body.orderNo, inspectorId: row.inspectorId, inspectorName: row.inspectorName });
    check(
      '建单透传 inspectorId 落库，且读侧按员工主数据补齐「检验人」姓名',
      created.status === 201 && row.inspectorId === inspectorId && row.inspectorName === '李伟',
      { status: created.status, inspectorId: row.inspectorId, inspectorName: row.inspectorName }
    );
    check(
      '建单透传的滚丝台账列（数量/螺纹规格/操作员/设备）往返一致',
      row.totalQty === 26000 && row.threadSpec === 'M6*25 6g' && row.operatorName === '验收操作员' && row.equipmentCode === 'EQ-RL-99',
      { totalQty: row.totalQty, threadSpec: row.threadSpec, operatorName: row.operatorName, equipmentCode: row.equipmentCode }
    );
  } catch (err) {
    check('建单透传 inspectorId 落库，且读侧按员工主数据补齐「检验人」姓名', false, String(err && err.message ? err.message : err));
  } finally {
    // 清理验收单：直接删库内验收行，避免污染台账
    try {
      const { Client } = resolvePg();
      const db = new Client({ connectionString: DB_URL });
      await db.connect();
      const del = await db.query('DELETE FROM inspection_orders WHERE batch_no = $1', [batchNo]);
      await db.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [createdId ?? '']);
      await db.end();
      log('cleanup: deleted inspection_orders rows =', del.rowCount);
    } catch (err) {
      log('cleanup FAILED（请手工清理 batch_no=' + batchNo + '）:', String(err && err.message ? err.message : err));
    }
  }

  const pass = results.filter((r) => r.ok).length;
  log(`\n=== ${pass}/${results.length} PASS ===`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    log('FAILED:', failed.map((f) => f.name));
  }

  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((err) => {
  log('FATAL: ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
