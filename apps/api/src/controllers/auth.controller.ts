import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import {
  LoginRequestSchema,
  LoginResponseSchema,
  AuthUserSchema,
  ChangePasswordRequestSchema,
} from '@letian/contracts';
import { UnauthorizedError, ValidationFailedError } from '@letian/application';
import type { ApiContainer } from '../container';
import { hashPassword, verifyPassword } from '../lib/password';
import { appendDbAuditLog } from '../lib/audit-log';

/**
 * 使用时读取密钥：.env 由 dotenv 在运行时加载，模块级常量会固化 import 时刻的值，
 * 导致签发侧 (此处) 与验证侧 (plugins/auth.ts) 读到不同密钥。
 * 签/验两侧都必须在请求时读取，才能保持一致。
 */
function jwtSecret(): string {
  return process.env.JWT_SECRET || 'letian-qms-default-secret-key-for-jwt-tokens-2026';
}

/**
 * 开发/演示环境全员统一初始密码。
 * 同样在请求时读取（原因同 jwtSecret），可用环境变量 DEFAULT_LOGIN_PASSWORD 覆盖。
 *
 * ⚠️ 安全边界：这是明文比对、无独立用户表、无锁定策略，仅满足演示环境的固定口令需求；
 * 接入真实身份源（SSO / LDAP / 密码哈希）前不可用于生产。
 */
function defaultLoginPassword(): string {
  return process.env.DEFAULT_LOGIN_PASSWORD || '123456';
}

/** 统一的账号/口令错误文案：不区分「用户不存在」与「密码错误」，避免账号枚举 */
const INVALID_CREDENTIALS = '用户名或密码错误';

/**
 * 登录入口（独立登录页 / 用户切换演示用）
 *
 * ⚠️ 安全边界：按职员档案 UUID 直接签发 JWT，等价于"任何人可自称任意员工"，
 * 因此**仅在非生产环境注册**（NODE_ENV === 'production' 时整组路由直接跳过注册）。
 * 生产环境必须替换为企业统一身份认证（SSO / OAuth2 / LDAP）后再开放登录能力。
 *
 * 过渡方案：生产环境显式设置 ENABLE_LOCAL_AUTH=true 时只注册 POST /login 的
 * 「用户名 + 口令」通道——/users 名单、userId 直签、缺省演示身份一律不放开；
 * 口令仍须由 DEFAULT_LOGIN_PASSWORD 换成高强度独立口令。此为接入 SSO 前的
 * 内网部署过渡措施，不应在公网环境使用。
 */
