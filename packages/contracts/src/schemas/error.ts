import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const InvalidParamDetailSchema = z
  .object({
    name: z.string().openapi({ description: '错误字段名称', example: 'measuredVal' }),
    reason: z.string().openapi({ description: '字段校验失败原因', example: '实测值不能小于0' }),
  })
  .openapi('InvalidParamDetail');

export const ProblemDetailsSchema = z.object({
  type: z
    .string()
    .default('about:blank')
    .openapi({
      description: '符合 RFC 7807 标准的错误类型 URI（小写短横线规范）',
      example: 'https://letian-qms.com/errors/validation-error',
    }),
  title: z
    .string()
    .openapi({
      description: '简短可读的错误摘要',
      example: '参数验证失败',
    }),
  status: z
    .number()
    .int()
    .openapi({
      description: '对应 HTTP 状态码',
      example: 400,
    }),
  detail: z
    .string()
    .openapi({
      description: '详细错误原因描述',
      example: '实测尺寸超出规格公差范围',
    }),
  instance: z
    .string()
    .optional()
    .openapi({
      description: '发生错误的请求实例路径',
      example: '/api/v1/inspections/ins-001/submit',
    }),
  code: z
    .string()
    .openapi({
      description: '业务级错误识别码',
      example: 'QMS_VALIDATION_ERROR',
    }),
  traceId: z
    .string()
    .openapi({
      description: '全局请求链路追踪 ID',
      example: 'req_trace_20260706_001',
    }),
  invalidParams: z
    .array(InvalidParamDetailSchema)
    .optional()
    .openapi({
      description: '非法参数字段列表',
    }),
}).openapi('ProblemDetails');
