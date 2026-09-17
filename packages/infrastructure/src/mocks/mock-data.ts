import {
  InspectionOrder,
  InspectionItem,
  InspectionPlanItem,
  InspectionPlan,
  ReviewFlow,
  MRBReview,
  MaterialPermission,
  AuditLog,
  TraceNode,
  TraceEdge,
  AuditStatsResponse,
} from '@letian/contracts';

/**
 * 工序质检配置模板 (MES 工序设置)
 *
 * 该形状目前只有本模块的 Mock 与 API 控制器使用，尚未提升为契约 Schema。
 * 待工序模板成为真实持久化实体时，应上移至 @letian/contracts。
 */
export interface ProcessTemplate {
  id: string;
  processCode: string;
  processName: string;
  inspectionType: string;
  isMandatoryGate: boolean;
  defaultSampleQty: number;
  checkItems: Array<{
    itemCode: string;
    name: string;
    standardText: string;
    nominalValue: number;
    upperTolerance: number;
    lowerTolerance: number;
  }>;
  createdAt: string;
  updatedAt: string;
}

/**
 * MES 网关联调配置
 *
 * 同上：MES 网关配置的对外字段与 IntegrationConfig 契约不同，暂未统一。
 */
export interface MesGatewayConfig {
  id: string;
  mesEndpointUrl: string;
  authSecretKey: string;
  syncIntervalMinutes: number;
  enableAutoGateCheck: boolean;
  isConnected: boolean;
  updatedAt: string;
}

/**
 * 严格对齐 @letian/contracts 定义的标准化 Mock 数据服务
 * 仅用于单元测试、API 控制器离线联调与前端 MSW 独立交互验证，严禁混入生产构建
 *
 * 字段命名、枚举取值一律以 @letian/contracts 为准：
 * - 检验类型 InspectionTypeEnum: IQC | IPQC_CT | IPQC_RL | IPQC_FN | OQC_SF | OQC_SH
 * - 工单状态 InspectionStatusEnum: PENDING | INSPECTING | DRAFT | PASSED | FAILED | IN_MRB_REVIEW | RE_INSPECTING | COMPLETED
 * - 总体判定 OverallDecisionEnum: PASSED | FAILED | CONCESSION
 * - 指标判定 InspectionItemDecisionEnum: PENDING | PASSED | FAILED
 * - MRB 状态 MRBStatusEnum: PENDING_REVIEW | UNDER_REVIEW | DISPOSED | REJECTED
 * - 公差约定 (与 domain/services/tolerance-evaluator 一致): 上下公差均为正数量级，
 *   合格区间为 [nominalValue - lowerTolerance, nominalValue + upperTolerance]
 */

/** 知识性常量：作为质检单快照的方案版本 UUID */
const PLAN_VERSIONS = {
  IQC_BOLT: {
    planId: 'a1000000-0000-4000-8000-000000000001',
    planCode: 'PLAN-IQC-BOLT',
    planName: '六角螺栓来料检验方案',
    versionId: 'a1000000-0000-4000-8000-000000000101',
    versionNo: 'v1.0.0',
    samplingScheme: 'GB_T_2828',
    aqlLevel: 'II',
    strictness: 'NORMAL',
  },
  IPQC_CT: {
    planId: 'a1000000-0000-4000-8000-000000000002',
    planCode: 'PLAN-IPQC-CT-01',
    planName: '下料工序过程检验方案',
    versionId: 'a1000000-0000-4000-8000-000000000102',
    versionNo: 'v1.0.0',
    samplingScheme: 'GB_T_2828',
    aqlLevel: 'S-1',
    strictness: 'NORMAL',
  },
  OQC_SF: {
    planId: 'a1000000-0000-4000-8000-000000000003',
    planCode: 'PLAN-OQC-SF-01',
    planName: '成品出厂全检方案',
    versionId: 'a1000000-0000-4000-8000-000000000103',
    versionNo: 'v2.0.0',
    samplingScheme: 'GB_T_2828',
    aqlLevel: 'II',
    strictness: 'TIGHTENED',
  },
} as const;

/** 方案检验项目快照 (InspectionPlanItem)，供质检单 planSnapshot.items 复用 */
const SNAPSHOT_ITEMS: Record<keyof typeof PLAN_VERSIONS, InspectionPlanItem[]> = {
  IQC_BOLT: [
    {
      seq: 1,
      itemCode: 'ITEM-HEX-AF',
      name: '对边宽度',
      dataType: 'NUMERIC' as const,
      metricCategory: 'DIMENSION' as const,
      standardText: '19.00 ± 0.10 mm',
      nominalValue: 19.0,
      upperTolerance: 0.1,
      lowerTolerance: 0.1,
      sampleSize: 5,
      unit: 'mm',
      isMandatory: true,
    },
    {
      seq: 2,
      itemCode: 'ITEM-CHEM-C',
      name: '化学成分 - C(碳)',
      dataType: 'NUMERIC' as const,
      metricCategory: 'CHEMICAL_COMPOSITION' as const,
      standardText: '0.38% ~ 0.45%',
      nominalValue: 0.4,
      upperTolerance: 0.05,
      lowerTolerance: 0.02,
      sampleSize: 5,
      unit: '%',
      isMandatory: true,
    },
  ],
  IPQC_CT: [
    {
      seq: 1,
      itemCode: 'ITEM-LEN-TOTAL',
      name: '下料总长度',
      dataType: 'NUMERIC' as const,
      metricCategory: 'DIMENSION' as const,
      standardText: '50.00 ± 0.20 mm',
      nominalValue: 50.0,
      upperTolerance: 0.2,
      lowerTolerance: 0.2,
      sampleSize: 8,
      unit: 'mm',
      isMandatory: true,
    },
  ],
  OQC_SF: [
    {
      seq: 1,
      itemCode: 'ITEM-HEX-AF',
      name: '对边宽度',
      dataType: 'NUMERIC' as const,
      metricCategory: 'DIMENSION' as const,
      standardText: '19.00 ± 0.10 mm',
      nominalValue: 19.0,
      upperTolerance: 0.1,
      lowerTolerance: 0.1,
      sampleSize: 125,
      unit: 'mm',
      isMandatory: true,
    },
    {
      seq: 2,
      itemCode: 'ITEM-APPEARANCE',
      name: '外观质量',
      dataType: 'QUALITATIVE' as const,
      metricCategory: 'APPEARANCE' as const,
      standardText: '合格,OK,Pass',
      sampleSize: 125,
      isMandatory: true,
      remark: '无裂纹、无飞边、无锈蚀',
    },
  ],
};

