/**
 * 方案导入（Excel / 表格型 PDF）端到端回归（真实 PostgreSQL + app.inject 全链路）
 *
 * 断言口径：
 *   1. GET /plans/import-template 返回可解析的 .xlsx（方案导入/填写说明/物料参照三页，
 *      数据页表头与 PLAN_IMPORT_COLUMNS 一致）；
 *   2. POST /plans/import 上传合法工作簿 → 逐组落库（走 CreatePlanUseCase：服务端取号 + 保存即启用），
 *      响应 created 三态字段齐备；
 *   3. 同一文件二次导入 → 判重 skipped，不重复建方案；
 *   4. 混合文件（一组合法 + 一组校验失败）→ created/failed 并存，坏组不拖垮好组；
 *   5. 结构性错误一律 400 problem+json：非 .xlsx/.pdf 扩展名 / 缺必填表头 / 非工作簿内容 / 无文件；
 *   6. multipart 字段名不是 file 时按「缺少上传文件」拒绝；
 *   7. 表格型 PDF（fixtures/plan-import-sample.pdf，由导入模板表格另存/打印而来）走同一套校验与落库链路：
 *      解析出 6 行 → 建方案或被判重；无文字层的 PDF 明确 400 并说明原因。
 *
 * 运行：tsx test/integration/plan-import-link.test.ts（结束后清理本次新建方案）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { buildApp } from '../../src/app';
import { createApiContainer, type ApiContainer } from '../../src/container';
import { generateTestToken } from '../../src/plugins/auth';
import { PLAN_IMPORT_COLUMNS, PLAN_IMPORT_SHEET_NAME } from '../../src/lib/plan-import';
import type { ImportPlansResult } from '@letian/contracts';

const QA = { userId: '11000000-0000-4000-8000-000000000001', userName: '张强', role: 'QA_MANAGER' };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type ImportRow = Partial<Record<(typeof PLAN_IMPORT_COLUMNS)[number]['key'], string>>;

/** 用契约列定义就地搭一个导入工作簿（columns 先声明 key，数据行才能按 key 写入） */
async function buildWorkbook(rows: ImportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(PLAN_IMPORT_SHEET_NAME);
  sheet.columns = PLAN_IMPORT_COLUMNS.map((col) => ({ key: col.key, width: col.width }));
  sheet.addRow(PLAN_IMPORT_COLUMNS.map((col) => col.header));
  for (const row of rows) sheet.addRow(row);
  const output = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(output) ? output : Buffer.from(output as ArrayBuffer);
}

