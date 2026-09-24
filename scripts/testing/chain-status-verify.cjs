/**
 * 看板「传递链状态」接口验收（`GET /api/v1/traceability/chain-status`，docs/48 §4.6 P1）
 *
 * 覆盖：
 *   ① 契约形状（Zod 唯一真相 `ChainStatusResponseSchema`）：`anchor` / `stages[]` / `summary` 必填字段到位；
 *   ② 环节排序：`stages` 按工艺序位（`seq`）升序，且与 `stage-sequence.ts` 同源；
 *   ③ **口径一致性（本探针的核心价值）**：同一张单，`chain-status` 的 `decision` 与台账行
 *      （`GET /inspections?orderNo=`）的 `transferCode` / `canTransfer` **必须逐字段一致** ——
 *      两者一旦漂移，就是「看板说能传、现场建单被拒」这类无法向客户解释的矛盾；
 *   ④ 语义分离：`summary.blockedBy.code` 取的是**该环节自身**的判定码（`stateCode`），
 *      不得等于「进入该环节的闸门码」（`decision.code`）—— 历史缺陷：`state=BLOCKED` 却下发
 *      `code=UPSTREAM_MISSING`（自相矛盾）；
 *   ⑤ 空态与校验：未知批次 -> 200 + `stages=[]` + `summary.state='MISSING'`；缺 `batchNo` -> 400。
 *
 * 前置：后端 `:3100` 已启动；演示集已播种（`pnpm db:demo:heat-trace`，批次 `TEST2609-*`）。
 * 只读：本探针**不写库**（不建单、不改状态、不写审计），随时可重复跑。
 *
 * 用法：pnpm verify:chain-status
 */
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3100/api/v1';
/** 张强（QA_MANAGER，material_categories = ["*"]）：不会被 PBAC 挡住 */
const OPERATOR_ID = '11000000-0000-4000-8000-000000000001';

