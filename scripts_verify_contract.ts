/** 一次性脚本：抽样验证 MES 同步单能否通过前端同款契约校验（InspectionOrderSchema）。 */
import { execSync } from 'node:child_process';
import { sql } from 'kysely';
import { db } from './packages/infrastructure/src/database/connection.js';

const TOKEN = execSync('node gen_token.cjs', { cwd: 'D:/乐天' })
  .toString()
  .trim()
  .split('\n')
  .pop()!
  .trim();

import { InspectionOrderSchema } from './packages/contracts/dist/index.js';

(async () => {
  const target = await db
    .selectFrom('inspectionOrders')
    .select(['id', 'orderNo', 'orderType'])
    .where('orderNo', '=', 'CR20221200069')
    .executeTakeFirst();
  const others = await db
    .selectFrom('inspectionOrders')
    .select(['id', 'orderNo', 'orderType'])
    .where('inspectionNotes', 'like', '%[MES实绩同步]%')
    .orderBy(sql`random()`)
    .limit(29)
    .execute();
  const rows = [...(target ? [target] : []), ...others];

  let pass = 0;
  for (const r of rows) {
    const res = await fetch(`http://127.0.0.1:3100/api/v1/inspections/${r.id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await res.json();
    const p = InspectionOrderSchema.safeParse(json);
    if (p.success) {
      pass++;
      console.log(
        `✅ ${r.orderNo} (${r.orderType}) | 方案:${p.data.planSnapshot.planName} | 指标:${p.data.planSnapshot.items[0]?.name} | 实测:${p.data.items?.[0]?.measuredText ?? '-'} | 检验员:${p.data.inspectorName}`
      );
    } else {
      console.log(
        `❌ ${r.orderNo} (${r.orderType}) | ${p.error.issues.slice(0, 4).map((i: any) => `${i.path.join('.')}:${i.message}`).join('; ')}`
      );
    }
  }
  console.log(`\n抽样 ${rows.length} 条，通过 ${pass} 条`);
  await db.destroy();
})().catch((e) => {
  console.error('ERR:', e?.message ?? String(e));
  process.exit(1);
});
