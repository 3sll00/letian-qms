import type { InspectionStatus, InspectionType } from '@letian/contracts';

/**
 * 检验类型页面映射 —— 单一来源 (single source of truth)。
 *
 * 契约 InspectionTypeEnum (packages/contracts/src/schemas/inspection.ts) 的真实成员只有：
 *   IQC / IPQC_CT / IPQC_RL / IPQC_FN / OQC_SF / OQC_SH
 * 页面把细分类型归并成 4 个展示分组，供筛选页签与录入表单使用：
 *   IQC  = 来料进货检验
 *   IPQC = 过程制程 (下料 IPQC_CT / 滚丝 IPQC_RL / 成品检 IPQC_FN)
 *   FQC  = 成品入库终检 (IPQC_FN)，它是 IPQC 组的子集 —— 分组之间允许重叠
 *   OQC  = 委外与出货 (委外 OQC_SF / 出货 OQC_SH)
 *
 * 为什么这里是两张表而不是一张：
 *   - INSPECTION_TYPES 方向为「枚举 → 展示信息」，用于读取接口数据时渲染 (列表 / 详情)；
 *   - INSPECTION_GROUPS 方向为「分组 → 契约成员 + 表单默认提交类型」，用于写入接口时反查。
 *     一个页面选项必须落到一个确定的枚举值，而「枚举 → 分组」是多对一，无法反向唯一还原，
 *     两个方向语义不同，因此保留两张表，但所有键/值都只引用契约真实枚举成员；
 *     任一侧新增枚举成员时，TS 会因 Record<InspectionType, ...> 缺键而在此处直接报错。
 */
export type InspectionGroup = 'IQC' | 'IPQC' | 'FQC' | 'OQC';
export type InspectionFilterTab = 'ALL' | InspectionGroup;

/** 契约枚举成员 → 展示分组与中文名 (列表 / 详情渲染的唯一入口) */
export const INSPECTION_TYPES: Record<
  InspectionType,
  { group: InspectionGroup; label: string }
> = {
  IQC: { group: 'IQC', label: 'IQC 来料检验' },
  IPQC_CT: { group: 'IPQC', label: 'IPQC 下料检验' },
  IPQC_RL: { group: 'IPQC', label: 'IPQC 滚丝检验' },
  IPQC_FN: { group: 'FQC', label: 'FQC 成品入库终检' },
  OQC_SF: { group: 'OQC', label: 'OQC 委外加工检验' },
  OQC_SH: { group: 'OQC', label: 'OQC 出货检验' },
  OQC_HEAT: { group: 'OQC', label: 'OQC 委外热处理' },
  OQC_BLACK: { group: 'OQC', label: 'OQC 委外发黑' },
  OQC_ZINC: { group: 'OQC', label: 'OQC 委外镀锌' },
  OQC_NICKEL: { group: 'OQC', label: 'OQC 委外镀镍' },
  OQC_PHOSPH: { group: 'OQC', label: 'OQC 委外磷化' },
  OQC_DACRO: { group: 'OQC', label: 'OQC 委外达克罗' },
  OQC_MACH: { group: 'OQC', label: 'OQC 委外机加工' },
};

/** 展示分组 → 包含的契约成员 与 录入表单默认提交的细分类型 */
export const INSPECTION_GROUPS: Record<
  InspectionGroup,
  { members: readonly InspectionType[]; submitType: InspectionType }
> = {
  IQC: { members: ['IQC'], submitType: 'IQC' },
  IPQC: { members: ['IPQC_CT', 'IPQC_RL', 'IPQC_FN'], submitType: 'IPQC_CT' },
  FQC: { members: ['IPQC_FN'], submitType: 'IPQC_FN' },
  OQC: { members: ['OQC_SF', 'OQC_SH', 'OQC_HEAT', 'OQC_BLACK', 'OQC_ZINC', 'OQC_NICKEL', 'OQC_PHOSPH', 'OQC_DACRO', 'OQC_MACH'], submitType: 'OQC_SH' },
};

export const INSPECTION_FILTER_TABS: readonly InspectionFilterTab[] = [
  'ALL',
  'IQC',
  'IPQC',
  'FQC',
  'OQC',
];

/** 运行时判定一个 query 参数是否为合法的页面展示分组 */
export function isInspectionGroup(value: string): value is InspectionGroup {
  return Object.prototype.hasOwnProperty.call(INSPECTION_GROUPS, value);
}

/** 单条记录的检验类型展示名 */
export function inspectionTypeLabel(type: InspectionType): string {
  return INSPECTION_TYPES[type].label;
}

/**
 * 契约 InspectionStatusEnum 成员 → 台账展示用中文名。
 *
 * 用途：工单「尚未形成综合判定」(overallDecision 为空) 时，台账必须按后端真实状态展示，
 * 不能一律显示成「合格通过」——否则刚创建、一条实测值都没录入的工单会被误读为已放行。
 * Record<InspectionStatus, ...> 保证枚举新增成员时此处编译期报错，不会静默漏掉新状态。
 */
export const INSPECTION_STATUS_LABELS: Record<InspectionStatus, string> = {
  PENDING: '待检验',
  INSPECTING: '检验录入中',
  DRAFT: '草稿暂存',
  PASSED: '合格通过',
  FAILED: '不合格',
  IN_MRB_REVIEW: 'MRB 评审中',
  RE_INSPECTING: '复检中',
  COMPLETED: '已结单',
};

/**
 * 展示分组筛选匹配规则。
 * 页面页签 (前端) 与 mock handler 的 query 过滤 (被 mock 的后端) 共用此函数，
 * 保证「页签能看到什么」与「接口返回什么」使用同一份成员定义。
 */
