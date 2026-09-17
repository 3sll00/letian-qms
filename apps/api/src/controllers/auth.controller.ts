import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { generateTestToken, type CurrentUser } from '../plugins/auth';

/**
 * 开发环境登录入口
 *
 * ⚠️ 安全边界：
 * 本接口用固定的 JWT 密钥按请求体直接签发令牌，等价于"任何人可自称任意角色"，
 * 因此**仅在非生产环境注册**（NODE_ENV === 'production' 时整组路由直接跳过注册）。
 * 生产环境必须替换为企业统一身份认证（SSO / OAuth2 / LDAP）后再开放登录能力。
 */
const LoginRequestSchema = z.object({
  userId: z.string().uuid().optional(),
  userName: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  department: z.string().min(1).optional(),
  permissions: z.array(z.string()).optional(),
});

/** 无请求体时的默认演示身份与 auth 插件内置默认值保持一致 */
const DEFAULT_DEV_USER: CurrentUser = {
  userId: '11111111-1111-1111-1111-111111111111',
  userName: '张三 (测试质检员)',
  role: 'INSPECTOR',
  department: '品质保证部',
  permissions: ['*'],
};

export const authController: FastifyPluginAsync = async (fastify) => {
  if (process.env.NODE_ENV === 'production') {
    return;
  }

  fastify.post(
    '/login',
    {
      schema: {
        body: LoginRequestSchema.optional(),
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as z.infer<typeof LoginRequestSchema>;

      const user: CurrentUser = {
        userId: body.userId ?? DEFAULT_DEV_USER.userId,
        userName: body.userName ?? DEFAULT_DEV_USER.userName,
        role: body.role ?? DEFAULT_DEV_USER.role,
        permissions: body.permissions ?? DEFAULT_DEV_USER.permissions ?? [],
      };
      const department = body.department ?? DEFAULT_DEV_USER.department;
      if (department !== undefined) {
        user.department = department;
      }

      return reply.status(200).send({
        token: generateTestToken(user),
        user,
        expiresInSeconds: 86400,
        // 明确告知消费方这是开发态登录，不具备生产可用性
        devOnly: true,
      });
    }
  );
};
