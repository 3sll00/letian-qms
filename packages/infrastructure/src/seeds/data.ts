/**
 * 乐天 QMS 演示数据集（Demo Seed Data）
 *
 * 设计原则：
 * 1. 所有主键 / 外键均为"固定字面量 UUID"（版本位为 4、变体位为 8），
 *    保证每次执行 `pnpm db:seed` 得到完全一致、可复现的数据集；
 *    这些 UUID 会被契约 Schema（z.string().uuid()）校验，因此不能使用非 UUID 文本。
 * 2. 具体编码 / 名称尽量复用 apps/web/src/mocks/data.ts 中的演示值
 *    （物料编码、批次号、供应商/客户/车间/员工名称、MRB 单号、追溯链路），
 *    切换真实接口后前端界面与原先的 Mock 观感保持一致。
 * 3. 本文件只放"纯数据"，落库编排（TRUNCATE / 各仓储调用 / 汇总打印）在 runner.ts。
 */
import type {
  InspectionType,
  MRBReview,
  MaterialPermission,
  OverallDecision,
  PlanVersionStatus,
  ReviewFlow,
  TraceEdge,
  TraceNode,
  DataType,
  MetricCategory,
  InspectionStatus,
} from '@letian/contracts';
import type {
  AuditLogInsert,
  AuthorizationLogInsert,
  CustomerInsert,
  EmployeeInsert,
  CompanyProfileInsert,
  IntegrationConfigInsert,
  IntegrationSyncLogInsert,
  InventoryCategoryInsert,
  MaterialInsert,
  OutboxEventInsert,
  RoleInsert,
  SupplierInsert,
  WorkshopInsert,
} from '../database/schema.js';

// ============================================================================
// 0. 公共常量：员工 UUID（同时充当检验员 / 审批人 / PBAC 用户）
// ============================================================================

export const EMPLOYEE_IDS = {
  /** 张强 —— 质量经理 / MRB 主席 */
  zhangQiang: '11000000-0000-4000-8000-000000000001',
  /** 李伟 —— 工艺工程师 */
  liWei: '11000000-0000-4000-8000-000000000002',
  /** 刘芳 —— 成品终检质检员 */
  liuFang: '11000000-0000-4000-8000-000000000003',
  /** 王建国 —— 冷镦车间班组长 */
  wangJianGuo: '11000000-0000-4000-8000-000000000004',
  /** 赵志明 —— 搓丝车间质检员 */
  zhaoZhiMing: '11000000-0000-4000-8000-000000000005',
  /** 孙德胜 —— 热处理工艺员 */
  sunDeSheng: '11000000-0000-4000-8000-000000000006',
  /** 周海波 —— 表面处理工程师 */
  zhouHaiBo: '11000000-0000-4000-8000-000000000007',
  /** 陈静 —— 来料检验员 */
  chenJing: '11000000-0000-4000-8000-000000000008',
} as const;

/** 系统自动操作人（审计日志用全零 UUID 表示系统） */
export const SYSTEM_OPERATOR_ID = '00000000-0000-4000-8000-000000000000';

/** 统一的抽样配置：与前端 Mock 保持一致 */
const SAMPLING = {
  samplingScheme: 'GB_T_2828',
  aqlLevel: 'II',
  strictness: 'NORMAL',
} as const;

export { SAMPLING };

// ============================================================================
// 1. 存货分类（≥6 行、≥2 层级，父子关系靠 parent_code 表达）
// ============================================================================

export const seedCategories: InventoryCategoryInsert[] = [
  {
    id: '12000000-0000-4000-8000-000000000001',
    categoryCode: 'CAT-RAW',
    categoryName: '原材料与线材',
    parentCode: null,
    level: 1,
  },
  {
    id: '12000000-0000-4000-8000-000000000002',
    categoryCode: 'CAT-RAW-WIRE',
    categoryName: '不锈钢盘条与精拔丝',
    parentCode: 'CAT-RAW',
    level: 2,
  },
  {
    id: '12000000-0000-4000-8000-000000000003',
    categoryCode: 'CAT-RAW-ALLOY',
    categoryName: '合金钢圆钢',
    parentCode: 'CAT-RAW',
    level: 2,
  },
  {
    id: '12000000-0000-4000-8000-000000000004',
    categoryCode: 'CAT-SEMI',
    categoryName: '工序半成品件',
    parentCode: null,
    level: 1,
  },
  {
    id: '12000000-0000-4000-8000-000000000005',
    categoryCode: 'CAT-SEMI-BLANK',
    categoryName: '下料切断胚料',
    parentCode: 'CAT-SEMI',
    level: 2,
  },
  {
    id: '12000000-0000-4000-8000-000000000006',
    categoryCode: 'CAT-SEMI-THREAD',
    categoryName: '冷镦搓丝半成品',
    parentCode: 'CAT-SEMI',
    level: 2,
  },
  {
    id: '12000000-0000-4000-8000-000000000007',
    categoryCode: 'CAT-FINISH',
    categoryName: '成品紧固件',
    parentCode: null,
    level: 1,
  },
  {
    id: '12000000-0000-4000-8000-000000000008',
    categoryCode: 'CAT-FIN-BOLT',
    categoryName: '高强度螺栓类',
    parentCode: 'CAT-FINISH',
    level: 2,
  },
  {
    id: '12000000-0000-4000-8000-000000000009',
    categoryCode: 'CAT-FIN-NUT',
    categoryName: '高强度螺母类',
    parentCode: 'CAT-FINISH',
    level: 2,
  },
  {
    // 027 委外机加工成品件归位：精密轴套 / 连接件既非螺栓亦非螺母（docs/33 §4）
    id: '12000000-0000-4000-8000-000000000010',
    categoryCode: 'CAT-FIN-MACH',
    categoryName: '机加工成品件',
    parentCode: 'CAT-FINISH',
    level: 2,
  },
];

// ============================================================================
// 2. 物料主数据（≥8 行、≥4 个分类，密级覆盖 1..4）
// ============================================================================

export const seedMaterials: MaterialInsert[] = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    materialCode: 'MAT-304SS-05',
    materialName: '不锈钢线材 Φ5.0mm',
    specModel: 'Φ5.0mm / 盘圆 / 304HC',
    categoryCode: 'CAT-RAW-WIRE',
    unit: 'KG',
    confidentialityLevel: 1,
  },
  {
    id: '10000000-0000-4000-8000-000000000002',
    materialCode: 'MAT-35CRMO-08',
    materialName: '35CrMo 合金圆钢 Φ8.0mm',
    specModel: 'Φ8.0mm / 热轧圆钢 / 35CrMo',
    categoryCode: 'CAT-RAW-ALLOY',
    unit: 'KG',
    confidentialityLevel: 2,
  },
  {
    id: '10000000-0000-4000-8000-000000000003',
    materialCode: 'MAT-10B21-06',
    materialName: '冷镦钢 10B21 Φ6.0mm',
    specModel: 'Φ6.0mm / 盘条 / 10B21',
    categoryCode: 'CAT-RAW-WIRE',
    unit: 'KG',
    confidentialityLevel: 1,
  },
  {
    id: '10000000-0000-4000-8000-000000000004',
    materialCode: 'MAT-316L-04',
    materialName: '316L 不锈钢线材 Φ4.0mm',
    specModel: 'Φ4.0mm / 盘圆 / 316L',
    categoryCode: 'CAT-RAW-WIRE',
    unit: 'KG',
    confidentialityLevel: 4,
  },
  {
    id: '10000000-0000-4000-8000-000000000005',
    materialCode: 'MAT-SCR-M6-25',
    materialName: '高强度螺柱 M6*25 (冷镦毛坯)',
    specModel: 'M6*25 / 10.9级毛坯',
    categoryCode: 'CAT-SEMI-BLANK',
    unit: 'PCS',
    confidentialityLevel: 2,
  },
  {
    id: '10000000-0000-4000-8000-000000000006',
    materialCode: 'MAT-THRD-M6-25',
    materialName: '搓丝半成品 M6*25 6g',
    specModel: 'M6*25 / 6g 公差带',
    categoryCode: 'CAT-SEMI-THREAD',
    unit: 'PCS',
    confidentialityLevel: 2,
  },
  {
    id: '10000000-0000-4000-8000-000000000007',
    materialCode: 'MAT-BLT-109-M10',
    materialName: '10.9级六角头螺栓 M10*45 (成品)',
    specModel: 'M10*45 / GB/T 5782 / 蓝白锌',
    categoryCode: 'CAT-FIN-BOLT',
    unit: 'PCS',
    confidentialityLevel: 3,
  },
  {
    id: '10000000-0000-4000-8000-000000000008',
    materialCode: 'MAT-BLT-88-M12',
    materialName: '8.8级六角头螺栓 M12*60 (成品)',
    specModel: 'M12*60 / GB/T 5782 / 发黑',
    categoryCode: 'CAT-FIN-BOLT',
    unit: 'PCS',
    confidentialityLevel: 3,
  },
  {
    id: '10000000-0000-4000-8000-000000000009',
    materialCode: 'MAT-NUT-10-M10',
    materialName: '10级六角螺母 M10 (成品)',
    specModel: 'M10 / GB/T 6170 / 蓝白锌',
    categoryCode: 'CAT-FIN-NUT',
    unit: 'PCS',
    confidentialityLevel: 2,
  },
  {
    id: '10000000-0000-4000-8000-000000000010',
    materialCode: 'MAT-WSH-M10',
    materialName: '平垫圈 M10 (成品)',
    specModel: 'M10 / GB/T 97.1 / 镀锌',
    categoryCode: 'CAT-FIN-NUT',
    unit: 'PCS',
    confidentialityLevel: 1,
  },
  // 009 委外检验 (机加工 / 热处理) 受托件成品物料
  {
    id: '10000000-0000-4000-8000-000000000011',
    materialCode: 'MAT-SLV-45-20-30',
    materialName: '精密轴套',
    specModel: 'Φ20×30mm / 45# 钢 / 精磨外圆',
    categoryCode: 'CAT-FIN-MACH',
    unit: 'PCS',
    confidentialityLevel: 2,
  },
  {
    id: '10000000-0000-4000-8000-000000000012',
    materialCode: 'MAT-CON-M12',
    materialName: '连接件',
    specModel: 'M12 连接件 / 机加工成品',
    categoryCode: 'CAT-FIN-MACH',
    unit: 'PCS',
    confidentialityLevel: 2,
  },
  {
    id: '10000000-0000-4000-8000-000000000013',
    materialCode: 'MAT-BLT-109-M10-HT',
    materialName: '高强度螺栓',
    specModel: 'M10×45 / 10.9级 / 热处理回厂',
    categoryCode: 'CAT-FIN-BOLT',
    unit: 'PCS',
    confidentialityLevel: 3,
  },
  {
    id: '10000000-0000-4000-8000-000000000014',
    materialCode: 'MAT-WSH-SPR-M10',
    materialName: '弹簧垫圈',
    specModel: 'Φ10 / 65Mn / 热处理回厂',
    categoryCode: 'CAT-FIN-NUT',
    unit: 'PCS',
    confidentialityLevel: 1,
  },
  // 008 出货检验 (OQC_SH) 销售出库成品物料（与 WPS 图片(9) 出货检验原型口径一致）
  {
    id: '10000000-0000-4000-8000-000000000015',
    materialCode: 'MAT-BLT-88-M10',
    materialName: '六角螺栓M10',
    specModel: 'M10×30 / 8.8级 / 蓝白锌',
    categoryCode: 'CAT-FIN-BOLT',
    unit: 'PCS',
    confidentialityLevel: 3,
  },
  {
    id: '10000000-0000-4000-8000-000000000016',
    materialCode: 'MAT-BLT-88-M12-40',
    materialName: '六角螺栓M12',
    specModel: 'M12×40 / 8.8级 / 发黑',
    categoryCode: 'CAT-FIN-BOLT',
    unit: 'PCS',
    confidentialityLevel: 3,
  },
  {
    id: '10000000-0000-4000-8000-000000000017',
    materialCode: 'MAT-BLT-FLG-M8',
    materialName: '法兰螺栓',
    specModel: 'M8×25 / 法兰面 / 镀锌',
    categoryCode: 'CAT-FIN-BOLT',
    unit: 'PCS',
    confidentialityLevel: 2,
  },
];

/** 物料编码 -> 物料名称，工单落库时补齐 material_name */
export function materialNameOf(materialCode: string): string {
  const found = seedMaterials.find((m) => m.materialCode === materialCode);
  if (!found) {
    throw new Error(`SEED_MATERIAL_NOT_FOUND: 演示数据缺少物料 [${materialCode}]`);
  }
  return found.materialName;
}

/**
 * 物料编码 -> 规格型号，工单落库时补齐 specification（台账「规格型号」列的唯一来源）。
 *
 * 与 materialNameOf() 同型：规格型号属于物料主数据（ERP Ptype.Standard -> materials.spec_model），
 * 检验单只做快照，**绝不从 material_name 里猜**。详见 docs/26。
 */
export function materialSpecOf(materialCode: string): string | undefined {
  const found = seedMaterials.find((m) => m.materialCode === materialCode);
  if (!found) {
    throw new Error(`SEED_MATERIAL_NOT_FOUND: 演示数据缺少物料 [${materialCode}]`);
  }
  // 主数据列可空：查不到即返回 undefined，由调用方决定是否省略该属性（不做规格猜测）
  return found.specModel ?? undefined;
}

/**
 * 物料编码 -> 计量单位，工单落库时补齐 unit（台账「数量」列按 `{qty} {unit}` 渲染）。
 * 同样以物料主数据（ERP Unit1 -> materials.unit）为唯一权威来源。
 */
export function materialUnitOf(materialCode: string): string | undefined {
  const found = seedMaterials.find((m) => m.materialCode === materialCode);
  if (!found) {
    throw new Error(`SEED_MATERIAL_NOT_FOUND: 演示数据缺少物料 [${materialCode}]`);
  }
  return found.unit ?? undefined;
}

/** 物料编码 -> 存货分类编码，方案落库时补齐 category_code（分类级兜底匹配依据） */
export function materialCategoryOf(materialCode: string): string {
  const found = seedMaterials.find((m) => m.materialCode === materialCode);
  if (!found) {
    throw new Error(`SEED_MATERIAL_NOT_FOUND: 演示数据缺少物料 [${materialCode}]`);
  }
  return found.categoryCode;
}

/**
 * 员工 UUID -> 姓名，工单落库时补齐 inspector_name。
 *
 * 与迁移 010 的口径一致：检验人姓名是可重算的展示快照，必须与 inspector_id 指向的员工
 * 保持一致；查不到员工时返回 undefined（由调用方决定是否省略该属性），不做姓名猜测。
 */
export function employeeNameOf(employeeId: string): string | undefined {
  return seedEmployees.find((employee) => employee.id === employeeId)?.name;
}

/** 供应商编码 -> 企业全称（落 supplier_name 快照；查不到返回 undefined，不做姓名猜测） */
export function supplierNameOf(supplierCode: string): string | undefined {
  return seedSuppliers.find((supplier) => supplier.supplierCode === supplierCode)?.supplierName;
}

/** 客户编码 -> 企业全称（出货 / 成品检的客户追溯字段） */
export function customerNameOf(customerCode: string): string | undefined {
  return seedCustomers.find((customer) => customer.customerCode === customerCode)?.customerName;
}

/**
 * 待审核池条目 ID 由来源检验单 ID 派生（仅首段 3 -> 6）。
 * 池与工单一一对应，派生规则让种子、迁移回填与 MRB 外键可以互相确定引用，
 * 不需要额外的映射表，也不会产生随机 ID 造成的不可复现数据。
 */
