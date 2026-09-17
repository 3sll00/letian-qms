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
  CustomerInsert,
  EmployeeInsert,
  IntegrationConfigInsert,
  IntegrationSyncLogInsert,
  InventoryCategoryInsert,
  MaterialInsert,
  OutboxEventInsert,
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
];

/** 物料编码 -> 物料名称，工单落库时补齐 material_name */
export function materialNameOf(materialCode: string): string {
  const found = seedMaterials.find((m) => m.materialCode === materialCode);
  if (!found) {
    throw new Error(`SEED_MATERIAL_NOT_FOUND: 演示数据缺少物料 [${materialCode}]`);
  }
  return found.materialName;
}

// ============================================================================
// 3. 供应商 / 客户 / 车间 / 员工
// ============================================================================

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
    id: EMPLOYEE_IDS.zhangQiang,
    employeeCode: 'EMP-1042',
    name: '张强',
    department: '品质保证部',
    phone: '13800000001',
    email: 'zhangqiang@letian.com',
    isActive: true,
  },
  {
    id: EMPLOYEE_IDS.liWei,
    employeeCode: 'EMP-1088',
    name: '李伟',
    department: '生产部',
    phone: '13800000002',
    email: 'liwei@letian.com',
    isActive: true,
  },
  {
    id: EMPLOYEE_IDS.liuFang,
    employeeCode: 'EMP-1095',
    name: '刘芳',
    department: '品质保证部',
    phone: '13800000003',
    email: 'liufang@letian.com',
    isActive: true,
  },
  {
    id: EMPLOYEE_IDS.wangJianGuo,
    employeeCode: 'EMP-1102',
    name: '王建国',
    department: '生产部',
    phone: '13800000004',
    email: 'wangjianguo@letian.com',
    isActive: true,
  },
  {
    id: EMPLOYEE_IDS.zhaoZhiMing,
    employeeCode: 'EMP-1108',
    name: '赵志明',
    department: '生产部',
    phone: '13800000005',
    email: 'zhaozhiming@letian.com',
    isActive: true,
  },
  {
    id: EMPLOYEE_IDS.sunDeSheng,
    employeeCode: 'EMP-1115',
    name: '孙德胜',
    department: '生产部',
    phone: '13800000006',
    email: 'sundesheng@letian.com',
    isActive: true,
  },
  {
    id: EMPLOYEE_IDS.zhouHaiBo,
    employeeCode: 'EMP-1121',
    name: '周海波',
    department: '生产部',
    phone: '13800000007',
    email: 'zhouhaibo@letian.com',
    isActive: true,
  },
  {
    id: EMPLOYEE_IDS.chenJing,
    employeeCode: 'EMP-1130',
    name: '陈静',
    department: '品质保证部',
    phone: '13800000008',
    email: 'chenjing@letian.com',
    isActive: true,
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
  nominalValue: number;
  /** 上公差（正数量值） */
  upperTolerance: number;
  /** 下公差（正数量值） */
  lowerTolerance: number;
  sampleSize: number;
  unit: string;
  measurementTool: string;
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
  materialCode: string;
  inspectionType: InspectionType;
  versions: SeedPlanVersion[];
}

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
}

