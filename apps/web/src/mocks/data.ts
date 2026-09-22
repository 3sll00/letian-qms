import {
  InspectionOrderSchema,
  MRBReviewSchema,
  PendingDefectItemSchema,
  ReviewFlowSchema,
  InspectionPlanSchema,
  TraceabilityGraphResponseSchema,
  TraceBatchSearchResponseSchema,
  TraceOrderChainResponseSchema,
  IntegrationConfigSchema,
  IntegrationSyncLogSchema,
  MaterialSchema,
  SupplierSchema,
  CustomerSchema,
  WorkshopSchema,
  EmployeeSchema,
  InventoryCategorySchema,
  type InspectionOrder,
  type MRBReview,
  type TraceabilityGraphResponse,
  type TraceBatchSearchResponse,
  type TraceOrderChainResponse,
  type IntegrationConfig,
  type IntegrationSyncLog,
  type Material,
  type Supplier,
  type Customer,
  type Workshop,
  type Employee,
  type InventoryCategory,
  type CompanyProfile,
  type InspectionPlan,
  type PendingDefectItem,
  type ReviewFlow,
  type InspectionPlanItem,
  type InspectionType,
  type MetricCategory,
  type PlanVersionStatus,
  type PlanStatus,
} from '@letian/contracts';

// ==========================================
// 1. INSPECTION ORDER MOCK DATA (Zod Validated)
// ==========================================

