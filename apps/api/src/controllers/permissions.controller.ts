import { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MaterialPermission } from '@letian/contracts';
import {
  PermissionListQuerySchema,
  CreatePermissionRequestSchema,
  UpdateMaterialPermissionRequestSchema,
  ApplyRolePermissionRequestSchema,
  PermissionCheckRequestSchema,
  PermissionCheckResponseSchema,
  MaterialPermissionListResponseSchema,
  RoleSchema,
  PermissionLogListResponseSchema,
} from '@letian/contracts';
import { NotFoundError, ConflictError } from '@letian/application';
import type { ApiContainer } from '../container';
import { operatorOf } from '../lib/operator';
import { appendDbAuditLog } from '../lib/audit-log';
import { logAuthorizationCheck } from '../lib/permission-guard';

const PermissionParamsSchema = z.object({
  id: z.string().uuid('规则ID必须为有效UUID'),
});

const LogQuerySchema = z.object({
  userId: z.string().optional(),
  decision: z.enum(['ALLOWED', 'DENIED']).optional(),
  resourceType: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const permissionsController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;
  const permissionsRepo = container.repositories.materialPermissions;
  const rolesRepo = container.repositories.roles;
  const logsRepo = container.repositories.authorizationLogs;
  const masterData = container.repositories.masterData;

  /** 把职员档案 UUID 翻译成姓名（权限规则落库时冗余存储，便于台账展示与审计） */
  async function resolveUserName(userId: string): Promise<string> {
    const employees = await masterData.getEmployees();
    const emp = employees.find((e) => e.id === userId);
    return emp?.name ?? '未知用户';
  }

  /**
   * 1. 获取物料权限规则列表（分页、筛选；台账含停用规则）
   */
  fastify.get(
    '/materials',
    {
      schema: {
        querystring: PermissionListQuerySchema,
        response: {
          200: MaterialPermissionListResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof PermissionListQuerySchema>;

      const result = await permissionsRepo.listAll({
        page: query.page,
        pageSize: query.pageSize,
        ...(query.userName !== undefined ? { userName: query.userName } : {}),
        ...(query.roleCode !== undefined ? { roleCode: query.roleCode } : {}),
        ...(query.materialCode !== undefined ? { materialCode: query.materialCode } : {}),
      });

      return reply.status(200).send({
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
        items: result.items,
        list: result.items,
      });
    }
  );

  /**
   * 2. 新增物料权限规则（同 userId+roleCode 冲突 → 409）
   */
  fastify.post(
    '/materials',
    {
      schema: {
        body: CreatePermissionRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreatePermissionRequestSchema>;

      // 检查 (userId, roleCode) 是否已经存在规则（含停用规则，避免绕开唯一约束）
      const existingRules = await permissionsRepo.findAllForUser(body.userId);
      const conflict = existingRules.find((rule) => rule.roleCode === body.roleCode);
      if (conflict) {
        throw new ConflictError(
          `用户 [${conflict.userName}] 在角色 [${body.roleCode}] 下已存在权限规则，请直接编辑而非重复创建`
        );
      }

      const newRule: MaterialPermission = {
        id: randomUUID(),
        userId: body.userId,
        userName: body.userName ?? (await resolveUserName(body.userId)),
        roleCode: body.roleCode,
        materialCategories: body.materialCategories,
        materialCodes: body.materialCodes,
        supplierCodes: body.supplierCodes,
        isActive: body.isActive,
      };

      await permissionsRepo.save(newRule);

      await appendDbAuditLog(container.uow, request, {
        action: 'CREATE',
        resourceType: 'MATERIAL_PERMISSION',
        resourceId: newRule.id,
        diffPatch: { created: newRule },
      });

      return reply.status(201).send(newRule);
    }
  );

  /**
   * 3. 更新物料权限规则（三维维度 / 启停）
   */
  fastify.put(
    '/materials/:id',
    {
      schema: {
        params: PermissionParamsSchema,
        body: UpdateMaterialPermissionRequestSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof PermissionParamsSchema>;
      const body = request.body as z.infer<typeof UpdateMaterialPermissionRequestSchema>;

      const existing = await permissionsRepo.findById(id);
      if (!existing) {
        throw new NotFoundError(`物料权限规则不存在: ${id}`);
      }

      const nextUserId = body.userId ?? existing.userId;
      const nextRoleCode = body.roleCode ?? existing.roleCode;

      // userName 是 employees.name 的冗余展示快照（material_permissions.user_name）：
      // 请求体未回传时按「规则原值 → 职员档案」顺序兜底，保证列表页「用户姓名」列永不为空。
      const userName =
        body.userName ??
        (nextUserId === existing.userId && existing.userName !== ''
          ? existing.userName
          : await resolveUserName(nextUserId));

      // 若本次更新把规则迁移到另一个 (用户, 角色) 组合，需先做唯一性检测，
      // 避免直接撞上 uq_permission_user_role 约束抛出 500。
      if (nextUserId !== existing.userId || nextRoleCode !== existing.roleCode) {
        const candidates = await permissionsRepo.findAllForUser(nextUserId);
        const conflict = candidates.find((rule) => rule.roleCode === nextRoleCode && rule.id !== id);
        if (conflict) {
          throw new ConflictError(
            `用户 [${conflict.userName}] 在角色 [${nextRoleCode}] 下已存在权限规则，请直接编辑而非迁移覆盖`
          );
        }
      }

      const updated: MaterialPermission = {
        ...existing,
        userId: nextUserId,
        userName,
        roleCode: nextRoleCode,
        ...(body.materialCategories !== undefined ? { materialCategories: body.materialCategories } : {}),
        ...(body.materialCodes !== undefined ? { materialCodes: body.materialCodes } : {}),
        ...(body.supplierCodes !== undefined ? { supplierCodes: body.supplierCodes } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      };

      await permissionsRepo.save(updated);

      await appendDbAuditLog(container.uow, request, {
        action: 'UPDATE',
        resourceType: 'MATERIAL_PERMISSION',
        resourceId: id,
        diffPatch: { before: existing, after: updated },
      });

      return reply.status(200).send(updated);
    }
  );

  /**
   * 4. 删除物料权限规则（物理删除 + 操作审计）
   */
  fastify.delete(
    '/materials/:id',
    {
      schema: {
        params: PermissionParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof PermissionParamsSchema>;

      const existing = await permissionsRepo.findById(id);
      if (!existing) {
        throw new NotFoundError(`物料权限规则不存在: ${id}`);
      }

      await permissionsRepo.deleteById(id);

      await appendDbAuditLog(container.uow, request, {
        action: 'STATUS_CHANGE',
        resourceType: 'MATERIAL_PERMISSION',
        resourceId: id,
        diffPatch: { deleted: existing },
      });

      return reply.status(204).send();
    }
  );

  /**
   * 5. 角色字典列表（前端角色下拉 / 批量配置页共用）
   */
  fastify.get(
    '/roles',
    {
      schema: {
        response: {
          200: z.array(RoleSchema),
        },
      },
    },
    async (_request, reply) => {
      const roles = await rolesRepo.listRoles();
      return reply.status(200).send(roles);
    }
  );

  /**
   * 6. 按角色批量应用三维权限（「按角色批量配置」Tab）
   */
  fastify.post(
    '/apply-role',
    {
      schema: {
        body: ApplyRolePermissionRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof ApplyRolePermissionRequestSchema>;

      const count = await permissionsRepo.updateAllByRole(body.roleCode, {
        materialCategories: body.materialCategories,
        materialCodes: body.materialCodes,
        supplierCodes: body.supplierCodes,
        isActive: body.isActive,
      });

      await appendDbAuditLog(container.uow, request, {
        action: 'UPDATE',
        resourceType: 'ROLE_MATERIAL_PERMISSION',
        resourceId: body.roleCode,
        diffPatch: {
          roleCode: body.roleCode,
          materialCategories: body.materialCategories,
          materialCodes: body.materialCodes,
          supplierCodes: body.supplierCodes,
          isActive: body.isActive,
          affectedRows: count,
        },
      });

      return reply.status(200).send({
        success: true,
        message: `成功为角色 [${body.roleCode}] 下的 ${count} 条规则同步三维权限配置`,
        affectedCount: count,
      });
    }
  );

  /**
   * 7. 权限校验工具（实时诊断：某用户 × 某物料是否放行 + 命中规则）
   */
  fastify.post(
    '/check',
    {
      schema: {
        body: PermissionCheckRequestSchema,
        response: {
          200: PermissionCheckResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof PermissionCheckRequestSchema>;
      const operator = operatorOf(request);

      const result = await container.useCases.checkPermission.execute({
        userId: body.userId,
        materialCode: body.materialCode,
        ...(body.supplierCode !== undefined ? { supplierCode: body.supplierCode } : {}),
      });

      // 校验工具本身也是一次敏感数据探测，记录操作人日志
      logAuthorizationCheck(container, {
        userId: operator.userId,
        userName: operator.userName,
        ...(operator.role !== 'SYSTEM' ? { roleCode: operator.role } : {}),
        resourceType: 'PERMISSION_CHECK',
        resourceId: `${body.userId}:${body.materialCode}`,
        ...(body.supplierCode !== undefined ? { supplierCode: body.supplierCode } : {}),
        action: 'CHECK',
        decision: result.allowed ? 'ALLOWED' : 'DENIED',
        ...(result.matchedRule !== null ? { matchedRuleId: result.matchedRule.id } : {}),
        detail: result.message,
      });

      return reply.status(200).send(result);
    }
  );

  /**
   * 8. 权限校验日志列表（「权限校验日志」Tab）
   */
  fastify.get(
    '/logs',
    {
      schema: {
        querystring: LogQuerySchema,
        response: {
          200: PermissionLogListResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof LogQuerySchema>;

      const result = await logsRepo.queryList({
        page: query.page,
        pageSize: query.pageSize,
        ...(query.userId !== undefined ? { userId: query.userId } : {}),
        ...(query.decision !== undefined ? { decision: query.decision } : {}),
        ...(query.resourceType !== undefined ? { resourceType: query.resourceType } : {}),
      });

      return reply.status(200).send({
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
        items: result.items,
        list: result.items,
      });
    }
  );
};
