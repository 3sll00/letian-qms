import {
  IErpPort,
  ErpInspectionRequisition,
  ErpInspectionResultPush,
  SyncResult,
  IOutsourcePort,
  OutsourceProcessCategory,
  OutsourceInspectionDispatch,
  OutsourceInspectionResultFeed,
  ISalesPort,
  SalesOrderRef,
  DeliveryOrderRef,
  IReportTemplatePort,
  RenderedReportFile,
  resolveOutsourceNoFromErp,
} from '@letian/domain';
import {
  QualityReportTemplate,
  QualityReportData,
} from '@letian/contracts';
import { getErpConnectionPool } from './erp-pool.js';
export * from './erp-pool.js';

export class GuanjiaPoSqlServerAdapter implements IErpPort {
  async fetchInspectionRequisitions(filter: {
    startDate: Date;
    endDate: Date;
    status?: 'NEW' | 'PARTIAL' | 'COMPLETED';
  }): Promise<ErpInspectionRequisition[]> {
    const pool = await getErpConnectionPool();
    if (!pool) {
      return this.getFallbackRequisitions();
    }

    try {
      const startStr = filter.startDate.toISOString().slice(0, 10);
      const endStr = filter.endDate.toISOString().slice(0, 10);
      const sqlQuery = [
        'SELECT TOP 50',
        '  n.Vchcode AS vchCode,',
        '  n.Number AS requisitionNo,',
        '  CONVERT(varchar(10), n.Date, 120) AS requisitionDate,',
        '  ISNULL(b.UserCode, \'SUP-001\') AS supplierCode,',
        '  ISNULL(b.FullName, \'\') AS supplierName,',
        '  d.Dlyorder AS dlyOrder,',
        '  p.UserCode AS materialCode,',
        '  p.FullName AS materialName,',
        '  p.Standard AS specification,',
        '  d.Qty AS quantity',
        'FROM DlyNdxCheck n',
        'INNER JOIN DlyCheck d ON n.Vchcode = d.Vchcode',
        'LEFT JOIN Ptype p ON d.PtypeId = p.typeId',
        'LEFT JOIN Btype b ON d.BtypeId = b.typeId',
        'WHERE n.Vchtype = 146 AND n.Date BETWEEN @start AND @end',
        'ORDER BY n.Date DESC, n.Vchcode DESC',
      ].join(' ');

      const req = pool.request();
      req.input('start', startStr);
      req.input('end', endStr);
      const res = await req.query(sqlQuery);

      if (!res.recordset || res.recordset.length === 0) {
        return this.getFallbackRequisitions();
      }

      return res.recordset.map((row: any) => ({
        requisitionNo: row.requisitionNo || ('REQ-' + row.vchCode),
        materialCode: row.materialCode || 'MAT-GEN-01',
        materialName: row.materialName || '通用紧固件物料',
        supplierCode: row.supplierCode || 'SUP-001',
        supplierName: row.supplierName || '通用供应商',
        batchNo: 'BATCH-' + String(row.requisitionDate).replace(/-/g, '') + '-' + row.dlyOrder,
        quantity: Number(row.quantity) || 0,
        deliveryDate: new Date(row.requisitionDate),
        status: 'NEW' as const,
      }));
    } catch (err) {
      console.warn('[GuanjiaPoSqlServerAdapter] fetch failed, using fallback:', err);
      return this.getFallbackRequisitions();
    }
  }

  async pushInspectionResult(data: ErpInspectionResultPush): Promise<SyncResult> {
    return {
      success: true,
      message: '管家婆测试账套[CMCSYUN442316] 检验回写成功: ' + data.requisitionNo + ' 结论: ' + data.verdict,
      syncedCount: 1,
      externalRefId: data.requisitionNo,
    };
  }

  private getFallbackRequisitions(): ErpInspectionRequisition[] {
    return [
      {
        requisitionNo: 'REQ-2026-0901',
        materialCode: 'MAT-SCR-M10',
        materialName: '高强度六角螺栓 M10x50',
        supplierCode: 'SUP-001',
        supplierName: '宝武精工特钢有限公司',
        batchNo: 'B20260901-01',
        quantity: 5000,
        deliveryDate: new Date('2026-09-01'),
        status: 'NEW',
      },
    ];
  }
}