export const rawInspectionOrders = [
  {
    id: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    orderNo: 'INS-20231012-0001',
    inspectionType: 'IQC' as const,
    materialCode: 'MAT-304SS-05',
    materialName: '不锈钢线材 Φ5.0mm',
    specification: 'Φ5.0mm / 盘圆 / 304HC',
    unit: 'KG',
    batchNo: 'B20231012-01',
    supplierCode: 'SUP-001',
    inboundNo: 'RK-20231012-001',
    inboundDate: '2023-10-12',
    customerCode: undefined,
    sampleQty: 50,
    passQty: 50,
    failQty: 0,
    isMandatoryGate: false,
    status: 'COMPLETED' as const,
    overallDecision: 'PASSED' as const,
    inspectorId: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
    inspectorName: '张强',
    inspectionNotes: '原材料常规抽样检验，尺寸与力学指标均合格',
    planVersionId: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
    planSnapshot: {
      planId: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
      planCode: 'QP-IQC-304SS-V2',
      planName: '不锈钢冷镦盘圆丝来料抽样规程',
      versionId: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
      versionNo: 'V2.4',
      samplingScheme: 'GB_T_2828',
      aqlLevel: 'II',
      strictness: 'NORMAL',
      snapshotAt: '2023-10-12T08:00:00.000Z',
      items: [
        {
          seq: 1,
          itemCode: 'DIA-001',
          name: '直径',
          dataType: 'NUMERIC' as const,
          metricCategory: 'DIMENSION' as const,
          standardText: 'Φ5.00±0.02mm',
          nominalValue: 5.0,
          upperTolerance: 0.02,
          lowerTolerance: -0.02,
          sampleSize: 50,
          unit: 'mm',
          isMandatory: true,
        },
        {
          seq: 2,
          itemCode: 'TEN-001',
          name: '抗拉强度',
          dataType: 'NUMERIC' as const,
          metricCategory: 'TENSILE_STRENGTH' as const,
          standardText: '≥650MPa',
          nominalValue: 650,
          upperTolerance: 200,
          lowerTolerance: 0,
          sampleSize: 5,
          unit: 'MPa',
          isMandatory: true,
        },
      ],
    },
    items: [
      {
        id: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
        seq: 1,
        itemCode: 'DIA-001',
        name: '直径',
        dataType: 'NUMERIC' as const,
        metricCategory: 'DIMENSION' as const,
        standardText: 'Φ5.00±0.02mm',
        nominalValue: 5.0,
        upperTolerance: 0.02,
        lowerTolerance: -0.02,
        sampleSize: 50,
        measuredVal: 5.01,
        unit: 'mm',
        result: 'PASSED' as const,
      },
      {
        id: 'e5f6a1b2-c3d4-4e5f-a06b-7c8d9e0f1a2b',
        seq: 2,
        itemCode: 'TEN-001',
        name: '抗拉强度',
        dataType: 'NUMERIC' as const,
        metricCategory: 'TENSILE_STRENGTH' as const,
        standardText: '≥650MPa',
        nominalValue: 650,
        upperTolerance: 200,
        lowerTolerance: 0,
        sampleSize: 5,
        measuredVal: 685,
        unit: 'MPa',
        result: 'PASSED' as const,
      },
    ],
    createdAt: '2023-10-12T08:00:00.000Z',
    updatedAt: '2023-10-12T08:45:00.000Z',
  },
  {
    id: 'f6a1b2c3-d4e5-4f6a-b17c-8d9e0f1a2b3c',
    orderNo: 'INS-20231012-0002',
    inspectionType: 'IPQC_CT' as const,
    // 007 过程检验下料工序台账列（docs/29 §2）：离线 Mock 与真实库同列同口径
    workOrderNo: 'WO-20231012-01',
    totalQty: 30000,
    blankingLength: 25.15,
    operatorName: '陈操作',
    operatorId: 'OP-0102',
    equipmentCode: 'EQ-CT-01',
    equipmentName: '1#全自动高速冷镦机',
    processStep: '自动断料',
    completedAt: '2023-10-12T09:30:00.000Z',
    materialCode: 'MAT-SCR-M6-25',
    materialName: '高强度螺柱 M6*25 (下料工序)',
    specification: 'M6*25 / 10.9级毛坯',
    unit: 'PCS',
    batchNo: 'B20231012-02',
    supplierCode: undefined,
    customerCode: undefined,
    sampleQty: 32,
    passQty: 24,
    failQty: 8,
    isMandatoryGate: false,
    status: 'COMPLETED' as const,
    overallDecision: 'FAILED' as const,
    inspectorId: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
    inspectorName: '李伟',
    inspectionNotes: '下料毛刺严重超标，端面倾斜 >0.5° (超差 32%)',
    planVersionId: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
    planSnapshot: {
      planId: 'e5f6a1b2-c3d4-4e5f-a06b-7c8d9e0f1a2b',
      planCode: 'QP-IPQC-CUT-V3',
      planName: '冷镦下料工序首巡检规范',
      versionId: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
      versionNo: 'V1.1',
      samplingScheme: 'GB_T_2828',
      aqlLevel: 'II',
      strictness: 'NORMAL',
      snapshotAt: '2023-10-12T09:00:00.000Z',
      items: [
        {
          seq: 1,
          itemCode: 'CUT-001',
          name: '切断长度',
          dataType: 'NUMERIC' as const,
          metricCategory: 'DIMENSION' as const,
          standardText: '25.00±0.10mm',
          nominalValue: 25.0,
          upperTolerance: 0.1,
          lowerTolerance: -0.1,
          sampleSize: 32,
          unit: 'mm',
          isMandatory: true,
        },
        {
          seq: 2,
          itemCode: 'BUR-001',
          name: '毛刺高度',
          dataType: 'NUMERIC' as const,
          metricCategory: 'APPEARANCE' as const,
          standardText: '≤0.05mm',
          nominalValue: 0.05,
          upperTolerance: 0.0,
          lowerTolerance: -0.05,
          sampleSize: 32,
          unit: 'mm',
          isMandatory: true,
        },
      ],
    },
    items: [
      {
        id: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
        seq: 1,
        itemCode: 'CUT-001',
        name: '切断长度',
        dataType: 'NUMERIC' as const,
        metricCategory: 'DIMENSION' as const,
        standardText: '25.00±0.10mm',
        nominalValue: 25.0,
        upperTolerance: 0.1,
        lowerTolerance: -0.1,
        sampleSize: 32,
        measuredVal: 25.42,
        unit: 'mm',
        result: 'FAILED' as const,
        defectReason: '切断长度 25.42mm 超出公差上限 25.10mm',
      },
      {
        id: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
        seq: 2,
        itemCode: 'BUR-001',
        name: '毛刺高度',
        dataType: 'NUMERIC' as const,
        metricCategory: 'APPEARANCE' as const,
        standardText: '≤0.05mm',
        nominalValue: 0.05,
        upperTolerance: 0.0,
        lowerTolerance: -0.05,
        sampleSize: 32,
        measuredVal: 0.18,
        unit: 'mm',
        result: 'FAILED' as const,
        defectReason: '毛刺高度 0.18mm 超出允许值 ≤0.05mm',
      },
    ],
    createdAt: '2023-10-12T09:00:00.000Z',
    updatedAt: '2023-10-12T09:30:00.000Z',
  },
  {
    id: 'e5f6a1b2-c3d4-4e5f-a06b-7c8d9e0f1a2b',
    orderNo: 'INS-20231012-0003',
    inspectionType: 'IPQC_FN' as const,
    // 007 过程检验成品检台账列（docs/30 §2）：MES工单号 / 数量 / 终检组 / 检测入库工序 / 报工时间
    workOrderNo: 'WO-20231012-01',
    totalQty: 60000,
    inspectionTeam: '终检一组',
    processStep: '检测入库',
    completedAt: '2023-10-12T11:00:00.000Z',
    materialCode: 'MAT-BLT-109-M10',
    materialName: '10.9级六角头螺栓 M10*45 (成品检)',
    specification: 'M10*45 / GB/T 5782 / 蓝白锌',
    unit: 'PCS',
    batchNo: 'B20231012-03',
    supplierCode: undefined,
    customerCode: 'CUST-002',
    sampleQty: 80,
    passQty: 79,
    failQty: 1,
    isMandatoryGate: true,
    status: 'IN_MRB_REVIEW' as const,
    overallDecision: 'FAILED' as const,
    inspectorId: 'f6a1b2c3-d4e5-4f6a-b17c-8d9e0f1a2b3c',
    inspectorName: '刘芳',
    inspectionNotes: '成品检 mandatoryGate=true 强制放行管控，抽检1件螺纹中径超差，触发MRB会签阻断',
    planVersionId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    planSnapshot: {
      planId: 'f6a1b2c3-d4e5-4f6a-b17c-8d9e0f1a2b3c',
      planCode: 'QP-FQC-AUTO-V4',
      planName: '六角头成品螺栓全尺寸与机械性能检验标准',
      versionId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
      versionNo: 'V3.0',
      samplingScheme: 'GB_T_2828',
      aqlLevel: 'II',
      strictness: 'NORMAL',
      snapshotAt: '2023-10-12T10:30:00.000Z',
      items: [
        {
          seq: 1,
          itemCode: 'THR-001',
          name: '螺纹中径',
          dataType: 'NUMERIC' as const,
          metricCategory: 'DIMENSION' as const,
          standardText: '9.026±0.03mm',
          nominalValue: 9.026,
          upperTolerance: 0.03,
          lowerTolerance: -0.03,
          sampleSize: 80,
          unit: 'mm',
          isMandatory: true,
        },
      ],
    },
    items: [
      {
        id: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
        seq: 1,
        itemCode: 'THR-001',
        name: '螺纹中径',
        dataType: 'NUMERIC' as const,
        metricCategory: 'DIMENSION' as const,
        standardText: '9.026±0.03mm',
        nominalValue: 9.026,
        upperTolerance: 0.03,
        lowerTolerance: -0.03,
        sampleSize: 80,
        measuredVal: 9.068,
        unit: 'mm',
        result: 'FAILED' as const,
        defectReason: '螺纹中径 9.068mm 超出公差上限 9.056mm，可能影响装配拧入扭矩',
      },
    ],
    createdAt: '2023-10-12T10:30:00.000Z',
    updatedAt: '2023-10-12T11:15:00.000Z',
  },
  {
    id: 'a4b5c6d7-e8f9-4a0b-9c1d-2e3f4a5b6c7d',
    orderNo: 'INS-20231012-0004',
    inspectionType: 'IPQC_RL' as const,
    // 007 过程检验滚丝工序台账列（docs/30 §2）：MES工单号 / 数量 / 螺纹规格 / 滚丝机台 / 报工时间
    workOrderNo: 'WO-20231012-01',
    totalQty: 26000,
    threadSpec: 'M6*25 6g',
    operatorName: '刘滚丝',
    operatorId: 'OP-0205',
    equipmentCode: 'EQ-RL-02',
    equipmentName: '2#精密数控滚丝机',
    processStep: '手工滚牙',
    completedAt: '2023-10-12T10:30:00.000Z',
    materialCode: 'MAT-THRD-M6-25',
    materialName: '高强度螺柱 M6*25 (滚丝工序)',
    specification: 'M6*25 / 6g',
    unit: 'PCS',
    batchNo: 'B20231012-04',
    supplierCode: undefined,
    customerCode: undefined,
    sampleQty: 32,
    passQty: 0,
    failQty: 0,
    isMandatoryGate: false,
    status: 'INSPECTING' as const,
    // 滚丝行尚未指派检验人：inspectorId / inspectorName 均缺省，台账「检验人」列据此显示 --（不推导）
    inspectorId: undefined,
    inspectionNotes: '滚丝工序巡检录入中，螺纹中径与牙型角待判定',
    planVersionId: 'a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d',
    planSnapshot: {
      planId: 'a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d',
      planCode: 'QP-IPQC-RL-V1',
      planName: '滚丝工序螺纹尺寸与外观检验规范',
      versionId: 'a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d',
      versionNo: 'V1.0',
      samplingScheme: 'GB_T_2828',
      aqlLevel: 'II',
      strictness: 'NORMAL',
      snapshotAt: '2023-10-12T13:00:00.000Z',
      items: [
        {
          seq: 1,
          itemCode: 'THR-001',
          name: '螺纹中径',
          dataType: 'NUMERIC' as const,
          metricCategory: 'DIMENSION' as const,
          standardText: '5.350±0.030mm',
          nominalValue: 5.35,
          upperTolerance: 0.03,
          lowerTolerance: -0.03,
          sampleSize: 32,
          unit: 'mm',
          isMandatory: true,
        },
        {
          seq: 2,
          itemCode: 'PIT-001',
          name: '螺距',
          dataType: 'NUMERIC' as const,
          metricCategory: 'DIMENSION' as const,
          standardText: '1.00±0.02mm',
          nominalValue: 1.0,
          upperTolerance: 0.02,
          lowerTolerance: -0.02,
          sampleSize: 32,
          unit: 'mm',
          isMandatory: true,
        },
      ],
    },
    items: [
      {
        id: 'a5b6c7d8-e9f0-4a1b-8c2d-3e4f5a6b7c8d',
        seq: 1,
        itemCode: 'THR-001',
        name: '螺纹中径',
        dataType: 'NUMERIC' as const,
        metricCategory: 'DIMENSION' as const,
        standardText: '5.350±0.030mm',
        nominalValue: 5.35,
        upperTolerance: 0.03,
        lowerTolerance: -0.03,
        sampleSize: 32,
        unit: 'mm',
        result: 'PENDING' as const,
      },
    ],
    createdAt: '2023-10-12T13:00:00.000Z',
    updatedAt: '2023-10-12T13:00:00.000Z',
  },
  // ---------------------------------------------------------------
  // 委外检验三工艺分类（表面处理 / 机加工 / 热处理）台账演示数据，
  // 与 OQC_SF / OQC_MACH / OQC_HEAT 三种契约检验类型逐一对齐。
  // ---------------------------------------------------------------
  {
    id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
    orderNo: 'OQC-SF-20260706-0001',
    inspectionType: 'OQC_SF' as const,
    materialCode: 'MAT-BLT-88-M10',
    materialName: '六角螺栓M10',
    specification: 'M10×30 / 8.8级 / 蓝白锌',
    unit: 'PCS',
    batchNo: 'B20260706-001',
    outsourceNo: 'WWJG-20260706-001',
    processType: '镀锌',
    returnDate: '2026-07-06',
    vendorName: '东莞表面处理厂',
    sampleQty: 500,
    passQty: 0,
    failQty: 0,
    isMandatoryGate: true,
    status: 'PENDING' as const,
    inspectorId: undefined,
    inspectionNotes: '委外表面处理（镀锌）回厂待检验',
    planVersionId: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
    planSnapshot: {
      planId: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
      planCode: 'QP-OQC-SF-V2',
      planName: '委外表处/热处理回厂检验规范',
      versionId: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
      versionNo: 'V2.0',
      samplingScheme: 'GB_T_2828',
      aqlLevel: 'II',
      strictness: 'NORMAL',
      snapshotAt: '2026-07-06T08:00:00.000Z',
      items: [
        {
          seq: 1,
          itemCode: 'COA-001',
          name: '镀层厚度',
          dataType: 'NUMERIC' as const,
          metricCategory: 'COATING_THICKNESS' as const,
          standardText: '局部≥8μm',
          nominalValue: 8,
          upperTolerance: 4,
          lowerTolerance: -0.5,
          sampleSize: 20,
          unit: 'μm',
          isMandatory: true,
        },
      ],
    },
    items: [
      {
        id: 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f',
        seq: 1,
        itemCode: 'COA-001',
        name: '镀层厚度',
        dataType: 'NUMERIC' as const,
        metricCategory: 'COATING_THICKNESS' as const,
        standardText: '局部≥8μm',
        nominalValue: 8,
        upperTolerance: 4,
        lowerTolerance: -0.5,
        sampleSize: 20,
        unit: 'μm',
        result: 'PENDING' as const,
      },
    ],
    createdAt: '2026-07-06T08:00:00.000Z',
    updatedAt: '2026-07-06T08:00:00.000Z',
  },
  {
    id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
    orderNo: 'OQC-MC-20260706-0001',
    inspectionType: 'OQC_MACH' as const,
    materialCode: 'MAT-SLV-45-20-30',
    materialName: '精密轴套',
    specification: 'Φ20×30mm / 45# 钢 / 精磨外圆',
    unit: 'PCS',
    batchNo: 'B20260706-010',
    outsourceNo: 'WWJG-20260706-010',
    processType: '机加工',
    returnDate: '2026-07-06',
    vendorName: '苏州机加工厂',
    sampleQty: 100,
    passQty: 0,
    failQty: 0,
    isMandatoryGate: false,
    status: 'PENDING' as const,
    inspectorId: undefined,
    inspectionNotes: '委外机加工（精密轴套）回厂待检验',
    planVersionId: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
    planSnapshot: {
      planId: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
      planCode: 'QP-OQC-SF-V2',
      planName: '委外表处/热处理回厂检验规范',
      versionId: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
      versionNo: 'V2.0',
      samplingScheme: 'GB_T_2828',
      aqlLevel: 'II',
      strictness: 'NORMAL',
      snapshotAt: '2026-07-06T08:00:00.000Z',
      items: [
        {
          seq: 1,
          itemCode: 'DIM-001',
          name: '外径',
          dataType: 'NUMERIC' as const,
          metricCategory: 'DIMENSION' as const,
          standardText: 'Φ20±0.02mm',
          nominalValue: 20,
          upperTolerance: 0.02,
          lowerTolerance: -0.02,
          sampleSize: 20,
          unit: 'mm',
          isMandatory: true,
        },
      ],
    },
    items: [
      {
        id: 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a',
        seq: 1,
        itemCode: 'DIM-001',
        name: '外径',
        dataType: 'NUMERIC' as const,
        metricCategory: 'DIMENSION' as const,
        standardText: 'Φ20±0.02mm',
        nominalValue: 20,
        upperTolerance: 0.02,
        lowerTolerance: -0.02,
        sampleSize: 20,
        unit: 'mm',
        result: 'PENDING' as const,
      },
    ],
    createdAt: '2026-07-06T08:00:00.000Z',
    updatedAt: '2026-07-06T08:00:00.000Z',
  },
  {
    id: 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a',
    orderNo: 'OQC-HT-20260706-0001',
    inspectionType: 'OQC_HEAT' as const,
    materialCode: 'MAT-BLT-109-M10-HT',
    materialName: '高强度螺栓',
    specification: 'M10×45 / 10.9级 / 热处理回厂',
    unit: 'PCS',
    batchNo: 'B20260706-015',
    outsourceNo: 'WWJG-20260706-015',
    processType: '热处理',
    returnDate: '2026-07-06',
    vendorName: '上海热处理厂',
    sampleQty: 500,
    passQty: 0,
    failQty: 0,
    isMandatoryGate: false,
    status: 'INSPECTING' as const,
    inspectorId: 'f6a1b2c3-d4e5-4f6a-b17c-8d9e0f1a2b3c',
    inspectionNotes: '委外热处理回厂检验录入中',
    planVersionId: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
    planSnapshot: {
      planId: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
      planCode: 'QP-OQC-SF-V2',
      planName: '委外表处/热处理回厂检验规范',
      versionId: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
      versionNo: 'V2.0',
      samplingScheme: 'GB_T_2828',
      aqlLevel: 'II',
      strictness: 'NORMAL',
      snapshotAt: '2026-07-06T08:00:00.000Z',
      items: [
        {
          seq: 1,
          itemCode: 'HAR-004',
          name: '回厂硬度',
          dataType: 'NUMERIC' as const,
          metricCategory: 'HARDNESS' as const,
          standardText: '33±3HRC',
          nominalValue: 33,
          upperTolerance: 3,
          lowerTolerance: -3,
          sampleSize: 8,
          unit: 'HRC',
          isMandatory: true,
        },
      ],
    },
    items: [
      {
        id: 'e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b',
        seq: 1,
        itemCode: 'HAR-004',
        name: '回厂硬度',
        dataType: 'NUMERIC' as const,
        metricCategory: 'HARDNESS' as const,
        standardText: '33±3HRC',
        nominalValue: 33,
        upperTolerance: 3,
        lowerTolerance: -3,
        sampleSize: 8,
        unit: 'HRC',
        result: 'PENDING' as const,
      },
    ],
    createdAt: '2026-07-06T08:00:00.000Z',
    updatedAt: '2026-07-06T08:00:00.000Z',
  },
  // ---- 待审核池来源检验单：判定 FAILED 且尚未生成 MRB 工单，供「发起评审」抽屉演示逐条发起 ----
  {
    id: '71000000-0000-4000-8000-0000000000a1',
    orderNo: 'IQC-20260918-0002',
    inspectionType: 'IQC' as const,
    materialCode: 'MAT-304SS-05',
    materialName: '不锈钢线材 Φ5.0mm',
    batchNo: 'LOT-2026-0918-02',
    supplierCode: 'SUP-001',
    inboundNo: 'RK-20260918-002',
    inboundDate: '2026-09-18',
    customerCode: undefined,
    supplierName: '宝钢特钢有限公司',
    sampleQty: 200,
    passQty: 160,
    failQty: 40,
    isMandatoryGate: false,
    status: 'COMPLETED' as const,
    overallDecision: 'FAILED' as const,
    inspectorId: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
    inspectorName: '张强',
    inspectionNotes: '线材表面纵向划痕深度 0.12mm，超出「表面不得有手感划伤」要求',
    planVersionId: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
    planSnapshot: {
      planId: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
      planCode: 'QP-IQC-304SS-V2',
      planName: '不锈钢冷镦盘圆丝来料抽样规程',
      versionId: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
      versionNo: 'V2.4',
      samplingScheme: 'GB_T_2828',
      aqlLevel: 'II',
      strictness: 'NORMAL',
      snapshotAt: '2026-09-18T01:10:00.000Z',
      items: [
        {
          seq: 1,
          itemCode: 'IQC-SUR-002',
          name: '表面质量',
          dataType: 'QUALITATIVE' as const,
          metricCategory: 'APPEARANCE' as const,
          standardText: '表面不得有手感划伤、裂纹、结疤',
          sampleSize: 200,
          isMandatory: true,
        },
      ],
    },
    items: [
      {
        seq: 1,
        itemCode: 'IQC-SUR-002',
        name: '表面质量',
        dataType: 'QUALITATIVE' as const,
        metricCategory: 'APPEARANCE' as const,
        standardText: '表面不得有手感划伤、裂纹、结疤',
        measuredText: '40 支存在深度 0.12mm 纵向划痕',
        result: 'FAILED' as const,
        defectReason: '拉拔模具磨损导致表面划伤',
      },
    ],
    createdAt: '2026-09-18T01:20:00.000Z',
    updatedAt: '2026-09-18T01:35:00.000Z',
  },
  {
    id: '71000000-0000-4000-8000-0000000000a2',
    orderNo: 'IPQC-CT-20260918-0007',
    inspectionType: 'IPQC_CT' as const,
    // 007 过程检验下料工序台账列（docs/29 §2）：离线 Mock 与真实库同列同口径
    workOrderNo: 'WO-20260918-07',
    totalQty: 12000,
    blankingLength: 25.35,
    operatorName: '陈操作',
    operatorId: 'OP-0102',
    equipmentCode: 'EQ-CT-02',
    equipmentName: '2#全自动高速冷镦机',
    processStep: '自动断料',
    completedAt: '2026-09-18T02:05:00.000Z',
    materialCode: 'MAT-SCR-M6-25',
    materialName: '高强度螺柱 M6*25 (下料工序)',
    batchNo: 'B20260918-07',
    supplierCode: undefined,
    customerCode: undefined,
    sampleQty: 64,
    passQty: 52,
    failQty: 12,
    isMandatoryGate: false,
    status: 'FAILED' as const,
    overallDecision: 'FAILED' as const,
    inspectorId: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
    inspectorName: '李伟',
    inspectionNotes: '下料长度 25.35mm 超上差，端面倾斜 0.8°',
    planVersionId: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
    planSnapshot: {
      planId: 'e5f6a1b2-c3d4-4e5f-a06b-7c8d9e0f1a2b',
      planCode: 'QP-IPQC-CUT-V3',
      planName: '冷镦下料工序首巡检规范',
      versionId: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
      versionNo: 'V1.1',
      samplingScheme: 'GB_T_2828',
      aqlLevel: 'II',
      strictness: 'NORMAL',
      snapshotAt: '2026-09-18T02:00:00.000Z',
      items: [
        {
          seq: 1,
          itemCode: 'CUT-001',
          name: '切断长度',
          dataType: 'NUMERIC' as const,
          metricCategory: 'DIMENSION' as const,
          standardText: '25.00±0.10mm',
          nominalValue: 25,
          upperTolerance: 0.1,
          lowerTolerance: -0.1,
          sampleSize: 64,
          unit: 'mm',
          isMandatory: true,
        },
      ],
    },
    items: [
      {
        seq: 1,
        itemCode: 'CUT-001',
        name: '切断长度',
        dataType: 'NUMERIC' as const,
        metricCategory: 'DIMENSION' as const,
        standardText: '25.00±0.10mm',
        nominalValue: 25,
        upperTolerance: 0.1,
        lowerTolerance: -0.1,
        measuredVal: 25.35,
        unit: 'mm',
        result: 'FAILED' as const,
        defectReason: '切刀磨损导致送料行程漂移',
      },
    ],
    createdAt: '2026-09-18T02:05:00.000Z',
    updatedAt: '2026-09-18T02:20:00.000Z',
  },
  {
    id: '71000000-0000-4000-8000-0000000000a3',
    orderNo: 'OQC-SH-20260918-0003',
    inspectionType: 'OQC_SH' as const,
    materialCode: 'MAT-BLT-88-M10',
    materialName: '六角螺栓M10',
    batchNo: 'B20260918-003',
    supplierCode: undefined,
    customerCode: 'CUST-001',
    customerName: '东风商用车',
    sampleQty: 80,
    passQty: 62,
    failQty: 18,
    isMandatoryGate: true,
    status: 'FAILED' as const,
    overallDecision: 'FAILED' as const,
    inspectorId: 'f6a1b2c3-d4e5-4f6a-b17c-8d9e0f1a2b3c',
    inspectorName: '刘芳',
    inspectionNotes: '螺纹通止规检验不合格，18 件止规可旋入 2 牙以上',
    planVersionId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    planSnapshot: {
      planId: 'f6a1b2c3-d4e5-4f6a-b17c-8d9e0f1a2b3c',
      planCode: 'QP-FQC-AUTO-V4',
      planName: '六角头成品螺栓全尺寸与机械性能检验标准',
      versionId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
      versionNo: 'V3.0',
      samplingScheme: 'GB_T_2828',
      aqlLevel: 'II',
      strictness: 'NORMAL',
      snapshotAt: '2026-09-18T03:00:00.000Z',
      items: [
        {
          seq: 1,
          itemCode: 'THR-GO',
          name: '螺纹通止规',
          dataType: 'QUALITATIVE' as const,
          metricCategory: 'DIMENSION' as const,
          standardText: '通规通、止规止 (不得旋入 2 牙以上)',
          sampleSize: 80,
          isMandatory: true,
        },
      ],
    },
    items: [
      {
        seq: 1,
        itemCode: 'THR-GO',
        name: '螺纹通止规',
        dataType: 'QUALITATIVE' as const,
        metricCategory: 'DIMENSION' as const,
        standardText: '通规通、止规止 (不得旋入 2 牙以上)',
        measuredText: '18 件止规可旋入 2 牙以上',
        result: 'FAILED' as const,
        defectReason: '搓丝板磨损导致螺纹中径偏大',
      },
    ],
    createdAt: '2026-09-18T03:10:00.000Z',
    updatedAt: '2026-09-18T03:25:00.000Z',
  },
];