export function pendingDefectIdOfOrder(orderId: string): string {
  return `6${orderId.slice(1)}`;
}

// ============================================================================
// 3. 供应商 / 客户 / 车间 / 员工
// ============================================================================

/**
 * 角色字典（003 迁移新增 roles 表）。
 * roleCode 同时被 material_permissions.role_code 与 employees.role_code 引用，
 * 是登录签发 JWT 角色与"按角色批量配置"的唯一数据源。
 */
export const seedRoles: RoleInsert[] = [
  { roleCode: 'ADMIN', roleName: '系统管理员', description: '系统所有资源与数据的完全控制权', sortOrder: 0 },
  { roleCode: 'QA_MANAGER', roleName: '质量主管', description: '质量总览与全量物料数据权限', sortOrder: 10 },
  { roleCode: 'PROCESS_ENGINEER', roleName: '工艺工程师', description: '质检方案与工艺参数维护', sortOrder: 20 },
  { roleCode: 'IQC_INSPECTOR', roleName: 'IQC检验员', description: '来料检验', sortOrder: 30 },
  { roleCode: 'IPQC_INSPECTOR', roleName: 'IPQC检验员', description: '过程检验', sortOrder: 40 },
  { roleCode: 'OQC_INSPECTOR', roleName: 'OQC检验员', description: '出货检验', sortOrder: 50 },
  { roleCode: 'INSPECTOR', roleName: '通用质检员', description: '质检基础权限角色', sortOrder: 55 },
  { roleCode: 'SURFACE_TREATMENT_ENGINEER', roleName: '表面处理工程师', description: '表面处理工序质量', sortOrder: 60 },
  { roleCode: 'WORKSHOP_LEADER', roleName: '车间班组长', description: '车间现场管理', sortOrder: 70 },
  { roleCode: 'RESTRICTED_VIEWER', roleName: '受限访问', description: '演示用受限角色（默认停用规则）', sortOrder: 90 },
];

export const seedSuppliers: SupplierInsert[] = [
  {
    id: '13000000-0000-4000-8000-000000000001',
    supplierCode: 'SUP-001',
    supplierName: '江苏大明不锈钢特钢有限公司',
    contactPerson: '钱总',
    phone: '13812345678',
  },
  {
    id: '13000000-0000-4000-8000-000000000002',
    supplierCode: 'SUP-002',
    supplierName: '青山控股实业线材分公司',
    contactPerson: '孙经理',
    phone: '13987654321',
  },
  {
    id: '13000000-0000-4000-8000-000000000003',
    supplierCode: 'SUP-003',
    supplierName: '张家港永钢集团金属制品公司',
    contactPerson: '赵部长',
    phone: '13700001122',
  },
  {
    id: '13000000-0000-4000-8000-000000000004',
    supplierCode: 'SUP-004',
    supplierName: '恒信表面处理厂',
    contactPerson: '吴厂长',
    phone: '13655558888',
  },
  {
    id: '13000000-0000-4000-8000-000000000005',
    supplierCode: 'SUP-005',
    supplierName: '无锡超匠工光轴制造有限公司',
    contactPerson: '郑经理',
    phone: '13522226666',
  },
  {
    // 009 委外检验 - 机加工工艺外协厂商
    id: '13000000-0000-4000-8000-000000000006',
    supplierCode: 'SUP-006',
    supplierName: '苏州机加工厂',
    contactPerson: '顾厂长',
    phone: '13711112222',
  },
  {
    // 009 委外检验 - 热处理工艺外协厂商
    id: '13000000-0000-4000-8000-000000000007',
    supplierCode: 'SUP-007',
    supplierName: '上海热处理厂',
    contactPerson: '沈经理',
    phone: '13833334444',
  },
];

export const seedCustomers: CustomerInsert[] = [
  {
    id: '14000000-0000-4000-8000-000000000001',
    customerCode: 'CUST-001',
    customerName: '上海通用汽车零部件采购部',
    contactPerson: '陈总监',
    phone: '021-88997766',
  },
  {
    id: '14000000-0000-4000-8000-000000000002',
    customerCode: 'CUST-002',
    customerName: '三一重工机械装备底盘制造厂',
    contactPerson: '周科长',
    phone: '0731-66554433',
  },
  {
    id: '14000000-0000-4000-8000-000000000003',
    customerCode: 'CUST-003',
    customerName: '金风科技风电紧固件集采中心',
    contactPerson: '吴经理',
    phone: '010-55667788',
  },
];

export const seedWorkshops: WorkshopInsert[] = [
  {
    id: '15000000-0000-4000-8000-000000000001',
    workshopCode: 'WS-01',
    workshopName: '高速冷镦第一车间',
  },
  {
    id: '15000000-0000-4000-8000-000000000002',
    workshopCode: 'WS-02',
    workshopName: '精密搓丝成型第二车间',
  },
  {
    id: '15000000-0000-4000-8000-000000000003',
    workshopCode: 'WS-03',
    workshopName: '连续式网带调质热处理车间',
  },
  {
    id: '15000000-0000-4000-8000-000000000004',
    workshopCode: 'WS-04',
    workshopName: '环保自动化电镀流水线车间',
  },
];

export const seedEmployees: EmployeeInsert[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    employeeCode: 'EMP-9999',
    name: '张三 (测试质检员)',
    department: '品质保证部',
    phone: '13899999999',
    email: 'zhangsan@letian.com',
    isActive: true,
    roleCode: 'QA_MANAGER',
  },
  {
    id: EMPLOYEE_IDS.zhangQiang,
    employeeCode: 'EMP-1042',
    name: '张强',
    department: '品质保证部',
    phone: '13800000001',
    email: 'zhangqiang@letian.com',
    isActive: true,
    roleCode: 'QA_MANAGER',
  },
  {
    id: EMPLOYEE_IDS.liWei,
    employeeCode: 'EMP-1088',
    name: '李伟',
    department: '生产部',
    phone: '13800000002',
    email: 'liwei@letian.com',
    isActive: true,
    roleCode: 'PROCESS_ENGINEER',
  },
  {
    id: EMPLOYEE_IDS.liuFang,
    employeeCode: 'EMP-1095',
    name: '刘芳',
    department: '品质保证部',
    phone: '13800000003',
    email: 'liufang@letian.com',
    isActive: true,
    roleCode: 'OQC_INSPECTOR',
  },
  {
    id: EMPLOYEE_IDS.wangJianGuo,
    employeeCode: 'EMP-1102',
    name: '王建国',
    department: '生产部',
    phone: '13800000004',
    email: 'wangjianguo@letian.com',
    isActive: true,
    roleCode: 'WORKSHOP_LEADER',
  },
  {
    id: EMPLOYEE_IDS.zhaoZhiMing,
    employeeCode: 'EMP-1108',
    name: '赵志明',
    department: '生产部',
    phone: '13800000005',
    email: 'zhaozhiming@letian.com',
    isActive: true,
    roleCode: 'IPQC_INSPECTOR',
  },
  {
    id: EMPLOYEE_IDS.sunDeSheng,
    employeeCode: 'EMP-1115',
    name: '孙德胜',
    department: '生产部',
    phone: '13800000006',
    email: 'sundesheng@letian.com',
    isActive: true,
    roleCode: 'PROCESS_ENGINEER',
  },
  {
    id: EMPLOYEE_IDS.zhouHaiBo,
    employeeCode: 'EMP-1121',
    name: '周海波',
    department: '生产部',
    phone: '13800000007',
    email: 'zhouhaibo@letian.com',
    isActive: true,
    roleCode: 'SURFACE_TREATMENT_ENGINEER',
  },
  {
    id: EMPLOYEE_IDS.chenJing,
    employeeCode: 'EMP-1130',
    name: '陈静',
    department: '品质保证部',
    phone: '13800000008',
    email: 'chenjing@letian.com',
    isActive: true,
    roleCode: 'IQC_INSPECTOR',
  },
];

// ============================================================================
// 4. 质检方案与方案版本（一行 = 一个版本，UNIQUE(plan_code, version)）
// ============================================================================

/** 指标模板（内部强类型，保证 nominalValue / 公差 / 单位 等字段齐全） */
export interface SeedMetric {
  itemCode: string;
  name: string;
  dataType: DataType;
  metricCategory: MetricCategory;
  /** 规格描述 */
  standardText: string;
  /**
   * 定性 / 文本型指标的「可接受值清单」（契约 `InspectionPlanItemSchema.acceptableValues`）。
   * 判标唯一权威（`docs/17` §7.6 TBD-06）：非空时领域层只认清单成员，不再回落
   * `standardText` 的 `, ， / |` 分隔符约定。数值型指标不使用该字段。
   */
  acceptableValues?: string[];
  // 数值判定基准：仅 `dataType = NUMERIC` 的指标携带（定性指标不写，避免落下没有依据的公差）
  nominalValue?: number;
  /** 上公差（正数量值） */
  upperTolerance?: number;
  /** 下公差（正数量值） */
  lowerTolerance?: number;
  sampleSize?: number;
  unit?: string;
  measurementTool?: string;
  isMandatory: boolean;
}

export interface SeedPlanVersion {
  /** 版本行 UUID：同时充当契约里的 planId 与 versionId */
  id: string;
  versionNo: string;
  status: PlanVersionStatus;
  createdBy: string;
  items: SeedMetric[];
}

export interface SeedPlan {
  planCode: string;
  planName: string;
  /** 专属物料编码；**空串 = 该存货分类的通用方案**（分类级兜底匹配依据，见 docs/17 §7.3 与 docs/37） */
  materialCode: string;
  /** 方案分类归属；分类通用方案（materialCode 为空串）必须显式给出，否则定位不到兜底分类 */
  categoryCode?: string;
  inspectionType: InspectionType;
  versions: SeedPlanVersion[];
}

/**
 * 企业档案（迁移 029 起的主数据表）：证书抬头「签发主体 / 供货单位 / 产地」的唯一真实来源。
 *
 * 三个已填值取自改造前**模板里的硬编码常量**（迁移 029 的初始行同值），只是从代码搬到数据，
 * 不新增任何未经确认的信息；`address` / `origin_place` / `phone` / `email` 保持 NULL ——
 * 业务侧未确认，界面按空白渲染，绝不用推测值填充。
 */
