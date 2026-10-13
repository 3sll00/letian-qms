// 全量同步驱动器：分批调用 POST /api/v1/integration/erp/sales-dispatches/sync
// 用 offset 翻页（读取层 ROW_NUMBER 分页），直到某批 total=0 为止。
// 幂等：已建单的 orderNo 会自动跳过，可安全重跑/续跑。
const { execFileSync } = require('child_process');

const NODE = 'C:/Users/Sll91/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const TOKEN = execFileSync(NODE, ['D:/乐天/gen_token.cjs'], { encoding: 'utf8' }).trim().split('\n').pop().trim();
const BASE = 'http://127.0.0.1:3100/api/v1/integration/erp/sales-dispatches/sync';
const BATCH = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let offset = 0, batches = 0;
  let cumCreated = 0, cumSkipped = 0, cumFailed = 0;
  while (true) {
    const t0 = Date.now();
    let res, j;
    try {
      res = await fetch(BASE, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: BATCH, offset }),
      });
      j = await res.json();
    } catch (e) {
      console.log(`[batch ${batches + 1}] offset=${offset} FETCH ERROR: ${e.message}; retry after 10s`);
      await sleep(10000);
      continue;
    }
    batches++;
    const t = j.total || 0, c = j.created || 0, s = j.skipped || 0, f = j.failed || 0;
    cumCreated += c; cumSkipped += s; cumFailed += f;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[batch ${batches}] offset=${offset} total=${t} created=${c} skipped=${s} failed=${f} (${secs}s) cumCreated=${cumCreated}`);
    if (j.failures && j.failures.length) console.log('  failures:', JSON.stringify(j.failures.slice(0, 8)));
    if (t === 0) { console.log('NO MORE ROWS — DONE'); break; }
    offset += BATCH;
    if (offset > 80000) { console.log('SAFETY STOP at offset>80000'); break; }
    await sleep(500);
  }
  console.log(`FINAL created=${cumCreated} skipped=${cumSkipped} failed=${cumFailed} batches=${batches}`);
})().catch((e) => { console.error('DRIVER ERROR', e); process.exit(1); });