export function inspectionTypeMatchesGroup(type: InspectionType, group: string): boolean {
  if (group === 'ALL') return true;
  return isInspectionGroup(group) && INSPECTION_GROUPS[group].members.includes(type);
}

// ==========================================
// 证书导出与打印标准数据模型 (PDF 导出专用)
// ==========================================

export interface ChemicalElementValue {
  element: string; // C, Si, Mn, P, S, Cr, Ni, Mo, Cu 等
  standard?: string; // 标准要求值，例如 ≤0.08 或 18.00-20.00
  standardMin?: number;
  standardMax?: number;
  actual?: string; // 实际测试值，例如 0.04 或 18.25
  actualValue?: string;
  unit?: string;
}

export interface ChemicalComposition {
  elements?: ChemicalElementValue[];
  [key: string]: any;
}

export interface MechanicalPropertyItem {
  name: string; // 抗拉强度 Rm, 屈服强度 Rp0.2, 断后伸长率 A, 硬度等
  standard: string; // 标准值，例如 ≥800 MPa 或 32-39 HRC
  actual: string; // 实测值，例如 845 MPa 或 35.5 HRC
  unit?: string;
  result?: string;
}

export interface MechanicalProperties {
  items?: MechanicalPropertyItem[];
  [key: string]: any;
}

export interface DimensionItem {
  name: string; // 螺纹通止规、外径、杆长、头部厚度等
  standard: string;
  actual: string;
  result: '合格' | '不合格';
}

// 模板一：《质量保证证书》导出模型 (用于 IQC / IPQC / OQC)
export interface QualityCertificateData {
  certNo: string; // 证书编号
  date?: string;
  issueDate?: string; // 签发日期
  inspectionType?: 'IQC' | 'IPQC' | 'OQC' | string; // 检验类型
  inspectionTypeLabel?: string; // 来料检验 / 过程检验 / 出货检验
  customer?: string; // 订货单位 / 客户
  customerAddress?: string; // 客户送货/收货地址（来自 ERP）
  projectNo?: string; // 项目号（来自 ERP）
  shortProjectNo?: string; // 短项目号（来自 ERP）
  manufactureDate?: string; // 制造日期（来自 ERP/MES）
  supplier?: string; // 供货单位 (IQC用)
  contractNo?: string; // 合同号 / 订单号
  deliveryNo?: string;
  productName: string; // 产品名称
  specification?: string; // 规格型号
  spec?: string;
  heatNo?: string; // 炉号 / 批号
  batchNo?: string; // 生产/检验批号
  lotNo?: string;
  quantity: string; // 检验/出货数量
  steelGrade?: string; // 材质牌号 (如 304SS, ML40Cr, 35K)
  materialGrade?: string;
  surfaceFinish?: string; // 表面处理
  standard: string; // 执行标准
  performanceGrade?: string; // 性能等级 (如 8.8, 10.9, A2-70)
  chemicalComposition: ChemicalComposition;
  mechanicalProperties: MechanicalProperties;
  dimensions?: DimensionItem[];
  overallConclusion?: '合格' | '特采' | '不合格' | string;
  inspector: string;
  reviewer?: string;
  approver?: string;
  remarks?: string;
  [key: string]: any;
}

// 模板二：《MANUFACTURING CERT》导出模型 (用于 委外检验 Outsource)
export interface OutsourceTestResult {
  coatingThickness?: {
    standard: string; // 如 8 - 12 μm
    actual: string; // 如 9.8 μm
    points?: string[]; // 多点测量值
  };
  saltSprayHours?: {
    standard: string; // 如 ≥480h 无红锈
    actual: string; // 如 720h 合格
  };
  adhesion?: {
    standard: string; // 如 划格法 0级
    actual: string; // 如 0级 无脱落
  };
  deEmbrittlement?: {
    standard: string; // 如 200℃±10℃, ≥4小时
    actual: string; // 如 205℃, 4.5小时
  };
  surfaceHardness?: {
    standard: string; // 如 32-39 HRC
    actual: string; // 如 35.5 HRC
  };
  coreHardness?: {
    standard: string; // 如 32-39 HRC
    actual: string; // 如 34.0 HRC
  };
  caseDepth?: {
    standard: string; // 如 0.15-0.25 mm
    actual: string; // 如 0.19 mm
  };
  torqueStrength?: {
    standard: string; // 如 ≥55 N·m
    actual: string; // 如 62 N·m
  };
  tensileStrength?: {
    standard: string; // 如 ≥800 MPa
    actual: string; // 如 850 MPa
  };
}

export interface ManufacturingCertData {
  certNo?: string;
  certificateNo?: string;
  date?: string;
  dateOfIssue?: string;
  customerName?: string;
  purchaseOrderNo?: string;
  orderNo?: string;
  subcontractNo?: string; // 委外工单号
  subcontractor?: string; // 委外加工商
  vendorName?: string;
  processName?: string; // 委外加工工序 (热处理/表面处理/达克罗等)
  productDescription?: string; // 产品/工件描述
  partName?: string;
  partSpec?: string;
  dimension?: string; // 规格尺寸
  steelGrade?: string; // 钢号/材质
  materialGrade?: string;
  heatNo?: string; // 炉号
  batchNo?: string; // 批次号
  quantity?: string;
  quantityPcs?: string; // 数量 (PCS)
  weightKg?: string; // 重量 (KG)
  standardsApplied?: string; // 适用标准规范
  standard?: string;
  testResults?: OutsourceTestResult;
  tests?: any[];
  visualInspection?: 'Pass' | 'Fail' | string;
  complianceStatement?: string;
  overallDecision?: string;
  inspectorName?: string;
  qaManagerName?: string;
  remarks?: string;
  [key: string]: any;
}

export type QualityCertData = QualityCertificateData;

