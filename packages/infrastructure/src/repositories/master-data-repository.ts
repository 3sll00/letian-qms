import { Kysely } from 'kysely';
import type { ErpPort } from '@letian/domain';
import type {
  Customer,
  CompanyProfile,
  Employee,
  InventoryCategory,
  Material,
  Supplier,
  Workshop,
} from '@letian/contracts';
import type {
  CustomerRow,
  CompanyProfileRow,
  Database,
  EmployeeRow,
  InventoryCategoryRow,
  MaterialRow,
  SupplierRow,
  WorkshopRow,
} from '../database/schema.js';

/**
 * 本地 ERP 主数据镜像仓储 (Kysely + PostgreSQL)，实现 ErpPort。
 *
 * 只读：主数据由 ERP/MES 同步链路写入，本仓储不提供任何 upsert。
 * 可空列在 DTO 中一律用条件展开省略，绝不写入 undefined
 * （契约 Material.specModel / Supplier.contactPerson 等均为可选）。
 */
export class KyselyMasterDataRepository implements ErpPort {
  constructor(private readonly db: Kysely<Database>) {}

  public async getMaterials(query?: { categoryCode?: string; materialCode?: string }): Promise<readonly Material[]> {
    let q = this.db.selectFrom('materials').selectAll();

    if (query?.categoryCode !== undefined) {
      q = q.where('categoryCode', '=', query.categoryCode);
    }
    if (query?.materialCode !== undefined) {
      q = q.where('materialCode', '=', query.materialCode);
    }

    const rows = await q.orderBy('materialCode', 'asc').execute();
    return rows.map((row) => this.mapMaterial(row));
  }

  public async getMaterialByName(name: string): Promise<Material | null> {
    const row = await this.db
      .selectFrom("materials")
      .selectAll()
      .where("materialName", "=", name)
      .executeTakeFirst();
    return row ? this.mapMaterial(row) : null;
  }

  public async findMaterialByCode(code: string): Promise<Material | null> {
    return this.getMaterialByCode(code);
  }

  public async getMaterialByCode(materialCode: string): Promise<Material | null> {
    const row = await this.db
      .selectFrom('materials')
      .selectAll()
      .where('materialCode', '=', materialCode)
      .executeTakeFirst();

    return row ? this.mapMaterial(row) : null;
  }

  public async getSuppliers(query?: { supplierCode?: string; supplierName?: string }): Promise<readonly Supplier[]> {
    let q = this.db.selectFrom('suppliers').selectAll();

    if (query?.supplierCode !== undefined) {
      q = q.where('supplierCode', '=', query.supplierCode);
    }
    if (query?.supplierName !== undefined) {
      // 供应商名称按模糊匹配，大小写不敏感
      q = q.where('supplierName', 'ilike', `%${query.supplierName}%`);
    }

    const rows = await q.orderBy('supplierCode', 'asc').execute();
    return rows.map((row) => this.mapSupplier(row));
  }

  public async getSupplierByCode(supplierCode: string): Promise<Supplier | null> {
    const row = await this.db
      .selectFrom('suppliers')
      .selectAll()
      .where('supplierCode', '=', supplierCode)
      .executeTakeFirst();

    return row ? this.mapSupplier(row) : null;
  }

  public async getCustomers(query?: { customerCode?: string }): Promise<readonly Customer[]> {
    let q = this.db.selectFrom('customers').selectAll();

    if (query?.customerCode !== undefined) {
      q = q.where('customerCode', '=', query.customerCode);
    }

    const rows = await q.orderBy('customerCode', 'asc').execute();
    return rows.map((row) => this.mapCustomer(row));
  }

  public async getWorkshops(query?: { workshopCode?: string }): Promise<readonly Workshop[]> {
    let q = this.db.selectFrom('workshops').selectAll();

    if (query?.workshopCode !== undefined) {
      q = q.where('workshopCode', '=', query.workshopCode);
    }

    const rows = await q.orderBy('workshopCode', 'asc').execute();
    return rows.map((row) => this.mapWorkshop(row));
  }

  public async getEmployees(query?: { department?: string }): Promise<readonly Employee[]> {
    let q = this.db.selectFrom('employees').selectAll();

    if (query?.department !== undefined) {
      q = q.where('department', '=', query.department);
    }

    const rows = await q.orderBy('employeeCode', 'asc').execute();
    return rows.map((row) => this.mapEmployee(row));
  }

