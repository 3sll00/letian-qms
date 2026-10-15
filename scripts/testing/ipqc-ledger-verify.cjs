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
 *   8. 总览看板（子页默认页）：管控总量汇总条与三工序卡片同为浅色白底、无深色渐变，5 项指标取值
 *      = `GET /inspections/ipqc-overview` 的 `summary`（页头总量 = `summary.total` 批次）。
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
  : ['http://127.0.0.1:31100/', 'http://127.0.0.1:31101/', 'http://127.0.0.1:31102/'];
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3100/api/v1';
const DB_URL =
  process.env.DATABASE_URL ??
  'postgresql://letian_user:letian_secure_pass_2026@127.0.0.1:5433/letian_qms_db';

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
    /** 需求（docs/40）：仅下料 / 滚丝开放勾选列与【检视】批量判定；成品检不开放 */
    bulk: true,
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
    bulk: true,
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
    bulk: false,
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

  const overviewRes = await httpJson(`${API_BASE}/inspections/ipqc-overview`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const overviewApi = overviewRes.body || {};
  log('baseline ipqc-overview summary:', overviewApi.summary);

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

  /**
   * 读表：业务列口径见 docs/29 §2 / docs/30 §2（11 列）。
   * 下料 / 滚丝两页最左侧新增「行选择列」（docs/40），页头是**无文本的复选框**、
   * 行首是行复选框 —— 读表时先剥离该列，再按 11 列业务列逐列对账（勾选列不是业务列）。
   */
  const readTable = () => evalJs(cdp, `(() => {
    const headCells = [...document.querySelectorAll('th')];
    const hasSelectCol = headCells.length > 0 && !!headCells[0].querySelector('input[type="checkbox"]');
    const heads = (hasSelectCol ? headCells.slice(1) : headCells).map((t) => t.innerText.trim());
    const rows = [...document.querySelectorAll('tbody tr')].map((tr) => {
      const cells = [...tr.querySelectorAll('td')];
      const dropSelectCell = hasSelectCol && cells.length > 0 && !!cells[0].querySelector('input[type="checkbox"]');
      return (dropSelectCell ? cells.slice(1) : cells).map((td) => td.innerText.trim());
    });
    const text = document.body.innerText;
    const m = text.match(/共\\s*(\\d+)\\s*条记录/);
    return { heads, hasSelectCol, rows, statedTotal: m ? Number(m[1]) : null };
  })()`);

  /** 勾选框（页头全选 / 行选择）与表格右上角【检视】按钮的现场快照（docs/40 §3.1 §3.2） */
  const readBulkControls = () => evalJs(cdp, `(() => {
    const selectAll = document.querySelector('th input[type="checkbox"]');
    const rowBoxes = [...document.querySelectorAll('tbody input[type="checkbox"]')];
    const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '检视');
    const card = btn ? btn.closest('div.bg-white') : null;
    const table = document.querySelector('table');
    const countText = [...document.querySelectorAll('span')]
      .map((s) => s.innerText || '')
      .find((t) => /已勾选\\s*\\d+\\s*条/.test(t)) || null;
    return {
      selectAll: !!selectAll,
      selectAllIndeterminate: selectAll ? !!selectAll.indeterminate : null,
      checkedRows: rowBoxes.filter((b) => b.checked).length,
      rowBoxes: rowBoxes.length,
      button: btn ? btn.innerText.trim() : null,
      buttonDisabled: btn ? !!btn.disabled : null,
      /** 表格右上角：按钮必须落在「包含该表格的卡片」内，且位于卡片右边界附近 */
      buttonInTableCard: !!(card && table && card.contains(table)),
      buttonAtRight: (() => {
        if (!btn || !card) return false;
        const b = btn.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        return b.right <= c.right && c.right - b.right < 32 && b.top < c.top + 80;
      })(),
      countText,
    };
  })()`);

  /** 点页头全选 / 行复选框（勾选态是纯前端状态，不落库） */
  const clickSelectAll = () => evalJs(cdp, `(() => {
    const box = document.querySelector('th input[type="checkbox"]');
    if (!box) return null;
    box.click();
    return true;
  })()`);

  log('nav IPQC:', await clickByText('过程检验(IPQC)'));
  await sleep(4000);

  // ============ 总览看板：汇总条浅色口径 + 取值来自接口 ============
  const overview = await evalJs(cdp, `(() => {
    const title = [...document.querySelectorAll('h2')].find((h) => h.innerText.includes('过程检验总览'));
    const scope = title ? title.closest('div.space-y-5') || title.parentElement.parentElement : null;
    const label = [...document.querySelectorAll('div')].find((d) => (d.innerText || '').trim() === '今日过程检验管控总量');
    let banner = label;
    let bannerBg = 'rgba(0, 0, 0, 0)';
    let bannerImg = 'none';
    while (banner && banner !== document.body) {
      const cs = getComputedStyle(banner);
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        bannerBg = cs.backgroundColor;
        bannerImg = cs.backgroundImage;
        break;
      }
      banner = banner.parentElement;
    }
    const totalEl = banner
      ? [...banner.querySelectorAll('div')].find((d) => /^\\d+ 批次$/.test((d.innerText || '').trim()))
      : null;
    const metrics = {};
    if (banner) {
      for (const cell of banner.querySelectorAll('div')) {
        const spans = cell.querySelectorAll(':scope > span');
        if (spans.length === 2) metrics[spans[0].innerText.trim()] = spans[1].innerText.trim();
      }
    }
    // 浅色校验只针对过程检验页面自身子树（侧边栏/顶栏是应用外壳）
    const darkEls = scope
      ? [...scope.querySelectorAll('div,section,table,thead,tr,td,th')]
          .filter((el) => {
            const c = getComputedStyle(el).backgroundColor || '';
            const m = c.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
            if (!m) return false;
            const alpha = m[4] === undefined ? 1 : Number(m[4]);
            if (alpha === 0) return false;
            const lum = (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3;
            return lum < 140 && el.clientHeight > 30;
          })
          .slice(0, 3)
          .map((el) => ({ cls: el.className.toString().slice(0, 80), bg: getComputedStyle(el).backgroundColor }))
      : [];
    return { hasTitle: title !== undefined, bannerBg, bannerImg, total: totalEl ? totalEl.innerText.trim() : null, metrics, darkEls };
  })()`);
  log('overview snapshot:', overview);
  await shot('ipqc-overview-board.png');

  const summaryApi = overviewApi.summary || {};
  const expectedMetrics = {
    待检排队: String(summaryApi.pending),
    检验中: String(summaryApi.inspecting),
    合格放行: String(summaryApi.passed),
    不合格拦截: String(summaryApi.failed),
    综合合格率: `${summaryApi.passRate}%`,
  };
  check('总览看板：页头「过程检验总览 (IPQC)」', overview.hasTitle === true);
  check(
    '总览看板：管控总量汇总条为浅色白底（与三工序卡片同底色口径）',
    overview.bannerBg === 'rgb(255, 255, 255)' && overview.bannerImg === 'none',
    { bg: overview.bannerBg, img: overview.bannerImg }
  );
  check('总览看板：汇总条 5 项指标齐全且顺序一致', JSON.stringify(Object.keys(overview.metrics)) === JSON.stringify(Object.keys(expectedMetrics)), overview.metrics);
  check('总览看板：汇总条取值 = 接口 summary', JSON.stringify(overview.metrics) === JSON.stringify(expectedMetrics), { page: overview.metrics, api: expectedMetrics });
  check('总览看板：页头总量 = 接口 summary.total 批次', overview.total === `${summaryApi.total} 批次`, { page: overview.total, api: summaryApi.total });
  check('浅色主题：过程检验总览子树无深色容器', overview.darkEls.length === 0, overview.darkEls);

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

    // ============ 勾选列 + 表格右上角【检视】按钮（需求口径：docs/40 §3.1 §3.2 §3.6） ============
    const bulk0 = await readBulkControls();
    log(`[${page.name}] bulk controls:`, bulk0);
    check(
      `${page.name}：表左侧${page.bulk ? '有' : '无'}行选择列 + 页头全选复选框（每行一个）`,
      table.hasSelectCol === page.bulk &&
        bulk0.selectAll === page.bulk &&
        (!page.bulk || bulk0.rowBoxes === table.rows.length),
      { hasSelectCol: table.hasSelectCol, selectAll: bulk0.selectAll, rowBoxes: bulk0.rowBoxes, rows: table.rows.length }
    );
    check(
      `${page.name}：表格右上角${page.bulk ? '有' : '无'}【检视】按钮（初始未勾选 -> 禁用）`,
      page.bulk
        ? bulk0.button === '检视' &&
            bulk0.buttonInTableCard === true &&
            bulk0.buttonAtRight === true &&
            bulk0.buttonDisabled === true &&
            bulk0.countText === null
        : bulk0.button === null,
      bulk0
    );

    if (page.bulk) {
      // 全选 / 取消全选（纯前端勾选态，不落库）
      await clickSelectAll();
      await sleep(700);
      const bulkAll = await readBulkControls();
      check(
        `${page.name}：点页头复选框「全选本页」（N/N 行勾选 + 「已勾选 N 条」+ 按钮可用）`,
        bulkAll.checkedRows === table.rows.length &&
          bulkAll.checkedRows > 0 &&
          bulkAll.buttonDisabled === false &&
          bulkAll.countText !== null &&
          new RegExp(`已勾选\\s*${table.rows.length}\\s*条`).test(bulkAll.countText),
        bulkAll
      );
      await clickSelectAll();
      await sleep(700);
      const bulkNone = await readBulkControls();
      check(
        `${page.name}：再点一次「取消全选」（0 勾选 + 【检视】回到禁用）`,
        bulkNone.checkedRows === 0 && bulkNone.buttonDisabled === true && bulkNone.countText === null,
        bulkNone
      );
      // 行级勾选：勾第 1 行 -> 1 勾选（多行台账须呈页头半选态，单行台账即"已全选"）
      await evalJs(cdp, `(() => {
        const box = document.querySelector('tbody input[type="checkbox"]');
        if (box) box.click();
        return !!box;
      })()`);
      await sleep(600);
      const bulkOne = await readBulkControls();
      const singleRow = table.rows.length === 1;
      check(
        `${page.name}：行复选框可单选（勾 1 行 -> 1 勾选 + 【检视】可用${singleRow ? '' : ' + 页头半选态'}）`,
        bulkOne.checkedRows === 1 &&
          bulkOne.buttonDisabled === false &&
          (singleRow ? bulkOne.selectAllIndeterminate === false : bulkOne.selectAllIndeterminate === true),
        { ...bulkOne, rows: table.rows.length }
      );
      if (!singleRow) {
        // 半选态下点页头 = 全选（并入已有勾选，不误清空）
        await clickSelectAll();
        await sleep(700);
        const bulkMerged = await readBulkControls();
        check(
          `${page.name}：半选态下点页头复选框 = 全选（并入已有勾选，不误清空）`,
          bulkMerged.checkedRows === table.rows.length,
          bulkMerged
        );
      }
      // 收尾：清空勾选，避免影响后续断言的初始态
      await clickSelectAll();
      await sleep(700);
      const bulkClean = await readBulkControls();
      check(
        `${page.name}：勾选可完全清空（0 勾选 + 【检视】禁用 + 无「已勾选」文案）`,
        bulkClean.checkedRows === 0 && bulkClean.buttonDisabled === true && bulkClean.countText === null,
        bulkClean
      );
    }

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
      // 判定不合格即自动建 MRB 单（docs/43）：mrb_reviews 只存检验单号、无外键级联，
      // 必须在检验单删除前按单号回溯清理，否则留下「源单已删」的孤儿评审工单污染 MRB 列表。
      const mrbDel = await db.query(
        'DELETE FROM mrb_reviews WHERE source_order_no IN (SELECT order_no FROM inspection_orders WHERE batch_no = $1)',
        [batchNo]
      );
      const del = await db.query('DELETE FROM inspection_orders WHERE batch_no = $1', [batchNo]);
      await db.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [createdId ?? '']);
      await db.end();
      log('cleanup: deleted inspection_orders rows =', del.rowCount, '/ mrb_reviews rows =', mrbDel.rowCount);
    } catch (err) {
      log('cleanup FAILED（请手工清理 batch_no=' + batchNo + '）:', String(err && err.message ? err.message : err));
    }
  }

  // ============ 6. 批量勾选 +【检视】统一判定写路径往返（docs/40） ============
  //
  // 现场：滚丝台账按「生产工单」筛出验收批 -> 页头全选 -> 表格右上角【检视】-> 合格 / 不合格 -> 确定。
  // 断言：勾选两单统一落库（status / judgment / 数量），判不合格两单全部自动汇入不合格待审核池（docs/39 §4.1）；
  // 跑完自动清理验收单与池条目，可反复执行。
  const uiSetInputByPlaceholder = (placeholder, value) =>
    evalJs(cdp, `(() => {
      const input = [...document.querySelectorAll('input')].find((i) => i.placeholder === ${JSON.stringify(placeholder)});
      if (!input) return null;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`);

  /** 只在最上层弹窗内点按钮（避免命中台账里的同名文字 / 被遮挡元素） */
  const clickModalButton = (label) =>
    evalJs(cdp, `(() => {
      const modal = [...document.querySelectorAll('div.fixed.inset-0')].pop();
      if (!modal) return null;
      const btn = [...modal.querySelectorAll('button')].find((b) => (b.innerText || '').trim().startsWith(${JSON.stringify(label)}));
      if (!btn || btn.disabled) return null;
      btn.click();
      return btn.innerText.trim();
    })()`);

  const createVerifyOrder = async (batch) => {
    const res = await httpJson(`${API_BASE}/inspections`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        inspectionType: 'IPQC_RL',
        materialCode: 'MAT-THRD-M6-25',
        batchNo: batch,
        sampleQty: 32,
        totalQty: 800,
        operatorName: '批量检视验收',
        equipmentCode: 'EQ-RL-98',
        processStep: '手工滚牙',
      }),
    });
    return { status: res.status, id: res.body?.id ?? null, orderNo: res.body?.orderNo ?? null };
  };

  /** 台账按「生产工单」（= work_order_no，为空按 batch_no 兜底）筛出验收批 */
  const readBatchLedger = async (batch) => {
    const res = await apiGet(`type=IPQC_RL&workOrderNo=${encodeURIComponent(batch)}&page=1&pageSize=10`);
    return { total: res.body.total, items: res.body.items ?? [] };
  };

  const waitForStatuses = async (batch, expected, timeoutMs = 25000) => {
    const deadline = Date.now() + timeoutMs;
    let last = { total: 0, items: [] };
    while (Date.now() < deadline) {
      last = await readBatchLedger(batch);
      if (last.total === 2 && last.items.every((row) => row.status === expected)) return last;
      await sleep(700);
    }
    return last;
  };

  /** 一轮完整 UI 操作：筛选 -> 全选 -> 检视 -> 选结论 -> 确定 */
  const runBulkInspect = async (batch, verdictLabel) => {
    const steps = {};
    steps.filter = await uiSetInputByPlaceholder('MES生产工单号', batch);
    await sleep(300);
    steps.search = await clickByText('查询');
    await sleep(4000);
    steps.rows = (await readTable()).rows.length;
    steps.selectAll = await clickSelectAll();
    await sleep(600);
    steps.selected = (await readBulkControls()).checkedRows;
    steps.openModal = await evalJs(cdp, `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '检视');
      if (!btn || btn.disabled) return null;
      btn.click();
      return true;
    })()`);
    await sleep(700);
    steps.verdict = await clickModalButton(verdictLabel);
    await sleep(300);
    steps.confirm = await clickModalButton('确定');
    return steps;
  };

  const bulkPassBatch = `VERIFY-IPQC-BULK-PASS-${Date.now()}`;
  const bulkFailBatch = `VERIFY-IPQC-BULK-FAIL-${Date.now()}`;
  let bulkCreatedIds = [];
  let bulkCleanupBatchNos = [];
  try {
    const passOrders = [await createVerifyOrder(bulkPassBatch), await createVerifyOrder(bulkPassBatch)];
    const failOrders = [await createVerifyOrder(bulkFailBatch), await createVerifyOrder(bulkFailBatch)];
    bulkCreatedIds = [...passOrders, ...failOrders].map((o) => o.id).filter((id) => id !== null);
    bulkCleanupBatchNos = [bulkPassBatch, bulkFailBatch];
    check(
      '批量检视：验收单建单成功（合格批 2 单 + 不合格批 2 单）',
      [...passOrders, ...failOrders].every((o) => o.status === 201 && o.id !== null) && bulkCreatedIds.length === 4,
      [...passOrders, ...failOrders].map((o) => ({ status: o.status, orderNo: o.orderNo }))
    );
    check(
      '批量检视：新建单初始状态为「待检验」（未判定前不得凭空合格）',
      (await readBatchLedger(bulkPassBatch)).items.every((row) => row.status === 'PENDING'),
      (await readBatchLedger(bulkPassBatch)).items.map((row) => row.status)
    );

    // 上一段逐页对账停在「成品检」页，先回到总览再进滚丝台账
    await clickByText('返回总览');
    await sleep(2500);
    await clickByText('进入滚丝台账');
    await sleep(4000);

    // ---- 统一合格 ----
    const passSteps = await runBulkInspect(bulkPassBatch, '合格');
    log('bulk PASS steps:', passSteps);
    const passRows = await waitForStatuses(bulkPassBatch, 'PASSED');
    check(
      '批量检视【合格】：全选 2 条 -> 统一判定为合格并逐条落库（status / judgment）',
      passSteps.rows === 2 && passSteps.selected === 2 && passRows.total === 2 &&
        passRows.items.every((row) => row.status === 'PASSED' && row.overallDecision === 'PASSED'),
      { steps: passSteps, rows: passRows.items.map((r) => ({ orderNo: r.orderNo, status: r.status, overallDecision: r.overallDecision })) }
    );
    check(
      '批量检视【合格】：数量按本单抽样数落库（passQty=32 / failQty=0）',
      passRows.items.every((row) => row.passQty === 32 && row.failQty === 0),
      passRows.items.map((r) => ({ orderNo: r.orderNo, passQty: r.passQty, failQty: r.failQty }))
    );
    const passNotice = await evalJs(cdp, `(() => {
      const el = [...document.querySelectorAll('div')].find((d) => /^已将勾选的\\s*2\\s*条/.test((d.innerText || '').trim()));
      return el ? el.innerText.trim().split('\\n')[0] : null;
    })()`);
    check('批量检视【合格】：台账给出绿色结果提示条', passNotice !== null, passNotice);

    // ---- 统一不合格 ----
    const failSteps = await runBulkInspect(bulkFailBatch, '不合格');
    log('bulk FAIL steps:', failSteps);
    const failRows = await waitForStatuses(bulkFailBatch, 'FAILED');
    check(
      '批量检视【不合格】：全选 2 条 -> 统一判定为不合格并逐条落库（status / judgment）',
      failSteps.rows === 2 && failSteps.selected === 2 && failRows.total === 2 &&
        failRows.items.every((row) => row.status === 'FAILED' && row.overallDecision === 'FAILED'),
      { steps: failSteps, rows: failRows.items.map((r) => ({ orderNo: r.orderNo, status: r.status, overallDecision: r.overallDecision })) }
    );
    check(
      '批量检视【不合格】：数量按本单抽样数落库（passQty=0 / failQty=32）',
      failRows.items.every((row) => row.passQty === 0 && row.failQty === 32),
      failRows.items.map((r) => ({ orderNo: r.orderNo, passQty: r.passQty, failQty: r.failQty }))
    );

    const { Client } = resolvePg();
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const pooled = await db.query(
      'SELECT count(*)::int AS n FROM pending_mrb_items WHERE source_order_id = ANY($1::uuid[])',
      [failOrders.map((o) => o.id)]
    );
    const notPooled = await db.query(
      'SELECT count(*)::int AS n FROM pending_mrb_items WHERE source_order_id = ANY($1::uuid[])',
      [passOrders.map((o) => o.id)]
    );
    const audited = await db.query(
      // 物理列口径：audit_logs.entity_name / entity_id（资源类型与资源 ID 的映射见 audit-log-repository）
      "SELECT count(*)::int AS n FROM audit_logs WHERE entity_name = 'INSPECTION_ORDER' AND action = 'STATUS_CHANGE' AND entity_id = ANY($1::text[])",
      [bulkCreatedIds]
    );
    await db.end();
    check(
      '批量检视【不合格】：2 单全部自动汇入不合格待审核池（docs/39 §4.1），合格批不入池',
      pooled.rows[0].n === 2 && notPooled.rows[0].n === 0,
      { pooled: pooled.rows[0].n, passedPooled: notPooled.rows[0].n }
    );
    check('批量检视：4 条终判各留一条审计记录（逐单可追溯）', audited.rows[0].n === 4, audited.rows[0]);
  } catch (err) {
    check('批量检视：写路径往返用例执行完成', false, String(err && err.message ? err.message : err));
  } finally {
    try {
      const { Client } = resolvePg();
      const db = new Client({ connectionString: DB_URL });
      await db.connect();
      if (bulkCreatedIds.length > 0) {
        const mrbDel = await db.query(
          'DELETE FROM mrb_reviews WHERE source_order_no IN (SELECT order_no FROM inspection_orders WHERE id = ANY($1::uuid[]))',
          [bulkCreatedIds]
        );
        await db.query('DELETE FROM pending_mrb_items WHERE source_order_id = ANY($1::uuid[])', [bulkCreatedIds]);
        // outbox_events.aggregate_id 是 varchar（不是 uuid），必须按 text 比较
        await db.query('DELETE FROM outbox_events WHERE aggregate_id = ANY($1::text[])', [bulkCreatedIds]);
        const del = await db.query('DELETE FROM inspection_orders WHERE id = ANY($1::uuid[])', [bulkCreatedIds]);
        log('bulk cleanup: deleted inspection_orders rows =', del.rowCount, '/ mrb_reviews rows =', mrbDel.rowCount);
      }
      await db.end();
    } catch (err) {
      log(
        'bulk cleanup FAILED（请手工清理 batch_no=' + bulkCleanupBatchNos.join(' / ') + '）:',
        String(err && err.message ? err.message : err)
      );
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
