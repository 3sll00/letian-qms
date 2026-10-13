import { http, HttpResponse } from 'msw';
import {
  mockInspectionOrders,
  mockMrbRecords,
  mockPendingDefects,
  mockReviewFlows,
  mockTraceabilityGraph,
  mockConcessionGraph,
  mockTraceBatchSearch,
  mockOrderChain,
  mockIntegrationConfigs,
  mockIntegrationLogs,
  mockSuppliers,
  mockCustomers,
  mockWorkshops,
  mockEmployees,
  mockMaterials,
  mockCompanyProfile,
  mockAuthUsers,
  mockCategoryTree,
  mockPlans,
  mockTestItems,
  withPlanDisplayFields,
  allocateMockPlanCode,
  mockEquipmentMappings,
  mockInterceptionRules,
  type MesEquipmentMapping,
} from './data';
import {
  InspectionOrderSchema,
  CreateInspectionOrderRequestSchema,
  UpdateInspectionHeaderRequestSchema,
  MRBReviewSchema,
  DisposeMRBResponseSchema,
  PendingDefectItemSchema,
  PaginatedMRBRecordsSchema,
  ReviewFlowSchema,
  TraceabilityGraphResponseSchema,
  TraceBatchSearchResponseSchema,
  TraceOrderChainResponseSchema,
  IntegrationConfigSchema,
  IntegrationSyncLogSchema,
  TriggerSyncResponseSchema,
  UpsertCompanyProfileRequestSchema,
  LoginResponseSchema,
  type InspectionOrder,
  type InspectionPlan,
  type MRBReview,
  type MRBDisposition,
  type PendingDefectItem,
  type ReviewFlow,
  type TriggerSyncRequest,
  type CompanyProfile,
  // 检验环节 → 不合格来源分类的唯一口径（后端同源复用，docs/44 §1）
  inspectionTypeToFailCategory,
} from '@letian/contracts';
import {
  deriveInspectionStateLabel,
  INSPECTION_STATE_OPTIONS,
  inspectionTypeMatchesGroup,
} from '../lib/inspectionTypes';

// In-memory working copies for live updates
const inspectionOrdersList: InspectionOrder[] = [...mockInspectionOrders];
const mrbList: MRBReview[] = [...mockMrbRecords];
const pendingPoolList: PendingDefectItem[] = [...mockPendingDefects];
const reviewFlowsList: ReviewFlow[] = [...mockReviewFlows];
const equipmentList: MesEquipmentMapping[] = [...mockEquipmentMappings];
const plansList: InspectionPlan[] = [...mockPlans];

/**
 * 当前登录身份（Mock 无服务端会话）。
 *
 * 真实后端从会话取「谁签核 / 谁维护」，离线 Mock 没有会话中间件，
 * 由登录接口写入这里，供签核与档案维护回执使用 —— 保证回执上的姓名与登录账号一致，
 * 而不是请求体里自称的任意姓名（与后端「不接受请求体自称」同口径）。
 */
let mockCurrentUser = {
  userId: '11111111-1111-1111-1111-111111111111',
  userName: '张三 (测试质检员)',
  role: 'INSPECTOR',
};

/** 企业档案 Mock 单行：null = 未维护（与真实后端 GET 无行返回 null 同口径） */
let companyProfileRow: CompanyProfile | null = { ...mockCompanyProfile };

/** 演示环境全员统一初始密码（与后端 auth.controller 的 defaultLoginPassword() 同口径） */
const MOCK_DEFAULT_PASSWORD = '123456';

/** 统一的账号/口令错误文案：不区分用户不存在与密码错误，避免账号枚举 */
const MOCK_INVALID_CREDENTIALS = '用户名或密码错误';

/** RFC 7807 problem+json 错误体（与后端异常处理器的输出结构保持一致） */
function problemResponse(status: number, title: string, detail: string) {
  return HttpResponse.json({ type: 'about:blank', title, status, detail }, { status });
}

/** 检验单状态合法值（与 @letian/domain 的 InspectionStateMachine / 契约 InspectionStatusEnum 对齐） */
const INSPECTION_STATUSES = [
  'PENDING',
  'INSPECTING',
  'DRAFT',
  'PASSED',
  'FAILED',
  'IN_MRB_REVIEW',
  'RE_INSPECTING',
  'COMPLETED',
] as const;

/** 契约 MRBDispositionEnum 的 4 个合法处置方式（与 packages/contracts 对齐） */
const MRB_DISPOSITIONS = ['RETURN_TO_VENDOR', 'REWORK', 'CONCESSION', 'SCRAP'] as const;

function isMrbDisposition(value: string): value is MRBDisposition {
  return (MRB_DISPOSITIONS as readonly string[]).includes(value);
}

/**
 * 待审核池环节筛选 → 池条目的检验环节标识集合。
 * 与 src/lib/inspectionTypes.ts 的分组口径一致（FQC 成品终检为 IPQC 的子集）。
 */
const POOL_STAGE_MEMBERS: Record<string, readonly string[]> = {
  IQC: ['IQC'],
  IPQC: ['IPQC', 'IPQC_CT', 'IPQC_RL', 'IPQC_FN'],
  FQC: ['FQC', 'IPQC_FN'],
  OQC: ['OQC', 'OQC_SF', 'OQC_SH', 'OQC_MACH', 'OQC_HEAT'],
};

function readPositiveInt(url: URL, key: string, fallback: number, max?: number): number {
  const raw = Number(url.searchParams.get(key) ?? '');
  const value = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
  return max !== undefined ? Math.min(max, value) : value;
}

/**
 * 检验人派生：真实后端在 listMrbReviews 内按 sourceOrderNo 关联
 * inspection_orders.inspector_name 构建 Map 后条件注入（绝不写 undefined），
 * Mock 层沿用同一口径，查不到对应检验单时不注入（页面显示「-」）。
 */
function inspectorNameByOrderNo(): Map<string, string> {
  const map = new Map<string, string>();
  for (const order of inspectionOrdersList) {
    if (order.inspectorName !== undefined) map.set(order.orderNo, order.inspectorName);
  }
  return map;
}

function withDerivedMrbFields(record: MRBReview, inspectorMap: Map<string, string>): MRBReview {
  const inspectorName = inspectorMap.get(record.sourceOrderNo);
  return inspectorName !== undefined ? { ...record, inspectorName } : { ...record };
}

/** 紧急程度白名单（契约 MRBUrgencyLevelEnum），非白名单值一律回落 NORMAL */
function isUrgencyLevel(value: string | undefined): value is 'NORMAL' | 'URGENT' | 'CRITICAL' {
  return value === 'NORMAL' || value === 'URGENT' || value === 'CRITICAL';
}

/**
 * 复检单构造（口径同后端 `create-reinspection.ts`，见 docs/26 §5.2）：
 * 沿用原单的批次凭证快照（入库单号 / 入库日期 / 规格型号 / 计量单位 / 供应商 / 客户 /
 * 销售出库 / 委外工艺），只重置「本轮判定产物」（实测值 / 判定 / 检验人 / 综合结论）。
 * 离线 Mock 与真实后端必须逐字段同口径，否则页面上看到的是 Mock 自己编的规则。
 */