function buildSnapshot(key: keyof typeof PLAN_VERSIONS) {
  const meta = PLAN_VERSIONS[key];
  return {
    planId: meta.planId,
    planCode: meta.planCode,
    planName: meta.planName,
    versionId: meta.versionId,
    versionNo: meta.versionNo,
    samplingScheme: meta.samplingScheme,
    aqlLevel: meta.aqlLevel,
    strictness: meta.strictness,
    items: [...SNAPSHOT_ITEMS[key]],
    snapshotAt: '2026-07-06T08:00:00Z',
  };
}

/**
 * 把方案快照的指标模板深拷贝为工单自己的实测项实例。
 *
 * 契约第 4 节规定工单 items 是"方案版本深拷贝快照"，检验判定与实测值录入
 * 都必须基于工单自身的 items。若 items 留空数组，则任何录入都因"指标编码不属于
 * 本工单"而被判定为非法，工单也永远无法推进状态，录入路径会整体失效。
 *
 * @param decision 已判定工单的最终结论。给出时按该结论反推一套自洽的实测值
 *                 （公差约定：合格区间为 [nominalValue - lowerTolerance, nominalValue + upperTolerance]），
 *                 'INSPECTING' 表示仅首项已录入、其余仍待检。
 */
function buildItems(
  key: keyof typeof PLAN_VERSIONS,
  decision?: 'PASSED' | 'FAILED' | 'INSPECTING'
): InspectionItem[] {
  return SNAPSHOT_ITEMS[key].map((tpl, index) => {
    const item: InspectionItem = {
      seq: tpl.seq,
      itemCode: tpl.itemCode,
      name: tpl.name,
      dataType: tpl.dataType,
      metricCategory: tpl.metricCategory,
      result: 'PENDING',
    };
    if (tpl.standardText !== undefined) item.standardText = tpl.standardText;
    if (tpl.sampleSize !== undefined) item.sampleSize = tpl.sampleSize;
    if (tpl.unit !== undefined) item.unit = tpl.unit;
    if (tpl.nominalValue !== undefined) item.nominalValue = tpl.nominalValue;
    if (tpl.upperTolerance !== undefined) item.upperTolerance = tpl.upperTolerance;
    if (tpl.lowerTolerance !== undefined) item.lowerTolerance = tpl.lowerTolerance;

    // 待检工单：全部指标保持 PENDING，不得预填任何实测值
    if (decision === undefined) {
      return item;
    }
    // 检验中工单：仅首项已录入实测值，其余仍待检
    if (decision === 'INSPECTING' && index > 0) {
      return item;
    }

    // 判退工单取首项作为超上限的不合格项，其余项按标准基准值判定合格
    const isFailingItem = decision === 'FAILED' && index === 0;

    if (tpl.dataType === 'NUMERIC') {
      if (tpl.nominalValue === undefined) {
        return item; // 缺少标准基准值，无法评定，保持待检
      }
      item.measuredVal = isFailingItem
        ? tpl.nominalValue + (tpl.upperTolerance ?? 0) + 0.5
        : tpl.nominalValue;
      item.result = isFailingItem ? 'FAILED' : 'PASSED';
      return item;
    }

    // 文本与定性项：用标准判定语的首个可选项作为合格实测值
    const options = (tpl.standardText ?? '合格').split(/[,，/|]/).map((s) => s.trim());
    item.measuredText = isFailingItem ? '不合格' : (options[0] ?? '合格');
    item.result = isFailingItem ? 'FAILED' : 'PASSED';
    return item;
  });
}