export const seedOrders: SeedOrderSpec[] = [
  {
    // 来料不合格：被 MRB-20231011-01（DISPOSED + CONCESSION）引用
    id: '30000000-0000-4000-8000-000000000001',
    orderNo: 'INS-20231011-001',
    orderType: 'IQC',
    planCode: 'QP-IQC-35CRMO',
    versionNo: 'v1.0',
    batchNo: 'B20231011-92',
    materialCode: 'MAT-35CRMO-08',
    supplierCode: 'SUP-002',
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
    orderNo: 'INS-20231012-001',
    orderType: 'IQC',
    planCode: 'QP-IQC-304SS',
    versionNo: 'v2.4',
    batchNo: 'B20231012-01',
    materialCode: 'MAT-304SS-05',
    supplierCode: 'SUP-001',
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
    orderNo: 'INS-20231012-002',
    orderType: 'IPQC_CT',
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
    orderNo: 'INS-20231012-003',
    orderType: 'IPQC_FN',
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
    orderNo: 'INS-20231012-004',
    orderType: 'IPQC_RL',
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
    orderNo: 'INS-20231012-005',
    orderType: 'OQC_SF',
    planCode: 'QP-OQC-SF',
    versionNo: 'v2.0',
    batchNo: 'B20231010-03',
    materialCode: 'MAT-BLT-109-M10',
    supplierCode: 'SUP-004',
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
    orderNo: 'INS-20231012-006',
    orderType: 'OQC_SH',
    planCode: 'QP-OQC-SH',
    versionNo: 'v1.2',
    batchNo: 'B20231012-06',
    materialCode: 'MAT-BLT-109-M10',
    customerCode: 'CUST-001',
    inspectorId: EMPLOYEE_IDS.liuFang,
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
    orderNo: 'INS-20231013-001',
    orderType: 'IQC',
    planCode: 'QP-IQC-304SS',
    versionNo: 'v2.4',
    batchNo: 'B20231013-01',
    materialCode: 'MAT-304SS-05',
    supplierCode: 'SUP-001',
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
    orderNo: 'INS-20231013-002',
    orderType: 'IPQC_CT',
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
    orderNo: 'INS-20231013-003',
    orderType: 'IPQC_FN',
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
    orderNo: 'INS-20231013-004',
    orderType: 'OQC_SH',
    planCode: 'QP-OQC-SH',
    versionNo: 'v1.2',
    batchNo: 'B20231013-04',
    materialCode: 'MAT-BLT-109-M10',
    customerCode: 'CUST-003',
    inspectorId: EMPLOYEE_IDS.liuFang,
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
    orderNo: 'INS-20231013-005',
    orderType: 'OQC_SF',
    planCode: 'QP-OQC-SF',
    versionNo: 'v2.0',
    batchNo: 'B20231013-05',
    materialCode: 'MAT-35CRMO-08',
    supplierCode: 'SUP-004',
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
    orderNo: 'INS-20231013-006',
    orderType: 'OQC_SH',
    planCode: 'QP-OQC-SH',
    versionNo: 'v1.2',
    batchNo: 'B20231013-06',
    materialCode: 'MAT-BLT-109-M10',
    customerCode: 'CUST-003',
    inspectorId: EMPLOYEE_IDS.liuFang,
    totalQty: 42000,
    sampleQty: 200,
    status: 'COMPLETED',
    judgment: 'FAILED',
    isMandatoryGate: true,
    inspectionNotes: '出货抽检发现通规不止，经 MRB 让步接收决议后归档',
    snapshotAt: '2023-10-13T13:00:00.000Z',
    itemKind: 'HAS_FAILED',
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
    applicableType: 'INCOMING_FAIL',
    version: 'v1.0.0',
    isActive: true,
    nodes: [
      { nodeLevel: 1, nodeName: '来料检验员初判', roleCode: '检验员', requireCustomerSign: false },
      { nodeLevel: 2, nodeName: '质量工程师技术评审', roleCode: '质量工程师', requireCustomerSign: false },
      { nodeLevel: 3, nodeName: '质量经理终审裁决', roleCode: '质量经理', requireCustomerSign: false },
    ],
  },
  {
    id: '50000000-0000-4000-8000-000000000002',
    flowCode: 'FLOW-PROCESS-FAIL',
    flowName: '过程不合格评审与返工确认流程',
    applicableType: 'PROCESS_FAIL',
    version: 'v1.0.0',
    isActive: true,
    nodes: [
      { nodeLevel: 1, nodeName: '过程检验员初判', roleCode: '检验员', requireCustomerSign: false },
      { nodeLevel: 2, nodeName: '工艺工程师返工方案评审', roleCode: '工艺工程师', requireCustomerSign: false },
      { nodeLevel: 3, nodeName: '质量经理终审裁决', roleCode: '质量经理', requireCustomerSign: false },
    ],
  },
  {
    id: '50000000-0000-4000-8000-000000000003',
    flowCode: 'FLOW-SHIPMENT-FAIL',
    flowName: '出货不合格与客户让步接收签核流程',
    applicableType: 'SHIPMENT_FAIL',
    version: 'v1.0.0',
    isActive: true,
    nodes: [
      { nodeLevel: 1, nodeName: '出货检验员初判', roleCode: '检验员', requireCustomerSign: false },
      { nodeLevel: 2, nodeName: '质量经理让步评估', roleCode: '质量经理', requireCustomerSign: false },
      { nodeLevel: 3, nodeName: '客户代表书面签核', roleCode: '客户代表', requireCustomerSign: true },
    ],
  },
  {
    id: '50000000-0000-4000-8000-000000000004',
    flowCode: 'FLOW-SUBCONTRACT-FAIL',
    flowName: '委外加工不合格评审与供应商索赔流程',
    applicableType: 'SUBCONTRACT_FAIL',
    version: 'v1.0.0',
    isActive: true,
    nodes: [
      { nodeLevel: 1, nodeName: '委外检验员初判', roleCode: '检验员', requireCustomerSign: false },
      {
        nodeLevel: 2,
        nodeName: '供应商质量工程师责任认定',
        roleCode: '供应商质量工程师',
        requireCustomerSign: false,
      },
      { nodeLevel: 3, nodeName: '质量经理终审裁决', roleCode: '质量经理', requireCustomerSign: false },
    ],
  },
];