export const mockInspectionOrders: InspectionOrder[] = rawInspectionOrders.map((rec) =>
  InspectionOrderSchema.parse(rec)
);

// ==========================================
// 2. MRB REVIEW MOCK DATA (Zod Validated)
// ==========================================

export const rawMrbRecords = [
  {
    id: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    mrbNo: 'MRB-20231012-01',
    sourceType: 'PROCESS_FAIL' as const,
    sourceOrderNo: 'INS-20231012-0002',
    batchNo: 'B20231012-02',
    materialCode: 'MAT-SCR-M6-25',
    materialName: '高强度螺柱 M6*25 (下料工序)',
    defectDescription: '切断毛刺高度超标达到 0.18mm (允许值 ≤0.05mm)，下料长度 25.42mm 超差',
    defectQty: 3000,
    status: 'UNDER_REVIEW' as const,
    disposition: 'REWORK' as const,
    dispositionNotes: '安排机修检修切刀，车间安排二次平头倒角加工返工',
    approvers: [
      {
        userId: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
        userName: '张强 (质量经理)',
        roleCode: 'QA_MGR',
        action: 'APPROVED' as const,
        comment: '同意转二车间平头倒角返工处理',
        signedAt: '2023-10-12T10:15:00.000Z',
      },
      {
        userId: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
        userName: '王工 (工艺总监)',
        roleCode: 'TECH_DIR',
        action: 'APPROVED' as const,
        comment: '评估返工后尺寸公差可恢复受控范围',
        signedAt: '2023-10-12T10:30:00.000Z',
      },
    ],
    concessionAttachmentUrl: undefined,
    createdAt: '2023-10-12T09:40:00.000Z',
    updatedAt: '2023-10-12T10:30:00.000Z',
  },
  {
    id: 'f6a1b2c3-d4e5-4f6a-b17c-8d9e0f1a2b3c',
    mrbNo: 'MRB-20231012-02',
    sourceType: 'SHIPMENT_FAIL' as const,
    sourceOrderNo: 'INS-20231012-0003',
    batchNo: 'B20231012-03',
    materialCode: 'MAT-BLT-109-M10',
    materialName: '10.9级六角头螺栓 M10*45 (成品检)',
    defectDescription: '螺栓螺纹中径偏大 0.04mm，可能影响装配拧入扭矩',
    defectQty: 10000,
    status: 'UNDER_REVIEW' as const,
    disposition: 'CONCESSION' as const,
    dispositionNotes: '客户现场试装合格，已签署特采让步接收协议，质保部会签放行',
    approvers: [
      {
        userId: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
        userName: '张强 (质量经理)',
        roleCode: 'QA_MGR',
        action: 'APPROVED' as const,
        comment: '建议特采让步接收，附客户签字特采单',
        signedAt: '2023-10-12T11:30:00.000Z',
      },
    ],
    concessionAttachmentUrl: 'https://qms.letian.com/docs/concession/CONC-20231012-02.pdf',
    createdAt: '2023-10-12T11:20:00.000Z',
    updatedAt: '2023-10-12T11:35:00.000Z',
  },
  {
    id: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
    mrbNo: 'MRB-20231011-01',
    sourceType: 'INCOMING_FAIL' as const,
    sourceOrderNo: 'INS-20231011-0001',
    batchNo: 'B20231011-01',
    materialCode: 'MAT-35CRMO-08',
    materialName: '35CrMo 合金圆钢 Φ8.0mm',
    defectDescription: '表面存在沿轧制方向裂纹，深度达 0.35mm',
    defectQty: 15000,
    status: 'DISPOSED' as const,
    disposition: 'RETURN_TO_VENDOR' as const,
    dispositionNotes: '严重母材缺陷，作整批退货处理并开具供应商质量处罚单',
    approvers: [
      {
        userId: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
        userName: '张强 (质量经理)',
        roleCode: 'QA_MGR',
        action: 'REJECTED' as const,
        comment: '无法让步，直接退供应商',
        signedAt: '2023-10-11T14:00:00.000Z',
      },
    ],
    concessionAttachmentUrl: undefined,
    createdAt: '2023-10-11T13:30:00.000Z',
    updatedAt: '2023-10-11T16:00:00.000Z',
  },
];

