import { SupplierSchema, CustomerSchema, MaterialSchema, WorkshopSchema, EmployeeSchema, InventoryCategorySchema } from "@letian/contracts";
import { UpsertCompanyProfileRequestSchema } from "@letian/contracts";
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ApiContainer } from '../container';
import { operatorOf } from '../lib/operator';

/**
 * ERP 主数据查询控制器
 *
 * 契约里只有 Material / Supplier / Customer / Workshop / Employee / InventoryCategory
 * 六类档案的实体 Schema，没有对应的分页响应包装 Schema，
 * 因此这里按前端既有消费方式返回**裸数组**（与旧内存接口一致），不做 total/items 包装。
 *
 * inventory 与 categories 属于读侧投影：
 * - inventory 额外附带 categoryName（取自 inventory_categories）与 planCode（取自 inspection_plans 的 ACTIVE 版本）
 * - categories 依据 parent_code 组装成树，count 为该分类下直接挂载的物料款数
 */
const ListQuerySchema = z.object({
  keyword: z.string().optional(),
});

export interface MaterialView {
  id?: string;
  materialCode: string;
  materialName: string;
  specModel?: string;
  categoryCode: string;
  categoryName: string;
  unit: string;
  planCode: string | null;
}

export interface CategoryTreeNodeView {
  id: string;
  code: string;
  name: string;
  count: number;
  children: CategoryTreeNodeView[];
}

function matches(keyword: string | undefined, ...values: Array<string | undefined>): boolean {
  if (keyword === undefined || keyword === '') {
    return true;
  }
  const needle = keyword.toLowerCase();
  return values.some((value) => (value ?? '').toLowerCase().includes(needle));
}

