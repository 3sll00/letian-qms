import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../../errors/application-error.js';
import type { IExcelExporterPort, IPdfExporterPort, ExportResult } from '../../ports/export-port.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface ExportInspectionReportCommand {
  orderId: string;
  format: 'EXCEL' | 'PDF';
  operatorId: string;
  operatorName?: string;
}

export class ExportInspectionReportUseCase {
  constructor(
    private readonly uow: IUnitOfWork,
    private readonly excelExporter?: IExcelExporterPort,
    private readonly pdfExporter?: IPdfExporterPort
  ) {}

  public async execute(
    cmd: ExportInspectionReportCommand,
    securityCtx?: ISecurityContext
  ): Promise<ExportResult> {
    return await this.uow.execute(async (ctx) => {
      const order = await ctx.inspectionOrders.findById(cmd.orderId);
      if (!order) {
        throw new ApplicationError('ORDER_NOT_FOUND', `未找到检验工单 [${cmd.orderId}]`, 404);
      }

      if (securityCtx) {
        // 从物料主数据解析真实分类；查不到时 UNKNOWN 不命中任何白名单（fail-closed）
        const material = await ctx.materials.getMaterialByCode(order.materialCode);
        securityCtx.assertAccess({
          targetCategory: material?.categoryCode ?? 'UNKNOWN',
          targetMaterialCode: order.materialCode,
          ...(order.supplierCode !== undefined ? { targetSupplierCode: order.supplierCode } : {}),
        });
      }

      let exportResult: ExportResult;
      const orderDTO = order;

      if (cmd.format === 'EXCEL') {
        if (!this.excelExporter) {
          throw new ApplicationError('EXPORTER_NOT_CONFIGURED', '未配置 Excel 导出适配器', 500);
        }
        exportResult = await this.excelExporter.generateSpreadsheet({
          sheetName: `检验工单_${order.orderNo}`,
          title: `乐天精密紧固件 - 质检报告 [${order.orderNo}]`,
          subtitle: `批次: ${order.batchNo} | 物料: ${order.materialCode} | 判定: ${order.overallDecision ?? '待定'}`,
          columns: [
            { header: '检验项编号', key: 'itemCode', width: 15 },
            { header: '检验项名称', key: 'name', width: 25 },
            { header: '规格/标准', key: 'standardText', width: 20 },
            { header: '公差范围', key: 'tolerance', width: 18 },
            { header: '实测值', key: 'measuredVal', width: 15 },
            { header: '实测描述', key: 'measuredText', width: 20 },
            { header: '单项判定', key: 'result', width: 12 },
            { header: '缺陷原因', key: 'defectReason', width: 25 },
          ],
          rows: orderDTO.items.map((it) => ({
            itemCode: it.itemCode,
            name: it.name,
            standardText: it.standardText ?? '-',
            tolerance: `${it.lowerTolerance ?? '-'} ~ ${it.upperTolerance ?? '-'}`,
            measuredVal: it.measuredVal ?? '-',
            measuredText: it.measuredText ?? '-',
            result: it.result,
            defectReason: it.defectReason ?? '-',
          })),
        });
      } else {
        if (!this.pdfExporter) {
          throw new ApplicationError('EXPORTER_NOT_CONFIGURED', '未配置 PDF 导出适配器', 500);
        }
        exportResult = await this.pdfExporter.generateDocument({
          title: `乐天紧固件检验合格/判定报告`,
          subTitle: `工单号: ${order.orderNo} | 批次: ${order.batchNo}`,
          reportNo: order.orderNo,
          createdAt: new Date().toISOString(),
          watermark: '乐天紧固件受控质量凭单',
          sections: [
            {
              title: '基本信息',
              type: 'KEY_VALUE',
              content: {
                工单号: order.orderNo,
                批次号: order.batchNo,
                物料代码: order.materialCode,
                物料名称: order.materialName,
                检验类型: order.inspectionType,
                检验状态: order.status,
                综合判定: order.overallDecision ?? '未完成',
                抽样数: order.sampleQty,
              },
            },
            {
              title: '质检明细与实测记录',
              type: 'TABLE',
              content: orderDTO.items.map((it) => ({
                项目: it.name,
                标准: it.standardText ?? '-',
                公差: `${it.lowerTolerance ?? '-'} ~ ${it.upperTolerance ?? '-'}`,
                实测: it.measuredVal ?? it.measuredText ?? '-',
                判定: it.result,
              })),
            },
          ],
        });
      }

      await ctx.auditLogs.insert({
        id: randomUUID(),
        traceId: securityCtx?.traceId ?? randomUUID(),
        userId: cmd.operatorId,
        userName: cmd.operatorName ?? '系统操作员',
        action: 'UPDATE',
        resourceType: 'INSPECTION_ORDER',
        resourceId: order.id ?? cmd.orderId,
        status: 'SUCCESS',
        createdAt: new Date().toISOString(),
      });

      return exportResult;
    });
  }
}
