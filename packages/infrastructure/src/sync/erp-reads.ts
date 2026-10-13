/**
 * ERP 业务/主数据读取层（读侧，单向只读）—— 管家婆财贸 SQL Server。
 *
 * 与 `erp-source.ts`（仅 Ptype / TestItem 字典同步）互补：本文件面向 QMS 需要的
 * 「主数据·规格 / 订单·批次 / 供应商质量 / 质量成本」四大类取数，全部走 `queryErpReadOnly`
 * 只读守门（见 `erp-readonly.ts`，写语句直接抛错，fail-closed）。
 *
 * 表结构依据：`(管家婆财贸事业部)主要数据结构.docx`（2026-09）。
 *
 * ── 需求项 → ERP 表 映射（已核对文档）────────────────────────────────────
 * 主数据与规格
 *   物料/产品代码          → Ptype（typeId/UserCode/FullName/Standard/Type…）        ✅
 *   版本(version)          → 管家婆无独立"版本"字段；以 Standard(规格)/Type(型号) 代理  ⚠️ 不存在
 *   BOM 物料清单           → T_SC_BOM_Ndx(索引) + T_SC_BOM_Detail(明细)             ✅
 *   工艺路线               → T_PM_ProcessRoute + T_PM_ProcessRoutes + T_PM_ProcessRoutePtypes ✅
 *   批准供应商清单         → 无独立表；Btype(isclient=0) 即供应商，bQuality(是否质检) 作近似  ⚠️ 无"批准"状态
 *   计量单位换算规则       → t_jxc_ptypeunit（PtypeId/UnitName/UnitRate）+ Ptype.Unit*  ✅
 * 订单与批次信息
 *   采购订单               → DlyNdxOrder(VchType=150) + BakDlyOrder                  ✅
 *   生产工单               → dlyndxsc + DlySC（生产任务/委外加工）                   ✅
 *   批次/序列号            → 批号 Blockno 多表通用（BakDlyOrder/DlyCheck/DlySC…）；   ✅ 批号
 *                            序列号仅 Ptype.ManSerialNum 管理标志，无独立数值字段    ⚠️ 序列号仅标志
 * 供应商质量数据
 *   供应商基础信息         → Btype WHERE isclient=0                                  ✅
 *   来料检验结果反馈       → Dlyndxcheck + DlyCheck（管家婆自带送检/检验单）          ✅ 已存在
 *   供应商纠正措施 SCAR    → ERP 无此概念；属 QMS 自身功能                           ❌ 不存在
 * 质量成本相关数据
 *   成本中心               → 无独立表；Department(部门档案, 含 Costtype) 作代理；
 *                            AtypeCW(会计科目) 带 核算部门/供应商… 标志               ⚠️ 代理
 *   物料财务属性           → Ptype(costmode/CostPrice/Tax/GoodsProp…) + t_goodsprop  ✅
 * ───────────────────────────────────────────────────────────────────────────────
 */
import path from 'node:path';
import type sql from 'mssql';
import { queryErpReadOnly, type ErpQueryParam, type ErpQueryRunner } from './erp-readonly.js';

/* ----------------------------- 行类型定义 ----------------------------- */

export interface ErpMaterialRow {
  typeId: string;
  userCode: string;
  fullName: string | null;
  name: string | null;
  standard: string | null;
  model: string | null;
  unitName: string | null;
  isPurchase: boolean;
  isProduce: boolean;
  isConsign: boolean;
  manageBatch: boolean;
  manageSerial: boolean;
  defaultSupplierId: string | null;
  defaultWarehouseId: string | null;
  costMode: number | null;
  taxRate: number | null;
  comment: string | null;
}

export interface ErpUnitConversionRow {
  ptypeId: string;
  unitName: string;
  unitRate: number;
  nUnit: number;
}

export interface ErpBomIndexRow {
  bomId: number;
  ptypeId: string;
  userCode: string;
  fullName: string;
  qty: number;
  manHour: number;
  bomDate: string | null;
  auditor: string | null;
  auditDate: string | null;
}

export interface ErpBomDetailRow {
  parentTypeId: string;
  ptypeId: string;
  qty: number;
  wastage: number;
  scale: number;
  level: number;
  orderIndex: number;
}

export interface ErpRoutingRow {
  rec: number;
  bomId: number;
  ptypeId: string;
  pUserCode: string;
  qty: number;
  maker: string | null;
  makeTime: string | null;
}

export interface ErpRoutingStepRow {
  rec: number;
  ndxRec: number;
  routeId: string;
  nextRouteId: string;
  ptypeId: string;
  qty: number;
  quotaHour: number;
  rowNo: number;
}

export interface ErpSupplierRow {
  typeId: string;
  userCode: string;
  fullName: string;
  name: string | null;
  contact: string | null;
  phone: string | null;
  address: string | null;
  taxNumber: string | null;
  isClient: boolean;
  qualityChecked: boolean;
  email: string | null;
  mobile: string | null;
  comment: string | null;
}