export const masterDataController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const masterData = options.container.repositories.masterData;
  const plans = options.container.repositories.plans;

  // 1. 供应商档案
  fastify.get(
    '/suppliers',
    { schema: { querystring: ListQuerySchema } },
    async (request, reply) => {
      const { keyword } = request.query as z.infer<typeof ListQuerySchema>;
      const suppliers = await masterData.getSuppliers();
      return reply
        .status(200)
        .send(suppliers.filter((item) => matches(keyword, item.supplierCode, item.supplierName)));
    }
  );

  // 2. 客户档案
  fastify.get(
    '/customers',
    { schema: { querystring: ListQuerySchema } },
    async (request, reply) => {
      const { keyword } = request.query as z.infer<typeof ListQuerySchema>;
      const customers = await masterData.getCustomers();
      return reply
        .status(200)
        .send(customers.filter((item) => matches(keyword, item.customerCode, item.customerName)));
    }
  );

  // 3. 存货料品档案（附带分类名称与生效质检方案编码）
  fastify.get(
    '/inventory',
    { schema: { querystring: ListQuerySchema } },
    async (request, reply) => {
      const { keyword } = request.query as z.infer<typeof ListQuerySchema>;

      const [materials, categories, activePlans] = await Promise.all([
        masterData.getMaterials(),
        masterData.getInventoryCategories(),
        plans.listPlans({ activeOnly: true, page: 1, pageSize: 100 }),
      ]);

      const categoryNameByCode = new Map(
        categories.map((category) => [category.categoryCode, category.categoryName])
      );
      const planCodeByMaterial = new Map(
        activePlans.list.map((plan) => [plan.materialCode, plan.planCode])
      );

      const list: MaterialView[] = materials
        .filter((item) => matches(keyword, item.materialCode, item.materialName))
        .map((item) => ({
          ...(item.id !== undefined ? { id: item.id } : {}),
          materialCode: item.materialCode,
          materialName: item.materialName,
          ...(item.specModel !== undefined ? { specModel: item.specModel } : {}),
          categoryCode: item.categoryCode,
          categoryName: categoryNameByCode.get(item.categoryCode) ?? item.categoryCode,
          unit: item.unit,
          planCode: planCodeByMaterial.get(item.materialCode) ?? null,
        }));

      return reply.status(200).send(list);
    }
  );

  // 4. 生产车间档案
  fastify.get(
    '/workshops',
    { schema: { querystring: ListQuerySchema } },
    async (request, reply) => {
      const { keyword } = request.query as z.infer<typeof ListQuerySchema>;
      const workshops = await masterData.getWorkshops();
      return reply
        .status(200)
        .send(workshops.filter((item) => matches(keyword, item.workshopCode, item.workshopName)));
    }
  );

  // 5. 职员与检验员档案
  fastify.get(
    '/employees',
    { schema: { querystring: ListQuerySchema } },
    async (request, reply) => {
      const { keyword } = request.query as z.infer<typeof ListQuerySchema>;
      const employees = await masterData.getEmployees();
      return reply
        .status(200)
        .send(employees.filter((item) => matches(keyword, item.employeeCode, item.name)));
    }
  );

  // 6. 存货分类树（依据 parent_code 组装，count = 该分类下直接挂载的物料款数）
  fastify.get('/categories', async (_request, reply) => {
    const [categories, materials] = await Promise.all([
      masterData.getInventoryCategories(),
      masterData.getMaterials(),
    ]);

    const materialCountByCode = new Map<string, number>();
    for (const material of materials) {
      materialCountByCode.set(
        material.categoryCode,
        (materialCountByCode.get(material.categoryCode) ?? 0) + 1
      );
    }

    const nodeById = new Map<string, CategoryTreeNodeView>();
    for (const category of categories) {
      nodeById.set(category.categoryCode, {
        id: category.id ?? category.categoryCode,
        code: category.categoryCode,
        name: category.categoryName,
        count: materialCountByCode.get(category.categoryCode) ?? 0,
        children: [],
      });
    }

    const roots: CategoryTreeNodeView[] = [];
    for (const category of categories) {
      const node = nodeById.get(category.categoryCode);
      if (!node) {
        continue;
      }
      const parent = category.parentCode !== undefined ? nodeById.get(category.parentCode) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return reply.status(200).send(roots);
  });
  // 1.1 创建供应商
  fastify.post('/suppliers', { schema: { body: SupplierSchema } }, async (request, reply) => {
    const data = request.body as any;
    const created = await masterData.saveSupplier({
      supplierCode: data.supplierCode,
      supplierName: data.supplierName,
      contactPerson: data.contactPerson,
      phone: data.phone,
    });
    return reply.status(201).send(created);
  });

  // 2.1 创建客户
  fastify.post('/customers', { schema: { body: CustomerSchema } }, async (request, reply) => {
    const data = request.body as any;
    const created = await masterData.saveCustomer({
      customerCode: data.customerCode,
      customerName: data.customerName,
      contactPerson: data.contactPerson,
      phone: data.phone,
    });
    return reply.status(201).send(created);
  });

  // 3.1 创建物料存货档案
  fastify.post('/inventory', { schema: { body: MaterialSchema } }, async (request, reply) => {
    const data = request.body as any;
    const created = await masterData.saveMaterial({
      materialCode: data.materialCode,
      materialName: data.materialName,
      specModel: data.specModel,
      categoryCode: data.categoryCode,
      unit: data.unit || "个",
    });
    return reply.status(201).send(created);
  });

  // 4.1 创建生产车间
  fastify.post('/workshops', { schema: { body: WorkshopSchema } }, async (request, reply) => {
    const data = request.body as any;
    const created = await masterData.saveWorkshop({
      workshopCode: data.workshopCode,
      workshopName: data.workshopName,
    });
    return reply.status(201).send(created);
  });

  // 5.1 创建职员/检验员
  fastify.post('/employees', { schema: { body: EmployeeSchema } }, async (request, reply) => {
    const data = request.body as any;
    const created = await masterData.saveEmployee({
      employeeCode: data.employeeCode,
      name: data.name,
      department: data.department,
      phone: data.phone,
      email: data.email,
      roleCode: data.roleCode,
    });
    return reply.status(201).send(created);
  });

  // 6.1 创建存货分类
  fastify.post('/categories', { schema: { body: InventoryCategorySchema } }, async (request, reply) => {
    const data = request.body as any;
    const created = await masterData.saveInventoryCategory({
      categoryCode: data.categoryCode,
      categoryName: data.categoryName,
      parentCode: data.parentCode,
      level: data.level ?? 1,
    });
    return reply.status(201).send(created);
  });

  // --------------------------------------------------------------------------
  // 企业档案（迁移 029，docs/35 §6）：证书抬头「签发主体 / 供货单位 / 产地」的主数据。
  // 与其它主数据不同：ERP 侧没有对应档案，只能在本系统人工维护，且**只有一行**。
  // --------------------------------------------------------------------------

  fastify.get('/company-profile', async (_request, reply) => {
    const profile = await masterData.getCompanyProfile();
    // 未维护时返回 null（不是空对象、更不是编造默认值）：调用方据此在界面提示「企业档案未维护」，
    // 证书对应单元格留白（docs/35 §6）
    return reply.status(200).send(profile);
  });

  fastify.put(
    '/company-profile',
    { schema: { body: UpsertCompanyProfileRequestSchema } },
    async (request, reply) => {
      const body = request.body as z.infer<typeof UpsertCompanyProfileRequestSchema>;
      // 维护人 = 当前登录用户（服务端注入，不接受请求体自称）
      const operator = operatorOf(request);
      const saved = await masterData.saveCompanyProfile(
        {
          ...(body.legalName !== undefined ? { legalName: body.legalName } : {}),
          ...(body.legalNameEn !== undefined ? { legalNameEn: body.legalNameEn } : {}),
          ...(body.shortName !== undefined ? { shortName: body.shortName } : {}),
          ...(body.address !== undefined ? { address: body.address } : {}),
          ...(body.originPlace !== undefined ? { originPlace: body.originPlace } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.email !== undefined ? { email: body.email } : {}),
          ...(body.qualityStamp !== undefined ? { qualityStamp: body.qualityStamp } : {}),
        },
        operator.userName
      );
      return reply.status(200).send(saved);
    }
  );
};