function buildReinspectionOrder(source: InspectionOrder, round: number): InspectionOrder {
  const now = new Date().toISOString();
  return InspectionOrderSchema.parse({
    id: crypto.randomUUID(),
    orderNo: `${source.orderNo}-R${round}`,
    inspectionType: source.inspectionType,
    materialCode: source.materialCode,
    materialName: source.materialName,
    ...(source.specification !== undefined ? { specification: source.specification } : {}),
    ...(source.spec !== undefined ? { spec: source.spec } : {}),
    ...(source.unit !== undefined ? { unit: source.unit } : {}),
    batchNo: source.batchNo,
    ...(source.inboundNo !== undefined ? { inboundNo: source.inboundNo } : {}),
    ...(source.inboundDate !== undefined ? { inboundDate: source.inboundDate } : {}),
    ...(source.supplierCode !== undefined ? { supplierCode: source.supplierCode } : {}),
    ...(source.supplierName !== undefined ? { supplierName: source.supplierName } : {}),
    ...(source.customerCode !== undefined ? { customerCode: source.customerCode } : {}),
    ...(source.customerName !== undefined ? { customerName: source.customerName } : {}),
    ...(source.salesOrderNo !== undefined ? { salesOrderNo: source.salesOrderNo } : {}),
    ...(source.dispatchDate !== undefined ? { dispatchDate: source.dispatchDate } : {}),
    ...(source.salesOrderPoNo !== undefined ? { salesOrderPoNo: source.salesOrderPoNo } : {}),
    ...(source.erpStatus !== undefined ? { erpStatus: source.erpStatus } : {}),
    ...(source.processType !== undefined ? { processType: source.processType } : {}),
    ...(source.vendorName !== undefined ? { vendorName: source.vendorName } : {}),
    // 委外台账字段与 030 录入页字段（docs/36）：批次来源凭证与工件事实，复检单沿承原单
    // （检验日期不沿承：复检是新的检验周期）
    ...(source.outsourceNo !== undefined ? { outsourceNo: source.outsourceNo } : {}),
    ...(source.returnDate !== undefined ? { returnDate: source.returnDate } : {}),
    ...(source.materialGrade !== undefined ? { materialGrade: source.materialGrade } : {}),
    ...(source.techStandard !== undefined ? { techStandard: source.techStandard } : {}),
    sampleQty: source.sampleQty,
    passQty: 0,
    failQty: 0,
    isMandatoryGate: source.isMandatoryGate,
    status: 'PENDING',
    planVersionId: source.planVersionId,
    planSnapshot: source.planSnapshot,
    // 指标清单沿用原单快照，但判定与实测值必须由本轮重新产生（复检不继承上一轮的结论）
    items: source.items.map((item) => ({
      seq: item.seq,
      itemCode: item.itemCode,
      name: item.name,
      dataType: item.dataType,
      metricCategory: item.metricCategory,
      ...(item.standardText !== undefined ? { standardText: item.standardText } : {}),
      ...(item.acceptableValues !== undefined ? { acceptableValues: item.acceptableValues } : {}),
      ...(item.nominalValue !== undefined ? { nominalValue: item.nominalValue } : {}),
      ...(item.upperTolerance !== undefined ? { upperTolerance: item.upperTolerance } : {}),
      ...(item.lowerTolerance !== undefined ? { lowerTolerance: item.lowerTolerance } : {}),
      ...(item.sampleSize !== undefined ? { sampleSize: item.sampleSize } : {}),
      ...(item.unit !== undefined ? { unit: item.unit } : {}),
      isExempt: false,
      result: 'PENDING',
    })),
    createdAt: now,
    updatedAt: now,
    inspectionNotes: `MRB 返工复检（第 ${round} 轮，原单 ${source.orderNo}）`,
  });
}