/** 工艺序位（与 `packages/domain/src/models/stage-sequence.ts` 同源；此处只作独立复算，不参与判定） */
const STAGE_SEQ = {
  IQC: 1,
  IPQC_CT: 2,
  IPQC_RL: 3,
  IPQC_FN: 4,
  OQC_SF: 5,
  OQC_HEAT: 5,
  OQC_BLACK: 5,
  OQC_ZINC: 5,
  OQC_NICKEL: 5,
  OQC_PHOSPH: 5,
  OQC_DACRO: 5,
  OQC_MACH: 5,
  OQC_SH: 6,
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log((ok ? 'PASS' : 'FAIL') + ' :: ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
}

let token = '';
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

function authed(extra) {
  return Object.assign({ authorization: 'Bearer ' + token }, extra || {});
}

async function chainStatus(batchNo, extraQuery) {
  const query = '?batchNo=' + encodeURIComponent(batchNo) + (extraQuery || '');
  const res = await httpJson('/traceability/chain-status' + query, { headers: authed() });
  return { status: res.status, body: res.body };
}

/** 台账行（同一张单的服务端派生字段，用于与 chain-status 对账） */
async function ledgerRow(orderNo) {
  const res = await httpJson('/inspections?orderNo=' + encodeURIComponent(orderNo) + '&pageSize=5', {
    headers: authed(),
  });
  const items = res.body && Array.isArray(res.body.items) ? res.body.items : [];
  return items.find((row) => row.orderNo === orderNo) || null;
}

function stageOf(body, stage) {
  const stages = body && Array.isArray(body.stages) ? body.stages : [];
  return stages.find((item) => item.stage === stage) || null;
}

async function main() {
  console.log('--- 看板「传递链状态」接口验收（API=' + API_BASE + '）---');

  const login = await httpJson('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: OPERATOR_ID }),
  });
  token = login.body && login.body.token ? login.body.token : '';
  if (token === '') {
    console.error('登录失败：' + JSON.stringify(login.body));
    process.exitCode = 2;
  }
  check('登录成功（QA_MANAGER 张强）', token !== '');

  // ---------- ① 契约形状 + ③ 与台账对账（TBD-01 场景：同炉不合格） ----------
  const mrbBatch = 'TEST2609-HT-001D';
  const mrbOrder = 'OQC-HT-20260923-9104';
  const mrb = await chainStatus(mrbBatch);
  check('契约：已建单批次返回 200', mrb.status === 200, { status: mrb.status });
  check(
    '契约：必填字段到位（batchNo / anchor / stages / summary / generatedAt）',
    mrb.body &&
      typeof mrb.body.batchNo === 'string' &&
      mrb.body.anchor &&
      typeof mrb.body.anchor.kind === 'string' &&
      Array.isArray(mrb.body.stages) &&
      mrb.body.summary &&
      typeof mrb.body.generatedAt === 'string',
    { keys: mrb.body ? Object.keys(mrb.body) : null }
  );
  check(
    '锚点优先级：批次入口命中 BATCH 锚点',
    mrb.body && mrb.body.anchor.kind === 'BATCH' && mrb.body.anchor.value === mrbBatch,
    mrb.body && mrb.body.anchor
  );

  const stagesAsc = mrb.body && Array.isArray(mrb.body.stages) ? mrb.body.stages.map((s) => s.seq) : [];
  check(
    '环节排序：stages 按工艺序位升序',
    stagesAsc.length > 0 && stagesAsc.every((seq, index) => index === 0 || stagesAsc[index - 1] <= seq),
    stagesAsc
  );
  check(
    '环节序位与 stage-sequence 同源（逐环节独立复算）',
    mrb.body.stages.every((s) => STAGE_SEQ[s.stage] === s.seq),
    mrb.body.stages.map((s) => ({ stage: s.stage, seq: s.seq }))
  );

  // ---------- ④ 语义分离：blockedBy.code 取环节自身判定码 ----------
  const mrbHeat = stageOf(mrb.body, 'OQC_HEAT');
  check('TBD-01 场景：OQC_HEAT 环节已建单', mrbHeat !== null, mrbHeat && mrbHeat.orderNo);
  check(
    '环节状态与判定码一致：state=BLOCKED 必须对应自身判定码 UPSTREAM_FAILED（不是闸门码）',
    mrbHeat !== null && mrbHeat.state === 'BLOCKED' && mrbHeat.stateCode === 'UPSTREAM_FAILED',
    mrbHeat && { state: mrbHeat.state, stateCode: mrbHeat.stateCode }
  );
  check(
    'summary.blockedBy 取环节自身判定码 + 环节 + 该环节权威单（不得混入闸门码）',
    mrb.body.summary.blockedBy &&
      mrb.body.summary.blockedBy.code === mrbHeat.stateCode &&
      mrb.body.summary.blockedBy.stage === mrbHeat.stage &&
      mrb.body.summary.blockedBy.orderNo === mrbHeat.orderNo,
    mrb.body.summary.blockedBy
  );
  check(
    'summary.state = 最严重环节状态（含阻断环节时不得报 RELEASED）',
    mrb.body.summary.state === 'BLOCKED' && mrb.body.summary.blockedCount >= 1,
    { state: mrb.body.summary.state, blockedCount: mrb.body.summary.blockedCount }
  );
  check(
    '环节自带中文理由（界面直接展示，不靠前端拼）',
    typeof mrbHeat.stateReason === 'string' && mrbHeat.stateReason.length > 0,
    mrbHeat && mrbHeat.stateReason
  );

  // ---------- ③ 同一张单：chain-status 与台账派生字段逐字段一致 ----------
  const ledger = await ledgerRow(mrbOrder);
  check('台账可查到同一张单（对账前置）', ledger !== null, mrbOrder);
  check(
    '口径同源：chain-status.decision 与台账 transferCode / canTransfer 一致',
    ledger !== null &&
      mrbHeat !== null &&
      ledger.canTransfer === mrbHeat.decision.allowed &&
      ledger.transferCode === mrbHeat.decision.code,
    {
      ledger: ledger && { canTransfer: ledger.canTransfer, transferCode: ledger.transferCode },
      chain: mrbHeat && { allowed: mrbHeat.decision.allowed, code: mrbHeat.decision.code },
    }
  );

  // ---------- ② 另一条链路：上游合格但本单检验中 -> PENDING ----------
  const shBatch = 'TEST2609-SH-001';
  const sh = await chainStatus(shBatch);
  const shStage = stageOf(sh.body, 'OQC_SH');
  check('出货批次：返回 OQC_SH 环节', sh.status === 200 && shStage !== null, shStage && shStage.orderNo);
  check(
    '本单检验中 -> state=PENDING（不是 RELEASED、也不是 BLOCKED）',
    shStage !== null && shStage.state === 'PENDING' && shStage.stateCode === 'UPSTREAM_INSPECTING',
    shStage && { state: shStage.state, stateCode: shStage.stateCode, orderStatus: shStage.orderStatus }
  );
  check(
    '闸门与环节状态是两个问题：本单检验中，但进入本环节的闸门是放行的',
    shStage !== null && shStage.decision.allowed === true && shStage.decision.code === 'UPSTREAM_PASSED',
    shStage && shStage.decision
  );

  // ---------- ⑤ 空态与参数校验 ----------
  const none = await chainStatus('NO-SUCH-BATCH-2609');
  check(
    '未知批次 -> 200 + stages=[] + summary.state=MISSING（空态不报错）',
    none.status === 200 && Array.isArray(none.body.stages) && none.body.stages.length === 0 && none.body.summary.state === 'MISSING',
    { status: none.status, stages: none.body && none.body.stages.length, state: none.body && none.body.summary.state }
  );

  const bad = await httpJson('/traceability/chain-status', { headers: authed() });
  check('缺 batchNo -> 400（参数校验，不静默返回空链路）', bad.status === 400, { status: bad.status });

  const unauthorized = await httpJson('/traceability/chain-status?batchNo=' + encodeURIComponent(mrbBatch));
  check('未带 token -> 401（不泄露链路）', unauthorized.status === 401, { status: unauthorized.status });

  return null;
}

main()
  .then(() => {
    const failed = results.filter((item) => !item.ok);
    console.log('=== 汇总：' + (results.length - failed.length) + '/' + results.length + ' 通过 ===');
    process.exitCode = failed.length === 0 ? 0 : 1;
  })
  .catch((error) => {
    console.error('探针异常终止：', error);
    process.exit(2);
  });