/**
 * ERP 客户（Btype，isclient=1）。与 {@link ErpSupplierRow} 同表不同标记位，字段完全一致，
 * 仅 isClient 恒为 true。用途：出货检验(OQC)的客户来源（检验基准 / 客户特殊要求）。
 */
export interface ErpCustomerRow {
  typeId: string;
  userCode: string;
  fullName: string;
  name: string | null;
  contact: string | null;
  phone: string | null;
  address: string | null;
  taxNumber: string | null;
  isClient: boolean;
  email: string | null;
  mobile: string | null;
  comment: string | null;
}

export interface ErpPurchaseOrderRow {
  vchCode: number;
  number: string;
  date: string;
  btypeId: string;
  etypeId: string;
  ktypeId: string;
  total: number;
  isQMCheck: boolean;
  draft: number;
  orderOver: number;
}

export interface ErpPurchaseOrderLineRow {
  vchCode: number;
  dlyOrder: number;
  ptypeId: string;
  qty: number;
  price: number;
  total: number;
  blockNo: string | null;
  bomType: string | null;
  unit: number;
}

export interface ErpProductionOrderRow {
  vchCode: number;
  number: string;
  date: string;
  vchType: number;
  workshopId: string;
  btypeId: string;
  dateBegin: string;
  dateEnd: string;
  contractNo: string | null;
  billType: number;
}

export interface ErpIncomingInspectionRow {
  vchCode: number;
  number: string;
  vchType: number;
  date: string;
  btypeId: string;
  ptypeId: string;
  qty: number;
  qty2: number;
  qty3: number;
  qmReason: string | null;
  blockNo: string | null;
  sourceVchCode: number;
  /**
   * 物料在 ERP 的用户编码（Ptype.UserCode），即 QMS 的 materialCode。
   * 管家婆 DlyCheck 只存内部 typeId，建 QMS 单必须用 UserCode 才能命中 materials 主数据，
   * 故在此 JOIN Ptype 一并取出（见 INCOMING_INSPECTION_SELECT_SQL）。
   */
  ptypeUserCode: string;
  /** 供应商在 ERP 的用户编码（Btype.UserCode），即 QMS 的 supplierCode；同上 JOIN Btype 取出 */
  btypeUserCode: string;
}

/**
 * ERP 委外加工单（委外检验 OQC 数据源）行。
 *
 * 来源：管家婆 `DlyndxSC`（委外加工单表头，VchType=181）+ `DlySC`（委外加工单明细，一行一个物料）
 * + `Ptype`（取物料用户编码/名称）+ `Btype`（取委外加工单位用户编码，即 QMS 的供应商编码）。
 * 一张委外加工单可含多物料明细行 → 多张 QMS 委外检验单（OQC_SF / OQC_MACH / OQC_HEAT，按备注关键词分类）。
 *
 * 说明：ERP 委外加工单本身**没有**「表面/机加/热处理」的标准区分字段（WtypeID、DlySC.ProcessTypeId
 * 均为空，ProduceType 仅 0/1 二态），分类只能依据明细备注 `DlySC.Comment` 里的工艺词（如「发黑」）
 * 做关键词识别，识别不出的一律归「表面处理(OQC_SF)」。该分类逻辑放在 application 同步用例里。
 */
export interface ErpOutsourceInspectionRow {
  vchCode: number;
  /** 委外加工单号（DlyndxSC.Number），即 QMS outsource_no 的 ERP 镜像；空时回落 `WWJG-{vchCode}` */
  number: string;
  /** 委外加工单日期（DlyndxSC.Date，YYYY-MM-DD） */
  date: string;
  /** 委外加工单位在 ERP 的 typeId（DlyndxSC.BtypeID） */
  btypeId: string;
  /** 物料在 ERP 的 typeId（DlySC.PtypeID） */
  ptypeId: string;
  /** 物料在 ERP 的用户编码（Ptype.UserCode），即 QMS 的 materialCode */
  ptypeUserCode: string;
  /** 物料名称（Ptype.FullName），建单时若不传则由 CreateInspectionOrderUseCase 按主数据补齐 */
  ptypeFullName: string;
  /** 委外加工单位在 ERP 的用户编码（Btype.UserCode），即 QMS 的 supplierCode */
  btypeUserCode: string;
  /** 送检/加工数量（DlySC.Qty）；与 qty2 取大值作为报检批量 */
  qty: number;
  qty2: number;
  /** 批号（DlySC.Blockno），缺失时回落 `B-{单号}` */
  blockNo: string;
  /** 明细备注（DlySC.Comment）：可能含工艺词（发黑/镀锌…）或加急说明（急件/紧急），用于分类识别 */
  detailComment: string;
}

/**
 * ERP 销售出库（出货检验 OQC 数据源）行。
 *
 * 来源：管家婆 `DlySale`（销售明细表；本测试账套销售单 VchType=11，文档常写 86 但实库无此类型）+ 表头 `DlyNdx`（取单据编号 Number）
 * + `Ptype`（取成品用户编码/名称）+ `Btype`（取客户名称，isclient=1）。
 * 一张销售出库单可含多成品行 → 多张 QMS 出货检验单（OQC_SH）。
 */