export const seedCompanyProfile: CompanyProfileInsert[] = [
  {
    profileId: true,
    legalName: '宁波乐天紧固件制造有限公司',
    legalNameEn: 'NINGBO LETIAN FASTENERS MANUFACTURING CO., LTD.',
    shortName: null,
    address: null,
    originPlace: null,
    phone: null,
    email: null,
    qualityStamp: '宁波乐天质检',
    updatedBy: 'seed',
  },
];
export const seedPlans: SeedPlan[] = [
  {
    planCode: 'QP-IQC-304SS',
    planName: '不锈钢冷镦盘圆丝来料抽样规程',
    materialCode: 'MAT-304SS-05',
    inspectionType: 'IQC',
    versions: [
      {
        // 当前生效版本
        id: '21000000-0000-4000-8000-000000000001',
        versionNo: 'v2.4',
        status: 'ACTIVE',
        createdBy: EMPLOYEE_IDS.zhangQiang,
        items: [
          {
            itemCode: 'DIA-001',
            name: '直径',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: 'Φ5.00±0.02mm',
            nominalValue: 5.0,
            upperTolerance: 0.02,
            lowerTolerance: 0.02,
            sampleSize: 50,
            unit: 'mm',
            measurementTool: '外径千分尺',
            isMandatory: true,
          },
          {
            itemCode: 'TEN-001',
            name: '抗拉强度',
            dataType: 'NUMERIC',
            metricCategory: 'TENSILE_STRENGTH',
            standardText: '≥650MPa',
            nominalValue: 650,
            upperTolerance: 200,
            lowerTolerance: 0,
            sampleSize: 5,
            unit: 'MPa',
            measurementTool: '万能材料试验机',
            isMandatory: true,
          },
          {
            itemCode: 'CHE-001',
            name: '碳含量',
            dataType: 'NUMERIC',
            metricCategory: 'CHEMICAL_COMPOSITION',
            standardText: '0.05%~0.11%',
            nominalValue: 0.08,
            upperTolerance: 0.03,
            lowerTolerance: 0.03,
            sampleSize: 3,
            unit: '%',
            measurementTool: '光谱分析仪',
            isMandatory: true,
          },
          {
            itemCode: 'RGH-001',
            name: '表面粗糙度',
            dataType: 'NUMERIC',
            metricCategory: 'APPEARANCE',
            standardText: 'Ra≤0.8μm',
            nominalValue: 0.8,
            upperTolerance: 0.2,
            lowerTolerance: 0.2,
            sampleSize: 10,
            unit: 'μm',
            measurementTool: '粗糙度仪',
            isMandatory: false,
          },
        ],
      },
      {
        // 草案版本：用于演示 DRAFT -> ACTIVE 的版本切换
        id: '21000000-0000-4000-8000-000000000002',
        versionNo: 'v2.5',
        status: 'DRAFT',
        createdBy: EMPLOYEE_IDS.zhangQiang,
        items: [
          {
            itemCode: 'DIA-001',
            name: '直径',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: 'Φ5.00±0.015mm',
            nominalValue: 5.0,
            upperTolerance: 0.015,
            lowerTolerance: 0.015,
            sampleSize: 64,
            unit: 'mm',
            measurementTool: '外径千分尺',
            isMandatory: true,
          },
          {
            itemCode: 'TEN-001',
            name: '抗拉强度',
            dataType: 'NUMERIC',
            metricCategory: 'TENSILE_STRENGTH',
            standardText: '≥650MPa',
            nominalValue: 650,
            upperTolerance: 200,
            lowerTolerance: 0,
            sampleSize: 5,
            unit: 'MPa',
            measurementTool: '万能材料试验机',
            isMandatory: true,
          },
          {
            itemCode: 'CHE-001',
            name: '碳含量',
            dataType: 'NUMERIC',
            metricCategory: 'CHEMICAL_COMPOSITION',
            standardText: '0.05%~0.11%',
            nominalValue: 0.08,
            upperTolerance: 0.03,
            lowerTolerance: 0.03,
            sampleSize: 3,
            unit: '%',
            measurementTool: '光谱分析仪',
            isMandatory: true,
          },
        ],
      },
    ],
  },
  {
    planCode: 'QP-IQC-35CRMO',
    planName: '35CrMo 合金圆钢来料检验规程',
    materialCode: 'MAT-35CRMO-08',
    inspectionType: 'IQC',
    versions: [
      {
        id: '22000000-0000-4000-8000-000000000001',
        versionNo: 'v1.0',
        status: 'ACTIVE',
        createdBy: EMPLOYEE_IDS.chenJing,
        items: [
          {
            itemCode: 'DIA-002',
            name: '直径',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: 'Φ8.00±0.03mm',
            nominalValue: 8.0,
            upperTolerance: 0.03,
            lowerTolerance: 0.03,
            sampleSize: 32,
            unit: 'mm',
            measurementTool: '游标卡尺',
            isMandatory: true,
          },
          {
            itemCode: 'CHE-002',
            name: '铬含量',
            dataType: 'NUMERIC',
            metricCategory: 'CHEMICAL_COMPOSITION',
            standardText: '0.90%~1.10%',
            nominalValue: 1.0,
            upperTolerance: 0.1,
            lowerTolerance: 0.1,
            sampleSize: 3,
            unit: '%',
            measurementTool: '光谱分析仪',
            isMandatory: true,
          },
          {
            itemCode: 'TEN-002',
            name: '抗拉强度',
            dataType: 'NUMERIC',
            metricCategory: 'TENSILE_STRENGTH',
            standardText: '≥980MPa',
            nominalValue: 980,
            upperTolerance: 120,
            lowerTolerance: 0,
            sampleSize: 5,
            unit: 'MPa',
            measurementTool: '万能材料试验机',
            isMandatory: true,
          },
          {
            itemCode: 'HAR-002',
            name: '洛氏硬度',
            dataType: 'NUMERIC',
            metricCategory: 'HARDNESS',
            standardText: '32~38HRC',
            nominalValue: 35,
            upperTolerance: 3,
            lowerTolerance: 3,
            sampleSize: 8,
            unit: 'HRC',
            measurementTool: '洛氏硬度计',
            isMandatory: true,
          },
        ],
      },
    ],
  },
  {
    planCode: 'QP-IPQC-CUT',
    planName: '冷镦下料工序首巡检规范',
    materialCode: 'MAT-SCR-M6-25',
    inspectionType: 'IPQC_CT',
    versions: [
      {
        id: '23000000-0000-4000-8000-000000000001',
        versionNo: 'v1.1',
        status: 'ACTIVE',
        createdBy: EMPLOYEE_IDS.wangJianGuo,
        items: [
          {
            itemCode: 'CUT-001',
            name: '切断长度',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: '25.00±0.10mm',
            nominalValue: 25.0,
            upperTolerance: 0.1,
            lowerTolerance: 0.1,
            sampleSize: 32,
            unit: 'mm',
            measurementTool: '游标卡尺',
            isMandatory: true,
          },
          {
            itemCode: 'BUR-001',
            name: '毛刺高度',
            dataType: 'NUMERIC',
            metricCategory: 'APPEARANCE',
            standardText: '≤0.05mm',
            nominalValue: 0.05,
            upperTolerance: 0.02,
            lowerTolerance: 0.05,
            sampleSize: 32,
            unit: 'mm',
            measurementTool: '影像测量仪',
            isMandatory: true,
          },
          {
            itemCode: 'ANG-001',
            name: '端面垂直度',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: '90.0±0.5°',
            nominalValue: 90.0,
            upperTolerance: 0.5,
            lowerTolerance: 0.5,
            sampleSize: 16,
            unit: '°',
            measurementTool: '直角量块',
            isMandatory: true,
          },
        ],
      },
    ],
  },
  {
    planCode: 'QP-IPQC-RL',
    planName: '滚丝工序螺纹尺寸与外观检验规范',
    materialCode: 'MAT-THRD-M6-25',
    inspectionType: 'IPQC_RL',
    versions: [
      {
        id: '24000000-0000-4000-8000-000000000001',
        versionNo: 'v1.0',
        status: 'ACTIVE',
        createdBy: EMPLOYEE_IDS.zhaoZhiMing,
        items: [
          {
            itemCode: 'THR-001',
            name: '螺纹中径',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: '5.350±0.030mm',
            nominalValue: 5.35,
            upperTolerance: 0.03,
            lowerTolerance: 0.03,
            sampleSize: 32,
            unit: 'mm',
            measurementTool: '螺纹千分尺',
            isMandatory: true,
          },
          {
            itemCode: 'PIT-001',
            name: '螺距',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: '1.00±0.02mm',
            nominalValue: 1.0,
            upperTolerance: 0.02,
            lowerTolerance: 0.02,
            sampleSize: 32,
            unit: 'mm',
            measurementTool: '螺距规',
            isMandatory: true,
          },
          {
            itemCode: 'THA-001',
            name: '牙型角',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: '60.0±1.0°',
            nominalValue: 60.0,
            upperTolerance: 1.0,
            lowerTolerance: 1.0,
            sampleSize: 16,
            unit: '°',
            measurementTool: '投影仪',
            isMandatory: true,
          },
          {
            itemCode: 'RGH-002',
            name: '螺纹表面粗糙度',
            dataType: 'NUMERIC',
            metricCategory: 'APPEARANCE',
            standardText: 'Ra≤1.6μm',
            nominalValue: 1.6,
            upperTolerance: 0.4,
            lowerTolerance: 0.4,
            sampleSize: 16,
            unit: 'μm',
            measurementTool: '粗糙度仪',
            isMandatory: false,
          },
        ],
      },
    ],
  },
  {
    planCode: 'QP-FQC-AUTO',
    planName: '六角头成品螺栓全尺寸与机械性能检验标准',
    materialCode: 'MAT-BLT-109-M10',
    inspectionType: 'IPQC_FN',
    versions: [
      {
        id: '25000000-0000-4000-8000-000000000001',
        versionNo: 'v3.0',
        status: 'ACTIVE',
        createdBy: EMPLOYEE_IDS.liuFang,
        items: [
          {
            itemCode: 'THR-002',
            name: '螺纹中径',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: '9.026±0.030mm',
            nominalValue: 9.026,
            upperTolerance: 0.03,
            lowerTolerance: 0.03,
            sampleSize: 80,
            unit: 'mm',
            measurementTool: '螺纹千分尺',
            isMandatory: true,
          },
          {
            itemCode: 'LEN-002',
            name: '总长',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: '45.0±0.2mm',
            nominalValue: 45.0,
            upperTolerance: 0.2,
            lowerTolerance: 0.2,
            sampleSize: 32,
            unit: 'mm',
            measurementTool: '游标卡尺',
            isMandatory: true,
          },
          {
            itemCode: 'HAR-003',
            name: '芯部硬度',
            dataType: 'NUMERIC',
            metricCategory: 'HARDNESS',
            standardText: '33±3HRC',
            nominalValue: 33,
            upperTolerance: 3,
            lowerTolerance: 3,
            sampleSize: 8,
            unit: 'HRC',
            measurementTool: '洛氏硬度计',
            isMandatory: true,
          },
          {
            itemCode: 'TEN-003',
            name: '抗拉强度',
            dataType: 'NUMERIC',
            metricCategory: 'TENSILE_STRENGTH',
            standardText: '≥1040MPa',
            nominalValue: 1040,
            upperTolerance: 100,
            lowerTolerance: 0,
            sampleSize: 5,
            unit: 'MPa',
            measurementTool: '万能材料试验机',
            isMandatory: true,
          },
        ],
      },
    ],
  },
  {
    planCode: 'QP-OQC-SF',
    planName: '委外表处/热处理回厂检验规范',
    materialCode: 'MAT-BLT-109-M10',
    inspectionType: 'OQC_SF',
    versions: [
      {
        id: '26000000-0000-4000-8000-000000000001',
        versionNo: 'v2.0',
        status: 'ACTIVE',
        createdBy: EMPLOYEE_IDS.zhouHaiBo,
        items: [
          {
            itemCode: 'COA-001',
            name: '镀层厚度',
            dataType: 'NUMERIC',
            metricCategory: 'COATING_THICKNESS',
            standardText: '局部≥8μm',
            nominalValue: 8.0,
            upperTolerance: 4.0,
            lowerTolerance: 0.5,
            sampleSize: 20,
            unit: 'μm',
            measurementTool: '膜厚测厚仪',
            isMandatory: true,
          },
          {
            itemCode: 'HAR-004',
            name: '回厂硬度',
            dataType: 'NUMERIC',
            metricCategory: 'HARDNESS',
            standardText: '33±3HRC',
            nominalValue: 33,
            upperTolerance: 3,
            lowerTolerance: 3,
            sampleSize: 8,
            unit: 'HRC',
            measurementTool: '洛氏硬度计',
            isMandatory: true,
          },
          {
            itemCode: 'APP-002',
            name: '镀层色差',
            dataType: 'NUMERIC',
            metricCategory: 'APPEARANCE',
            standardText: 'ΔE≤1.5',
            nominalValue: 1.0,
            upperTolerance: 0.5,
            lowerTolerance: 0.5,
            sampleSize: 20,
            unit: 'ΔE',
            measurementTool: '色差仪',
            isMandatory: false,
          },
          {
            itemCode: 'TOR-001',
            name: '扭矩系数',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: '0.14±0.02',
            nominalValue: 0.14,
            upperTolerance: 0.02,
            lowerTolerance: 0.02,
            sampleSize: 10,
            unit: '',
            measurementTool: '扭矩试验机',
            isMandatory: true,
          },
        ],
      },
    ],
  },
  {
    planCode: 'QP-OQC-SH',
    planName: '出货检验与客户放行规范',
    materialCode: 'MAT-BLT-109-M10',
    inspectionType: 'OQC_SH',
    versions: [
      {
        id: '27000000-0000-4000-8000-000000000001',
        versionNo: 'v1.2',
        status: 'ACTIVE',
        createdBy: EMPLOYEE_IDS.liuFang,
        items: [
          {
            itemCode: 'PKG-001',
            name: '包装重量',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: '25.0±0.5kg',
            nominalValue: 25.0,
            upperTolerance: 0.5,
            lowerTolerance: 0.5,
            sampleSize: 10,
            unit: 'kg',
            measurementTool: '电子台秤',
            isMandatory: true,
          },
          {
            itemCode: 'THR-003',
            name: '通规通过率',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: '100%',
            nominalValue: 100,
            upperTolerance: 1,
            lowerTolerance: 0,
            sampleSize: 200,
            unit: '%',
            measurementTool: '螺纹通止规',
            isMandatory: true,
          },
          {
            itemCode: 'LEN-003',
            name: '总长',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: '45.0±0.2mm',
            nominalValue: 45.0,
            upperTolerance: 0.2,
            lowerTolerance: 0.2,
            sampleSize: 32,
            unit: 'mm',
            measurementTool: '游标卡尺',
            isMandatory: true,
          },
          {
            itemCode: 'MAR-001',
            name: '标识印记高度',
            dataType: 'NUMERIC',
            metricCategory: 'APPEARANCE',
            standardText: '0.5±0.1mm',
            nominalValue: 0.5,
            upperTolerance: 0.1,
            lowerTolerance: 0.1,
            sampleSize: 20,
            unit: 'mm',
            measurementTool: '影像测量仪',
            isMandatory: false,
          },
        ],
      },
    ],
  },
  {
    planCode: 'QP-OQC-SH-FAMILY',
    planName: '成品螺栓族出货检验与客户放行通用规范',
    // 空串 = 分类通用方案：承载「判标不依赖具体规格」的族内通用检项，作为出货检验的族级兜底
    // （件专有尺寸/装箱项仍在物料专属方案 QP-OQC-SH，命中优先级高于本方案，见 docs/37）
    materialCode: '',
    categoryCode: 'CAT-FIN-BOLT',
    inspectionType: 'OQC_SH',
    versions: [
      {
        id: '27000000-0000-4000-8000-000000000002',
        versionNo: 'v1.0',
        status: 'ACTIVE',
        createdBy: EMPLOYEE_IDS.liuFang,
        items: [
          {
            itemCode: 'THR-003',
            name: '通规通过率',
            dataType: 'NUMERIC',
            metricCategory: 'DIMENSION',
            standardText: '100%',
            nominalValue: 100,
            upperTolerance: 1,
            lowerTolerance: 0,
            sampleSize: 200,
            unit: '%',
            measurementTool: '螺纹通止规',
            isMandatory: true,
          },
          {
            itemCode: 'MAR-001',
            name: '标识印记高度',
            dataType: 'NUMERIC',
            metricCategory: 'APPEARANCE',
            standardText: '0.5±0.1mm',
            nominalValue: 0.5,
            upperTolerance: 0.1,
            lowerTolerance: 0.1,
            sampleSize: 20,
            unit: 'mm',
            measurementTool: '影像测量仪',
            isMandatory: false,
          },
        ],
      },
    ],
  },
  {
    planCode: 'QP-OQC-MACH-FAMILY',
    planName: '机加工件委外回厂通用验收规范',
    // 空串 = 分类通用方案：只承载「判标不依赖具体件号规格」的工艺级要求，作为机加工委外的族级兜底。
    // 尺寸 / 螺纹 / 粗糙度等依图纸的特性留在物料专属方案（命中优先级更高），见 docs/36 §9。
    materialCode: '',
    categoryCode: 'CAT-FIN-MACH',
    inspectionType: 'OQC_MACH',
    versions: [
      {
        id: '26000000-0000-4000-8000-000000000201',
        versionNo: 'v1.0',
        status: 'ACTIVE',
        createdBy: EMPLOYEE_IDS.liWei,
        items: [
          {
            itemCode: 'VIS-001',
            name: '外观与棱边质量',
            dataType: 'QUALITATIVE',
            metricCategory: 'APPEARANCE',
            standardText: '无毛刺、无磕碰划伤、无锈蚀，棱边倒角完整',
            acceptableValues: ['合格'],
            sampleSize: 20,
            unit: '',
            measurementTool: '目视 / 手感',
            isMandatory: true,
          },
          {
            itemCode: 'PRT-001',
            name: '表面防护与包装',
            dataType: 'QUALITATIVE',
            metricCategory: 'APPEARANCE',
            standardText: '加工面防锈处理有效、无锈蚀；随件防护包装完好',
            acceptableValues: ['合格'],
            sampleSize: 5,
            unit: '',
            measurementTool: '目视',
            isMandatory: false,
          },
        ],
      },
    ],
  },
  {
    planCode: 'QP-OQC-HEAT-FAMILY-BOLT',
    planName: '紧固件（螺栓）热处理委外回厂通用验收规范',
    // 热处理属特殊过程（IATF 16949 §8.5.1.1 / CQI-9）：族级只承载「过程记录可追溯性 + 外观」这类
    // 与件号无关的工艺级要求；硬度 / 力学性能依材料牌号，必须留在物料专属方案，见 docs/36 §9.3。
    materialCode: '',
    categoryCode: 'CAT-FIN-BOLT',
    inspectionType: 'OQC_HEAT',
    versions: [
      {
        id: '26000000-0000-4000-8000-000000000202',
        versionNo: 'v1.0',
        status: 'ACTIVE',
        createdBy: EMPLOYEE_IDS.sunDeSheng,
        items: [
          {
            itemCode: 'TRC-001',
            name: '热处理过程记录可追溯性',
            dataType: 'QUALITATIVE',
            metricCategory: 'APPEARANCE',
            standardText: '炉号 / 装炉记录 / 工艺曲线随单归档并可追溯（CQI-9 特殊过程确认）',
            acceptableValues: ['合格'],
            sampleSize: 1,
            unit: '',
            measurementTool: '记录核查',
            isMandatory: true,
          },
          {
            itemCode: 'VIS-002',
            name: '热处理外观',
            dataType: 'QUALITATIVE',
            metricCategory: 'APPEARANCE',
            standardText: '无氧化皮、无裂纹、无过烧、无碰伤',
            acceptableValues: ['合格'],
            sampleSize: 20,
            unit: '',
            measurementTool: '目视',
            isMandatory: true,
          },
        ],
      },
    ],
  },
  {
    planCode: 'QP-OQC-HEAT-FAMILY-NUT',
    planName: '紧固件（螺母 / 垫圈）热处理委外回厂通用验收规范',
    // 与 QP-OQC-HEAT-FAMILY-BOLT 同款指标（同一工艺级要求），分类不同故独立一行
    // —— 两级匹配按 category_code 兜底，一个分类一行（plan_code + version 唯一约束）
    materialCode: '',
    categoryCode: 'CAT-FIN-NUT',
    inspectionType: 'OQC_HEAT',
    versions: [
      {
        id: '26000000-0000-4000-8000-000000000203',
        versionNo: 'v1.0',
        status: 'ACTIVE',
        createdBy: EMPLOYEE_IDS.sunDeSheng,
        items: [
          {
            itemCode: 'TRC-001',
            name: '热处理过程记录可追溯性',
            dataType: 'QUALITATIVE',
            metricCategory: 'APPEARANCE',
            standardText: '炉号 / 装炉记录 / 工艺曲线随单归档并可追溯（CQI-9 特殊过程确认）',
            acceptableValues: ['合格'],
            sampleSize: 1,
            unit: '',
            measurementTool: '记录核查',
            isMandatory: true,
          },
          {
            itemCode: 'VIS-002',
            name: '热处理外观',
            dataType: 'QUALITATIVE',
            metricCategory: 'APPEARANCE',
            standardText: '无氧化皮、无裂纹、无过烧、无碰伤',
            acceptableValues: ['合格'],
            sampleSize: 20,
            unit: '',
            measurementTool: '目视',
            isMandatory: true,
          },
        ],
      },
    ],
  },
  {
    planCode: 'QP-OQC-SF-FAMILY-BOLT',
    planName: '成品螺栓族表面处理委外回厂通用验收规范',
    // 空串 = 分类通用方案：表面处理族级只承载「判标不依赖具体件号规格」的工艺级要求
    //（镀覆层外观 / 附着力 / 防护包装）；镀层厚度、色差、盐雾小时数、扭矩系数依规格，
    //  留在物料专属方案 QP-OQC-SF（命中优先级更高），见 docs/36 §9。
    materialCode: '',
    categoryCode: 'CAT-FIN-BOLT',
    inspectionType: 'OQC_SF',
    versions: [
      {
        id: '26000000-0000-4000-8000-000000000301',
        versionNo: 'v1.0',
        status: 'ACTIVE',
        createdBy: EMPLOYEE_IDS.zhouHaiBo,
        items: [
          {
            itemCode: 'VIS-003',
            name: '镀覆层外观',
            dataType: 'QUALITATIVE',
            metricCategory: 'APPEARANCE',
            standardText: '镀覆层均匀完整，无漏镀、无起泡、无剥落、无烧焦、无锈蚀',
            acceptableValues: ['合格'],
            sampleSize: 20,
            unit: '',
            measurementTool: '目视',
            isMandatory: true,
          },
          {
            itemCode: 'ADH-001',
            name: '镀覆层附着力',
            dataType: 'QUALITATIVE',
            metricCategory: 'APPEARANCE',
            standardText: '划格 / 弯曲试验后镀覆层无剥落、无起皮（GB/T 5270）',
            acceptableValues: ['合格'],
            sampleSize: 3,
            unit: '',
            measurementTool: '划格器 / 弯曲试验',
            isMandatory: true,
          },
          {
            itemCode: 'PRT-002',
            name: '表面防护与包装',
            dataType: 'QUALITATIVE',
            metricCategory: 'APPEARANCE',
            standardText: '经防潮、防碰伤包装，随件标识完整、运输后无锈蚀',
            acceptableValues: ['合格'],
            sampleSize: 5,
            unit: '',
            measurementTool: '目视',
            isMandatory: false,
          },
        ],
      },
    ],
  },
  {
    planCode: 'QP-OQC-SF-FAMILY-NUT',
    planName: '成品螺母 / 垫圈族表面处理委外回厂通用验收规范',
    // 与 QP-OQC-SF-FAMILY-BOLT 同款工艺级要求（同一表面处理工序族），分类不同故独立一行
    // —— 两级匹配按 category_code 兜底，一个分类一行（plan_code + version 唯一约束）
    materialCode: '',
    categoryCode: 'CAT-FIN-NUT',
    inspectionType: 'OQC_SF',
    versions: [
      {
        id: '26000000-0000-4000-8000-000000000302',
        versionNo: 'v1.0',
        status: 'ACTIVE',
        createdBy: EMPLOYEE_IDS.zhouHaiBo,
        items: [
          {
            itemCode: 'VIS-003',
            name: '镀覆层外观',
            dataType: 'QUALITATIVE',
            metricCategory: 'APPEARANCE',
            standardText: '镀覆层均匀完整，无漏镀、无起泡、无剥落、无烧焦、无锈蚀',
            acceptableValues: ['合格'],
            sampleSize: 20,
            unit: '',
            measurementTool: '目视',
            isMandatory: true,
          },
          {
            itemCode: 'ADH-001',
            name: '镀覆层附着力',
            dataType: 'QUALITATIVE',
            metricCategory: 'APPEARANCE',
            standardText: '划格 / 弯曲试验后镀覆层无剥落、无起皮（GB/T 5270）',
            acceptableValues: ['合格'],
            sampleSize: 3,
            unit: '',
            measurementTool: '划格器 / 弯曲试验',
            isMandatory: true,
          },
          {
            itemCode: 'PRT-002',
            name: '表面防护与包装',
            dataType: 'QUALITATIVE',
            metricCategory: 'APPEARANCE',
            standardText: '经防潮、防碰伤包装，随件标识完整、运输后无锈蚀',
            acceptableValues: ['合格'],
            sampleSize: 5,
            unit: '',
            measurementTool: '目视',
            isMandatory: false,
          },
        ],
      },
    ],
  },
];

