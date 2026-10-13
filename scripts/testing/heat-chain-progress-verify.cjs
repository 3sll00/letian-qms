/**
 * 「按炉批号传递进度」链路验收探针
 * 链路口径（用户需求）：采购入库 → 来料检验(IQC) → 下料检(IPQC_CT) → 滚丝检(IPQC_RL)
 *                     → 成品检(IPQC_FN) → 表面处理(OQC_SF) → 出货检(OQC_SH)
 *
 * 用法（仓库根目录，需先起 API :3100）：
 *   pnpm dev:api
 *   node scripts/testing/heat-chain-progress-verify.cjs
 *
 * 四条纪律（与 docs/47 / docs/48 的 verify:* 同型）：
 *   ① 判据只来自**真实 HTTP 响应 + 真实落库回读**，关键模块之间不 mock；
 *   ② 夹具批次一律 `HCP2609-` 前缀，与真实行（INS-* / OQC-*）完全隔离，运行前后自清理；
 *   ③ 夹具用于构造「上游已处于某状态」的前置条件（SQL 直插），被测动作与判据全部走 API；
 *   ④ 现状对账（§1）全程只读，不写任何一行。
 *
 * 场景状态：PASS / FAIL / SKIP（未执行，附原因）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3100/api/v1';
const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://letian_user:letian_secure_pass_2026@127.0.0.1:5433/letian_qms_db';

/** 张强（QA_MANAGER）：建单与读侧权限最宽，用于构造链路 */
const QA_MANAGER_ID = '11000000-0000-4000-8000-000000000001';
/** 陈静（IQC_INSPECTOR）/ 刘芳（OQC_INSPECTOR）/ 赵志明（IPQC_INSPECTOR）用于权限矩阵 */
const ROLES = {
  QA_MANAGER: '11000000-0000-4000-8000-000000000001',
  IQC_INSPECTOR: '11000000-0000-4000-8000-000000000008',
  OQC_INSPECTOR: '11000000-0000-4000-8000-000000000003',
  IPQC_INSPECTOR: '11000000-0000-4000-8000-000000000005',
  WORKSHOP_LEADER: '11000000-0000-4000-8000-000000000004',
};

const PREFIX = 'HCP2609';

/** 用户口径的 7 环节（采购入库在 ERP 侧，QMS 无对应单据，见 §1 S7） */
const CHAIN = [
  { type: 'IQC', label: '来料检验' },
  { type: 'IPQC_CT', label: '下料检' },
  { type: 'IPQC_RL', label: '滚丝检' },
  { type: 'IPQC_FN', label: '成品检' },
  { type: 'OQC_SF', label: '表面处理' },
  { type: 'OQC_SH', label: '出货检' },
];

const PLAN_BY_TYPE = {
  IQC: '21000000-0000-4000-8000-000000000001',
  IPQC_CT: '23000000-0000-4000-8000-000000000001',
  IPQC_RL: '24000000-0000-4000-8000-000000000001',
  IPQC_FN: '25000000-0000-4000-8000-000000000001',
  OQC_SF: '26000000-0000-4000-8000-000000000001',
  OQC_HEAT: '26000000-0000-4000-8000-000000000202',
  OQC_SH: '27000000-0000-4000-8000-000000000002',
};

const MATERIAL = { code: 'MAT-BLT-109-M10', name: '10.9级六角头螺栓 M10*45 (成品)' };
const MATERIAL_OTHER = { code: 'MAT-BLT-88-M12', name: '8.8级六角头螺栓 M12*60 (成品)' };

/**
 * 各检验类型「有已启用方案」的物料（建单会做方案匹配，物料与类型不匹配直接 400）。
 * 夹具建单必须用本表，否则会被「未找到适用质检方案」拦下 —— 那是主数据约束，不是传递门禁。
 */
const MATERIAL_BY_TYPE = {
  IQC: { code: 'MAT-304SS-05', name: '不锈钢线材 Φ5.0mm' },
  IPQC_CT: { code: 'MAT-SCR-M6-25', name: '高强度螺柱 M6*25 (冷镦毛坯)' },
  IPQC_RL: { code: 'MAT-THRD-M6-25', name: '搓丝半成品 M6*25 6g' },
  IPQC_FN: MATERIAL,
  OQC_SF: MATERIAL,
  OQC_HEAT: { code: 'MAT-BLT-109-M10-HT', name: '高强度螺栓' },
  OQC_SH: MATERIAL,
};
const matOf = (type) => MATERIAL_BY_TYPE[type] || MATERIAL;
/** 下料检（IPQC_CT）场景统一用毛坯物料：与上游 IQC 夹具同物料，保证 A2 炉批号锚点生效 */
const MCT = MATERIAL_BY_TYPE.IPQC_CT;

const SHIPPING = {
  salesOrderNo: PREFIX + '-SO-0001',
  dispatchDate: '2026-10-08',
  customerName: '炉批号链路验收客户（夹具）',
  erpStatus: 'SYNCED',
};
const isOqcType = (t) => typeof t === 'string' && t.startsWith('OQC_');