export const mockMrbRecords: MRBReview[] = rawMrbRecords.map((mrb) =>
  MRBReviewSchema.parse(mrb)
);

// ==========================================
// 2.1 不合格待审核池 MOCK DATA (统一待审核池★，Zod Validated)
// ==========================================
// 池内条目 = 各检验环节判定 FAILED 且尚未发起评审的检验单（status = PENDING_INITIATE）；
// status = INITIATED 表示该条已生成 MRB 工单（mrbId 回填关联）。
// 口径见 docs/19-MRB不合格品处置页整合设计.md §7.1。

export const rawPendingDefects = [
  {
    id: '71000000-0000-4000-8000-000000000001',
    inspectionOrderId: '71000000-0000-4000-8000-0000000000a1',
    orderNo: 'IQC-20260918-0002',
    inspectionType: 'IQC',
    batchNo: 'LOT-2026-0918-02',
    materialCode: 'MAT-304SS-05',
    materialName: '不锈钢线材 Φ5.0mm',
    supplierName: '宝钢特钢有限公司',
    defectQty: 40,
    totalQty: 200,
    defectDescription: '线材表面纵向划痕深度 0.12mm，超出「表面不得有手感划伤」要求',
    defectItemCode: 'IQC-SUR-002',
    status: 'PENDING_INITIATE' as const,
    inspectorId: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
    inspectorName: '张强',
    createdAt: '2026-09-18T01:35:00.000Z',
  },
  {
    id: '71000000-0000-4000-8000-000000000002',
    inspectionOrderId: '71000000-0000-4000-8000-0000000000a2',
    orderNo: 'IPQC-CT-20260918-0007',
    inspectionType: 'IPQC',
    batchNo: 'B20260918-07',
    materialCode: 'MAT-SCR-M6-25',
    materialName: '高强度螺柱 M6*25 (下料工序)',
    defectQty: 12,
    totalQty: 64,
    defectDescription: '下料长度 25.35mm 超上差 0.25mm，端面倾斜 0.8°',
    defectItemCode: 'CUT-001',
    status: 'PENDING_INITIATE' as const,
    inspectorId: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
    inspectorName: '李伟',
    createdAt: '2026-09-18T02:20:00.000Z',
  },
  {
    id: '71000000-0000-4000-8000-000000000003',
    inspectionOrderId: '71000000-0000-4000-8000-0000000000a3',
    orderNo: 'OQC-SH-20260918-0003',
    inspectionType: 'OQC',
    batchNo: 'B20260918-003',
    materialCode: 'MAT-BLT-88-M10',
    materialName: '六角螺栓M10',
    customerName: '东风商用车',
    defectQty: 18,
    totalQty: 80,
    defectDescription: '18 件螺纹止规可旋入 2 牙以上，螺纹中径偏大',
    defectItemCode: 'THR-GO',
    status: 'PENDING_INITIATE' as const,
    inspectorId: 'f6a1b2c3-d4e5-4f6a-b17c-8d9e0f1a2b3c',
    inspectorName: '刘芳',
    createdAt: '2026-09-18T03:25:00.000Z',
  },
  {
    id: '71000000-0000-4000-8000-000000000004',
    inspectionOrderId: 'f6a1b2c3-d4e5-4f6a-b17c-8d9e0f1a2b3c',
    orderNo: 'INS-20231012-0002',
    inspectionType: 'IPQC',
    batchNo: 'B20231012-02',
    materialCode: 'MAT-SCR-M6-25',
    materialName: '高强度螺柱 M6*25 (下料工序)',
    defectQty: 3000,
    totalQty: 5000,
    defectDescription: '切断毛刺高度超标达到 0.18mm (允许值 ≤0.05mm)，下料长度 25.42mm 超差',
    defectItemCode: 'CUT-002',
    status: 'INITIATED' as const,
    mrbId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    inspectorId: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
    inspectorName: '李伟',
    createdAt: '2023-10-12T09:40:00.000Z',
  },
];

export const mockPendingDefects: PendingDefectItem[] = rawPendingDefects.map((item) =>
  PendingDefectItemSchema.parse(item)
);

// ==========================================
// 2.2 MRB 评审流程定义 MOCK DATA (与 seeds/runner.ts 播种的 4 条 ACTIVE 流程同口径)
// ==========================================
// 字段严格对齐契约 ReviewFlowSchema：nodes[].nodeLevel / nodeName / roleCode / requireCustomerSign。

export const rawReviewFlows = [
  {
    id: '50000000-0000-4000-8000-000000000001',
    flowCode: 'FLOW-IQC-FAIL',
    flowName: '来料检验不合格多方会签流程',
    description: '来料检验判定不合格后的多方会签、退货与让步接收裁决流转',
    applicableType: 'INCOMING_FAIL' as const,
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
    applicableType: 'PROCESS_FAIL' as const,
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
    applicableType: 'SHIPMENT_FAIL' as const,
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
    applicableType: 'SUBCONTRACT_FAIL' as const,
    version: 'v1.0.0',
    isActive: true,
    nodes: [
      { nodeLevel: 1, nodeName: '委外检验员初判', roleCode: '检验员', roleName: '委外检验员', isRequired: true, allowConcession: false, requireCustomerSign: false },
      { nodeLevel: 2, nodeName: '供应商质量工程师责任认定', roleCode: '供应商质量工程师', roleName: '供应商质量工程师 (SQE)', isRequired: true, allowConcession: false, requireCustomerSign: false },
      { nodeLevel: 3, nodeName: '质量经理终审裁决', roleCode: '质量经理', roleName: '质量主管 / 经理', isRequired: true, allowConcession: true, requireCustomerSign: false },
    ],
  },
];

export const mockReviewFlows: ReviewFlow[] = rawReviewFlows.map((flow) =>
  ReviewFlowSchema.parse(flow)
);

// ==========================================
// 3. TRACEABILITY DAG MOCK (Zod Validated)
// ==========================================

