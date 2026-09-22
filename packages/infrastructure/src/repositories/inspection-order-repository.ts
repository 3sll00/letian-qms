import { sql, type Expression, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
import type { InspectionOrderRepository as IInspectionOrderRepository } from '@letian/domain';
import { InspectionTypeEnum } from '@letian/contracts';
import type { InspectionOrder, InspectionStatus, InspectionType, MaterialPermission } from '@letian/contracts';
import { buildMaterialPermissionWhere } from './pbac-sql-translator.js';
import type {
  Database,
  InspectionOrderRow,
  InspectionOrderUpdate,
} from '../database/schema.js';

/** 濂戠害 InspectionStatusEnum 鐨?8 涓悎娉曞彇鍊硷紝鐢ㄤ簬鎶?string 鏀剁獎涓?InspectionStatus */
const INSPECTION_STATUSES: readonly string[] = [
  'PENDING',
  'INSPECTING',
  'DRAFT',
  'PASSED',
  'FAILED',
  'IN_MRB_REVIEW',
  'RE_INSPECTING',
  'COMPLETED',
];

/**
 * 台账派生列「检验状态」→ 库内 status 组合（不含终检合格判定）。
 *
 * 台账列展示的是**业务语义状态**，与契约 `status` 枚举并非一一对应：
 *  - 已合格 = `COMPLETED` / `PASSED` 且 `judgment <> 'FAILED'`
 *  - 不合格 = `FAILED` / `IN_MRB_REVIEW`，或 `COMPLETED` / `PASSED` 且 `judgment = 'FAILED'`
 * 若由前端各自拼装 `statuses` 组合，筛选结果必然与列上显示的字样漂移（详见 docs 16 §5.1）。
 */
const INSPECTION_STATE_STATUSES: Record<string, readonly string[]> = {
  PENDING: ['PENDING', 'DRAFT'],
  INSPECTING: ['INSPECTING', 'RE_INSPECTING'],
};

/** 需要结合 `judgment` 才能判定派生状态的「已出终检结论」状态集合 */
const DECIDED_INSPECTION_STATUSES: readonly string[] = ['COMPLETED', 'PASSED'];

/**
 * 把台账派生列「检验状态」翻译成 SQL 谓词（唯一实现，避免前后端各写一份口径）。
 * 非法取值直接抛错而不是静默忽略，防止筛选条件被悄悄丢弃后返回全表。
 */
function toInspectionStateWhere(
  eb: ExpressionBuilder<Database, 'inspectionOrders'>,
  state: string
): Expression<SqlBool> {
  const statuses = INSPECTION_STATE_STATUSES[state];
  if (statuses !== undefined) {
    return eb('status', 'in', statuses.map((v) => toInspectionStatus(v)));
  }
  if (state === 'PASSED') {
    return eb.and([
      eb('status', 'in', DECIDED_INSPECTION_STATUSES.map((v) => toInspectionStatus(v))),
      eb.or([eb('judgment', 'is', null), eb('judgment', '!=', 'FAILED')]),
    ]);
  }
  if (state === 'FAILED') {
    return eb.or([
      eb('status', 'in', ['FAILED', 'IN_MRB_REVIEW'].map((v) => toInspectionStatus(v))),
      eb.and([
        eb('status', 'in', DECIDED_INSPECTION_STATUSES.map((v) => toInspectionStatus(v))),
        eb('judgment', '=', 'FAILED'),
      ]),
    ]);
  }
  throw new Error(`ORDER_INSPECTION_STATE_INVALID: 非法的检验状态语义筛选 [${state}]`);
}

/** PostgreSQL uuid 鍒椾笉鎺ュ彈闈?uuid 鏂囨湰锛屾寜 id 鏌ヨ鍓嶅厛鍋氭牸寮忓垽鏂伩鍏?22P02 閿欒 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 契约 InspectionTypeEnum 的 13 个合法取值。
 * 必须与 @letian/contracts 的 InspectionTypeEnum 逐值对齐，
 * 否则委外七分类 (OQC_HEAT / OQC_MACH 等) 查询会在仓储层抛错。
 */
const INSPECTION_TYPES: readonly string[] = [...InspectionTypeEnum.options];

function isInspectionType(value: string): value is InspectionType {
  return INSPECTION_TYPES.includes(value);
}

/**
 * inbound_date 在库中是 timestamptz 列，而契约 DTO / 领域模型侧是 'YYYY-MM-DD' 字符串
 * （见 InspectionOrderSchema.inboundDate）。落库前统一转换，非法值直接报错而不是写入 Invalid Date。
 */
function toInboundDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`INBOUND_DATE_INVALID: 入库日期必须是可解析的日期字符串 [${value}]`);
  }
  return parsed;
}

/**
 * ISO8601 字符串 -> Date：TIMESTAMPTZ 列（如 completed_at）的写入归一。
 * 非法值直接抛错、不静默写 NULL，避免再出现一条「界面看得到、库里没有」的断链（见 docs/29 §3）。
 */
function toTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`TIMESTAMP_INVALID: 时间必须是可解析的日期时间字符串 [${value}]`);
  }
  return parsed;
}

/** 鎶婂閮ㄤ紶鍏ョ殑妫€楠岀被鍨嬪瓧绗︿覆鏀剁獎涓哄绾︽灇涓撅紝闈炴硶鍙栧€肩洿鎺ユ姤閿欒€屼笉鏄潤榛樺叏琛ㄦ壂鎻?*/
function toInspectionType(value: string): InspectionType {
  if (!isInspectionType(value)) {
    throw new Error(`ORDER_TYPE_INVALID: 闈炴硶鐨勬楠岀被鍨?[${value}]`);
  }
  return value;
}

/** ILIKE 妯″紡涓茶浆涔夛細% 涓?_ 鏄€氶厤绗︼紝鐢ㄦ埛杈撳叆蹇呴』鎸夊瓧闈㈤噺鍖归厤 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function isInspectionStatus(value: string): value is InspectionStatus {
  return INSPECTION_STATUSES.includes(value);
}

/** 鎶婂閮ㄤ紶鍏ョ殑鐘舵€佸瓧绗︿覆鏀剁獎涓哄绾︽灇涓撅紝闈炴硶鍙栧€肩洿鎺ユ姤閿欒€屼笉鏄潤榛樿繑鍥炵┖鍒楄〃 */
function toInspectionStatus(value: string): InspectionStatus {
  if (!isInspectionStatus(value)) {
    throw new Error(`ORDER_STATUS_INVALID: 闈炴硶鐨勬楠屽伐鍗曠姸鎬?[${value}]`);
  }
  return value;
}

