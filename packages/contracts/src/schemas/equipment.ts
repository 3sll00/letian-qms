import { z } from 'zod';

/** 设备状态选项（系统管理-设备管理，设备领用周转口径）；未填 = 不设置，展示为灰色「-」 */
export const EQUIPMENT_STATUS_OPTIONS = ['领出', '归还', '维修', '保养', '点检'] as const;

/** 采购日期口径：YYYY-MM-DD 文本（与检验单 dispatchDate 等展示型日期同口径，仅展示不作运算） */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const EquipmentSchema = z.object({
  /** 主码：6 位顺序编码（000001 起），由服务端自动发号，客户端只读 */
  equipmentCode: z.string().regex(/^\d{6}$/, '设备编码必须是 6 位数字'),
  name: z.string().optional(),
  model: z.string().optional(),
  factorySerialNo: z.string().optional(),
  equipmentType: z.string().optional(),
  workshop: z.string().optional(),
  status: z.string().optional(),
  purchaseDate: z.string().regex(DATE_ONLY_PATTERN, '采购日期须为 YYYY-MM-DD').optional(),
  warrantyPeriod: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

/** 新增设备请求：除编码外的全部字段均可选（需求口径：不强制填写） */
export const CreateEquipmentRequestSchema = EquipmentSchema.omit({
  equipmentCode: true,
  createdAt: true,
  updatedAt: true,
});

export const EquipmentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  /** 关键字：模糊匹配 编码 / 名称 / 型号 / 出厂序列号 / 设备类型 */
  keyword: z.string().optional(),
  status: z.string().optional(),
  workshop: z.string().optional(),
});

export const EquipmentListResponseSchema = z.object({
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  items: z.array(EquipmentSchema),
  list: z.array(EquipmentSchema),
});
