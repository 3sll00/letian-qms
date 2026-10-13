import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

/**
 * 质检报告四段式分区枚举 (外观/尺寸/性能/化学成分)
 */
export const ReportSectionEnum = z.enum([
  'APPEARANCE',            // 外观检验段
  'DIMENSION',             // 尺寸检验段
  'MECHANICAL_PERFORMANCE', // 机械性能段
  'CHEMICAL_COMPOSITION',  // 化学成分段
]).openapi('ReportSection');

/**
 * 报告模板适用范围枚举
 */
export const ReportTemplateScopeEnum = z.enum([
  'STANDARD',   // 通用模板 (IQC/IPQC/FQC/OQC共用)
  'OUTSOURCE',  // 委外独立模板 (七分类)
  'CUSTOM',     // 客户客制化定制模板
]).openapi('ReportTemplateScope');

/**
 * 质检报告模板元数据 Schema
 */
export const QualityReportTemplateSchema = z.object({
  id: z.string().uuid().openapi({ description: '模板唯一标识 ID' }),
  templateCode: z.string().min(1).openapi({ description: '模板编码', example: 'TPL-STD-001' }),
  templateName: z.string().min(1).openapi({ description: '模板名称', example: '通用紧固件出厂检验标准模板' }),
  scope: ReportTemplateScopeEnum.default('STANDARD').openapi({ description: '适用场景' }),
  isDefault: z.boolean().default(false).openapi({ description: '是否为默认模板' }),
  enabledSections: z.array(ReportSectionEnum).default([
    'APPEARANCE',
    'DIMENSION',
    'MECHANICAL_PERFORMANCE',
    'CHEMICAL_COMPOSITION',
  ]).openapi({ description: '该模板启用的报告段落' }),
  headerConfig: z.record(z.any()).optional().openapi({ description: '抬头配置 (Logo/公司名/受控编号)' }),
  footerConfig: z.record(z.any()).optional().openapi({ description: '页脚签核配置 (质检/审核/批准)' }),
  styleConfig: z.record(z.any()).optional().openapi({ description: '排版样式配置 (字号/边距/分段打印规则)' }),
  description: z.string().optional().openapi({ description: '模板说明' }),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
}).openapi('QualityReportTemplate');

/**
 * 质检报告外观段明细项
 */
export const ReportItemDecisionEnum = z.enum(['PENDING', 'PASSED', 'FAILED', 'EXEMPT']).openapi('ReportItemDecision');

export const AppearanceSectionItemSchema = z.object({
  itemCode: z.string(),
  name: z.string(),
  standardText: z.string(),
  measuredResult: z.string(),
  conclusion: ReportItemDecisionEnum,
  defectDescription: z.string().optional(),
});

/**
 * 质检报告尺寸段明细项
 */
export const DimensionSectionItemSchema = z.object({
  itemCode: z.string(),
  name: z.string(),
  nominalValue: z.number().optional(),
  upperTolerance: z.number().optional(),
  lowerTolerance: z.number().optional(),
  unit: z.string().optional(),
  measuredVal: z.number().optional(),
  sampleSize: z.number().int().optional(),
  conclusion: ReportItemDecisionEnum,
});

/**
 * 质检报告机械性能段明细项 (抗拉/屈服/硬度/伸长率)
 */
export const MechanicalSectionItemSchema = z.object({
  itemCode: z.string(),
  name: z.string(),
  standardRequirement: z.string(),
  nominalValue: z.number().optional(),
  measuredVal: z.number().optional(),
  unit: z.string().optional(),
  inheritedFrom: z.enum(['OUTSOURCE_HEAT_TREATMENT', 'IQC_RAW_MATERIAL', 'MANUAL_ENTRY']).optional(),
  isManuallyModified: z.boolean().default(false),
  conclusion: ReportItemDecisionEnum,
});

/**
 * 质检报告化学成分段元素明细项 (C, Si, Mn, P, S, Cr, Ni, Mo等)
 */
export const ChemicalElementItemSchema = z.object({
  element: z.string().openapi({ description: '化学元素符号', example: 'C' }),
  elementName: z.string().openapi({ description: '元素中文名称', example: '碳' }),
  standardText: z.string().optional().openapi({ description: '方案快照中的标准原文' }),
  standardMin: z.number().optional().openapi({ description: '标准下限(%)' }),
  standardMax: z.number().optional().openapi({ description: '标准上限(%)' }),
  measuredVal: z.number().optional().openapi({ description: '实测百分比含量(%)；未录入时缺省' }),
  conclusion: ReportItemDecisionEnum,
});

/**
 * 质检报告四段式完整数据模型 Schema
 */
export const QualityReportDataSchema = z.object({
  reportNo: z.string().openapi({ description: '检验报告编号' }),
  orderNo: z.string().openapi({ description: '关联检验单号' }),
  templateId: z.string().uuid().optional(),
  templateCode: z.string().optional(),
  materialCode: z.string(),
  materialName: z.string(),
  materialSpec: z.string().optional(),
  batchNo: z.string(),
  furnaceHeatNo: z.string().optional().openapi({ description: '炉批号' }),
  supplierName: z.string().optional(),
  customerName: z.string().optional(),
  inspectionDate: z.string(),
  inspectorName: z.string().optional(),
  overallDecision: z.enum(['PENDING', 'PASSED', 'FAILED', 'CONCESSION']),
  
  // 四段结构数据
  appearanceSection: z.object({
    enabled: z.boolean().default(true),
    items: z.array(AppearanceSectionItemSchema).default([]),
  }),
  dimensionSection: z.object({
    enabled: z.boolean().default(true),
    items: z.array(DimensionSectionItemSchema).default([]),
  }),
  mechanicalSection: z.object({
    enabled: z.boolean().default(true),
    items: z.array(MechanicalSectionItemSchema).default([]),
  }),
  chemicalSection: z.object({
    enabled: z.boolean().default(true),
    elements: z.array(ChemicalElementItemSchema).default([]),
  }),
}).openapi('QualityReportData');

/**
 * 打印/导出质检报告请求 Schema
 */
export const GenerateReportRequestSchema = z.object({
  orderId: z.string().uuid().optional().openapi({ description: '检验单唯一标识；与 orderNo 至少提供一项' }),
  orderNo: z.string().min(1).optional().openapi({ description: '检验单号；与 orderId 至少提供一项' }),
  templateId: z.string().uuid().optional().openapi({ description: '选用报告模板ID (不传则采用默认模板)' }),
  sections: z.array(ReportSectionEnum).optional().openapi({ description: '指定导出的分段 (不传则全部段落)' }),
  format: z.enum(['PDF', 'EXCEL', 'JSON']).default('PDF').openapi({ description: '导出格式；JSON 为服务端组装后的四段式数据预览' }),
}).openapi('GenerateReportRequest');

/**
 * 批量导出报告请求 Schema (支持日期范围筛选)
 */
export const BatchExportReportRequestSchema = z.object({
  templateId: z.string().uuid().optional(),
  startDate: z.string().openapi({ description: '检验起始日期 YYYY-MM-DD' }),
  endDate: z.string().openapi({ description: '检验截止日期 YYYY-MM-DD' }),
  inspectionType: z.string().optional(),
  batchNo: z.string().optional(),
  format: z.enum(['ZIP_PDF', 'EXCEL']).default('ZIP_PDF'),
}).openapi('BatchExportReportRequest');

export type ReportSectionLayoutDTO = {
  section: z.infer<typeof ReportSectionEnum>;
  enabled: boolean;
  pageBreakAfter?: boolean;
};
