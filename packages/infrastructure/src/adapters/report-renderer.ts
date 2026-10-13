import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import type { QualityReportData, ReportItemDecision } from '@letian/contracts';
import type { RenderedReportFile } from '@letian/domain';

const DECISION_LABEL: Record<ReportItemDecision | 'CONCESSION', string> = {
  PENDING: '未检',
  PASSED: '合格',
  FAILED: '不合格',
  EXEMPT: '免检',
  CONCESSION: '让步接收',
};

const INHERITED_SOURCE_LABEL: Record<string, string> = {
  OUTSOURCE_HEAT_TREATMENT: '委外热处理带出',
  IQC_RAW_MATERIAL: '来料检验带出',
  MANUAL_ENTRY: '人工录入',
};

type FontCandidate = { path: string; family?: string };

const REPORT_FONT_CANDIDATES: readonly FontCandidate[] = [
  ...(process.env.QMS_REPORT_FONT_PATH
    ? [{
        path: process.env.QMS_REPORT_FONT_PATH,
        ...(process.env.QMS_REPORT_FONT_FAMILY
          ? { family: process.env.QMS_REPORT_FONT_FAMILY }
          : {}),
      }]
    : []),
  { path: 'C:/Windows/Fonts/Deng.ttf' },
  { path: 'C:/Windows/Fonts/simhei.ttf' },
  { path: 'C:/Windows/Fonts/msyh.ttc', family: 'MicrosoftYaHei' },
  { path: 'C:/Windows/Fonts/simsun.ttc', family: 'SimSun' },
  { path: '/mnt/c/Windows/Fonts/Deng.ttf' },
  { path: '/mnt/c/Windows/Fonts/simhei.ttf' },
  { path: '/mnt/c/Windows/Fonts/msyh.ttc', family: 'MicrosoftYaHei' },
  { path: '/mnt/c/Windows/Fonts/simsun.ttc', family: 'SimSun' },
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'NotoSansCJKsc-Regular' },
  { path: '/usr/share/fonts/noto/NotoSansCJK-Regular.ttc', family: 'NotoSansCJKsc-Regular' },
  { path: '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', family: 'NotoSansCJKsc-Regular' },
  { path: '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', family: 'WenQuanYiMicroHei' },
];

function applyReportFont(doc: PDFKit.PDFDocument): void {
  for (const candidate of REPORT_FONT_CANDIDATES) {
    if (!existsSync(candidate.path)) continue;
    try {
      if (candidate.family !== undefined) {
        doc.font(candidate.path, candidate.family);
      } else if (!candidate.path.toLowerCase().endsWith('.ttc')) {
        doc.font(candidate.path);
      } else {
        continue;
      }
      return;
    } catch {
      // 尝试下一个候选字体；最终回退 PDFKit 标准字体，保证文件结构仍有效。
    }
  }
  doc.font('Helvetica');
}

