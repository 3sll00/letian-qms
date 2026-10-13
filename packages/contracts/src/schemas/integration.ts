import { z } from 'zod';

// ============================================================================
// 1. ERP 6大基础主数据档案与组织档案模型
// ============================================================================

export const MaterialSchema = z.object({
  id: z.string().uuid().optional(),
  materialCode: z.string().min(1, '物料编码不能为空'),
  materialName: z.string().min(1, '物料名称不能为空'),
  specModel: z.string().optional(),
  categoryCode: z.string().min(1, '分类编码不能为空'),
  unit: z.string().default('个'),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const InventoryCategorySchema = z.object({
  id: z.string().uuid().optional(),
  categoryCode: z.string().min(1, '存货分类编码不能为空'),
  categoryName: z.string().min(1, '存货分类名称不能为空'),
  parentCode: z.string().optional(),
  level: z.number().int().min(1).default(1),
  createdAt: z.string().optional(),
});

/**
 * 检验项目字典（ERP `TestItem` 表镜像，docs/45 单向同步口径的扩展）。
 *
 * ERP 检验方案明细 `T_Inf_PtypeCheckingSchemeDly.TITypeId` 参照本字典；
 * `bBuy/bProduce/bConsign` 三个环节标志决定该检验项目在哪个质检阶段可选：
 *   bBuy -> 来料检验(IQC)，bProduce -> 过程检验(IPQC·FQC)，bConsign -> 委外/出货检验(OQC)。
 */
export const TestItemSchema = z.object({
  id: z.string().uuid().optional(),
  /** ERP `TestItem.TypeID`（如 '00001'）——方案指标行 `testItemCode` 的回链键 */
  testItemCode: z.string().min(1, '检验项目编码不能为空'),
  /** ERP `TestItem.FullName`（如 '外观'） */
  name: z.string().min(1, '检验项目名称不能为空'),
  namePy: z.string().optional(),
  testStandard: z.string().optional(),
  appliesToBuy: z.boolean().default(true).openapi({ description: '来料检验环节可选（ERP bBuy）' }),
  appliesToProduce: z.boolean().default(true).openapi({ description: '生产/过程检验环节可选（ERP bProduce）' }),
  appliesToConsign: z.boolean().default(true).openapi({ description: '委外/出货检验环节可选（ERP bConsign）' }),
  sortNo: z.number().int().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const SupplierSchema = z.object({
  id: z.string().uuid().optional(),
  supplierCode: z.string().min(1, '供应商编码不能为空'),
  supplierName: z.string().min(1, '供应商名称不能为空'),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  createdAt: z.string().optional(),
});

export const CustomerSchema = z.object({
  id: z.string().uuid().optional(),
  customerCode: z.string().min(1, '客户编码不能为空'),
  customerName: z.string().min(1, '客户名称不能为空'),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  /** 客户地址，对接管家婆 Btype.TelAndAddress 或销售订单送货地址 */
  address: z.string().optional(),
  createdAt: z.string().optional(),
});

export const WorkshopSchema = z.object({
  id: z.string().uuid().optional(),
  workshopCode: z.string().min(1, '车间编码不能为空'),
  workshopName: z.string().min(1, '车间名称不能为空'),
  createdAt: z.string().optional(),
});

export const EmployeeSchema = z.object({
  id: z.string().uuid().optional(),
  employeeCode: z.string().min(1, '员工工号不能为空'),
  name: z.string().min(1, '员工姓名不能为空'),
  department: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  isActive: z.boolean().default(true),
  /** 主角色编码，关联角色字典 roles.role_code */
  roleCode: z.string().optional(),
  createdAt: z.string().optional(),
});

/**
 * 企业档案（迁移 029）：证书抬头「签发主体 / 供货单位 / 产地」的唯一真实来源（单行主数据）。
 * 未维护的字段一律为空 —— 证书按空白渲染，绝不用推测值或模板硬编码常量填充（docs/35 §6）。
 */
export const CompanyProfileSchema = z.object({
  legalName: z.string().optional().openapi({ description: '企业法定名称（证书抬头中文）', example: '江阴乐天紧固件制造有限公司' }),
  legalNameEn: z.string().optional().openapi({ description: '企业英文名称（证书抬头英文）' }),
  shortName: z.string().optional().openapi({ description: '企业简称' }),
  address: z.string().optional().openapi({ description: '企业地址' }),
  originPlace: z.string().optional().openapi({ description: '产地（质量证书「供货单位/产地」格）' }),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  qualityStamp: z.string().optional().openapi({ description: '证书印章文字', example: '江阴乐天质检' }),
  updatedBy: z.string().optional().openapi({ description: '最后维护人（服务端按当前登录用户写入）' }),
  updatedAt: z.string().optional().openapi({ description: '最后维护时间 (ISO 8601)' }),
}).openapi('CompanyProfile');

/** 企业档案写入请求：`updatedBy` / `updatedAt` 由服务端填写，客户端不得传入 */
export const UpsertCompanyProfileRequestSchema = CompanyProfileSchema.omit({
  updatedBy: true,
  updatedAt: true,
}).openapi('UpsertCompanyProfileRequest');

// ============================================================================
// 2. MES/ERP 系统集成配置与同步日志模型
// ============================================================================

export const SystemTypeEnum = z.enum(['MES', 'ERP']);

export const IntegrationConfigSchema = z.object({
  id: z.string().uuid().optional(),
  systemType: SystemTypeEnum,
  serviceUrl: z.string().url('必须是合法的服务地址URL'),
  authToken: z.string().optional(),
  subscribedWorkshops: z.array(z.string()).default([]),
  subscribedProcesses: z.array(z.string()).default([]),
  cronSchedule: z.string().default('0 */5 * * * *'), // 统一默认每5分钟轮询
  enabled: z.boolean().default(true),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const SyncDirectionEnum = z.enum(['PULL', 'PUSH']);

export const SyncStatusEnum = z.enum(['SUCCESS', 'PARTIAL_FAIL', 'FAILED']);

export const IntegrationSyncLogSchema = z.object({
  id: z.string().uuid().optional(),
  batchNo: z.string().min(1, '批次号不能为空'),
  systemType: SystemTypeEnum,
  syncDirection: SyncDirectionEnum,
  status: SyncStatusEnum,
  recordsCount: z.number().int().min(0).default(0),
  errorDetails: z.string().optional(),
  createdAt: z.string().optional(),
});

export const TriggerSyncRequestSchema = z.object({
  systemType: SystemTypeEnum,
  syncScope: z.enum(['ALL', 'INCREMENTAL']).default('INCREMENTAL'),
});

export const TriggerSyncResponseSchema = z.object({
  batchNo: z.string(),
  systemType: SystemTypeEnum,
  syncDirection: SyncDirectionEnum,
  status: SyncStatusEnum,
  recordsCount: z.number().int(),
  message: z.string(),
});

/** ERP 源数据只读预览的限量参数 */
export const ErpSourcePreviewQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50000).optional(),
});

/** ERP 源数据同步请求（rows/useFixture 仅用于本地 fixture 演示源） */
export const ErpSourceSyncRequestSchema = z.object({
  limit: z.number().int().min(1).max(50000).optional(),
  useFixture: z.boolean().optional(),
  rows: z.array(z.unknown()).optional(),
});

export const ErpSalesDispatchSyncRequestSchema = ErpSourceSyncRequestSchema.extend({
  offset: z.number().int().min(0).max(200000).optional(),
});

/** 出货检验五路数据源聚合查询条件：检验单 ID 与物料编码至少提供其一 */
export const OqcSourcesQuerySchema = z
  .object({
    orderId: z.string().uuid().optional(),
    materialCode: z.string().trim().min(1).optional(),
    batchNo: z.string().trim().min(1).optional(),
    customerName: z.string().trim().min(1).optional(),
  })
  .refine((value) => value.orderId !== undefined || value.materialCode !== undefined, {
    message: '至少需要 orderId 或 materialCode 之一',
    path: ['orderId'],
  });

/** MES 列表分页 / 模糊检索查询条件 */
export const MesPagedQuerySchema = z.object({
  search: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** ERP 检验项目字典按适用环节过滤 */
export const TestItemsQuerySchema = z.object({
  stage: z.enum(['IQC', 'IPQC', 'OQC']).optional(),
});