export const rawTraceabilityGraph = {
  batchNo: 'LOT-2026-FN-01',
  hasCycle: false,
  nodes: [
    {
      nodeId: '60000000-0000-4000-8000-000000000001',
      batchNo: 'COIL-20230925-01',
      stageName: '原材料入库 (IQC)',
      materialName: '304HC 不锈钢盘条 Φ6.5mm',
      operatorName: '陈静',
      timestamp: '2023-09-25T08:30:00.000Z',
      nodeStatus: 'STORED' as const,
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
      nodeStatus: 'PASSED' as const,
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
      nodeStatus: 'INSPECTING' as const,
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
      nodeStatus: 'PASSED' as const,
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
      nodeStatus: 'PASSED' as const,
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
      nodeStatus: 'PASSED' as const,
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
      nodeStatus: 'FAILED' as const,
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
      nodeStatus: 'PENDING' as const,
      orderNo: 'SO-20231012-01',
      supplierOrCustomer: '三一重工机械装备底盘制造厂',
    },
  ],
  edges: [
    {
      id: '3e4f5a6b-7c8d-4e5f-a06b-7c8d9e0f1a2b',
      sourceBatchNo: 'COIL-20230925-01',
      targetBatchNo: 'WIRE-20230927-04',
      relationType: 'RAW_TO_PROCESS' as const,
      depth: 1,
      isCycle: false,
      hasCycleWarning: false,
    },
    {
      id: '4a5b6c7d-8e9f-4a5b-b18c-9d0e1f2a3b4c',
      sourceBatchNo: 'WIRE-20230927-04',
      targetBatchNo: 'BLANK-20231002-01',
      relationType: 'PROCESS_TO_PROCESS' as const,
      depth: 2,
      isCycle: false,
      hasCycleWarning: false,
    },
    {
      id: '5b6c7d8e-9f0a-4b6c-c29d-0e1f2a3b4c5d',
      sourceBatchNo: 'BLANK-20231002-01',
      targetBatchNo: 'THRD-20231005-02',
      relationType: 'PROCESS_TO_PROCESS' as const,
      depth: 3,
      isCycle: false,
      hasCycleWarning: false,
    },
    {
      id: '6c7d8e9f-0a1b-4c7d-d30e-1f2a3b4c5d6e',
      sourceBatchNo: 'THRD-20231005-02',
      targetBatchNo: 'HEAT-20231008-01',
      relationType: 'PROCESS_TO_PROCESS' as const,
      depth: 4,
      isCycle: false,
      hasCycleWarning: false,
    },
    {
      id: '7d8e9f0a-1b2c-4d8e-e41f-2a3b4c5d6e7f',
      sourceBatchNo: 'HEAT-20231008-01',
      targetBatchNo: 'PLT-20231010-03',
      relationType: 'PROCESS_TO_OUTSOURCE' as const,
      depth: 5,
      isCycle: false,
      hasCycleWarning: false,
    },
    {
      id: '8e9f0a1b-2c3d-4e9f-f520-3b4c5d6e7f8a',
      sourceBatchNo: 'PLT-20231010-03',
      targetBatchNo: 'LOT-2026-FN-01',
      relationType: 'OUTSOURCE_TO_FINISH' as const,
      depth: 6,
      isCycle: false,
      hasCycleWarning: false,
    },
    {
      id: '9f0a1b2c-3d4e-4f0a-0631-4c5d6e7f8a9b',
      sourceBatchNo: 'PLT-20231010-03',
      targetBatchNo: 'SHP-20231012-01',
      relationType: 'OUTSOURCE_TO_FINISH' as const,
      depth: 6,
      isCycle: false,
      hasCycleWarning: false,
    },
    {
      id: '0a1b2c3d-4e5f-4a1b-1742-5d6e7f8a9b0c',
      sourceBatchNo: 'LOT-2026-FN-01',
      targetBatchNo: 'SHP-20231012-01',
      relationType: 'FINISH_TO_SHIPMENT' as const,
      depth: 7,
      isCycle: false,
      hasCycleWarning: false,
    },
  ],
  impact: {
    downstreamBatchCount: 1,
    upstreamBatchCount: 6,
    downstreamOrderCount: 1,
    downstreamPartyCount: 1,
    downstreamOrderNos: ['SO-20231012-01'],
    downstreamParties: ['三一重工机械装备底盘制造厂'],
  },
};

export const mockTraceabilityGraph: TraceabilityGraphResponse =
  TraceabilityGraphResponseSchema.parse(rawTraceabilityGraph);
/**
 * 特采（让步接收）样本图谱：单独成图，用于演示「特采节点必须同时举证 MRB 单号 + 客户书面授权件」。
 *
 * 与真实后端同口径：该批次在种子数据里**故意不接入主链路**，因此查询 LOT-2026-FN-01 时
 * 不会把 B20231011-92 带出来；只有直接按该批次号查询才会得到这张图。
 */
export const rawConcessionGraph = {
  batchNo: 'B20231011-92',
  hasCycle: false,
  nodes: [
    {
      nodeId: '60000000-0000-4000-8000-000000000012',
      batchNo: 'B20231011-92',
      stageName: '来料检验 (IQC 特采放行)',
      materialName: '35CrMo 合金圆钢 Φ8.0mm',
      operatorName: '陈静',
      timestamp: '2023-10-11T16:00:00.000Z',
      nodeStatus: 'CONCESSION' as const,
      orderNo: 'INS-20231011-0001',
      supplierOrCustomer: '青山控股实业线材分公司',
      materialCode: 'MAT-35CRMO-08',
      furnaceHeatBatchNo: '230910-112',
      inspectionOrderNo: 'INS-20231011-0001',
      mrbNo: 'MRB-20231011-01',
      concessionAttachmentUrl: '/api/v1/mrb/reviews/MRB-20231011-01/attachments/concession-letter.pdf',
    },
  ],
  edges: [],
  impact: {
    downstreamBatchCount: 0,
    upstreamBatchCount: 0,
    downstreamOrderCount: 0,
    downstreamPartyCount: 0,
    downstreamOrderNos: [],
    downstreamParties: [],
  },
};

export const mockConcessionGraph: TraceabilityGraphResponse =
  TraceabilityGraphResponseSchema.parse(rawConcessionGraph);

/**
 * 批次检索样本：两路数据源并集 —— 已建血缘（batch_trace_nodes）与仅有检验台账（inspection_orders）。
 * 最后一行为「仅检验台账」样本，用于验证界面把它如实标成「仅检验台账」而不是当成已有血缘。
 */
export const rawTraceBatchSearch = {
  total: 4,
  page: 1,
  pageSize: 20,
  items: [
    {
      batchNo: 'LOT-2026-FN-01',
      materialName: '外六角螺栓 M6*25-10.9级 盒装',
      stageName: '成品终检入库 (FQC 强制放行)',
      nodeStatus: 'FAILED' as const,
      timestamp: '2023-10-12T11:00:00.000Z',
      inspectionOrderNo: 'OQC-SH-20231013-0002',
      orderNo: 'SO-20231012-01',
      supplierOrCustomer: '成品立体库 03-A-12',
      sources: ['TRACE_NODE', 'INSPECTION_ORDER'],
      relatedOrderNos: ['OQC-SH-20231013-0002', 'SO-20231012-01'],
    },
    {
      batchNo: 'COIL-20230925-01',
      furnaceHeatBatchNo: '230915-047',
      materialName: '304HC 不锈钢盘条 Φ6.5mm',
      stageName: '原材料入库 (IQC)',
      nodeStatus: 'STORED' as const,
      timestamp: '2023-09-25T08:30:00.000Z',
      orderNo: 'PO-20230920-08',
      supplierOrCustomer: '青山特钢',
      sources: ['TRACE_NODE'],
      relatedOrderNos: [],
    },
    {
      batchNo: 'B20231011-92',
      materialCode: 'MAT-35CRMO-08',
      furnaceHeatBatchNo: '230910-112',
      materialName: '35CrMo 合金圆钢 Φ8.0mm',
      stageName: '来料检验 (IQC 特采放行)',
      nodeStatus: 'CONCESSION' as const,
      timestamp: '2023-10-11T16:00:00.000Z',
      inspectionOrderNo: 'INS-20231011-0001',
      orderNo: 'INS-20231011-0001',
      supplierOrCustomer: '青山控股实业线材分公司',
      sources: ['TRACE_NODE', 'INSPECTION_ORDER'],
      relatedOrderNos: ['INS-20231011-0001'],
    },
    {
      batchNo: 'LOT-20260706-0002',
      materialName: '六角螺栓 M10*40-10.9级 盒装',
      timestamp: '2026-07-06T09:30:00.000Z',
      inspectionOrderNo: 'OQC-SH-20260706-0002',
      orderNo: 'PO-B-002',
      supplierOrCustomer: '徐州工程机械集团',
      sources: ['INSPECTION_ORDER'],
      relatedOrderNos: ['OQC-SH-20260706-0002'],
    },
  ],
};

export const mockTraceBatchSearch: TraceBatchSearchResponse =
  TraceBatchSearchResponseSchema.parse(rawTraceBatchSearch);

/**
 * 订单检验环节样本：镜像种子里的 MES 工单 WO-20231012-01（下料检 / 滚丝检 / 成品检三张并列检验单）。
 *
 * 这是**并列台账**而不是血缘链路：三条环节之间没有批次上下游关系，
 * 因此界面上只能是「本订单检验环节」，不得写「完整质量追溯链路」。
 */
export const rawOrderChain = {
  orderNo: 'WO-20231012-01',
  matchedBy: 'WORK_ORDER_NO' as const,
  customerName: '三一重工机械装备底盘制造厂',
  erpStatus: '已审核',
  salesOrderNo: 'SO-20231012-01',
  salesOrderPoNo: 'PO-B-002',
  batchNos: ['BLANK-20231012-01', 'LOT-2026-FN-01', 'THRD-20231012-01'],
  materialCode: 'MAT-BLT-109-M10',
  materialName: '外六角螺栓 M6*25-10.9级 盒装',
  totalQty: 12000,
  stages: [
    {
      seq: 2,
      stageName: '下料检',
      orderNo: 'INS-20231012-0002',
      orderType: 'IPQC_CT',
      batchNo: 'BLANK-20231012-01',
      sourceDocNo: 'WO-20231012-01',
      status: 'PASSED' as const,
      judgment: 'PASSED' as const,
      inspectorName: '王建国',
      occurredAt: '2023-10-12T02:30:00.000Z',
      durationMinutes: 30,
    },
    {
      seq: 3,
      stageName: '滚丝检',
      orderNo: 'INS-20231012-0004',
      orderType: 'IPQC_RL',
      batchNo: 'THRD-20231012-01',
      sourceDocNo: 'WO-20231012-01',
      status: 'INSPECTING' as const,
      inspectorName: '赵志明',
      occurredAt: '2023-10-12T05:00:00.000Z',
    },
    {
      seq: 4,
      stageName: '成品检',
      orderNo: 'INS-20231012-0003',
      orderType: 'IPQC_FN',
      batchNo: 'LOT-2026-FN-01',
      sourceDocNo: 'WO-20231012-01',
      status: 'FAILED' as const,
      judgment: 'FAILED' as const,
      inspectorName: '刘芳',
      occurredAt: '2023-10-12T09:30:00.000Z',
      durationMinutes: 150,
    },
  ],
};

export const mockOrderChain: TraceOrderChainResponse = TraceOrderChainResponseSchema.parse(rawOrderChain);

// ==========================================
// 4. INTEGRATION MOCK DATA (Zod Validated)
// ==========================================

export const rawIntegrationConfigs = [
  {
    id: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    systemType: 'MES' as const,
    serviceUrl: 'https://mes.letian-fasteners.com/api/v2',
    authToken: 'bearer-mes-secret-token-2026',
    subscribedWorkshops: ['拔丝车间', '冷镦一车间', '热处理二车间', '表面处理三车间'],
    subscribedProcesses: ['拔丝', '冷镦成型', '搓丝', '网带热处理', '滚镀锌'],
    cronSchedule: '0 */5 * * * *',
    enabled: true,
    createdAt: '2023-01-01T00:00:00.000Z',
    updatedAt: '2023-10-12T08:00:00.000Z',
  },
  {
    id: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
    systemType: 'ERP' as const,
    serviceUrl: 'https://erp.letian-fasteners.com/openapi',
    authToken: 'bearer-erp-secret-token-2026',
    subscribedWorkshops: ['中心仓库', '原料库', '成品立体库'],
    subscribedProcesses: ['采购收货', '销售出库'],
    cronSchedule: '0 0 */1 * * *',
    enabled: true,
    createdAt: '2023-01-01T00:00:00.000Z',
    updatedAt: '2023-10-12T08:00:00.000Z',
  },
];

