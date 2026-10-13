/**
 * 一次性脚本：把存量 [MES实绩同步] 检验单的 plan_snapshot / items 重写为符合契约的结构。
 *
 * 背景：同步代码此前写入的自造结构（itemName/standardValue/measuredValue/remarks +
 * {planId,version,name} 快照）不符合 contracts 的 InspectionItemSchema /
 * InspectionPlanSnapshotSchema，前端详情页 zod 严格校验失败 →「检验单详情不符合契约」。
 *
 * 用法：node --tsx scripts_fix_mes_snapshot.ts [limit]   （limit 缺省全量）
 */
import { db } from './packages/infrastructure/src/database/connection.js';

const limitArg = Number(process.argv[2]) || 0;

interface OldItem {
  seq?: number;
  itemCode?: string;
  itemName?: string;
  standardValue?: string;
  measuredValue?: string;
  result?: string;
  remarks?: string;
}

function buildPlanItems(procName: string, remark?: string) {
  return [
    {
      seq: 1,
      itemCode: 'MES-QC-01',
      name: `${procName}质检项目`,
      dataType: 'TEXT',
      metricCategory: 'MECHANICAL_PERFORMANCE',
      standardText: '按图纸公差与工艺规程执行',
      isMandatory: true,
      ...(remark ? { remark } : {}),
    },
  ];
}

(async () => {
  let q = db
    .selectFrom('inspectionOrders')
    .select(['id', 'orderNo', 'processStep', 'createdAt', 'judgment', 'items', 'planId', 'planVersionId'])
    .where('inspectionNotes', 'like', '%[MES实绩同步]%')
    .orderBy('createdAt', 'asc');
  if (limitArg > 0) q = q.limit(limitArg);
  const rows = await q.execute();
  console.log(`待修复行数: ${rows.length}`);

  let fixed = 0;
  for (const r of rows) {
    const proc = r.processStep || '工序检验';
    const isQualified = r.judgment === 'PASSED';
    let oldRemark: string | undefined;
    try {
      const old = JSON.parse(String(r.items ?? '[]')) as OldItem[];
      oldRemark = old?.[0]?.remarks;
    } catch {
      /* 旧结构解析失败就放弃 remark */
    }

    const planItems = buildPlanItems(proc, oldRemark);
    const planSnapshot = {
      planId: r.planId,
      planCode: 'MES-QC',
      planName: `MES现场质检标准-${proc}`,
      versionId: r.planVersionId,
      versionNo: 'v1.0',
      samplingScheme: '全检',
      aqlLevel: '-',
      strictness: '正常',
      items: planItems,
      snapshotAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as unknown as string)).toISOString(),
    };
    const newItems = [
      {
        seq: 1,
        itemCode: 'MES-QC-01',
        name: `${proc}质检项目`,
        dataType: 'TEXT',
        metricCategory: 'MECHANICAL_PERFORMANCE',
        standardText: '按图纸公差与工艺规程执行',
        measuredText: isQualified ? '合格' : '不合格',
        result: isQualified ? 'PASSED' : 'FAILED',
        ...(oldRemark ? { remark: oldRemark } : {}),
      },
    ];

    await db
      .updateTable('inspectionOrders')
      .set({
        planSnapshot: JSON.stringify(planSnapshot) as any,
        items: JSON.stringify(newItems) as any,
      })
      .where('id', '=', r.id)
      .execute();
    fixed++;
    if (fixed % 500 === 0) console.log(`  已修复 ${fixed}/${rows.length}`);
  }
  console.log(`修复完成: ${fixed} 行`);
  await db.destroy();
})().catch((e) => {
  console.error('ERR:', e?.message ?? String(e));
  process.exit(1);
});
