import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import {
  ForbiddenError,
  SecurityContextFactory,
  UnauthorizedError,
  type ISecurityContext,
} from '@letian/application';
import type { ApiContainer } from '../container';
import { requestTraceId } from '../lib/trace';

export interface CurrentUser {
  userId: string;
  userName: string;
  role: string;
  department?: string;
  workshopId?: string;
  productionLineId?: string;
  permissions?: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: CurrentUser;
    securityContext?: ISecurityContext;
  }
  interface FastifyInstance {
    /** 校验 Authorization: Bearer <token>，失败抛出 RFC 7807 401 */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** 生成权限校验前置钩子，失败抛出 RFC 7807 403 */
    requirePermission: (
      requiredPermission: string
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * 使用时读取密钥，与签发侧 (controllers/auth.controller.ts) 保持一致。
 * dotenv 在运行时才把 .env 写入 process.env，模块级常量会固化 import 时刻的旧值。
 */
function jwtSecret(): string {
  return process.env.JWT_SECRET || 'letian-qms-default-secret-key-for-jwt-tokens-2026';
}

export function generateTestToken(payload: Partial<CurrentUser>): string {
  const defaultUser: CurrentUser = {
    userId: '11111111-1111-1111-1111-111111111111',
    userName: '张三 (测试质检员)',
    role: 'INSPECTOR',
    department: '品质保证部',
    permissions: ['*'],
  };
  return jwt.sign({ ...defaultUser, ...payload }, jwtSecret(), { expiresIn: '1d' });
}

interface AuthPluginOptions {
  container: ApiContainer;
}

const authPluginAsync: FastifyPluginAsync<AuthPluginOptions> = async (fastify, options) => {
  const securityContextFactory = new SecurityContextFactory(
    options.container.repositories.materialPermissions
  );

  fastify.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      throw new UnauthorizedError('未提供认证凭据 (Authorization header缺失)');
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || (parts[0] ?? '').toLowerCase() !== 'bearer') {
      throw new UnauthorizedError('认证凭据格式不正确 (必须为 Bearer <token>)');
    }

    const token = parts[1] as string;
    let user: CurrentUser;
    try {
      const decoded = jwt.verify(token, jwtSecret()) as Record<string, unknown>;

      // 可选字段在缺失时必须整体省略，而不是赋 undefined
      // （tsconfig 开启了 exactOptionalPropertyTypes）
      user = {
        userId: (decoded.userId as string) || (decoded.sub as string) || 'unknown-user',
        userName: (decoded.userName as string) || (decoded.name as string) || '系统用户',
        role: (decoded.role as string) || 'USER',
        permissions: (decoded.permissions as string[]) || [],
      };
      if (typeof decoded.department === 'string') user.department = decoded.department;
      if (typeof decoded.workshopId === 'string') user.workshopId = decoded.workshopId;
      if (typeof decoded.productionLineId === 'string') {
        user.productionLineId = decoded.productionLineId;
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new UnauthorizedError(`凭据校验无效或已过期: ${reason}`);
    }

    request.user = user;
    request.securityContext = await securityContextFactory.createContext(
      {
        id: user.userId,
        name: user.userName,
        role: user.role,
      },
      requestTraceId(request)
    );
  });

  fastify.decorate('requirePermission', (requiredPermission: string) => {
    return async (request: FastifyRequest, _reply: FastifyReply) => {
      // 必须先通过 authenticate
      if (!request.user) {
        throw new UnauthorizedError('用户未登录');
      }

      const permissions = request.user.permissions || [];
      if (permissions.includes('*') || permissions.includes(requiredPermission)) {
        return;
      }

      throw new ForbiddenError(`权限不足: 需要权限 [${requiredPermission}]`);
    };
  });
};

export const authPlugin = fp(authPluginAsync, {
  name: 'fastify-jwt-auth',
  fastify: '5.x',
});
