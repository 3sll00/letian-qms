/**
 * Mock 数据契约校验脚本。
 *
 * 对 src/mocks/data.ts 中所有会作为 Mock HTTP 响应体的数据集，
 * 用 @letian/contracts 的 Zod schema 重新 parse 一遍，
 * 任何数据集与契约不一致时以非零退出码失败，供 CI (pnpm test) 拦截回归。
 *
 * 纯页面本地数据（如 dashboard 统计，无对应 schema）不在此校验。
 */
import { z } from 'zod';
import {
  InspectionOrderSchema,
  MRBReviewSchema,
  PendingDefectItemSchema,
  ReviewFlowSchema,
  TraceabilityGraphResponseSchema,
  TraceBatchSearchResponseSchema,
  TraceOrderChainResponseSchema,
  IntegrationConfigSchema,
  IntegrationSyncLogSchema,
  CompanyProfileSchema,
  MaterialSchema,
  SupplierSchema,
  CustomerSchema,
  WorkshopSchema,
  EmployeeSchema,
  InventoryCategorySchema,
  InspectionPlanSchema,
  PlanStatsSchema,
} from '@letian/contracts';
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
  mockCategories,
  mockEquipmentMappings,
  mockInterceptionRules,
  mockPlans,
  withPlanDisplayFields,
} from './data';

let passed = 0;
const failures: string[] = [];

