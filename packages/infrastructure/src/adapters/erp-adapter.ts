import { Kysely } from 'kysely';
import type { ErpPort } from '@letian/domain';
import type { Customer, Employee, Material, Supplier, Workshop } from '@letian/contracts';
import type { Database } from '../database/schema.js';
import { KyselyMasterDataRepository } from '../repositories/master-data-repository.js';

/**
 * ERP 主数据适配器：对本项目而言 ERP 数据已同步落库为本地镜像表，
 * 因此该适配器不再直连外部 ERP，而是把 ErpPort 全部委托给 KyselyMasterDataRepository。
 * 仅保留此类是为了沿用既有的适配器入口（adapters/index.ts）。
 */
export class ErpAdapter implements ErpPort {
  private readonly masterData: KyselyMasterDataRepository;

  constructor(db: Kysely<Database>) {
    this.masterData = new KyselyMasterDataRepository(db);
  }

  public async getMaterials(query?: {
    categoryCode?: string;
    materialCode?: string;
  }): Promise<readonly Material[]> {
    return this.masterData.getMaterials(query);
  }

  public async getMaterialByCode(materialCode: string): Promise<Material | null> {
    return this.masterData.getMaterialByCode(materialCode);
  }

  public async getSuppliers(query?: {
    supplierCode?: string;
    supplierName?: string;
  }): Promise<readonly Supplier[]> {
    return this.masterData.getSuppliers(query);
  }

  public async getSupplierByCode(supplierCode: string): Promise<Supplier | null> {
    return this.masterData.getSupplierByCode(supplierCode);
  }

  public async getCustomers(query?: { customerCode?: string }): Promise<readonly Customer[]> {
    return this.masterData.getCustomers(query);
  }

  public async getWorkshops(query?: { workshopCode?: string }): Promise<readonly Workshop[]> {
    return this.masterData.getWorkshops(query);
  }

  public async getEmployees(query?: { department?: string }): Promise<readonly Employee[]> {
    return this.masterData.getEmployees(query);
  }
}
