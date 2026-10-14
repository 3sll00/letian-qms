import type { InspectionOrder as InspectionOrderDTO } from '@letian/contracts';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';
import {
  CreateInspectionOrderUseCase,
  type CreateInspectionOrderCommand,
} from '../inspections/create-inspection-order.js';

/**
 * ERP 委外加工单 -> QMS 委外检验单 (OQC_SF / OQC_MACH / OQC_HEAT) 同步用例
 * （委外检验第①段闭环：ERP 读取 -> QMS 建单）。
 *
 * 设计要点（与 IQC 同步用例同构，差异见下）：
 *  - 建单必须走 `CreateInspectionOrderUseCase`（方案快照 / PBAC / 传递门禁 / 审计 / Outbox / 单号流水），
 *    本用例只做"编排"：拉取 ERP 行、按备注关键词分类、映射字段、幂等去重、逐行容错。
 *  - 不依赖基础设施 `ErpReads` 具体实现，只依赖下面的极简端口 `IOutsourceInspectionSource`，
 *    由控制器注入真实 mssql 源或 fixture 源，避免 application 反向依赖 infrastructure。
 *
 * 与 IQC 同步的关键差异——**分类**：
 *  ERP 委外加工单（DlyndxSC, VchType=181）**没有**标准的"表面/机加/热处理"区分字段
 *  （WtypeID、DlySC.ProcessTypeId 均为空，ProduceType 仅 0/1 二态），唯一信号是明细备注
 *  `DlySC.Comment`（偶尔写"发黑"等工艺词，但也混写"急件/紧急"等加急说明）。因此分类只能
 *  按备注关键词识别，识别不出的统一归"表面处理(OQC_SF)"。该规则集中在 `resolveOutsourceType`。
 */

/** ERP 委外加工单行（最小结构，作为端口契约；与基础设施 ErpOutsourceInspectionRow 字段对齐） */
export interface ErpOutsourceInspectionLike {
  vchCode: number;
  /** 委外加工单号（DlyndxSC.Number），空时回落 `WWJG-{vchCode}` */
  number: string;
  date: string;
  /** 物料 ERP 用户编码（Ptype.UserCode）= QMS materialCode */
  ptypeUserCode: string;
  /** 物料 ERP 全名（Ptype.FullName）：主数据缺失时兜底为 materialName */
  ptypeFullName: string;
  /** 物料 ERP 规格型号（Ptype.Standard）：建单时直接作为 specification 快照 */
  ptypeStandard: string;
  /** 委外加工单位 ERP 用户编码（Btype.UserCode）= QMS supplierCode */
  btypeUserCode: string;
  /** 委外加工单位全名（Btype.FullName）= QMS vendor_name 快照；fixture/旧实现可省略 */
  btypeFullName?: string;
  qty: number;
  qty2: number;
  blockNo: string;
  /** 明细备注（DlySC.Comment）：工艺词 / 加急说明，用于分类识别 */
  detailComment: string;
}

/** 委外检验数据源端口（读侧，单向）：由 ERP mssql 实现或本地 fixture 实现注入 */
export interface IOutsourceInspectionSource {
  fetchOutsourceInspections(limit: number): Promise<ErpOutsourceInspectionLike[]>;
}

export interface SyncErpOutsourceInspectionsInput {
  source: IOutsourceInspectionSource;
  limit?: number;
  /** 操作人（审计/建单归属）；缺省用用例构造时注入的系统账号 */
  operator?: { operatorId: string; operatorName: string };
}

export interface SyncErpOutsourceInspectionsResult {
  total: number;
  created: number;
  skipped: number;
  failed: number;
  /** 按分类统计的新建数（调试/对账用） */
  createdByType: Record<string, number>;
  createdOrders: InspectionOrderDTO[];
  skippedErpNumbers: string[];
  failures: { erpNumber: string; reason: string }[];
}

/** 系统默认操作人：ERP 自动同步服务（前端/脚本未指定操作人时使用）
 * 与 sync-erp-incoming-inspections 同常量，此处不重复导出，避免 barrel `export *` 撞名(TS2308)。 */
const ERP_SYNC_SYSTEM_OPERATOR = {
  operatorId: 'SYS-ERP-SYNC',
  operatorName: 'ERP同步服务',
} as const;