function text(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

function decisionLabel(value: string): string {
  return DECISION_LABEL[value as keyof typeof DECISION_LABEL] ?? value;
}

function reportFileName(data: QualityReportData, extension: 'pdf' | 'xlsx'): string {
  const safeReportNo = data.reportNo.replace(/[\\/:*?"<>|\s]+/g, '_');
  return `COA-${safeReportNo}.${extension}`;
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number): void {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

function writeInfo(doc: PDFKit.PDFDocument, label: string, value: unknown): void {
  ensureSpace(doc, 16);
  doc.fontSize(9).fillColor('#334155').text(`${label}：${text(value)}`, {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
  });
}

function drawTable(
  doc: PDFKit.PDFDocument,
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  columnWeights: readonly number[]
): void {
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const widths = columnWeights.map((weight) => contentWidth * weight);

  const drawRow = (cells: readonly unknown[], isHeader: boolean): void => {
    doc.fontSize(isHeader ? 8.5 : 8);
    const cellTexts = cells.map((cell) => text(cell));
    const height = Math.max(
      18,
      ...cellTexts.map((cell, index) =>
        doc.heightOfString(cell, { width: Math.max(20, (widths[index] ?? 40) - 8) })
      )
    ) + 8;
    ensureSpace(doc, height);
    const startX = doc.page.margins.left;
    const y = doc.y;

    if (isHeader) {
      doc.save().rect(startX, y, contentWidth, height).fill('#E2E8F0').restore();
    }

    let x = startX;
    cellTexts.forEach((cell, index) => {
      const width = widths[index] ?? 40;
      doc.rect(x, y, width, height).stroke('#CBD5E1');
      doc
        .fillColor(isHeader ? '#0F172A' : '#334155')
        .text(cell, x + 4, y + 4, { width: Math.max(12, width - 8) });
      x += width;
    });
    doc.y = y + height;
    doc.x = startX;
  };

  ensureSpace(doc, 34);
  drawRow(headers, true);
  for (const row of rows) drawRow(row, false);
  if (rows.length === 0) drawRow(['—'], false);
  doc.moveDown(0.7);
}

function writeSectionTitle(doc: PDFKit.PDFDocument, title: string): void {
  ensureSpace(doc, 30);
  doc.fontSize(12).fillColor('#0F172A').text(title, { underline: false });
  doc.moveDown(0.3);
}

async function renderPdf(data: QualityReportData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      applyReportFont(doc);
      doc.fontSize(17).fillColor('#0F172A').text('质量检验报告书', { align: 'center' });
      doc.fontSize(9).fillColor('#64748B').text('江阴市乐天精工紧固件有限公司', { align: 'center' });
      doc.moveDown(0.8);

      writeInfo(doc, '报告编号', data.reportNo);
      writeInfo(doc, '检验单号', data.orderNo);
      writeInfo(doc, '报告模板', data.templateCode ?? data.templateId);
      writeInfo(doc, '物料', `${data.materialCode} / ${data.materialName}`);
      writeInfo(doc, '规格型号', data.materialSpec);
      writeInfo(doc, '批次号', data.batchNo);
      writeInfo(doc, '炉批号', data.furnaceHeatNo);
      writeInfo(doc, '供应商', data.supplierName);
      writeInfo(doc, '客户', data.customerName);
      writeInfo(doc, '检验日期', data.inspectionDate);
      writeInfo(doc, '检验人员', data.inspectorName);
      writeInfo(doc, '综合判定', decisionLabel(data.overallDecision));
      doc.moveDown(0.5);

      if (data.appearanceSection.enabled) {
        writeSectionTitle(doc, '一、外观检验');
        drawTable(
          doc,
          ['项目编码', '项目名称', '标准要求', '实测结果', '判定'],
          data.appearanceSection.items.map((item) => [
            item.itemCode,
            item.name,
            item.standardText,
            item.measuredResult,
            decisionLabel(item.conclusion),
          ]),
          [0.13, 0.18, 0.32, 0.25, 0.12]
        );
      }

      if (data.dimensionSection.enabled) {
        writeSectionTitle(doc, '二、尺寸检验');
        drawTable(
          doc,
          ['项目编码', '项目名称', '标称值', '公差', '实测值', '单位', '判定'],
          data.dimensionSection.items.map((item) => [
            item.itemCode,
            item.name,
            item.nominalValue,
            item.lowerTolerance !== undefined || item.upperTolerance !== undefined
              ? `${text(item.lowerTolerance)} / ${text(item.upperTolerance)}`
              : '—',
            item.measuredVal ?? '未检',
            item.unit,
            decisionLabel(item.conclusion),
          ]),
          [0.12, 0.22, 0.13, 0.18, 0.13, 0.09, 0.13]
        );
      }

      if (data.mechanicalSection.enabled) {
        writeSectionTitle(doc, '三、机械性能检验');
        drawTable(
          doc,
          ['项目编码', '项目名称', '标准要求', '实测值', '单位', '来源', '判定'],
          data.mechanicalSection.items.map((item) => [
            item.itemCode,
            item.name,
            item.standardRequirement,
            item.measuredVal ?? '未检',
            item.unit,
            item.inheritedFrom !== undefined
              ? INHERITED_SOURCE_LABEL[item.inheritedFrom] ?? item.inheritedFrom
              : '—',
            decisionLabel(item.conclusion),
          ]),
          [0.11, 0.19, 0.28, 0.12, 0.08, 0.12, 0.1]
        );
      }

      if (data.chemicalSection.enabled) {
        writeSectionTitle(doc, '四、化学成分检验');
        drawTable(
          doc,
          ['元素', '名称', '标准要求', '实测值(%)', '判定'],
          data.chemicalSection.elements.map((item) => [
            item.element,
            item.elementName,
            item.standardText ??
              (item.standardMin !== undefined || item.standardMax !== undefined
                ? `${text(item.standardMin)} ~ ${text(item.standardMax)}`
                : '—'),
            item.measuredVal ?? '未检',
            decisionLabel(item.conclusion),
          ]),
          [0.12, 0.18, 0.39, 0.18, 0.13]
        );
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

type CellValue = string | number | null;

function addWorksheet(
  workbook: ExcelJS.Workbook,
  name: string,
  headers: readonly string[],
  rows: readonly (readonly CellValue[])[],
  widths: readonly number[]
): void {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = headers.map((header, index) => ({
    header,
    key: `c${index + 1}`,
    width: widths[index] ?? 16,
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE2E8F0' },
  };
  for (const row of rows) sheet.addRow([...row]);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

async function renderExcel(data: QualityReportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Letian QMS';
  workbook.created = new Date();

  const info = workbook.addWorksheet('基本信息');
  info.columns = [{ width: 18 }, { width: 48 }];
  [
    ['报告编号', data.reportNo],
    ['检验单号', data.orderNo],
    ['报告模板', data.templateCode ?? data.templateId ?? ''],
    ['物料编码', data.materialCode],
    ['物料名称', data.materialName],
    ['规格型号', data.materialSpec ?? ''],
    ['批次号', data.batchNo],
    ['炉批号', data.furnaceHeatNo ?? ''],
    ['供应商', data.supplierName ?? ''],
    ['客户', data.customerName ?? ''],
    ['检验日期', data.inspectionDate],
    ['检验人员', data.inspectorName ?? ''],
    ['综合判定', decisionLabel(data.overallDecision)],
  ].forEach(([label, value]) => info.addRow([label, value]));
  info.getColumn(1).font = { bold: true };

  if (data.appearanceSection.enabled) {
    addWorksheet(
      workbook,
      '外观检验',
      ['项目编码', '项目名称', '标准要求', '实测结果', '判定'],
      data.appearanceSection.items.map((item) => [
        item.itemCode,
        item.name,
        item.standardText,
        item.measuredResult,
        decisionLabel(item.conclusion),
      ]),
      [14, 24, 42, 28, 12]
    );
  }

  if (data.dimensionSection.enabled) {
    addWorksheet(
      workbook,
      '尺寸检验',
      ['项目编码', '项目名称', '标称值', '下公差', '上公差', '实测值', '单位', '判定'],
      data.dimensionSection.items.map((item) => [
        item.itemCode,
        item.name,
        item.nominalValue ?? null,
        item.lowerTolerance ?? null,
        item.upperTolerance ?? null,
        item.measuredVal ?? '未检',
        item.unit ?? '',
        decisionLabel(item.conclusion),
      ]),
      [14, 24, 14, 14, 14, 14, 10, 12]
    );
  }

  if (data.mechanicalSection.enabled) {
    addWorksheet(
      workbook,
      '机械性能',
      ['项目编码', '项目名称', '标准要求', '实测值', '单位', '数据来源', '判定'],
      data.mechanicalSection.items.map((item) => [
        item.itemCode,
        item.name,
        item.standardRequirement,
        item.measuredVal ?? '未检',
        item.unit ?? '',
        item.inheritedFrom !== undefined
          ? INHERITED_SOURCE_LABEL[item.inheritedFrom] ?? item.inheritedFrom
          : '',
        decisionLabel(item.conclusion),
      ]),
      [14, 24, 42, 14, 10, 20, 12]
    );
  }

  if (data.chemicalSection.enabled) {
    addWorksheet(
      workbook,
      '化学成分',
      ['元素', '元素名称', '标准原文', '标准下限(%)', '标准上限(%)', '实测值(%)', '判定'],
      data.chemicalSection.elements.map((item) => [
        item.element,
        item.elementName,
        item.standardText ?? '',
        item.standardMin ?? null,
        item.standardMax ?? null,
        item.measuredVal ?? '未检',
        decisionLabel(item.conclusion),
      ]),
      [12, 18, 36, 16, 16, 16, 12]
    );
  }

  const output = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(output) ? output : Buffer.from(output as ArrayBuffer);
}

export async function renderReportFile(
  data: QualityReportData,
  format: 'PDF' | 'EXCEL'
): Promise<RenderedReportFile> {
  if (format === 'PDF') {
    return {
      fileName: reportFileName(data, 'pdf'),
      mimeType: 'application/pdf',
      buffer: await renderPdf(data),
    };
  }
  return {
    fileName: reportFileName(data, 'xlsx'),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await renderExcel(data),
  };
}
