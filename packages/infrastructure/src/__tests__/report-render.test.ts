import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import type { QualityReportData } from '@letian/contracts';
import { StandardReportEngine } from '../adapters/external-adapters.js';

async function run(): Promise<void> {
  const engine = new StandardReportEngine();
  const templates = await engine.listTemplates();
  assert.ok(templates.length >= 3, '应提供至少三个内置报告模板');
  assert.equal(await engine.getTemplateById('00000000-0000-0000-0000-00000000ffff'), null, '未知模板不得静默回退默认模板');

  const data: QualityReportData = {
    reportNo: 'RPT-TEST-001',
    orderNo: 'OQC-SH-20260706-0001',
    templateId: templates[0]!.id,
    templateCode: templates[0]!.templateCode,
    materialCode: 'MAT-001',
    materialName: '测试螺栓',
    materialSpec: 'M10×50',
    batchNo: 'BATCH-001',
    furnaceHeatNo: 'HT-001',
    inspectionDate: '2026-07-06',
    inspectorName: '张检验',
    overallDecision: 'PENDING',
    appearanceSection: {
      enabled: true,
      items: [{
        itemCode: 'AP-01',
        name: '表面缺陷',
        standardText: '不得有裂纹',
        measuredResult: '未检',
        conclusion: 'PENDING',
      }],
    },
    dimensionSection: {
      enabled: true,
      items: [{
        itemCode: 'DM-01',
        name: '长度',
        nominalValue: 50,
        lowerTolerance: 0.1,
        upperTolerance: 0.1,
        unit: 'mm',
        conclusion: 'PENDING',
      }],
    },
    mechanicalSection: {
      enabled: true,
      items: [{
        itemCode: 'PF-01',
        name: '硬度',
        standardRequirement: 'HRC 32 ~ 39',
        measuredVal: 35,
        unit: 'HRC',
        isManuallyModified: false,
        conclusion: 'PASSED',
      }],
    },
    chemicalSection: {
      enabled: true,
      elements: [{
        element: 'C',
        elementName: '碳',
        standardMin: 0.38,
        standardMax: 0.45,
        conclusion: 'PENDING',
      }],
    },
  };

  const pdf = await engine.renderReport(templates[0]!.id, data, 'PDF');
  assert.equal(pdf.mimeType, 'application/pdf');
  assert.equal(Buffer.from(pdf.buffer).subarray(0, 5).toString('latin1'), '%PDF-', 'PDF 输出必须具备真实文件签名');
  assert.ok(Buffer.from(pdf.buffer).includes(Buffer.from('%%EOF')), 'PDF 输出必须包含 EOF 结构');

  const excel = await engine.renderReport(templates[0]!.id, data, 'EXCEL');
  assert.equal(excel.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const bytes = Buffer.from(excel.buffer);
  assert.equal(bytes[0], 0x50, 'XLSX 输出必须是 ZIP 包');
  assert.equal(bytes[1], 0x4b, 'XLSX 输出必须是 ZIP 包');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  assert.ok(workbook.getWorksheet('基本信息'), 'XLSX 应包含基本信息页');
  assert.ok(workbook.getWorksheet('外观检验'), 'XLSX 应包含外观检验页');
  assert.ok(workbook.getWorksheet('化学成分'), 'XLSX 应包含化学成分页');

  console.log('✔ 报告 PDF/XLSX 真实文件结构与模板精确匹配验证通过');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