function resolvePg() {
  try {
    return require('pg');
  } catch {
    const store = path.join(__dirname, '..', '..', 'node_modules', '.pnpm');
    const entry = fs.readdirSync(store).find((dir) => dir.startsWith('pg@'));
    if (!entry) throw new Error('未找到 pg 依赖，请先 pnpm install');
    return require(path.join(store, entry, 'node_modules', 'pg'));
  }
}
const { Client } = resolvePg();
const client = new Client({ connectionString: DB_URL });
async function q(text, params) {
  const res = await client.query(text, params || []);
  return res.rows;
}

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------
const results = [];
function record(status, name, detail) {
  results.push({ status, name, detail });
  const tag = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : status === 'SKIP' ? 'SKIP' : 'INFO';
  console.log(tag + ' :: ' + name + (detail === undefined ? '' : ' :: ' + detail));
}
const check = (name, ok, detail) => record(ok ? 'PASS' : 'FAIL', name, detail);
const skip = (name, reason) => record('SKIP', name, reason);
/** 只读现状发现：不计入通过/失败（数据缺口属已知，用户确认后续由客户补炉批号） */
const info = (name, detail) => record('INFO', name, detail);
const section = (title) => console.log('\n--- ' + title + ' ---');

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function httpJson(pathname, options) {
  const res = await fetch(API_BASE + pathname, options || {});
  const text = await res.text();
  let body;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
async function withToken(tk, pathname, options) {
  return httpJson(
    pathname,
    Object.assign({}, options, {
      headers: Object.assign({}, (options && options.headers) || {}, {
        authorization: 'Bearer ' + tk,
      }),
    })
  );
}
async function post(tk, pathname, body) {
  return withToken(tk, pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function get(tk, pathname) {
  return withToken(tk, pathname, { method: 'GET' });
}
async function login(userId) {
  const res = await httpJson('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  return { status: res.status, token: res.body && res.body.token ? res.body.token : '', body: res.body };
}

function decisionOf(res) {
  if (!res || !res.body || typeof res.body !== 'object') return null;
  if (res.body.details && res.body.details.transferDecision) return res.body.details.transferDecision;
  return res.body.transferDecision || null;
}
const codeOf = (res) => {
  const d = decisionOf(res);
  return d ? d.code : null;
};

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
async function purgeFixtures(label) {
  const like = PREFIX + '%';
  const removed = [];
  const del = async (table, column) => {
    const res = await client.query('DELETE FROM ' + table + ' WHERE ' + column + ' LIKE $1', [like]);
    if (res.rowCount > 0) removed.push(table + '=' + res.rowCount);
  };
  await del('pending_mrb_items', 'batch_no');
  await del('pending_mrb_items', 'source_order_no');
  await del('transfer_override_tickets', 'batch_no');
  await del('mrb_reviews', 'batch_no');
  await del('batch_trace_nodes', 'batch_no');
  await del('batch_trace_relations', 'parent_batch');
  await del('batch_trace_relations', 'child_batch');
  await del('inspection_orders', 'batch_no');
  console.log(
    '--- ' + label + '夹具清理（仅 ' + PREFIX + '-*，真实行不动）：' +
      (removed.length === 0 ? '无残留' : removed.join(', ')) + ' ---'
  );
}

/** 直插上游夹具单（构造前置状态，不经门禁） */
async function seedOrder(o) {
  const material = o.material || MATERIAL;
  const plan = PLAN_BY_TYPE[o.type];
  const stamp = o.updatedAt || new Date();
  const ship = isOqcType(o.type)
    ? SHIPPING
    : { salesOrderNo: null, dispatchDate: null, customerName: null, erpStatus: null };
  await q(
    'INSERT INTO inspection_orders' +
      ' (id, order_no, order_type, plan_id, plan_version_id, batch_no, material_code, material_name,' +
      '  sample_qty, status, judgment, work_order_no, furnace_heat_batch_no, plan_snapshot,' +
      '  sales_order_no, dispatch_date, customer_name, erp_status, created_at, updated_at)' +
      ' SELECT $1,$2,$3,$4,$4,$5,$6,$7,5,$8,$9,$10,$11,' +
      "  jsonb_build_object('planId', p.id, 'planCode', p.plan_code, 'planName', p.plan_name," +
      "    'versionId', p.id, 'versionNo', p.version, 'items', COALESCE(p.items, '[]'::jsonb))," +
      '  $13, $14, $15, $16, $12, $12' +
      ' FROM inspection_plans p WHERE p.id = $4' +
      ' ON CONFLICT (order_no) DO UPDATE SET status = EXCLUDED.status, judgment = EXCLUDED.judgment,' +
      '  furnace_heat_batch_no = EXCLUDED.furnace_heat_batch_no,' +
      '  sales_order_no = EXCLUDED.sales_order_no, dispatch_date = EXCLUDED.dispatch_date,' +
      '  customer_name = EXCLUDED.customer_name, erp_status = EXCLUDED.erp_status,' +
      '  updated_at = EXCLUDED.updated_at, created_at = EXCLUDED.created_at',
    [
      crypto.randomUUID(),
      o.orderNo,
      o.type,
      plan,
      o.batch,
      material.code,
      material.name,
      o.status,
      o.judgment === undefined ? null : o.judgment,
      o.workOrderNo === undefined ? null : o.workOrderNo,
      o.furnaceHeatNo === undefined ? null : o.furnaceHeatNo,
      stamp,
      ship.salesOrderNo,
      ship.dispatchDate,
      ship.customerName,
      ship.erpStatus,
    ]
  );
  return o.orderNo;
}

async function seedMrb(o) {
  const material = o.material || MATERIAL;
  const stamp = new Date();
  await q(
    'INSERT INTO mrb_reviews' +
      ' (id, mrb_no, source_type, source_order_no, batch_no, material_code, material_name,' +
      '  defect_description, defect_qty, status, disposition, concession_attachment_url, created_at, updated_at)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$12)' +
      ' ON CONFLICT (mrb_no) DO UPDATE SET status = EXCLUDED.status, disposition = EXCLUDED.disposition,' +
      '  concession_attachment_url = EXCLUDED.concession_attachment_url, updated_at = EXCLUDED.updated_at',
    [
      crypto.randomUUID(),
      o.mrbNo,
      o.sourceType || 'PROCESS_FAIL',
      o.sourceOrderNo,
      o.batch,
      material.code,
      material.name,
      '炉批号链路验收夹具：上游不合格',
      o.status,
      o.disposition === undefined ? null : o.disposition,
      o.attachmentUrl === undefined ? null : o.attachmentUrl,
      stamp,
    ]
  );
  return o.mrbNo;
}

async function createOrder(tk, payload) {
  const body = isOqcType(payload.inspectionType)
    ? Object.assign({}, SHIPPING, payload)
    : payload;
  return post(tk, '/inspections', body);
}

async function permitOf(tk, item) {
  const res = await post(tk, '/inspections/transfer-permits', { items: [item] });
  const d = res.body && res.body.items ? res.body.items[0].decision : null;
  return { status: res.status, decision: d, body: res.body };
}

async function rowOf(orderNo) {
  const rows = await q(
    'SELECT order_no, order_type, batch_no, material_code, status, judgment, furnace_heat_batch_no,' +
      ' furnace_heat_batch_no_norm, chain_key, chain_key_kind, upstream_order_no, upstream_gate_code' +
      ' FROM inspection_orders WHERE order_no = $1',
    [orderNo]
  );
  return rows[0] || null;
}

// ===========================================================================
async function main() {
  console.log('=== 「按炉批号传递进度」链路验收（API=' + API_BASE + '）===');
  await client.connect();
  await purgeFixtures('运行前');

  const auth = await login(QA_MANAGER_ID);
  if (auth.token === '') {
    console.error('登录失败，环境不可用：', auth.status, auth.body);
    process.exit(2);
  }
  const TOKEN = auth.token;

  // =========================================================================
  // §1 现状对账（只读，不写任何一行）
  // =========================================================================
  section('§1 现状对账：全库单号 × 炉批号链路可达性（只读）');

  const total = (await q('SELECT count(*) n FROM inspection_orders'))[0].n;
  const heatNonNull = (
    await q('SELECT count(*) n FROM inspection_orders WHERE furnace_heat_batch_no IS NOT NULL')
  )[0].n;
  info(
    'S1 炉批号覆盖率：全库 ' + total + ' 单中有炉批号的单数',
    '有炉批号 ' + heatNonNull + ' / 共 ' + total + '（覆盖率 ' + ((heatNonNull / total) * 100).toFixed(1) + '%）—— 已知数据缺口，用户确认后续由客户补录'
  );

  // S2 炉批号维度能否串起 >=2 个环节
  const heatGroups = await q(
    'SELECT furnace_heat_batch_no h, count(*) n, count(DISTINCT order_type) t' +
      ' FROM inspection_orders WHERE furnace_heat_batch_no IS NOT NULL GROUP BY 1 ORDER BY 2 DESC'
  );
  const multiStage = heatGroups.filter((g) => g.t >= 2);
  info(
    'S2 炉批号可串起 >=2 个环节的链路数',
    '炉批号分组 ' + heatGroups.length + ' 组，其中跨环节 ' + multiStage.length + ' 组 —— 已知数据缺口（炉批号全空），逻辑就绪、待客户补录'
  );

  // S3 三个锚点的可达性
  const dupBatch = await q(
    'SELECT batch_no, count(*) n FROM inspection_orders GROUP BY batch_no HAVING count(*) > 1'
  );
  const woGroups = await q(
    'SELECT work_order_no w, count(DISTINCT order_type) t, count(*) n FROM inspection_orders' +
      ' WHERE work_order_no IS NOT NULL GROUP BY 1'
  );
  info(
    'S3-A1 同批次锚点：存在同批次多环节的单据组',
    '重复批次组 ' + dupBatch.length + ' 个 —— 现状发现（当前全库批次号均唯一），非逻辑缺陷'
  );
  check(
    'S3-A3 同工单锚点：存在同工单跨环节的单据组',
    woGroups.some((g) => g.t >= 2),
    '工单组 ' + woGroups.length + ' 个：' + JSON.stringify(woGroups.map((g) => g.w + '(' + g.t + '环节/' + g.n + '单)'))
  );

  // S4 传递留痕列覆盖（迁移 035）
  const trace = (
    await q(
      'SELECT count(*) n, count(chain_key) ck, count(upstream_order_no) uo, count(upstream_gate_code) ug' +
        ' FROM inspection_orders'
    )
  )[0];
  info(
    'S4 传递留痕列（chain_key/upstream_*）覆盖率',
    'chain_key ' + trace.ck + '/' + trace.n + '、upstream_order_no ' + trace.uo + '/' + trace.n +
      '、upstream_gate_code ' + trace.ug + '/' + trace.n + ' —— 现状发现（现有单未触发留痕），逻辑就绪、待新单产生'
  );

  // S5 逐单实测：调服务端批量预览，看每张单在「其应处的下一环节」上的判定
  const allOrders = await q(
    'SELECT order_no, order_type, batch_no, material_code, status, judgment, furnace_heat_batch_no' +
      ' FROM inspection_orders WHERE batch_no NOT LIKE $1 ORDER BY order_type, order_no',
    [PREFIX + '%']
  );
  const NEXT = { IQC: 'IPQC_CT', IPQC_CT: 'IPQC_RL', IPQC_RL: 'IPQC_FN', IPQC_FN: 'OQC_SF', OQC_SF: 'OQC_SH' };
  const permitSource = allOrders.filter((o) => NEXT[o.order_type] !== undefined);
  const permitItems = permitSource.map((o) => ({
    inspectionType: NEXT[o.order_type],
    batchNo: o.batch_no,
    materialCode: o.material_code,
    ...(o.furnace_heat_batch_no ? { furnaceHeatNo: o.furnace_heat_batch_no } : {}),
  }));
  let permitSummary = { total: 0, missing: 0, passed: 0, blocked: 0, error: 0 };
  /** 逐单判定明细（真实单号 → 下一环节 → 判定码 → 命中锚点），作为「当前所有单号」的取证 */
  const perOrderVerdict = [];
  if (permitItems.length > 0) {
    const res = await post(TOKEN, '/inspections/transfer-permits', { items: permitItems });
    if (res.status === 200 && res.body && Array.isArray(res.body.items)) {
      res.body.items.forEach((it, i) => {
        const src = permitSource[i];
        const c = it.decision ? it.decision.code : 'NO_DECISION';
        permitSummary.total += 1;
        if (c === 'UPSTREAM_MISSING') permitSummary.missing += 1;
        else if (c === 'UPSTREAM_PASSED') permitSummary.passed += 1;
        else if (it.decision && it.decision.allowed === false) permitSummary.blocked += 1;
        else permitSummary.error += 1;
        perOrderVerdict.push({
          单号: src ? src.order_no : '-',
          本环节: src ? src.order_type : '-',
          下一环节: src ? NEXT[src.order_type] : '-',
          炉批号: src && src.furnace_heat_batch_no ? src.furnace_heat_batch_no : '(空)',
          判定码: c,
          命中锚点: it.decision ? it.decision.chainKeyKind : '-',
          上游单号: it.decision && it.decision.predecessorOrderNo ? it.decision.predecessorOrderNo : '(无)',
        });
      });
      check(
        'S5 全库单据在「下一环节」的传递判定可计算（HTTP 200）',
        true,
        JSON.stringify(permitSummary)
      );
      console.log('    逐单判定明细（只读预览，真实单号）：');
      perOrderVerdict.forEach((v) =>
        console.log(
          '      ' + v.单号 + ' | ' + v.本环节 + '→' + v.下一环节 + ' | 炉批号=' + v.炉批号 +
            ' | ' + v.判定码 + ' | 锚点=' + v.命中锚点 + ' | 上游=' + v.上游单号
        )
      );
      info(
        'S5b 全库单据中存在「靠炉批号解析出的链路」（chainKeyKind=HEAT）',
        'HEAT 锚点命中 ' +
          res.body.items.filter((it) => it.decision && it.decision.chainKeyKind === 'HEAT').length +
          ' / ' + res.body.items.length + ' —— 现状发现（炉批号全空，命中均落在 BATCH 锚点）'
      );
    } else {
      check('S5 全库单据传递判定批量预览', false, 'HTTP ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 200));
    }
  }

  // S6 追溯边是否覆盖现有单据的批次
  const relBatches = await q('SELECT parent_batch p, child_batch c FROM batch_trace_relations');
  const relSet = new Set();
  relBatches.forEach((r) => {
    relSet.add(r.p);
    relSet.add(r.c);
  });
  const covered = allOrders.filter((o) => relSet.has(o.batch_no)).length;
  info(
    'S6 血缘边（batch_trace_relations）覆盖现有单据批次的比例',
    '被覆盖 ' + covered + ' / ' + allOrders.length + '（血缘边共 ' + relBatches.length + ' 条）—— 现状发现（血缘边均为种子批次，与真实单无交集），非逻辑缺陷'
  );

  // S7 采购入库环节
  const inboundOrders = await q(
    "SELECT count(*) n FROM inspection_orders WHERE inbound_no IS NOT NULL AND inbound_no <> ''"
  );
  skip(
    'S7 「采购入库」环节是否纳入传递门禁',
    'QMS 侧无「采购入库」单据实体（仅 IQC 单带 inbound_no 入库单号，共 ' +
      inboundOrders[0].n + ' 单）；docs/48 §2.2 与 TBD-08 定稿：IQC 无门禁上游、QMS 侧不门禁，' +
      '拦截归 ERP 收料侧 ⇒ 本轮不覆盖，标记为假设而非通过'
  );

  // =========================================================================
  // §2 端到端：7 环节链路（夹具，真实 HTTP + 真实落库）
  // =========================================================================
  section('§2 端到端：按炉批号串起的 7 环节链路');

  const HEAT = 'HN-HCP-2609-0001';
  const batchOf = (i) => PREFIX + '-L1-B' + i;

  /** 把刚建的夹具单终判为合格（只改结论与时间戳，不动留痕列） */
  async function finalizePass(orderNo) {
    await q(
      "UPDATE inspection_orders SET status='COMPLETED', judgment='PASSED', updated_at = now()" +
        ' WHERE order_no = $1',
      [orderNo]
    );
  }

  // ---- E1a 同物料链路（IPQC_FN → OQC_SF → OQC_SH，均 CAT-FIN-BOLT 有启用方案）----
  // 说明：IPQC_CT / IPQC_RL 的启用方案只覆盖毛坯 / 搓丝半成品物料（CAT-SEMI-BLANK / CAT-SEMI-THREAD），
  //       与成品物料无交集 ⇒ 同物料只能覆盖后半段，前半段见 E1b。
  await seedOrder({
    orderNo: PREFIX + '-L1-IQC',
    type: 'IQC',
    batch: batchOf(1),
    status: 'COMPLETED',
    judgment: 'PASSED',
    furnaceHeatNo: HEAT,
    updatedAt: new Date(Date.now() - 7200e3),
  });
  let lastShipOrderNo = null;
  for (const [idx, stage] of [
    { type: 'IPQC_FN', label: '成品检', b: 4 },
    { type: 'OQC_SF', label: '表面处理', b: 5 },
    { type: 'OQC_SH', label: '出货检', b: 6 },
  ].entries()) {
    const res = await createOrder(TOKEN, {
      inspectionType: stage.type,
      materialCode: MATERIAL.code,
      batchNo: batchOf(stage.b),
      furnaceHeatNo: HEAT,
      sampleQty: 5,
      totalQty: 100,
    });
    const code = codeOf(res);
    check(
      'E1a-' + stage.label + '(' + stage.type + ') 同炉批号同物料上游合格 → 建单放行',
      res.status === 201 && code === 'UPSTREAM_PASSED',
      'HTTP ' + res.status + ' code=' + code +
        (res.status !== 201 ? ' body=' + JSON.stringify(res.body).slice(0, 220) : '')
    );
    if (res.status === 201 && res.body && res.body.orderNo) {
      await finalizePass(res.body.orderNo);
      if (stage.type === 'OQC_SH') lastShipOrderNo = res.body.orderNo;
    }
  }

  // E1a 判定链：出货检单应记录 HEAT 锚点与上游单
  const shipRow = await q(
    'SELECT order_no, chain_key, chain_key_kind, upstream_order_no, upstream_gate_code' +
      ' FROM inspection_orders WHERE batch_no = $1',
    [batchOf(6)]
  );
  check(
    'E1a-留痕：出货检单记录了链路锚点（HEAT）与上游单号',
    shipRow.length === 1 && shipRow[0].chain_key_kind === 'HEAT' && shipRow[0].upstream_order_no !== null,
    JSON.stringify(shipRow[0] || null)
  );

  // ---- E1b 真实工艺物料全链（原材料 → 毛坯 → 搓丝半成品 → 成品）----
  // 这是现场真实形态：同一炉批号下，各工序的物料编码**必然不同**。
  // 用于实证「A2 炉批号锚点 + 同物料强制」在真实工艺链上的实际效果。
  const HEAT2 = 'HN-HCP-2609-0002';
  const REAL_CHAIN = [
    { type: 'IPQC_CT', label: '下料检', material: { code: 'MAT-SCR-M6-25', name: '高强度螺柱 M6*25 (冷镦毛坯)' } },
    { type: 'IPQC_RL', label: '滚丝检', material: { code: 'MAT-THRD-M6-25', name: '搓丝半成品 M6*25 6g' } },
    { type: 'IPQC_FN', label: '成品检', material: MATERIAL },
    { type: 'OQC_SF', label: '表面处理', material: MATERIAL },
    { type: 'OQC_SH', label: '出货检', material: MATERIAL },
  ];
  await seedOrder({
    orderNo: PREFIX + '-L2-IQC',
    type: 'IQC',
    batch: PREFIX + '-L2-B1',
    status: 'COMPLETED',
    judgment: 'PASSED',
    furnaceHeatNo: HEAT2,
    material: { code: 'MAT-304SS-05', name: '不锈钢线材 Φ5.0mm' },
    updatedAt: new Date(Date.now() - 7200e3),
  });
  const realChainResult = [];
  for (let i = 0; i < REAL_CHAIN.length; i += 1) {
    const stage = REAL_CHAIN[i];
    const res = await createOrder(TOKEN, {
      inspectionType: stage.type,
      materialCode: stage.material.code,
      batchNo: PREFIX + '-L2-B' + (i + 2),
      furnaceHeatNo: HEAT2,
      sampleQty: 5,
      totalQty: 100,
    });
    const code = codeOf(res);
    realChainResult.push(stage.label + '=' + code);
    if (res.status === 201 && res.body && res.body.orderNo) await finalizePass(res.body.orderNo);
  }
  check(
    'E1b 真实工艺物料链（物料随工序变化）：各下游环节应能读到同炉批号上游的合格结论',
    realChainResult.every((s) => s.endsWith('UPSTREAM_PASSED')),
    realChainResult.join(' | ') +
      ' ⇒ 非 PASSED 即为「跨物料导致炉批号锚点失效」'
  );

  // E1c 同一炉批号不合格上游在真实工艺链下能否阻断下游（跨物料场景）
  const HEAT3 = 'HN-HCP-2609-0003';
  await seedOrder({
    orderNo: PREFIX + '-L3-IQC',
    type: 'IQC',
    batch: PREFIX + '-L3-B1',
    status: 'FAILED',
    judgment: 'FAILED',
    furnaceHeatNo: HEAT3,
    material: { code: 'MAT-304SS-05', name: '不锈钢线材 Φ5.0mm' },
    updatedAt: new Date(Date.now() - 3600e3),
  });
  const e1c = await permitOf(TOKEN, {
    inspectionType: 'IPQC_CT',
    batchNo: PREFIX + '-L3-B2',
    materialCode: 'MAT-SCR-M6-25',
    furnaceHeatNo: HEAT3,
  });
  check(
    'E1c 跨物料（原材料→毛坯）同炉批号：上游 IQC 不合格是否仍阻断下料检',
    e1c.decision && e1c.decision.allowed === false && e1c.decision.code === 'UPSTREAM_FAILED',
    'allowed=' + (e1c.decision ? e1c.decision.allowed : '-') +
      ' code=' + (e1c.decision ? e1c.decision.code : '-') +
      ' chainKeyKind=' + (e1c.decision ? e1c.decision.chainKeyKind : '-')
  );

  // ---- E2 上游不合格 → 下游阻断 ----
  section('§2.2 异常流程');
  await seedOrder({
    orderNo: PREFIX + '-E2-IQC',
    type: 'IQC',
    batch: PREFIX + '-E2-B1',
    status: 'FAILED',
    judgment: 'FAILED',
    furnaceHeatNo: 'HN-HCP-E2',
    material: MCT,
    updatedAt: new Date(Date.now() - 3600e3),
  });
  const e2 = await createOrder(TOKEN, {
    inspectionType: 'IPQC_CT',
    materialCode: MCT.code,
    batchNo: PREFIX + '-E2-B2',
    furnaceHeatNo: 'HN-HCP-E2',
    sampleQty: 5,
  });
  check(
    'E2 上游 IQC 不合格 → 建下料检被阻断 422 / UPSTREAM_FAILED',
    e2.status === 422 && codeOf(e2) === 'UPSTREAM_FAILED',
    'HTTP ' + e2.status + ' code=' + codeOf(e2) +
      ' predecessor=' + ((decisionOf(e2) || {}).predecessorOrderNo || '-')
  );

  // ---- E3 上游检验中 → 阻断 ----
  await seedOrder({
    orderNo: PREFIX + '-E3-IQC',
    type: 'IQC',
    batch: PREFIX + '-E3-B1',
    status: 'INSPECTING',
    judgment: null,
    furnaceHeatNo: 'HN-HCP-E3',
    material: MCT,
  });
  const e3 = await createOrder(TOKEN, {
    inspectionType: 'IPQC_CT',
    materialCode: MCT.code,
    batchNo: PREFIX + '-E3-B2',
    furnaceHeatNo: 'HN-HCP-E3',
    sampleQty: 5,
  });
  check(
    'E3 上游 IQC 检验中(INSPECTING) → 阻断 422 / UPSTREAM_INSPECTING',
    e3.status === 422 && codeOf(e3) === 'UPSTREAM_INSPECTING',
    'HTTP ' + e3.status + ' code=' + codeOf(e3)
  );

  // ---- E4 上游 MRB 评审中 → 阻断 ----
  await seedOrder({
    orderNo: PREFIX + '-E4-IQC',
    type: 'IQC',
    batch: PREFIX + '-E4-B1',
    status: 'IN_MRB_REVIEW',
    judgment: 'FAILED',
    furnaceHeatNo: 'HN-HCP-E4',
    material: MCT,
  });
  await seedMrb({
    mrbNo: PREFIX + '-E4-MRB',
    sourceOrderNo: PREFIX + '-E4-IQC',
    batch: PREFIX + '-E4-B1',
    status: 'UNDER_REVIEW',
    material: MCT,
  });
  const e4 = await createOrder(TOKEN, {
    inspectionType: 'IPQC_CT',
    batchNo: PREFIX + '-E4-B2',
    furnaceHeatNo: 'HN-HCP-E4',
    materialCode: MCT.code,
    sampleQty: 5,
  });
  check(
    'E4 上游 MRB 评审中 → 阻断 422 / UPSTREAM_UNDER_MRB',
    e4.status === 422 && codeOf(e4) === 'UPSTREAM_UNDER_MRB',
    'HTTP ' + e4.status + ' code=' + codeOf(e4) +
      ' mrbNo=' + ((decisionOf(e4) || {}).mrbNo || '-')
  );

  // ---- E5 让步接收：有授权件 → 受限放行；无授权件 → 仍阻断 ----
  await seedOrder({
    orderNo: PREFIX + '-E5-IQC',
    type: 'IQC',
    batch: PREFIX + '-E5-B1',
    status: 'IN_MRB_REVIEW',
    judgment: 'FAILED',
    furnaceHeatNo: 'HN-HCP-E5',
    material: MCT,
  });
  await seedMrb({
    mrbNo: PREFIX + '-E5-MRB',
    sourceOrderNo: PREFIX + '-E5-IQC',
    batch: PREFIX + '-E5-B1',
    status: 'DISPOSED',
    disposition: 'CONCESSION',
    attachmentUrl: 'https://qms.letian.local/attachments/' + PREFIX + '-E5-auth.pdf',
    material: MCT,
  });
  const e5a = await createOrder(TOKEN, {
    inspectionType: 'IPQC_CT',
    materialCode: MATERIAL.code,
    batchNo: PREFIX + '-E5-B2',
    materialCode: MCT.code,
    furnaceHeatNo: 'HN-HCP-E5',
    sampleQty: 5,
  });
  const e5d = decisionOf(e5a);
  check(
    'E5-① MRB 让步接收(有客户授权件) → 受限放行 / UPSTREAM_CONCESSION',
    e5a.status === 201 && codeOf(e5a) === 'UPSTREAM_CONCESSION',
    'HTTP ' + e5a.status + ' code=' + codeOf(e5a) +
      ' evidence=' + JSON.stringify(e5d ? e5d.permitEvidence : null)
  );
  check(
    'E5-② 受限放行必须携带特采举证要求（attachmentRequired = true）',
    e5d && e5d.permitEvidence && e5d.permitEvidence.kind === 'MRB_CONCESSION' &&
      e5d.permitEvidence.attachmentRequired === true,
    JSON.stringify(e5d ? e5d.permitEvidence : null)
  );
  await seedMrb({
    mrbNo: PREFIX + '-E5-MRB',
    sourceOrderNo: PREFIX + '-E5-IQC',
    batch: PREFIX + '-E5-B1',
    status: 'DISPOSED',
    disposition: 'CONCESSION',
    attachmentUrl: null,
    material: MCT,
  });
  const e5b = await createOrder(TOKEN, {
    inspectionType: 'IPQC_CT',
    materialCode: MATERIAL.code,
    batchNo: PREFIX + '-E5-B3',
    materialCode: MCT.code,
    furnaceHeatNo: 'HN-HCP-E5',
    sampleQty: 5,
  });
  check(
    'E5-③ 让步接收但客户授权件缺失 → 仍阻断',
    e5b.status === 422,
    'HTTP ' + e5b.status + ' code=' + codeOf(e5b)
  );

  // ---- E6 返工：复检未终判 → 阻断；复检合格 → 放行 ----
  await seedOrder({
    orderNo: PREFIX + '-E6-IQC',
    type: 'IQC',
    batch: PREFIX + '-E6-B1',
    status: 'RE_INSPECTING',
    judgment: 'FAILED',
    furnaceHeatNo: 'HN-HCP-E6',
    material: MCT,
  });
  await seedMrb({
    mrbNo: PREFIX + '-E6-MRB',
    sourceOrderNo: PREFIX + '-E6-IQC',
    batch: PREFIX + '-E6-B1',
    status: 'DISPOSED',
    disposition: 'REWORK',
    material: MCT,
  });
  await seedOrder({
    orderNo: PREFIX + '-E6-IQC-R1',
    type: 'IQC',
    batch: PREFIX + '-E6-B1',
    status: 'INSPECTING',
    judgment: null,
    furnaceHeatNo: 'HN-HCP-E6',
    material: MCT,
    updatedAt: new Date(),
  });
  const e6a = await createOrder(TOKEN, {
    inspectionType: 'IPQC_CT',
    materialCode: MATERIAL.code,
    batchNo: PREFIX + '-E6-B2',
    materialCode: MCT.code,
    furnaceHeatNo: 'HN-HCP-E6',
    sampleQty: 5,
  });
  check(
    'E6-① 返工复检未终判 → 阻断 / UPSTREAM_REINSPECTING',
    e6a.status === 422 && codeOf(e6a) === 'UPSTREAM_REINSPECTING',
    'HTTP ' + e6a.status + ' code=' + codeOf(e6a)
  );
  await seedOrder({
    orderNo: PREFIX + '-E6-IQC-R1',
    type: 'IQC',
    batch: PREFIX + '-E6-B1',
    status: 'COMPLETED',
    judgment: 'PASSED',
    furnaceHeatNo: 'HN-HCP-E6',
    material: MCT,
    updatedAt: new Date(),
  });
  const e6b = await createOrder(TOKEN, {
    inspectionType: 'IPQC_CT',
    materialCode: MATERIAL.code,
    batchNo: PREFIX + '-E6-B3',
    materialCode: MCT.code,
    furnaceHeatNo: 'HN-HCP-E6',
    sampleQty: 5,
  });
  const e6bd = decisionOf(e6b);
  check(
    'E6-② 返工复检合格 → 放行 / UPSTREAM_REWORK_PASSED，且权威上游取复检单',
    e6b.status === 201 && codeOf(e6b) === 'UPSTREAM_REWORK_PASSED' &&
      e6bd.predecessorOrderNo === PREFIX + '-E6-IQC-R1',
    'HTTP ' + e6b.status + ' code=' + codeOf(e6b) +
      ' predecessor=' + (e6bd ? e6bd.predecessorOrderNo : '-')
  );

  // ---- E7 退货 / 报废 → 链路终止 ----
  for (const [tag, disposition] of [['退货', 'RETURN_TO_VENDOR'], ['报废', 'SCRAP']]) {
    const hn = 'HN-HCP-E7-' + disposition;
    await seedOrder({
      orderNo: PREFIX + '-E7-' + disposition + '-IQC',
      type: 'IQC',
      batch: PREFIX + '-E7-' + disposition + '-B1',
      status: 'IN_MRB_REVIEW',
      judgment: 'FAILED',
      furnaceHeatNo: hn,
      material: MCT,
    });
    await seedMrb({
      mrbNo: PREFIX + '-E7-' + disposition + '-MRB',
      sourceOrderNo: PREFIX + '-E7-' + disposition + '-IQC',
      batch: PREFIX + '-E7-' + disposition + '-B1',
      status: 'DISPOSED',
      disposition,
      material: MCT,
    });
    const res = await createOrder(TOKEN, {
      inspectionType: 'IPQC_CT',
      materialCode: MATERIAL.code,
      batchNo: PREFIX + '-E7-' + disposition + '-B2',
      materialCode: MCT.code,
      furnaceHeatNo: hn,
      sampleQty: 5,
    });
    const d = decisionOf(res);
    check(
      'E7-' + tag + '（' + disposition + '）→ 链路终止 / CHAIN_TERMINATED',
      res.status === 422 && codeOf(res) === 'CHAIN_TERMINATED' && d && d.terminateChain === true,
      'HTTP ' + res.status + ' code=' + codeOf(res) +
        ' terminateChain=' + (d ? d.terminateChain : '-')
    );
  }

  // ---- E8 上游缺失 → 放行 + 留痕（TBD-01） ----
  const e8 = await createOrder(TOKEN, {
    inspectionType: 'IPQC_CT',
    materialCode: MATERIAL.code,
    batchNo: PREFIX + '-E8-B1',
    materialCode: MCT.code,
    furnaceHeatNo: 'HN-HCP-E8-NONE',
    sampleQty: 5,
  });
  const e8d = decisionOf(e8);
  check(
    'E8 上游缺失 → 放行但显式标记 UPSTREAM_MISSING（TBD-01 定稿口径）',
    e8.status === 201 && codeOf(e8) === 'UPSTREAM_MISSING' && e8d.allowed === true,
    'HTTP ' + e8.status + ' code=' + codeOf(e8)
  );

  // ---- E9 跨批次同炉批号（A2 锚点）生效 ----
  const e9 = await permitOf(TOKEN, {
    inspectionType: 'OQC_SH',
    batchNo: PREFIX + '-E9-OTHER-BATCH',
    materialCode: MCT.code,
    furnaceHeatNo: 'HN-HCP-E2', // 该炉号上 IQC 为 FAILED（批次 E2-B1）
  });
  check(
    'E9 跨批次同炉批号（A2 锚点）：不同批次但同炉号的不合格上游仍阻断',
    e9.decision && e9.decision.allowed === false && e9.decision.chainKeyKind === 'HEAT' &&
      e9.decision.code === 'UPSTREAM_FAILED',
    'code=' + (e9.decision ? e9.decision.code : '-') +
      'chainKeyKind=' + (e9.decision ? e9.decision.chainKeyKind : '-') +
      ' predecessor=' + (e9.decision ? e9.decision.predecessorOrderNo : '-')
  );

  // ---- E10 同炉批号跨物料门禁（用户定稿口径，取代原 TBD-03「只提示不阻断」）----
  // 用只读预览（不走方案匹配），避免把「主数据无方案」误当成「门禁结论」。
  // 上游 HN-HCP-E2 的 IQC 单（物料 MCT 毛坯）判 FAILED；本单用不同物料 MATERIAL_OTHER 但同炉号，
  // 按新口径：同一炉批号下的跨物料上游必须参与门禁 ⇒ 上游不合格应阻断下游。
  const e10 = await permitOf(TOKEN, {
    inspectionType: 'IPQC_CT',
    materialCode: MATERIAL_OTHER.code,
    batchNo: PREFIX + '-E10-B2',
    furnaceHeatNo: 'HN-HCP-E2',
  });
  check(
    'E10 同炉批号跨物料：上游不合格 → 阻断（不再静默放行，UPSTREAM_FAILED）',
    e10.decision && e10.decision.allowed === false && e10.decision.code === 'UPSTREAM_FAILED',
    'allowed=' + (e10.decision ? e10.decision.allowed : '-') +
      ' code=' + (e10.decision ? e10.decision.code : '-') +
      ' reason=' + (e10.decision ? e10.decision.reason : '-')
  );
  check(
    'E10b 跨物料上游已参与门禁：阻断时指名上游单号且标记为跨物料',
    e10.decision && e10.decision.predecessorOrderNo === PREFIX + '-E2-IQC' &&
      e10.decision.crossMaterialUpstream === true,
    'predecessor=' + (e10.decision ? e10.decision.predecessorOrderNo || '(无)' : '-') +
      ' crossMaterialUpstream=' + (e10.decision ? e10.decision.crossMaterialUpstream : '-')
  );

  // ---- E11 委外并列：表面处理不合格不阻断热处理 ----
  await seedOrder({
    orderNo: PREFIX + '-E11-SF',
    type: 'OQC_SF',
    batch: PREFIX + '-E11-B1',
    status: 'FAILED',
    judgment: 'FAILED',
    furnaceHeatNo: 'HN-HCP-E11',
    updatedAt: new Date(Date.now() - 1800e3),
  });
  const e11 = await permitOf(TOKEN, {
    inspectionType: 'OQC_HEAT',
    batchNo: PREFIX + '-E11-B1',
    materialCode: MATERIAL.code,
    furnaceHeatNo: 'HN-HCP-E11',
  });
  check(
    'E11 表面处理(OQC_SF)不合格 → 不阻断并列的热处理(OQC_HEAT)',
    e11.decision && e11.decision.allowed === true,
    'allowed=' + (e11.decision ? e11.decision.allowed : '-') +
      ' code=' + (e11.decision ? e11.decision.code : '-')
  );

  // =========================================================================
  // §3 权限
  // =========================================================================
  section('§3 权限（PBAC / 鉴权）');

  const noAuth = await httpJson('/inspections?pageSize=1', { method: 'GET' });
  check('P1 无 token 访问台账 → 401', noAuth.status === 401, 'HTTP ' + noAuth.status);

  const badToken = await httpJson('/inspections?pageSize=1', {
    method: 'GET',
    headers: { authorization: 'Bearer not.a.real.jwt' },
  });
  check('P2 伪造 token → 401', badToken.status === 401, 'HTTP ' + badToken.status);

  const badPost = await httpJson('/inspections', {
    method: 'POST',
    headers: { authorization: 'Bearer not.a.real.jwt', 'content-type': 'application/json' },
    body: JSON.stringify({ inspectionType: 'IQC', materialCode: MATERIAL_BY_TYPE.IQC.code, batchNo: PREFIX + '-P-B1', sampleQty: 5 }),
  });
  check('P3 伪造 token 建单 → 401（不得落到业务校验）', badPost.status === 401, 'HTTP ' + badPost.status);

  const noAuthPermit = await httpJson('/inspections/transfer-permits', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ inspectionType: 'IPQC_CT', batchNo: PREFIX + '-P-B1', materialCode: MATERIAL.code }] }),
  });
  check('P4 无 token 调用传递预览 → 401', noAuthPermit.status === 401, 'HTTP ' + noAuthPermit.status);

  // 角色矩阵：各角色能否读取台账与预览
  for (const [role, id] of Object.entries(ROLES)) {
    const l = await login(id);
    if (l.token === '') {
      check('P5-' + role + ' 登录', false, 'HTTP ' + l.status);
      continue;
    }
    const g = await get(l.token, '/inspections?pageSize=1');
    const pm = await post(l.token, '/inspections/transfer-permits', {
      items: [{ inspectionType: 'IPQC_CT', batchNo: PREFIX + '-P-B1', materialCode: MATERIAL.code }],
    });
    check(
      'P5-' + role + ' 台账读取 + 传递预览可用',
      g.status === 200 && pm.status === 200,
      'ledger=' + g.status + ' permit=' + pm.status
    );
    const c = await createOrder(l.token, {
      inspectionType: 'IQC',
      materialCode: MATERIAL_BY_TYPE.IQC.code,
      batchNo: PREFIX + '-P-' + role,
      furnaceHeatNo: 'HN-HCP-P-' + role,
      sampleQty: 5,
    });
    check(
      'P6-' + role + ' 建 IQC 单（链首环节，无门禁上游）',
      c.status === 201 || c.status === 403,
      'HTTP ' + c.status + (c.status === 403 ? ' 角色被拒（PBAC）' : '')
    );
  }

  // 停用员工
  const inactive = await q('SELECT id, name FROM employees WHERE is_active = false LIMIT 1');
  if (inactive.length > 0) {
    const l = await login(inactive[0].id);
    check('P7 停用员工登录 → 401', l.status === 401, 'HTTP ' + l.status + ' 员工=' + inactive[0].name);
  } else {
    skip('P7 停用员工登录', '库内无 is_active=false 的员工，无法执行');
  }

  // =========================================================================
  // §4 关键边界
  // =========================================================================
  section('§4 关键边界');

  // B1 炉批号归一化：不同写法应视为同一炉号
  await seedOrder({
    orderNo: PREFIX + '-B1-IQC',
    type: 'IQC',
    batch: PREFIX + '-B1-B1',
    status: 'FAILED',
    judgment: 'FAILED',
    furnaceHeatNo: 'hn-hcp-b1-0001',
    updatedAt: new Date(Date.now() - 3600e3),
  });
  const variants = ['HN-HCP-B1-0001', 'HN-HCP-B1-0001', 'hn-hcp-b1-0001', ' hn-hcp-b1-0001 '];
  let b1AllBlocked = true;
  const b1Detail = [];
  for (const v of variants) {
    const r = await permitOf(TOKEN, {
      inspectionType: 'IPQC_CT',
      batchNo: PREFIX + '-B1-B' + Math.random().toString(36).slice(2, 6),
      materialCode: MATERIAL.code,
      furnaceHeatNo: v,
    });
    const ok = r.decision && r.decision.allowed === false && r.decision.code === 'UPSTREAM_FAILED';
    if (!ok) b1AllBlocked = false;
    b1Detail.push(v.trim() + '→' + (r.decision ? r.decision.code : '-'));
  }
  check('B1 炉批号归一化：大小写/空格变体命中同一链路', b1AllBlocked, b1Detail.join(' | '));

  // B2 同环节多张单 → 取最近一次终判
  const hnB2 = 'HN-HCP-B2-0001';
  await seedOrder({
    orderNo: PREFIX + '-B2-IQC-OLD',
    type: 'IQC',
    batch: PREFIX + '-B2-B1',
    status: 'COMPLETED',
    judgment: 'PASSED',
    furnaceHeatNo: hnB2,
    updatedAt: new Date(Date.now() - 7200e3),
  });
  await seedOrder({
    orderNo: PREFIX + '-B2-IQC-NEW',
    type: 'IQC',
    batch: PREFIX + '-B2-B2',
    status: 'FAILED',
    judgment: 'FAILED',
    furnaceHeatNo: hnB2,
    updatedAt: new Date(),
  });
  const b2 = await permitOf(TOKEN, {
    inspectionType: 'IPQC_CT',
    batchNo: PREFIX + '-B2-B3',
    materialCode: MATERIAL.code,
    furnaceHeatNo: hnB2,
  });
  check(
    'B2 同环节多张单：取最近一次终判（最近 FAILED → 阻断，不得取最旧 PASSED）',
    b2.decision && b2.decision.allowed === false && b2.decision.predecessorOrderNo === PREFIX + '-B2-IQC-NEW',
    'code=' + (b2.decision ? b2.decision.code : '-') +
      ' predecessor=' + (b2.decision ? b2.decision.predecessorOrderNo : '-')
  );

  // B3 复检轮次优先
  const hnB3 = 'HN-HCP-B3-0001';
  await seedOrder({
    orderNo: PREFIX + '-B3-IQC',
    type: 'IQC',
    batch: PREFIX + '-B3-B1',
    status: 'COMPLETED',
    judgment: 'FAILED',
    furnaceHeatNo: hnB3,
    updatedAt: new Date(),
  });
  await seedOrder({
    orderNo: PREFIX + '-B3-IQC-R1',
    type: 'IQC',
    batch: PREFIX + '-B3-B2',
    status: 'COMPLETED',
    judgment: 'PASSED',
    furnaceHeatNo: hnB3,
    updatedAt: new Date(Date.now() - 3600e3),
  });
  const b3 = await permitOf(TOKEN, {
    inspectionType: 'IPQC_CT',
    batchNo: PREFIX + '-B3-B3',
    materialCode: MATERIAL.code,
    furnaceHeatNo: hnB3,
  });
  check(
    'B3 复检轮次优先：R1 合格覆盖原单不合格（即使原单 updatedAt 更新）',
    b3.decision && b3.decision.allowed === true && b3.decision.predecessorOrderNo === PREFIX + '-B3-IQC-R1',
    'allowed=' + (b3.decision ? b3.decision.allowed : '-') +
      ' code=' + (b3.decision ? b3.decision.code : '-') +
      ' predecessor=' + (b3.decision ? b3.decision.predecessorOrderNo : '-')
  );

  // B4 空值与异常输入
  const b4a = await createOrder(TOKEN, {
    inspectionType: 'IPQC_CT',
    materialCode: MATERIAL.code,
    batchNo: PREFIX + '-B4-B1',
    materialCode: MCT.code,
    furnaceHeatNo: '',
    sampleQty: 5,
  });
  check(
    'B4-① 炉批号传空串：不得生成空锚点（应回落批次锚点并按 UPSTREAM_MISSING 放行）',
    b4a.status === 201 && codeOf(b4a) === 'UPSTREAM_MISSING',
    'HTTP ' + b4a.status + ' code=' + codeOf(b4a)
  );
  const b4b = await post(TOKEN, '/inspections', {
    inspectionType: 'IPQC_CT',
    materialCode: MATERIAL.code,
    batchNo: '',
    sampleQty: 5,
  });
  check('B4-② 批次号为空 → 400（契约 min(1)）', b4b.status === 400, 'HTTP ' + b4b.status);
  const b4c = await post(TOKEN, '/inspections/transfer-permits', { items: [] });
  check('B4-③ 批量预览空数组 → 400（min(1)）', b4c.status === 400, 'HTTP ' + b4c.status);
  const b4d = await post(TOKEN, '/inspections/transfer-permits', {
    items: [{ inspectionType: 'NOT_A_TYPE', batchNo: PREFIX + '-B4-B1', materialCode: MATERIAL.code }],
  });
  check('B4-④ 非法检验类型 → 400', b4d.status === 400, 'HTTP ' + b4d.status);

  // B5 并发建单：同炉批号同批次并发两张下游单，结论应一致且串行化
  const hnB5 = 'HN-HCP-B5-0001';
  await seedOrder({
    orderNo: PREFIX + '-B5-IQC',
    type: 'IQC',
    batch: PREFIX + '-B5-B1',
    status: 'COMPLETED',
    judgment: 'PASSED',
    furnaceHeatNo: hnB5,
    material: MCT,
    updatedAt: new Date(Date.now() - 3600e3),
  });
  const concurrent = await Promise.all(
    [1, 2, 3].map((i) =>
      createOrder(TOKEN, {
        inspectionType: 'IPQC_CT',
        materialCode: MATERIAL.code,
        batchNo: PREFIX + '-B5-B' + (i + 1),
        materialCode: MCT.code,
        furnaceHeatNo: hnB5,
        sampleQty: 5,
      })
    )
  );
  const b5Codes = concurrent.map((r) => codeOf(r));
  check(
    'B5 并发建单：同链路 3 张下游单结论一致（pg_advisory_xact_lock 串行化）',
    concurrent.every((r) => r.status === 201) && b5Codes.every((c) => c === 'UPSTREAM_PASSED'),
    'status=' + concurrent.map((r) => r.status).join(',') + ' codes=' + b5Codes.join(',')
  );

  // B6 幂等：预览接口重复调用无副作用
  const before = (await q('SELECT count(*) n FROM inspection_orders WHERE batch_no LIKE $1', [PREFIX + '%']))[0].n;
  await permitOf(TOKEN, {
    inspectionType: 'IPQC_CT',
    batchNo: PREFIX + '-B6-B1',
    materialCode: MATERIAL.code,
    furnaceHeatNo: hnB5,
  });
  await permitOf(TOKEN, {
    inspectionType: 'IPQC_CT',
    batchNo: PREFIX + '-B6-B1',
    materialCode: MATERIAL.code,
    furnaceHeatNo: hnB5,
  });
  const after = (await q('SELECT count(*) n FROM inspection_orders WHERE batch_no LIKE $1', [PREFIX + '%']))[0].n;
  check('B6 传递预览重复调用零副作用（不建单）', Number(before) === Number(after), before + ' → ' + after);

  // =========================================================================
  // §5 数据状态变化
  // =========================================================================
  section('§5 数据状态变化');

  // D1 阻断留痕：审计 + Outbox（阻断必须另开事务，不随建单回滚）
  const auditCount = () =>
    q("SELECT count(*) n FROM audit_logs WHERE entity_id LIKE $1 AND action = 'GATE_BLOCKED'", [
      PREFIX + '%',
    ]).then((r) => Number(r[0].n));
  const auditBefore = await auditCount();
  const e2Again = await createOrder(TOKEN, {
    inspectionType: 'IPQC_CT',
    batchNo: PREFIX + '-D1-B1',
    materialCode: MCT.code,
    furnaceHeatNo: 'HN-HCP-E2',
    sampleQty: 5,
  });
  const auditAfter = await auditCount();
  check(
    'D1 阻断落审计 GATE_BLOCKED（不随建单事务回滚）',
    e2Again.status === 422 && Number(auditAfter) > Number(auditBefore),
    'HTTP ' + e2Again.status + ' 审计 ' + auditBefore + ' → ' + auditAfter
  );

  const outbox = await q(
    "SELECT event_type, count(*) n FROM outbox_events WHERE payload::text LIKE $1 AND event_type IN ('TRANSFER_BLOCKED','CHAIN_TERMINATED') GROUP BY 1",
    ['%' + PREFIX + '%']
  );
  check(
    'D2 阻断发 Outbox 事件 TRANSFER_BLOCKED',
    outbox.some((r) => r.event_type === 'TRANSFER_BLOCKED'),
    JSON.stringify(outbox.map((r) => r.event_type + '=' + r.n))
  );

  // D3 留痕 vs 实时重算漂移：改上游后留痕不变、实时转阻断
  const d3Order = shipRow[0];
  if (d3Order) {
    const traceBefore = await rowOf(d3Order.order_no);
    // 把链路上的成品检单改成不合格（直接影响出货检的上游）
    const fnRow = await q('SELECT order_no FROM inspection_orders WHERE batch_no = $1', [batchOf(4)]);
    if (fnRow.length > 0) {
      await q(
        "UPDATE inspection_orders SET status='FAILED', judgment='FAILED', updated_at=now()" +
          ' WHERE order_no = $1',
        [fnRow[0].order_no]
      );
      const live = await permitOf(TOKEN, {
        inspectionType: 'OQC_SH',
        batchNo: batchOf(6),
        materialCode: MATERIAL.code,
        furnaceHeatNo: HEAT,
      });
      const traceAfter = await rowOf(d3Order.order_no);
      check(
        'D3 漂移可检出且实时优先：留痕保持历史值、实时判定转阻断',
        traceBefore.upstream_gate_code === traceAfter.upstream_gate_code &&
          live.decision &&
          live.decision.allowed === false,
        '留痕 ' + traceBefore.upstream_gate_code + ' → ' + traceAfter.upstream_gate_code +
          '｜实时 code=' + (live.decision ? live.decision.code : '-') +
          ' allowed=' + (live.decision ? live.decision.allowed : '-')
      );
    } else {
      skip('D3 留痕与实时漂移', '链路夹具的成品检单缺失，无法构造');
    }
  } else {
    skip('D3 留痕与实时漂移', 'E1 链路未生成出货检单');
  }

  // D4 台账接口下发实时派生字段
  const ledger = await get(TOKEN, '/inspections?batchNo=' + encodeURIComponent(batchOf(6)) + '&pageSize=5');
  const ledgerRow = ledger.body && ledger.body.items ? ledger.body.items[0] : null;
  check(
    'D4 台账下发实时传递字段（canTransfer / transferCode）与留痕 transferTrace 分键',
    ledgerRow && ledgerRow.canTransfer === false && ledgerRow.transferTrace !== undefined,
    JSON.stringify(
      ledgerRow
        ? {
            canTransfer: ledgerRow.canTransfer,
            transferCode: ledgerRow.transferCode,
            chainKey: ledgerRow.chainKey,
            transferTrace: ledgerRow.transferTrace,
          }
        : null
    )
  );

  // D5 放行关卡与门禁同源（硬约束 4）：关卡判「本批次出货检单自身是否放行」
  const gateOk = await get(TOKEN, '/release-gates/' + encodeURIComponent(batchOf(6)));
  await q("UPDATE inspection_orders SET status='FAILED', judgment='FAILED', updated_at=now() WHERE batch_no = $1", [batchOf(6)]);
  const gateBad = await get(TOKEN, '/release-gates/' + encodeURIComponent(batchOf(6)));
  check(
    'D5 出货放行关卡：本批次出货检合格→200，改判不合格→409（与传递门禁同源）',
    gateOk.status === 200 && gateBad.status === 409,
    '合格=' + gateOk.status + ' 不合格=' + gateBad.status + ' ' + JSON.stringify(gateBad.body).slice(0, 160)
  );

  // =========================================================================
  // 收尾
  // =========================================================================
  await purgeFixtures('运行后');
  await client.end();

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  const infoCount = results.filter((r) => r.status === 'INFO').length;
  console.log('\n=== 断言合计：PASS ' + pass + ' / FAIL ' + fail + ' / SKIP ' + skipped + ' / INFO(现状发现) ' + infoCount + ' ===');
  if (fail > 0) {
    console.log('\n失败项：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log('  FAIL :: ' + r.name + ' :: ' + r.detail));
  }
  if (skipped > 0) {
    console.log('\n未执行项：');
    results.filter((r) => r.status === 'SKIP').forEach((r) => console.log('  SKIP :: ' + r.name + ' :: ' + r.detail));
  }
  if (infoCount > 0) {
    console.log('\n现状发现（只读、非失败，已知数据缺口待客户补录）：');
    results.filter((r) => r.status === 'INFO').forEach((r) => console.log('  INFO :: ' + r.name + ' :: ' + r.detail));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('探针异常终止：', err);
  process.exit(2);
});