export const mockIntegrationConfigs: IntegrationConfig[] = rawIntegrationConfigs.map(
  (cfg) => IntegrationConfigSchema.parse(cfg)
);

export const rawIntegrationLogs = [
  {
    id: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
    batchNo: 'B20231012-02',
    systemType: 'MES' as const,
    syncDirection: 'PULL' as const,
    status: 'SUCCESS' as const,
    recordsCount: 42,
    errorDetails: undefined,
    createdAt: '2023-10-12T08:55:00.000Z',
  },
  {
    id: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
    batchNo: 'B20231012-03',
    systemType: 'MES' as const,
    syncDirection: 'PUSH' as const,
    status: 'PARTIAL_FAIL' as const,
    recordsCount: 18,
    errorDetails: '网关超时: 下料工序 CH-04 设备实测数据丢包 2 条',
    createdAt: '2023-10-12T09:10:00.000Z',
  },
  {
    id: 'e5f6a1b2-c3d4-4e5f-a06b-7c8d9e0f1a2b',
    batchNo: 'B20231012-01',
    systemType: 'ERP' as const,
    syncDirection: 'PUSH' as const,
    status: 'SUCCESS' as const,
    recordsCount: 1,
    errorDetails: undefined,
    createdAt: '2023-10-12T08:46:00.000Z',
  },
];

export const mockIntegrationLogs: IntegrationSyncLog[] = rawIntegrationLogs.map(
  (log) => IntegrationSyncLogSchema.parse(log)
);

// ---- MES 机台档案与拦截规则 (页面展示模型，无对应 contracts schema) ----

export interface MesEquipmentMapping {
  id: string;
  equipmentCode: string;
  equipmentName: string;
  stationCode: string;
  workshop: string;
  protocol: 'OPC UA' | 'Modbus TCP' | 'MQTT';
  ipAddress: string;
  status: 'ONLINE' | 'INTERCEPTED';
}

export const mockEquipmentMappings: MesEquipmentMapping[] = [
  {
    id: 'eq-01',
    equipmentCode: 'CH-04',
    equipmentName: '高速精密下料机',
    stationCode: 'ST-CUT-04',
    workshop: '高速冷镦第一车间',
    protocol: 'OPC UA',
    ipAddress: '192.168.10.14',
    status: 'INTERCEPTED',
  },
  {
    id: 'eq-02',
    equipmentCode: 'HT-02',
    equipmentName: '连续式网带调质炉',
    stationCode: 'ST-HT-02',
    workshop: '连续式网带调质热处理车间',
    protocol: 'Modbus TCP',
    ipAddress: '192.168.10.22',
    status: 'ONLINE',
  },
  {
    id: 'eq-03',
    equipmentCode: 'HF-08',
    equipmentName: '六模多工位冷镦机',
    stationCode: 'ST-HF-08',
    workshop: '高速冷镦第一车间',
    protocol: 'MQTT',
    ipAddress: '192.168.10.31',
    status: 'ONLINE',
  },
  {
    id: 'eq-04',
    equipmentCode: 'PL-01',
    equipmentName: '环保滚镀锌电镀线',
    stationCode: 'ST-PL-01',
    workshop: '环保自动化电镀流水线车间',
    protocol: 'OPC UA',
    ipAddress: '192.168.10.46',
    status: 'ONLINE',
  },
];

export interface MesInterceptionRule {
  id: string;
  ruleName: string;
  stage: string;
  condition: string;
  action: string;
  autoLock: boolean;
  status: 'ACTIVE' | 'INACTIVE';
}

export const mockInterceptionRules: MesInterceptionRule[] = [
  {
    id: 'rule-01',
    ruleName: '下料长度超差硬阻断',
    stage: '精密下料',
    condition: 'blanking_length > 25.10mm OR < 24.90mm',
    action: 'PLC 抱闸停机 + 声光报警',
    autoLock: true,
    status: 'ACTIVE',
  },
  {
    id: 'rule-02',
    ruleName: '端面毛刺超限锁机',
    stage: '精密下料',
    condition: 'burr_height > 0.05mm',
    action: 'PLC 互锁跳闸停机',
    autoLock: true,
    status: 'ACTIVE',
  },
  {
    id: 'rule-03',
    ruleName: '炉温偏差预警看板',
    stage: '网带热处理',
    condition: '|furnace_temp - setpoint| > 20℃ 持续 60s',
    action: '推送 QMS 看板红色预警',
    autoLock: false,
    status: 'ACTIVE',
  },
  {
    id: 'rule-04',
    ruleName: '搓丝中径下差拦截',
    stage: '搓丝成型',
    condition: 'thread_pitch_dia < 下限值',
    action: 'MES 工序强制挂起',
    autoLock: true,
    status: 'ACTIVE',
  },
  {
    id: 'rule-05',
    ruleName: '镀层膜厚不足软报警',
    stage: '电镀委外回厂',
    condition: 'coating_thickness < 8μm',
    action: 'QMS 标红待 MRB 评审',
    autoLock: false,
    status: 'INACTIVE',
  },
];

// ==========================================
// 5. MASTER DATA MOCK (Zod Validated + 页面展示字段)
// ==========================================

// ==========================================
// 4.5 COMPANY PROFILE (企业档案主数据，company_profile 单行)
// ==========================================

/**
 * 企业档案离线 Mock（证书抬头 / 印章文字的**唯一来源**）。
 *
 * 取值与 packages/infrastructure/src/seeds/data.ts 的 seedCompanyProfile **同值** ——
 * 离线演示与真实后端的证书抬头必须一致，否则同一张证书在两种模式下会打印出不同抬头。
 * 法定名称中英文与印章文字之外一律留空：空 = 未维护，证书按留白渲染（docs/35 §6）。
 */
export const mockCompanyProfile: CompanyProfile = {
  legalName: '宁波乐天紧固件制造有限公司',
  legalNameEn: 'NINGBO LETIAN FASTENERS MANUFACTURING CO., LTD.',
  qualityStamp: '宁波乐天质检',
  updatedBy: 'seed',
};

export interface SupplierDisplay extends Supplier {
  materials: string;
  rating: string;
  status: string;
}

const rawSuppliers: SupplierDisplay[] = [
  {
    id: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    supplierCode: 'SUP-001',
    supplierName: '江苏大明不锈钢特钢有限公司',
    contactPerson: '钱总',
    phone: '13812345678',
    materials: '304HC / 316L 不锈钢盘条',
    rating: 'A 级战略供方',
    status: 'ACTIVE',
    createdAt: '2023-01-10T08:00:00.000Z',
  },
  {
    id: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
    supplierCode: 'SUP-002',
    supplierName: '青山控股实业线材分公司',
    contactPerson: '孙经理',
    phone: '13987654321',
    materials: '冷镦钢 10B21 / 35CrMo 圆钢',
    rating: 'A 级战略供方',
    status: 'ACTIVE',
    createdAt: '2023-01-15T08:00:00.000Z',
  },
  {
    id: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
    supplierCode: 'SUP-003',
    supplierName: '张家港永钢集团金属制品公司',
    contactPerson: '赵部长',
    phone: '13700001122',
    materials: '中碳合金结构线材',
    rating: 'B 级合格供方',
    status: 'ACTIVE',
    createdAt: '2023-02-01T08:00:00.000Z',
  },
];

export const mockSuppliers: SupplierDisplay[] = rawSuppliers.map((s) => {
  SupplierSchema.parse(s);
  return s;
});

export interface CustomerDisplay extends Customer {
  industry: string;
  standards: string;
  status: string;
}

const rawCustomers: CustomerDisplay[] = [
  {
    id: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
    customerCode: 'CUST-001',
    customerName: '上海通用汽车零部件采购部',
    contactPerson: '陈总监',
    phone: '021-88997766',
    industry: '汽车整车与零部件',
    standards: 'IATF 16949 / PPAP  Level 3',
    status: 'ACTIVE',
    createdAt: '2023-01-20T08:00:00.000Z',
  },
  {
    id: 'e5f6a1b2-c3d4-4e5f-a06b-7c8d9e0f1a2b',
    customerCode: 'CUST-002',
    customerName: '三一重工机械装备底盘制造厂',
    contactPerson: '周科长',
    phone: '0731-66554433',
    industry: '工程机械装备',
    standards: 'ISO 898-1 / GB/T 5782',
    status: 'ACTIVE',
    createdAt: '2023-02-12T08:00:00.000Z',
  },
  {
    id: 'f6a1b2c3-d4e5-4f6a-b17c-8d9e0f1a2b3c',
    customerCode: 'CUST-003',
    customerName: '金风科技风电紧固件集采中心',
    contactPerson: '吴经理',
    phone: '010-55667788',
    industry: '风电新能源装备',
    standards: 'EN 14399 / CE 认证',
    status: 'ACTIVE',
    createdAt: '2023-03-05T08:00:00.000Z',
  },
];

export const mockCustomers: CustomerDisplay[] = rawCustomers.map((c) => {
  CustomerSchema.parse(c);
  return c;
});

export interface WorkshopDisplay extends Workshop {
  sections: string;
  supervisor: string;
  qcCount: number;
  status: string;
}

const rawWorkshops: WorkshopDisplay[] = [
  {
    id: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    workshopCode: 'WS-01',
    workshopName: '高速冷镦第一车间',
    sections: '下料 CH-04 / 冷镦 HF-08 / 搓丝 RS-02',
    supervisor: '王建国',
    qcCount: 6,
    status: 'ACTIVE',
    createdAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
    workshopCode: 'WS-02',
    workshopName: '精密搓丝成型第二车间',
    sections: '搓丝 TR-05 / TR-06 / 通止规全检台',
    supervisor: '赵志明',
    qcCount: 4,
    status: 'ACTIVE',
    createdAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
    workshopCode: 'WS-03',
    workshopName: '连续式网带调质热处理车间',
    sections: '网带炉 HT-02 / 回火炉 HT-05 / 硬度计',
    supervisor: '孙德胜',
    qcCount: 3,
    status: 'ACTIVE',
    createdAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
    workshopCode: 'WS-04',
    workshopName: '环保自动化电镀流水线车间',
    sections: '滚镀锌 PL-01 / 膜厚检测室',
    supervisor: '周海波',
    qcCount: 2,
    status: 'ACTIVE',
    createdAt: '2023-01-01T08:00:00.000Z',
  },
];

