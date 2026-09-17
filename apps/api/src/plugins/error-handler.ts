import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import {
  ErrorCode,
  type InvalidParamDetail,
} from '@letian/contracts';
import {
  ApplicationError,
  ValidationFailedError,
} from '@letian/application';
import { requestTraceId } from '../lib/trace';

/** 对 Fastify 抛出的 unknown 异常做一次统一收窄，供各分支安全读取字段 */
interface NormalizedError {
  message: string;
  statusCode?: number;
  code?: string;
  validation?: unknown;
  validationError?: unknown;
  name?: string;
}

function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    const withExtras = error as Error & {
      statusCode?: number;
      code?: string;
      validation?: unknown;
      validationError?: unknown;
    };
    const normalized: NormalizedError = { message: error.message, name: error.name };
    if (typeof withExtras.statusCode === 'number') normalized.statusCode = withExtras.statusCode;
    if (typeof withExtras.code === 'string') normalized.code = withExtras.code;
    if (withExtras.validation !== undefined) normalized.validation = withExtras.validation;
    if (withExtras.validationError !== undefined) normalized.validationError = withExtras.validationError;
    return normalized;
  }
  return { message: typeof error === 'string' ? error : '未知异常' };
}

const errorHandlerPluginAsync: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const traceId = requestTraceId(request);
    const normalized = normalizeError(error);

    // 1. Zod 校验错误处理
    const isZodError = error instanceof ZodError || Boolean(normalized.validation);
    if (isZodError) {
      const zodErr = (error instanceof ZodError
        ? error
        : (normalized.validationError as ZodError | undefined) ?? error) as ZodError;
      const invalidParams: InvalidParamDetail[] = Array.isArray(zodErr.issues)
        ? zodErr.issues.map((issue) => ({
            name: issue.path.join('.'),
            reason: issue.message,
          }))
        : [];

      return reply
        .status(400)
        .header('Content-Type', 'application/problem+json')
        .send({
          type: 'https://letian-qms.com/errors/validation-failed',
          title: '参数验证失败',
          status: 400,
          detail: invalidParams.length > 0
            ? invalidParams.map((p) => `${p.name}: ${p.reason}`).join('; ')
            : normalized.message,
          instance: request.url,
          code: ErrorCode.VALIDATION_FAILED,
          traceId,
          invalidParams,
        });
    }

    // 2. 自定义领域 / 应用层 ApplicationError 及派生异常处理
    if (error instanceof ApplicationError) {
      return reply
        .status(error.status)
        .header('Content-Type', 'application/problem+json')
        .send({
          type: error.type || `https://letian-qms.com/errors/${error.code}`,
          title: error.title,
          status: error.status,
          detail: error.message,
          instance: request.url,
          code: error.code,
          traceId,
          ...(error instanceof ValidationFailedError ? { invalidParams: error.invalidParams } : {}),
        });
    }

    // 3. 常见 HTTP 错误或 Fastify 框架抛出的状态码
    const statusCode = normalized.statusCode ?? 500;
    if (statusCode === 401) {
      return reply
        .status(401)
        .header('Content-Type', 'application/problem+json')
        .send({
          type: 'https://letian-qms.com/errors/unauthorized',
          title: '身份认证失败',
          status: 401,
          detail: normalized.message || '未授权访问，请提供有效的身份凭据',
          instance: request.url,
          code: ErrorCode.UNAUTHORIZED,
          traceId,
        });
    }

    if (statusCode === 403) {
      return reply
        .status(403)
        .header('Content-Type', 'application/problem+json')
        .send({
          type: 'https://letian-qms.com/errors/forbidden',
          title: '拒绝访问',
          status: 403,
          detail: normalized.message || '无权限执行该操作',
          instance: request.url,
          code: ErrorCode.FORBIDDEN,
          traceId,
        });
    }

    if (statusCode === 404) {
      return reply
        .status(404)
        .header('Content-Type', 'application/problem+json')
        .send({
          type: 'https://letian-qms.com/errors/resource-not-found',
          title: '资源不存在',
          status: 404,
          detail: normalized.message || `请求的资源不存在: ${request.url}`,
          instance: request.url,
          code: ErrorCode.RESOURCE_NOT_FOUND,
          traceId,
        });
    }

    if (statusCode === 409) {
      return reply
        .status(409)
        .header('Content-Type', 'application/problem+json')
        .send({
          type: 'https://letian-qms.com/errors/conflict',
          title: '资源冲突或业务阻断',
          status: 409,
          detail: normalized.message || '当前资源状态不支持此操作',
          instance: request.url,
          code: (normalized.code as typeof ErrorCode.CONFLICT) || ErrorCode.CONFLICT,
          traceId,
        });
    }

    // 4. 默认兜底 500 系统内部异常
    request.log.error(error);
    return reply
      .status(500)
      .header('Content-Type', 'application/problem+json')
      .send({
        type: 'https://letian-qms.com/errors/internal-server-error',
        title: '系统内部错误',
        status: 500,
        detail: '服务器发生非预期异常，请稍后重试或联系系统管理员',
        instance: request.url,
        code: ErrorCode.INTERNAL_SERVER_ERROR,
        traceId,
      });
  });
};

export const errorHandlerPlugin = fp(errorHandlerPluginAsync, {
  name: 'fastify-rfc7807-error-handler',
  fastify: '5.x',
});
