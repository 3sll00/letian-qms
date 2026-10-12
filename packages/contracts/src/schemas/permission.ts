import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { MaterialPermissionSchema } from './pbac';

extendZodWithOpenApi(z);

/**
 * 权限管理体系契约（roles 角色字典 / authorization_logs 校验日志 /
 * 物料权限规则 CRUD / 权限校验工具 / 登录身份）
 *
 * 这些 Schema 与 003_permission_management 迁移建立的表结构一一对应，
 * 是前端"系统管理-物料权限管理"页面与后端权限接口的单一真理源。
 */

// ============================================================================
// 1. 角色字典
// ============================================================================

export const RoleSchema = z
  .object({
    roleCode: z.string().min(1).openapi({ description: '角色编码（主键）', example: 'IQC_INSPECTOR' }),
    roleName: z.string().min(1).openapi({ description: '角色名称', example: 'IQC检验员' }),
    description: z.string().optional().openapi({ description: '角色说明', example: '来料检验' }),
    isActive: z.boolean().default(true).openapi({ description: '是否启用', example: true }),
    sortOrder: z.number().int().default(0).openapi({ description: '排序权重', example: 30 }),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .openapi('Role');

// ============================================================================
// 2. 权限校验日志（PRD：保留周期至少 180 天）
// ============================================================================

export const AuthorizationDecisionEnum = z.enum(['ALLOWED', 'DENIED']).openapi('AuthorizationDecision');

export const AuthorizationLogSchema = z
  .object({
    id: z.string().uuid().openapi({ description: '日志唯一标识' }),
    userId: z.string().uuid().openapi({ description: '发起查询的用户 UUID' }),
    userName: z.string().openapi({ description: '用户姓名', example: '陈静' }),
    roleCode: z.string().optional().openapi({ description: '角色编码', example: 'IQC_INSPECTOR' }),
    resourceType: z.string().openapi({ description: '被访问的资源类型', example: 'INSPECTION_ORDER' }),
    resourceId: z.string().optional().openapi({ description: '被访问的资源标识', example: 'INS-2024-001' }),
    materialCode: z.string().optional().openapi({ description: '物料编码', example: 'MAT-304SS-05' }),
    materialCategory: z.string().optional().openapi({ description: '物料分类', example: 'CAT-RAW-WIRE' }),
    supplierCode: z.string().optional().openapi({ description: '供应商编码', example: 'SUP-001' }),
    action: z.string().openapi({ description: '动作类型', example: 'LIST' }),
    decision: AuthorizationDecisionEnum.openapi({ description: '判定结果：ALLOWED 放行 / DENIED 拦截' }),
    matchedRuleId: z.string().uuid().optional().openapi({ description: '命中的权限规则 UUID' }),
    detail: z.string().optional().openapi({ description: '明细说明' }),
    createdAt: z.string().openapi({ description: '发生时间 (ISO8601)' }),
  })
  .openapi('AuthorizationLog');

export const PermissionLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  userId: z.string().optional(),
  decision: AuthorizationDecisionEnum.optional(),
  resourceType: z.string().optional(),
});

export const PermissionLogListResponseSchema = z
  .object({
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    items: z.array(AuthorizationLogSchema),
    list: z.array(AuthorizationLogSchema),
  })
  .openapi('PermissionLogListResponse');

// ============================================================================
// 3. 物料权限规则 CRUD
// ============================================================================

export const PermissionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  userName: z.string().optional(),
  roleCode: z.string().optional(),
  materialCode: z.string().optional(),
});

export const MaterialPermissionListResponseSchema = z
  .object({
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    items: z.array(MaterialPermissionSchema),
    list: z.array(MaterialPermissionSchema),
  })
  .openapi('MaterialPermissionListResponse');

/**
 * 创建 / 编辑权限规则请求体（id 走路径参数）
 *
 * `userName` 为可选：它是 `material_permissions.user_name` 的冗余展示快照，
 * 服务端在缺省时统一从职员档案（employees.name）补全，因此调用方无需回传。
 * 创建与编辑两条路径的字段口径必须保持一致，避免出现「列表页启停能存、
 * 弹窗编辑报 400 userName Required」的契约割裂。
 */
