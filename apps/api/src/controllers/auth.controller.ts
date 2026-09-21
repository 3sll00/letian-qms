import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import {
  LoginRequestSchema,
  LoginResponseSchema,
  AuthUserSchema,
} from '@letian/contracts';
import { UnauthorizedError } from '@letian/application';
import type { ApiContainer } from '../container';

/**
 * 使用时读取密钥：.env 由 dotenv 在运行时加载，模块级常量会固化 import 时刻的值，
 * 导致签发侧 (此处) 与验证侧 (plugins/auth.ts) 读到不同密钥。
 * 签/验两侧都必须在请求时读取，才能保持一致。
 */
function jwtSecret(): string {
  return process.env.JWT_SECRET || 'letian-qms-default-secret-key-for-jwt-tokens-2026';
}

/**
 * 开发环境登录入口（独立登录页 / 用户切换演示用）
 *
 * ⚠️ 安全边界：按职员档案 UUID 直接签发 JWT，等价于"任何人可自称任意员工"，
 * 因此**仅在非生产环境注册**（NODE_ENV === 'production' 时整组路由直接跳过注册）。
 * 生产环境必须替换为企业统一身份认证（SSO / OAuth2 / LDAP）后再开放登录能力。
 */
export const authController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  if (process.env.NODE_ENV === 'production') {
    return;
  }

  const { container } = options;
  const masterData = container.repositories.masterData;
  const rolesRepo = container.repositories.roles;
  const permissionsRepo = container.repositories.materialPermissions;

  /**
   * 1. 登录页用户列表
   * 供独立登录页拉取在职员工列表及其主角色信息
   */
  fastify.get(
    '/users',
    {
      schema: {
        response: {
          200: z.array(AuthUserSchema),
        },
      },
    },
    async (_request, reply) => {
      const [employees, allRoles] = await Promise.all([
        masterData.getEmployees(),
        rolesRepo.listRoles(),
      ]);

      const roleMap = new Map(allRoles.map((r) => [r.roleCode, r.roleName]));

      const activeEmployees = employees.filter((e) => e.isActive !== false);

      const users = activeEmployees.map((emp) => ({
        id: emp.id ?? '',
        name: emp.name,
        employeeCode: emp.employeeCode,
        department: emp.department ?? '质量部',
        roleCode: emp.roleCode ?? 'GUEST',
        roleName: (emp.roleCode ? roleMap.get(emp.roleCode) : undefined) ?? '普通访客',
      }));

      return reply.status(200).send(users);
    }
  );

  /**
   * 2. 用户登录
   * 支持传 userId 快速切换登录，或传传统自定义身份
   */
  fastify.post(
    '/login',
    {
      schema: {
        body: LoginRequestSchema,
        response: {
          200: LoginResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof LoginRequestSchema>;

      let userId = body.userId;
      let userName = body.userName;
      let role = body.role;
      let roleName: string | undefined;

      if (userId) {
        // 从职员主数据解析真实身份
        const employees = await masterData.getEmployees();
        const emp = employees.find((e) => e.id === userId);
        if (!emp) {
          throw new UnauthorizedError(`用户不存在或未在员工档案注册: ${userId}`);
        }
        if (emp.isActive === false) {
          throw new UnauthorizedError(`该员工账号已停用: ${emp.name}`);
        }

        userName = emp.name;
        role = emp.roleCode ?? 'GUEST';

        if (emp.roleCode) {
          const roleEntity = await rolesRepo.findByCode(emp.roleCode);
          if (roleEntity) {
            roleName = roleEntity.roleName;
          }
        }
      } else {
        // 缺省演示身份：质量主管「张强」（EMPLOYEE_IDS.zhangQiang，种子配置了全量通配规则）
        userId = '11000000-0000-4000-8000-000000000001';
        userName = userName ?? '张强';
        role = role ?? 'QA_MANAGER';
      }

      // 获取该用户的有效 PBAC 规则数量
      const activeRules = await permissionsRepo.findByUserId(userId);
      const activeRulesCount = activeRules.filter((r) => r.isActive).length;

      // 签发 JWT
      const token = jwt.sign(
        {
          userId,
          userName,
          role,
        },
        jwtSecret(),
        {
          expiresIn: '24h',
        }
      );

      return reply.status(200).send({
        token,
        user: {
          userId,
          userName: userName ?? '未知用户',
          role: role ?? 'GUEST',
          roleName: roleName ?? role ?? 'GUEST',
          activeRulesCount,
        },
      });
    }
  );
};
