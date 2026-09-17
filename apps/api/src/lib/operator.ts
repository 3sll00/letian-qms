import type { FastifyRequest } from 'fastify';

/** 无法从 JWT 取得身份时的兜底操作人（与契约注释中的系统用户一致） */
export const SYSTEM_OPERATOR_NAME = '系统用户';

export interface OperatorIdentity {
  userId: string;
  userName: string;
  role: string;
}

/**
 * 从请求上下文提取操作人身份。
 *
 * 业务路由统一挂在 authenticate 之后，正常情况必然存在 request.user；
 * 兜底仅用于防御式编程，避免测试或内部调用因缺少身份而抛 TypeError。
 */
export function operatorOf(request: FastifyRequest): OperatorIdentity {
  const user = request.user;
  return {
    userId: user?.userId ?? '00000000-0000-0000-0000-000000000000',
    userName: user?.userName ?? SYSTEM_OPERATOR_NAME,
    role: user?.role ?? 'SYSTEM',
  };
}