/** 按 plan_code 取方案 */
export function planOf(planCode: string): SeedPlan {
  const found = seedPlans.find((p) => p.planCode === planCode);
  if (!found) {
    throw new Error(`SEED_PLAN_NOT_FOUND: 演示数据缺少质检方案 [${planCode}]`);
  }
  return found;
}

/** 取指定方案的指定版本 */
export function planVersionOf(planCode: string, versionNo: string): SeedPlanVersion {
  const version = planOf(planCode).versions.find((v) => v.versionNo === versionNo);
  if (!version) {
    throw new Error(`SEED_PLAN_VERSION_NOT_FOUND: 方案 [${planCode}] 缺少版本 [${versionNo}]`);
  }
  return version;
}

// ============================================================================
// 5. 检验工单（覆盖 8 个状态、6 种检验类型）
// ============================================================================

/** 工单实测项的判定形态：决定 items 的结果与实测值 */
export type ItemResultKind = 'ALL_PASSED' | 'HAS_FAILED' | 'CONCESSION' | 'PENDING';

export interface SeedOrderSpec {
  id: string;
  orderNo: string;
  orderType: InspectionType;
  planCode: string;
  /** 指定引用的方案版本号 */
  versionNo: string;
  batchNo: string;
  materialCode: string;
  supplierCode?: string;
  customerCode?: string;
  inspectorId: string;
  totalQty: number;
  sampleQty: number;
  status: InspectionStatus;
  /** 未终判时为空 */
  judgment: OverallDecision | null;
  isMandatoryGate: boolean;
  inspectionNotes: string;
  /** 方案快照生成时间戳 */
  snapshotAt: string;
  itemKind: ItemResultKind;
  // 006 来料检验 (IQC) 入库单号 / 入库日期：台账第 2、3 列直接读库，不由检验单号推导
  /** 入库单号（ERP 采购入库单 Dlyndx.Number），如 RK-20231012-001 */
  inboundNo?: string;
  /** 入库日期，如 2023-10-12 */
  inboundDate?: string;
  // 007 过程检验 (IPQC) 工序追溯字段（下料检验 / 滚丝检验 / 成品检台账列，见 docs/29 §2）
  /** MES 生产工单号（追溯链上的「来源单据」，如 WO-20231012-01） */
  workOrderNo?: string;
  /** 断料长度 mm（下料检验专有，台账「断料长度」列） */
  blankingLength?: number;
  /** 机台作业员姓名（台账「操作员」列，如 陈操作） */
  operatorName?: string;
  /** 机台作业员工号（如 OP-0102） */
  operatorId?: string;
  /** 机台设备编号（台账「设备」列，如 EQ-CT-01） */
  equipmentCode?: string;
  /** 机台设备名称（如 1#全自动高速冷镦机） */
  equipmentName?: string;
  /** 牙纹/螺纹规格（滚丝检验专有，如 M6*25 6g） */
  threadSpec?: string;
  /** 终检班组（成品检专有，如 终检一组） */
  inspectionTeam?: string;
  /** 工序阶段：自动断料 / 手工滚牙 / 检测入库 */
  processStep?: string;
  /** 该工序报工/报检登记时间（台账「完成时间」列，ISO8601） */
  completedAt?: string;
  // 008 出货检验 (OQC) 销售出库关联字段：仅出货检验 (OQC_SH) 工单需要填写
  /** 销售出库单号，如 SO-20231012-01 */
  salesOrderNo?: string;
  /** 出库日期，如 2023-10-12 */
  dispatchDate?: string;
  /** 客户名称（快照自客户主数据，便于出库单直接展示） */
  customerName?: string;
  /** 客户采购订单号/合同号，如 PO-20231012-01 */
  salesOrderPoNo?: string;
  /** ERP 出库单审核状态：待审核 / 已审核 / 已拦截 */
  erpStatus?: string;
  /** 检验人姓名（冗余自员工主数据，出货台账需直接展示） */
  inspectorName?: string;
  // 009 委外检验 (OQC 七分类: 表面处理/机加工/热处理) 台账字段
  /** ERP 委外加工单号，如 WWJG-20260706-010（号段对齐 ERP DlyndxSC VchType=181，见 docs/34 §2.1） */
  outsourceNo?: string;
  /** 加工类型/工艺分类：镀锌 / 镀镍 / 发黑 / 磷化 / 达克罗 / 热处理 / 机加工 */
  processType?: string;
  /** 委外件回厂登记日期，如 2026-07-06 */
  returnDate?: string;
  /** 加工商名称快照，如 苏州机加工厂 */
  vendorName?: string;
}