/**
 * 按明细备注关键词把委外加工单行归类到 OQC 三类之一。
 *
 * ERP 无标准分类字段，只能从 `DlySC.Comment` 的工艺词识别；识别不出统一归 OQC_SF（表面处理）。
 * 优先级：热处理 > 机加工 > 表面处理（避免"热处理加工"被误判为机加工）。
 */
const HEAT_KEYWORDS = ['热处理', '淬火', '回火', '退火', '正火', '渗碳', '氮化', '调质', '时效', '高频', '中频'];
const MACH_KEYWORDS = ['机加工', '机加', '车削', '铣削', '数控', 'cnc', '精加工', '切削', '打磨', '加工中心'];
const SF_KEYWORDS = [
  '发黑', '镀锌', '镀镍', '磷化', '达克罗', '电镀', '喷塑', '喷涂', '阳极氧化',
  '钝化', '表面处理', '电泳', '喷漆', '烤漆', '氧化', '抛光', '拉丝',
];

export function resolveOutsourceType(remark: string): 'OQC_SF' | 'OQC_MACH' | 'OQC_HEAT' {
  const r = (remark ?? '').toLowerCase();
  if (HEAT_KEYWORDS.some((k) => r.includes(k.toLowerCase()))) return 'OQC_HEAT';
  if (MACH_KEYWORDS.some((k) => r.includes(k.toLowerCase()))) return 'OQC_MACH';
  if (SF_KEYWORDS.some((k) => r.includes(k.toLowerCase()))) return 'OQC_SF';
  return 'OQC_SF';
}

/**
 * 从明细备注中取出**命中的工艺词本身**，作为 `inspection_orders.process_type` 的写入值
 * （台账「加工类型」列目前唯一的自动来源）。
 *
 * 与 `resolveOutsourceType` 同一优先级（热处理 > 机加工 > 表面处理）：
 * 一条备注同时含多类词时，返回与分类结论同族的词，避免「分到热处理单、加工类型却写镀锌」。
 *
 * 未命中返回 `undefined` —— 备注里写的是「急件 / 客户名 / 补做加工单」这类非工艺内容时
 * 一律不落值（process_type 保持 NULL，不编造），界面台账仍显示 `-`。
 */
export function resolveOutsourceProcessType(remark: string): string | undefined {
  const r = (remark ?? '').toLowerCase();
  return (
    HEAT_KEYWORDS.find((k) => r.includes(k.toLowerCase())) ??
    MACH_KEYWORDS.find((k) => r.includes(k.toLowerCase())) ??
    SF_KEYWORDS.find((k) => r.includes(k.toLowerCase()))
  );
}

function mapRowToCommand(
  row: ErpOutsourceInspectionLike,
  erpNumber: string,
  inspectionType: 'OQC_SF' | 'OQC_MACH' | 'OQC_HEAT',
  operator: { operatorId: string; operatorName: string }
): { command: CreateInspectionOrderCommand } {
  const batchNo = row.blockNo && row.blockNo.trim() ? row.blockNo.trim() : `B-${erpNumber}`;
  const batchQty = Math.max(row.qty, row.qty2) > 0 ? Math.max(row.qty, row.qty2) : 1;

  const command: CreateInspectionOrderCommand = {
    inspectionType,
    materialCode: row.ptypeUserCode,
    batchNo,
    batchQty,
    orderNo: erpNumber,
    operatorId: operator.operatorId,
    operatorName: operator.operatorName,
  };
  // ERP 名称兜底：委外物料很多未同步进 QMS 主数据，缺 materialName 会直接建单失败；
  // 显式传入 ERP 存货全名（Ptype.FullName）即可绕开主数据缺失，与 IQC 同步口径一致。
  if (row.ptypeFullName) command.materialName = row.ptypeFullName;
  // 规格同样直接取 ERP（Ptype.Standard），与名称同口径：不依赖 QMS materials.spec_model。
  // 只出现在委外加工单的物料从未进过主数据（sync-master-data 只 JOIN DlyCheck），
  // 依赖主数据兜底会让这批物料的规格恒为空，台账与证书【规格尺寸】两处都跟着丢。
  if (row.ptypeStandard) command.specification = row.ptypeStandard;
  // 委外加工单号：ERP 单号原样镜像（与 inspection_orders.outsource_no 口径一致，见 docs/35 §2）
  if (row.number) command.outsourceNo = row.number;
  if (row.btypeUserCode) command.supplierCode = row.btypeUserCode;
  // 加工商名称快照（vendor_name）：台账列优先取它，其次回落 supplier_name；
  // ERP 行带 Btype.FullName 时一并落库，与 supplier_code 同一行取数、不会错配
  if (row.btypeFullName) command.vendorName = row.btypeFullName;
  // 加工类型（process_type）：只落备注里真实命中的工艺词；未命中不落值、不编造
  const processType = resolveOutsourceProcessType(row.detailComment);
  if (processType) command.processType = processType;
  if (row.number) command.inboundNo = row.number;
  if (row.date) command.inboundDate = row.date;

  return { command };
}