export const mockDatabase: {
  orders: InspectionOrder[];
  plans: InspectionPlan[];
  iqcItems: InspectionItem[];
  reviewFlows: ReviewFlow[];
  mrbReviews: MRBReview[];
  permissions: MaterialPermission[];
  auditLogs: AuditLog[];
  traceNodes: TraceNode[];
  traceEdges: TraceEdge[];
  processTemplates: ProcessTemplate[];
  mesConfig: MesGatewayConfig;
} = {
  // ==========================================================================
  // 检验工单：覆盖放行关卡的全部判定分支
  //   合格放行 / 检验中阻断 / 未送检阻断 / 不合格阻断 / MRB 评审中阻断 / 特采放行
  // ==========================================================================
  orders: [
    {
      id: 'd1a8e100-1111-4111-8111-000000000001',
      orderNo: 'IQC-20260714-0004',
      inspectionType: 'IQC',
      status: 'PENDING',
      materialCode: '000010000800001',
      materialName: '六角螺栓 M33',
      batchNo: 'SJ-2024-11-21-00001',
      supplierCode: 'SUP-001',
      sampleQty: 60,
      passQty: 0,
      failQty: 0,
      isMandatoryGate: false,
      inspectorId: undefined,
      inspectionNotes: undefined,
      planVersionId: PLAN_VERSIONS.IQC_BOLT.versionId,
      planSnapshot: buildSnapshot('IQC_BOLT'),
      items: buildItems('IQC_BOLT'),
      createdAt: '2026-07-14T08:30:00Z',
      updatedAt: '2026-07-14T08:30:00Z',
    },
    {
      id: 'd1a8e100-1111-4111-8111-000000000002',
      orderNo: 'IQC-20260714-0003',
      inspectionType: 'IQC',
      status: 'INSPECTING',
      materialCode: '000010000801701',
      materialName: '平垫圈 M30',
      batchNo: 'SJ-2024-11-21-00002',
      supplierCode: 'SUP-001',
      sampleQty: 58,
      passQty: 58,
      failQty: 0,
      isMandatoryGate: false,
      inspectorId: 'e1a8e100-1111-4111-8111-000000000001',
      inspectionNotes: '首批外观与膜厚抽检中',
      planVersionId: PLAN_VERSIONS.IQC_BOLT.versionId,
      planSnapshot: buildSnapshot('IQC_BOLT'),
      items: buildItems('IQC_BOLT', 'INSPECTING'),
      createdAt: '2026-07-14T09:00:00Z',
      updatedAt: '2026-07-14T09:15:00Z',
    },
    {
      id: 'd1a8e100-1111-4111-8111-000000000003',
      orderNo: 'IPQC-CT-20260706-0001',
      inspectionType: 'IPQC_CT',
      status: 'PENDING',
      materialCode: 'CL-001',
      materialName: '不锈钢棒料 Φ25',
      batchNo: 'WO-20260706-01',
      sampleQty: 500,
      passQty: 0,
      failQty: 0,
      isMandatoryGate: false,
      planVersionId: PLAN_VERSIONS.IPQC_CT.versionId,
      planSnapshot: buildSnapshot('IPQC_CT'),
      items: buildItems('IPQC_CT'),
      createdAt: '2026-07-06T08:30:00Z',
      updatedAt: '2026-07-06T08:30:00Z',
    },
    {
      id: 'd1a8e100-1111-4111-8111-000000000004',
      orderNo: 'IPQC-FN-20260706-0001',
      inspectionType: 'IPQC_FN',
      status: 'PENDING',
      materialCode: 'CP-001',
      materialName: '六角螺栓 M10×45',
      batchNo: 'WO-20260706-02',
      sampleQty: 500,
      passQty: 0,
      failQty: 0,
      isMandatoryGate: true, // 核心强制阻断关卡
      planVersionId: PLAN_VERSIONS.OQC_SF.versionId,
      planSnapshot: buildSnapshot('OQC_SF'),
      items: buildItems('OQC_SF'),
      createdAt: '2026-07-06T14:00:00Z',
      updatedAt: '2026-07-06T14:00:00Z',
    },
    {
      // 成品检合格并已结单归档 -> 关卡放行
      id: 'd1a8e100-1111-4111-8111-000000000005',
      orderNo: 'OQC-SF-20260706-0001',
      inspectionType: 'OQC_SF',
      status: 'COMPLETED',
      materialCode: 'CP-001',
      materialName: '六角螺栓 M10×45',
      batchNo: 'LOT-20260706-002',
      customerCode: 'CUS-001',
      sampleQty: 125,
      passQty: 125,
      failQty: 0,
      isMandatoryGate: true,
      overallDecision: 'PASSED',
      inspectorId: 'e1a8e100-1111-4111-8111-000000000001',
      inspectionNotes: '成品全检合格，准予放行',
      planVersionId: PLAN_VERSIONS.OQC_SF.versionId,
      planSnapshot: buildSnapshot('OQC_SF'),
      items: buildItems('OQC_SF', 'PASSED'),
      createdAt: '2026-07-06T09:00:00Z',
      updatedAt: '2026-07-06T11:30:00Z',
    },
    {
      // 成品检不合格且已结单，无 MRB 特采 -> 关卡 409 GATE_FAILED
      id: 'd1a8e100-1111-4111-8111-000000000006',
      orderNo: 'OQC-SF-20260706-0002',
      inspectionType: 'OQC_SF',
      status: 'COMPLETED',
      materialCode: 'CP-001',
      materialName: '六角螺栓 M10×45',
      batchNo: 'LOT-20260706-003',
      customerCode: 'CUS-001',
      sampleQty: 125,
      passQty: 120,
      failQty: 5,
      isMandatoryGate: true,
      overallDecision: 'FAILED',
      inspectorId: 'e1a8e100-1111-4111-8111-000000000001',
      inspectionNotes: '对边宽度超上限，判定不合格',
      planVersionId: PLAN_VERSIONS.OQC_SF.versionId,
      planSnapshot: buildSnapshot('OQC_SF'),
      items: buildItems('OQC_SF', 'FAILED'),
      createdAt: '2026-07-06T09:10:00Z',
      updatedAt: '2026-07-06T12:00:00Z',
    },
    {
      // 不合格正在 MRB 评审中 -> 关卡 409 GATE_UNDER_MRB
      id: 'd1a8e100-1111-4111-8111-000000000007',
      orderNo: 'OQC-SF-20260706-0003',
      inspectionType: 'OQC_SF',
      status: 'IN_MRB_REVIEW',
      materialCode: 'CP-001',
      materialName: '六角螺栓 M10×45',
      batchNo: 'LOT-20260706-004',
      customerCode: 'CUS-001',
      sampleQty: 125,
      passQty: 118,
      failQty: 7,
      isMandatoryGate: true,
      overallDecision: 'FAILED',
      inspectorId: 'e1a8e100-1111-4111-8111-000000000001',
      inspectionNotes: '外观锈蚀，已发起 MRB 会签',
      planVersionId: PLAN_VERSIONS.OQC_SF.versionId,
      planSnapshot: buildSnapshot('OQC_SF'),
      items: buildItems('OQC_SF', 'FAILED'),
      createdAt: '2026-07-06T09:20:00Z',
      updatedAt: '2026-07-06T13:00:00Z',
    },
    {
      // 不合格经 MRB 判定让步接收(CONCESSION) -> 关卡受限放行
      id: 'd1a8e100-1111-4111-8111-000000000008',
      orderNo: 'OQC-SF-20260706-0004',
      inspectionType: 'OQC_SF',
      status: 'COMPLETED',
      materialCode: 'CP-001',
      materialName: '六角螺栓 M10×45',
      batchNo: 'LOT-20260706-005',
      customerCode: 'CUS-001',
      sampleQty: 125,
      passQty: 123,
      failQty: 2,
      isMandatoryGate: true,
      overallDecision: 'FAILED',
      inspectorId: 'e1a8e100-1111-4111-8111-000000000001',
      inspectionNotes: '轻微色差，客户已书面同意特采',
      planVersionId: PLAN_VERSIONS.OQC_SF.versionId,
      planSnapshot: buildSnapshot('OQC_SF'),
      items: buildItems('OQC_SF', 'FAILED'),
      createdAt: '2026-07-06T09:30:00Z',
      updatedAt: '2026-07-06T14:00:00Z',
    },
    {
      // 成品检进行中 -> 关卡 409 GATE_INSPECTING
      id: 'd1a8e100-1111-4111-8111-000000000009',
      orderNo: 'OQC-SF-20260706-0005',
      inspectionType: 'OQC_SF',
      status: 'INSPECTING',
      materialCode: 'CP-001',
      materialName: '六角螺栓 M10×45',
      batchNo: 'LOT-20260706-006',
      customerCode: 'CUS-001',
      sampleQty: 125,
      passQty: 0,
      failQty: 0,
      isMandatoryGate: true,
      inspectorId: 'e1a8e100-1111-4111-8111-000000000001',
      inspectionNotes: '成品全检进行中',
      planVersionId: PLAN_VERSIONS.OQC_SF.versionId,
      planSnapshot: buildSnapshot('OQC_SF'),
      items: buildItems('OQC_SF', 'INSPECTING'),
      createdAt: '2026-07-06T15:00:00Z',
      updatedAt: '2026-07-06T15:10:00Z',
    },
  ],

  // ==========================================================================
  // 质检方案库 (InspectionPlan + 版本化指标)
  // ==========================================================================
  plans: [
    {
      id: PLAN_VERSIONS.IQC_BOLT.planId,
      planCode: PLAN_VERSIONS.IQC_BOLT.planCode,
      planName: PLAN_VERSIONS.IQC_BOLT.planName,
      inspectionType: 'IQC',
      materialCode: '000010000800001',
      versions: [
        {
          id: PLAN_VERSIONS.IQC_BOLT.versionId,
          planId: PLAN_VERSIONS.IQC_BOLT.planId,
          versionNo: PLAN_VERSIONS.IQC_BOLT.versionNo,
          status: 'ACTIVE',
          samplingScheme: PLAN_VERSIONS.IQC_BOLT.samplingScheme,
          aqlLevel: PLAN_VERSIONS.IQC_BOLT.aqlLevel,
          strictness: PLAN_VERSIONS.IQC_BOLT.strictness,
          items: [...SNAPSHOT_ITEMS.IQC_BOLT],
          createdBy: 'e1a8e100-1111-4111-8111-000000000002',
          createdAt: '2026-07-01T08:00:00Z',
        },
      ],
      createdAt: '2026-07-01T08:00:00Z',
      updatedAt: '2026-07-01T08:00:00Z',
    },
    {
      id: PLAN_VERSIONS.IPQC_CT.planId,
      planCode: PLAN_VERSIONS.IPQC_CT.planCode,
      planName: PLAN_VERSIONS.IPQC_CT.planName,
      inspectionType: 'IPQC_CT',
      materialCode: 'CL-001',
      versions: [
        {
          id: PLAN_VERSIONS.IPQC_CT.versionId,
          planId: PLAN_VERSIONS.IPQC_CT.planId,
          versionNo: PLAN_VERSIONS.IPQC_CT.versionNo,
          status: 'ACTIVE',
          samplingScheme: PLAN_VERSIONS.IPQC_CT.samplingScheme,
          aqlLevel: PLAN_VERSIONS.IPQC_CT.aqlLevel,
          strictness: PLAN_VERSIONS.IPQC_CT.strictness,
          items: [...SNAPSHOT_ITEMS.IPQC_CT],
          createdBy: 'e1a8e100-1111-4111-8111-000000000002',
          createdAt: '2026-07-02T08:00:00Z',
        },
      ],
      createdAt: '2026-07-02T08:00:00Z',
      updatedAt: '2026-07-02T08:00:00Z',
    },
    {
      id: PLAN_VERSIONS.OQC_SF.planId,
      planCode: PLAN_VERSIONS.OQC_SF.planCode,
      planName: PLAN_VERSIONS.OQC_SF.planName,
      inspectionType: 'OQC_SF',
      materialCode: 'CP-001',
      versions: [
        {
          // 已作废的历史版本，用于验证版本状态过滤
          id: 'a1000000-0000-4000-8000-000000000201',
          planId: PLAN_VERSIONS.OQC_SF.planId,
          versionNo: 'v1.0.0',
          status: 'INACTIVE',
          samplingScheme: 'GB_T_2828',
          aqlLevel: 'II',
          strictness: 'NORMAL',
          items: [...SNAPSHOT_ITEMS.OQC_SF],
          createdBy: 'e1a8e100-1111-4111-8111-000000000002',
          createdAt: '2026-06-01T08:00:00Z',
        },
        {
          id: PLAN_VERSIONS.OQC_SF.versionId,
          planId: PLAN_VERSIONS.OQC_SF.planId,
          versionNo: PLAN_VERSIONS.OQC_SF.versionNo,
          status: 'ACTIVE',
          samplingScheme: PLAN_VERSIONS.OQC_SF.samplingScheme,
          aqlLevel: PLAN_VERSIONS.OQC_SF.aqlLevel,
          strictness: PLAN_VERSIONS.OQC_SF.strictness,
          items: [...SNAPSHOT_ITEMS.OQC_SF],
          createdBy: 'e1a8e100-1111-4111-8111-000000000002',
          createdAt: '2026-07-03T08:00:00Z',
        },
      ],
      createdAt: '2026-06-01T08:00:00Z',
      updatedAt: '2026-07-03T08:00:00Z',
    },
  ],

  // 指标录入演示数据 (化学成分 + 外观)
  iqcItems: [
    {
      seq: 2,
      itemCode: 'ITEM-CHEM-C',
      name: '化学成分 - C(碳)',
      metricCategory: 'CHEMICAL_COMPOSITION',
      dataType: 'NUMERIC',
      standardText: '0.38% ~ 0.45%',
      nominalValue: 0.4,
      upperTolerance: 0.05,
      lowerTolerance: 0.02,
      sampleSize: 5,
      measuredVal: 0.42,
      unit: '%',
      result: 'PASSED',
      remark: '化学直读光谱分析',
    },
    {
      seq: 3,
      itemCode: 'ITEM-APPEARANCE',
      name: '外观裂纹检验',
      metricCategory: 'APPEARANCE',
      dataType: 'QUALITATIVE',
      standardText: '合格,OK,Pass',
      sampleSize: 10,
      measuredText: '合格',
      unit: '—',
      result: 'PASSED',
      remark: '目视检查 100% 合格',
    },
  ],

  // 评审流定义 (ReviewFlow + nodes)
  reviewFlows: [
    {
      id: 'f1a8e100-2222-4222-8222-000000000001',
      flowCode: 'FL-001',
      flowName: '来料不合格三级评审',
      applicableType: 'INCOMING_FAIL',
      version: 'v1.0.0',
      isActive: true,
      nodes: [
        { nodeLevel: 1, nodeName: '品质工程师初审', roleCode: 'QE', requireCustomerSign: false },
        { nodeLevel: 2, nodeName: '技术部工程评审', roleCode: 'TECH_DEPT', requireCustomerSign: false },
        { nodeLevel: 3, nodeName: '质量总监核准', roleCode: 'QM_DIRECTOR', requireCustomerSign: false },
      ],
    },
    {
      id: 'f1a8e100-2222-4222-8222-000000000002',
      flowCode: 'FL-002',
      flowName: '过程工序不合格二级评审',
      applicableType: 'PROCESS_FAIL',
      version: 'v1.0.0',
      isActive: true,
      nodes: [
        { nodeLevel: 1, nodeName: '工艺工程师评审', roleCode: 'PE', requireCustomerSign: false },
        { nodeLevel: 2, nodeName: '生产主管核准', roleCode: 'PROD_MANAGER', requireCustomerSign: false },
      ],
    },
    {
      id: 'f1a8e100-2222-4222-8222-000000000003',
      flowCode: 'FL-003',
      flowName: '出货不合格特采严格会签',
      applicableType: 'SHIPMENT_FAIL',
      version: 'v1.0.0',
      isActive: true,
      nodes: [
        { nodeLevel: 1, nodeName: '品质工程师初审', roleCode: 'QE', requireCustomerSign: false },
        { nodeLevel: 2, nodeName: '技术部工程评审', roleCode: 'TECH_DEPT', requireCustomerSign: false },
        { nodeLevel: 3, nodeName: '客户代表书面签核', roleCode: 'CUSTOMER_REP', requireCustomerSign: true },
      ],
    },
    {
      id: 'f1a8e100-2222-4222-8222-000000000004',
      flowCode: 'FL-004',
      flowName: '委外加工不合格三级评审',
      applicableType: 'SUBCONTRACT_FAIL',
      version: 'v1.0.0',
      isActive: false,
      nodes: [
        { nodeLevel: 1, nodeName: '采购工程师评审', roleCode: 'BUYER', requireCustomerSign: false },
        { nodeLevel: 2, nodeName: '供应商质量工程师评审', roleCode: 'SQE', requireCustomerSign: false },
        { nodeLevel: 3, nodeName: '质量总监核准', roleCode: 'QM_DIRECTOR', requireCustomerSign: false },
      ],
    },
  ],

  // MRB 评审单：覆盖 评审中 / 让步接收已处置 / 返工已处置 三种关键分支
  mrbReviews: [
    {
      // 对应 LOT-20260706-004：仍在会签 -> 放行关卡 409 GATE_UNDER_MRB
      id: 'b1a8e100-3333-4333-8333-000000000001',
      mrbNo: 'MRB20260706-001',
      sourceType: 'SHIPMENT_FAIL',
      sourceOrderNo: 'OQC-SF-20260706-0003',
      batchNo: 'LOT-20260706-004',
      materialCode: 'CP-001',
      materialName: '六角螺栓 M10×45',
      defectDescription: '外观锈蚀，超出外观检验标准',
      defectQty: 7,
      status: 'PENDING_REVIEW',
      approvers: [],
      createdAt: '2026-07-06T13:00:00Z',
      updatedAt: '2026-07-06T13:00:00Z',
    },
    {
      // 对应 LOT-20260706-005：让步接收已处置 -> 放行关卡受限放行
      id: 'b1a8e100-3333-4333-8333-000000000002',
      mrbNo: 'MRB20260706-002',
      sourceType: 'SHIPMENT_FAIL',
      sourceOrderNo: 'OQC-SF-20260706-0004',
      batchNo: 'LOT-20260706-005',
      materialCode: 'CP-001',
      materialName: '六角螺栓 M10×45',
      defectDescription: '表面色差，不影响装配性能',
      defectQty: 2,
      status: 'DISPOSED',
      disposition: 'CONCESSION',
      dispositionNotes: '经工程评审并取得客户书面同意书，判定让步接收',
      approvers: [
        {
          userId: 'e1a8e100-1111-4111-8111-000000000003',
          userName: '李技术',
          roleCode: 'TECH_LEAD',
          action: 'APPROVED',
          comment: '色差不影响总装与防腐性能，同意让步接收',
          signedAt: '2026-07-06T14:00:00Z',
        },
      ],
      concessionAttachmentUrl: 'https://letian-qms.com/attachments/concession-20260706-002.pdf',
      createdAt: '2026-07-06T13:30:00Z',
      updatedAt: '2026-07-06T14:00:00Z',
    },
    {
      // 对应 LOT-20260706-003：返工已处置（非 CONCESSION）-> 放行关卡仍 409 GATE_FAILED
      id: 'b1a8e100-3333-4333-8333-000000000003',
      mrbNo: 'MRB20260706-003',
      sourceType: 'SHIPMENT_FAIL',
      sourceOrderNo: 'OQC-SF-20260706-0002',
      batchNo: 'LOT-20260706-003',
      materialCode: 'CP-001',
      materialName: '六角螺栓 M10×45',
      defectDescription: '对边宽度超上限，需返工重制',
      defectQty: 5,
      status: 'DISPOSED',
      disposition: 'REWORK',
      dispositionNotes: '退回冷镦工序返工后重新报检',
      approvers: [
        {
          userId: 'e1a8e100-1111-4111-8111-000000000004',
          userName: '陈工艺',
          roleCode: 'PE',
          action: 'APPROVED',
          comment: '同意返工处理，返工后按复检流程处理',
          signedAt: '2026-07-06T12:30:00Z',
        },
      ],
      createdAt: '2026-07-06T12:10:00Z',
      updatedAt: '2026-07-06T12:30:00Z',
    },
  ],

  permissions: [
    {
      id: 'c1a8e100-4444-4444-8444-000000000001',
      userId: 'e1a8e100-1111-4111-8111-000000000001',
      userName: '张检验',
      roleCode: 'IQC_INSPECTOR',
      materialCategories: ['原材料'],
      materialCodes: ['CL-001', 'CL-002', 'CL-003'],
      supplierCodes: ['无锡超匠工光轴制造有限公司', '宝钢股份'],
      isActive: true,
    },
  ],

  // 审计日志 (AuditActionEnum / AuditStatusEnum 取值)
  auditLogs: [
    {
      id: 'a1a8e100-5555-4555-8555-000000000001',
      traceId: 'req-20260724-0001',
      userId: '00000000-0000-0000-0000-000000000000', // SYSTEM_USER_ID
      userName: 'system',
      action: 'SYNC_TRIGGER',
      resourceType: 'ERP_SUPPLIERS',
      resourceId: 'SYNC_BATCH_400',
      status: 'SUCCESS',
      diffPatch: { recordsCount: 400 },
      createdAt: '2026-07-24T11:23:20Z',
    },
    {
      id: 'a1a8e100-5555-4555-8555-000000000002',
      traceId: 'req-20260706-0001',
      userId: 'e1a8e100-1111-4111-8111-000000000001',
      userName: '张检验',
      action: 'STATUS_CHANGE',
      resourceType: 'INSPECTION_ORDER',
      resourceId: 'OQC-SF-20260706-0002',
      status: 'SUCCESS',
      diffPatch: { status: 'INSPECTING -> FAILED', overallDecision: 'FAILED' },
      createdAt: '2026-07-06T12:00:00Z',
    },
    {
      id: 'a1a8e100-5555-4555-8555-000000000003',
      traceId: 'req-20260706-0002',
      userId: 'e1a8e100-1111-4111-8111-000000000003',
      userName: '李技术',
      action: 'DISPOSE',
      resourceType: 'MRB_RECORD',
      resourceId: 'MRB20260706-002',
      status: 'SUCCESS',
      diffPatch: { disposition: 'CONCESSION', status: 'DISPOSED' },
      createdAt: '2026-07-06T14:00:00Z',
    },
    {
      id: 'a1a8e100-5555-4555-8555-000000000004',
      traceId: 'req-20260706-0003',
      userId: '00000000-0000-0000-0000-000000000000',
      userName: 'system',
      action: 'GATE_BLOCKED',
      resourceType: 'RELEASE_GATE',
      resourceId: 'LOT-20260706-003',
      status: 'REJECTED',
      diffPatch: { code: 'gate-failed', batchNo: 'LOT-20260706-003' },
      createdAt: '2026-07-06T12:05:00Z',
    },
  ],

  // ==========================================================================
  // 批次全生命周期追溯 DAG (7 节点 / 6 条有向边)
  // 覆盖全部 5 类 TraceRelationType，含委外加工分支
  // ==========================================================================
  traceNodes: [
    {
      nodeId: 'node-raw-01',
      batchNo: 'RAW-20260701-01',
      stageName: '原材料来料检(IQC)',
      materialName: '冷镦钢 10B21',
      operatorName: '张检验',
      timestamp: '2026-07-01 09:00',
      nodeStatus: 'PASSED',
      orderNo: 'IQC-20260701-0001',
      supplierOrCustomer: '宝钢股份',
    },
    {
      nodeId: 'node-ct-01',
      batchNo: 'CT-20260702-01',
      stageName: '下料检验(IPQC_CT)',
      materialName: '不锈钢棒料 Φ25',
      operatorName: '陈操作',
      timestamp: '2026-07-02 10:30',
      nodeStatus: 'PASSED',
      orderNo: 'IPQC-CT-20260702-0001',
    },
    {
      nodeId: 'node-rl-01',
      batchNo: 'RL-20260703-01',
      stageName: '冷镦成型检验(IPQC_RL)',
      materialName: '六角螺栓半成品',
      operatorName: '刘操作',
      timestamp: '2026-07-03 11:00',
      nodeStatus: 'PASSED',
      orderNo: 'IPQC-RL-20260703-0001',
    },
    {
      nodeId: 'node-fn-01',
      batchNo: 'FN-20260706-01',
      stageName: '搓丝热处理检验(IPQC_FN)',
      materialName: '六角螺栓 M10×45',
      operatorName: '终检组A',
      timestamp: '2026-07-06 14:00',
      nodeStatus: 'PASSED',
      orderNo: 'IPQC-FN-20260706-0001',
    },
    {
      nodeId: 'node-os-01',
      batchNo: 'OS-20260704-01',
      stageName: '委外表面处理(达克罗)',
      materialName: '六角螺栓 M10×45',
      operatorName: '无锡超匠工光轴制造有限公司',
      timestamp: '2026-07-04 16:20',
      nodeStatus: 'PASSED',
      orderNo: 'OS-20260704-0001',
      supplierOrCustomer: '无锡超匠工光轴制造有限公司',
    },
    {
      nodeId: 'node-oqc-01',
      batchNo: 'FN-20260706-02',
      stageName: '成品出厂全检(OQC_SF)',
      materialName: '六角螺栓 M10×45',
      operatorName: '张检验',
      timestamp: '2026-07-06 18:40',
      nodeStatus: 'PASSED',
      orderNo: 'OQC-SF-20260706-0001',
    },
    {
      nodeId: 'node-store-01',
      batchNo: 'LOT-20260706-002',
      stageName: '成品入库(STORED)',
      materialName: '六角螺栓 M10×45',
      operatorName: '仓管员B',
      timestamp: '2026-07-06 20:10',
      nodeStatus: 'STORED',
      orderNo: 'OQC-SF-20260706-0001',
    },
  ],

  traceEdges: [
    {
      id: 'e1a8e100-6666-4666-8666-000000000001',
      sourceBatchNo: 'RAW-20260701-01',
      targetBatchNo: 'CT-20260702-01',
      relationType: 'RAW_TO_PROCESS',
      depth: 1,
      isCycle: false,
      hasCycleWarning: false,
    },
    {
      id: 'e1a8e100-6666-4666-8666-000000000002',
      sourceBatchNo: 'CT-20260702-01',
      targetBatchNo: 'RL-20260703-01',
      relationType: 'PROCESS_TO_PROCESS',
      depth: 2,
      isCycle: false,
      hasCycleWarning: false,
    },
    {
      id: 'e1a8e100-6666-4666-8666-000000000003',
      sourceBatchNo: 'RL-20260703-01',
      targetBatchNo: 'FN-20260706-01',
      relationType: 'PROCESS_TO_PROCESS',
      depth: 3,
      isCycle: false,
      hasCycleWarning: false,
    },
    {
      id: 'e1a8e100-6666-4666-8666-000000000004',
      sourceBatchNo: 'FN-20260706-01',
      targetBatchNo: 'OS-20260704-01',
      relationType: 'PROCESS_TO_OUTSOURCE',
      depth: 4,
      isCycle: false,
      hasCycleWarning: false,
    },
    {
      id: 'e1a8e100-6666-4666-8666-000000000005',
      sourceBatchNo: 'OS-20260704-01',
      targetBatchNo: 'FN-20260706-02',
      relationType: 'OUTSOURCE_TO_FINISH',
      depth: 5,
      isCycle: false,
      hasCycleWarning: false,
    },
    {
      id: 'e1a8e100-6666-4666-8666-000000000006',
      sourceBatchNo: 'FN-20260706-02',
      targetBatchNo: 'LOT-20260706-002',
      relationType: 'FINISH_TO_SHIPMENT',
      depth: 6,
      isCycle: false,
      hasCycleWarning: false,
    },
  ],

  // 工序质检配置模板
  processTemplates: [
    {
      id: 'd1a8e100-7777-4777-8777-000000000001',
      processCode: 'PROC-CT',
      processName: '下料',
      inspectionType: 'IPQC_CT',
      isMandatoryGate: false,
      defaultSampleQty: 8,
      checkItems: [
        {
          itemCode: 'ITEM-LEN-TOTAL',
          name: '下料总长度',
          standardText: '50.00 ± 0.20 mm',
          nominalValue: 50.0,
          upperTolerance: 0.2,
          lowerTolerance: 0.2,
        },
      ],
      createdAt: '2026-07-01T08:00:00Z',
      updatedAt: '2026-07-01T08:00:00Z',
    },
    {
      id: 'd1a8e100-7777-4777-8777-000000000002',
      processCode: 'PROC-FN',
      processName: '搓丝成型',
      inspectionType: 'IPQC_FN',
      isMandatoryGate: true,
      defaultSampleQty: 5,
      checkItems: [
        {
          itemCode: 'ITEM-HEX-AF',
          name: '对边宽度',
          standardText: '19.00 ± 0.10 mm',
          nominalValue: 19.0,
          upperTolerance: 0.1,
          lowerTolerance: 0.1,
        },
      ],
      createdAt: '2026-07-01T08:00:00Z',
      updatedAt: '2026-07-01T08:00:00Z',
    },
  ],

  // MES 网关联调配置
  mesConfig: {
    id: 'e1a8e100-8888-4888-8888-000000000001',
    mesEndpointUrl: 'https://mes.letian.com/api/v1/gateway',
    authSecretKey: 'mes-secret-2026',
    syncIntervalMinutes: 15,
    enableAutoGateCheck: true,
    isConnected: true,
    updatedAt: '2026-07-06T08:00:00Z',
  },
};