export const seedOrders: SeedOrderSpec[] = [
  {
    // 来料不合格：被 MRB-20231011-01（DISPOSED + CONCESSION）引用
    id: '30000000-0000-4000-8000-000000000001',
    orderNo: 'INS-20231011-0001',
    orderType: 'IQC',
    planCode: 'QP-IQC-35CRMO',
    versionNo: 'v1.0',
    batchNo: 'B20231011-92',
    materialCode: 'MAT-35CRMO-08',
    supplierCode: 'SUP-002',
    inboundNo: 'RK-20231011-001',
    inboundDate: '2023-10-11',
    inspectorId: EMPLOYEE_IDS.chenJing,
    totalQty: 15000,
    sampleQty: 32,
    status: 'FAILED',
    judgment: 'FAILED',
    isMandatoryGate: false,
    inspectionNotes: '母材表面存在沿轧制方向裂纹，判不合格并转 MRB 评审',
    snapshotAt: '2023-10-11T08:00:00.000Z',
    itemKind: 'HAS_FAILED',
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    orderNo: 'INS-20231012-0001',
    orderType: 'IQC',
    planCode: 'QP-IQC-304SS',
    versionNo: 'v2.4',
    batchNo: 'B20231012-01',
    materialCode: 'MAT-304SS-05',
    supplierCode: 'SUP-001',
    inboundNo: 'RK-20231012-001',
    inboundDate: '2023-10-12',
    inspectorId: EMPLOYEE_IDS.chenJing,
    totalQty: 5000,
    sampleQty: 50,
    status: 'COMPLETED',
    judgment: 'PASSED',
    isMandatoryGate: false,
    inspectionNotes: '原材料常规抽样检验，尺寸与力学指标均合格',
    snapshotAt: '2023-10-12T08:00:00.000Z',
    itemKind: 'ALL_PASSED',
  },
  {
    // 下料工序不合格：前端 Mock 拦截事件的批次
    id: '30000000-0000-4000-8000-000000000003',
    orderNo: 'INS-20231012-0002',
    orderType: 'IPQC_CT',
    workOrderNo: 'WO-20231012-01',
    // 下料工序台账列（docs/29 §2）：断料长度 25.15mm 与「切断长度 25.00±0.10」方案项同源
    blankingLength: 25.15,
    operatorName: '陈操作',
    operatorId: 'OP-0102',
    equipmentCode: 'EQ-CT-01',
    equipmentName: '1#全自动高速冷镦机',
    processStep: '自动断料',
    completedAt: '2023-10-12T09:30:00.000Z',
    planCode: 'QP-IPQC-CUT',
    versionNo: 'v1.1',
    batchNo: 'B20231012-02',
    materialCode: 'MAT-SCR-M6-25',
    inspectorId: EMPLOYEE_IDS.wangJianGuo,
    totalQty: 30000,
    sampleQty: 32,
    status: 'FAILED',
    judgment: 'FAILED',
    isMandatoryGate: false,
    inspectionNotes: '下料毛刺严重超标，端面倾斜 >0.5°，触发 MRB 会签',
    snapshotAt: '2023-10-12T09:00:00.000Z',
    itemKind: 'HAS_FAILED',
  },
  {
    // 成品检强制关卡：MRB 会签评审中
    id: '30000000-0000-4000-8000-000000000004',
    orderNo: 'INS-20231012-0003',
    orderType: 'IPQC_FN',
    workOrderNo: 'WO-20231012-01',
    // 成品检台账列（docs/29 §2）：终检班组 + 检测入库工序
    inspectionTeam: '终检一组',
    processStep: '检测入库',
    completedAt: '2023-10-12T11:00:00.000Z',
    planCode: 'QP-FQC-AUTO',
    versionNo: 'v3.0',
    batchNo: 'B20231012-03',
    materialCode: 'MAT-BLT-109-M10',
    customerCode: 'CUST-002',
    inspectorId: EMPLOYEE_IDS.liuFang,
    totalQty: 60000,
    sampleQty: 80,
    status: 'IN_MRB_REVIEW',
    judgment: 'FAILED',
    isMandatoryGate: true,
    inspectionNotes: '成品检 mandatoryGate=true，抽检 1 件螺纹中径超差，触发 MRB 会签阻断',
    snapshotAt: '2023-10-12T10:30:00.000Z',
    itemKind: 'HAS_FAILED',
  },
  {
    id: '30000000-0000-4000-8000-000000000005',
    orderNo: 'INS-20231012-0004',
    orderType: 'IPQC_RL',
    workOrderNo: 'WO-20231012-01',
    // 滚丝工序台账列（docs/29 §2）：螺纹规格 + 滚丝机台
    threadSpec: 'M6*25 6g',
    operatorName: '刘滚丝',
    operatorId: 'OP-0205',
    equipmentCode: 'EQ-RL-02',
    equipmentName: '2#精密数控滚丝机',
    processStep: '手工滚牙',
    completedAt: '2023-10-12T10:30:00.000Z',
    planCode: 'QP-IPQC-RL',
    versionNo: 'v1.0',
    batchNo: 'B20231012-04',
    materialCode: 'MAT-THRD-M6-25',
    inspectorId: EMPLOYEE_IDS.zhaoZhiMing,
    totalQty: 26000,
    sampleQty: 32,
    status: 'INSPECTING',
    judgment: null,
    isMandatoryGate: false,
    inspectionNotes: '滚丝工序巡检录入中',
    snapshotAt: '2023-10-12T13:00:00.000Z',
    itemKind: 'PENDING',
  },
  {
    // 委外表处回厂检验（强制关卡）
    id: '30000000-0000-4000-8000-000000000006',
    orderNo: 'OQC-SF-20231012-0001',
    orderType: 'OQC_SF',
    planCode: 'QP-OQC-SF',
    versionNo: 'v2.0',
    batchNo: 'B20231010-03',
    materialCode: 'MAT-BLT-109-M10',
    supplierCode: 'SUP-004',
    // 009 委外检验台账字段：本行在 ERP 侧没有可对账的委外加工单，outsource_no 刻意留空——
    // 读路径**不回落批次号**（`batch_no B20231010-03` 不是委外加工单号），界面按定稿口径显示 `-`；
    // 其余三列（加工类型 / 加工商 / 回厂日期）显式落库，退回假数据同样被禁止。见 docs/32 §2。
    processType: '镀锌',
    vendorName: '恒信表面处理厂',
    returnDate: '2023-10-12',
    inspectorId: EMPLOYEE_IDS.zhouHaiBo,
    totalQty: 42000,
    sampleQty: 20,
    status: 'PASSED',
    judgment: 'PASSED',
    isMandatoryGate: true,
    inspectionNotes: '委外蓝白锌电镀回厂，膜厚与硬度合格',
    snapshotAt: '2023-10-12T14:00:00.000Z',
    itemKind: 'ALL_PASSED',
  },
  {
    id: '30000000-0000-4000-8000-000000000007',
    orderNo: 'OQC-SH-20231012-0001',
    orderType: 'OQC_SH',
    planCode: 'QP-OQC-SH',
    versionNo: 'v1.2',
    batchNo: 'B20231012-06',
    materialCode: 'MAT-BLT-109-M10',
    customerCode: 'CUST-001',
    inspectorId: EMPLOYEE_IDS.liuFang,
    salesOrderNo: 'SO-20231012-01',
    dispatchDate: '2023-10-12',
    customerName: '上海通用汽车零部件采购部',
    salesOrderPoNo: 'PO-20231012-01',
    erpStatus: '已审核',
    inspectorName: '刘芳',
    totalQty: 42000,
    sampleQty: 200,
    status: 'COMPLETED',
    judgment: 'PASSED',
    isMandatoryGate: true,
    inspectionNotes: '出货检验合格，客户放行归档',
    snapshotAt: '2023-10-12T15:00:00.000Z',
    itemKind: 'ALL_PASSED',
  },
  {
    id: '30000000-0000-4000-8000-000000000008',
    orderNo: 'INS-20231013-0001',
    orderType: 'IQC',
    planCode: 'QP-IQC-304SS',
    versionNo: 'v2.4',
    batchNo: 'B20231013-01',
    materialCode: 'MAT-304SS-05',
    supplierCode: 'SUP-001',
    inboundNo: 'RK-20231013-001',
    inboundDate: '2023-10-13',
    inspectorId: EMPLOYEE_IDS.chenJing,
    totalQty: 5000,
    sampleQty: 50,
    status: 'PENDING',
    judgment: null,
    isMandatoryGate: false,
    inspectionNotes: '待检验：供应商新批次到货',
    snapshotAt: '2023-10-13T08:00:00.000Z',
    itemKind: 'PENDING',
  },
  {
    id: '30000000-0000-4000-8000-000000000009',
    orderNo: 'INS-20231013-0002',
    orderType: 'IPQC_CT',
    workOrderNo: 'WO-20231013-01',
    // 下料工序台账列（docs/29 §2）：待复核草稿单，工序报工时间已登记
    blankingLength: 25.15,
    operatorName: '陈操作',
    operatorId: 'OP-0102',
    equipmentCode: 'EQ-CT-01',
    equipmentName: '1#全自动高速冷镦机',
    processStep: '自动断料',
    completedAt: '2023-10-13T09:05:00.000Z',
    planCode: 'QP-IPQC-CUT',
    versionNo: 'v1.1',
    batchNo: 'B20231013-02',
    materialCode: 'MAT-SCR-M6-25',
    inspectorId: EMPLOYEE_IDS.wangJianGuo,
    totalQty: 30000,
    sampleQty: 32,
    status: 'DRAFT',
    judgment: null,
    isMandatoryGate: false,
    inspectionNotes: '草稿暂存：下料首检数据待复核',
    snapshotAt: '2023-10-13T09:00:00.000Z',
    itemKind: 'PENDING',
  },
  {
    id: '30000000-0000-4000-8000-000000000010',
    orderNo: 'INS-20231013-0003',
    orderType: 'IPQC_FN',
    workOrderNo: 'WO-20231013-01',
    // 成品检台账列（docs/29 §2）：复检轮次的终检组与工序阶段
    inspectionTeam: '终检一组',
    processStep: '检测入库',
    completedAt: '2023-10-13T10:15:00.000Z',
    planCode: 'QP-FQC-AUTO',
    versionNo: 'v3.0',
    batchNo: 'B20231013-03',
    materialCode: 'MAT-BLT-109-M10',
    customerCode: 'CUST-003',
    inspectorId: EMPLOYEE_IDS.liuFang,
    totalQty: 60000,
    sampleQty: 80,
    status: 'RE_INSPECTING',
    judgment: null,
    isMandatoryGate: true,
    inspectionNotes: '返工后重新检验轮次，等待重新录入实测值',
    snapshotAt: '2023-10-13T10:00:00.000Z',
    itemKind: 'PENDING',
  },
  {
    // 终判让步接收（CONCESSION）
    id: '30000000-0000-4000-8000-000000000011',
    orderNo: 'OQC-SH-20231013-0001',
    orderType: 'OQC_SH',
    planCode: 'QP-OQC-SH',
    versionNo: 'v1.2',
    batchNo: 'B20231013-04',
    materialCode: 'MAT-BLT-109-M10',
    customerCode: 'CUST-003',
    inspectorId: EMPLOYEE_IDS.liuFang,
    salesOrderNo: 'SO-20231013-04',
    dispatchDate: '2023-10-13',
    customerName: '金风科技风电紧固件集采中心',
    salesOrderPoNo: 'PO-20231013-04',
    erpStatus: '已审核',
    inspectorName: '刘芳',
    totalQty: 42000,
    sampleQty: 200,
    status: 'COMPLETED',
    judgment: 'CONCESSION',
    isMandatoryGate: true,
    inspectionNotes: '包装重量轻微超差，客户签署特采让步接收协议后放行',
    snapshotAt: '2023-10-13T11:00:00.000Z',
    itemKind: 'CONCESSION',
  },
  {
    id: '30000000-0000-4000-8000-000000000012',
    orderNo: 'OQC-SF-20231013-0001',
    orderType: 'OQC_SF',
    planCode: 'QP-OQC-SF',
    versionNo: 'v2.0',
    batchNo: 'B20231013-05',
    materialCode: 'MAT-35CRMO-08',
    supplierCode: 'SUP-004',
    // 009 委外检验台账字段：同上（outsource_no 留空 → 界面 `-`，不回落批次号），
    // 口径与 011 迁移的供应商主数据回填保持一致，见 docs/32 §2。
    processType: '热处理',
    vendorName: '恒信表面处理厂',
    returnDate: '2023-10-13',
    inspectorId: EMPLOYEE_IDS.zhouHaiBo,
    totalQty: 15000,
    sampleQty: 20,
    status: 'PENDING',
    judgment: null,
    isMandatoryGate: true,
    inspectionNotes: '委外热处理回厂，待检验',
    snapshotAt: '2023-10-13T12:00:00.000Z',
    itemKind: 'PENDING',
  },
  {
    // 终判不合格但已归档：MRB-20231013-02（DISPOSED + CONCESSION）引用它，放行关卡可通过
    id: '30000000-0000-4000-8000-000000000013',
    orderNo: 'OQC-SH-20231013-0002',
    orderType: 'OQC_SH',
    planCode: 'QP-OQC-SH',
    versionNo: 'v1.2',
    batchNo: 'B20231013-06',
    materialCode: 'MAT-BLT-109-M10',
    customerCode: 'CUST-003',
    inspectorId: EMPLOYEE_IDS.liuFang,
    salesOrderNo: 'SO-20231013-06',
    dispatchDate: '2023-10-13',
    customerName: '金风科技风电紧固件集采中心',
    salesOrderPoNo: 'PO-20231013-06',
    erpStatus: '已拦截',
    inspectorName: '刘芳',
    totalQty: 42000,
    sampleQty: 200,
    status: 'COMPLETED',
    judgment: 'FAILED',
    isMandatoryGate: true,
    inspectionNotes: '出货抽检发现通规不止，经 MRB 让步接收决议后归档',
    snapshotAt: '2023-10-13T13:00:00.000Z',
    itemKind: 'HAS_FAILED',
  },
  // ------------------------------------------------------------------
  // 009 委外检验 - 机加工检验台账 (OQC_MACH)
  // ------------------------------------------------------------------
  // 009 委外检验 - 表面处理检验台账 (OQC_SF)
  {
    id: '30000000-0000-4000-8000-000000000025',
    orderNo: 'OQC-SF-20260706-0001',
    orderType: 'OQC_SF',
    planCode: 'QP-OQC-SF',
    versionNo: 'v2.0',
    batchNo: 'B20260706-001',
    outsourceNo: 'WWJG-20260706-001',
    processType: '镀锌',
    returnDate: '2026-07-06',
    materialCode: 'MAT-BLT-109-M10',
    supplierCode: 'SUP-004',
    vendorName: '东莞表面处理厂',
    inspectorId: EMPLOYEE_IDS.zhouHaiBo,
    totalQty: 500,
    sampleQty: 500,
    status: 'PENDING',
    judgment: null,
    isMandatoryGate: true,
    inspectionNotes: '委外表面处理（镀锌）回厂待检验',
    snapshotAt: '2026-07-06T08:00:00.000Z',
    itemKind: 'PENDING',
  },
  {
    id: '30000000-0000-4000-8000-000000000026',
    orderNo: 'OQC-SF-20260705-0008',
    orderType: 'OQC_SF',
    planCode: 'QP-OQC-SF',
    versionNo: 'v2.0',
    batchNo: 'B20260705-008',
    outsourceNo: 'WWJG-20260705-008',
    processType: '镀镍',
    returnDate: '2026-07-05',
    materialCode: 'MAT-BLT-88-M12',
    supplierCode: 'SUP-004',
    vendorName: '深圳电镀厂',
    inspectorId: EMPLOYEE_IDS.zhouHaiBo,
    inspectorName: '张检验',
    totalQty: 300,
    sampleQty: 300,
    status: 'PASSED',
    judgment: 'PASSED',
    isMandatoryGate: true,
    inspectionNotes: '委外表面处理（镀镍）回厂检验合格',
    snapshotAt: '2026-07-05T08:00:00.000Z',
    itemKind: 'ALL_PASSED',
  },
  {
    id: '30000000-0000-4000-8000-000000000027',
    orderNo: 'OQC-SF-20260705-0007',
    orderType: 'OQC_SF',
    planCode: 'QP-OQC-SF',
    versionNo: 'v2.0',
    batchNo: 'B20260705-007',
    outsourceNo: 'WWJG-20260705-007',
    processType: '发黑',
    returnDate: '2026-07-05',
    materialCode: 'MAT-NUT-10-M10',
    supplierCode: 'SUP-004',
    vendorName: '广州发黑厂',
    inspectorId: EMPLOYEE_IDS.zhouHaiBo,
    inspectorName: '李检验',
    totalQty: 200,
    sampleQty: 200,
    status: 'FAILED',
    judgment: 'FAILED',
    isMandatoryGate: true,
    inspectionNotes: '委外表面处理（发黑）膜厚不合格，转 MRB 评审',
    snapshotAt: '2026-07-05T08:00:00.000Z',
    itemKind: 'HAS_FAILED',
  },
  // ------------------------------------------------------------------
  // 009 委外检验 - 机加工检验台账 (OQC_MACH)
  {
    id: '30000000-0000-4000-8000-000000000021',
    orderNo: 'OQC-MC-20260706-0001',
    orderType: 'OQC_MACH',
    planCode: 'QP-OQC-SF',
    versionNo: 'v2.0',
    batchNo: 'B20260706-010',
    outsourceNo: 'WWJG-20260706-010',
    processType: '机加工',
    returnDate: '2026-07-06',
    materialCode: 'MAT-SLV-45-20-30',
    supplierCode: 'SUP-006',
    vendorName: '苏州机加工厂',
    inspectorId: EMPLOYEE_IDS.wangJianGuo,
    totalQty: 100,
    sampleQty: 100,
    status: 'PENDING',
    judgment: null,
    isMandatoryGate: false,
    inspectionNotes: '委外机加工（精密轴套）回厂待检验',
    snapshotAt: '2026-07-06T08:00:00.000Z',
    itemKind: 'PENDING',
  },
  {
    id: '30000000-0000-4000-8000-000000000022',
    orderNo: 'OQC-MC-20260705-0005',
    orderType: 'OQC_MACH',
    planCode: 'QP-OQC-SF',
    versionNo: 'v2.0',
    batchNo: 'B20260705-005',
    outsourceNo: 'WWJG-20260705-005',
    processType: '机加工',
    returnDate: '2026-07-05',
    materialCode: 'MAT-CON-M12',
    supplierCode: 'SUP-006',
    vendorName: '昆山加工中心',
    inspectorId: EMPLOYEE_IDS.wangJianGuo,
    inspectorName: '王检验',
    totalQty: 200,
    sampleQty: 200,
    status: 'PASSED',
    judgment: 'PASSED',
    isMandatoryGate: false,
    inspectionNotes: '委外机加工（连接件）回厂检验合格',
    snapshotAt: '2026-07-05T08:00:00.000Z',
    itemKind: 'ALL_PASSED',
  },
  // ------------------------------------------------------------------
  // 009 委外检验 - 热处理检验台账 (OQC_HEAT)
  // ------------------------------------------------------------------
  {
    id: '30000000-0000-4000-8000-000000000023',
    orderNo: 'OQC-HT-20260706-0001',
    orderType: 'OQC_HEAT',
    planCode: 'QP-OQC-SF',
    versionNo: 'v2.0',
    batchNo: 'B20260706-015',
    outsourceNo: 'WWJG-20260706-015',
    processType: '热处理',
    returnDate: '2026-07-06',
    materialCode: 'MAT-BLT-109-M10-HT',
    supplierCode: 'SUP-007',
    vendorName: '上海热处理厂',
    inspectorId: EMPLOYEE_IDS.zhangQiang,
    inspectorName: '张检验',
    totalQty: 500,
    sampleQty: 500,
    status: 'INSPECTING',
    judgment: null,
    isMandatoryGate: false,
    inspectionNotes: '委外热处理（高强度螺栓）回厂检验录入中',
    snapshotAt: '2026-07-06T08:00:00.000Z',
    itemKind: 'PENDING',
  },
  {
    id: '30000000-0000-4000-8000-000000000024',
    orderNo: 'OQC-HT-20260705-0003',
    orderType: 'OQC_HEAT',
    planCode: 'QP-OQC-SF',
    versionNo: 'v2.0',
    batchNo: 'B20260705-013',
    outsourceNo: 'WWJG-20260705-013',
    processType: '热处理',
    returnDate: '2026-07-05',
    materialCode: 'MAT-WSH-SPR-M10',
    supplierCode: 'SUP-007',
    vendorName: '无锡热处理',
    inspectorId: EMPLOYEE_IDS.liWei,
    inspectorName: '李检验',
    totalQty: 1000,
    sampleQty: 1000,
    status: 'PASSED',
    judgment: 'PASSED',
    isMandatoryGate: false,
    inspectionNotes: '委外热处理（弹簧垫圈）回厂检验合格',
    snapshotAt: '2026-07-05T08:00:00.000Z',
    itemKind: 'ALL_PASSED',
  },
  // ------------------------------------------------------------------
  // 008 出货检验 (OQC_SH) 销售出库放行台账
  // 与 WPS 图片(9) 出货检验原型逐列一致的 4 条记录（检验编号 / 销售出库单号 / 出库日期 /
  // 客户 / 订单号 / 成品编码 / 成品名称 / 数量 / ERP状态 / 检验状态 / 检验人 / 操作）
  // 注意：列表按 created_at DESC 排序，种子行 created_at 同为播种时刻，
  // 因此此处按原型展示顺序的「逆序」写入，读出来的顺序才与原型一致。
  // ------------------------------------------------------------------

  {
    id: '30000000-0000-4000-8000-000000000031',
    orderNo: 'OQC-SH-20260705-0007',
    orderType: 'OQC_SH',
    planCode: 'QP-OQC-SH',
    versionNo: 'v1.2',
    batchNo: 'LOT-20260705-0007',
    materialCode: 'MAT-BLT-FLG-M8',
    inspectorId: EMPLOYEE_IDS.wangJianGuo,
    inspectorName: '王检验',
    salesOrderNo: 'SO-20260705-07',
    dispatchDate: '2026-07-05',
    customerName: '客户D工业',
    salesOrderPoNo: 'PO-D-004',
    erpStatus: '已拦截',
    totalQty: 2000,
    sampleQty: 2000,
    status: 'COMPLETED',
    judgment: 'FAILED',
    isMandatoryGate: true,
    inspectionNotes: '销售出库单 SO-20260705-07 出货抽检不合格，ERP 已拦截出库',
    snapshotAt: '2026-07-05T16:00:00.000Z',
    itemKind: 'HAS_FAILED',
  },
  {
    id: '30000000-0000-4000-8000-000000000030',
    orderNo: 'OQC-SH-20260705-0008',
    orderType: 'OQC_SH',
    planCode: 'QP-OQC-SH',
    versionNo: 'v1.2',
    batchNo: 'LOT-20260705-0008',
    materialCode: 'MAT-BLT-88-M10',
    inspectorId: EMPLOYEE_IDS.liWei,
    inspectorName: '李检验',
    salesOrderNo: 'SO-20260705-08',
    dispatchDate: '2026-07-05',
    customerName: '客户C集团',
    salesOrderPoNo: 'PO-C-003',
    erpStatus: '已审核',
    totalQty: 8000,
    sampleQty: 8000,
    status: 'COMPLETED',
    judgment: 'PASSED',
    isMandatoryGate: true,
    inspectionNotes: '销售出库单 SO-20260705-08 出货检验合格，已放行归档',
    snapshotAt: '2026-07-05T15:00:00.000Z',
    itemKind: 'ALL_PASSED',
  },
  {
    id: '30000000-0000-4000-8000-000000000029',
    orderNo: 'OQC-SH-20260706-0002',
    orderType: 'OQC_SH',
    planCode: 'QP-OQC-SH',
    versionNo: 'v1.2',
    batchNo: 'LOT-20260706-0002',
    materialCode: 'MAT-BLT-88-M12-40',
    inspectorId: EMPLOYEE_IDS.zhangQiang,
    inspectorName: '张检验',
    salesOrderNo: 'SO-20260706-02',
    dispatchDate: '2026-07-06',
    customerName: '客户B制造',
    salesOrderPoNo: 'PO-B-002',
    erpStatus: '待审核',
    totalQty: 3000,
    sampleQty: 3000,
    status: 'INSPECTING',
    judgment: null,
    isMandatoryGate: true,
    inspectionNotes: '销售出库单 SO-20260706-02 检验录入中',
    snapshotAt: '2026-07-06T09:00:00.000Z',
    itemKind: 'PENDING',
  },
  {
    id: '30000000-0000-4000-8000-000000000028',
    orderNo: 'OQC-SH-20260706-0001',
    orderType: 'OQC_SH',
    planCode: 'QP-OQC-SH',
    versionNo: 'v1.2',
    batchNo: 'LOT-20260706-0001',
    materialCode: 'MAT-BLT-88-M10',
    inspectorId: EMPLOYEE_IDS.liuFang,
    salesOrderNo: 'SO-20260706-01',
    dispatchDate: '2026-07-06',
    customerName: '客户A科技',
    salesOrderPoNo: 'PO-A-001',
    erpStatus: '待审核',
    totalQty: 5000,
    sampleQty: 5000,
    status: 'PENDING',
    judgment: null,
    isMandatoryGate: true,
    inspectionNotes: '销售出库单 SO-20260706-01 待检验，ERP 出库单尚待审核',
    snapshotAt: '2026-07-06T08:00:00.000Z',
    itemKind: 'PENDING',
  },
];