export const handlers = [
  // ==========================================
  // 0. AUTH API (Mock 登录支持)
  // ==========================================
  // 登录页名单：与真实后端 GET /api/v1/auth/users 同口径（在职职员 + 主角色名）
  http.get('/api/v1/auth/users', () => HttpResponse.json(mockAuthUsers)),

  // 登录：与真实后端 POST /api/v1/auth/login 同口径 ——
  //   · 传 userId（一键登录演示）：不校验密码，身份必须在职员档案里查到；
  //   · 传 userName + password（登录页主路径）：密码须为统一初始密码，身份按姓名或工号匹配，
  //     不接受请求体自称姓名/角色；
  //   · 都不传：缺省身份固定为质量主管「张强」。
  http.post('/api/v1/auth/login', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const claimedId = typeof body.userId === 'string' ? body.userId : undefined;
    const claimedPassword = typeof body.password === 'string' ? body.password : undefined;

    const passwordProvided = claimedPassword !== undefined && claimedPassword !== '';
    if (passwordProvided && claimedPassword !== MOCK_DEFAULT_PASSWORD) {
      return problemResponse(401, 'Unauthorized', MOCK_INVALID_CREDENTIALS);
    }

    let userId: string;
    let userName: string;
    let role: string;
    let roleName: string;

    if (claimedId !== undefined) {
      const employee = mockAuthUsers.find((u) => u.id === claimedId);
      if (employee === undefined) {
        return problemResponse(401, 'Unauthorized', `用户不存在或未在员工档案注册: ${claimedId}`);
      }
      userId = employee.id;
      userName = employee.name;
      role = employee.roleCode;
      roleName = employee.roleName;
    } else if (passwordProvided) {
      const loginName = typeof body.userName === 'string' ? body.userName.trim() : '';
      const employee = mockAuthUsers.find(
        (u) => u.name === loginName || (u.employeeCode ?? '').toLowerCase() === loginName.toLowerCase()
      );
      if (employee === undefined) {
        return problemResponse(401, 'Unauthorized', MOCK_INVALID_CREDENTIALS);
      }
      userId = employee.id;
      userName = employee.name;
      role = employee.roleCode;
      roleName = employee.roleName;
    } else {
      // 与后端 authController 的缺省演示身份一致：EMPLOYEE_IDS.zhangQiang
      const fallback = mockAuthUsers.find((u) => u.roleCode === 'QA_MANAGER') ?? mockAuthUsers[0]!;
      userId = fallback.id;
      userName = typeof body.userName === 'string' && body.userName !== '' ? body.userName : fallback.name;
      role = typeof body.role === 'string' && body.role !== '' ? body.role : fallback.roleCode;
      roleName = fallback.roleName;
    }

    // 登录即记住当前身份：签核 / 企业档案维护的「谁做的」全部取自这里（客户端不能自称）
    mockCurrentUser = { userId, userName, role };
    return HttpResponse.json(
      LoginResponseSchema.parse({
        token: 'mock_jwt_token_for_dev_mode_' + Date.now(),
        user: { userId, userName, role, roleName, activeRulesCount: 0 },
        expiresInSeconds: 86400,
        devOnly: true,
      })
    );
  }),

  // ==========================================
  // 1. INSPECTIONS API (InspectionOrder)
  // ==========================================
  http.get('/api/v1/inspections', ({ request }) => {
    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const inspectionType = url.searchParams.get('inspectionType');
    const inspectionTypes = url.searchParams.get('inspectionTypes');
    const status = url.searchParams.get('status');
    const statuses = url.searchParams.get('statuses');
    const inspectionState = url.searchParams.get('inspectionState');
    const inspectionStates = url.searchParams.get('inspectionStates');
    const inspectors = url.searchParams.get('inspectors');
    const supplierCodes = url.searchParams.get('supplierCodes');
    const materialCodes = url.searchParams.get('materialCodes');
    const dateFrom = url.searchParams.get('dateFrom');
    const dateTo = url.searchParams.get('dateTo');
    const partner = url.searchParams.get('partner');
    const materialCode = url.searchParams.get('materialCode');
    const orderNo = url.searchParams.get('orderNo');
    const workOrderNo = url.searchParams.get('workOrderNo');
    const keyword = url.searchParams.get('keyword');
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? '20')));

    /** 逗号分隔的多值参数 -> 去空数组（与真实后端 /inspections 的 commaList 口径一致） */
    const multi = (raw: string | null): string[] =>
      (raw ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');

    const supplierNames = new Map(mockSuppliers.map((s) => [s.supplierCode, s.supplierName]));
    const customerNames = new Map(mockCustomers.map((c) => [c.customerCode, c.customerName]));

    let filtered = [...inspectionOrdersList];

    // 检验类型：多选 IN 语义优先于页签分组 / 单值
    const multiTypes = multi(inspectionTypes);
    if (multiTypes.length > 0) {
      filtered = filtered.filter((r) => multiTypes.includes(r.inspectionType));
    } else if (inspectionType) {
      filtered = filtered.filter((r) => r.inspectionType === inspectionType);
    } else if (type && type !== 'ALL') {
      // 页面筛选页签 (IQC / IPQC / FQC / OQC) 与前端展示共用
      // src/lib/inspectionTypes.ts 的同一份分组定义，避免前后端规则漂移
      filtered = filtered.filter((r) => inspectionTypeMatchesGroup(r.inspectionType, type));
    }

    // 检验状态：多选 IN 语义优先于单值
    const multiStatuses = multi(statuses);
    if (multiStatuses.length > 0) {
      filtered = filtered.filter((r) => multiStatuses.includes(r.status));
    } else if (status && status !== 'ALL') {
      filtered = filtered.filter((r) => r.status === status);
    }

    // 「检验状态」派生语义筛选（inspectionState 单值 / inspectionStates 多选，两参数间为 AND），
    // 与后端 toInspectionStateWhere 同一口径（docs 16 §5.1）：先按 status+overallDecision 派生
    // 再比对 —— 不能按原始 status IN 过滤（「不合格」包含 COMPLETED + judgment=FAILED 等形态）。
    const stateCodeToLabel: ReadonlyMap<string, string> = new Map(
      INSPECTION_STATE_OPTIONS.map((o) => [o.value, o.label])
    );
    const singleState = (inspectionState ?? '').trim();
    if (singleState !== '') {
      const label = stateCodeToLabel.get(singleState);
      filtered = filtered.filter(
        (r) => label !== undefined && deriveInspectionStateLabel(r.status, r.overallDecision) === label
      );
    }
    const multiStates = multi(inspectionStates);
    if (multiStates.length > 0) {
      const labels = multiStates
        .map((s) => stateCodeToLabel.get(s))
        .filter((v) => v !== undefined);
      filtered = filtered.filter((r) =>
        labels.includes(deriveInspectionStateLabel(r.status, r.overallDecision))
      );
    }

    // 检验人 / 供应商：多值 IN（按 id / 编码精确匹配）
    const multiInspectors = multi(inspectors);
    if (multiInspectors.length > 0) {
      filtered = filtered.filter(
        (r) => r.inspectorId !== undefined && multiInspectors.includes(r.inspectorId)
      );
    }
    const multiSuppliers = multi(supplierCodes);
    if (multiSuppliers.length > 0) {
      filtered = filtered.filter(
        (r) => r.supplierCode !== undefined && multiSuppliers.includes(r.supplierCode)
      );
    }
    // 「物料」多选：material_code IN 精确匹配，与真实后端 materialCodes 参数同口径
    const multiMaterials = multi(materialCodes);
    if (multiMaterials.length > 0) {
      filtered = filtered.filter((r) => multiMaterials.includes(r.materialCode));
    }

    // 日期范围：与真实后端一致按 createdAt 过滤（含起止当日）
    if (dateFrom) {
      filtered = filtered.filter((r) => (r.createdAt ?? '') >= `${dateFrom}T00:00:00`);
    }
    if (dateTo) {
      filtered = filtered.filter((r) => (r.createdAt ?? '') <= `${dateTo}T23:59:59.999`);
    }

    // 供应商/客户名称模糊匹配
    if (partner && partner.trim() !== '') {
      const q = partner.trim().toLowerCase();
      filtered = filtered.filter((r) => {
        const names = [
          r.supplierCode !== undefined ? supplierNames.get(r.supplierCode) ?? '' : '',
          r.customerCode !== undefined ? customerNames.get(r.customerCode) ?? '' : '',
        ];
        return names.some((name) => name.toLowerCase().includes(q));
      });
    }

    if (materialCode && materialCode.trim() !== '') {
      const q = materialCode.trim().toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.materialCode.toLowerCase().includes(q) || r.materialName.toLowerCase().includes(q)
      );
    }
    // 过程检验台账「检验工单」：只查检验单号（与真实后端 ?orderNo= 同口径，见 docs/28 §2.1）
    if (orderNo && orderNo.trim() !== '') {
      const q = orderNo.trim().toLowerCase();
      filtered = filtered.filter((r) => r.orderNo.toLowerCase().includes(q));
    }
    // 过程检验台账「生产工单」：生产工单号为空时按批次号兜底（与真实后端兜底口径一致，见 docs/28 §2.3）
    if (workOrderNo && workOrderNo.trim() !== '') {
      const q = workOrderNo.trim().toLowerCase();
      filtered = filtered.filter((r) =>
        (r.workOrderNo ?? r.batchNo).toLowerCase().includes(q)
      );
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

    // 与真实后端口径一致：createdAt 倒序，再按页切分；每一条记录严格校验
    const validatedItems = filtered
      .slice()
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .map((item) => InspectionOrderSchema.parse(item));

    const items = validatedItems.slice((page - 1) * pageSize, page * pageSize);

    return HttpResponse.json({
      items,
      total: validatedItems.length,
      page,
      pageSize,
    });
  }),

  // 检验明细筛选候选：检验人为库中出现过检验记录的员工，类型/状态为契约枚举全集
  http.get('/api/v1/inspections/filters', () => {
    const inspectors = new Map<string, string>();
    for (const order of inspectionOrdersList) {
      if (!order.inspectorId) continue;
      const employee = mockEmployees.find((e) => e.id === order.inspectorId);
      if (employee && employee.id !== undefined && !inspectors.has(employee.id)) {
        inspectors.set(employee.id, employee.name);
      }
    }
    return HttpResponse.json({
      inspectors: [...inspectors.entries()].map(([id, name]) => ({ id, name })),
      inspectionTypes: ['IQC', 'IPQC_CT', 'IPQC_RL', 'IPQC_FN', 'OQC_SF', 'OQC_SH'],
      statuses: [
        'PENDING',
        'INSPECTING',
        'DRAFT',
        'PASSED',
        'FAILED',
        'IN_MRB_REVIEW',
        'RE_INSPECTING',
        'COMPLETED',
      ],
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

  // 表头业务事实更新（`PATCH /inspections/{id}/header`，docs/47 §4.6 + docs/51 证书字段）：
  // 与真实后端同口径 —— 显式下发的键才改写，certFields 整袋覆盖（空对象 = 清空为未设置）
  http.patch('/api/v1/inspections/:id/header', async ({ params, request }) => {
    const index = inspectionOrdersList.findIndex((r) => r.id === params.id);
    if (index < 0) {
      return problemResponse(404, 'NotFound', `检验单不存在: ${String(params.id)}`);
    }
    const parsed = UpdateInspectionHeaderRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return problemResponse(400, 'ValidationError', '检验单表头更新请求体不合契约');
    }
    const body = parsed.data;
    const record = inspectionOrdersList[index]!;
    const updated = InspectionOrderSchema.parse({
      ...record,
      ...(body.furnaceHeatNo !== undefined
        ? { furnaceHeatNo: body.furnaceHeatNo === '' ? undefined : body.furnaceHeatNo }
        : {}),
      ...(body.materialGrade !== undefined ? { materialGrade: body.materialGrade } : {}),
      ...(body.techStandard !== undefined ? { techStandard: body.techStandard } : {}),
      ...(body.inspectedDate !== undefined ? { inspectedDate: body.inspectedDate } : {}),
      ...(body.certTemplate !== undefined ? { certTemplate: body.certTemplate } : {}),
      ...(body.certFields !== undefined
        ? { certFields: Object.keys(body.certFields).length === 0 ? undefined : body.certFields }
        : {}),
      updatedAt: new Date().toISOString(),
    });
    inspectionOrdersList[index] = updated;
    return HttpResponse.json(updated);
  }),

  http.post('/api/v1/inspections', async ({ request }) => {
    const body = await request.json();
    const validatedDto = CreateInspectionOrderRequestSchema.parse(body);

    // 方案版本：显式传入时以其为准；省略时（自动匹配口径）用演示版本占位。
    // 真实匹配逻辑在服务端 GET /api/v1/plans/match，见 docs/17-检验录入界面说明与质检方案匹配口径.md §7。
    const planVersionId = validatedDto.planVersionId ?? '11111111-1111-4111-8111-111111111111';

    // 与真实后端同口径（docs/26 §5.1）：名称 / 规格型号 / 计量单位省略时按 materialCode
    // 从存货档案补齐，避免离线 Mock 下新建工单的「规格型号」列落空。
    const material = mockMaterials.find((m) => m.materialCode === validatedDto.materialCode);
    const materialName = validatedDto.materialName ?? material?.materialName;
    if (materialName === undefined) {
      return problemResponse(
        400,
        'ValidationError',
        `物料名称缺失且无法从存货档案补齐：物料编码 [${validatedDto.materialCode}] 不存在`
      );
    }
    const specification = validatedDto.specification ?? validatedDto.spec ?? material?.specModel;
    const unit = validatedDto.unit ?? material?.unit;

    const newRecord: InspectionOrder = {
      id: crypto.randomUUID(),
      orderNo: `INS-${Date.now().toString().slice(-8)}`,
      inspectionType: validatedDto.inspectionType,
      materialCode: validatedDto.materialCode,
      materialName,
      ...(specification !== undefined ? { specification } : {}),
      ...(unit !== undefined ? { unit } : {}),
      batchNo: validatedDto.batchNo,
      supplierCode: validatedDto.supplierCode,
      customerCode: validatedDto.customerCode,
      // 委外台账字段与 030 录入页字段（docs/36）：与真实后端 POST /inspections 同口径透传，
      // 否则离线 Mock 新建的委外单在台账上「委外加工单号 / 加工类型 / 加工商 / 回厂日期」全为空
      ...(validatedDto.outsourceNo !== undefined ? { outsourceNo: validatedDto.outsourceNo } : {}),
      ...(validatedDto.processType !== undefined ? { processType: validatedDto.processType } : {}),
      ...(validatedDto.returnDate !== undefined ? { returnDate: validatedDto.returnDate } : {}),
      ...(validatedDto.vendorName !== undefined ? { vendorName: validatedDto.vendorName } : {}),
      ...(validatedDto.materialGrade !== undefined ? { materialGrade: validatedDto.materialGrade } : {}),
      ...(validatedDto.techStandard !== undefined ? { techStandard: validatedDto.techStandard } : {}),
      ...(validatedDto.inspectedDate !== undefined ? { inspectedDate: validatedDto.inspectedDate } : {}),
      // 038 证书模板与字段袋（docs/51）：建单即落库，离线 Mock 同口径透传
      ...(validatedDto.certTemplate !== undefined ? { certTemplate: validatedDto.certTemplate } : {}),
      ...(validatedDto.certFields !== undefined ? { certFields: validatedDto.certFields } : {}),
      sampleQty: validatedDto.sampleQty,
      passQty: 0,
      failQty: 0,
      isMandatoryGate: validatedDto.isMandatoryGate ?? false,
      status: 'PENDING',
      overallDecision: undefined,
      inspectorId: undefined,
      inspectionNotes: '新建质检工单',
      planVersionId,
      planSnapshot: {
        planId: 'd4e5f6a1-b2c3-4d4e-bf5a-6b7c8d9e0f1a',
        planCode: `QP-${validatedDto.inspectionType}-AUTO`,
        planName: `${materialName} 自动匹配检验方案`,
        versionId: planVersionId,
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

  // 录入写路径（docs/34 §6.2）：离线 Mock 同样接受「实测值落库 + 终判」两步，保证断网演示能走完
  // 录入链路；判标复算仍在服务端领域层，Mock 只搬数据，不在这里替服务端下结论。
  http.post('/api/v1/inspections/:id/submit-measurements', async ({ params, request }) => {
    const body = (await request.json()) as {
      items?: Array<{
        itemCode: string;
        measuredVal?: number;
        measuredText?: string;
        isExempt?: boolean;
        exemptReason?: string;
      }>;
      isDraft?: boolean;
      /** 检验员填写的合格 / 不合格数量（docs/21 §14）：与真实后端同口径随判定落库 */
      passQty?: number;
      failQty?: number;
    };
    const index = inspectionOrdersList.findIndex((r) => r.id === params.id);
    if (index < 0) {
      return problemResponse(404, 'NotFound', `检验单不存在: ${String(params.id)}`);
    }
    const record = inspectionOrdersList[index]!;
    const submitted = body.items ?? [];
    const items = (record.items ?? []).map((item) => {
      const hit = submitted.find((candidate) => candidate.itemCode === item.itemCode);
      if (hit === undefined) return item;
      // 不解检（EXEMPT）：与领域 evaluateInspectionItem 的免检特例同口径 ——
      // isExempt=true 单项恒判 EXEMPT，不计入合格率分母（v2.6.0 未结模块）
      return {
        ...item,
        ...(hit.isExempt !== undefined ? { isExempt: hit.isExempt } : {}),
        ...(hit.exemptReason !== undefined ? { exemptReason: hit.exemptReason } : {}),
        ...(hit.isExempt === true ? { result: 'EXEMPT' as const } : {}),
        ...(hit.measuredVal !== undefined ? { measuredVal: hit.measuredVal } : {}),
        ...(hit.measuredText !== undefined ? { measuredText: hit.measuredText } : {}),
      };
    });
    const updated = InspectionOrderSchema.parse({
      ...record,
      items,
      // 首次录入实测值即进入检验中（与真实后端 recordMeasurementsAndJudge 同口径）：
      // PENDING（新建单）与 RE_INSPECTING（MRB 返工回边后的复检轮次）都按状态机允许的边推进到 INSPECTING，
      // 否则离线演示能续录、真实库报 ORDER_NOT_EDITABLE（见 docs/17 §7.9）。
      status:
        record.status === 'PENDING' || record.status === 'RE_INSPECTING'
          ? 'INSPECTING'
          : record.status,
      // 检验员填写的合格 / 不合格数量随判定落库（与真实后端 recordMeasurementsAndJudge 同口径，docs/21 §14）；
      // 草稿只暂存实测值、不做判定，也就不落数量。
      ...(body.isDraft === true
        ? {}
        : {
            ...(body.passQty !== undefined ? { passQty: body.passQty } : {}),
            ...(body.failQty !== undefined ? { failQty: body.failQty } : {}),
          }),
      updatedAt: new Date().toISOString(),
    });
    inspectionOrdersList[index] = updated;
    return HttpResponse.json(updated);
  }),

  http.post('/api/v1/inspections/:id/status', async ({ params, request }) => {
    const body = (await request.json()) as {
      status?: string;
      judgment?: string;
      passQty?: number;
      failQty?: number;
      remark?: string;
      inspectionNotes?: string;
      preliminaryDisposition?: string;
    };
    const index = inspectionOrdersList.findIndex((r) => r.id === params.id);
    if (index < 0) {
      return problemResponse(404, 'NotFound', `检验单不存在: ${String(params.id)}`);
    }
    if (body.status === undefined || !(INSPECTION_STATUSES as readonly string[]).includes(body.status)) {
      return problemResponse(400, 'ValidationError', `非法检验单状态: ${String(body.status)}`);
    }
    const record = inspectionOrdersList[index]!;
    const notes = body.inspectionNotes ?? body.remark;
    const updated = InspectionOrderSchema.parse({
      ...record,
      status: body.status,
      ...(body.judgment !== undefined ? { overallDecision: body.judgment } : {}),
      ...(body.passQty !== undefined ? { passQty: body.passQty } : {}),
      ...(body.failQty !== undefined ? { failQty: body.failQty } : {}),
      ...(notes !== undefined ? { inspectionNotes: notes } : {}),
      ...(['PASSED', 'FAILED', 'COMPLETED'].includes(body.status)
        ? { completedAt: new Date().toISOString() }
        : {}),
      updatedAt: new Date().toISOString(),
    });
    inspectionOrdersList[index] = updated;

    // 判定不合格 -> **自动创建 MRB 评审单**并推进到 IN_MRB_REVIEW（docs/43：无人工发起环节）。
    // Mock 与真实后端同形：同一检验单幂等复用（sourceOrderNo 为天然键），
    // 台账条目（若存在）同步转 INITIATED —— 离线演示与真实环境表现一致。
    const nonconforming = updated.status === 'FAILED' || updated.overallDecision === 'FAILED';
    if (!nonconforming) {
      return HttpResponse.json(updated);
    }

    if (mrbList.every((m) => m.sourceOrderNo !== updated.orderNo)) {
      const now = new Date().toISOString();
      const poolItem = pendingPoolList.find((row) => row.orderNo === updated.orderNo);
      const created: MRBReview = {
        id: crypto.randomUUID(),
        mrbNo: `MRB-${now.slice(0, 10).replace(/-/g, '')}-${String(mrbList.length + 1).padStart(3, '0')}`,
        sourceType: inspectionTypeToFailCategory(updated.inspectionType),
        sourceOrderNo: updated.orderNo,
        ...(poolItem !== undefined ? { pendingDefectId: poolItem.id } : {}),
        batchNo: updated.batchNo,
        materialCode: updated.materialCode,
        materialName: updated.materialName,
        defectDescription: notes ?? `检验单 [${updated.orderNo}] 判定不合格，自动触发 MRB 评审`,
        defectQty: updated.failQty ?? 0,
        status: 'PENDING_REVIEW',
        // 拟定处置（docs/43 §4.4）：缺省 REWORK，终审时由处置决策覆盖
        disposition:
          body.preliminaryDisposition !== undefined && isMrbDisposition(body.preliminaryDisposition)
            ? body.preliminaryDisposition
            : 'REWORK',
        urgencyLevel: 'NORMAL',
        approvers: [],
        createdAt: now,
        updatedAt: now,
        ...(notes !== undefined ? { reviewNotes: notes } : {}),
      };
      mrbList.unshift(created);
      if (poolItem !== undefined) {
        poolItem.status = 'INITIATED';
        poolItem.mrbId = created.id;
      }
    } else {
      // 幂等复用：按口径把「不合格数量」对齐源单 fail_qty（真实后端 triggerMrbReviewInTransaction 同口径，
      // docs/21 §14）—— 建单与终判分属两次调用，数量不得停留在建单那一刻的中间态（那正是「显示成检测数」的来路）；
      // fail_qty = 0 视为检验员未填写，保留现值，绝不回退成 0。
      const failQty = updated.failQty ?? 0;
      const existingIndex = mrbList.findIndex((m) => m.sourceOrderNo === updated.orderNo);
      if (existingIndex >= 0 && failQty > 0 && mrbList[existingIndex]!.defectQty !== failQty) {
        mrbList[existingIndex] = {
          ...mrbList[existingIndex]!,
          defectQty: failQty,
          updatedAt: new Date().toISOString(),
        };
      }
    }

    const inMrb = InspectionOrderSchema.parse({
      ...updated,
      status: 'IN_MRB_REVIEW',
      updatedAt: new Date().toISOString(),
    });
    inspectionOrdersList[index] = inMrb;
    return HttpResponse.json(inMrb);
  }),

  // 质量负责人签核（docs/35 §5）：Mock 只搬数据，不替服务端下结论。
  // 落库字段与真实后端一致（approver_name / approved_at），签核人取当前登录身份，
  // 重复签核即覆盖（换人 / 换时间）；审计日志与角色门禁属服务端职责，Mock 不复刻。
  http.post('/api/v1/inspections/:id/approve', ({ params }) => {
    const index = inspectionOrdersList.findIndex((r) => r.id === params.id);
    if (index < 0) {
      return problemResponse(404, 'NotFound', `检验单不存在: ${String(params.id)}`);
    }
    const record = inspectionOrdersList[index]!;
    const updated = InspectionOrderSchema.parse({
      ...record,
      approverName: mockCurrentUser.userName,
      approvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    inspectionOrdersList[index] = updated;
    return HttpResponse.json(updated);
  }),

  // ==========================================
  // 2. MRB API（不合格品处置整合：待审核池 → 评审会签 → 处置结论）
  // 路由与请求体以 apps/api/src/controllers/mrb.controller.ts 为唯一真相源，
  // 页面口径见 docs/19-MRB不合格品处置页整合设计.md。
  // ==========================================

  // 2.1 待审核池：各检验环节判定不合格、尚未发起评审的记录（统一入口）
  http.get('/api/v1/mrb/pending-pool', ({ request }) => {
    const url = new URL(request.url);
    const stage =
      url.searchParams.get('stage') ??
      url.searchParams.get('sourceStage') ??
      url.searchParams.get('inspectionType');
    const status = url.searchParams.get('status');
    const materialCode = url.searchParams.get('materialCode');
    const batchNo = url.searchParams.get('batchNo');
    const page = readPositiveInt(url, 'page', 1);
    const pageSize = readPositiveInt(url, 'pageSize', 20, 100);

    let filtered = [...pendingPoolList];
    if (stage !== null && stage !== '' && stage !== 'ALL') {
      const members = POOL_STAGE_MEMBERS[stage];
      filtered =
        members !== undefined
          ? filtered.filter((item) => members.includes(item.inspectionType))
          : filtered.filter((item) => item.inspectionType === stage);
    }
    if (status !== null && status !== '') {
      filtered = filtered.filter((item) => item.status === status);
    }
    if (materialCode !== null && materialCode !== '') {
      filtered = filtered.filter((item) => item.materialCode === materialCode);
    }
    if (batchNo !== null && batchNo !== '') {
      filtered = filtered.filter((item) => item.batchNo === batchNo);
    }

    const start = (page - 1) * pageSize;
    const items = filtered
      .slice(start, start + pageSize)
      .map((item) => PendingDefectItemSchema.parse(item));

    // list 为兼容别名，与 items 指向同一份当页数据（与后端返回结构一致）
    return HttpResponse.json({
      items,
      list: items,
      total: filtered.length,
      page,
      pageSize,
    });
  }),

  // 2.2 待审核池逐条发起独立评审 → 生成 MRB 工单，池条目置为 INITIATED
  http.post('/api/v1/mrb/pending-pool/initiate', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      pendingDefectId?: string;
      flowId?: string;
      urgencyLevel?: string;
      reviewNotes?: string;
    };
    const item = pendingPoolList.find((row) => row.id === body.pendingDefectId);
    if (!item) {
      return problemResponse(404, 'NotFoundError', `待审核池条目不存在: ${body.pendingDefectId ?? ''}`);
    }
    if (item.status === 'INITIATED') {
      return problemResponse(409, 'ConflictError', `该不合格记录已发起过 MRB 评审: ${item.orderNo}`);
    }

    const sourceOrder = inspectionOrdersList.find((order) => order.orderNo === item.orderNo);
    const now = new Date().toISOString();
    // 015 起紧急程度 / 评审流程 / 发起说明均落库（docs/20 §4.2），Mock 与真实接口同形
    const created: MRBReview = {
      id: crypto.randomUUID(),
      mrbNo: `MRB-${now.slice(0, 10).replace(/-/g, '')}-${String(mrbList.length + 1).padStart(3, '0')}`,
      sourceType: inspectionTypeToFailCategory(sourceOrder?.inspectionType ?? item.inspectionType),
      sourceOrderNo: item.orderNo,
      pendingDefectId: item.id,
      batchNo: item.batchNo,
      materialCode: item.materialCode,
      materialName: item.materialName,
      defectDescription: item.defectDescription,
      defectQty: item.defectQty,
      status: 'PENDING_REVIEW',
      urgencyLevel: isUrgencyLevel(body.urgencyLevel) ? body.urgencyLevel : 'NORMAL',
      approvers: [],
      createdAt: now,
      updatedAt: now,
      ...(body.flowId !== undefined ? { reviewFlowId: body.flowId } : {}),
      ...(body.reviewNotes !== undefined ? { reviewNotes: body.reviewNotes } : {}),
    };

    mrbList.unshift(created);
    item.status = 'INITIATED';
    item.mrbId = created.id;

    return HttpResponse.json(MRBReviewSchema.parse(created), { status: 201 });
  }),

  // 2.3 MRB 列表：多状态页签、单号/来源单号模糊检索、处置方式与发现日期区间过滤 + KPI
  http.get('/api/v1/mrb/records', ({ request }) => {
    const url = new URL(request.url);
    const page = readPositiveInt(url, 'page', 1);
    const pageSize = readPositiveInt(url, 'pageSize', 20, 100);

    const statuses = (url.searchParams.get('status') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    const mrbNo = (url.searchParams.get('mrbNo') ?? '').trim().toLowerCase();
    const sourceOrderNo = (url.searchParams.get('sourceOrderNo') ?? '').trim().toLowerCase();
    const disposition = url.searchParams.get('disposition') ?? '';
    const dateFrom = url.searchParams.get('dateFrom');
    const dateTo = url.searchParams.get('dateTo');

    let filtered = [...mrbList];
    if (statuses.length > 0) {
      filtered = filtered.filter((m) => statuses.includes(m.status));
    }
    if (mrbNo !== '') {
      filtered = filtered.filter((m) => m.mrbNo.toLowerCase().includes(mrbNo));
    }
    if (sourceOrderNo !== '') {
      filtered = filtered.filter((m) => m.sourceOrderNo.toLowerCase().includes(sourceOrderNo));
    }
    if (disposition !== '') {
      filtered = filtered.filter((m) => m.disposition === disposition);
    }
    // 真实后端按本地日界右开区间过滤；Mock 单据为 ISO 时间戳，这里按日期前缀比较
    if (dateFrom !== null) {
      filtered = filtered.filter((m) => m.createdAt.slice(0, 10) >= dateFrom);
    }
    if (dateTo !== null) {
      filtered = filtered.filter((m) => m.createdAt.slice(0, 10) <= dateTo);
    }

    const start = (page - 1) * pageSize;
    const inspectorMap = inspectorNameByOrderNo();
    const validatedItems = filtered
      .slice(start, start + pageSize)
      .map((item) => MRBReviewSchema.parse(withDerivedMrbFields(item, inspectorMap)));

    // monthlyReviewRate 口径与后端一致（DISPOSED / 当月总数）；真实后端取「当前自然月」，
    // Mock 单据为固定历史日期，故取数据中最新单据所在月份作为统计窗口，避免演示恒为 0%。
    const referenceMonth = mrbList.reduce<string>(
      (latest, m) => (m.createdAt.slice(0, 7) > latest ? m.createdAt.slice(0, 7) : latest),
      ''
    );
    const monthRecords = mrbList.filter((m) => m.createdAt.startsWith(referenceMonth));
    const monthDisposed = monthRecords.filter((m) => m.status === 'DISPOSED').length;

    const payload = {
      items: validatedItems,
      total: filtered.length,
      page,
      pageSize,
      pendingCount: mrbList.filter((m) => m.status === 'PENDING_REVIEW').length,
      // 待发起评审的池条目数（与接口同名同义，docs/39 §2 D3）
      pendingPoolCount: pendingPoolList.filter((item) => item.status === 'PENDING_INITIATE').length,
      underReviewCount: mrbList.filter((m) => m.status === 'UNDER_REVIEW').length,
      totalReviewedCount: mrbList.filter(
        (m) => m.status === 'UNDER_REVIEW' || m.status === 'DISPOSED' || m.status === 'REJECTED'
      ).length,
      disposedCount: mrbList.filter((m) => m.status === 'DISPOSED').length,
      monthlyReviewRate:
        monthRecords.length > 0
          ? Number(((monthDisposed / monthRecords.length) * 100).toFixed(2))
          : 0,
    };

    const validated = PaginatedMRBRecordsSchema.parse(payload);
    return HttpResponse.json(validated);
  }),

  // 2.4 节点会签（携带会签席位 roleCode 与签署人姓名，写入 approvers 凭据）
  http.post('/api/v1/mrb/records/:id/sign', async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      comment?: string;
      roleCode?: string;
      approverName?: string;
    };
    const target = mrbList.find((m) => m.id === params.id);
    if (!target) {
      return problemResponse(404, 'NotFoundError', `MRB记录不存在: ${String(params.id)}`);
    }
    if (target.status === 'DISPOSED') {
      return problemResponse(409, 'ConflictError', `MRB 单据已完成处置，不能再发起会签: ${target.mrbNo}`);
    }

    const isApprove = body.action === 'APPROVE' || body.action === 'APPROVED';
    const comment = (body.comment ?? '').trim();
    const now = new Date().toISOString();

    target.approvers.push({
      userId: crypto.randomUUID(),
      userName: (body.approverName ?? '').trim() !== '' ? (body.approverName ?? '').trim() : '未署名',
      roleCode: (body.roleCode ?? '').trim() !== '' ? (body.roleCode ?? '').trim() : 'UNSPECIFIED',
      action: isApprove ? 'APPROVED' : 'REJECTED',
      comment: comment !== '' ? comment : isApprove ? '会签同意' : '会签驳回',
      signedAt: now,
    });
    // 口径同后端 submitSignature：会签通过进入评审中，驳回直接置为已驳回
    target.status = isApprove ? 'UNDER_REVIEW' : 'REJECTED';
    target.updatedAt = now;

    return HttpResponse.json(
      MRBReviewSchema.parse(withDerivedMrbFields(target, inspectorNameByOrderNo()))
    );
  }),

  http.post('/api/v1/mrb/records/:id/customer-sign-off', async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      customerName?: string;
      signOffDocumentUrl?: string;
      agreed?: boolean;
    };
    const target = mrbList.find((m) => m.id === params.id);
    if (!target) return problemResponse(404, 'NotFoundError', `MRB记录不存在: ${String(params.id)}`);
    if (target.status === 'DISPOSED' || target.status === 'REJECTED') {
      return problemResponse(400, 'MRB_ALREADY_FINISHED', 'MRB评审已结束');
    }
    if (!body.agreed || !body.customerName?.trim() || !body.signOffDocumentUrl?.trim()) {
      return problemResponse(400, 'CONCESSION_DOCUMENT_REQUIRED', '客户同意特采必须提交书面签核凭证');
    }
    target.concessionAttachmentUrl = body.signOffDocumentUrl.trim();
    target.updatedAt = new Date().toISOString();
    return HttpResponse.json(MRBReviewSchema.parse(withDerivedMrbFields(target, inspectorNameByOrderNo())));
  }),

  // 2.5 提交最终处置结论（特采让步接收必须提供客户书面签核凭证）
  http.post('/api/v1/mrb/records/:id/disposition', async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      disposition?: string;
      reason?: string;
      dispositionReason?: string;
      dispositionNotes?: string;
      concessionAttachmentUrl?: string;
    };
    const target = mrbList.find((m) => m.id === params.id);
    if (!target) {
      return problemResponse(404, 'NotFoundError', `MRB记录不存在: ${String(params.id)}`);
    }

    const rawDisposition = (body.disposition ?? '') === 'RETURN' ? 'RETURN_TO_VENDOR' : (body.disposition ?? '');
    if (!isMrbDisposition(rawDisposition)) {
      return problemResponse(
        400,
        'ValidationError',
        `处置方式非法: ${body.disposition ?? ''}（可选 ${MRB_DISPOSITIONS.join(' / ')}）`
      );
    }
    if (
      rawDisposition === 'CONCESSION' &&
      !target.concessionAttachmentUrl?.trim()
    ) {
      return problemResponse(400, 'ValidationError', '特采（让步接收）必须提供客户书面签核凭证');
    }

    const reason =
      (body.dispositionReason ?? '').trim() ||
      (body.reason ?? '').trim() ||
      (body.dispositionNotes ?? '').trim();
    const now = new Date().toISOString();

    target.disposition = rawDisposition;
    if (reason !== '') target.dispositionNotes = reason;
    target.status = 'DISPOSED';
    target.disposedAt = now;
    target.disposedBy = '张强';
    target.updatedAt = now;

    // 返工（REWORK）处置：与后端同口径，在同一事务内生成下一轮复检单，
    // 并把原单推进为 RE_INSPECTING（见 docs/26 §5.2 与 create-reinspection.ts）
    let reinspectionOrderId: string | undefined;
    let reinspectionOrderNo: string | undefined;
    if (rawDisposition === 'REWORK') {
      const sourceOrder = inspectionOrdersList.find((o) => o.orderNo === target.sourceOrderNo);
      if (sourceOrder !== undefined) {
        const round =
          inspectionOrdersList.filter((o) => o.batchNo === sourceOrder.batchNo).length + 1;
        const reinspection = buildReinspectionOrder(sourceOrder, round);
        sourceOrder.status = 'RE_INSPECTING';
        sourceOrder.updatedAt = now;
        inspectionOrdersList.unshift(reinspection);
        reinspectionOrderId = reinspection.id;
        reinspectionOrderNo = reinspection.orderNo;
      }
    }

    // 响应体 = MRB 单据本体 + 处置连带产物（契约 DisposeMRBResponse）
    return HttpResponse.json(
      DisposeMRBResponseSchema.parse({
        ...withDerivedMrbFields(target, inspectorNameByOrderNo()),
        ...(reinspectionOrderId !== undefined ? { reinspectionOrderId } : {}),
        ...(reinspectionOrderNo !== undefined ? { reinspectionOrderNo } : {}),
      })
    );
  }),

  // 2.6 评审流程定义列表（供「发起评审」抽屉选择流程）
  http.get('/api/v1/review-flows', () => {
    const items = reviewFlowsList.map((flow) => ReviewFlowSchema.parse(flow));
    return HttpResponse.json({ total: items.length, items });
  }),

  // 2.6.1 评审流程启停（「评审流程设置」页）
  // 口径与后端 review-flows.controller.ts 的 POST /:id/toggle-active 一致：
  // 路径必须带 -active（历史上前端打的 /toggle 恒 404），响应体为 { success, id, isActive }
  http.post('/api/v1/review-flows/:id/toggle-active', ({ params }) => {
    const index = reviewFlowsList.findIndex((flow) => flow.id === params.id);
    if (index < 0) {
      return problemResponse(404, '流程定义不存在', `未找到评审流程定义: ${String(params.id)}`);
    }
    const current = reviewFlowsList[index];
    const updated = { ...current, isActive: !current.isActive };
    reviewFlowsList[index] = updated;
    return HttpResponse.json({ success: true, id: updated.id, isActive: updated.isActive });
  }),

  // ==========================================
  // 3. TRACEABILITY API
  // ==========================================
  // 批次检索：两路数据源并集（已建血缘 + 仅有检验台账），返回命中批次清单
  http.get('/api/v1/traceability/batches', ({ request }) => {
    const url = new URL(request.url);
    const keyword = (url.searchParams.get('batchNo') ?? '').trim().toLowerCase();
    const items =
      keyword === ''
        ? mockTraceBatchSearch.items
        : mockTraceBatchSearch.items.filter((item) => item.batchNo.toLowerCase().includes(keyword));
    const validated = TraceBatchSearchResponseSchema.parse({
      ...mockTraceBatchSearch,
      total: items.length,
      items,
    });
    return HttpResponse.json(validated);
  }),

  // 订单检验环节：并列台账，不是血缘链路
  http.get('/api/v1/traceability/orders/:orderNo', () => {
    const validated = TraceOrderChainResponseSchema.parse(mockOrderChain);
    return HttpResponse.json(validated);
  }),

  // 批次血缘图：特采样本单独成图，其余批次共用一份可达子图（根批次替换为查询值）
  http.get('/api/v1/traceability/graph/:batchNo', ({ params }) => {
    const requested = String(params.batchNo || 'LOT-2026-FN-01');
    const graph =
      requested === mockConcessionGraph.batchNo
        ? mockConcessionGraph
        : { ...mockTraceabilityGraph, batchNo: requested };
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

  // MES 外部追溯（生产任务 / 过程检验）：只读参考，离线 Mock 兜底
  http.get('/api/v1/integration/mes/tasks', ({ request }) => {
    const url = new URL(request.url);
    const search = url.searchParams.get('search') || '';
    const all = [
      { id: 1, bill_no: 'SC-2026-0001', heat_number: 'HN-20260518-03', steel_mill: '沙钢', cutting_length: 1000, production_num: 5000, bill_date: '2026-05-18', materiel_code: 'MAT-BLT-109-M10', materiel_name: '全螺纹螺柱', materiel_spec: 'M10x50' },
      { id: 2, bill_no: 'SC-2026-0002', heat_number: 'HN-20260601-07', steel_mill: '宝钢', cutting_length: 800, production_num: 3200, bill_date: '2026-06-01', materiel_code: 'MAT-BLT-109-M12', materiel_name: '全螺纹螺柱', materiel_spec: 'M12x60' },
    ];
    const items = all.filter(
      (t) => search === '' || t.bill_no.includes(search) || t.heat_number.includes(search) || t.materiel_code.includes(search)
    );
    return HttpResponse.json({ page: 1, pageSize: 20, items });
  }),

  http.get('/api/v1/integration/mes/check-reports', ({ request }) => {
    const url = new URL(request.url);
    const search = url.searchParams.get('search') || '';
    const all = [
      { id: 1, bill_no: 'JC-2026-0001', bill_date: '2026-05-18', check_date: '2026-05-18', check_qty: 50, qualified_qty: 50, unqualified_qty: 0, is_qualified: 1, remarks: '', task_bill_no: 'SC-2026-0001', heat_number: 'HN-20260518-03', steel_mill: '沙钢', materiel_code: 'MAT-BLT-109-M10', materiel_name: '全螺纹螺柱', procedure_name: '冷镦', inspector_name: '李工' },
      { id: 2, bill_no: 'JC-2026-0002', bill_date: '2026-06-01', check_date: '2026-06-01', check_qty: 30, qualified_qty: 28, unqualified_qty: 2, is_qualified: 0, remarks: '2件外观瑕疵', task_bill_no: 'SC-2026-0002', heat_number: 'HN-20260601-07', steel_mill: '宝钢', materiel_code: 'MAT-BLT-109-M12', materiel_name: '全螺纹螺柱', procedure_name: '滚丝', inspector_name: '王工' },
    ];
    const items = all.filter(
      (r) => search === '' || r.bill_no.includes(search) || r.heat_number.includes(search) || (r.materiel_name || '').includes(search)
    );
    return HttpResponse.json({ page: 1, pageSize: 20, items });
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

  // 检验项目字典（ERP TestItem 镜像，迁移 037）：与真实后端同口径，
  // ?stage=IQC|IPQC|OQC 按环节标志过滤（bBuy / bProduce / bConsign）
  http.get('/api/v1/master-data/test-items', ({ request }) => {
    const stage = new URL(request.url).searchParams.get('stage');
    const flag =
      stage === 'IQC' ? 'appliesToBuy' : stage === 'IPQC' ? 'appliesToProduce' : stage === 'OQC' ? 'appliesToConsign' : null;
    return HttpResponse.json(
      flag === null ? mockTestItems : mockTestItems.filter((item) => item[flag as keyof typeof item] === true)
    );
  }),

  // 企业档案主数据（company_profile 单行，docs/35 §6）：
  // 未维护时 GET 返回 null（不是空对象、也不是编造默认值），界面据此提示「企业档案未维护」、
  // 证书对应单元格留白；PUT 只更新请求体显式给出的字段（空串 = 清空），
  // updated_by / updated_at 由「服务端」按当前登录身份写入。
  http.get('/api/v1/master-data/company-profile', () => {
    return HttpResponse.json(companyProfileRow);
  }),

  http.put('/api/v1/master-data/company-profile', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = UpsertCompanyProfileRequestSchema.safeParse(body);
    if (!parsed.success) {
      return problemResponse(
        400,
        'ValidationError',
        parsed.error.issues.map((issue) => issue.message).join('; ')
      );
    }
    const next: CompanyProfile = { ...(companyProfileRow ?? {}) };
    for (const [key, value] of Object.entries(parsed.data)) {
      if (typeof value === 'string') next[key as keyof CompanyProfile] = value;
    }
    next.updatedBy = mockCurrentUser.userName;
    next.updatedAt = new Date().toISOString();
    companyProfileRow = next;
    return HttpResponse.json(companyProfileRow);
  }),


  // ==========================================
  // 5.5 INSPECTION PLANS API (质检方案库 / 质检方案设计页)
  // ==========================================
  // 质检方案自动匹配（第一步 · 读）：按「物料编码 + 检验类型」返回待检指标清单。
  // 与后端 apps/api/src/controllers/plans.controller.ts 的 GET /match 同口径：
  // 第一级物料专属方案 → 第二级存货分类通用方案（materialCode 为空 + categoryCode 命中）；
  // 口径唯一真相见 docs/17-检验录入界面说明与质检方案匹配口径.md §7。
  http.get('/api/v1/plans/match', ({ request }) => {
    const url = new URL(request.url);
    const materialCode = (url.searchParams.get('materialCode') ?? '').trim();
    const inspectionType = (url.searchParams.get('inspectionType') ?? '').trim();
    if (materialCode === '' || inspectionType === '') {
      return problemResponse(400, 'ValidationError', 'materialCode 与 inspectionType 均为必填');
    }

    const hasActiveVersion = (plan: InspectionPlan): boolean =>
      (plan.versions ?? []).some((version) => version.status === 'ACTIVE');
    const materialCategory =
      mockMaterials.find((material) => material.materialCode === materialCode)?.categoryCode ?? '';

    // 039：质检类型多选 —— 命中条件为「请求类型 ∈ 方案适用类型全集」，
    // inspectionTypes 缺省（老数据）时按 [inspectionType] 等价回落，与真实后端同口径
    const coversType = (plan: InspectionPlan): boolean =>
      (plan.inspectionTypes ?? [plan.inspectionType]).includes(inspectionType as typeof plan.inspectionType);
    const candidates = plansList.filter((plan) => coversType(plan) && hasActiveVersion(plan));
    const plan =
      candidates.find((candidate) => candidate.materialCode === materialCode) ??
      candidates.find(
        (candidate) =>
          (candidate.materialCode ?? '') === '' &&
          materialCategory !== '' &&
          (candidate.categoryCode ?? '') === materialCategory
      );

    if (!plan) {
      return problemResponse(
        404,
        'inspection-plan-not-found',
        `未找到适用于物料 [${materialCode}]、检验类型 [${inspectionType}] 的已启用质检方案`
      );
    }

    const version = (plan.versions ?? []).find((candidate) => candidate.status === 'ACTIVE');
    if (!version || (version.id ?? '') === '' || version.items.length === 0) {
      return problemResponse(
        400,
        'inspection-plan-not-active',
        `质检方案 [${plan.planCode}] 当前无已启用的有效版本或指标项为空`
      );
    }

    return HttpResponse.json({
      planCode: plan.planCode,
      planName: plan.planName,
      matchSource: plan.materialCode === materialCode ? 'MATERIAL' : 'MATERIAL_CATEGORY',
      planVersionId: version.id,
      versionNo: version.versionNo,
      inspectionType: plan.inspectionType,
      inspectionTypes: plan.inspectionTypes ?? [plan.inspectionType],
      materialCode: plan.materialCode ?? materialCode,
      samplingScheme: version.samplingScheme,
      aqlLevel: version.aqlLevel,
      strictness: version.strictness,
      items: version.items,
      matchedAt: new Date().toISOString(),
    });
  }),

  // 质检方案 KPI 聚合（与后端 GET /plans/stats 同口径：全量方案聚合，不受列表筛选影响）
  http.get('/api/v1/plans/stats', () => {
    const decorated = plansList.map(withPlanDisplayFields);
    return HttpResponse.json({
      total: decorated.length,
      enabled: decorated.filter((plan) => plan.status === 'ENABLED').length,
      pending: decorated.filter((plan) => plan.status === 'PENDING_APPROVAL').length,
      productCount: new Set(
        decorated
          .map((plan) => plan.materialCode)
          .filter((code): code is string => typeof code === 'string' && code !== '')
      ).size,
    });
  }),

  http.get('/api/v1/plans', ({ request }) => {
    const url = new URL(request.url);
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
    const keyword = url.searchParams.get('keyword') ?? '';
    const materialCode = url.searchParams.get('materialCode') ?? '';
    const inspectionType = url.searchParams.get('inspectionType') ?? '';
    const categoryCode = url.searchParams.get('categoryCode') ?? '';
    const activeOnly = url.searchParams.get('isActive') === 'true';

    // 产品分类过滤与真实后端同口径：经物料主数据反查方案物料所属分类
    const categoryByMaterial = new Map(
      mockMaterials.map((item) => [item.materialCode, item.categoryCode])
    );

    const filtered = plansList.filter((plan) => {
      if (
        keyword !== '' &&
        !`${plan.planCode}${plan.planName}`.toLowerCase().includes(keyword.toLowerCase())
      ) {
        return false;
      }
      if (
        materialCode !== '' &&
        !(plan.materialCode ?? '').toLowerCase().includes(materialCode.toLowerCase())
      ) {
        return false;
      }
      if (
        inspectionType !== '' &&
        !(plan.inspectionTypes ?? [plan.inspectionType]).includes(
          inspectionType as typeof plan.inspectionType
        )
      ) {
        return false;
      }
      if (categoryCode !== '' && categoryByMaterial.get(plan.materialCode ?? '') !== categoryCode) {
        return false;
      }
      if (activeOnly && !(plan.versions ?? []).some((version) => version.status === 'ACTIVE')) {
        return false;
      }
      return true;
    });

    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize).map(withPlanDisplayFields);
    return HttpResponse.json({ total: filtered.length, page, pageSize, items, list: items });
  }),

  // 新建方案：与后端一致（已删除「草稿 → 审批」链路）—— 首个版本直接以 ACTIVE 落库，
  // 不再需要的方案由用户在方案列表「停用」
  http.post('/api/v1/plans', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Partial<InspectionPlan>;
    const planId = crypto.randomUUID();
    const firstVersion = body.versions?.[0];
    // 方案编码：与真实后端同口径（TBD-11）—— 未指定时按当日流水取号 QP-{YYYYMMDD}-{NNN}，
    // 原实现回落 `QP-${Date.now()}`（13 位时间戳），既不是文档化的编码形态也不可读
    const planCode = body.planCode ?? allocateMockPlanCode(plansList);
    const now = new Date().toISOString();
    const created: InspectionPlan = {
      id: planId,
      planCode,
      planName: body.planName ?? '未命名质检方案',
      inspectionType: body.inspectionType ?? 'IQC',
      // 039：适用类型全集；缺省回落 [主类型]，与仓储 save 同口径
      inspectionTypes: body.inspectionTypes ?? [body.inspectionType ?? 'IQC'],
      ...(body.materialCode != null && body.materialCode !== ''
        ? { materialCode: body.materialCode }
        : {}),
      versions: [
        {
          id: crypto.randomUUID(),
          planId,
          versionNo: firstVersion?.versionNo ?? 'V1.0',
          // 保存即启用（产品口径：不再有待审批草稿）
          status: 'ACTIVE',
          samplingScheme: firstVersion?.samplingScheme ?? 'GB_T_2828',
          aqlLevel: firstVersion?.aqlLevel ?? 'II',
          strictness: firstVersion?.strictness ?? 'NORMAL',
          // 生效周期与真实后端同口径（数据落版本级 sampling_config，缺失 = 该侧不设边界），
          // 否则离线演示里新建方案永远"即刻生效、长期有效"，方案列表的未生效 / 已过期提示无法复现
          ...(firstVersion?.effectiveStartDate !== undefined
            ? { effectiveStartDate: firstVersion.effectiveStartDate }
            : {}),
          ...(firstVersion?.effectiveEndDate !== undefined
            ? { effectiveEndDate: firstVersion.effectiveEndDate }
            : {}),
          items: firstVersion?.items ?? [],
          createdBy: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    plansList.unshift(created);
    return HttpResponse.json(withPlanDisplayFields(created), { status: 201 });
  }),

  // 方案版本停用：与后端 TogglePlanVersionUseCase + 领域状态机同口径
  //   1. DEACTIVATE 只接受当前为 ACTIVE 的版本，其余状态拒绝；
  //   2. ACTIVATE 保留仅为兼容后端接口语义，前端「审批 / 启用」入口已删除。
  http.post('/api/v1/plans/versions/:versionId/status', async ({ request, params }) => {
    const versionId = String(params.versionId ?? '');
    const body = (await request.json().catch(() => ({}))) as { action?: string };
    const action = body.action;
    if (action !== 'ACTIVATE' && action !== 'DEACTIVATE') {
      return problemResponse(400, 'ValidationError', 'action 必须为 ACTIVATE 或 DEACTIVATE');
    }
    const plan = plansList.find((candidate) =>
      (candidate.versions ?? []).some((version) => version.id === versionId)
    );
    const target = plan?.versions?.find((version) => version.id === versionId);
    if (plan === undefined || target === undefined) {
      return problemResponse(404, 'NotFoundError', `未找到质检方案版本: ${versionId}`);
    }
    if (action === 'ACTIVATE') {
      if ((target.items ?? []).length === 0) {
        return problemResponse(
          400,
          'PlanToggleFailed',
          `版本 [${target.versionNo}] 未配置指标项，严禁激活`
        );
      }
      for (const version of plan.versions ?? []) {
        if (version.id === versionId) {
          version.status = 'ACTIVE';
        } else if (version.status === 'ACTIVE') {
          version.status = 'INACTIVE';
        }
      }
    } else if (target.status !== 'ACTIVE') {
      return problemResponse(
        400,
        'PlanToggleFailed',
        `仅有处于 ACTIVE 状态的版本可执行停用，当前状态为 [${target.status}]`
      );
    } else {
      target.status = 'INACTIVE';
    }
    return HttpResponse.json(withPlanDisplayFields(plan));
  }),

  // 方案 Excel 导入：离线 Mock 无法解析 xlsx 二进制（真实解析在服务端 lib/plan-import.ts），
  // 按"不可用"如实返回 501，不伪造导入成功；与后端 EXPORTER_NOT_CONFIGURED 的诚实降级口径一致。
  http.get('/api/v1/plans/import-template', () => {
    return problemResponse(
      501,
      'NotImplemented',
      '离线演示环境不提供导入模板下载，请连接真实后端（模板由服务端按当前主数据实时生成）'
    );
  }),
  http.post('/api/v1/plans/import', () => {
    return problemResponse(
      501,
      'NotImplemented',
      '离线演示环境不支持方案 Excel 导入（需要服务端解析并落库），请连接真实后端后重试'
    );
  }),

  // ==========================================
  // 6. DASHBOARD OVERVIEW (与真实 dashboard.getOverview 同结构)
  // ==========================================
  http.get('/api/v1/dashboard/overview', () => {
    const stageOf = (type: string): 'iqc' | 'ipqc' | 'oqc' | null => {
      const value = type.toUpperCase();
      if (value === 'IQC') return 'iqc';
      if (value.startsWith('IPQC')) return 'ipqc';
      if (value.startsWith('OQC')) return 'oqc';
      return null;
    };

    const statusCounts: Record<string, number> = {};
    for (const order of inspectionOrdersList) {
      statusCounts[order.status] = (statusCounts[order.status] ?? 0) + 1;
    }

    const totalInspections = inspectionOrdersList.length;
    const passedCount = (statusCounts.PASSED ?? 0) + (statusCounts.COMPLETED ?? 0);
    const passRate = totalInspections > 0 ? Number(((passedCount / totalInspections) * 100).toFixed(2)) : 0;
    const stageDistribution = { iqcCount: 0, ipqcCount: 0, oqcCount: 0 };
    for (const order of inspectionOrdersList) {
      const stage = stageOf(order.inspectionType);
      if (stage === 'iqc') stageDistribution.iqcCount += 1;
      else if (stage === 'ipqc') stageDistribution.ipqcCount += 1;
      else if (stage === 'oqc') stageDistribution.oqcCount += 1;
    }

    const dateKey = (value: string | undefined): string => {
      if (value === undefined || value === '') return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toISOString().slice(0, 10);
    };
    const shiftDate = (value: string, offset: number): string => {
      const date = new Date(`${value}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + offset);
      return date.toISOString().slice(0, 10);
    };
    const orderDates = inspectionOrdersList.map((order) => dateKey(order.createdAt)).filter(Boolean).sort();
    const todayKey = new Date().toISOString().slice(0, 10);
    const endDate = orderDates.length > 0 && orderDates[orderDates.length - 1] < todayKey
      ? orderDates[orderDates.length - 1]
      : todayKey;
    const trendDates = Array.from({ length: 7 }, (_, index) => shiftDate(endDate, index - 6));
    const trendSeries = trendDates.map((date) => {
      const dayOrders = inspectionOrdersList.filter((order) => dateKey(order.createdAt) === date);
      const dayPassed = dayOrders.filter((order) => order.status === 'PASSED' || order.status === 'COMPLETED').length;
      const dayIqc = dayOrders.filter((order) => stageOf(order.inspectionType) === 'iqc').length;
      const dayIpqc = dayOrders.filter((order) => stageOf(order.inspectionType) === 'ipqc').length;
      const dayOqc = dayOrders.filter((order) => stageOf(order.inspectionType) === 'oqc').length;
      return {
        date,
        iqcCount: dayIqc,
        ipqcCount: dayIpqc,
        oqcCount: dayOqc,
        passRate: dayOrders.length > 0 ? Number(((dayPassed / dayOrders.length) * 100).toFixed(2)) : 0,
      };
    });

    const defectCounts = new Map<string, { category: string; count: number }>();
    for (const order of inspectionOrdersList) {
      for (const item of order.items ?? []) {
        if (item.result !== 'FAILED') continue;
        const defectName = item.name || item.itemCode || '未命名缺陷';
        const current = defectCounts.get(defectName) ?? { category: item.metricCategory ?? 'DIMENSION', count: 0 };
        defectCounts.set(defectName, { ...current, count: current.count + 1 });
      }
    }
    const topDefects = Array.from(defectCounts.entries())
      .map(([defectName, value]) => ({ defectName, category: value.category, count: value.count }))
      .sort((a, b) => b.count - a.count || a.defectName.localeCompare(b.defectName))
      .slice(0, 8);

    const recentActivities = [...inspectionOrdersList]
      .sort((a, b) => new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() - new Date(a.updatedAt ?? a.createdAt ?? 0).getTime())
      .slice(0, 8)
      .map((order) => ({
        id: order.id,
        type: 'INSPECTION',
        title: `${order.orderNo} · ${order.materialName}`,
        status: order.status,
        timestamp: order.updatedAt ?? order.createdAt ?? new Date(0).toISOString(),
      }));

    return HttpResponse.json({
      totalInspections,
      passRate,
      pendingCount: statusCounts.PENDING ?? 0,
      inspectingCount: statusCounts.INSPECTING ?? 0,
      failedCount: statusCounts.FAILED ?? 0,
      inMRBCount: mrbList.filter((record) => record.status === 'PENDING_REVIEW' || record.status === 'UNDER_REVIEW').length,
      stageDistribution,
      trendSeries,
      topDefects,
      recentActivities,
    });
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