export const authController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const localAuthEnabled = !isProduction || process.env.ENABLE_LOCAL_AUTH === 'true';
  if (!localAuthEnabled) {
    return;
  }

  const { container } = options;
  const masterData = container.repositories.masterData;
  const rolesRepo = container.repositories.roles;
  const permissionsRepo = container.repositories.materialPermissions;

  /**
   * 1. 登录页用户列表（演示身份切换专用）
   * 生产环境不注册：在职员工名单属敏感信息，正式登录页也不需要它
   */
  if (!isProduction)
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
   *
   * 三种模式（按优先级）：
   * - userId：一键登录开发态，供探针脚本与身份切换使用，不校验密码；
   * - userName + password：登录页主路径。密码须等于全员统一初始密码，
   *   身份必须能在职员档案中按工号或姓名查到 —— 不接受请求体自称姓名/角色；
   * - 两者都不传：缺省演示身份（质量主管「张强」）。
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

      // 传了 password 就走口令校验分支；口令不对一律用统一文案，不泄露用户是否存在
      const passwordProvided = typeof body.password === 'string' && body.password !== '';
      // 生产环境只保留「用户名 + 口令」通道：userId 直签与缺省演示身份是演示专用，
      // ENABLE_LOCAL_AUTH 放开登录时不得一并放开（否则任何人可自称任意员工）
      if (isProduction && (!passwordProvided || body.userId !== undefined)) {
        throw new UnauthorizedError(INVALID_CREDENTIALS);
      }

      let mustChangePassword = false;

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

        // userId + password 组合（开发态）：同样走该职员的独立口令校验，
        // 不能把传了密码的请求当成一键登录放行
        if (passwordProvided && emp.id) {
          const cred = await masterData.getEmployeeCredential(emp.id);
          const ok = cred?.passwordHash
            ? verifyPassword(body.password as string, cred.passwordHash)
            : body.password === defaultLoginPassword();
          if (!ok) {
            throw new UnauthorizedError(INVALID_CREDENTIALS);
          }
        }

        userName = emp.name;
        role = emp.roleCode ?? 'GUEST';

        if (emp.roleCode) {
          const roleEntity = await rolesRepo.findByCode(emp.roleCode);
          if (roleEntity) {
            roleName = roleEntity.roleName;
          }
        }
      } else if (passwordProvided) {
        // 用户名 + 密码：用户名支持「工号」或「姓名」，均以职员档案为准
        const loginName = (body.userName ?? '').trim();
        const employees = await masterData.getEmployees();
        const emp = employees.find(
          (e) => e.name === loginName || (e.employeeCode ?? '').toLowerCase() === loginName.toLowerCase()
        );
        if (!emp) {
          throw new UnauthorizedError(INVALID_CREDENTIALS);
        }
        if (emp.isActive === false) {
          throw new UnauthorizedError(`该员工账号已停用: ${emp.name}`);
        }

        userId = emp.id ?? undefined;
        if (!userId) {
          throw new UnauthorizedError(INVALID_CREDENTIALS);
        }

        // 独立口令校验（迁移 048）：已设置 password_hash 的职员只认独立口令，
        // 共享初始口令对其立即失效；未设置的回落共享初始口令并标记强制改密，
        // 前端按 mustChangePassword 引导其先调 /auth/change-password。
        const cred = await masterData.getEmployeeCredential(userId);
        if (cred?.passwordHash) {
          if (!verifyPassword(body.password as string, cred.passwordHash)) {
            throw new UnauthorizedError(INVALID_CREDENTIALS);
          }
        } else {
          if (body.password !== defaultLoginPassword()) {
            throw new UnauthorizedError(INVALID_CREDENTIALS);
          }
          mustChangePassword = true;
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
        ...(mustChangePassword ? { mustChangePassword: true } : {}),
      });
    }
  );

  /**
   * 修改密码（独立口令，迁移 048）
   *
   * 凭「用户名 + 旧口令」本人自证即可设置新口令，不依赖 JWT——
   * 这正好覆盖「首次登录强制改密」场景（此刻客户端手里的令牌也是刚签发的）。
   * 旧口令校验口径与登录完全一致：已设独立口令验独立口令；未设的用共享初始口令验。
   */
  fastify.post(
    '/change-password',
    {
      schema: {
        body: ChangePasswordRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof ChangePasswordRequestSchema>;
      const loginName = body.userName.trim();

      const employees = await masterData.getEmployees();
      const emp = employees.find(
        (e) => e.name === loginName || (e.employeeCode ?? '').toLowerCase() === loginName.toLowerCase()
      );
      if (!emp || !emp.id) {
        throw new UnauthorizedError(INVALID_CREDENTIALS);
      }
      if (emp.isActive === false) {
        throw new UnauthorizedError(`该员工账号已停用: ${emp.name}`);
      }

      const cred = await masterData.getEmployeeCredential(emp.id);
      const oldPasswordOk = cred?.passwordHash
        ? verifyPassword(body.oldPassword, cred.passwordHash)
        : body.oldPassword === defaultLoginPassword();
      if (!oldPasswordOk) {
        // 改密失败留痕（只记事实，不记口令内容）
        await appendDbAuditLog(container.uow, request, {
          action: 'AUTH_FAILED',
          resourceType: 'employee_credential',
          resourceId: emp.id,
          status: 'REJECTED',
          userId: emp.id,
          userName: emp.name,
          diffPatch: { reason: 'change-password: old password mismatch' },
        });
        throw new UnauthorizedError(INVALID_CREDENTIALS);
      }
      if (body.newPassword === body.oldPassword) {
        throw new ValidationFailedError('新密码不得与旧密码相同');
      }

      await masterData.setEmployeePasswordHash(emp.id, hashPassword(body.newPassword));
      await appendDbAuditLog(container.uow, request, {
        action: 'UPDATE',
        resourceType: 'employee_credential',
        resourceId: emp.id,
        status: 'SUCCESS',
        userId: emp.id,
        userName: emp.name,
        diffPatch: { passwordChanged: true },
      });

      return reply.status(200).send({ ok: true });
    }
  );
};
