import {
  Material,
  Supplier,
  Customer,
  Workshop,
  Employee,
} from '@letian/contracts';

/**
 * ERP 主数据集成输出端口 (ErpPort)
 * 供领域层/应用层调用，由基础设施层适配器实现（如 REST/SOAP/RFC 调用）
 * 覆盖基础档案：物料、供应商、客户、车间、人员
 */
export interface ErpPort {
  /** 获取物料主档案列表或按物料编码查询 */
  getMaterials(query?: { categoryCode?: string; materialCode?: string }): Promise<readonly Material[]>;
  getMaterialByCode(materialCode: string): Promise<Material | null>;

  /** 获取供应商主档案列表或按供应商编码查询 */
  getSuppliers(query?: { supplierCode?: string; supplierName?: string }): Promise<readonly Supplier[]>;
  getSupplierByCode(supplierCode: string): Promise<Supplier | null>;

  /** 获取客户档案列表 */
  getCustomers(query?: { customerCode?: string }): Promise<readonly Customer[]>;

  /** 获取车间档案列表 */
  getWorkshops(query?: { workshopCode?: string }): Promise<readonly Workshop[]>;

  /** 获取人员档案列表 */
  getEmployees(query?: { department?: string }): Promise<readonly Employee[]>;
}
