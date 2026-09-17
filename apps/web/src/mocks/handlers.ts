import { http, HttpResponse } from 'msw';
import {
  mockInspectionOrders,
  mockMrbRecords,
  mockTraceabilityGraph,
  mockIntegrationConfigs,
  mockIntegrationLogs,
  mockSuppliers,
  mockCustomers,
  mockWorkshops,
  mockEmployees,
  mockMaterials,
  mockCategoryTree,
  mockEquipmentMappings,
  mockInterceptionRules,
  type MesEquipmentMapping,
} from './data';
import {
  InspectionOrderSchema,
  CreateInspectionOrderRequestSchema,
  MRBReviewSchema,
  PaginatedMRBRecordsSchema,
  TraceabilityGraphResponseSchema,
  IntegrationConfigSchema,
  IntegrationSyncLogSchema,
  TriggerSyncResponseSchema,
  type InspectionOrder,
  type MRBReview,
  type TriggerSyncRequest,
} from '@letian/contracts';
import { inspectionTypeMatchesGroup } from '../lib/inspectionTypes';

// In-memory working copies for live updates
const inspectionOrdersList: InspectionOrder[] = [...mockInspectionOrders];
const mrbList: MRBReview[] = [...mockMrbRecords];
const equipmentList: MesEquipmentMapping[] = [...mockEquipmentMappings];

