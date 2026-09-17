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
  createdAt: z.string().optional(),
});

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