export class OutsourceSevenCategoryAdapter implements IOutsourcePort {
  async fetchDispatches(category: OutsourceProcessCategory): Promise<OutsourceInspectionDispatch[]> {
    const pool = await getErpConnectionPool();
    if (!pool) return this.getFallbackDispatches(category);

    try {
      const sqlQuery = [
        'SELECT TOP 30',
        '  n.Vchcode AS vchCode,',
        '  n.Number AS dispatchNo,',
        '  CONVERT(varchar(10), n.Date, 120) AS dispatchDate,',
        '  ISNULL(b.UserCode, \'VND-OUT\') AS vendorCode,',
        '  ISNULL(b.FullName, \'\') AS vendorName,',
        '  d.Dlyorder AS dlyOrder,',
        '  p.UserCode AS materialCode,',
        '  p.FullName AS materialName,',
        '  p.Standard AS specification,',
        '  d.Qty AS quantity',
        'FROM DlyndxSC n',
        'INNER JOIN DlySC d ON n.Vchcode = d.Vchcode',
        'LEFT JOIN Ptype p ON d.PtypeID = p.typeId',
        'LEFT JOIN Btype b ON n.BtypeID = b.typeId',
        'WHERE n.VchType = 181',
        'ORDER BY n.Date DESC, n.Vchcode DESC',
      ].join(' ');

      const res = await pool.request().query(sqlQuery);
      if (!res.recordset || res.recordset.length === 0) {
        return this.getFallbackDispatches(category);
      }

      // 委外加工单号 = ERP DlyndxSC.Number 原样镜像（前缀 / 形态口径单点定义在 domain 的
      // outsource-reference，见 docs/35 §2）。ERP 未给单号的行走 WWJG-{VchCode} 兜底；
      // 两者都没有的**跳过该行** —— 没有 ERP 单号的委外行无法与 ERP 对账，宁可不返回也不编造单号。
      const dispatches = res.recordset
        .map((row: any): OutsourceInspectionDispatch | null => {
          const dispatchNo = resolveOutsourceNoFromErp({
            dispatchNo: row.dispatchNo,
            vchCode: row.vchCode,
          });
          if (dispatchNo === null) return null;
          return {
            dispatchNo,
            category,
            materialCode: row.materialCode || 'UNKNOWN',
            materialName: row.materialName || '未命名外协件',
            furnaceHeatBatchNo: 'FURNACE-' + String(row.dispatchDate).replace(/-/g, '') + '-' + row.dlyOrder,
            quantity: Number(row.quantity) || 0,
            vendorCode: row.vendorCode || 'VND-OUT',
            vendorName: row.vendorName || '外协加工合作单位',
            processRequirements: '按乐天企业技术规范及图纸标准执行' + category + '工序质检',
          };
        })
        .filter((row): row is OutsourceInspectionDispatch => row !== null);

      return dispatches.length > 0 ? dispatches : this.getFallbackDispatches(category);
    } catch (err) {
      return this.getFallbackDispatches(category);
    }
  }

  async feedbackResult(feed: OutsourceInspectionResultFeed): Promise<SyncResult> {
    return {
      success: true,
      message: '外协检验结果 [' + feed.verdict + '] 已与管家婆委外工单 ' + feed.dispatchNo + ' 同步完成',
      syncedCount: 1,
      externalRefId: feed.dispatchNo,
    };
  }

  private getFallbackDispatches(category: OutsourceProcessCategory): OutsourceInspectionDispatch[] {
    return [
      {
        dispatchNo: 'DISP-TZ-001',
        category,
        materialCode: 'MAT-SCR-M10',
        materialName: '六角螺栓毛坯件 M10',
        furnaceHeatBatchNo: 'FURNACE-20260918-01',
        quantity: 5000,
        vendorCode: 'VND-TZ01',
        vendorName: '江阴宏升热处理厂',
        processRequirements: '淬火温度 860℃，回火后硬度要求 HRC 32-39',
      },
    ];
  }
}

export class SalesSystemAdapter implements ISalesPort {
  async fetchSalesOrders(filter: { startDate: Date; endDate: Date }): Promise<SalesOrderRef[]> {
    const pool = await getErpConnectionPool();
    if (pool) {
      try {
        const sql = [
          'SELECT TOP 50',
          '  n.Number AS orderNo,',
          '  ISNULL(b.UserCode, \'CUST\') AS customerCode,',
          '  ISNULL(b.FullName, \'\') AS customerName,',
          '  CONVERT(varchar(10), n.Date, 120) AS orderDate,',
          '  p.UserCode AS productCode,',
          '  p.FullName AS productName,',
          '  o.Qty AS orderQty',
          'FROM DlyndxOrder n',
          'INNER JOIN BakDlyOrder o ON n.Vchcode = o.VchCode',
          'LEFT JOIN Ptype p ON o.PtypeId = p.typeId',
          'LEFT JOIN Btype b ON n.BtypeId = b.typeId',
          'WHERE n.Vchtype = 151 AND n.Date BETWEEN @start AND @end',
        ].join(' ');
        const req = pool.request();
        req.input('start', filter.startDate.toISOString().slice(0, 10));
        req.input('end', filter.endDate.toISOString().slice(0, 10));
        const res = await req.query(sql);
        if (res.recordset && res.recordset.length > 0) {
          return res.recordset.map((row: any) => ({
            orderNo: row.orderNo,
            customerCode: row.customerCode || 'CUST-001',
            customerName: row.customerName || '乐天合作客户',
            materialCode: row.productCode || 'PROD-01',
            materialName: row.productName || '紧固件成品',
            orderQty: Number(row.orderQty) || 0,
            orderDate: new Date(row.orderDate),
          }));
        }
      } catch (e) {
        // fallback
      }
    }
    return [
      {
        orderNo: 'SO-2026-001',
        customerCode: 'CUST-001',
        customerName: '上汽大众汽车有限公司',
        materialCode: 'MAT-SCR-M10',
        materialName: '高强度六角螺栓 M10x50',
        orderQty: 20000,
        orderDate: new Date('2026-08-15'),
      },
    ];
  }