// ============================================================================
// 6. 可配置评审流程（4 类不合格来源各一条 ACTIVE 流程，每条 3 个节点）
// ============================================================================

export const seedReviewFlows: ReviewFlow[] = [
  {
    id: '50000000-0000-4000-8000-000000000001',
    flowCode: 'FLOW-IQC-FAIL',
    flowName: '来料检验不合格多方会签流程',
    description: '来料检验判定不合格后的多方会签、退货与让步接收裁决流转',
    applicableType: 'INCOMING_FAIL',
    version: 'v1.0.0',
    isActive: true,
    nodes: [
      { nodeLevel: 1, nodeName: '来料检验员初判', roleCode: '检验员', roleName: 'IQC 检验员', isRequired: true, allowConcession: false, requireCustomerSign: false },
      { nodeLevel: 2, nodeName: '质量工程师技术评审', roleCode: '质量工程师', roleName: '质量工程师', isRequired: true, allowConcession: false, requireCustomerSign: false },
      { nodeLevel: 3, nodeName: '质量经理终审裁决', roleCode: '质量经理', roleName: '质量主管 / 经理', isRequired: true, allowConcession: true, requireCustomerSign: false },
    ],
  },
  {
    id: '50000000-0000-4000-8000-000000000002',
    flowCode: 'FLOW-PROCESS-FAIL',
    flowName: '过程不合格评审与返工确认流程',
    description: '车间在制加工不合格的返工方案评审与复检轮次确认',
    applicableType: 'PROCESS_FAIL',
    version: 'v1.0.0',
    isActive: true,
    nodes: [
      { nodeLevel: 1, nodeName: '过程检验员初判', roleCode: '检验员', roleName: 'IPQC 检验员', isRequired: true, allowConcession: false, requireCustomerSign: false },
      { nodeLevel: 2, nodeName: '工艺工程师返工方案评审', roleCode: '工艺工程师', roleName: '工艺工程师', isRequired: true, allowConcession: false, requireCustomerSign: false },
      { nodeLevel: 3, nodeName: '质量经理终审裁决', roleCode: '质量经理', roleName: '质量主管 / 经理', isRequired: true, allowConcession: true, requireCustomerSign: false },
    ],
  },
  {
    id: '50000000-0000-4000-8000-000000000003',
    flowCode: 'FLOW-SHIPMENT-FAIL',
    flowName: '出货不合格与客户让步接收签核流程',
    description: '出货成品不合格的让步接收评估与客户代表书面签核闸门',
    applicableType: 'SHIPMENT_FAIL',
    version: 'v1.0.0',
    isActive: true,
    nodes: [
      { nodeLevel: 1, nodeName: '出货检验员初判', roleCode: '检验员', roleName: 'OQC 检验员', isRequired: true, allowConcession: false, requireCustomerSign: false },
      { nodeLevel: 2, nodeName: '质量经理让步评估', roleCode: '质量经理', roleName: '质量主管 / 经理', isRequired: true, allowConcession: true, requireCustomerSign: false },
      { nodeLevel: 3, nodeName: '客户代表书面签核', roleCode: '客户代表', roleName: '客户代表 / 销售', isRequired: true, allowConcession: true, requireCustomerSign: true },
    ],
  },
  {
    id: '50000000-0000-4000-8000-000000000004',
    flowCode: 'FLOW-SUBCONTRACT-FAIL',
    flowName: '委外加工不合格评审与供应商索赔流程',
    description: '委外加工不合格的责任认定、返工与供应商索赔裁决',
    applicableType: 'SUBCONTRACT_FAIL',
    version: 'v1.0.0',
    isActive: true,
    nodes: [
      { nodeLevel: 1, nodeName: '委外检验员初判', roleCode: '检验员', roleName: '委外检验员', isRequired: true, allowConcession: false, requireCustomerSign: false },
      {
        nodeLevel: 2,
        nodeName: '供应商质量工程师责任认定',
        roleCode: '供应商质量工程师',
        roleName: '供应商质量工程师 (SQE)',
        isRequired: true,
        allowConcession: false,
        requireCustomerSign: false,
      },
      { nodeLevel: 3, nodeName: '质量经理终审裁决', roleCode: '质量经理', roleName: '质量主管 / 经理', isRequired: true, allowConcession: true, requireCustomerSign: false },
    ],
  },
];

// ============================================================================
// 7. MRB 评审单（覆盖 4 个状态；source_order_no 必须命中已播种工单号）
// ============================================================================

export const seedMrbReviews: MRBReview[] = [
  {
    // DISPOSED + CONCESSION：引用 FAILED 工单 INS-20231011-0001
    id: '40000000-0000-4000-8000-000000000001',
    mrbNo: 'MRB-20231011-01',
    urgencyLevel: 'URGENT',
    sourceType: 'INCOMING_FAIL',
    sourceOrderNo: 'INS-20231011-0001',
    batchNo: 'B20231011-92',
    materialCode: 'MAT-35CRMO-08',
    materialName: '35CrMo 合金圆钢 Φ8.0mm',
    defectDescription: '表面存在沿轧制方向裂纹，深度达 0.35mm，存在断裂风险',
    defectQty: 15000,
    status: 'DISPOSED',
    disposition: 'CONCESSION',
    dispositionNotes: '经工程评估降级用于非承载件，客户已签署特采让步接收协议',
    approvers: [
      {
        userId: EMPLOYEE_IDS.zhangQiang,
        userName: '张强',
        roleCode: '质量经理',
        action: 'APPROVED',
        comment: '同意降级让步接收，附客户签字特采单',
        signedAt: '2023-10-11T14:00:00.000Z',
      },
      {
        userId: EMPLOYEE_IDS.liWei,
        userName: '李伟',
        roleCode: '工艺工程师',
        action: 'APPROVED',
        comment: '非承载部位使用不影响总装强度',
        signedAt: '2023-10-11T15:20:00.000Z',
      },
    ],
    concessionAttachmentUrl: 'https://qms.letian.com/docs/concession/CONC-20231011-01.pdf',
    createdAt: '2023-10-11T13:30:00.000Z',
    updatedAt: '2023-10-11T16:00:00.000Z',
  },
  {
    id: '40000000-0000-4000-8000-000000000002',
    mrbNo: 'MRB-20231012-01',
    urgencyLevel: 'NORMAL',
    sourceType: 'PROCESS_FAIL',
    sourceOrderNo: 'INS-20231012-0002',
    batchNo: 'B20231012-02',
    materialCode: 'MAT-SCR-M6-25',
    materialName: '高强度螺柱 M6*25 (冷镦毛坯)',
    defectDescription: '切断毛刺高度 0.18mm（允许值 ≤0.05mm），下料长度 25.42mm 超差',
    defectQty: 3000,
    status: 'UNDER_REVIEW',
    approvers: [
      {
        userId: EMPLOYEE_IDS.zhangQiang,
        userName: '张强',
        roleCode: '质量经理',
        action: 'APPROVED',
        comment: '同意转二车间平头倒角返工处理',
        signedAt: '2023-10-12T10:15:00.000Z',
      },
      {
        userId: EMPLOYEE_IDS.liWei,
        userName: '李伟',
        roleCode: '工艺工程师',
        action: 'APPROVED',
        comment: '评估返工后尺寸公差可恢复受控范围',
        signedAt: '2023-10-12T10:30:00.000Z',
      },
    ],
    createdAt: '2023-10-12T09:40:00.000Z',
    updatedAt: '2023-10-12T10:30:00.000Z',
  },
  {
    id: '40000000-0000-4000-8000-000000000003',
    mrbNo: 'MRB-20231012-02',
    urgencyLevel: 'NORMAL',
    sourceType: 'SHIPMENT_FAIL',
    sourceOrderNo: 'INS-20231012-0003',
    batchNo: 'B20231012-03',
    materialCode: 'MAT-BLT-109-M10',
    materialName: '10.9级六角头螺栓 M10*45 (成品)',
    defectDescription: '螺栓螺纹中径偏大 0.042mm，可能影响装配拧入扭矩',
    defectQty: 10000,
    status: 'PENDING_REVIEW',
    approvers: [
      {
        userId: EMPLOYEE_IDS.liuFang,
        userName: '刘芳',
        roleCode: '检验员',
        action: 'APPROVED',
        comment: '已完成不合格品隔离标识，提请 MRB 评审',
        signedAt: '2023-10-12T11:20:00.000Z',
      },
      {
        userId: EMPLOYEE_IDS.zhangQiang,
        userName: '张强',
        roleCode: '质量经理',
        action: 'APPROVED',
        comment: '同意立案评审，等待客户装配验证结果',
        signedAt: '2023-10-12T11:35:00.000Z',
      },
    ],
    createdAt: '2023-10-12T11:20:00.000Z',
    updatedAt: '2023-10-12T11:35:00.000Z',
  },
  {
    id: '40000000-0000-4000-8000-000000000004',
    mrbNo: 'MRB-20231013-01',
    urgencyLevel: 'NORMAL',
    sourceType: 'SUBCONTRACT_FAIL',
    sourceOrderNo: 'OQC-SF-20231013-0001',
    batchNo: 'B20231013-05',
    materialCode: 'MAT-35CRMO-08',
    materialName: '35CrMo 合金圆钢 Φ8.0mm',
    defectDescription: '委外热处理后表面脱碳层深度 0.25mm，超出 0.10mm 上限',
    defectQty: 800,
    status: 'REJECTED',
    dispositionNotes: '供方拒绝承担返工费用，评审被驳回并转供应商质量索赔流程',
    approvers: [
      {
        userId: EMPLOYEE_IDS.zhouHaiBo,
        userName: '周海波',
        roleCode: '供应商质量工程师',
        action: 'APPROVED',
        comment: '确认脱碳层超标属实，建议索赔',
        signedAt: '2023-10-13T09:30:00.000Z',
      },
      {
        userId: EMPLOYEE_IDS.zhangQiang,
        userName: '张强',
        roleCode: '质量经理',
        action: 'REJECTED',
        comment: '处置方案缺少供方书面确认，本次评审驳回',
        signedAt: '2023-10-13T10:10:00.000Z',
      },
    ],
    createdAt: '2023-10-13T09:00:00.000Z',
    updatedAt: '2023-10-13T10:10:00.000Z',
  },
  {
    // DISPOSED + CONCESSION：引用 COMPLETED + FAILED 工单，放行关卡可放行
    id: '40000000-0000-4000-8000-000000000005',
    mrbNo: 'MRB-20231013-02',
    urgencyLevel: 'CRITICAL',
    sourceType: 'SHIPMENT_FAIL',
    sourceOrderNo: 'OQC-SH-20231013-0002',
    batchNo: 'B20231013-06',
    materialCode: 'MAT-BLT-109-M10',
    materialName: '10.9级六角头螺栓 M10*45 (成品)',
    defectDescription: '出货抽检发现螺纹通规不止，通规通过率 99.0%',
    defectQty: 5000,
    status: 'DISPOSED',
    disposition: 'CONCESSION',
    dispositionNotes: '客户现场试装合格并签署让步接收协议，质保部会签放行',
    approvers: [
      {
        userId: EMPLOYEE_IDS.zhangQiang,
        userName: '张强',
        roleCode: '质量经理',
        action: 'APPROVED',
        comment: '建议特采让步接收，附客户签字特采单',
        signedAt: '2023-10-13T14:00:00.000Z',
      },
      {
        userId: EMPLOYEE_IDS.liuFang,
        userName: '刘芳',
        roleCode: '检验员',
        action: 'APPROVED',
        comment: '已核对不合格品数量与隔离记录',
        signedAt: '2023-10-13T14:20:00.000Z',
      },
    ],
    concessionAttachmentUrl: 'https://qms.letian.com/docs/concession/CONC-20231013-02.pdf',
    createdAt: '2023-10-13T13:30:00.000Z',
    updatedAt: '2023-10-13T14:30:00.000Z',
  },
  {
    id: '40000000-0000-4000-8000-000000000006',
    mrbNo: 'MRB-20231013-03',
    urgencyLevel: 'NORMAL',
    sourceType: 'INCOMING_FAIL',
    sourceOrderNo: 'INS-20231013-0001',
    batchNo: 'B20231013-01',
    materialCode: 'MAT-304SS-05',
    materialName: '不锈钢线材 Φ5.0mm',
    defectDescription: '来料盘条表面存在划伤，深度约 0.15mm，待评审确认是否让步',
    defectQty: 1200,
    status: 'UNDER_REVIEW',
    approvers: [
      {
        userId: EMPLOYEE_IDS.chenJing,
        userName: '陈静',
        roleCode: '检验员',
        action: 'APPROVED',
        comment: '已完成全批外观抽检，划伤集中在盘头部位',
        signedAt: '2023-10-13T08:40:00.000Z',
      },
      {
        userId: EMPLOYEE_IDS.zhangQiang,
        userName: '张强',
        roleCode: '质量经理',
        action: 'APPROVED',
        comment: '转技术部评估划伤对后续冷镦成型的影响',
        signedAt: '2023-10-13T09:05:00.000Z',
      },
    ],
    createdAt: '2023-10-13T08:20:00.000Z',
    updatedAt: '2023-10-13T09:05:00.000Z',
  },
];

