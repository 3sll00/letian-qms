export interface ExportResult {
  filename: string;
  mimeType: string;
  data: Uint8Array;
  sizeBytes: number;
}

export interface ExcelSheetColumn {
  header: string;
  key: string;
  width?: number;
}

export interface ExcelExportOptions {
  sheetName: string;
  columns: ExcelSheetColumn[];
  rows: Record<string, unknown>[];
  title?: string;
  subtitle?: string;
}

export interface IExcelExporterPort {
  generateSpreadsheet(options: ExcelExportOptions): Promise<ExportResult>;
}

export interface PdfSection {
  title: string;
  content: string | Record<string, unknown> | Array<Record<string, unknown>>;
  type: 'TEXT' | 'KEY_VALUE' | 'TABLE';
}

export interface PdfExportOptions {
  title: string;
  subTitle?: string;
  reportNo: string;
  createdAt: string;
  sections: PdfSection[];
  watermark?: string;
}

export interface IPdfExporterPort {
  generateDocument(options: PdfExportOptions): Promise<ExportResult>;
}
