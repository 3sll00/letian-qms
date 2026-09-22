import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

/**
 * 物料行级数据权限管控 (PBAC) Schema
 * 严格包含三维授权模型：物料分类维度、特定物料编码维度、供应商维度
 */
export const MaterialPermissionSchema = z.object({
  id: z.string().uuid().openapi({ description: '权限规则唯一标识', example: 'p1a8e100-0000-0000-0000-000000000001' }),
  userId: z.string().uuid().openapi({ description: '授权用户 UUID', example: 'u1a8e100-0000-0000-0000-000000000001' }),
  userName: z.string().openapi({ description: '用户姓名', example: '张检验' }),
  roleCode: z.string().openapi({ description: '角色编码', example: 'IQC_INSPECTOR' }),
  materialCategories: z.array(z.string()).default([]).openapi({
    description: '授权物料分类列表（维度一：物料分类）',
    example: ['CAT-RAW', 'CAT-FINISH'],
  }),
  materialCodes: z.array(z.string()).default([]).openapi({
    description: '授权特定物料编码白名单（维度二：特定编码）',
    example: ['MAT-304SS-05', 'MAT-BLT-88-M10'],
  }),
  supplierCodes: z.array(z.string()).default([]).openapi({
    description: '授权供应商编码白名单（维度三：供应商范围）',
    example: ['SUP-001', '宝钢股份'],
  }),
  isActive: z.boolean().default(true).openapi({ description: '规则是否生效', example: true }),
}).openapi('MaterialPermission');

/**
 * 说明：PBAC 规则的**创建 / 更新请求体**统一收敛在 `./permission.ts`
 * （`CreatePermissionRequestSchema` / `UpdateMaterialPermissionRequestSchema`），
 * 本文件只保留规则实体本身的 Schema，避免同一契约出现两处定义导致口径漂移。
 */