// ============================================================================
// 8. 批次追溯：主链路 DAG（含 2 条分叉边）+ 一个独立的 3 节点环分量
// ============================================================================

export const seedTraceNodes: TraceNode[] = [
  {
    nodeId: '60000000-0000-4000-8000-000000000001',
    batchNo: 'COIL-20230925-01',
    stageName: '原材料入库 (IQC)',
    materialName: '304HC 不锈钢盘条 Φ6.5mm',
    operatorName: '陈静',
    timestamp: '2023-09-25T08:30:00.000Z',
    nodeStatus: 'STORED',
    orderNo: 'PO-20230920-08',
    supplierOrCustomer: '青山特钢',
    furnaceHeatBatchNo: '230915-047',
  },
  {
    nodeId: '60000000-0000-4000-8000-000000000002',
    batchNo: 'WIRE-20230927-04',
    stageName: '拉丝工序 (IPQC)',
    materialName: '精拔不锈钢丝 Φ5.00mm',
    operatorName: '李伟',
    timestamp: '2023-09-27T10:00:00.000Z',
    nodeStatus: 'PASSED',
    orderNo: 'MO-20230927-01',
    supplierOrCustomer: '拔丝一车间',
  },
  {
    nodeId: '60000000-0000-4000-8000-000000000003',
    batchNo: 'BLANK-20231002-01',
    stageName: '冷镦下料成型 (IPQC)',
    materialName: '六角头毛坯螺栓 M6*25',
    operatorName: '王建国',
    timestamp: '2023-10-02T14:30:00.000Z',
    nodeStatus: 'INSPECTING',
    orderNo: 'MO-20231002-03',
    supplierOrCustomer: '冷镦机 CH-04',
  },
  {
    nodeId: '60000000-0000-4000-8000-000000000004',
    batchNo: 'THRD-20231005-02',
    stageName: '搓丝工序 (IPQC)',
    materialName: '搓丝成品半成品 M6*25 6g',
    operatorName: '赵志明',
    timestamp: '2023-10-05T09:15:00.000Z',
    nodeStatus: 'PASSED',
    orderNo: 'MO-20231005-02',
    supplierOrCustomer: '搓丝二车间',
  },
  {
    nodeId: '60000000-0000-4000-8000-000000000005',
    batchNo: 'HEAT-20231008-01',
    stageName: '网带炉热处理 (IPQC)',
    materialName: '调质热处理螺栓 (硬度 32-39 HRC)',
    operatorName: '孙德胜',
    timestamp: '2023-10-08T16:00:00.000Z',
    nodeStatus: 'PASSED',
    orderNo: 'MO-20231008-01',
    supplierOrCustomer: '热处理炉 HT-02',
    furnaceHeatBatchNo: 'HT02-20231008-A',
  },
  {
    nodeId: '60000000-0000-4000-8000-000000000006',
    batchNo: 'PLT-20231010-03',
    stageName: '环保蓝白锌电镀 (委外检)',
    materialName: '镀锌六角头螺栓 M6*25 (膜厚≥8μm)',
    operatorName: '周海波',
    timestamp: '2023-10-10T11:20:00.000Z',
    nodeStatus: 'PASSED',
    orderNo: 'OQC-SF-20231012-0001',
    supplierOrCustomer: '恒信表面处理厂',
    inspectionOrderNo: 'OQC-SF-20231012-0001',
  },
  {
    nodeId: '60000000-0000-4000-8000-000000000007',
    batchNo: 'LOT-2026-FN-01',
    stageName: '成品终检入库 (FQC 强制放行)',
    materialName: '外六角螺栓 M6*25-10.9级 盒装',
    operatorName: '刘芳',
    timestamp: '2023-10-12T11:00:00.000Z',
    nodeStatus: 'FAILED',
    orderNo: 'OQC-SH-20231013-0002',
    supplierOrCustomer: '成品立体库 03-A-12',
    inspectionOrderNo: 'OQC-SH-20231013-0002',
  },
  {
    nodeId: '60000000-0000-4000-8000-000000000008',
    batchNo: 'SHP-20231012-01',
    stageName: '销售发货出库',
    materialName: '外六角螺栓 M6*25-10.9级 盒装',
    operatorName: '刘芳',
    timestamp: '2023-10-12T17:00:00.000Z',
    nodeStatus: 'PENDING',
    orderNo: 'SO-20231012-01',
    supplierOrCustomer: '三一重工机械装备底盘制造厂',
  },
  {
    nodeId: '60000000-0000-4000-8000-000000000009',
    batchNo: 'CYCLE-A',
    stageName: '返工流转环 A (工艺验证用)',
    materialName: '返工验证批次 A',
    operatorName: '王建国',
    timestamp: '2023-10-14T09:00:00.000Z',
    nodeStatus: 'PASSED',
    orderNo: 'MO-20231014-01',
    supplierOrCustomer: '返工线 RW-01',
  },
  {
    nodeId: '60000000-0000-4000-8000-000000000010',
    batchNo: 'CYCLE-B',
    stageName: '返工流转环 B (工艺验证用)',
    materialName: '返工验证批次 B',
    operatorName: '王建国',
    timestamp: '2023-10-14T10:00:00.000Z',
    nodeStatus: 'INSPECTING',
    orderNo: 'MO-20231014-02',
    supplierOrCustomer: '返工线 RW-01',
  },
  {
    nodeId: '60000000-0000-4000-8000-000000000011',
    batchNo: 'CYCLE-C',
    stageName: '返工流转环 C (工艺验证用)',
    materialName: '返工验证批次 C',
    operatorName: '王建国',
    timestamp: '2023-10-14T11:00:00.000Z',
    nodeStatus: 'PENDING',
    orderNo: 'MO-20231014-03',
    supplierOrCustomer: '返工线 RW-01',
  },
  {
    // 特采（让步接收）样本：来料检验判不合格 → MRB-20231011-01 裁决 CONCESSION。
    // 该批次在 inspection_orders 有真实检验单 INS-20231011-0001、在 mrb_reviews 有真实的
    // CONCESSION 裁决与客户书面授权件，是「特采节点必须能举证」这条口径的活样本（docs/24 §4 R4）。
    // 故意不接入主链路：它既不是 304HC 那批料的下游，也不是其上游，不得凭空连边。
    nodeId: '60000000-0000-4000-8000-000000000012',
    batchNo: 'B20231011-92',
    stageName: '来料检验 (IQC 特采放行)',
    materialName: '35CrMo 合金圆钢 Φ8.0mm',
    operatorName: '陈静',
    timestamp: '2023-10-11T16:00:00.000Z',
    nodeStatus: 'CONCESSION',
    orderNo: 'INS-20231011-0001',
    supplierOrCustomer: '青山控股实业线材分公司',
    materialCode: 'MAT-35CRMO-08',
    furnaceHeatBatchNo: '230910-112',
    inspectionOrderNo: 'INS-20231011-0001',
  },
];

export const seedTraceEdges: TraceEdge[] = [
  // ---- 主链路（8 条边，包含 PLT 节点的 2 条分叉）----
  {
    sourceBatchNo: 'COIL-20230925-01',
    targetBatchNo: 'WIRE-20230927-04',
    relationType: 'RAW_TO_PROCESS',
    depth: 1,
    isCycle: false,
    hasCycleWarning: false,
  },
  {
    sourceBatchNo: 'WIRE-20230927-04',
    targetBatchNo: 'BLANK-20231002-01',
    relationType: 'PROCESS_TO_PROCESS',
    depth: 2,
    isCycle: false,
    hasCycleWarning: false,
  },
  {
    sourceBatchNo: 'BLANK-20231002-01',
    targetBatchNo: 'THRD-20231005-02',
    relationType: 'PROCESS_TO_PROCESS',
    depth: 3,
    isCycle: false,
    hasCycleWarning: false,
  },
  {
    sourceBatchNo: 'THRD-20231005-02',
    targetBatchNo: 'HEAT-20231008-01',
    relationType: 'PROCESS_TO_PROCESS',
    depth: 4,
    isCycle: false,
    hasCycleWarning: false,
  },
  {
    sourceBatchNo: 'HEAT-20231008-01',
    targetBatchNo: 'PLT-20231010-03',
    relationType: 'PROCESS_TO_OUTSOURCE',
    depth: 5,
    isCycle: false,
    hasCycleWarning: false,
  },
  // 分叉 1：委外回厂 -> 成品检入库
  {
    sourceBatchNo: 'PLT-20231010-03',
    targetBatchNo: 'LOT-2026-FN-01',
    relationType: 'OUTSOURCE_TO_FINISH',
    depth: 6,
    isCycle: false,
    hasCycleWarning: false,
  },
  // 分叉 2：委外回厂 -> 直接发货（真实 DAG 分叉，非链式）
  {
    sourceBatchNo: 'PLT-20231010-03',
    targetBatchNo: 'SHP-20231012-01',
    relationType: 'OUTSOURCE_TO_FINISH',
    depth: 6,
    isCycle: false,
    hasCycleWarning: false,
  },
  {
    sourceBatchNo: 'LOT-2026-FN-01',
    targetBatchNo: 'SHP-20231012-01',
    relationType: 'FINISH_TO_SHIPMENT',
    depth: 7,
    isCycle: false,
    hasCycleWarning: false,
  },
  // ---- 独立的 3 节点环分量（与主链路不连通，用于验证成环检测）----
  {
    sourceBatchNo: 'CYCLE-A',
    targetBatchNo: 'CYCLE-B',
    relationType: 'PROCESS_TO_PROCESS',
    depth: 1,
    isCycle: true,
    hasCycleWarning: true,
  },
  {
    sourceBatchNo: 'CYCLE-B',
    targetBatchNo: 'CYCLE-C',
    relationType: 'PROCESS_TO_PROCESS',
    depth: 2,
    isCycle: true,
    hasCycleWarning: true,
  },
  {
    sourceBatchNo: 'CYCLE-C',
    targetBatchNo: 'CYCLE-A',
    relationType: 'PROCESS_TO_PROCESS',
    depth: 3,
    isCycle: true,
    hasCycleWarning: true,
  },
];

/** 主链路根批次（findConnectedEdges 验证入口） */
export const MAIN_CHAIN_ROOT_BATCH = 'COIL-20230925-01';

// ============================================================================
// 9. 物料行级数据权限（PBAC）
// ============================================================================

export const seedMaterialPermissions: MaterialPermission[] = [
  {
    id: '70000000-0000-4000-8000-000000000099',
    userId: '11111111-1111-1111-1111-111111111111',
    userName: '张三 (测试质检员)',
    roleCode: 'QA_MANAGER',
    materialCategories: ['*'],
    materialCodes: [],
    supplierCodes: [],
    isActive: true,
  },
  {
    // 通配规则：可见全部物料分类
    id: '70000000-0000-4000-8000-000000000001',
    userId: EMPLOYEE_IDS.zhangQiang,
    userName: '张强',
    roleCode: 'QA_MANAGER',
    materialCategories: ['*'],
    materialCodes: [],
    supplierCodes: [],
    isActive: true,
  },
  {
    // 分类白名单 + 指定物料编码 + 指定供应商范围
    id: '70000000-0000-4000-8000-000000000002',
    userId: EMPLOYEE_IDS.chenJing,
    userName: '陈静',
    roleCode: 'IQC_INSPECTOR',
    materialCategories: ['CAT-RAW', 'CAT-RAW-WIRE'],
    materialCodes: ['MAT-304SS-05'],
    supplierCodes: ['SUP-001', 'SUP-002'],
    isActive: true,
  },
  {
    id: '70000000-0000-4000-8000-000000000003',
    userName: '刘芳',
    userId: EMPLOYEE_IDS.liuFang,
    roleCode: 'OQC_INSPECTOR',
    // 027：CAT-FIN-MACH（机加工成品件）与螺栓类同属成品件，追加后刘芳的可见范围与迁移前等价
    materialCategories: ['CAT-FINISH', 'CAT-FIN-BOLT', 'CAT-FIN-MACH'],
    materialCodes: [],
    supplierCodes: [],
    isActive: true,
  },
  {
    // 受限供应商白名单（仅恒信表面处理厂）
    id: '70000000-0000-4000-8000-000000000004',
    userId: EMPLOYEE_IDS.zhouHaiBo,
    userName: '周海波',
    roleCode: 'SURFACE_TREATMENT_ENGINEER',
    materialCategories: ['CAT-SEMI', 'CAT-FIN-BOLT'],
    materialCodes: ['MAT-BLT-109-M10'],
    supplierCodes: ['SUP-004'],
    isActive: true,
  },
  {
    // 已停用规则：用于验证 listAllActive() 只返回生效规则
    id: '70000000-0000-4000-8000-000000000005',
    userId: EMPLOYEE_IDS.wangJianGuo,
    userName: '王建国',
    roleCode: 'RESTRICTED_VIEWER',
    materialCategories: [],
    materialCodes: [],
    supplierCodes: [],
    isActive: false,
  },
];

// ============================================================================
// 10. MES / ERP 集成配置与同步日志
// ============================================================================

export const seedIntegrationConfigs: IntegrationConfigInsert[] = [
  {
    id: 'a0000000-0000-4000-8000-000000000001',
    systemCode: 'MES',
    systemName: '制造执行系统 (MES)',
    baseUrl: 'https://mes.letian-fasteners.com/api/v2',
    authType: 'BEARER_TOKEN',
    authSecret: 'bearer-mes-secret-token-2026',
    timeoutMs: 5000,
    isEnabled: true,
    syncSchedule: '0 */5 * * * *',
    subscribedWorkshops: ['拔丝车间', '冷镦一车间', '热处理二车间', '表面处理三车间'],
    subscribedProcesses: ['拔丝', '冷镦成型', '搓丝', '网带热处理', '滚镀锌'],
  },
  {
    id: 'a0000000-0000-4000-8000-000000000002',
    systemCode: 'ERP',
    systemName: '企业资源计划系统 (ERP)',
    baseUrl: 'https://erp.letian-fasteners.com/openapi',
    authType: 'BEARER_TOKEN',
    authSecret: 'bearer-erp-secret-token-2026',
    timeoutMs: 8000,
    isEnabled: true,
    syncSchedule: '0 */5 * * * *',
    subscribedWorkshops: ['中心仓库', '原料库', '成品立体库'],
    subscribedProcesses: ['采购收货', '销售出库'],
  },
];