export const mockWorkshops: WorkshopDisplay[] = rawWorkshops.map((w) => {
  WorkshopSchema.parse(w);
  return w;
});

export interface EmployeeDisplay extends Employee {
  title: string;
  certifications: string;
  mrbSeat: boolean;
  mrbRole: string;
  status: string;
}

const rawEmployees: EmployeeDisplay[] = [
  {
    id: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
    employeeCode: 'EMP-1042',
    name: '张强',
    department: '质量保证部',
    title: '质量经理 / MRB 主席',
    phone: '13800000001',
    email: 'zhangqiang@letian.com',
    certifications: 'ISO 9001 内审员 / CQI-9 热处理评审',
    mrbSeat: true,
    mrbRole: 'QA_MGR',
    status: 'ACTIVE',
    isActive: true,
    createdAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
    employeeCode: 'EMP-1088',
    name: '李伟',
    department: '生产制造部',
    title: '工艺工程师',
    phone: '13800000002',
    email: 'liwei@letian.com',
    certifications: '六西格玛绿带 / SPC 过程控制',
    mrbSeat: true,
    mrbRole: 'TECH_DIR',
    status: 'ACTIVE',
    isActive: true,
    createdAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: 'f6a1b2c3-d4e5-4f6a-b17c-8d9e0f1a2b3c',
    employeeCode: 'EMP-1095',
    name: '刘芳',
    department: '质量保证部',
    title: '成品终检质检员',
    phone: '13800000003',
    email: 'liufang@letian.com',
    certifications: '三坐标测量 / 金相分析二级',
    mrbSeat: false,
    mrbRole: '',
    status: 'ACTIVE',
    isActive: true,
    createdAt: '2023-01-01T08:00:00.000Z',
  },
];

export const mockEmployees: EmployeeDisplay[] = rawEmployees.map((e) => {
  EmployeeSchema.parse(e);
  return e;
});

export interface MaterialDisplay extends Material {
  category: string;
  stock: string;
  inspectionPlan: string;
  status: string;
}

const rawMaterials: MaterialDisplay[] = [
  {
    id: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    materialCode: 'MAT-304SS-05',
    materialName: '不锈钢线材 Φ5.0mm',
    specModel: 'Φ5.0mm / 盘圆 / 304HC',
    categoryCode: 'CAT-RAW',
    category: '原材料与线材',
    unit: 'KG',
    stock: '2,000 / 5,000 KG',
    inspectionPlan: 'QP-IQC-304SS-V2',
    status: 'ACTIVE',
    createdAt: '2023-01-01T08:00:00.000Z',
    updatedAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
    materialCode: 'MAT-SCR-M6-25',
    materialName: '高强度螺柱 M6*25 (冷镦毛坯)',
    specModel: 'M6*25 / 10.9级毛坯',
    categoryCode: 'CAT-SEMI',
    category: '工序半成品件',
    unit: 'PCS',
    stock: '18,000 / 30,000 PCS',
    inspectionPlan: 'QP-IPQC-CUT-V3',
    status: 'ACTIVE',
    createdAt: '2023-01-01T08:00:00.000Z',
    updatedAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
    materialCode: 'MAT-BLT-109-M10',
    materialName: '10.9级六角头螺栓 M10*45 (成品)',
    specModel: 'M10*45 / GB/T 5782 / 蓝白锌',
    categoryCode: 'CAT-FIN-BOLT',
    category: '成品紧固件 / 高强度螺栓类',
    unit: 'PCS',
    stock: '42,000 / 60,000 PCS',
    inspectionPlan: 'QP-FQC-AUTO-V4',
    status: 'ACTIVE',
    createdAt: '2023-01-01T08:00:00.000Z',
    updatedAt: '2023-01-01T08:00:00.000Z',
  },
];

export const mockMaterials: MaterialDisplay[] = rawMaterials.map((m) => {
  MaterialSchema.parse(m);
  return m;
});

// ---- 物料分类树 (页面树形模型；底层节点仍按 InventoryCategorySchema 校验) ----

export interface CategoryTreeNode {
  id: string;
  code: string;
  name: string;
  count: number;
  children: CategoryTreeNode[];
}

interface RawCategoryNode extends InventoryCategory {
  displayId: string;
  materialCount: number;
}

const rawCategoryNodes: RawCategoryNode[] = [
  {
    id: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    displayId: 'cat-raw',
    categoryCode: 'CAT-RAW',
    categoryName: '原材料与线材',
    parentCode: undefined,
    level: 1,
    materialCount: 12,
    createdAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
    displayId: 'cat-raw-wire',
    categoryCode: 'CAT-RAW-WIRE',
    categoryName: '不锈钢盘条与精拔丝',
    parentCode: 'CAT-RAW',
    level: 2,
    materialCount: 7,
    createdAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
    displayId: 'cat-semi',
    categoryCode: 'CAT-SEMI',
    categoryName: '工序半成品件',
    parentCode: undefined,
    level: 1,
    materialCount: 24,
    createdAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
    displayId: 'cat-semi-blank',
    categoryCode: 'CAT-SEMI-BLANK',
    categoryName: '下料切断胚料',
    parentCode: 'CAT-SEMI',
    level: 2,
    materialCount: 9,
    createdAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: 'e5f6a1b2-c3d4-4e5f-a06b-7c8d9e0f1a2b',
    displayId: 'cat-semi-thread',
    categoryCode: 'CAT-SEMI-THREAD',
    categoryName: '冷镦搓丝半成品',
    parentCode: 'CAT-SEMI',
    level: 2,
    materialCount: 15,
    createdAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: 'f6a1b2c3-d4e5-4f6a-b17c-8d9e0f1a2b3c',
    displayId: 'cat-finished',
    categoryCode: 'CAT-FINISH',
    categoryName: '成品紧固件',
    parentCode: undefined,
    level: 1,
    materialCount: 48,
    createdAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: '1a2b3c4d-5e6f-4a1b-82c3-d4e5f6a7b8c9',
    displayId: 'cat-finished-bolt',
    categoryCode: 'CAT-FIN-BOLT',
    categoryName: '高强度螺栓类',
    parentCode: 'CAT-FINISH',
    level: 2,
    materialCount: 30,
    createdAt: '2023-01-01T08:00:00.000Z',
  },
  {
    id: '2b3c4d5e-6f7a-4b2c-93d4-e5f6a7b8c9d0',
    displayId: 'cat-finished-nut',
    categoryCode: 'CAT-FIN-NUT',
    categoryName: '高强度螺母类',
    parentCode: 'CAT-FINISH',
    level: 2,
    materialCount: 18,
    createdAt: '2023-01-01T08:00:00.000Z',
  },
];

// 分类节点单一来源：每个节点先过契约校验，接口返回的树即由校验后的节点构建。
// displayId / materialCount 不是契约字段 (InventoryCategorySchema.parse 会把它们 strip 掉)，
// 但物料分类树页面依赖它们 (树节点 id、以及 "N 项物料" 计数)，因此在校验结果旁显式保留。
interface ValidatedCategoryNode {
  validated: InventoryCategory;
  displayId: string;
  materialCount: number;
}

const categoryNodes: ValidatedCategoryNode[] = rawCategoryNodes.map((c) => ({
  validated: InventoryCategorySchema.parse(c),
  displayId: c.displayId,
  materialCount: c.materialCount,
}));

export const mockCategories: InventoryCategory[] = categoryNodes.map((n) => n.validated);

function buildCategoryTree(parentCode: string | undefined): CategoryTreeNode[] {
  return categoryNodes
    .filter((n) => n.validated.parentCode === parentCode)
    .map((n) => ({
      id: n.displayId,
      code: n.validated.categoryCode,
      name: n.validated.categoryName,
      count: n.materialCount,
      children: buildCategoryTree(n.validated.categoryCode),
    }));
}

export const mockCategoryTree: CategoryTreeNode[] = buildCategoryTree(undefined);

// ==========================================
// 4. INSPECTION PLAN MOCK DATA (质检方案库 / 质检方案设计页)
//    仅用于离线 Mock（MSW）与桌面演示包；真实环境一律走 GET /api/v1/plans
// ==========================================

/** 指标项生成器：按检验类别批量生成，使「检验类别」徽标与「检验项目数」与设计稿口径一致 */
function planItems(
  prefix: string,
  spec: { appearance?: number; dimension?: number; performance?: number; chemical?: number }
): InspectionPlanItem[] {
  const items: InspectionPlanItem[] = [];
  const add = (
    metricCategory: MetricCategory,
    count: number,
    label: string,
    unit: string,
    standardText: string,
    /**
     * 数值基准（可选）：给了就能走领域判标服务实时判合格/不合格；
     * 标准语本身推不出数值基准的类别（如"按图纸公差 ±0.05mm"）刻意不填，
     * 录入页会如实显示"待判定"，符合"缺标准严禁放行"的口径。
     */
    numericBounds?: { nominalValue: number; upperTolerance: number; lowerTolerance: number }
  ): void => {
    for (let index = 1; index <= count; index += 1) {
      items.push({
        seq: items.length + 1,
        itemCode: `${prefix}-${metricCategory.slice(0, 3)}-${String(index).padStart(2, '0')}`,
        name: `${label}${index}`,
        dataType: 'NUMERIC',
        metricCategory,
        standardText,
        unit,
        sampleSize: 5,
        isMandatory: true,
        ...(numericBounds ?? {}),
      });
    }
  };
  if (spec.appearance) add('APPEARANCE', spec.appearance, '外观与表面缺陷检查 ', '—', '目视：无裂纹、无锈蚀、无毛刺');
  if (spec.dimension) add('DIMENSION', spec.dimension, '尺寸检测项 ', 'mm', '按图纸公差 ±0.05mm');
  if (spec.performance)
    add('MECHANICAL_PERFORMANCE', spec.performance, '机械性能项 ', 'MPa', '抗拉强度 ≥800MPa', {
      nominalValue: 800,
      upperTolerance: 200,
      lowerTolerance: 0,
    });
  if (spec.chemical)
    add('CHEMICAL_COMPOSITION', spec.chemical, '化学成分项 ', '%', 'C 0.05%~0.11%', {
      nominalValue: 0.08,
      upperTolerance: 0.03,
      lowerTolerance: 0.03,
    });
  return items;
}