export const handlers = [
  // ==========================================
  // 0. AUTH API (Mock 登录支持)
  // ==========================================
  http.post('/api/v1/auth/login', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, any>;
    const user = {
      userId: body.userId || '11111111-1111-1111-1111-111111111111',
      userName: body.userName || '张三 (测试质检员)',
      role: body.role || 'INSPECTOR',
      department: body.department || '品质保证部',
      permissions: body.permissions || ['*'],
    };
    return HttpResponse.json({
      token: 'mock_jwt_token_for_dev_mode_' + Date.now(),
      user,
      expiresInSeconds: 86400,
      devOnly: true,
    });
  }),

  // ==========================================
  // 1. INSPECTIONS API (InspectionOrder)
  // ==========================================
  http.get('/api/v1/inspections', ({ request }) => {
    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const status = url.searchParams.get('status');
    const keyword = url.searchParams.get('keyword');

    let filtered = [...inspectionOrdersList];
    if (type && type !== 'ALL') {
      // 页面筛选页签 (IQC / IPQC / FQC / OQC) 与前端展示共用
      // src/lib/inspectionTypes.ts 的同一份分组定义，避免前后端规则漂移
      filtered = filtered.filter((r) => inspectionTypeMatchesGroup(r.inspectionType, type));
    }
    if (status && status !== 'ALL') {
      filtered = filtered.filter((r) => r.status === status);
    }
    if (keyword) {
      const q = keyword.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.batchNo.toLowerCase().includes(q) ||
          r.materialName.toLowerCase().includes(q) ||
          r.materialCode.toLowerCase().includes(q) ||
          r.orderNo.toLowerCase().includes(q)
      );
    }

    // 每一条记录严格校验
    const validatedItems = filtered.map((item) => InspectionOrderSchema.parse(item));

    return HttpResponse.json({
      items: validatedItems,
      total: validatedItems.length,
      page: 1,
      pageSize: 50,
    });
  }),

  http.get('/api/v1/inspections/:id', ({ params }) => {
    const record = inspectionOrdersList.find((r) => r.id === params.id);
    if (!record) {
      return new HttpResponse(null, { status: 404 });
    }
    const validated = InspectionOrderSchema.parse(record);
    return HttpResponse.json(validated);
  }),

  http.post('/api/v1/inspections', async ({ request }) => {
    const body = await request.json();
    const validatedDto = CreateInspectionOrderRequestSchema.parse(body);

    const newRecord: InspectionOrder = {
      id: crypto.randomUUID(),
      orderNo: `INS-${Date.now().toString().slice(-8)}`,
      inspectionType: validatedDto.inspectionType,
      materialCode: validatedDto.materialCode,
      materialName: validatedDto.materialName,
      batchNo: validatedDto.batchNo,
      supplierCode: validatedDto.supplierCode,
      customerCode: validatedDto.customerCode,
      sampleQty: validatedDto.sampleQty,
      passQty: 0,
      failQty: 0,
      isMandatoryGate: validatedDto.isMandatoryGate ?? false,
      status: 'PENDING',
      overallDecision: undefined,
      inspectorId: undefined,
      inspectionNotes: '新建质检工单',
      planVersionId: validatedDto.planVersionId,
      planSnapshot: {
        planId: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
        planCode: `QP-${validatedDto.inspectionType}-AUTO`,
        planName: `${validatedDto.materialName} 自动匹配检验方案`,
        versionId: validatedDto.planVersionId,
        versionNo: 'V1.0',
        samplingScheme: 'GB_T_2828',
        aqlLevel: 'II',
        strictness: 'NORMAL',
        items: [],
        snapshotAt: new Date().toISOString(),
      },
      items: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const validatedRecord = InspectionOrderSchema.parse(newRecord);
    inspectionOrdersList.unshift(validatedRecord);
    return HttpResponse.json(validatedRecord, { status: 201 });
  }),

  // ==========================================
  // 2. MRB API
  // ==========================================
  http.get('/api/v1/mrb/records', ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');

    let filtered = [...mrbList];
    if (status && status !== 'ALL') {
      filtered = filtered.filter((m) => m.status === status);
    }

    const validatedItems = filtered.map((item) => MRBReviewSchema.parse(item));

    const payload = {
      items: validatedItems,
      total: validatedItems.length,
      page: 1,
      pageSize: 20,
      pendingCount: mrbList.filter((m) => m.status === 'PENDING_REVIEW').length,
      underReviewCount: mrbList.filter((m) => m.status === 'UNDER_REVIEW').length,
      totalReviewedCount: mrbList.filter(
        (m) => m.status === 'UNDER_REVIEW' || m.status === 'DISPOSED' || m.status === 'REJECTED'
      ).length,
      disposedCount: mrbList.filter((m) => m.status === 'DISPOSED').length,
      monthlyReviewRate: 88.9,
    };

    const validated = PaginatedMRBRecordsSchema.parse(payload);
    return HttpResponse.json(validated);
  }),

  http.post('/api/v1/mrb/records/:id/signatures', async ({ params, request }) => {
    const body = (await request.json()) as {
      roleCode: string;
      approverName: string;
      action: 'APPROVED' | 'REJECTED';
      comment?: string;
    };
    const target = mrbList.find((m) => m.id === params.id);
    if (!target) {
      return new HttpResponse(null, { status: 404 });
    }

    const newApprover = {
      userId: crypto.randomUUID(),
      userName: body.approverName,
      roleCode: body.roleCode,
      action: body.action,
      comment: body.comment?.trim() || '会签同意',
      signedAt: new Date().toISOString(),
    };

    const approverIndex = target.approvers.findIndex((a) => a.roleCode === body.roleCode);
    if (approverIndex >= 0) {
      target.approvers[approverIndex] = newApprover;
    } else {
      target.approvers.push(newApprover);
    }

    target.updatedAt = new Date().toISOString();
    const validated = MRBReviewSchema.parse(target);
    return HttpResponse.json(validated);
  }),

  // ==========================================
  // 3. TRACEABILITY API
  // ==========================================
  http.get('/api/v1/traceability/graph/:batchNo', ({ params }) => {
    const graph = {
      ...mockTraceabilityGraph,
      batchNo: String(params.batchNo || 'LOT-2026-FN-01'),
    };
    const validated = TraceabilityGraphResponseSchema.parse(graph);
    return HttpResponse.json(validated);
  }),

  // ==========================================
  // 4. INTEGRATION API
  // ==========================================
  http.get('/api/v1/integration/configs', () => {
    const validated = mockIntegrationConfigs.map((cfg) =>
      IntegrationConfigSchema.parse(cfg)
    );
    return HttpResponse.json(validated);
  }),

  http.get('/api/v1/integration/logs', () => {
    const validated = mockIntegrationLogs.map((log) =>
      IntegrationSyncLogSchema.parse(log)
    );
    return HttpResponse.json(validated);
  }),

  http.get('/api/v1/integration/equipment', () => {
    return HttpResponse.json(equipmentList);
  }),

  http.put('/api/v1/integration/equipment/:id/status', async ({ params, request }) => {
    const body = (await request.json()) as { status?: string };
    const target = equipmentList.find((e) => e.id === params.id);
    if (!target) {
      return new HttpResponse(null, { status: 404 });
    }
    if (body.status === 'ONLINE' || body.status === 'INTERCEPTED') {
      target.status = body.status;
    }
    return HttpResponse.json(target);
  }),

  http.get('/api/v1/integration/rules', () => {
    return HttpResponse.json(mockInterceptionRules);
  }),

  http.post('/api/v1/integration/dispatch', async ({ request }) => {
    const body = (await request.json()) as TriggerSyncRequest;
    const resp = {
      batchNo: `SYNC-${Date.now().toString().slice(-8)}`,
      systemType: body.systemType || 'MES',
      syncDirection: 'PULL' as const,
      status: 'SUCCESS' as const,
      recordsCount: 38,
      message: `${body.systemType || 'MES'} 同步调度指令已接收并成功触发`,
    };
    const validated = TriggerSyncResponseSchema.parse(resp);
    return HttpResponse.json(validated);
  }),

  // ==========================================
  // 5. MASTER DATA API
  // ==========================================
  http.get('/api/v1/master-data/suppliers', () => {
    return HttpResponse.json(mockSuppliers);
  }),

  http.get('/api/v1/master-data/customers', () => {
    return HttpResponse.json(mockCustomers);
  }),

  http.get('/api/v1/master-data/inventory', () => {
    return HttpResponse.json(mockMaterials);
  }),

  http.get('/api/v1/master-data/workshops', () => {
    return HttpResponse.json(mockWorkshops);
  }),

  http.get('/api/v1/master-data/employees', () => {
    return HttpResponse.json(mockEmployees);
  }),

  http.get('/api/v1/master-data/categories', () => {
    return HttpResponse.json(mockCategoryTree);
  }),

  // ==========================================
  // 6. DASHBOARD SUMMARY STATS
  // ==========================================
  http.get('/api/v1/dashboard/stats', () => {
    return HttpResponse.json({
      todayInspections: 128,
      yieldRate: 99.42,
      interceptedBatches: 3,
      pendingMrb: 2,
      equipmentConnected: 48,
      equipmentOnlineRate: 97.9,
      defectDistribution: [
        { name: '下料毛刺/端斜', value: 34, percentage: '41.5%' },
        { name: '搓丝中径偏下差', value: 21, percentage: '25.6%' },
        { name: '冷镦头部裂纹', value: 12, percentage: '14.6%' },
        { name: '热处理硬度异常', value: 9, percentage: '11.0%' },
        { name: '表面防锈层瑕疵', value: 6, percentage: '7.3%' },
      ],
      weeklyTrend: {
        dates: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
        yieldRates: [99.1, 99.3, 98.9, 99.5, 99.2, 99.6, 99.42],
        inspectionCounts: [110, 125, 142, 138, 150, 95, 128],
        defectCounts: [1, 2, 4, 1, 3, 0, 1],
      },
      interceptionEvents: [
        {
          id: 'int-01',
          time: '10:42:15',
          station: '一车间精密下料机 CH-04',
          batch: 'B20231012-02',
          item: '端面毛刺超标 32%',
          mesStatus: 'MES产线受控锁机',
        },
        {
          id: 'int-02',
          time: '09:18:22',
          station: '热处理网带炉 3#',
          batch: 'B20231011-92',
          item: '炉温虚温 -25℃ 预警',
          mesStatus: '已拦截回火工步',
        },
      ],
    });
  }),
];