/** 妫€楠屽崟鍙拌处鍒楄〃鏌ヨ鏉′欢锛堣渚ф姇褰憋紝涓嶅睘浜庨鍩熺鍙ｏ級 */
export interface OrderListQuery {
  statuses?: readonly string[];
  /**
   * 台账「检验状态」派生列语义筛选：PENDING / INSPECTING / PASSED / FAILED。
   * 与 status / statuses 相互独立（叠加时为 AND）；翻译口径见 docs 16 §5.1。
   */
  inspectionState?: string;
  inspectors?: readonly string[];
  supplierCodes?: readonly string[];
  dateFrom?: string;
  dateTo?: string;
  partnerKeyword?: string;
  /** 入库单号模糊匹配（来料检验台账「入库单号」列，006 字段扩展） */
  inboundNo?: string;
  permissions?: readonly MaterialPermission[];
  inspectionType?: string;
  /** 鍓嶇椤电鍒嗙粍锛圛QC/IPQC/FQC/OQC锛夊搴旂殑绫诲瀷闆嗗悎锛屼笌 inspectionType 浜掓枼浣跨敤 */
  inspectionTypes?: readonly string[];
  status?: string;
  batchNo?: string;
  materialCode?: string;
  /** 委外加工单号（ERP 委外工单号）模糊匹配 */
  outsourceNo?: string;
  /** 加工类型/工艺分类精确匹配（如 镀锌 / 热处理 / 机加工） */
  processType?: string;
  salesOrderNo?: string;
  customerName?: string;
  salesOrderPoNo?: string;
  dispatchDate?: string;
  erpStatus?: string;
  /** 鎵规鍙?/ 鐗╂枡缂栫爜 / 鐗╂枡鍚嶇О / 宸ュ崟鍙?鐨勬ā绯婂尮閰?*/
  keyword?: string;
  /**
   * 「检验单号 / 入库单号」模糊匹配（order_no OR inbound_no）。
   * 与 keyword（多字段联合检索）刻意区分：本参数只命中单号类字段，
   * 用于台账「单号」筛选框的精确口径，避免把物料名/批次也一并命中。
   */
  docKeyword?: string;
  /** 「物料编号 / 物料名称」模糊匹配（material_code OR material_name），对应台账「物料」筛选框 */
  materialKeyword?: string;
  /**
   * 「检验工单」= 检验单号（order_no）模糊匹配，对应过程检验台账「检验工单」筛选框。
   * 与 docKeyword（order_no OR inbound_no）刻意区分：只命中 order_no，理由见 docs/28 §2.1。
   */
  orderNo?: string;
  /**
   * 「生产工单」= MES 生产工单号（work_order_no）模糊匹配，对应过程检验台账「生产工单」筛选框。
   * 与列表列「MES生产工单」显示口径一致：物理列为空时按 batch_no 兜底（见 docs/28 §2.3）。
   */
  workOrderNo?: string;
  /**
   * 过程检验台账「操作员」列（下料/滚丝机台作业员姓名）模糊匹配。
   * 控制器 InspectionQuerySchema 早已声明该参数，但此前未在本接口声明、listOrders() 也无条件，
   * 对象展开传参不触发 excess property 检查 -> 输入即静默丢弃（与 docs/28 §2.2 同型，见 docs/29 §3）。
   */
  operatorName?: string;
  /** 过程检验台账「设备」列（机台设备编号）模糊匹配 */
  equipmentCode?: string;
  /** 滚丝检验台账「螺纹规格」列模糊匹配 */
  threadSpec?: string;
  /** 成品检台账「终检班组」列模糊匹配 */
  inspectionTeam?: string;
  /** 过程检验台账「工序阶段」模糊匹配（自动断料 / 手工滚牙 / 检测入库） */
  processStep?: string;
  page: number;
  pageSize: number;
}

/** 妫€楠屽崟鍙拌处鍒楄〃鏌ヨ缁撴灉锛氬綋椤垫暟鎹?+ 鍛戒腑鎬绘暟 + 鍏ㄨ〃鐘舵€佽鏁?*/
export interface OrderListResult {
  total: number;
  list: InspectionOrder[];
  statusCounts: Record<string, number>;
}

/**
 * 妫€楠屽伐鍗曚粨鍌?(Kysely + PostgreSQL)
 *
 * 娉ㄦ剰锛氬绾?DTO 鏃㈡病鏈?batchQty 涔熸病鏈?workshopCode锛?
 * 鍥犳 total_qty / workshop_code 鍙湪棣栨鎻掑叆鏃跺啓 NULL锛屽啿绐佹洿鏂版椂鍒绘剰涓嶅姩锛?
 * 閬垮厤鎶?ERP/MES 鍚屾鍐欏叆鐨勫師濮嬫壒閲忎笌杞﹂棿淇℃伅瑕嗙洊鎺夈€?
 */
export class KyselyInspectionOrderRepository implements IInspectionOrderRepository {
  /** 员工 id -> 姓名 的惰性缓存：检验单表的 inspector_name 允许为空，读侧按主数据补齐 */
  private employeeNameCache: Map<string, string> | null = null;

  /** 供应商编码 -> 名称 的惰性缓存：检验单表的 supplier_name 允许为空，读侧按供应商主数据补齐 */
  private supplierNameCache: Map<string, string> | null = null;

  constructor(private readonly db: Kysely<Database>) {}

  /** 加载职员主数据姓名映射（整个仓储实例只查一次） */
  private async getEmployeeNameMap(): Promise<Map<string, string>> {
    if (this.employeeNameCache === null) {
      const rows = await this.db.selectFrom('employees').select(['id', 'name']).execute();
      this.employeeNameCache = new Map(rows.map((r) => [r.id, r.name]));
    }
    return this.employeeNameCache;
  }

