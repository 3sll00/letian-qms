import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const OutboxStatusEnum = z
  .enum(['PENDING', 'PUBLISHED', 'FAILED'])
  .openapi('OutboxStatus');

export const OutboxEventSchema = z
  .object({
    id: z.string().uuid().openapi({ description: '事件唯一标识', example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }),
    aggregateType: z.string().openapi({ description: '聚合根类型', example: 'INSPECTION_ORDER' }),
    aggregateId: z.string().openapi({ description: '聚合根标识', example: 'd3b07384-d113-4676-9c47-5d326f633333' }),
    eventType: z.string().openapi({ description: '领域事件类型', example: 'InspectionOrderCreated' }),
    payload: z.record(z.unknown()).openapi({ description: '事件载荷 JSON 对象' }),
    traceId: z.string().openapi({ description: '分布式链路追踪 ID', example: 'req_trace_20260706_001' }),
    occurredAt: z.string().datetime().openapi({ description: '事件产生时间戳' }),
    status: OutboxStatusEnum.default('PENDING').openapi({ description: 'Outbox 事件状态' }),
    retryCount: z.number().int().default(0).openapi({ description: '重试次数' }),
    errorReason: z.string().optional().openapi({ description: '失败原因详情' }),
  })
  .openapi('OutboxEvent');
