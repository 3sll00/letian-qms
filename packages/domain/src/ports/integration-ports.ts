import {
  QualityReportTemplate,
  QualityReportData,
} from '@letian/contracts';

export interface ErpInspectionRequisition {
  requisitionNo: string;
  materialCode: string;
  materialName: string;
  supplierCode: string;
  supplierName: string;
  batchNo: string;
  quantity: number;
  deliveryDate: Date;
  status: 'NEW' | 'PARTIAL' | 'COMPLETED';
}

export interface ErpInspectionResultPush {
  requisitionNo: string;
  qmsOrderNo: string;
  materialCode: string;
  batchNo: string;
  sampleQty: number;
  qualifiedQty: number;
  unqualifiedQty: number;
  verdict: 'PASS' | 'FAIL' | 'CONCESSION';
  inspector: string;
  inspectionDate: Date;
}

export interface SyncResult {
  success: boolean;
  message: string;
  syncedCount?: number;
  externalRefId?: string;
}

export interface IErpPort {
  fetchInspectionRequisitions(filter: {
    startDate: Date;
    endDate: Date;
    status?: 'NEW' | 'PARTIAL' | 'COMPLETED';
  }): Promise<ErpInspectionRequisition[]>;

  pushInspectionResult(data: ErpInspectionResultPush): Promise<SyncResult>;
}

export type OutsourceProcessCategory =
  | 'HEAT_TREATMENT'
  | 'BLACKENING'
  | 'GALVANIZING'
  | 'NICKEL_PLATING'
  | 'PHOSPHATING'
  | 'DACROMET'
  | 'CARBURIZING_MACHINING';

export interface OutsourceInspectionDispatch {
  dispatchNo: string;
  category: OutsourceProcessCategory;
  materialCode: string;
  materialName: string;
  furnaceHeatBatchNo?: string;
  quantity: number;
  vendorCode: string;
  vendorName: string;
  processRequirements: string;
}

export interface OutsourceInspectionResultFeed {
  dispatchNo: string;
  category: OutsourceProcessCategory;
  qmsOrderNo: string;
  qualifiedQty: number;
  unqualifiedQty: number;
  verdict: 'PASS' | 'FAIL';
  hardness?: number;
  layerThickness?: number;
  metallographicResult?: string;
  inspector: string;
}

export interface IOutsourcePort {
  fetchDispatches(category: OutsourceProcessCategory): Promise<OutsourceInspectionDispatch[]>;
  feedbackResult(feed: OutsourceInspectionResultFeed): Promise<SyncResult>;
}

export interface SalesOrderRef {
  orderNo: string;
  customerCode: string;
  customerName: string;
  customerAddress?: string;
  projectNo?: string;
  shortProjectNo?: string;
  materialCode: string;
  materialName: string;
  orderQty: number;
  orderDate: Date;
}

export interface DeliveryOrderRef {
  deliveryNo: string;
  salesOrderNo: string;
  customerCode: string;
  customerName: string;
  customerAddress?: string;
  projectNo?: string;
  shortProjectNo?: string;
  manufactureDate?: Date;
  materialCode: string;
  furnaceHeatBatchNo?: string;
  dispatchQty: number;
  dispatchDate: Date;
}

export interface ISalesPort {
  fetchSalesOrders(filter: { startDate: Date; endDate: Date }): Promise<SalesOrderRef[]>;
  fetchDeliveryOrders(filter: { startDate: Date; endDate: Date }): Promise<DeliveryOrderRef[]>;
  pushQualifiedStockOutStatus(deliveryNo: string, qmsOrderNo: string, isQualified: boolean): Promise<SyncResult>;
}

export interface RenderedReportFile {
  fileName: string;
  mimeType: string;
  buffer: Uint8Array;
}

export interface IReportTemplatePort {
  listTemplates(): Promise<QualityReportTemplate[]>;
  getTemplateById(id: string): Promise<QualityReportTemplate | null>;
  renderReport(templateId: string, reportData: QualityReportData, format: 'PDF' | 'EXCEL'): Promise<RenderedReportFile>;
}