  /** 额外方法（非 ErpPort 契约）：存货分类档案，供物料分类下拉使用 */
  public async getInventoryCategories(query?: { categoryCode?: string }): Promise<InventoryCategory[]> {
    let q = this.db.selectFrom('inventoryCategories').selectAll();

    if (query?.categoryCode !== undefined) {
      q = q.where('categoryCode', '=', query.categoryCode);
    }

    const rows = await q.orderBy('categoryCode', 'asc').execute();
    return rows.map((row) => this.mapInventoryCategory(row));
  }

  private mapMaterial(row: MaterialRow): Material {
    return {
      id: row.id,
      materialCode: row.materialCode,
      materialName: row.materialName,
      categoryCode: row.categoryCode,
      unit: row.unit,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(row.specModel !== null ? { specModel: row.specModel } : {}),
    };
  }

  private mapSupplier(row: SupplierRow): Supplier {
    return {
      id: row.id,
      supplierCode: row.supplierCode,
      supplierName: row.supplierName,
      createdAt: row.createdAt.toISOString(),
      ...(row.contactPerson !== null ? { contactPerson: row.contactPerson } : {}),
      ...(row.phone !== null ? { phone: row.phone } : {}),
    };
  }

  private mapCustomer(row: CustomerRow): Customer {
    return {
      id: row.id,
      customerCode: row.customerCode,
      customerName: row.customerName,
      createdAt: row.createdAt.toISOString(),
      ...(row.contactPerson !== null ? { contactPerson: row.contactPerson } : {}),
      ...(row.phone !== null ? { phone: row.phone } : {}),
    };
  }

