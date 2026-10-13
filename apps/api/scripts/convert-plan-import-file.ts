/**
 * 把「旧口径（ERP 检验项目字典 00001~00009）」已填写的导入文件转换为新口径
 * （预置检验项目清单 AP-* / DM-* / PF-*），并就地做一次解析层自验（不落库）。
 *
 * 转换规则（旧字典编码 → 新预置项目）：
 *   00001 外观            → AP-01 表面毛疵
 *   00002 尺寸（多尺寸）   → 拆行：DM-06 长度 L / DM-04 螺纹大径 d（按标准值里的分号拆）
 *   00003 通止            → DM-09 螺纹实配
 *   00004 硬度            → PF-01 硬度 (HRC/HV)
 *   00005 拉伸            → PF-02 抗拉强度 (MPa)
 *   00006 光谱            → PF-07 化学成分（光谱）
 *   00008 冲击            → PF-03 保证载荷/楔负载（语义最近的力学项，需人工复核）
 *   00007 挑选工时 / 00009 不良品描述 → 无对应预置项，跳过并列出
 *
 * 旧文件的「检验方式 / 检验设备 / 公差 / 备注」新模板没有对应列，统一并入备注，避免丢信息。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs apps/api/scripts/convert-plan-import-file.ts <旧文件> <新文件>
 */
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import { PLAN_IMPORT_COLUMNS, parsePlanImportWorkbook } from '../src/lib/plan-import';
import { findPlanPreset } from '@letian/contracts';

interface LegacyRow {
  planName: string;
  categoryCode: string;
  materialCode: string;
  inspectionTypes: string;
  versionNo: string;
  samplingScheme: string;
  aqlLevel: string;
  strictness: string;
  testItemCode: string;
  standardText: string;
  dif: string;
  checkWay: string;
  measurementTool: string;
  remark: string;
}

/** 旧字典编码 → 新预置项目编码（多尺寸行按标准值里的分号拆分到多个项目，顺序即拆分顺序） */
const LEGACY_MAP: Record<string, string[]> = {
  '00001': ['AP-01'],
  '00002': ['DM-06', 'DM-04'], // 长度 L / 螺纹大径 d（按标准值分号顺序）
  '00003': ['DM-09'],
  '00004': ['PF-01'],
  '00005': ['PF-02'],
  '00006': ['PF-07'],
  '00008': ['PF-03'],
};

function readLegacy(file: string): LegacyRow[] {
  // 同步读取（脚本一次性跑完，无需异步流）
  const workbook = new ExcelJS.Workbook();
  const buffer = fs.readFileSync(file);
  return (async () => {
    await workbook.xlsx.load(new Uint8Array(buffer).buffer as ArrayBuffer);
    const sheet = workbook.getWorksheet('方案导入') ?? workbook.worksheets[0]!;
    const header = new Map<string, number>();
    sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
      const text = String(cell.value ?? '').replace(/[\s*＊]/g, '');
      if (text !== '') header.set(text, col);
    });
    const pick = (row: ExcelJS.Row, name: string): string => {
      const col = header.get(name);
      if (col === undefined) return '';
      const value = row.getCell(col).value;
      return value === null || value === undefined ? '' : String(value).trim();
    };
    const rows: LegacyRow[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const legacy: LegacyRow = {
        planName: pick(row, '方案名称'),
        categoryCode: pick(row, '产品分类编码'),
        materialCode: pick(row, '物料编码'),
        inspectionTypes: pick(row, '质检类型'),
        versionNo: pick(row, '版本号'),
        samplingScheme: pick(row, '抽样方案'),
        aqlLevel: pick(row, 'AQL水平'),
        strictness: pick(row, '检验严格度'),
        testItemCode: pick(row, '检验项目编码'),
        standardText: pick(row, '标准值'),
        dif: pick(row, '公差'),
        checkWay: pick(row, '检验方式'),
        measurementTool: pick(row, '检验设备'),
        remark: pick(row, '备注'),
      };
      if (legacy.testItemCode === '' && legacy.standardText === '') return;
      rows.push(legacy);
    });
    return rows;
  })() as unknown as LegacyRow[];
}