export interface ErpSalesDispatchRow {
  /** 销售出库明细 Vchcode（关联表头 DlyNdx 取单号） */
  vchCode: number;
  /** 销售出库单号（DlyNdx.Number，经 Vchcode 关联表头） */
  number: string;
  /** 明细单据类型（本账套销售单 = 11；文档常写销售出库 86、退货 87、销售单 32，但实库无 86/87/32） */
  vchType: number;
  /** 单据日期（DlySale.date，nvarchar(10)） */
  date: string;
  /** 客户往来单位内部 typeId（DlySale.btypeid） */
  btypeId: string;
  /** 成品存货内部 typeId（DlySale.PtypeId） */
  ptypeId: string;
  /** 成品在 ERP 的用户编码（Ptype.UserCode）= QMS 的 materialCode */
  ptypeUserCode: string;
  /** 成品名称（Ptype.FullName） */
  ptypeFullName: string | null;
  /** 客户名称（Btype.FullName，isclient=1） */
  customerName: string | null;
  /** 出库数量（DlySale.Qty） */
  qty: number;
  /** 批号（DlySale.Blockno） */
  blockNo: string | null;
  /** 生产日期（DlySale.ProduceDate，nvarchar(10)） */
  produceDate: string | null;
  /** 行摘要（DlySale.comment） */
  comment: string | null;
  /** 项目/部门 typeId（DlySale.ProjectID） */
  projectId: string | null;
}

export interface ErpBatchRow {
  vchCode: number;
  sourceVchCode: number;
  ptypeId: string;
  blockNo: string;
  qty: number;
}

export interface ErpCostCenterRow {
  typeId: string;
  userCode: string;
  fullName: string;
  comment: string | null;
  depType: number | null;
  costType: number | null;
  atypeId: string | null;
}

export interface ErpMaterialFinancialRow {
  typeId: string;
  userCode: string;
  fullName: string;
  costMode: number | null;
  costPrice: number | null;
  taxRate: number | null;
  goodsPropId: string | null;
  prePrice1: number | null;
}

/* ----------------------------- 取数接口 ----------------------------- */

export interface ErpReads {
  readonly name: string;
  readonly kind: 'mssql' | 'fixture';
  fetchMaterials(limit: number): Promise<ErpMaterialRow[]>;
  fetchUnitConversions(limit: number): Promise<ErpUnitConversionRow[]>;
  fetchBomIndex(limit: number): Promise<ErpBomIndexRow[]>;
  fetchBomDetail(limit: number): Promise<ErpBomDetailRow[]>;
  fetchRoutings(limit: number): Promise<ErpRoutingRow[]>;
  fetchRoutingSteps(limit: number): Promise<ErpRoutingStepRow[]>;
  fetchSuppliers(limit: number): Promise<ErpSupplierRow[]>;
  fetchCustomers(limit: number): Promise<ErpCustomerRow[]>;
  fetchPurchaseOrders(limit: number): Promise<ErpPurchaseOrderRow[]>;
  fetchPurchaseOrderLines(limit: number): Promise<ErpPurchaseOrderLineRow[]>;
  fetchProductionOrders(limit: number): Promise<ErpProductionOrderRow[]>;
  fetchIncomingInspections(limit: number): Promise<ErpIncomingInspectionRow[]>;
  fetchOutsourceInspections(limit: number): Promise<ErpOutsourceInspectionRow[]>;
  fetchSalesDispatch(limit: number, offset?: number): Promise<ErpSalesDispatchRow[]>;
  fetchBatches(limit: number): Promise<ErpBatchRow[]>;
  fetchCostCenters(limit: number): Promise<ErpCostCenterRow[]>;
  fetchMaterialFinancials(limit: number): Promise<ErpMaterialFinancialRow[]>;
}

/* ----------------------------- SQL 常量（全部只读 SELECT） ----------------------------- */

export const MATERIAL_SELECT_SQL = [
  'SELECT TOP (@limit) typeId, UserCode, FullName, Name, Standard, Type,',
  "       ISNULL(Unit1, N'件') AS UnitName,",
  '       ISNULL(bPurchase, 0) AS bPurchase, ISNULL(bProduce, 0) AS bProduce, ISNULL(bConsign, 0) AS bConsign,',
  '       ISNULL(bBlockNo, 0) AS bBlockNo, ISNULL(ManSerialNum, 0) AS ManSerialNum,',
  "       NULLIF(Btypeid, '') AS Btypeid, NULLIF(KTypeID, '') AS KTypeID,",
  '       costmode, Tax, Comment',
  '  FROM Ptype',
  ' WHERE deleted = 0 AND sonnum = 0',
  "   AND UserCode IS NOT NULL AND UserCode <> N''",
  ' ORDER BY typeId DESC',
].join('\n');

