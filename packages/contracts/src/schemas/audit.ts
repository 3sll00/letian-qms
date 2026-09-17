import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

/**
 * 审计日志动作类型枚举 (8类关键动作)
 */
export const AuditActionEnum = z.enum([
  'CREATE',
  'UPDATE',
  'STATUS_CHANGE',
  'DISPOSE',
  'GATE_BLOCKED',
  'AUTH_FAILED',
  'VALIDATION_REJECTED',
  'SYNC_TRIGGER',
]).openapi('AuditAction');

/**
 * 审计状态枚举
 */
export const AuditStatusEnum = z.enum(['SUCCESS', 'REJECTED', 'FAILED']).openapi('AuditStatus');

/**
 * 审计日志 Schema
 */
export const AuditLogSchema = z.object({
  id: z.string().uuid().optional().openapi({ description: '审计流水 UUID', example: 'a1a8e100-0000-0000-0000-000000000001' }),
  traceId: z.string().openapi({ description: '链路追踪 ID', example: 'req_trace_20260706_001' }),
  userId: z.string().uuid().openapi({ description: '操作人用户 UUID (系统自动操作为全零UUID)', example: 'u1a8e100-0000-0000-0000-000000000001' }),
  userName: z.string().openapi({ description: '操作人姓名', example: '张检验' }),
  action: AuditActionEnum,
  resourceType: z.string().openapi({ description: '操作资源类别', example: 'INSPECTION_ORDER' }),
  resourceId: z.string().openapi({ description: '操作资源业务标识', example: 'INS20260706-001' }),
  status: AuditStatusEnum.default('SUCCESS'),
  diffPatch: z.record(z.unknown()).optional().openapi({ description: '变更前后的 JSON 补丁或快照' }),
  createdAt: z.string().datetime().default(() => new Date().toISOString()).openapi({ description: '操作时间戳' }),
}).openapi('AuditLog');

/**
 * 审计统计卡片响应 Schema
 */
export const AuditStatsResponseSchema = z.object({
  totalLogs: z.number().int().openapi({ description: '操作日志总数', example: 1250 }),
  successCount: z.number().int().openapi({ description: '成功操作数', example: 1240 }),
  failedCount: z.number().int().openapi({ description: '失败/被拦截数', example: 10 }),
  todayCount: z.number().int().openapi({ description: '今日操作总数', example: 45 }),
}).openapi('AuditStatsResponse');