// ============================================================================
// 导出便于后端控制器引用的命名常量集合
//
// 每个导出都显式标注契约 DTO 类型：契约 DTO 是 z.infer 推导出的映射类型，
// 若不标注，声明产物会把它们展开成匿名结构类型，消费方拿到的就不再是契约类型
// 本身，跨包赋值会因「同名却互不相关的两个类型」而失败。
// ============================================================================

export const MOCK_INSPECTION_ORDERS: InspectionOrder[] = mockDatabase.orders;
export const MOCK_INSPECTION_PLANS: InspectionPlan[] = mockDatabase.plans;
export const MOCK_MRB_RECORDS: MRBReview[] = mockDatabase.mrbReviews;
export const MOCK_REVIEW_FLOWS: ReviewFlow[] = mockDatabase.reviewFlows;
export const MOCK_AUDIT_LOGS: AuditLog[] = mockDatabase.auditLogs;
export const MOCK_PERMISSIONS: MaterialPermission[] = mockDatabase.permissions;
export const MOCK_PROCESS_TEMPLATES: ProcessTemplate[] = mockDatabase.processTemplates;
export const MOCK_MES_CONFIGS: MesGatewayConfig = mockDatabase.mesConfig;

/**
 * 审计统计卡片快照 (AuditStatsResponse)
 * 控制器在实时统计结果为 0 时回退到该快照，保证看板卡片不出现空态。
 */