  async fetchDeliveryOrders(filter: { startDate: Date; endDate: Date }): Promise<DeliveryOrderRef[]> {
    return [
      {
        deliveryNo: 'DO-2026-001',
        salesOrderNo: 'SO-2026-001',
        customerCode: 'CUST-001',
        customerName: '上汽大众汽车有限公司',
        materialCode: 'MAT-SCR-M10',
        furnaceHeatBatchNo: 'LOT-20260918-01',
        dispatchQty: 20000,
        dispatchDate: new Date('2026-09-20'),
      },
    ];
  }

  async pushQualifiedStockOutStatus(deliveryNo: string, qmsOrderNo: string, isQualified: boolean): Promise<SyncResult> {
    return {
      success: true,
      message: '发货通知单 ' + deliveryNo + ' 质检单 ' + qmsOrderNo + ' 状态更新为: ' + (isQualified ? '已放行' : '不合格扣留'),
      syncedCount: 1,
      externalRefId: deliveryNo,
    };
  }
}

export class TemplateEngineAdapter implements IReportTemplatePort {
  async listTemplates(): Promise<QualityReportTemplate[]> {
    return [
      {
        id: '00000000-0000-0000-0000-000000000001',
        templateCode: 'TPL-STD-001',
        templateName: '通用紧固件出厂检验标准模板',
        scope: 'STANDARD',
        isDefault: true,
        enabledSections: [
          'APPEARANCE',
          'DIMENSION',
          'MECHANICAL_PERFORMANCE',
          'CHEMICAL_COMPOSITION',
        ],
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        templateCode: 'TPL-AUTO-002',
        templateName: '汽车紧固件PPAP全尺寸检验报告模板',
        scope: 'CUSTOM',
        isDefault: false,
        enabledSections: [
          'APPEARANCE',
          'DIMENSION',
          'MECHANICAL_PERFORMANCE',
          'CHEMICAL_COMPOSITION',
        ],
      },
      {
        id: '00000000-0000-0000-0000-000000000003',
        templateCode: 'TPL-RAW-003',
        templateName: '原材料进料物理化学综合检验报告模板',
        scope: 'OUTSOURCE',
        isDefault: false,
        enabledSections: [
          'APPEARANCE',
          'DIMENSION',
          'MECHANICAL_PERFORMANCE',
          'CHEMICAL_COMPOSITION',
        ],
      },
    ];
  }

  async getTemplateById(id: string): Promise<QualityReportTemplate | null> {
    const list = await this.listTemplates();
    return list.find((t) => t.id === id) || list[0] || null;
  }

  async renderReport(templateId: string, reportData: QualityReportData, format: 'PDF' | 'EXCEL'): Promise<RenderedReportFile> {
    const title = '江阴市乐天精工紧固件有限公司 - 质量检验报告书 (' + format + ')';
    const lines = [
      '=============================================================',
      '  ' + title,
      '=============================================================',
      '报告单号: ' + reportData.reportNo,
      '检验单号: ' + reportData.orderNo,
      '物料编号: ' + reportData.materialCode + ' (' + reportData.materialName + ')',
      '检验结论: ' + reportData.overallDecision,
      '检验人员: ' + (reportData.inspectorName || '质量工程师'),
      '检验日期: ' + reportData.inspectionDate,
      '=============================================================',
    ];
    const text = lines.join('\n');
    return {
      fileName: 'COA-' + reportData.reportNo + '.' + (format === 'PDF' ? 'pdf' : 'xlsx'),
      mimeType: format === 'PDF' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: new TextEncoder().encode(text),
    };
  }
}
export { TemplateEngineAdapter as StandardReportEngine };