export const UNIT_CONVERSION_SELECT_SQL = [
  'SELECT PtypeId, nUnit, UnitName, UnitRate',
  '  FROM t_jxc_ptypeunit',
  ' ORDER BY PtypeId, nUnit',
].join('\n');

export const BOM_INDEX_SELECT_SQL = [
  'SELECT ID, PtypeID, UserCode, FullName, Qty, ManHour, BomDate, Auditor, AuditDate',
  '  FROM T_SC_BOM_Ndx',
  ' ORDER BY ID DESC',
].join('\n');

export const BOM_DETAIL_SELECT_SQL = [
  'SELECT ParTypeID, PtypeID, Qty, Wastage, Scale, Leveal, OrderIndex',
  '  FROM T_SC_BOM_Detail',
  ' ORDER BY ParTypeID, OrderIndex',
].join('\n');

export const ROUTING_SELECT_SQL = [
  'SELECT Rec, BomId, PtypeId, PUserCode, Qty, Maker, MakeTime',
  '  FROM T_PM_ProcessRoute',
  ' ORDER BY Rec DESC',
].join('\n');

export const ROUTING_STEP_SELECT_SQL = [
  'SELECT Rec, NdxRec, RouteId, NextRouteId, PtypeId, Qty, QuotaHour, RowNo',
  '  FROM T_PM_ProcessRoutes',
  ' ORDER BY NdxRec, RowNo',
].join('\n');

export const SUPPLIER_SELECT_SQL = [
  'SELECT typeId, UserCode, FullName, Name, Person, Area, TelAndAddress, TaxNumber,',
  '       isclient, Email, Mobile, Comment',
  '  FROM Btype',
  ' WHERE isclient = 0 AND deleted = 0',
  ' ORDER BY typeId DESC',
].join('\n');

export const CUSTOMER_SELECT_SQL = [
  'SELECT typeId, UserCode, FullName, Name, Person, Area, TelAndAddress, TaxNumber,',
  '       isclient, Email, Mobile, Comment',
  '  FROM Btype',
  ' WHERE isclient = 1 AND deleted = 0 AND sonnum = 0',
  "   AND UserCode IS NOT NULL AND UserCode <> N''",
  ' ORDER BY typeId DESC',
].join('\n');

export const PURCHASE_ORDER_SELECT_SQL = [
  'SELECT Vchcode, Number, Date, btypeid, etypeid, ktypeid, total, IsQMCheck, draft, orderover',
  '  FROM DlyNdxOrder',
  ' WHERE VchType = 150',
  ' ORDER BY Vchcode DESC',
].join('\n');

export const PURCHASE_ORDER_LINE_SELECT_SQL = [
  'SELECT Vchcode, dlyorder, PtypeId, Qty, price, total, Blockno, BOMType, unit',
  '  FROM BakDlyOrder',
  ' WHERE VchType = 150',
  ' ORDER BY Vchcode DESC, dlyorder',
].join('\n');

export const PRODUCTION_ORDER_SELECT_SQL = [
  'SELECT Vchcode, Number, Date, Vchtype, WtypeID, BtypeID, DateBegin, DateEnd, Compact, BillType',
  '  FROM dlyndxsc',
  ' ORDER BY Vchcode DESC',
].join('\n');

export const INCOMING_INSPECTION_SELECT_SQL = [
  // TOP (@limit) 必须有：DlyCheck 是"一行一个物料"，历史单据可达数万行，
  // 不加 TOP 会一次性全表拉回（曾实测 23760 行 / 6MB+），同步接口据此建单会失控。
  'SELECT TOP (@limit) d.Vchcode, ISNULL(h.Number, N\'\') AS Number, d.Vchtype, ISNULL(h.Date, N\'\') AS Date,',
  '       d.BtypeId, d.PtypeId, d.Qty, d.Qty2, d.Qty3, d.QMReason, d.Blockno, d.SourceVchcode,',
  '       ISNULL(p.UserCode, N\'\') AS PtypeUserCode, ISNULL(b.UserCode, N\'\') AS BtypeUserCode',
  '  FROM DlyCheck d',
  '  LEFT JOIN Dlyndxcheck h ON h.Vchcode = d.Vchcode',
  '  LEFT JOIN Ptype p ON p.typeId = d.PtypeId',
  '  LEFT JOIN Btype b ON b.typeId = d.BtypeId',
  ' ORDER BY d.Vchcode DESC',
].join('\n');

