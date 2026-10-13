/**
 * 导入方案模板改造后的自验脚本（只读解析层，不落库、不污染数据）。
 *
 * 验证三件事：
 *   1. 新模板「方案导入」页表头 = PLAN_IMPORT_COLUMNS；
 *   2. 说明页带出预置检验项目清单（与新建弹窗同源）；
 *   3. 解析器的标准值双轨：数值口径 → NUMERIC + 公差；文字要求 → TEXT/QUALITATIVE + remark、standardText 留空；
 *      不在清单的项目编码 / 类别错配 / 组内重复 → 逐条失败原因。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-plan-import-template.ts
 */
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import { PLAN_IMPORT_COLUMNS, parsePlanImportWorkbook } from '../src/lib/plan-import';
import { PLAN_CHECK_CATEGORIES } from '@letian/contracts';

async function main() {
  // 默认读手工下载的模板；也可传入路径：node …/cli.mjs scripts/verify-plan-import-template.ts <模板.xlsx>
  const file = process.argv[2] ?? 'D:/乐天/质检方案导入模板.xlsx';
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(file) as unknown as ArrayBuffer);

  const sheet = workbook.getWorksheet('方案导入')!;
  const headers = PLAN_IMPORT_COLUMNS.map((col, index) =>
    String(sheet.getRow(1).getCell(index + 1).value)
  );
  console.log('【数据页表头】', headers.join(' | '));

  const guide = workbook.getWorksheet('填写说明')!;
  const guideLines: string[] = [];
  guide.eachRow((row) => {
    const first = row.getCell(1).value;
    if (typeof first === 'string' && first !== '') guideLines.push(first.slice(0, 60));
  });
  console.log('【说明页行数】', guideLines.length);
  console.log('【规则首条】', guideLines[1]);
  console.log('【清单标题】', guideLines.find((line) => line.includes('预置检验项目清单')) ?? '(缺失)');

  // 从模板「物料参照」页取真实分类/物料编码作为主数据（校验分类/物料存在性用）
  const matSheet = workbook.getWorksheet('物料参照')!;
  const firstMat = matSheet.getRow(2);
  const materialCode = String(firstMat.getCell(1).value ?? '');
  const categoryCode = String(firstMat.getCell(3).value ?? '');
  const masterData = {
    categories: [{ categoryCode, categoryName: '样例分类' }],
    materials: [{ materialCode, materialName: '样例物料', categoryCode }],
  } as never;

  const build = async (rows: Record<string, string>[]): Promise<Buffer> => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('方案导入');
    ws.columns = PLAN_IMPORT_COLUMNS.map((col) => ({ key: col.key, width: col.width }));
    ws.addRow(PLAN_IMPORT_COLUMNS.map((col) => col.header));
    for (const row of rows) ws.addRow(row);
    const out = await wb.xlsx.writeBuffer();
    return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
  };

  const base = {
    planName: '自验方案-不落库',
    categoryCode,
    materialCode,
    inspectionTypes: 'IQC',
    versionNo: 'V1.0',
    samplingScheme: 'GB_T_2828',
    aqlLevel: 'II',
    strictness: 'NORMAL',
  };

  const good = await build([
    { ...base, categoryKey: '外观检验', presetCode: 'AP-01', standardText: '清理干净，美观光滑平整无毛刺' },
    { ...base, categoryKey: '尺寸检验', presetCode: 'DM-06', standardText: '100±0.5' },
    { ...base, categoryKey: '尺寸检验', presetCode: '牙距 P', standardText: '3+0.2/-0.1' },
    { ...base, categoryKey: '性能检验', presetCode: 'PF-01', standardText: '按产品标准', remark: '抽检 5 件' },
  ]);
  const parsed = await parsePlanImportWorkbook(good, masterData);
  console.log('\n【合法文件】rows=%d groups=%d failures=%d', parsed.totalRows, parsed.groups.length, parsed.failures.length);
  for (const item of parsed.groups[0]?.items ?? []) {
    console.log(
      `  - ${item.itemCode} ${item.name} | ${item.dataType} | metric=${item.metricCategory} | ` +
        `nominal=${item.nominalValue ?? '-'} +${item.upperTolerance ?? '-'}/-${item.lowerTolerance ?? '-'} | ` +
        `dif=${item.dif ?? '-'} | standardText=${item.standardText ?? '(空)'} | remark=${item.remark ?? '-'}`
    );
  }

  const bad = await build([
    { ...base, presetCode: 'ZZ-99', standardText: 'x' },
    { ...base, presetCode: 'AP-01', categoryKey: '尺寸检验', standardText: 'x' },
    { ...base, presetCode: 'AP-01', standardText: 'x' },
    { ...base, presetCode: 'AP-01', standardText: 'x' },
    { ...base, presetCode: '', standardText: 'x' },
  ]);
  const badParsed = await parsePlanImportWorkbook(bad, masterData);
  console.log('\n【问题文件】failures=%d', badParsed.failures.length);
  for (const reason of badParsed.failures[0]?.reason.split('；') ?? []) {
    console.log('  × ', reason);
  }

  console.log('\n【预置清单条目数】', PLAN_CHECK_CATEGORIES.map((c) => `${c.name}:${c.items.length}`).join(' / '));
}

void main();