  private mapWorkshop(row: WorkshopRow): Workshop {
    return {
      id: row.id,
      workshopCode: row.workshopCode,
      workshopName: row.workshopName,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private mapEmployee(row: EmployeeRow): Employee {
    return {
      id: row.id,
      employeeCode: row.employeeCode,
      name: row.name,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      // 主角色（employees.role_code，迁移 003 新增列）关联角色字典 roles.role_code。
      // 必须显式映射：物料权限管理页的用户下拉、登录签发的 JWT role、权限校验日志的
      // role_code 全部依赖它，遗漏会静默退化为 'GUEST'（详见 docs/18 §3.2 D2）。
      ...(row.roleCode !== null ? { roleCode: row.roleCode } : {}),
      ...(row.department !== null ? { department: row.department } : {}),
      ...(row.phone !== null ? { phone: row.phone } : {}),
      ...(row.email !== null ? { email: row.email } : {}),
    };
  }

  private mapInventoryCategory(row: InventoryCategoryRow): InventoryCategory {
    return {
      id: row.id,
      categoryCode: row.categoryCode,
      categoryName: row.categoryName,
      level: row.level,
      createdAt: row.createdAt.toISOString(),
      ...(row.parentCode !== null ? { parentCode: row.parentCode } : {}),
    };
  }

  // --------------------------------------------------------------------------
  // 企业档案（迁移 029，docs/35 §6）：证书抬头「签发主体 / 供货单位 / 产地」的唯一真实来源。
  // 与其它主数据不同，本表是**单行表**且允许人工维护（ERP 侧没有对应档案）。
  // --------------------------------------------------------------------------

  /** 读取企业档案；表内无行即返回 null（调用方按「未维护」处理，绝不用硬编码常量顶替） */
  public async getCompanyProfile(): Promise<CompanyProfile | null> {
    const row = await this.db.selectFrom('companyProfile').selectAll().executeTakeFirst();
    return row === undefined ? null : this.mapCompanyProfile(row);
  }

  /**
   * 写入企业档案（单行 upsert）。
   *
   * 语义：**显式传入的字段才更新**，传空串表示清空该字段，未传入的字段保持原值；
   * `updatedBy` = 当前登录用户（服务端注入）。单行表由 `profile_id BOOLEAN PRIMARY KEY` 保证，
   * 冲突分支固定按 `profile_id` 更新，结构上不可能写出第二行。
   */
  public async saveCompanyProfile(
    data: {
      legalName?: string;
      legalNameEn?: string;
      shortName?: string;
      address?: string;
      originPlace?: string;
      phone?: string;
      email?: string;
      qualityStamp?: string;
    },
    updatedBy?: string
  ): Promise<CompanyProfile> {
    const patch = {
      ...(data.legalName !== undefined ? { legalName: data.legalName } : {}),
      ...(data.legalNameEn !== undefined ? { legalNameEn: data.legalNameEn } : {}),
      ...(data.shortName !== undefined ? { shortName: data.shortName } : {}),
      ...(data.address !== undefined ? { address: data.address } : {}),
      ...(data.originPlace !== undefined ? { originPlace: data.originPlace } : {}),
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
      ...(data.email !== undefined ? { email: data.email } : {}),
      ...(data.qualityStamp !== undefined ? { qualityStamp: data.qualityStamp } : {}),
      ...(updatedBy !== undefined ? { updatedBy } : {}),
      updatedAt: new Date(),
    };

    const row = await this.db
      .insertInto('companyProfile')
      .values({ profileId: true, ...patch })
      .onConflict((oc) => oc.column('profileId').doUpdateSet(patch))
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapCompanyProfile(row);
  }

  private mapCompanyProfile(row: CompanyProfileRow): CompanyProfile {
    return {
      ...(row.legalName !== null ? { legalName: row.legalName } : {}),
      ...(row.legalNameEn !== null ? { legalNameEn: row.legalNameEn } : {}),
      ...(row.shortName !== null ? { shortName: row.shortName } : {}),
      ...(row.address !== null ? { address: row.address } : {}),
      ...(row.originPlace !== null ? { originPlace: row.originPlace } : {}),
      ...(row.phone !== null ? { phone: row.phone } : {}),
      ...(row.email !== null ? { email: row.email } : {}),
      ...(row.qualityStamp !== null ? { qualityStamp: row.qualityStamp } : {}),
      ...(row.updatedBy !== null ? { updatedBy: row.updatedBy } : {}),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  public async saveSupplier(data: { supplierCode: string; supplierName: string; contactPerson?: string; phone?: string }): Promise<Supplier> {
    const row = await this.db.insertInto('suppliers').values({
      id: crypto.randomUUID(),
      supplierCode: data.supplierCode,
      supplierName: data.supplierName,
      contactPerson: data.contactPerson ?? null,
      phone: data.phone ?? null,
      createdAt: new Date(),
    }).returningAll().executeTakeFirstOrThrow();
    return this.mapSupplier(row);
  }

  public async saveCustomer(data: { customerCode: string; customerName: string; contactPerson?: string; phone?: string }): Promise<Customer> {
    const row = await this.db.insertInto('customers').values({
      id: crypto.randomUUID(),
      customerCode: data.customerCode,
      customerName: data.customerName,
      contactPerson: data.contactPerson ?? null,
      phone: data.phone ?? null,
      createdAt: new Date(),
    }).returningAll().executeTakeFirstOrThrow();
    return this.mapCustomer(row);
  }

  public async saveMaterial(data: { materialCode: string; materialName: string; specModel?: string; categoryCode: string; unit?: string }): Promise<Material> {
    const row = await this.db.insertInto('materials').values({
      id: crypto.randomUUID(),
      materialCode: data.materialCode,
      materialName: data.materialName,
      specModel: data.specModel ?? null,
      categoryCode: data.categoryCode,
      unit: data.unit ?? '个',
      createdAt: new Date(),
    }).returningAll().executeTakeFirstOrThrow();
    return this.mapMaterial(row);
  }

  public async saveWorkshop(data: { workshopCode: string; workshopName: string }): Promise<Workshop> {
    const row = await this.db.insertInto('workshops').values({
      id: crypto.randomUUID(),
      workshopCode: data.workshopCode,
      workshopName: data.workshopName,
      createdAt: new Date(),
    }).returningAll().executeTakeFirstOrThrow();
    return this.mapWorkshop(row);
  }

  public async saveEmployee(data: { employeeCode: string; name: string; department?: string; phone?: string; email?: string; roleCode?: string }): Promise<Employee> {
    const row = await this.db.insertInto('employees').values({
      id: crypto.randomUUID(),
      employeeCode: data.employeeCode,
      name: data.name,
      roleCode: data.roleCode ?? null,
      department: data.department ?? null,
      phone: data.phone ?? null,
      email: data.email ?? null,
      isActive: true,
      createdAt: new Date(),
    }).returningAll().executeTakeFirstOrThrow();
    return this.mapEmployee(row);
  }

  public async saveInventoryCategory(data: { categoryCode: string; categoryName: string; level?: number; parentCode?: string }): Promise<InventoryCategory> {
    const row = await this.db.insertInto('inventoryCategories').values({
      id: crypto.randomUUID(),
      categoryCode: data.categoryCode,
      categoryName: data.categoryName,
      level: data.level ?? 1,
      parentCode: data.parentCode ?? null,
      createdAt: new Date(),
    }).returningAll().executeTakeFirstOrThrow();
    return this.mapInventoryCategory(row as any);
  }

}