export const OUTSOURCE_INSPECTION_SELECT_SQL = [
  // TOP (@limit) 必须有：一张委外加工单多物料明细行，历史可达数千行，不加 TOP 会一次性全表拉回。
  // VchType = 181 = 委外加工单；表头 DlyndxSC 取单号/日期/委外加工单位，明细 DlySC 取物料/数量/批号/备注。
  'SELECT TOP (@limit)',
  '       n.Vchcode AS vchCode,',
  "       ISNULL(n.Number, N'') AS Number,",
  "       CONVERT(varchar(10), n.Date, 120) AS Date,",
  '       n.BtypeID AS BtypeId,',
  '       d.PtypeID AS PtypeId,',
  "       ISNULL(p.UserCode, N'') AS PtypeUserCode,",
  "       ISNULL(p.FullName, N'') AS PtypeFullName,",
  "       ISNULL(b.UserCode, N'') AS BtypeUserCode,",
  '       ISNULL(d.Qty, 0) AS Qty,',
  "       ISNULL(d.Blockno, N'') AS BlockNo,",
  "       ISNULL(d.Comment, N'') AS DetailComment",
  '  FROM DlyndxSC n',
  '  INNER JOIN DlySC d ON n.Vchcode = d.Vchcode',
  '  LEFT JOIN Ptype p ON p.typeId = d.PtypeId',
  '  LEFT JOIN Btype b ON b.typeId = n.BtypeID',
  ' WHERE n.VchType = 181',
  ' ORDER BY n.Date DESC, n.Vchcode DESC',
].join('\n');

export const SALES_DISPATCH_SELECT_SQL = [
  // 全量同步分页：用 ROW_NUMBER() OVER (ORDER BY s.Vchcode DESC) 做 keyset 翻页，
  // 兼容 SQL Server 2005+（不依赖 OFFSET/FETCH NEXT 的 2012+ 语法）。@offset 从 0 起，每页 @limit 行。
  // DlySale 是销售模块影响库存的明细总表，历史可达数万行，必须分页，否则一次性全表拉回建单会失控。
  // 仅取销售单（本账套 VchType=11；文档常称 86 但实库无此类型）。
  // 注意：管家婆本账套「销售单」数量以负数存储（出库减库存方向），故不能加 Qty>0 过滤，
  // 出货数量在建单时取 ABS(Qty)。
  'SELECT x.Vchcode, x.Number, x.Vchtype, x.Date, x.BtypeId, x.PtypeId,',
  '       x.PtypeUserCode, x.PtypeFullName, x.CustomerName, x.Qty, x.BlockNo,',
  '       x.ProduceDate, x.Comment, x.ProjectID',
  '  FROM (',
  '    SELECT ROW_NUMBER() OVER (ORDER BY s.Vchcode DESC) AS _rn,',
  '           s.Vchcode, ISNULL(h.Number, N\'\') AS Number, s.Vchtype, ISNULL(s.date, N\'\') AS Date,',
  '           s.BtypeId, s.PtypeId, ISNULL(p.UserCode, N\'\') AS PtypeUserCode, p.FullName AS PtypeFullName,',
  '           b.FullName AS CustomerName, ISNULL(s.Qty, 0) AS Qty, s.Blockno AS BlockNo,',
  '           s.ProduceDate AS ProduceDate, s.comment AS Comment, s.ProjectID AS ProjectID',
  '      FROM DlySale s',
  '      LEFT JOIN DlyNdx h ON h.Vchcode = s.Vchcode',
  '      LEFT JOIN Ptype p ON p.typeId = s.PtypeId',
  "      LEFT JOIN Btype b ON b.typeId = s.btypeid AND b.isclient = 1",
  '     WHERE s.VchType = 11',
  '  ) x',
  ' WHERE x._rn > @offset AND x._rn <= @offset + @limit',
  ' ORDER BY x._rn',
].join('\n');

export const BATCH_SELECT_SQL = [
  'SELECT Vchcode, SourceVchCode, PtypeId, Blockno, Qty',
  '  FROM BakDlyOrder',
  " WHERE VchType = 150 AND Blockno IS NOT NULL AND Blockno <> N''",
  ' ORDER BY Vchcode DESC',
].join('\n');

export const COST_CENTER_SELECT_SQL = [
  'SELECT typeid, usercode, FullName, Comment, deptype, Costtype, Atypeid',
  '  FROM Department',
  ' WHERE deleted = 0',
  ' ORDER BY typeid',
].join('\n');

export const MATERIAL_FINANCIAL_SELECT_SQL = [
  'SELECT TOP (@limit) typeId, UserCode, FullName, costmode, CostPrice, Tax,',
  "       NULLIF(GoodsProp, '') AS GoodsProp, preprice1",
  '  FROM Ptype',
  ' WHERE deleted = 0 AND sonnum = 0',
  "   AND UserCode IS NOT NULL AND UserCode <> N''",
  ' ORDER BY typeId DESC',
].join('\n');

/* ----------------------------- 工具函数 ----------------------------- */

export function normalizeLimit(limit: number | undefined): number {
  const value = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 500;
  // 上限提到 50000：ERP 来料检验实际有 23758 行，单次全量同步需超过旧上限 20000；
  // 其余 fetch 方法（物料/供应商主数据等）只是放宽了 TOP 上限，仍只返回真实存在的行，无副作用。
  return Math.min(Math.max(value, 1), 50000);
}

