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
    example: ['原材料', '紧固件五金'],
  }),
  materialCodes: z.array(z.string()).default([]).openapi({
    description: '授权特定物料编码白名单（维度二：特定编码）',
    example: ['CL-001', 'CL-002'],
  }),
  supplierCodes: z.array(z.string()).default([]).openapi({
    description: '授权供应商编码白名单（维度三：供应商范围）',
    example: ['SUP-001', '宝钢股份'],
  }),
  isActive: z.boolean().default(true).openapi({ description: '规则是否生效', example: true }),
}).openapi('MaterialPermission');

/**
 * PBAC 规则配置更新请求 Schema
 */
export const UpdateMaterialPermissionRequestSchema = MaterialPermissionSchema.omit({ id: true });