/** 手工拼 multipart/form-data 请求体（light-my-request 不带 form-data 组装器） */
function multipartBody(fileName: string, content: Buffer, fieldName = 'file'): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = '----planImportTestBoundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${XLSX_MIME}\r\n\r\n`
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function main() {
  const container: ApiContainer = await createApiContainer();
  const app = await buildApp({ container, logger: false });
  const authHeader = { authorization: `Bearer ${generateTestToken(QA)}` };
  const createdPlanCodes: string[] = [];

  // 主数据快照：取真实存在的分类 / 物料（判重与物料校验依赖真实口径）；
  // 检验项目不再查 ERP 字典 —— 与新建弹窗同口径，用契约包预置清单的编码（AP-* / DM-* / PF-*）
  const [categories, materials] = await Promise.all([
    container.repositories.masterData.getInventoryCategories(),
    container.repositories.masterData.getMaterials(),
  ]);
  const material = materials[0];
  const category = categories.find((item) => item.categoryCode === material?.categoryCode) ?? categories[0];
  assert.ok(material !== undefined && category !== undefined, '主数据缺失：需要至少一个分类与物料');

  const stamp = Date.now().toString(36).toUpperCase();
  const planA = `导入回归A-${stamp}`;
  const planB = `导入回归B-${stamp}`;
  const planBad = `导入回归坏-${stamp}`;

  const post = (fileName: string, content: Buffer, fieldName = 'file') => {
    const { payload, contentType } = multipartBody(fileName, content, fieldName);
    return app.inject({
      method: 'POST',
      url: '/api/v1/plans/import',
      headers: { ...authHeader, 'content-type': contentType },
      payload,
    });
  };

  try {
    // ==== 1. 模板下载：200 + xlsx MIME + 三页结构 + 数据页表头逐字一致 ====
    const tplRes = await app.inject({
      method: 'GET',
      url: '/api/v1/plans/import-template',
      headers: authHeader,
    });
    assert.equal(tplRes.statusCode, 200, `模板下载失败: ${tplRes.body}`);
    assert.ok(
      String(tplRes.headers['content-type'] ?? '').includes('spreadsheetml'),
      `模板 Content-Type 异常: ${tplRes.headers['content-type']}`
    );
    const tplWorkbook = new ExcelJS.Workbook();
    await tplWorkbook.xlsx.load(new Uint8Array(tplRes.rawPayload).buffer);
    const sheetNames = tplWorkbook.worksheets.map((sheet) => sheet.name);
    assert.deepEqual(sheetNames, [PLAN_IMPORT_SHEET_NAME, '填写说明', '物料参照'], '模板应为三页结构');
    const headerTexts = PLAN_IMPORT_COLUMNS.map((col, index) =>
      String(tplWorkbook.getWorksheet(PLAN_IMPORT_SHEET_NAME)?.getRow(1).getCell(index + 1).value)
    );
    assert.deepEqual(headerTexts, PLAN_IMPORT_COLUMNS.map((col) => col.header), '表头应与列定义一致');
    console.log('  ✓ GET /plans/import-template 返回结构正确的 .xlsx 模板');

    // ==== 2. 合法导入：物料专属方案（2 项指标） + 分类通用方案（1 项指标） ====
    const baseRow: ImportRow = {
      planName: planA,
      categoryCode: category.categoryCode,
      materialCode: material.materialCode,
      inspectionTypes: 'IQC',
      versionNo: 'V1.0',
      samplingScheme: 'GB_T_2828',
      aqlLevel: 'II',
      strictness: 'NORMAL',
    };
    const goodBook = await buildWorkbook([
      // 文字要求（落 remark 人工确认）、数值公差（NUMERIC 自动判定）、按产品标准 三种口径各一行
      { ...baseRow, presetCode: 'AP-01', standardText: '清理干净，美观光滑平整无毛刺' },
      { ...baseRow, presetCode: 'DM-06', standardText: '100±0.5' },
      {
        ...baseRow,
        planName: planB,
        materialCode: '',
        presetCode: 'PF-01',
        standardText: '按产品标准',
      },
    ]);
    const importRes = await post('plan-import.xlsx', goodBook);
    assert.equal(importRes.statusCode, 200, `导入失败: ${importRes.body}`);
    const result = importRes.json<ImportPlansResult>();
    assert.equal(result.fileName, 'plan-import.xlsx');
    assert.equal(result.totalRows, 3);
    assert.equal(result.created.length, 2, `应新建 2 个方案: ${JSON.stringify(result)}`);
    assert.equal(result.failed.length, 0, `不应有失败组: ${JSON.stringify(result.failed)}`);
    const createdA = result.created.find((item) => item.planName === planA);
    const createdB = result.created.find((item) => item.planName === planB);
    assert.ok(createdA !== undefined && createdB !== undefined, '两个方案都应在 created 中');
    assert.match(createdA.planCode, /^QP-\d{8}-\d+$/);
    assert.equal(createdA.itemCount, 2, '物料专属方案应有 2 项指标');
    assert.equal(createdB.itemCount, 1);
    createdPlanCodes.push(createdA.planCode, createdB.planCode);
    console.log(`  ✓ 合法导入：新建 ${result.created.length} 个方案（${createdA.planCode} / ${createdB.planCode}）`);

    // 落库口径：保存即启用（ACTIVE）+ 物料方案带 materialCode、通用方案 materialCode 空串
    const rowsA = await container.db
      .selectFrom('inspectionPlans')
      .select(['versionStatus', 'materialCode'])
      .where('planCode', 'in', createdPlanCodes)
      .execute();
    assert.ok(rowsA.every((row) => row.versionStatus === 'ACTIVE'), '导入版本应一律为 ACTIVE（不再进草稿）');
    const rowB = rowsA.find((row) => row.materialCode === '');
    assert.ok(rowB !== undefined, '分类通用方案落库 materialCode 应为空串');
    console.log('  ✓ 落库口径：版本 ACTIVE（保存即启用）、通用方案 materialCode 空串');

    // ==== 3. 判重：同文件二次导入 → 两组全 skipped ====
    const againRes = await post('plan-import.xlsx', goodBook);
    assert.equal(againRes.statusCode, 200, `二次导入失败: ${againRes.body}`);
    const again = againRes.json<ImportPlansResult>();
    assert.equal(again.created.length, 0, '重复导入不应再建方案');
    assert.equal(again.skipped.length, 2, `两组都应判重跳过: ${JSON.stringify(again)}`);
    assert.equal(
      again.skipped.find((item) => item.planName === planA)?.existingPlanCode,
      createdA.planCode,
      '判重应回显既有方案编码'
    );
    console.log('  ✓ 判重保护：二次导入两组全部 skipped 并回显既有编码');

    // ==== 4. 混合文件：好组建库、坏组（项目编码不存在 + 类型无法识别）进入 failed ====
    const planC = `导入回归C-${stamp}`;
    const mixedBook = await buildWorkbook([
      { ...baseRow, planName: planC, presetCode: 'AP-02', standardText: '不得有裂纹、磕碰' },
      { ...baseRow, planName: planBad, presetCode: 'ZZ-99', inspectionTypes: 'IQC' },
      { ...baseRow, planName: planBad, presetCode: 'AP-01', inspectionTypes: '不存在的类型' },
      { ...baseRow, planName: planBad, presetCode: 'AP-01', inspectionTypes: 'OQC_SH' },
    ]);
    const mixedRes = await post('mixed.xlsx', mixedBook);
    assert.equal(mixedRes.statusCode, 200, `混合导入失败: ${mixedRes.body}`);
    const mixed = mixedRes.json<ImportPlansResult>();
    assert.equal(mixed.created.length, 1, `好组应正常落库: ${JSON.stringify(mixed)}`);
    assert.equal(mixed.failed.length, 1, '坏组应进 failed');
    assert.equal(mixed.failed[0]?.planName, planBad);
    assert.ok(mixed.failed[0]!.reason.includes('ZZ-99'), '失败原因应点名不在预置清单的项目编码');
    assert.ok(mixed.failed[0]!.reason.includes('无法识别'), '失败原因应点名无法识别的质检类型');
    assert.ok(mixed.failed[0]!.reason.includes('不一致'), '类型不一致也应被点名');
    createdPlanCodes.push(mixed.created[0]!.planCode);
    console.log('  ✓ 混合导入：好组建库、坏组逐条列出失败原因');

    // ==== 4.5 表格型 PDF：与 xlsx 走同一套校验 / 落库链路 ====
    const pdfFixture = readFileSync(join(__dirname, '../fixtures/plan-import-sample.pdf'));
    const pdfRes = await post('plan-import.pdf', pdfFixture);
    assert.equal(pdfRes.statusCode, 200, `PDF 导入失败: ${pdfRes.body}`);
    const pdfResult = pdfRes.json<ImportPlansResult>();
    assert.equal(pdfResult.totalRows, 6, `PDF 应解析出 6 行数据: ${JSON.stringify(pdfResult)}`);
    assert.equal(pdfResult.failed.length, 0, `PDF 不应有失败组: ${JSON.stringify(pdfResult.failed)}`);
    assert.equal(
      pdfResult.created.length + pdfResult.skipped.length,
      1,
      'PDF 里的 6 行应聚成一个方案'
    );
    for (const item of pdfResult.created) createdPlanCodes.push(item.planCode);
    console.log(
      `  ✓ 表格型 PDF：解析 6 行 → ${pdfResult.created.length > 0 ? '新建' : '判重跳过'} 1 个方案`
    );

    // 无文字层的 PDF（空页 / 扫描件）→ 明确 400，并说明是扫描件或图片型
    const emptyPdf = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
        '2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
      'latin1'
    );
    const emptyPdfRes = await post('scanned.pdf', emptyPdf);
    assert.equal(emptyPdfRes.statusCode, 400, `无文字层 PDF 应 400: ${emptyPdfRes.statusCode}`);
    assert.ok(
      String(emptyPdfRes.json().detail).includes('读不到文字'),
      '报错应说明 PDF 没有文字层'
    );
    console.log('  ✓ 无文字层 PDF：明确 400 并提示为扫描件/图片型');

    // ==== 5. 结构性错误：全部 400 problem+json ====
    const badExt = await post('plan-import.csv', goodBook);
    assert.equal(badExt.statusCode, 400, `非 xlsx 扩展名应 400: ${badExt.statusCode}`);
    assert.equal(badExt.json().code, 'validation-failed');

    const missingCol = new ExcelJS.Workbook();
    const shortSheet = missingCol.addWorksheet(PLAN_IMPORT_SHEET_NAME);
    shortSheet.addRow(PLAN_IMPORT_COLUMNS.filter((col) => col.key !== 'remark').map((col) => col.header));
    const shortOutput = await missingCol.xlsx.writeBuffer();
    const shortBook = Buffer.isBuffer(shortOutput) ? shortOutput : Buffer.from(shortOutput as ArrayBuffer);
    const missingRes = await post('missing.xlsx', shortBook);
    assert.equal(missingRes.statusCode, 400, `缺表头列应 400: ${missingRes.statusCode}`);
    assert.ok(missingRes.json().detail.includes('备注'), '报错应点名缺失列');

    const garbageRes = await post('garbage.xlsx', Buffer.from('not a workbook at all'));
    assert.equal(garbageRes.statusCode, 400, `非工作簿内容应 400: ${garbageRes.statusCode}`);

    const noFileRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plans/import',
      headers: {
        ...authHeader,
        'content-type': 'multipart/form-data; boundary=----planImportTestBoundary',
      },
      payload: Buffer.from('------planImportTestBoundary--\r\n'),
    });
    assert.equal(noFileRes.statusCode, 400, `无文件应 400: ${noFileRes.statusCode}`);

    const wrongField = await post('plan-import.xlsx', goodBook, 'attachment');
    assert.equal(wrongField.statusCode, 400, `字段名非 file 应 400: ${wrongField.statusCode}`);
    console.log('  ✓ 结构性错误：扩展名/缺列/非工作簿/无文件/字段名错全部 400 problem+json');

    console.log('=== Excel 方案导入端到端回归全部通过 ===');
  } finally {
    if (createdPlanCodes.length > 0) {
      await container.db
        .deleteFrom('inspectionPlans')
        .where('planCode', 'in', createdPlanCodes)
        .execute();
      console.log(`清理：删除本次导入的 ${createdPlanCodes.length} 个方案`);
    }
    await app.close();
    await container.db.destroy();
  }
}

void main();