/** 分页偏移：下限 0，不接受负数；缺省 0 */
export function normalizeOffset(offset: number | undefined): number {
  const value = typeof offset === 'number' && Number.isFinite(offset) ? Math.floor(offset) : 0;
  return Math.max(value, 0);
}

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const asNum = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const asBool = (value: unknown): boolean => value === true || value === 1;

function toRunner(pool: sql.ConnectionPool): ErpQueryRunner {
  return {
    async query(sqlText, params = []) {
      const request = pool.request();
      for (const param of params) request.input(param.name, param.value);
      const result = await request.query(sqlText);
      return { recordset: (result?.recordset ?? []) as unknown[] };
    },
  };
}

/* ----------------------------- mssql 真源实现 ----------------------------- */

export function createMssqlErpReads(pool: sql.ConnectionPool): ErpReads {
  const runner = toRunner(pool);
  const select = <T>(sql: string, params: readonly ErpQueryParam[] = []): Promise<T[]> =>
    queryErpReadOnly<T>(runner, sql, params);

  return {
    name: 'guanjiapo-erp-reads(mssql)',
    kind: 'mssql',

    async fetchMaterials(limit) {
      const rows = await select<Record<string, unknown>>(MATERIAL_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        typeId: String(r.typeId ?? ''),
        userCode: String(r.UserCode ?? ''),
        fullName: asText(r.FullName),
        name: asText(r.Name),
        standard: asText(r.Standard),
        model: asText(r.Type),
        unitName: asText(r.UnitName),
        isPurchase: asBool(r.bPurchase),
        isProduce: asBool(r.bProduce),
        isConsign: asBool(r.bConsign),
        manageBatch: asBool(r.bBlockNo),
        manageSerial: asBool(r.ManSerialNum),
        defaultSupplierId: asText(r.Btypeid),
        defaultWarehouseId: asText(r.KTypeID),
        costMode: asNum(r.costmode),
        taxRate: asNum(r.Tax),
        comment: asText(r.Comment),
      }));
    },

    async fetchUnitConversions(limit) {
      const rows = await select<Record<string, unknown>>(UNIT_CONVERSION_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        ptypeId: String(r.PtypeId ?? ''),
        unitName: String(r.UnitName ?? ''),
        unitRate: asNum(r.UnitRate) ?? 1,
        nUnit: asNum(r.nUnit) ?? 0,
      }));
    },

    async fetchBomIndex(limit) {
      const rows = await select<Record<string, unknown>>(BOM_INDEX_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        bomId: asNum(r.ID) ?? 0,
        ptypeId: String(r.PtypeID ?? ''),
        userCode: String(r.UserCode ?? ''),
        fullName: String(r.FullName ?? ''),
        qty: asNum(r.Qty) ?? 0,
        manHour: asNum(r.ManHour) ?? 0,
        bomDate: asText(r.BomDate),
        auditor: asText(r.Auditor),
        auditDate: asText(r.AuditDate),
      }));
    },

    async fetchBomDetail(limit) {
      const rows = await select<Record<string, unknown>>(BOM_DETAIL_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        parentTypeId: String(r.ParTypeID ?? ''),
        ptypeId: String(r.PtypeID ?? ''),
        qty: asNum(r.Qty) ?? 0,
        wastage: asNum(r.Wastage) ?? 0,
        scale: asNum(r.Scale) ?? 0,
        level: asNum(r.Leveal) ?? 1,
        orderIndex: asNum(r.OrderIndex) ?? 0,
      }));
    },

    async fetchRoutings(limit) {
      const rows = await select<Record<string, unknown>>(ROUTING_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        rec: asNum(r.Rec) ?? 0,
        bomId: asNum(r.BomId) ?? 0,
        ptypeId: String(r.PtypeId ?? ''),
        pUserCode: String(r.PUserCode ?? ''),
        qty: asNum(r.Qty) ?? 0,
        maker: asText(r.Maker),
        makeTime: asText(r.MakeTime),
      }));
    },

    async fetchRoutingSteps(limit) {
      const rows = await select<Record<string, unknown>>(ROUTING_STEP_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        rec: asNum(r.Rec) ?? 0,
        ndxRec: asNum(r.NdxRec) ?? 0,
        routeId: String(r.RouteId ?? ''),
        nextRouteId: String(r.NextRouteId ?? ''),
        ptypeId: String(r.PtypeId ?? ''),
        qty: asNum(r.Qty) ?? 0,
        quotaHour: asNum(r.QuotaHour) ?? 0,
        rowNo: asNum(r.RowNo) ?? 0,
      }));
    },

    async fetchSuppliers(limit) {
      const rows = await select<Record<string, unknown>>(SUPPLIER_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        typeId: String(r.typeId ?? ''),
        userCode: String(r.UserCode ?? ''),
        fullName: String(r.FullName ?? ''),
        name: asText(r.Name),
        contact: asText(r.Person),
        phone: asText(r.Area),
        address: asText(r.TelAndAddress),
        taxNumber: asText(r.TaxNumber),
        isClient: asBool(r.isclient),
        qualityChecked: false,
        email: asText(r.Email),
        mobile: asText(r.Mobile),
        comment: asText(r.Comment),
      }));
    },

    async fetchCustomers(limit) {
      const rows = await select<Record<string, unknown>>(CUSTOMER_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        typeId: String(r.typeId ?? ''),
        userCode: String(r.UserCode ?? ''),
        fullName: String(r.FullName ?? ''),
        name: asText(r.Name),
        contact: asText(r.Person),
        phone: asText(r.Area),
        address: asText(r.TelAndAddress),
        taxNumber: asText(r.TaxNumber),
        isClient: asBool(r.isclient),
        email: asText(r.Email),
        mobile: asText(r.Mobile),
        comment: asText(r.Comment),
      }));
    },

    async fetchPurchaseOrders(limit) {
      const rows = await select<Record<string, unknown>>(PURCHASE_ORDER_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        vchCode: asNum(r.Vchcode) ?? 0,
        number: String(r.Number ?? ''),
        date: String(r.Date ?? ''),
        btypeId: String(r.btypeid ?? ''),
        etypeId: String(r.etypeid ?? ''),
        ktypeId: String(r.ktypeid ?? ''),
        total: asNum(r.total) ?? 0,
        isQMCheck: asBool(r.IsQMCheck),
        draft: asNum(r.draft) ?? 0,
        orderOver: asNum(r.orderover) ?? 0,
      }));
    },

    async fetchPurchaseOrderLines(limit) {
      const rows = await select<Record<string, unknown>>(PURCHASE_ORDER_LINE_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        vchCode: asNum(r.Vchcode) ?? 0,
        dlyOrder: asNum(r.dlyorder) ?? 0,
        ptypeId: String(r.PtypeId ?? ''),
        qty: asNum(r.Qty) ?? 0,
        price: asNum(r.price) ?? 0,
        total: asNum(r.total) ?? 0,
        blockNo: asText(r.Blockno),
        bomType: asText(r.BOMType),
        unit: asNum(r.unit) ?? 1,
      }));
    },

    async fetchProductionOrders(limit) {
      const rows = await select<Record<string, unknown>>(PRODUCTION_ORDER_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        vchCode: asNum(r.Vchcode) ?? 0,
        number: String(r.Number ?? ''),
        date: String(r.Date ?? ''),
        vchType: asNum(r.Vchtype) ?? 0,
        workshopId: String(r.WtypeID ?? ''),
        btypeId: String(r.BtypeID ?? ''),
        dateBegin: String(r.DateBegin ?? ''),
        dateEnd: String(r.DateEnd ?? ''),
        contractNo: asText(r.Compact),
        billType: asNum(r.BillType) ?? 0,
      }));
    },

    async fetchIncomingInspections(limit) {
      const rows = await select<Record<string, unknown>>(INCOMING_INSPECTION_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        vchCode: asNum(r.Vchcode) ?? 0,
        number: String(r.Number ?? ''),
        vchType: asNum(r.Vchtype) ?? 0,
        date: String(r.Date ?? ''),
        btypeId: String(r.BtypeId ?? ''),
        ptypeId: String(r.PtypeId ?? ''),
        qty: asNum(r.Qty) ?? 0,
        qty2: asNum(r.Qty2) ?? 0,
        qty3: asNum(r.Qty3) ?? 0,
        qmReason: asText(r.QMReason),
        blockNo: asText(r.Blockno),
        sourceVchCode: asNum(r.SourceVchcode) ?? 0,
        ptypeUserCode: String(r.PtypeUserCode ?? ''),
        btypeUserCode: String(r.BtypeUserCode ?? ''),
      }));
    },

    async fetchOutsourceInspections(limit) {
      const rows = await select<Record<string, unknown>>(OUTSOURCE_INSPECTION_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        vchCode: asNum(r.vchCode) ?? 0,
        number: String(r.Number ?? ''),
        date: String(r.Date ?? ''),
        btypeId: String(r.BtypeId ?? ''),
        ptypeId: String(r.PtypeId ?? ''),
        ptypeUserCode: String(r.PtypeUserCode ?? ''),
        ptypeFullName: String(r.PtypeFullName ?? ''),
        btypeUserCode: String(r.BtypeUserCode ?? ''),
        qty: asNum(r.Qty) ?? 0,
        // DlySC 委外加工单明细只有 Qty 一列数量（无 Qty2/Qty3，那是 DlyBuy 来料单才有），
        // 故 qty2 固定为 0，批次数量以 qty 为准。
        qty2: 0,
        blockNo: String(r.BlockNo ?? ''),
        detailComment: String(r.DetailComment ?? ''),
      }));
    },

    async fetchSalesDispatch(limit, offset = 0) {
      const rows = await select<Record<string, unknown>>(SALES_DISPATCH_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
        { name: 'offset', value: normalizeOffset(offset) },
      ]);
      return rows.map((r) => ({
        vchCode: asNum(r.Vchcode) ?? 0,
        number: String(r.Number ?? ''),
        vchType: asNum(r.Vchtype) ?? 0,
        date: String(r.Date ?? ''),
        btypeId: String(r.BtypeId ?? ''),
        ptypeId: String(r.PtypeId ?? ''),
        ptypeUserCode: String(r.PtypeUserCode ?? ''),
        ptypeFullName: asText(r.PtypeFullName),
        customerName: asText(r.CustomerName),
        qty: asNum(r.Qty) ?? 0,
        blockNo: asText(r.BlockNo),
        produceDate: asText(r.ProduceDate),
        comment: asText(r.Comment),
        projectId: asText(r.ProjectID),
      }));
    },

    async fetchBatches(limit) {
      const rows = await select<Record<string, unknown>>(BATCH_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        vchCode: asNum(r.Vchcode) ?? 0,
        sourceVchCode: asNum(r.SourceVchCode) ?? 0,
        ptypeId: String(r.PtypeId ?? ''),
        blockNo: String(r.Blockno ?? ''),
        qty: asNum(r.Qty) ?? 0,
      }));
    },

    async fetchCostCenters(limit) {
      const rows = await select<Record<string, unknown>>(COST_CENTER_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        typeId: String(r.typeid ?? ''),
        userCode: String(r.usercode ?? ''),
        fullName: String(r.FullName ?? ''),
        comment: asText(r.Comment),
        depType: asNum(r.deptype),
        costType: asNum(r.Costtype),
        atypeId: asText(r.Atypeid),
      }));
    },

    async fetchMaterialFinancials(limit) {
      const rows = await select<Record<string, unknown>>(MATERIAL_FINANCIAL_SELECT_SQL, [
        { name: 'limit', value: normalizeLimit(limit) },
      ]);
      return rows.map((r) => ({
        typeId: String(r.typeId ?? ''),
        userCode: String(r.UserCode ?? ''),
        fullName: String(r.FullName ?? ''),
        costMode: asNum(r.costmode),
        costPrice: asNum(r.CostPrice),
        taxRate: asNum(r.Tax),
        goodsPropId: asText(r.GoodsProp),
        prePrice1: asNum(r.preprice1),
      }));
    },
  };
}