export const seedSyncLogs: IntegrationSyncLogInsert[] = [
  {
    id: 'b0000000-0000-4000-8000-000000000001',
    systemCode: 'MES',
    taskName: 'MES 工序实测数据增量拉取',
    status: 'SUCCESS',
    recordsProcessed: 42,
    errorMessage: null,
    durationMs: 380,
    batchNo: 'B20231012-02',
    syncDirection: 'PULL',
  },
  {
    id: 'b0000000-0000-4000-8000-000000000002',
    systemCode: 'MES',
    taskName: 'MES 检验结果回写',
    status: 'PARTIAL_FAIL',
    recordsProcessed: 18,
    errorMessage: '网关超时: 下料工序 CH-04 实测数据丢包 2 条',
    durationMs: 1520,
    batchNo: 'B20231012-03',
    syncDirection: 'PUSH',
  },
  {
    id: 'b0000000-0000-4000-8000-000000000003',
    systemCode: 'MES',
    taskName: 'MES 设备状态心跳同步',
    status: 'SUCCESS',
    recordsProcessed: 12,
    errorMessage: null,
    durationMs: 210,
    batchNo: 'B20231013-02',
    syncDirection: 'PULL',
  },
  {
    id: 'b0000000-0000-4000-8000-000000000004',
    systemCode: 'MES',
    taskName: 'MES 工单工序流转推送',
    status: 'FAILED',
    recordsProcessed: 0,
    errorMessage: 'MES 网关 504 Gateway Timeout，已进入重试队列',
    durationMs: 5000,
    batchNo: 'B20231013-03',
    syncDirection: 'PUSH',
  },
  {
    id: 'b0000000-0000-4000-8000-000000000005',
    systemCode: 'ERP',
    taskName: 'ERP 物料主数据拉取',
    status: 'SUCCESS',
    recordsProcessed: 1,
    errorMessage: null,
    durationMs: 145,
    batchNo: 'B20231012-01',
    syncDirection: 'PULL',
  },
  {
    id: 'b0000000-0000-4000-8000-000000000006',
    systemCode: 'ERP',
    taskName: 'ERP 检验工单过账回写',
    status: 'SUCCESS',
    recordsProcessed: 3,
    errorMessage: null,
    durationMs: 260,
    batchNo: 'B20231012-01',
    syncDirection: 'PUSH',
  },
  {
    id: 'b0000000-0000-4000-8000-000000000007',
    systemCode: 'ERP',
    taskName: 'ERP 库存批次主数据拉取',
    status: 'PARTIAL_FAIL',
    recordsProcessed: 25,
    errorMessage: '存在 2 个批次未匹配到物料档案，已跳过',
    durationMs: 980,
    batchNo: 'B20231011-92',
    syncDirection: 'PULL',
  },
  {
    id: 'b0000000-0000-4000-8000-000000000008',
    systemCode: 'MES',
    taskName: 'MES 工序实测数据增量拉取',
    status: 'FAILED',
    recordsProcessed: 0,
    errorMessage: '连接超时，MES 服务不可达',
    durationMs: 30000,
    batchNo: 'B20231011-92',
    syncDirection: 'PULL',
  },
];

// ============================================================================
// 11. 审计日志（append-only，仅 INSERT）与 Outbox 事件
// ============================================================================

export const seedAuditLogs: AuditLogInsert[] = [
  {
    id: '80000000-0000-4000-8000-000000000001',
    entityName: 'INSPECTION_ORDER',
    entityId: 'INS-20231012-0002',
    action: 'CREATE',
    operatorId: EMPLOYEE_IDS.wangJianGuo,
    operatorName: '王建国',
    diffPatch: { orderType: 'IPQC_CT', batchNo: 'B20231012-02', status: 'PENDING' },
    clientIp: '192.168.10.14',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LetianQMS/1.0',
    occurredAt: new Date('2023-10-12T09:00:00.000Z'),
    traceId: 'trace-20231012-0900-001',
    status: 'SUCCESS',
  },
  {
    id: '80000000-0000-4000-8000-000000000002',
    entityName: 'INSPECTION_ORDER',
    entityId: 'INS-20231012-0002',
    action: 'STATUS_CHANGE',
    operatorId: EMPLOYEE_IDS.wangJianGuo,
    operatorName: '王建国',
    diffPatch: { from: 'INSPECTING', to: 'FAILED', failQty: 4 },
    clientIp: '192.168.10.14',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LetianQMS/1.0',
    occurredAt: new Date('2023-10-12T09:30:00.000Z'),
    traceId: 'trace-20231012-0930-002',
    status: 'SUCCESS',
  },
  {
    id: '80000000-0000-4000-8000-000000000003',
    entityName: 'RELEASE_GATE',
    entityId: 'B20231012-02',
    action: 'GATE_BLOCKED',
    operatorId: EMPLOYEE_IDS.zhangQiang,
    operatorName: '张强',
    diffPatch: { reason: '批次工单处于失败状态且无生效特采单，禁止放行' },
    clientIp: '192.168.10.21',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LetianQMS/1.0',
    occurredAt: new Date('2023-10-12T09:45:00.000Z'),
    traceId: 'trace-20231012-0945-003',
    status: 'REJECTED',
  },
  {
    id: '80000000-0000-4000-8000-000000000004',
    entityName: 'MRB_REVIEW',
    entityId: 'MRB-20231011-01',
    action: 'DISPOSE',
    operatorId: EMPLOYEE_IDS.zhangQiang,
    operatorName: '张强',
    diffPatch: { disposition: 'CONCESSION', sourceOrderNo: 'INS-20231011-0001' },
    clientIp: '192.168.10.21',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LetianQMS/1.0',
    occurredAt: new Date('2023-10-11T16:00:00.000Z'),
    traceId: 'trace-20231011-1600-004',
    status: 'SUCCESS',
  },
  {
    id: '80000000-0000-4000-8000-000000000005',
    entityName: 'AUTH_SESSION',
    entityId: 'login-attempt-token-expired',
    action: 'AUTH_FAILED',
    operatorId: SYSTEM_OPERATOR_ID,
    operatorName: '系统操作员',
    diffPatch: { reason: 'JWT 令牌已过期', endpoint: '/api/v1/mrb/reviews' },
    clientIp: '192.168.10.77',
    userAgent: 'python-requests/2.31.0',
    occurredAt: new Date('2023-10-12T07:12:00.000Z'),
    traceId: 'trace-20231012-0712-005',
    status: 'FAILED',
  },
  {
    id: '80000000-0000-4000-8000-000000000006',
    entityName: 'INTEGRATION_CONFIG',
    entityId: 'MES',
    action: 'SYNC_TRIGGER',
    operatorId: EMPLOYEE_IDS.liWei,
    operatorName: '李伟',
    diffPatch: { syncDirection: 'PULL', batchNo: 'B20231012-02', recordsProcessed: 42 },
    clientIp: '192.168.10.33',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LetianQMS/1.0',
    occurredAt: new Date('2023-10-12T08:55:00.000Z'),
    traceId: 'trace-20231012-0855-006',
    status: 'SUCCESS',
  },
  {
    id: '80000000-0000-4000-8000-000000000007',
    entityName: 'INSPECTION_ITEM',
    entityId: 'THR-001',
    action: 'VALIDATION_REJECTED',
    operatorId: EMPLOYEE_IDS.liuFang,
    operatorName: '刘芳',
    diffPatch: { itemCode: 'THR-001', reason: '实测值 9.068mm 超出上公差，需填写缺陷原因' },
    clientIp: '192.168.10.45',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LetianQMS/1.0',
    occurredAt: new Date('2023-10-12T10:20:00.000Z'),
    traceId: 'trace-20231012-1020-007',
    status: 'REJECTED',
  },
  {
    id: '80000000-0000-4000-8000-000000000008',
    entityName: 'INSPECTION_PLAN',
    entityId: 'QP-IQC-304SS',
    action: 'UPDATE',
    operatorId: EMPLOYEE_IDS.zhangQiang,
    operatorName: '张强',
    diffPatch: { addedVersion: 'v2.5', status: 'DRAFT', reason: '收紧直径公差至 ±0.015mm' },
    clientIp: '192.168.10.21',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LetianQMS/1.0',
    occurredAt: new Date('2023-10-13T08:10:00.000Z'),
    traceId: 'trace-20231013-0810-008',
    status: 'SUCCESS',
  },
];

export const seedOutboxEvents: OutboxEventInsert[] = [
  {
    id: '90000000-0000-4000-8000-000000000001',
    aggregateType: 'ReleaseGate',
    aggregateId: 'B20231012-02',
    eventType: 'RELEASE_GATE_BLOCKED',
    payload: {
      batchNo: 'B20231012-02',
      gateType: 'PROCESS_TRANSFER',
      reason: '批次工单处于失败状态且无生效特采单，禁止放行',
    },
    status: 'PENDING',
    retryCount: 0,
    createdAt: new Date('2023-10-12T09:45:00.000Z'),
    processedAt: null,
    traceId: 'trace-20231012-0945-003',
    errorReason: null,
  },
  {
    id: '90000000-0000-4000-8000-000000000002',
    aggregateType: 'InspectionOrder',
    aggregateId: 'INS-20231012-0003',
    eventType: 'MRB_REVIEW_TRIGGERED',
    payload: { mrbNo: 'MRB-20231012-02', sourceOrderNo: 'INS-20231012-0003', materialCode: 'MAT-BLT-109-M10' },
    status: 'PENDING',
    retryCount: 0,
    createdAt: new Date('2023-10-12T11:20:00.000Z'),
    processedAt: null,
    traceId: 'trace-20231012-1120-009',
    errorReason: null,
  },
  {
    id: '90000000-0000-4000-8000-000000000003',
    aggregateType: 'MRBReview',
    aggregateId: 'MRB-20231013-02',
    eventType: 'CONCESSION_GRANTED',
    payload: { mrbNo: 'MRB-20231013-02', batchNo: 'B20231013-06', disposition: 'CONCESSION' },
    status: 'PENDING',
    retryCount: 0,
    createdAt: new Date('2023-10-13T14:30:00.000Z'),
    processedAt: null,
    traceId: 'trace-20231013-1430-010',
    errorReason: null,
  },
];

// ============================================================================
// 12. 权限校验日志（authorization_logs）
// ============================================================================

export const seedAuthorizationLogs: AuthorizationLogInsert[] = [
  {
    id: '71000000-0000-4000-8000-000000000001',
    userId: EMPLOYEE_IDS.zhangQiang,
    userName: '张强',
    roleCode: 'QA_MANAGER',
    resourceType: 'DASHBOARD',
    resourceId: 'OVERVIEW',
    materialCode: null,
    materialCategory: null,
    supplierCode: null,
    action: 'READ',
    decision: 'ALLOWED',
    matchedRuleId: '70000000-0000-4000-8000-000000000001',
    detail: '质量主管全量通配规则，放行看板质量指标查询',
    createdAt: new Date(Date.now() - 3600000 * 24 * 2),
  },
  {
    id: '71000000-0000-4000-8000-000000000002',
    userId: EMPLOYEE_IDS.chenJing,
    userName: '陈静',
    roleCode: 'IQC_INSPECTOR',
    resourceType: 'INSPECTION_ORDER',
    resourceId: '40000000-0000-4000-8000-000000000001',
    materialCode: 'MAT-304SS-05',
    materialCategory: 'CAT-RAW-WIRE',
    supplierCode: 'SUP-001',
    action: 'READ',
    decision: 'ALLOWED',
    matchedRuleId: '70000000-0000-4000-8000-000000000002',
    detail: '匹配来料线材分类与江苏大明不锈钢供应商准入规则',
    createdAt: new Date(Date.now() - 3600000 * 24),
  },
  {
    id: '71000000-0000-4000-8000-000000000003',
    userId: EMPLOYEE_IDS.chenJing,
    userName: '陈静',
    roleCode: 'IQC_INSPECTOR',
    resourceType: 'INSPECTION_ORDER',
    resourceId: '40000000-0000-4000-8000-000000000005',
    materialCode: 'MAT-PKG-BOX-01',
    materialCategory: 'CAT-PKG',
    supplierCode: 'SUP-005',
    action: 'READ',
    decision: 'DENIED',
    matchedRuleId: null,
    detail: '未获得包材类供应商 SUP-005 的检验权限，行级过滤拒绝',
    createdAt: new Date(Date.now() - 3600000 * 20),
  },
  {
    id: '71000000-0000-4000-8000-000000000004',
    userId: EMPLOYEE_IDS.zhouHaiBo,
    userName: '周海波',
    roleCode: 'IPQC_INSPECTOR',
    resourceType: 'INSPECTION_ORDER',
    resourceId: '40000000-0000-4000-8000-000000000007',
    materialCode: 'MAT-BLT-109-M10',
    materialCategory: 'CAT-WIP-BLANK',
    supplierCode: null,
    action: 'EVALUATE',
    decision: 'ALLOWED',
    matchedRuleId: '70000000-0000-4000-8000-000000000004',
    detail: '匹配冷镦成型件半成品检验权限',
    createdAt: new Date(Date.now() - 3600000 * 16),
  },
  {
    id: '71000000-0000-4000-8000-000000000005',
    userId: EMPLOYEE_IDS.liuFang,
    userName: '刘芳',
    roleCode: 'OQC_INSPECTOR',
    resourceType: 'INSPECTION_ORDER',
    resourceId: '40000000-0000-4000-8000-000000000009',
    materialCode: 'MAT-SCR-HEX-M8',
    materialCategory: 'CAT-FIN',
    supplierCode: null,
    action: 'READ',
    decision: 'ALLOWED',
    matchedRuleId: '70000000-0000-4000-8000-000000000003',
    detail: '匹配成品出货检验全量成品权限',
    createdAt: new Date(Date.now() - 3600000 * 12),
  },
  {
    id: '71000000-0000-4000-8000-000000000006',
    userId: EMPLOYEE_IDS.wangJianGuo,
    userName: '王建国',
    roleCode: 'RESTRICTED_VIEWER',
    resourceType: 'INSPECTION_PLAN',
    resourceId: '30000000-0000-4000-8000-000000000001',
    materialCode: 'MAT-304SS-05',
    materialCategory: 'CAT-RAW-WIRE',
    supplierCode: null,
    action: 'READ',
    decision: 'DENIED',
    matchedRuleId: '70000000-0000-4000-8000-000000000005',
    detail: '受限访问角色规则处于停用状态，拒绝访问质检方案',
    createdAt: new Date(Date.now() - 3600000 * 8),
  },
  {
    id: '71000000-0000-4000-8000-000000000007',
    userId: EMPLOYEE_IDS.zhangQiang,
    userName: '张强',
    roleCode: 'QA_MANAGER',
    resourceType: 'MRB_REVIEW',
    resourceId: '50000000-0000-4000-8000-000000000001',
    materialCode: 'MAT-304SS-05',
    materialCategory: 'CAT-RAW-WIRE',
    supplierCode: 'SUP-001',
    action: 'READ',
    decision: 'ALLOWED',
    matchedRuleId: '70000000-0000-4000-8000-000000000001',
    detail: '质量主管通配权限放行 MRB 评审单查阅',
    createdAt: new Date(Date.now() - 3600000 * 4),
  },
  {
    id: '71000000-0000-4000-8000-000000000008',
    userId: EMPLOYEE_IDS.zhangQiang,
    userName: '张强',
    roleCode: 'QA_MANAGER',
    resourceType: 'BATCH_TRACE',
    resourceId: 'B20231012-01',
    materialCode: 'MAT-304SS-05',
    materialCategory: 'CAT-RAW-WIRE',
    supplierCode: 'SUP-001',
    action: 'READ',
    decision: 'ALLOWED',
    matchedRuleId: '70000000-0000-4000-8000-000000000001',
    detail: '追溯图谱穿透查询放行',
    createdAt: new Date(Date.now() - 3600000 * 1),
  },
];
