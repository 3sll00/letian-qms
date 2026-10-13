/**
 * 表格型 PDF 导入自验：抽文字层 → 聚行 → 按表头列位还原 → 走完整校验链路（不落库）。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs apps/api/scripts/verify-plan-pdf.ts <表格.pdf>
 */
import fs from 'node:fs';
import { extractPdfTextItems } from '../src/lib/pdf-text';
import { groupPdfRows, pdfRowsToTable } from '../src/lib/pdf-table';
import { PLAN_IMPORT_COLUMNS, parsePlanImportPdf } from '../src/lib/plan-import';

async function main() {
  const file = process.argv[2] ?? 'D:/乐天/_test/plan-table.pdf';
  const buffer = fs.readFileSync(file);

  const items = extractPdfTextItems(buffer);
  console.log(`【文本片段】${items.length} 条`);
  for (const item of items.slice(0, 8)) {
    console.log(`  (page=${item.page} x=${item.x.toFixed(1)} y=${item.y.toFixed(1)}) ${item.text}`);
  }

  const rows = groupPdfRows(items);
  console.log(`\n【聚行】${rows.length} 行`);
  for (const row of rows.slice(0, 4)) {
    console.log(`  y=${row.y.toFixed(1)} [${row.items.length} 片段] ${row.items.map((i) => i.text).join(' | ')}`);
  }

  const table = pdfRowsToTable(rows, {
    keys: PLAN_IMPORT_COLUMNS.map((column) => column.key),
    headers: PLAN_IMPORT_COLUMNS.map((column) => column.header),
  });
  console.log(`\n【列还原】headerFound=${table.headerFound} 数据行=${table.rows.length}`);
  for (const record of table.rows.slice(0, 3)) {
    console.log('  ', JSON.stringify(record));
  }

  const masterData = {
    categories: [{ categoryCode: 'CAT-FIN-BOLT', categoryName: '紧固件' }],
    materials: [
      { materialCode: 'MAT-STUD-A2-M24-140', materialName: '全螺纹螺柱 M24-3.0×140', categoryCode: 'CAT-FIN-BOLT' },
    ],
  } as never;

  try {
    const parsed = parsePlanImportPdf(buffer, masterData);
    console.log(`\n【完整解析】rows=${parsed.totalRows} groups=${parsed.groups.length} failures=${parsed.failures.length}`);
    for (const failure of parsed.failures) console.log('  × ', failure.reason);
    for (const item of parsed.groups[0]?.items ?? []) {
      console.log(
        `  - ${item.itemCode} ${item.name} | ${item.dataType} | ${item.metricCategory} | ` +
          `nominal=${item.nominalValue ?? '-'} +${item.upperTolerance ?? '-'}/-${item.lowerTolerance ?? '-'} | ` +
          `remark=${item.remark ?? '-'}`
      );
    }
  } catch (error) {
    console.log('\n【完整解析】失败：', error instanceof Error ? error.message : String(error));
  }
}

void main();