/* ----------------------------- 本地 fixture 源（无 ERP 也能跑通验证） ----------------------------- */

export interface ErpFixtureData {
  materials?: ErpMaterialRow[];
  unitConversions?: ErpUnitConversionRow[];
  bomIndex?: ErpBomIndexRow[];
  bomDetail?: ErpBomDetailRow[];
  routings?: ErpRoutingRow[];
  routingSteps?: ErpRoutingStepRow[];
  suppliers?: ErpSupplierRow[];
  customers?: ErpCustomerRow[];
  purchaseOrders?: ErpPurchaseOrderRow[];
  purchaseOrderLines?: ErpPurchaseOrderLineRow[];
  productionOrders?: ErpProductionOrderRow[];
  incomingInspections?: ErpIncomingInspectionRow[];
  outsourceInspections?: ErpOutsourceInspectionRow[];
  salesDispatches?: ErpSalesDispatchRow[];
  batches?: ErpBatchRow[];
  costCenters?: ErpCostCenterRow[];
  materialFinancials?: ErpMaterialFinancialRow[];
}

export function createFixtureErpReads(
  data: ErpFixtureData,
  name = 'fixture(本地样例)',
): ErpReads {
  const take = <T>(arr?: T[]): T[] => (arr ?? []).slice(0, normalizeLimit(undefined));
  return {
    name,
    kind: 'fixture',
    fetchMaterials: () => Promise.resolve(take(data.materials)),
    fetchUnitConversions: () => Promise.resolve(take(data.unitConversions)),
    fetchBomIndex: () => Promise.resolve(take(data.bomIndex)),
    fetchBomDetail: () => Promise.resolve(take(data.bomDetail)),
    fetchRoutings: () => Promise.resolve(take(data.routings)),
    fetchRoutingSteps: () => Promise.resolve(take(data.routingSteps)),
    fetchSuppliers: () => Promise.resolve(take(data.suppliers)),
    fetchCustomers: () => Promise.resolve(take(data.customers)),
    fetchPurchaseOrders: () => Promise.resolve(take(data.purchaseOrders)),
    fetchPurchaseOrderLines: () => Promise.resolve(take(data.purchaseOrderLines)),
    fetchProductionOrders: () => Promise.resolve(take(data.productionOrders)),
    fetchIncomingInspections: () => Promise.resolve(take(data.incomingInspections)),
    fetchOutsourceInspections: () => Promise.resolve(take(data.outsourceInspections)),
    fetchSalesDispatch: (limit, offset = 0) =>
      Promise.resolve((data.salesDispatches ?? []).slice(normalizeOffset(offset), normalizeOffset(offset) + normalizeLimit(limit))),
    fetchBatches: () => Promise.resolve(take(data.batches)),
    fetchCostCenters: () => Promise.resolve(take(data.costCenters)),
    fetchMaterialFinancials: () => Promise.resolve(take(data.materialFinancials)),
  };
}