function parseEach<T>(label: string, schema: z.ZodType<T>, items: unknown[]): void {
  items.forEach((item, index) => {
    try {
      schema.parse(item);
    } catch (error) {
      throw new Error(
        `${label}[${index}] 未通过契约校验: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });
}

function check(label: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.info(`  ✓ ${label}`);
  } catch (error) {
    failures.push(label);
    console.error(`  ✗ ${label}`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

console.info('校验 mock 数据集与 @letian/contracts 契约的一致性...');

check('检验工单 mockInspectionOrders (InspectionOrderSchema)', () =>
  parseEach('mockInspectionOrders', InspectionOrderSchema, mockInspectionOrders)
);

check('MRB 评审 mockMrbRecords (MRBReviewSchema)', () =>
  parseEach('mockMrbRecords', MRBReviewSchema, mockMrbRecords)
);

check('不合格待审核池 mockPendingDefects (PendingDefectItemSchema)', () =>
  parseEach('mockPendingDefects', PendingDefectItemSchema, mockPendingDefects)
);

check('MRB 评审流程定义 mockReviewFlows (ReviewFlowSchema)', () =>
  parseEach('mockReviewFlows', ReviewFlowSchema, mockReviewFlows)
);

check('批次追溯图谱 mockTraceabilityGraph (TraceabilityGraphResponseSchema)', () =>
  TraceabilityGraphResponseSchema.parse(mockTraceabilityGraph)
);

/*
 * 特采样本单独校验：它是「特采节点必须能举证 MRB 单号 + 客户书面授权件」这条口径的活样本
 * （docs/24 §4 R4），字段被改空时这里必须失败，而不是等到现场演示才发现举不出证。
 */
check('特采样本图谱 mockConcessionGraph (TraceabilityGraphResponseSchema)', () => {
  const parsed = TraceabilityGraphResponseSchema.parse(mockConcessionGraph);
  const node = parsed.nodes.find((item) => item.nodeStatus === 'CONCESSION');
  if (node === undefined) throw new Error('特采样本图谱缺少 CONCESSION 节点');
  if (node.mrbNo === undefined || node.mrbNo === '') throw new Error('特采节点缺少 MRB 单号');
  if (node.concessionAttachmentUrl === undefined || node.concessionAttachmentUrl === '') {
    throw new Error('特采节点缺少客户书面授权件地址');
  }
});

check('批次检索 mockTraceBatchSearch (TraceBatchSearchResponseSchema)', () =>
  TraceBatchSearchResponseSchema.parse(mockTraceBatchSearch)
);

check('订单检验环节 mockOrderChain (TraceOrderChainResponseSchema)', () => {
  const parsed = TraceOrderChainResponseSchema.parse(mockOrderChain);
  const seqs = parsed.stages.map((stage) => stage.seq);
  const sorted = [...seqs].sort((left, right) => left - right);
  if (seqs.join(',') !== sorted.join(',')) {
    throw new Error(`检验环节必须按工艺序位升序返回，实际为 ${seqs.join(',')}`);
  }
});

check('集成配置 mockIntegrationConfigs (IntegrationConfigSchema)', () =>
  parseEach('mockIntegrationConfigs', IntegrationConfigSchema, mockIntegrationConfigs)
);

check('集成同步日志 mockIntegrationLogs (IntegrationSyncLogSchema)', () =>
  parseEach('mockIntegrationLogs', IntegrationSyncLogSchema, mockIntegrationLogs)
);

check('供应商档案 mockSuppliers (SupplierSchema)', () =>
  parseEach('mockSuppliers', SupplierSchema, mockSuppliers)
);

check('客户档案 mockCustomers (CustomerSchema)', () =>
  parseEach('mockCustomers', CustomerSchema, mockCustomers)
);

check('生产车间档案 mockWorkshops (WorkshopSchema)', () =>
  parseEach('mockWorkshops', WorkshopSchema, mockWorkshops)
);

check('职员档案 mockEmployees (EmployeeSchema)', () =>
  parseEach('mockEmployees', EmployeeSchema, mockEmployees)
);

check('存货料品档案 mockMaterials (MaterialSchema)', () =>
  parseEach('mockMaterials', MaterialSchema, mockMaterials)
);

check('物料分类档案 mockCategories (InventoryCategorySchema)', () =>
  parseEach('mockCategories', InventoryCategorySchema, mockCategories)
);

/*
 * 企业档案是证书抬头 / 印章文字的唯一来源：被改空或被写成非法邮箱时必须在这里失败，
 * 而不是等到打印证书才发现抬头是编造的常量（docs/35 §6）。
 */
check('企业档案 mockCompanyProfile (CompanyProfileSchema)', () => {
  const parsed = CompanyProfileSchema.parse(mockCompanyProfile);
  if (parsed.legalName === undefined || parsed.legalName === '') {
    throw new Error('企业档案缺少法定名称：证书抬头将整片留白');
  }
});

/*
 * 质检方案：页面「适用产品 / 状态 / 创建人」取的是派生后的展示字段，
 * 因此这里校验 withPlanDisplayFields 的输出（与真实后端读时 JOIN 同口径），
 * 而不是只校验未派生的 mockPlans，避免派生逻辑回归时校验仍"全绿"。
 */
check('质检方案 mockPlans + 展示字段派生 (InspectionPlanSchema)', () =>
  parseEach(
    'mockPlans(带展示字段)',
    InspectionPlanSchema,
    mockPlans.map((plan) => withPlanDisplayFields(plan))
  )
);

check('质检方案 KPI 聚合结果 (PlanStatsSchema)', () => {
  const decorated = mockPlans.map((plan) => withPlanDisplayFields(plan));
  PlanStatsSchema.parse({
    total: decorated.length,
    enabled: decorated.filter((plan) => plan.status === 'ENABLED').length,
    pending: decorated.filter((plan) => plan.status === 'PENDING_APPROVAL').length,
    productCount: new Set(
      decorated
        .map((plan) => plan.materialCode)
        .filter((code): code is string => typeof code === 'string' && code !== '')
    ).size,
  });
});

if (failures.length > 0) {
  console.error(`\nMock 数据契约校验失败: ${failures.length} 组数据集未通过。`);
  throw new Error('mock validation failed');
}

console.info(
  `\n全部 ${passed} 组契约校验通过 (另有 ${mockEquipmentMappings.length} 条机台档案、${mockInterceptionRules.length} 条拦截规则为页面本地模型，无对应 schema，跳过强校验)。`
);
