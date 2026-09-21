import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

/**
 * 筛选运算符枚举
 */
export const FilterOperatorEnum = z.enum([
  'EQ',           // 等于
  'NEQ',          // 不等于
  'IN',           // 多选包含 (单字段多选★)
  'NOT_IN',       // 不在多选列表
  'LIKE',         // 模糊匹配
  'BETWEEN',      // 区间 (如日期范围、数值范围)
  'GTE',          // 大于等于
  'LTE',          // 小于等于
]).openapi('FilterOperator');

/**
 * 单条高级筛选条件
 */
export const FilterConditionSchema = z.object({
  field: z.string().min(1).openapi({ description: '实体字段名 (白名单限制)', example: 'materialCode' }),
  operator: FilterOperatorEnum.openapi({ description: '比较操作符', example: 'IN' }),
  value: z.any().openapi({ description: '比较值 (单值、数组或区间 [min, max])' }),
}).openapi('FilterCondition');

/**
 * 通用高级筛选查询 DSL 请求 Schema
 */
export const AdvancedQueryDslSchema = z.object({
  conditions: z.array(FilterConditionSchema).default([]).openapi({ description: '组合筛选条件列表' }),
  logicalOperator: z.enum(['AND', 'OR']).default('AND').openapi({ description: '条件间逻辑关系' }),
  page: z.number().int().min(1).default(1).openapi({ description: '当前页码' }),
  pageSize: z.number().int().min(1).max(200).default(20).openapi({ description: '每页条数' }),
  sortField: z.string().optional().openapi({ description: '排序字段' }),
  sortOrder: z.enum(['ASC', 'DESC']).default('DESC').openapi({ description: '排序方向' }),
}).openapi('AdvancedQueryDsl');

/**
 * 筛选方案保存/收藏 Schema (支持管家婆式常用查询方案持久化)
 */
export const SavedQueryPresetSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).openapi({ description: '查询方案名称', example: '本周退货不合格汇总' }),
  module: z.enum(['INSPECTION', 'MRB', 'TRACEABILITY', 'INTEGRATION', 'REPORT']).openapi({ description: '所属业务模块' }),
  queryDsl: AdvancedQueryDslSchema.openapi({ description: '方案对应的 DSL 配置' }),
  isDefault: z.boolean().default(false).openapi({ description: '是否为默认载入方案' }),
  createdUserId: z.string().uuid().optional(),
  createdAt: z.string().datetime().optional(),
}).openapi('SavedQueryPreset');