/** ERP 单据基准号：优先用委外加工单号，缺失时按 VchCode 兜底（WWJG- 前缀，与既有口径一致） */
function baseKeyOf(row: ErpOutsourceInspectionLike): string {
  return row.number && row.number.trim() ? row.number.trim() : `WWJG-${row.vchCode}`;
}

export class SyncErpOutsourceInspectionsUseCase {
  constructor(
    private readonly uow: IUnitOfWork,
    private readonly creator: CreateInspectionOrderUseCase,
    private readonly defaultOperator: { operatorId: string; operatorName: string } = ERP_SYNC_SYSTEM_OPERATOR
  ) {}

  public async execute(
    input: SyncErpOutsourceInspectionsInput
  ): Promise<SyncErpOutsourceInspectionsResult> {
    const operator = input.operator ?? this.defaultOperator;
    const rows = await input.source.fetchOutsourceInspections(input.limit ?? 500);

    const createdOrders: InspectionOrderDTO[] = [];
    const skippedErpNumbers: string[] = [];
    const failures: { erpNumber: string; reason: string }[] = [];
    const createdByType: Record<string, number> = { OQC_SF: 0, OQC_MACH: 0, OQC_HEAT: 0 };

    // 0. 预分组：统计每个 ERP 委外单号下有几行明细（DlySC 一行一个物料），
    //    据此决定单号是否需要按物料拆分（与 IQC 同构：20 个物料 -> 20 张 QMS 单）。
    const lineCountByDoc = new Map<string, number>();
    for (const row of rows) {
      const base = baseKeyOf(row);
      lineCountByDoc.set(base, (lineCountByDoc.get(base) ?? 0) + 1);
    }
    const usedKeys = new Set<string>();

    for (const row of rows) {
      const base = baseKeyOf(row);
      const multiLine = (lineCountByDoc.get(base) ?? 0) > 1;
      // 多物料单据：单号追加 #物料编码；同单据同物料重复行再追加序号，保证唯一且可重放
      const candidate = multiLine ? `${base}#${row.ptypeUserCode || 'NOMAT'}` : base;
      let erpNumber = candidate;
      let seq = 2;
      while (usedKeys.has(erpNumber)) {
        erpNumber = `${candidate}-${seq}`;
        seq += 1;
      }
      usedKeys.add(erpNumber);

      // 分类：按明细备注关键词决定 OQC 类型（默认 OQC_SF）
      const inspectionType = resolveOutsourceType(row.detailComment);
      const { command } = mapRowToCommand(row, erpNumber, inspectionType, operator);

      // 1. 幂等去重：QMS 已存在相同单号（orderNo）则跳过，不重复建单
      const existing = await this.uow.execute((ctx) =>
        ctx.inspectionOrders.findByOrderNo(erpNumber)
      );
      if (existing) {
        skippedErpNumbers.push(erpNumber);
        continue;
      }

      // 2. 物料编码缺失（ERP 行未带 UserCode）：无法映射为 QMS 物料，直接记失败
      if (!command.materialCode) {
        failures.push({
          erpNumber,
          reason: 'ERP 委外加工单行缺少物料 UserCode，无法映射为 QMS 物料编码',
        });
        continue;
      }

      // 3. 调用领域建单用例（方案快照 / PBAC / 传递门禁 / 审计 / Outbox 全部生效）；逐行容错
      try {
        const order = await this.creator.execute(command);
        createdOrders.push(order);
        createdByType[inspectionType] = (createdByType[inspectionType] ?? 0) + 1;
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        failures.push({ erpNumber, reason });
      }
    }

    return {
      total: rows.length,
      created: createdOrders.length,
      skipped: skippedErpNumbers.length,
      failed: failures.length,
      createdByType,
      createdOrders,
      skippedErpNumbers,
      failures,
    };
  }
}