export const CreatePermissionRequestSchema = z
  .object({
    userId: z.string().uuid().openapi({ description: '授权用户 UUID（职员档案主键）' }),
    userName: z.string().min(1).optional().openapi({ description: '用户姓名，缺省时服务端从职员档案补全' }),
    roleCode: z.string().min(1).openapi({ description: '角色编码', example: 'IQC_INSPECTOR' }),
    materialCategories: z.array(z.string()).default([]).openapi({ description: '物料分类白名单（空数组或含 * 表示通配）' }),
    materialCodes: z.array(z.string()).default([]).openapi({ description: '物料编码白名单' }),
    supplierCodes: z.array(z.string()).default([]).openapi({ description: '供应商编码白名单' }),
    isActive: z.boolean().default(true).openapi({ description: '规则是否生效' }),
  })
  .openapi('CreatePermissionRequest');

/**
 * 更新权限规则请求体（三维维度 / 用户 / 角色 / 启停）
 *
 * 由 CreatePermissionRequestSchema 派生，唯一差异是各维度转为可选（PATCH 语义的
 * 部分更新：未提交的维度保持原值），`userName` 同样可选并由服务端补全。
 */
export const UpdateMaterialPermissionRequestSchema = CreatePermissionRequestSchema.partial()
  .extend({
    userId: z.string().uuid().optional().openapi({ description: '授权用户 UUID，缺省时保持不变' }),
    roleCode: z.string().min(1).optional().openapi({ description: '角色编码，缺省时保持不变' }),
  })
  .openapi('UpdateMaterialPermissionRequest');

/** 按角色批量配置请求体：将该角色下所有用户规则的三维维度统一改写 */
export const ApplyRolePermissionRequestSchema = z
  .object({
    roleCode: z.string().min(1).openapi({ description: '目标角色编码', example: 'IQC_INSPECTOR' }),
    materialCategories: z.array(z.string()).default([]),
    materialCodes: z.array(z.string()).default([]),
    supplierCodes: z.array(z.string()).default([]),
    isActive: z.boolean().default(true),
  })
  .openapi('ApplyRolePermissionRequest');

// ============================================================================
// 4. 权限校验工具
// ============================================================================

export const PermissionCheckRequestSchema = z
  .object({
    userId: z.string().uuid().openapi({ description: '被校验用户 UUID' }),
    materialCode: z.string().min(1).openapi({ description: '物料编码', example: 'MAT-304SS-05' }),
    supplierCode: z.string().optional().openapi({ description: '供应商编码（可选上下文）' }),
  })
  .openapi('PermissionCheckRequest');

export const PermissionCheckResponseSchema = z
  .object({
    allowed: z.boolean().openapi({ description: '是否允许访问' }),
    userId: z.string().uuid(),
    userName: z.string(),
    materialCode: z.string(),
    materialCategory: z.string().optional().openapi({ description: '物料所属分类' }),
    supplierCode: z.string().optional(),
    matchedRule: MaterialPermissionSchema.nullable().openapi({ description: '命中的权限规则，未命中为 null' }),
    message: z.string().openapi({ description: '人可读的判定说明' }),
  })
  .openapi('PermissionCheckResponse');

// ============================================================================
// 5. 登录身份（开发态登录页）
// ============================================================================

/** 登录页可选的用户（来自职员档案 + 主角色） */
export const AuthUserSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    employeeCode: z.string().optional(),
    department: z.string().optional(),
    roleCode: z.string().optional(),
    roleName: z.string().optional(),
  })
  .openapi('AuthUser');

export const LoginRequestSchema = z
  .object({
    userId: z.string().uuid().optional().openapi({ description: '职员档案用户 UUID（一键登录模式）' }),
    userName: z
      .string()
      .optional()
      .openapi({ description: '登录用户名：职员工号或姓名（用户名+密码模式）；自定义模式下的自称姓名' }),
    password: z
      .string()
      .optional()
      .openapi({
        description:
          '登录密码。传入即进入「用户名+密码」校验分支（身份必须能在职员档案中查到）；不传则为开发态一键登录',
      }),
    role: z.string().optional().openapi({ description: '角色编码（自定义模式）' }),
  })
  .openapi('LoginRequest');

export const LoginUserSchema = z
  .object({
    userId: z.string().uuid(),
    userName: z.string(),
    role: z.string(),
    roleName: z.string().optional(),
    activeRulesCount: z.number().int().optional(),
  })
  .openapi('LoginUser');

export const LoginResponseSchema = z
  .object({
    token: z.string(),
    user: LoginUserSchema,
    expiresInSeconds: z.number().int().optional(),
    devOnly: z.boolean().optional(),
  })
  .openapi('LoginResponse');
