import type { FastifyRequest } from 'fastify';

/**
 * 统一链路追踪 ID 取值口径。
 *
 * 优先取网关透传的 x-request-id 请求头，其次回退到 Fastify 自身的请求 ID。
 * 审计日志、RFC 7807 错误响应与放行关卡阻断响应必须使用同一口径，
 * 否则同一次请求在不同响应里会带上不同的 traceId，链路无法对齐。
 */
export function requestTraceId(request: FastifyRequest): string {
  const headerTraceId = request.headers['x-request-id'];
  if (typeof headerTraceId === 'string' && headerTraceId.length > 0) {
    return headerTraceId;
  }
  return String(request.id);
}