  /**
   * 加载供应商主数据名称映射（整个仓储实例只查一次）
   *
   * 供应商主数据（suppliers）是「供应商」名称的唯一权威来源：检验单上的 supplier_name 只是
   * 建单当时的名称快照，历史行可能为空。为空时读侧回落到本映射，保证台账「供应商」列
   * 永远展示厂商全称，而不是内部编码（如 SUP-001）。
   */
  private async getSupplierNameMap(): Promise<Map<string, string>> {
    if (this.supplierNameCache === null) {
      const rows = await this.db
        .selectFrom('suppliers')
        .select(['supplierCode', 'supplierName'])
        .execute();
      this.supplierNameCache = new Map(rows.map((r) => [r.supplierCode, r.supplierName]));
    }
    return this.supplierNameCache;
  }

  /** 读路径公共参照数据：[员工 id -> 姓名, 供应商编码 -> 名称]（并行加载，各自只查一次） */
  private async getRefNameMaps(): Promise<[Map<string, string>, Map<string, string>]> {
    return await Promise.all([this.getEmployeeNameMap(), this.getSupplierNameMap()]);
  }

  public async findById(id: string): Promise<InspectionOrder | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }

    const row = await this.db
      .selectFrom('inspectionOrders')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? this.mapRow(row, ...(await this.getRefNameMaps())) : null;
  }

  public async findByOrderNo(orderNo: string): Promise<InspectionOrder | null> {
    const row = await this.db
      .selectFrom('inspectionOrders')
      .selectAll()
      .where('orderNo', '=', orderNo)
      .executeTakeFirst();

    return row ? this.mapRow(row, ...(await this.getRefNameMaps())) : null;
  }

  public async findByBatchNo(batchNo: string): Promise<readonly InspectionOrder[]> {
    const rows = await this.db
      .selectFrom('inspectionOrders')
      .selectAll()
      .where('batchNo', '=', batchNo)
      .orderBy('createdAt', 'asc')
      .execute();

    const [names, supplierNames] = await this.getRefNameMaps();
    return rows.map((row) => this.mapRow(row, names, supplierNames));
  }

  /**
   * 按订单标识取一组检验单：同一个订单号可能落在
   * 「检验单号 / 工单号 / 销售出库单号 / 客户采购订单号」四个字段中的任意一个上，
   * 这里四个字段同时等值匹配（任一命中即返回），供订单维度检验环节台账使用。
   */
  public async findByOrderKey(orderKey: string): Promise<readonly InspectionOrder[]> {
    const key = orderKey.trim();
    if (key === '') {
      return [];
    }

    const rows = await this.db
      .selectFrom('inspectionOrders')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('orderNo', '=', key),
          eb('workOrderNo', '=', key),
          eb('salesOrderNo', '=', key),
          eb('salesOrderPoNo', '=', key),
        ])
      )
      .orderBy('createdAt', 'asc')
      .execute();

    const [names, supplierNames] = await this.getRefNameMaps();
    return rows.map((row) => this.mapRow(row, names, supplierNames));
  }

  public async save(order: InspectionOrder): Promise<void> {
    const now = new Date();
    // 契约别名归一：规格型号的唯一落库列是 specification，`spec` 只是读侧别名。
    // 此前这里只认 order.specification，只传别名 spec 的调用方会静默「读得出、写不进」（见 docs/26 §5）。
    const specificationValue = order.specification ?? order.spec;

    // 鎻掑叆鍊煎唴鑱斾功鍐欙紙涓嶉鍏堟爣娉?Insertable 绫诲瀷锛夛紝璁?Kysely 鎸?ValueExpression 閫愬垪鏍￠獙
    await this.db
      .insertInto('inspectionOrders')
      .values({
        orderNo: order.orderNo,
        // plan_id 鍙兘浠庢柟妗堝揩鐓ч噷鍙栵紝DTO 鏈韩涓嶇洿鎺ユ毚闇?planId
        planId: order.planSnapshot.planId,
        orderType: order.inspectionType,
        batchNo: order.batchNo,
        materialCode: order.materialCode,
        materialName: order.materialName,
        supplierCode: order.supplierCode ?? null,
        customerCode: order.customerCode ?? null,
        inspectorId: order.inspectorId ?? null,
        // 「数量」列（报检批量）：契约 DTO 的 totalQty 一直存在，此处此前硬编码写 NULL，
        // 导致过程检验台账「数量」列永远只能显示 --（见 docs/29 §3 断链 ②）
        totalQty: order.totalQty ?? null,
        // 检验人姓名快照：与 inspector_id 一同落库；缺省时不写入，避免覆盖已有值
        ...(order.inspectorName !== undefined ? { inspectorName: order.inspectorName } : {}),
        workshopCode: null,
        sampleQty: order.sampleQty,
        passQty: order.passQty,
        failQty: order.failQty,
        isMandatoryGate: order.isMandatoryGate,
        status: order.status,
        judgment: order.overallDecision ?? null,
        inspectionNotes: order.inspectionNotes ?? null,
        planVersionId: order.planVersionId,
        // 008 出货检验 (OQC) 出库/对账字段：仅当调用方显式传入时才写入，
        // 避免非 OQC 工单或旧调用方把已有值覆盖为 NULL
        // 006 来料检验 (IQC) 入库单号 / 入库日期 / 规格型号 / 计量单位：同一「显式传入才写」口径
        ...(order.inboundNo !== undefined ? { inboundNo: order.inboundNo } : {}),
        ...(order.inboundDate !== undefined
          ? { inboundDate: toInboundDate(order.inboundDate) }
          : {}),
        ...(specificationValue !== undefined ? { specification: specificationValue } : {}),
        ...(order.unit !== undefined ? { unit: order.unit } : {}),
        ...(order.salesOrderNo !== undefined ? { salesOrderNo: order.salesOrderNo } : {}),
        ...(order.dispatchDate !== undefined ? { dispatchDate: order.dispatchDate } : {}),
        ...(order.customerName !== undefined ? { customerName: order.customerName } : {}),
        ...(order.salesOrderPoNo !== undefined ? { salesOrderPoNo: order.salesOrderPoNo } : {}),
        ...(order.erpStatus !== undefined ? { erpStatus: order.erpStatus } : {}),
        // jsonb 鍒楀繀椤绘樉寮忓瓧绗︿覆鍖栵細node-postgres 浼氭妸 JS 鏁扮粍娓叉煋鎴?PG 鏁扮粍瀛楅潰閲?"{"a","b"}")锛?
        // 璇ユ枃鏈笉鏄悎娉?JSON锛孭G 浼氱洿鎺ユ姤 22P02 invalid input syntax for type json
        ...(order.outsourceNo !== undefined ? { outsourceNo: order.outsourceNo } : {}),
        ...(order.processType !== undefined ? { processType: order.processType } : {}),
        ...(order.returnDate !== undefined ? { returnDate: order.returnDate } : {}),
        ...(order.vendorName !== undefined ? { vendorName: order.vendorName } : {}),
        // 007 过程检验工序字段：此前 save() 只写入 work_order_no，其余 9 列（断料长度 / 操作员 /
        // 设备 / 螺纹规格 / 终检组 / 工序阶段 / 完成时间）一列都没写，而读路径 mapRow 一直在读，
        // 属「读得出、写不进」的断链（见 docs/24 §6 D4、docs/29 §3 断链 ②）。
        ...(order.workOrderNo !== undefined ? { workOrderNo: order.workOrderNo } : {}),
        ...(order.blankingLength !== undefined ? { blankingLength: order.blankingLength } : {}),
        ...(order.operatorName !== undefined ? { operatorName: order.operatorName } : {}),
        ...(order.operatorId !== undefined ? { operatorId: order.operatorId } : {}),
        ...(order.equipmentCode !== undefined ? { equipmentCode: order.equipmentCode } : {}),
        ...(order.equipmentName !== undefined ? { equipmentName: order.equipmentName } : {}),
        ...(order.threadSpec !== undefined ? { threadSpec: order.threadSpec } : {}),
        ...(order.inspectionTeam !== undefined ? { inspectionTeam: order.inspectionTeam } : {}),
        ...(order.processStep !== undefined ? { processStep: order.processStep } : {}),
        ...(order.completedAt !== undefined ? { completedAt: toTimestamp(order.completedAt) } : {}),
        planSnapshot: JSON.stringify(order.planSnapshot),
        items: JSON.stringify(order.items),
        updatedAt: now,
        ...(order.id !== undefined ? { id: order.id } : {}),
      })
      .onConflict((oc) =>
        oc.column('orderNo').doUpdateSet({
          orderType: order.inspectionType,
          planId: order.planSnapshot.planId,
          batchNo: order.batchNo,
          materialCode: order.materialCode,
          materialName: order.materialName,
          supplierCode: order.supplierCode ?? null,
          customerCode: order.customerCode ?? null,
          inspectorId: order.inspectorId ?? null,
          sampleQty: order.sampleQty,
          ...(order.inspectorName !== undefined ? { inspectorName: order.inspectorName } : {}),
          // 鏇存柊璺緞涓?Kysely 宸茶В鍖呰鍒楃被鍨嬶紝鐩存帴浼?number 鍗冲彲
          passQty: order.passQty,
          failQty: order.failQty,
          isMandatoryGate: order.isMandatoryGate,
          status: order.status,
          judgment: order.overallDecision ?? null,
          inspectionNotes: order.inspectionNotes ?? null,
          planVersionId: order.planVersionId,
          ...(order.inboundNo !== undefined ? { inboundNo: order.inboundNo } : {}),
          ...(order.inboundDate !== undefined
            ? { inboundDate: toInboundDate(order.inboundDate) }
            : {}),
          ...(specificationValue !== undefined ? { specification: specificationValue } : {}),
          ...(order.unit !== undefined ? { unit: order.unit } : {}),
          ...(order.salesOrderNo !== undefined ? { salesOrderNo: order.salesOrderNo } : {}),
          ...(order.dispatchDate !== undefined ? { dispatchDate: order.dispatchDate } : {}),
          ...(order.customerName !== undefined ? { customerName: order.customerName } : {}),
          ...(order.salesOrderPoNo !== undefined ? { salesOrderPoNo: order.salesOrderPoNo } : {}),
        ...(order.erpStatus !== undefined ? { erpStatus: order.erpStatus } : {}),
        // 009 委外检验 (OQC 七分类) 台账字段：同样仅在显式传入时写入
        ...(order.outsourceNo !== undefined ? { outsourceNo: order.outsourceNo } : {}),
        ...(order.processType !== undefined ? { processType: order.processType } : {}),
        ...(order.returnDate !== undefined ? { returnDate: order.returnDate } : {}),
        ...(order.vendorName !== undefined ? { vendorName: order.vendorName } : {}),
        // 007 过程检验工序字段：与 insert 同一「显式传入才写」口径。
        // 这些值来自仓储读侧的 DTO 回吐（见 mapRow），因此重建型用例（暂存草稿 / 录入实测值 /
        // 复检）不会把已有值抹成 NULL。
        ...(order.workOrderNo !== undefined ? { workOrderNo: order.workOrderNo } : {}),
        ...(order.totalQty !== undefined ? { totalQty: order.totalQty } : {}),
        ...(order.blankingLength !== undefined ? { blankingLength: order.blankingLength } : {}),
        ...(order.operatorName !== undefined ? { operatorName: order.operatorName } : {}),
        ...(order.operatorId !== undefined ? { operatorId: order.operatorId } : {}),
        ...(order.equipmentCode !== undefined ? { equipmentCode: order.equipmentCode } : {}),
        ...(order.equipmentName !== undefined ? { equipmentName: order.equipmentName } : {}),
        ...(order.threadSpec !== undefined ? { threadSpec: order.threadSpec } : {}),
        ...(order.inspectionTeam !== undefined ? { inspectionTeam: order.inspectionTeam } : {}),
        ...(order.processStep !== undefined ? { processStep: order.processStep } : {}),
        ...(order.completedAt !== undefined ? { completedAt: toTimestamp(order.completedAt) } : {}),
        planSnapshot: JSON.stringify(order.planSnapshot),
          items: JSON.stringify(order.items),
          updatedAt: now,
        })
      )
      .execute();
  }

  /**
   * 璇讳晶鎶曞奖锛氭楠屽崟鍙拌处鍒嗛〉鍒楄〃 + 鍏ㄨ〃鐘舵€佽鏁?
   * 浠呯敤浜?API 鍒楄〃椤碉紝涓嶅弬涓庨鍩熷啓璺緞銆?
   */
  public async listOrders(query: OrderListQuery): Promise<OrderListResult> {
    const filter = (eb: ExpressionBuilder<Database, 'inspectionOrders'>): Expression<SqlBool> => {
      const list: Expression<SqlBool>[] = [];
      if (query.inspectionType !== undefined) {
        list.push(eb('orderType', '=', toInspectionType(query.inspectionType)));
      } else if (query.inspectionTypes !== undefined && query.inspectionTypes.length > 0) {
        list.push(eb('orderType', 'in', query.inspectionTypes.map((v) => toInspectionType(v))));
      }
      if (query.status !== undefined) {
        list.push(eb('status', '=', toInspectionStatus(query.status)));
      } else if (query.statuses !== undefined && query.statuses.length > 0) {
        list.push(eb('status', 'in', query.statuses.map((v) => toInspectionStatus(v))));
      }
      // 台账「检验状态」派生口径筛选：与上面的 status/statuses 是并存关系（不互斥），
      // 因为它约束的是 status + judgment 的业务语义，而非单一 status 枚举。
      if (query.inspectionState !== undefined && query.inspectionState !== '') {
        list.push(toInspectionStateWhere(eb, query.inspectionState));
      }
      if (query.batchNo !== undefined) {
        list.push(eb('batchNo', 'ilike', `%${escapeLike(query.batchNo)}%`));
      }
      if (query.materialCode !== undefined) {
        list.push(eb('materialCode', 'ilike', `%${escapeLike(query.materialCode)}%`));
      }
      if (query.outsourceNo !== undefined && query.outsourceNo !== '') {
        list.push(eb('outsourceNo', 'ilike', `%${escapeLike(query.outsourceNo)}%`));
      }
      if (query.processType !== undefined && query.processType !== '') {
        list.push(eb('processType', '=', query.processType));
      }
      if (query.inspectors !== undefined && query.inspectors.length > 0) {
        list.push(eb('inspectorId', 'in', query.inspectors as string[]));
      }
      if (query.supplierCodes !== undefined && query.supplierCodes.length > 0) {
        list.push(eb('supplierCode', 'in', query.supplierCodes as string[]));
      }
      if (query.dateFrom !== undefined && query.dateFrom !== '') {
        list.push(eb('createdAt', '>=', new Date(query.dateFrom)));
      }
      if (query.dateTo !== undefined && query.dateTo !== '') {
        const to = new Date(query.dateTo);
        if (query.dateTo.length <= 10) {
          to.setHours(23, 59, 59, 999);
        }
        list.push(eb('createdAt', '<=', to));
      }
      if (query.inboundNo !== undefined && query.inboundNo !== '') {
        list.push(eb('inboundNo', 'ilike', `%${escapeLike(query.inboundNo)}%`));
      }
      // 008 出货检验 (OQC) 台账筛选：销售出库单号 / 客户 / 客户订单号 支持模糊匹配，
      // 出库日期与 ERP 状态为精确匹配（与前端筛选控件语义一致）
      if (query.salesOrderNo !== undefined && query.salesOrderNo !== '') {
        list.push(eb('salesOrderNo', 'ilike', `%${escapeLike(query.salesOrderNo)}%`));
      }
      if (query.customerName !== undefined && query.customerName !== '') {
        list.push(eb('customerName', 'ilike', `%${escapeLike(query.customerName)}%`));
      }
      if (query.salesOrderPoNo !== undefined && query.salesOrderPoNo !== '') {
        list.push(eb('salesOrderPoNo', 'ilike', `%${escapeLike(query.salesOrderPoNo)}%`));
      }
      if (query.dispatchDate !== undefined && query.dispatchDate !== '') {
        list.push(eb('dispatchDate', '=', query.dispatchDate));
      }
      if (query.erpStatus !== undefined && query.erpStatus !== '') {
        list.push(eb('erpStatus', '=', query.erpStatus));
      }
      if (query.partnerKeyword !== undefined && query.partnerKeyword !== '') {
        const pPat = `%${escapeLike(query.partnerKeyword)}%`;
        list.push(eb.or([
          eb('supplierName', 'ilike', pPat),
          eb('supplierCode', 'ilike', pPat),
          eb('customerCode', 'ilike', pPat),
          eb('customerName', 'ilike', pPat),
        ]));
      }
      if (query.docKeyword !== undefined && query.docKeyword !== '') {
        const dPat = `%${escapeLike(query.docKeyword)}%`;
        list.push(eb.or([eb('orderNo', 'ilike', dPat), eb('inboundNo', 'ilike', dPat)]));
      }
      // 过程检验台账「检验工单」筛选框：只查检验单号，不掺 inbound_no（过程检验无入库单概念）
      if (query.orderNo !== undefined && query.orderNo !== '') {
        list.push(eb('orderNo', 'ilike', `%${escapeLike(query.orderNo)}%`));
      }
      // 过程检验台账「生产工单」筛选框：与列表列「MES生产工单」显示口径一致 ——
      // mapRow 在 work_order_no 为空时用 batch_no 兜底，筛选必须同样兜底，
      // 否则会出现「列上显示 batch_no、输入该值却查不到」的筛选/显示不一致。
      if (query.workOrderNo !== undefined && query.workOrderNo !== '') {
        const wPat = `%${escapeLike(query.workOrderNo)}%`;
        list.push(
          eb.or([
            eb('workOrderNo', 'ilike', wPat),
            eb.and([
              eb.or([eb('workOrderNo', 'is', null), eb('workOrderNo', '=', '')]),
              eb('batchNo', 'ilike', wPat),
            ]),
          ])
        );
      }
      if (query.materialKeyword !== undefined && query.materialKeyword !== '') {
        const mPat = `%${escapeLike(query.materialKeyword)}%`;
        list.push(eb.or([eb('materialCode', 'ilike', mPat), eb('materialName', 'ilike', mPat)]));
      }
      // 过程检验（下料 / 滚丝 / 成品检）台账列级筛选：操作员 / 设备 / 螺纹规格 / 终检班组 / 工序阶段。
      // 这五个参数此前只存在于控制器 InspectionQuerySchema（以及下推对象里），仓储接口未声明、
      // 查询无条件，属「声明了但空转」的筛选黑洞 —— 本轮真正落到 SQL（见 docs/29 §3 断链 ①）。
      if (query.operatorName !== undefined && query.operatorName !== '') {
        list.push(eb('operatorName', 'ilike', `%${escapeLike(query.operatorName)}%`));
      }
      if (query.equipmentCode !== undefined && query.equipmentCode !== '') {
        list.push(eb('equipmentCode', 'ilike', `%${escapeLike(query.equipmentCode)}%`));
      }
      if (query.threadSpec !== undefined && query.threadSpec !== '') {
        list.push(eb('threadSpec', 'ilike', `%${escapeLike(query.threadSpec)}%`));
      }
      if (query.inspectionTeam !== undefined && query.inspectionTeam !== '') {
        list.push(eb('inspectionTeam', 'ilike', `%${escapeLike(query.inspectionTeam)}%`));
      }
      if (query.processStep !== undefined && query.processStep !== '') {
        list.push(eb('processStep', 'ilike', `%${escapeLike(query.processStep)}%`));
      }
      if (query.permissions && query.permissions.length > 0) {
        const permClause = buildMaterialPermissionWhere(query.permissions);
        if (permClause) {
          list.push(permClause);
        }
      }
      if (query.keyword !== undefined && query.keyword !== '') {
        const pattern = `%${escapeLike(query.keyword)}%`;
        list.push(
          eb.or([
            eb('batchNo', 'ilike', pattern),
            eb('materialCode', 'ilike', pattern),
            eb('materialName', 'ilike', pattern),
            eb('orderNo', 'ilike', pattern),
            eb('inboundNo', 'ilike', pattern),
            eb('workOrderNo', 'ilike', pattern),
            eb('operatorName', 'ilike', pattern),
            eb('equipmentCode', 'ilike', pattern),
            eb('equipmentName', 'ilike', pattern),
            eb('salesOrderNo', 'ilike', pattern),
            eb('salesOrderPoNo', 'ilike', pattern),
            eb('customerName', 'ilike', pattern),
          ])
        );
      }
      // 鍚屼竴缁勭瓫閫夋潯浠跺繀椤诲悓鏃朵綔鐢ㄤ簬鍒嗛〉鏌ヨ涓庤鏁版煡璇紝鍚﹀垯 total 涓庢暟鎹笉涓€鑷?
      return list.length > 0 ? eb.and(list) : sql<SqlBool>`1 = 1`;
    };

    const rows = await this.db
      .selectFrom('inspectionOrders')
      .selectAll()
      .where(filter)
      .orderBy('createdAt', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();

    const countRow = await this.db
      .selectFrom('inspectionOrders')
      .select((eb) => eb.fn.countAll().as('total'))
      .where(filter)
      .executeTakeFirst();
    const total = countRow ? Number(countRow.total) : 0;

    // 鐘舵€佽鏁扮敤浜庣湅鏉垮崱鐗囷紝鎸夊叏琛ㄧ粺璁★紙涓嶅彈绛涢€夋潯浠跺奖鍝嶏級
    const statusRows = await this.db
      .selectFrom('inspectionOrders')
      .select((eb) => ['status', eb.fn.countAll().as('count')])
      .groupBy('status')
      .execute();

    const statusCounts: Record<string, number> = {};
    for (const row of statusRows) {
      statusCounts[row.status] = Number(row.count);
    }

    const [names, supplierNames] = await this.getRefNameMaps();
    return { total, list: rows.map((row) => this.mapRow(row, names, supplierNames)), statusCounts };
  }

  public async getIpqcOverviewStats(): Promise<{
    blanking: { total: number; pending: number; inspecting: number; passed: number; failed: number; passRate: number };
    rolling: { total: number; pending: number; inspecting: number; passed: number; failed: number; passRate: number };
    finished: { total: number; pending: number; inspecting: number; passed: number; failed: number; passRate: number };
    summary: { total: number; pending: number; inspecting: number; passed: number; failed: number; passRate: number };
    timestamp: string;
  }> {
    const rows = await this.db
      .selectFrom("inspectionOrders")
      .select(["orderType", "status", (eb) => eb.fn.countAll().as("count")])
      .where("orderType", "in", ["IPQC_CT", "IPQC_RL", "IPQC_FN"])
      .groupBy(["orderType", "status"])
      .execute();

    const calcGroup = (type: string) => {
      const typeRows = rows.filter((r) => r.orderType === type);
      let pending = 0;
      let inspecting = 0;
      let passed = 0;
      let failed = 0;
      let total = 0;
      for (const r of typeRows) {
        const cnt = Number(r.count);
        total += cnt;
        const st = String(r.status);
        if (st === "PENDING" || st === "DRAFT") pending += cnt;
        else if (st === "INSPECTING" || st === "RE_INSPECTING") inspecting += cnt;
        else if (st === "PASSED" || st === "COMPLETED") passed += cnt;
        else if (st === "FAILED" || st === "IN_MRB_REVIEW") failed += cnt;
      }
      const decided = passed + failed;
      const passRate = decided > 0 ? Math.round((passed / decided) * 100) : 100;
      return { total, pending, inspecting, passed, failed, passRate };
    };

    const blanking = calcGroup("IPQC_CT");
    const rolling = calcGroup("IPQC_RL");
    const finished = calcGroup("IPQC_FN");

    const totalPassed = blanking.passed + rolling.passed + finished.passed;
    const totalFailed = blanking.failed + rolling.failed + finished.failed;
    const totalDecided = totalPassed + totalFailed;

    const summary = {
      total: blanking.total + rolling.total + finished.total,
      pending: blanking.pending + rolling.pending + finished.pending,
      inspecting: blanking.inspecting + rolling.inspecting + finished.inspecting,
      passed: totalPassed,
      failed: totalFailed,
      passRate: totalDecided > 0 ? Math.round((totalPassed / totalDecided) * 100) : 100,
    };

    return {
      blanking,
      rolling,
      finished,
      summary,
      timestamp: new Date().toISOString(),
    };
  }

  public async listInspectorFacets(): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.db
      .selectFrom('inspectionOrders')
      .select(['inspectorId', 'inspectorName'])
      .distinct()
      .where('inspectorId', 'is not', null)
      .execute();
    return rows
      .filter((r) => Boolean(r.inspectorId))
      .map((r) => ({
        id: r.inspectorId as string,
        name: (r.inspectorName as string) || (r.inspectorId as string),
      }));
  }

  

  public async findAll(): Promise<InspectionOrder[]> {
    const rows = await this.db.selectFrom('inspectionOrders').selectAll().execute();
    const [names, supplierNames] = await this.getRefNameMaps();
    return rows.map((r) => this.mapRow(r, names, supplierNames));
  }

  public async updateStatsAndVerdict(
    id: string,
    data: { passQty?: number; failQty?: number; judgment?: string; completedAt?: Date; inspectionNotes?: string }
  ): Promise<void> {
    const values: any = { updatedAt: new Date() };
    if (data.passQty !== undefined) values.passQty = data.passQty;
    if (data.failQty !== undefined) values.failQty = data.failQty;
    if (data.judgment !== undefined) values.judgment = data.judgment;
    if (data.completedAt !== undefined) values.completedAt = data.completedAt;
    if (data.inspectionNotes !== undefined) values.inspectionNotes = data.inspectionNotes;

    await this.db.updateTable("inspectionOrders").set(values).where("id", "=", id).execute();
  }

  /**
   * 质量负责人签核（docs/35 §5）：写入**真实签核动作**的产物 —— 签核人 id / 姓名 / 时间。
   *
   * - 签核人由调用方从会话取（`operatorOf(request)`），不接受请求体自称的签核人；
   * - 重复签核覆盖为最后一次（同一动作的更正），但 `approved_at` 始终是最新一次；
   * - 签核意见**不写这里**：检验单备注记的是检验过程，签核意见进审计日志（append-only），
   *   两个渠道互不覆盖（见 controllers/inspections.controller.ts 的 approve 路由）。
   */
  public async recordApproval(
    id: string,
    approval: { approverId?: string; approverName?: string }
  ): Promise<void> {
    const now = new Date();

    await this.db
      .updateTable('inspectionOrders')
      .set({
        ...(approval.approverId !== undefined ? { approverId: approval.approverId } : {}),
        ...(approval.approverName !== undefined ? { approverName: approval.approverName } : {}),
        approvedAt: now,
        updatedAt: now,
      })
      .where('id', '=', id)
      .execute();
  }
  public async updateStatus(id: string, status: string, remark?: string): Promise<void> {
    const targetStatus = toInspectionStatus(status);

    const now = new Date();

    // remark 浠呯敤浜庤ˉ榻?澶囨敞浠嶄负绌?鐨勫伐鍗曪細WHERE inspection_notes IS NULL 淇濊瘉
    // 浠讳綍宸插瓨鍦ㄧ殑澶囨敞閮戒笉浼氳杩欐鐘舵€佹祦杞鐩栵紝涔熶笉浼氫负绌哄€煎啓鍏?note銆?
    if (remark !== undefined && remark !== '') {
      await this.db
        .updateTable('inspectionOrders')
        .set({ inspectionNotes: remark, updatedAt: now })
        .where('id', '=', id)
        .where('inspectionNotes', 'is', null)
        .execute();
    }

    const updateValues: InspectionOrderUpdate = { status: targetStatus, updatedAt: now };

    await this.db
      .updateTable('inspectionOrders')
      .set(updateValues)
      .where('id', '=', id)
      .execute();
  }

  /**
   * 检验单号流水号分配（见 @letian/domain 的 inspection-order-number 编号规则）。
   *
   * 在 `inspection_order_no_sequences` 的 (prefix, day_key) 唯一键上做原子 upsert：
   * 首次插入 last_seq=1，后续 `last_seq = last_seq + 1 RETURNING`。
   * 依赖 PostgreSQL 行级锁 + 唯一索引保证并发建单不重号；
   * 调用方处于 UoW 事务内，因此事务回滚时流水号一并回滚（不留空洞、不跳号）。
   */
  public async allocateOrderNoSequence(prefix: string, dayKey: string): Promise<number> {
    const result = await sql`
      INSERT INTO inspection_order_no_sequences (prefix, day_key, last_seq, updated_at)
      VALUES (${prefix}, ${dayKey}, 1, now())
      ON CONFLICT (prefix, day_key)
      DO UPDATE SET last_seq = inspection_order_no_sequences.last_seq + 1,
                    updated_at = now()
      RETURNING last_seq
    `.execute(this.db);

    // 连接层启用了 Kysely CamelCasePlugin，结果集列名会被转成 camelCase（last_seq -> lastSeq）。
    // 这里同时兼容两种形态，避免取号逻辑与连接层插件配置耦合：一旦插件被移除或替换，
    // 取号不会静默变成 NaN 而写出脏单号。
    const row = result.rows[0] as
      | { last_seq?: number | string; lastSeq?: number | string }
      | undefined;
    const raw = row?.last_seq ?? row?.lastSeq;
    if (raw === undefined || raw === null) {
      throw new Error(`ORDER_NO_SEQUENCE_ALLOCATE_FAILED: ${prefix}-${dayKey}`);
    }
    const seq = Number(raw);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new Error(`ORDER_NO_SEQUENCE_INVALID: ${prefix}-${dayKey} -> [${String(raw)}]`);
    }
    return seq;
  }

  private mapRow(
    row: InspectionOrderRow,
    employeeNames?: Map<string, string>,
    supplierNames?: Map<string, string>
  ): InspectionOrder {
    // 「供应商」口径：优先取检验单上的名称快照（建单当时的权威值），
    // 快照为空（历史行 / 只传了编码）时按 supplier_code 回查供应商主数据，
    // 让台账永远展示厂商全称而不是内部编码（SUP-001）。
    const resolvedSupplierName =
      (row as any).supplierName ||
      (row.supplierCode !== null ? supplierNames?.get(row.supplierCode) : undefined);
    return {
      id: row.id,
      orderNo: row.orderNo,
      inspectionType: row.orderType,
      status: row.status,
      materialCode: row.materialCode,
      materialName: row.materialName,
      batchNo: row.batchNo,
      // NUMERIC 鍒楀湪閮ㄥ垎椹卞姩閰嶇疆涓嬩細浠ュ瓧绗︿覆杩斿洖锛岃繖閲岀粺涓€鏀舵暃涓?number
      sampleQty: Number(row.sampleQty),
      passQty: Number(row.passQty),
      failQty: Number(row.failQty),
      isMandatoryGate: row.isMandatoryGate,
      planVersionId: row.planVersionId,
      planSnapshot: row.planSnapshot,
      items: row.items,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      // 鍙┖鍒椾竴寰嬬敤鏉′欢灞曞紑鐪佺暐锛岀粷涓嶅啓鍏?undefined锛坋xactOptionalPropertyTypes 瑕佹眰锛?
      ...(row.supplierCode !== null ? { supplierCode: row.supplierCode } : {}),
      ...(row.customerCode !== null ? { customerCode: row.customerCode } : {}),
      ...(row.inspectorId !== null ? { inspectorId: row.inspectorId } : {}),
      ...(row.judgment !== null ? { overallDecision: row.judgment } : {}),
      ...(row.inspectionNotes !== null ? { inspectionNotes: row.inspectionNotes } : {}),
      ...(row.totalQty !== null && row.totalQty !== undefined ? { totalQty: Number(row.totalQty) } : {}),
      ...((row as any).inboundNo ? { inboundNo: (row as any).inboundNo } : {}),
      ...((row as any).inboundDate ? { inboundDate: ((row as any).inboundDate instanceof Date ? (row as any).inboundDate.toISOString().slice(0, 10) : String((row as any).inboundDate).slice(0, 10)) } : {}),
      ...((row as any).specification || (row as any).spec ? { specification: (row as any).specification || (row as any).spec, spec: (row as any).specification || (row as any).spec } : {}),
      ...((row as any).unit ? { unit: (row as any).unit } : {}),
      ...(resolvedSupplierName ? { supplierName: resolvedSupplierName } : {}),
      // inspector_name 为冗余快照列，历史上可能为空：按员工主数据（id -> 姓名）补齐
      ...((row as any).inspectorName
        ? { inspectorName: (row as any).inspectorName }
        : row.inspectorId && employeeNames?.has(row.inspectorId)
          ? { inspectorName: employeeNames.get(row.inspectorId) as string }
          : {}),
      ...((row as any).workOrderNo ? { workOrderNo: (row as any).workOrderNo } : (row.batchNo ? { workOrderNo: row.batchNo } : {})),
      ...((row as any).blankingLength !== null && (row as any).blankingLength !== undefined ? { blankingLength: Number((row as any).blankingLength) } : {}),
      ...((row as any).operatorName ? { operatorName: (row as any).operatorName } : {}),
      ...((row as any).operatorId ? { operatorId: (row as any).operatorId } : {}),
      ...((row as any).equipmentCode ? { equipmentCode: (row as any).equipmentCode } : {}),
      ...((row as any).equipmentName ? { equipmentName: (row as any).equipmentName } : {}),
      ...((row as any).threadSpec ? { threadSpec: (row as any).threadSpec } : {}),
      ...((row as any).inspectionTeam ? { inspectionTeam: (row as any).inspectionTeam } : {}),
      ...((row as any).processStep ? { processStep: (row as any).processStep } : {}),
      ...((row as any).completedAt ? { completedAt: (row as any).completedAt instanceof Date ? (row as any).completedAt.toISOString() : String((row as any).completedAt) } : {}),
      ...((row as any).salesOrderNo ? { salesOrderNo: (row as any).salesOrderNo } : {}),
      ...((row as any).dispatchDate ? { dispatchDate: (row as any).dispatchDate instanceof Date ? (row as any).dispatchDate.toISOString().slice(0, 10) : String((row as any).dispatchDate).slice(0, 10) } : {}),
      ...((row as any).customerName ? { customerName: (row as any).customerName } : {}),
      ...((row as any).salesOrderPoNo ? { salesOrderPoNo: (row as any).salesOrderPoNo } : {}),
      ...((row as any).erpStatus ? { erpStatus: (row as any).erpStatus } : {}),
      // 009 委外检验 (OQC 七分类) 台账字段。委外加工单号 / 回厂日期**只取物理列**：
      // 列为空即不输出该键，界面按 `-` 渲染。历史上这里用 batch_no 顶替委外加工单号、
      // 用 created_at 顶替回厂日期，属「推导值冒充真实字段」——已被 docs/09 §2.4 与
      // scripts/testing/README.md 的断言口径明令禁止（见 docs/32 §2）。
      ...((row as any).outsourceNo ? { outsourceNo: (row as any).outsourceNo } : {}),
      ...((row as any).processType ? { processType: (row as any).processType } : {}),
      ...((row as any).returnDate
        ? { returnDate: String((row as any).returnDate).slice(0, 10) }
        : {}),
      ...((row as any).vendorName
        ? { vendorName: (row as any).vendorName }
        : resolvedSupplierName
          ? { vendorName: resolvedSupplierName }
          : {}),
      // 029 质量负责人签核（docs/35 §5）：只输出物理列的真实值；未签核即不输出该键，
      // 制造证书 / 质量证书据此留白，绝不用「签核人」这类键冒充已发生的签核动作。
      ...((row as any).approverId ? { approverId: (row as any).approverId } : {}),
      ...((row as any).approverName ? { approverName: (row as any).approverName } : {}),
      ...((row as any).approvedAt
        ? {
            approvedAt:
              (row as any).approvedAt instanceof Date
                ? (row as any).approvedAt.toISOString()
                : String((row as any).approvedAt),
          }
        : {}),    };
  }
}