// ============================================================================
// 7. MRB 评审单（覆盖 4 个状态；source_order_no 必须命中已播种工单号）
// ============================================================================

export const seedMrbReviews: MRBReview[] = [
  {
    // DISPOSED + CONCESSION：引用 FAILED 工单 INS-20231011-001
    id: '40000000-0000-4000-8000-000000000001',
    mrbNo: 'MRB-20231011-01',
    sourceType: 'INCOMING_FAIL',
    sourceOrderNo: 'INS-20231011-001',
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
    sourceType: 'PROCESS_FAIL',
    sourceOrderNo: 'INS-20231012-002',
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
    sourceType: 'SHIPMENT_FAIL',
    sourceOrderNo: 'INS-20231012-003',
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
    sourceType: 'SUBCONTRACT_FAIL',
    sourceOrderNo: 'INS-20231013-005',
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
    sourceType: 'SHIPMENT_FAIL',
    sourceOrderNo: 'INS-20231013-006',
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
    sourceType: 'INCOMING_FAIL',
    sourceOrderNo: 'INS-20231013-001',
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
  },
  {
    nodeId: '60000000-0000-4000-8000-000000000006',
    batchNo: 'PLT-20231010-03',
    stageName: '环保蓝白锌电镀 (委外检)',
    materialName: '镀锌六角头螺栓 M6*25 (膜厚≥8μm)',
    operatorName: '周海波',
    timestamp: '2023-10-10T11:20:00.000Z',
    nodeStatus: 'PASSED',
    orderNo: 'INS-20231012-005',
    supplierOrCustomer: '恒信表面处理厂',
  },
  {
    nodeId: '60000000-0000-4000-8000-000000000007',
    batchNo: 'LOT-2026-FN-01',
    stageName: '成品终检入库 (FQC 强制放行)',
    materialName: '外六角螺栓 M6*25-10.9级 盒装',
    operatorName: '刘芳',
    timestamp: '2023-10-12T11:00:00.000Z',
    nodeStatus: 'FAILED',
    orderNo: 'INS-20231013-006',
    supplierOrCustomer: '成品立体库 03-A-12',
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
    materialCategories: ['CAT-FINISH', 'CAT-FIN-BOLT'],
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
    entityId: 'INS-20231012-002',
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
    entityId: 'INS-20231012-002',
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
    diffPatch: { disposition: 'CONCESSION', sourceOrderNo: 'INS-20231011-001' },
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
    aggregateId: 'INS-20231012-003',
    eventType: 'MRB_REVIEW_TRIGGERED',
    payload: { mrbNo: 'MRB-20231012-02', sourceOrderNo: 'INS-20231012-003', materialCode: 'MAT-BLT-109-M10' },
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
