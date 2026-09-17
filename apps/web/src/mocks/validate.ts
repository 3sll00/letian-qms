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
  TraceabilityGraphResponseSchema,
  IntegrationConfigSchema,
  IntegrationSyncLogSchema,
  MaterialSchema,
  SupplierSchema,
  CustomerSchema,
  WorkshopSchema,
  EmployeeSchema,
  InventoryCategorySchema,
} from '@letian/contracts';
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
  mockCategories,
  mockEquipmentMappings,
  mockInterceptionRules,
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

check('批次追溯图谱 mockTraceabilityGraph (TraceabilityGraphResponseSchema)', () =>
  TraceabilityGraphResponseSchema.parse(mockTraceabilityGraph)
);

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

if (failures.length > 0) {
  console.error(`\nMock 数据契约校验失败: ${failures.length} 组数据集未通过。`);
  throw new Error('mock validation failed');
}

console.info(
  `\n全部 ${passed} 组契约校验通过 (另有 ${mockEquipmentMappings.length} 条机台档案、${mockInterceptionRules.length} 条拦截规则为页面本地模型，无对应 schema，跳过强校验)。`
);