export const MOCK_AUDIT_STATS: AuditStatsResponse = {
  totalLogs: 4,
  successCount: 3,
  failedCount: 1,
  todayCount: 4,
};

/**
 * 质量总览看板聚合快照
 * 实时统计结果的回退值，字段与 dashboard 控制器响应保持一致。
 */
export const MOCK_DASHBOARD_OVERVIEW = {
  totalInspections: 9,
  passRate: 11.11,
  pendingCount: 3,
  inMRBCount: 1,
  stageDistribution: {
    iqcCount: 2,
    ipqcCount: 2,
    oqcCount: 5,
  },
  trendSeries: [
    { date: '2026-07-01', iqcCount: 1, ipqcCount: 0, oqcCount: 0, passRate: 100 },
    { date: '2026-07-02', iqcCount: 0, ipqcCount: 1, oqcCount: 0, passRate: 100 },
    { date: '2026-07-03', iqcCount: 0, ipqcCount: 0, oqcCount: 1, passRate: 100 },
    { date: '2026-07-04', iqcCount: 0, ipqcCount: 0, oqcCount: 1, passRate: 100 },
    { date: '2026-07-06', iqcCount: 0, ipqcCount: 1, oqcCount: 3, passRate: 60 },
    { date: '2026-07-14', iqcCount: 2, ipqcCount: 0, oqcCount: 0, passRate: 0 },
  ],
  topDefects: [
    { defectName: '对边宽度超上限', category: 'DIMENSION', count: 5 },
    { defectName: '外观锈蚀', category: 'APPEARANCE', count: 7 },
    { defectName: '表面色差', category: 'APPEARANCE', count: 2 },
  ],
  recentActivities: [
    {
      id: 'act-1',
      type: 'INSPECTION',
      title: 'IQC-20260714-0004 六角螺栓 M33 检验完成',
      status: 'PASSED',
      timestamp: '2026-07-14T09:30:00Z',
    },
    {
      id: 'act-2',
      type: 'MRB',
      title: 'MRB20260706-001 发起特采会签评审',
      status: 'UNDER_REVIEW',
      timestamp: '2026-07-14T10:15:00Z',
    },
  ],
};

/**
 * 预置的批次追溯全景图 (按批次号索引)
 * 未预置的批次由 trace 控制器依据检验单与 MRB 动态推导。
 */
export const MOCK_TRACE_TREES: Record<string, {
  batchNo: string;
  hasCycle: boolean;
  nodes: readonly TraceNode[];
  edges: readonly TraceEdge[];
  aqlInfo: { batchSize: number; inspectionLevel: string; sampleSize: number; ac: number; re: number };
}> = {
  'LOT-20260706-002': {
    batchNo: 'LOT-20260706-002',
    hasCycle: false,
    nodes: mockDatabase.traceNodes,
    edges: mockDatabase.traceEdges,
    aqlInfo: {
      batchSize: 3000,
      inspectionLevel: 'II',
      sampleSize: 125,
      ac: 3,
      re: 4,
    },
  },
  'RAW-20260701-01': {
    batchNo: 'RAW-20260701-01',
    hasCycle: false,
    nodes: mockDatabase.traceNodes,
    edges: mockDatabase.traceEdges,
    aqlInfo: {
      batchSize: 3000,
      inspectionLevel: 'II',
      sampleSize: 125,
      ac: 3,
      re: 4,
    },
  },
};