/** Mock 职员 UUID（与文件内 mockEmployees 一致，用于「创建人」列解析姓名） */
const MOCK_PLAN_CREATORS = {
  zhangQiang: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
  liWei: 'c3d4e5f6-a1b2-4c3d-ae4f-5a6b7c8d9e0f',
  liuFang: 'f6a1b2c3-d4e5-4f6a-b17c-8d9e0f1a2b3c',
} as const;

interface PlanSeed {
  planCode: string;
  planName: string;
  inspectionType: InspectionType;
  materialCode: string;
  versionNo: string;
  status: PlanVersionStatus;
  createdBy: string;
  /** ISO 时间（UTC）；页面按本地时区渲染 */
  updatedAt: string;
  items: InspectionPlanItem[];
}

/** 12 条方案（首屏 6 条 + 第二页 6 条）：10 已启用 / 1 待审批草稿 / 1 已停用 */
const rawPlans: PlanSeed[] = [
  { planCode: 'QP-20260706-001', planName: '六角螺栓M10-来料检验', inspectionType: 'IQC', materialCode: 'MAT-BLT-109-M10', versionNo: 'v1.2', status: 'ACTIVE', createdBy: MOCK_PLAN_CREATORS.zhangQiang, updatedAt: '2026-07-06T02:30:00.000Z', items: planItems('QP-001', { appearance: 6, dimension: 15 }) },
  { planCode: 'QP-20260706-002', planName: '六角螺栓M10-过程检验', inspectionType: 'IPQC_RL', materialCode: 'MAT-BLT-109-M10', versionNo: 'v1.1', status: 'ACTIVE', createdBy: MOCK_PLAN_CREATORS.liWei, updatedAt: '2026-07-05T08:00:00.000Z', items: planItems('QP-002', { performance: 9 }) },
  { planCode: 'QP-20260706-003', planName: '碳钢圆钢-来料检验', inspectionType: 'IQC', materialCode: 'MAT-SCR-M6-25', versionNo: 'v2.0', status: 'ACTIVE', createdBy: MOCK_PLAN_CREATORS.zhangQiang, updatedAt: '2026-07-04T01:15:00.000Z', items: planItems('QP-003', { appearance: 6, dimension: 13 }) },
  { planCode: 'QP-20260706-004', planName: '不锈钢棒料-来料检验', inspectionType: 'IQC', materialCode: 'MAT-304SS-05', versionNo: 'v1.0', status: 'DRAFT', createdBy: MOCK_PLAN_CREATORS.liWei, updatedAt: '2026-07-03T06:20:00.000Z', items: planItems('QP-004', { appearance: 6, dimension: 15, performance: 9 }) },
  { planCode: 'QP-20260706-005', planName: '六角螺栓M12-出货检验', inspectionType: 'OQC_SH', materialCode: 'MAT-BLT-109-M10', versionNo: 'v1.3', status: 'ACTIVE', createdBy: MOCK_PLAN_CREATORS.liuFang, updatedAt: '2026-07-02T03:45:00.000Z', items: planItems('QP-005', { appearance: 6, dimension: 10, performance: 9 }) },
  { planCode: 'QP-20260706-006', planName: '法兰螺栓-来料检验', inspectionType: 'IQC', materialCode: 'MAT-BLT-109-M10', versionNo: 'v1.1', status: 'ACTIVE', createdBy: MOCK_PLAN_CREATORS.zhangQiang, updatedAt: '2026-07-01T07:30:00.000Z', items: planItems('QP-006', { appearance: 6, dimension: 16 }) },
  { planCode: 'QP-20260706-007', planName: '平垫圈-出货检验', inspectionType: 'OQC_SH', materialCode: 'MAT-SCR-M6-25', versionNo: 'v1.0', status: 'ACTIVE', createdBy: MOCK_PLAN_CREATORS.liuFang, updatedAt: '2026-06-30T05:10:00.000Z', items: planItems('QP-007', { appearance: 4, dimension: 8 }) },
  { planCode: 'QP-20260706-008', planName: '冷镦盘圆丝-来料检验', inspectionType: 'IQC', materialCode: 'MAT-304SS-05', versionNo: 'v2.1', status: 'ACTIVE', createdBy: MOCK_PLAN_CREATORS.liWei, updatedAt: '2026-06-29T09:40:00.000Z', items: planItems('QP-008', { dimension: 10, chemical: 4 }) },
  { planCode: 'QP-20260706-009', planName: '下料工序-过程检验', inspectionType: 'IPQC_CT', materialCode: 'MAT-SCR-M6-25', versionNo: 'v1.4', status: 'ACTIVE', createdBy: MOCK_PLAN_CREATORS.zhangQiang, updatedAt: '2026-06-28T02:05:00.000Z', items: planItems('QP-009', { appearance: 3, dimension: 9 }) },
  { planCode: 'QP-20260706-010', planName: '螺纹尺寸-过程检验', inspectionType: 'IPQC_RL', materialCode: 'MAT-SCR-M6-25', versionNo: 'v1.2', status: 'ACTIVE', createdBy: MOCK_PLAN_CREATORS.liWei, updatedAt: '2026-06-27T06:55:00.000Z', items: planItems('QP-010', { dimension: 12 }) },
  { planCode: 'QP-20260706-011', planName: '旧版法兰螺栓-来料检验', inspectionType: 'IQC', materialCode: 'MAT-BLT-109-M10', versionNo: 'v0.9', status: 'INACTIVE', createdBy: MOCK_PLAN_CREATORS.zhangQiang, updatedAt: '2026-06-26T01:20:00.000Z', items: planItems('QP-011', { appearance: 3, dimension: 7 }) },
  { planCode: 'QP-20260706-012', planName: '精密轴套-成品终检', inspectionType: 'IPQC_FN', materialCode: 'MAT-BLT-109-M10', versionNo: 'v1.0', status: 'ACTIVE', createdBy: MOCK_PLAN_CREATORS.liuFang, updatedAt: '2026-06-25T08:35:00.000Z', items: planItems('QP-012', { dimension: 9, performance: 6 }) },
];

export const mockPlans: InspectionPlan[] = rawPlans.map((seed, index) => {
  const suffix = String(index + 1).padStart(12, '0');
  const planId = `27000000-0000-4000-8000-${suffix}`;
  const plan: InspectionPlan = {
    id: planId,
    planCode: seed.planCode,
    planName: seed.planName,
    inspectionType: seed.inspectionType,
    materialCode: seed.materialCode,
    versions: [
      {
        id: `28000000-0000-4000-8000-${suffix}`,
        planId,
        versionNo: seed.versionNo,
        status: seed.status,
        samplingScheme: 'GB_T_2828',
        aqlLevel: 'II',
        strictness: 'NORMAL',
        items: seed.items,
        createdBy: seed.createdBy,
        createdAt: seed.updatedAt,
      },
    ],
    createdAt: seed.updatedAt,
    updatedAt: seed.updatedAt,
  };
  InspectionPlanSchema.parse(plan);
  return plan;
});

/**
 * 质检方案的展示字段派生（Mock 侧与真实后端读时 JOIN 同口径，见 docs/20 第 5 节）。
 *
 * 真实后端由 `KyselyInspectionPlanRepository.loadPlanByCode()` 联表 materials / inventory_categories /
 * employees 派生 materialName / categoryName / categoryId / createdByName，并按版本状态派生方案级 status；
 * 这里补同一份派生逻辑，避免离线演示出现"字段缺口"，也保证 Mock 与真实接口的形状一致。
 */
export function withPlanDisplayFields(plan: InspectionPlan): InspectionPlan {
  const materialCode = plan.materialCode ?? '';
  const material = mockMaterials.find((item) => item.materialCode === materialCode);
  // 分类归属与 014 迁移同口径：物料专属方案取该物料的存货分类
  const categoryCode = plan.categoryCode ?? material?.categoryCode ?? undefined;
  const category =
    categoryCode !== undefined
      ? mockCategories.find((item) => item.categoryCode === categoryCode)
      : undefined;

  const versions = (plan.versions ?? []).map((version) => {
    const creator = mockEmployees.find((employee) => employee.id === version.createdBy);
    return creator !== undefined ? { ...version, createdByName: creator.name } : { ...version };
  });

  // 方案级状态口径与契约 PlanStatusEnum 一致：有 ACTIVE=已启用，仅 DRAFT=待审批，否则已停用
  const status: PlanStatus = versions.some((version) => version.status === 'ACTIVE')
    ? 'ENABLED'
    : versions.some((version) => version.status === 'DRAFT')
      ? 'PENDING_APPROVAL'
      : 'DISABLED';

  return {
    ...plan,
    ...(material !== undefined ? { materialName: material.materialName } : {}),
    ...(category !== undefined
      ? { categoryId: category.id, categoryName: category.categoryName }
      : {}),
    ...(categoryCode !== undefined ? { categoryCode } : {}),
    isCategoryDefault: materialCode === '' && categoryCode !== undefined,
    status,
    versions,
  };
}

/**
 * 方案编码取号（Mock 侧）：与真实后端同口径 —— `QP-{YYYYMMDD}-{NNN}`，当日流水，3 位左补零。
 *
 * 序号取 mock 方案库中**同日前缀**的最大值 +1，因此离线演示同样"不重号、不跳号"，
 * 与 `@letian/domain` 的 inspection-plan-number 及迁移 017 的取号池行为一致
 * （Mock 没有数据库行锁，故用"扫描当前集合并取最大值"这一等价实现）。
 */
export function allocateMockPlanCode(
  existing: readonly InspectionPlan[],
  today: Date = new Date()
): string {
  const dayKey = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(
    today.getDate()
  ).padStart(2, '0')}`;
  const prefix = `QP-${dayKey}-`;
  const maxSeq = existing.reduce((max, plan) => {
    if (!plan.planCode.startsWith(prefix)) return max;
    const seq = Number(plan.planCode.slice(prefix.length));
    return Number.isInteger(seq) && seq > max ? seq : max;
  }, 0);
  return `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;
}