/** 备注拼装：检验方式 / 检验设备 / 公差 / 原备注，空值跳过，用「；」连接 */
function buildRemark(row: LegacyRow, extra: string[]): string {
  return [...extra, row.dif === '' ? '' : `公差：${row.dif}`, row.checkWay, row.measurementTool, row.remark]
    .filter((part) => part !== '')
    .join('；');
}

async function main() {
  const src = process.argv[2] ?? 'D:/乐天/全螺纹螺柱M24_A2-304_质检方案导入模板.xlsx';
  const dest =
    process.argv[3] ?? 'D:/乐天/全螺纹螺柱M24_A2-304_质检方案导入模板_新口径.xlsx';

  const legacyRows = await readLegacy(src);
  console.log(`【旧文件】${src} → 数据行 ${legacyRows.length}`);

  const converted: Record<string, string>[] = [];
  const skipped: string[] = [];

  for (const row of legacyRows) {
    const targets = LEGACY_MAP[row.testItemCode];
    if (targets === undefined) {
      skipped.push(`旧编码 ${row.testItemCode}（标准值：${row.standardText}）无对应预置项目，已跳过`);
      continue;
    }
    // 标准值按分号拆成多段，与 targets 顺序一一对应；拆不开就整段给第一个项目
    const segments = row.standardText
      .split(/[；;]/)
      .map((part) => part.trim())
      .filter((part) => part !== '');
    targets.forEach((presetCode, index) => {
      const preset = findPlanPreset(presetCode);
      if (preset === undefined) {
        skipped.push(`预置项目 ${presetCode} 不存在，已跳过`);
        return;
      }
      // 标准值能按分号与项目数一一对应 → 各取一段；拆不开就整段原文给每个项目（不丢要求、不重复）
      const standard = segments.length === targets.length ? segments[index]! : row.standardText;
      const extras: string[] = [];
      converted.push({
        planName: row.planName,
        categoryCode: row.categoryCode,
        materialCode: row.materialCode,
        inspectionTypes: row.inspectionTypes,
        versionNo: row.versionNo === '' ? 'V1.0' : row.versionNo,
        samplingScheme: row.samplingScheme,
        aqlLevel: row.aqlLevel,
        strictness: row.strictness,
        categoryKey: preset.category.name,
        presetCode: preset.item.code,
        standardText: standard,
        remark: buildRemark(row, extras),
      });
    });
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('方案导入', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = PLAN_IMPORT_COLUMNS.map((col) => ({ key: col.key, width: col.width }));
  const headerRow = sheet.getRow(1);
  PLAN_IMPORT_COLUMNS.forEach((col, index) => {
    headerRow.getCell(index + 1).value = col.header;
  });
  headerRow.font = { bold: true };
  for (const row of converted) sheet.addRow(row);
  await workbook.xlsx.writeFile(dest);
  console.log(`【新文件】${dest} → 数据行 ${converted.length}`);
  for (const line of skipped) console.log('  ! ', line);

  // 解析层自验：分类 / 物料沿用旧文件里的真实编码（此处只做存在性校验，不查库）
  const first = legacyRows[0]!;
  const masterData = {
    categories: [{ categoryCode: first.categoryCode, categoryName: first.categoryCode }],
    materials: [{ materialCode: first.materialCode, materialName: first.materialCode, categoryCode: first.categoryCode }],
  } as never;
  const parsed = await parsePlanImportWorkbook(fs.readFileSync(dest), masterData);
  console.log(
    `\n【自验】rows=${parsed.totalRows} groups=${parsed.groups.length} failures=${parsed.failures.length}`
  );
  for (const failure of parsed.failures) console.log('  × ', failure.reason);
  for (const item of parsed.groups[0]?.items ?? []) {
    console.log(
      `  - ${item.itemCode} ${item.name} | ${item.dataType} | ${item.metricCategory} | ` +
        `standardText=${item.standardText ?? '(空)'} | remark=${item.remark ?? '-'}`
    );
  }
}

void main();
