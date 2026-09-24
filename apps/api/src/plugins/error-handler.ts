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
          // 结构化补充信息（如「合格后传递」门禁的 { transferDecision, blockedBy }，docs/48 §4.6）：
          // 与 problem+json 主体同级下发，调用方按 code 分支而不必解析中文 detail。
          ...(error.details !== undefined ? { details: error.details } : {}),
        });
    }

    // 3. 常见 HTTP 错误或 Fastify 框架抛出的状态码
    const statusCode = normalized.statusCode ?? 500;

    // QUERY 等 bodywith 方法无 Content-Type 时，Fastify 在路由前以
    // FST_ERR_ROUTE_MISSING_CONTENT_TYPE 400 拦截（RFC 10008）。
    // 若路径模板已注册但该方法未注册，本质仍是「方法不被支持」，
    // 按 405 回吐，与文件尾部 notFound → 405 的口径一致。
    if (normalized.code === 'FST_ERR_ROUTE_MISSING_CONTENT_TYPE') {
      const allowed = allowedMethodsForPath(request.url.split('?')[0] ?? '/');
      if (allowed.size > 0) {
        return sendMethodNotAllowed(request, reply, allowed);
      }
    }

    if (statusCode === 400) {
      // Fastify 自身抛出的 4xx（如 FST_ERR_CTP_EMPTY_JSON_BODY：声明了
      // content-type: application/json 却提交空体）本质是调用方请求有误，
      // 必须按 400 回吐，不能落到下面「未知异常」的 500 兜底分支——
      // 否则客户端会把「请求写错了」误判成「服务端崩了」。
      return reply
        .status(400)
        .header('Content-Type', 'application/problem+json')
        .send({
          type: 'https://letian-qms.com/errors/validation-failed',
          title: '参数验证失败',
          status: 400,
          detail: normalized.message || '请求参数不合法',
          instance: request.url,
          code: ErrorCode.VALIDATION_FAILED,
          traceId,
          invalidParams: [],
        });
    }

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

    // 其余 4xx（405 / 413 / 414 / 415 / 429 等框架级客户端错误）按原状态码回吐：
    // 调用方请求形态有误，不能落到下面 500 兜底被误判成「服务端崩了」
    // （实测：POST 无 Content-Type → FST_ERR_CTP_INVALID_MEDIA_TYPE 415 曾漏成 500）
    if (statusCode >= 400 && statusCode < 500) {
      return reply
        .status(statusCode)
        .header('Content-Type', 'application/problem+json')
        .send({
          type: `https://letian-qms.com/errors/http-${statusCode}`,
          title: '请求不被接受',
          status: statusCode,
          detail: normalized.message || `HTTP ${statusCode}`,
          instance: request.url,
          code: normalized.code || `HTTP_${statusCode}`,
          traceId,
        });
    }

    // PostgreSQL 错误码（SQLSTATE）兜底映射：DB 约束/编码类错误本质是调用方数据问题，
    // 按 4xx 回吐而不是 500。控制器可先行捕获给出精确消息；这里统一收口漏网者。
    // 实测：jsonb 拒绝孤立代理/NUL 字节 → 22P05 unsupported_unicode 曾漏成 500。
    const pgCode = normalized.code;
    if (typeof pgCode === 'string' && /^\d{2}[A-Z0-9]{3}$/.test(pgCode)) {
      if (pgCode === '23505') {
        return reply
          .status(409)
          .header('Content-Type', 'application/problem+json')
          .send({
            type: 'https://letian-qms.com/errors/conflict',
            title: '资源冲突或业务阻断',
            status: 409,
            detail: '违反唯一性约束：记录已存在或标识被占用',
            instance: request.url,
            code: ErrorCode.CONFLICT,
            traceId,
          });
      }
      if (pgCode.startsWith('22') || pgCode.startsWith('23')) {
        return reply
          .status(400)
          .header('Content-Type', 'application/problem+json')
          .send({
            type: 'https://letian-qms.com/errors/validation-failed',
            title: '参数验证失败',
            status: 400,
            detail: '请求包含无法落库的非法数据（编码、类型表示或完整性约束不合法）',
            instance: request.url,
            code: ErrorCode.VALIDATION_FAILED,
            traceId,
            invalidParams: [],
          });
      }
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

  // RFC 9110 §15.5.6：路径已注册但请求方法不支持时应返回 405 + Allow 头，
  // 而不是 404。经 onRoute 钩子自收集已注册路由表（path 为含前缀的完整
  // 模板），供 notFound 与错误处理共用：
  // - Fastify 对未注册方法（含 TRACE 等）落到 notFound → 原生 404
  // - QUERY 属 bodywith 方法，无 Content-Type 时在路由前被
  //   FST_ERR_ROUTE_MISSING_CONTENT_TYPE 400 拦截（RFC 10008）
  // 两种情况统一翻译为 405；路径完全未知时保持原生 404。
  const registeredRoutes: { pattern: string; methods: string[] }[] = [];
  fastify.addHook('onRoute', (routeOptions) => {
    const pattern = (routeOptions as { path?: string }).path ?? routeOptions.url;
    const methods = (
      Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method]
    ).map((m) => m.toUpperCase());
    registeredRoutes.push({ pattern, methods });
  });
  const allowedMethodsForPath = (pathname: string): Set<string> => {
    const segments = pathname.split('/').filter(Boolean);
    const allowed = new Set<string>();
    for (const { pattern, methods } of registeredRoutes) {
      const pSegs = pattern.split('/').filter(Boolean);
      if (pSegs.length !== segments.length) continue;
      const matched = pSegs.every(
        (seg: string, i: number) => seg === '*' || seg.startsWith(':') || seg === segments[i]
      );
      if (matched) for (const m of methods) allowed.add(m);
    }
    return allowed;
  };
  const sendMethodNotAllowed = (
    request: FastifyRequest,
    reply: FastifyReply,
    allowed: Set<string>
  ) => {
    // Fastify 默认 exposeHeadRoutes：GET 路由自动响应 HEAD，Allow 中一并声明
    if (allowed.has('GET')) allowed.add('HEAD');
    const allow = [...allowed].join(', ');
    return reply
      .status(405)
      .header('Allow', allow)
      .header('Content-Type', 'application/problem+json')
      .send({
        type: 'https://letian-qms.com/errors/method-not-allowed',
        title: '请求方法不被支持',
        status: 405,
        detail: `${request.method} 方法不被该路由支持；允许的方法: ${allow}`,
        instance: request.url,
        code: 'HTTP_405',
        traceId: requestTraceId(request),
      });
  };
  fastify.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? '/';
    const allowed = allowedMethodsForPath(pathname);
    if (allowed.size === 0) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Route ${request.method}:${pathname} not found`,
      });
    }
    return sendMethodNotAllowed(request, reply, allowed);
  });
};

export const errorHandlerPlugin = fp(errorHandlerPluginAsync, {
  name: 'fastify-rfc7807-error-handler',
  fastify: '5.x',
});
