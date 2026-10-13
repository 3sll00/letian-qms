import type { InspectionOrder as InspectionOrderDTO } from '@letian/contracts';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';
import {
  CreateInspectionOrderUseCase,
  type CreateInspectionOrderCommand,
} from '../inspections/create-inspection-order.js';

/**
 * ERP 销售出库 -> QMS 出货检验单 (OQC_SH) 同步用例（出货检验数据来源第①段闭环：ERP 读取 -> QMS 建单）。
 *
 * 为什么单独成用例：建单必须用 `CreateInspectionOrderUseCase`（负责方案快照深拷贝、PBAC、
 * 传递门禁、审计、Outbox、单号流水），绝不能绕过它直接写表。本用例只做"编排"——
 * 拉取 ERP 销售出库、映射字段、幂等去重、逐行容错，真正的建单交给领域用例。
 *
 * 分层约束：本用例不依赖基础设施的 `ErpReads` 具体实现，只依赖下面这个最小端口
 * `ISalesDispatchSource`（结构性兼容 `ErpReads.fetchSalesDispatch`），由组合根（apps/api 容器 /
 * 控制器）注入真实 mssql 源或本地 fixture 源，避免 application 反向依赖 infrastructure。
 */

/** ERP 销售出库行（最小结构，作为端口契约；与基础设施 ErpSalesDispatchRow 字段对齐） */
export interface ErpSalesDispatchLike {
  vchCode: number;
  /** 销售出库单号（DlyNdx.Number） */
  number: string;
  /** 单据日期（DlySale.date） */
  date: string;
  /** 成品 ERP 用户编码（Ptype.UserCode）= QMS materialCode */
  ptypeUserCode: string;
  /** 成品名称（Ptype.FullName） */
  ptypeFullName: string | null;
  /** 客户名称（Btype.FullName，isclient=1） */
  customerName: string | null;
  /** 出库数量（DlySale.Qty） */
  qty: number;
  /** 批号（DlySale.Blockno） */
  blockNo: string | null;
  /** 生产日期（DlySale.ProduceDate） */
  produceDate: string | null;
  /** 行摘要（DlySale.comment） */
  comment: string | null;
  /** 项目/部门 typeId（DlySale.ProjectID） */
  projectId: string | null;
}

/** 销售出库数据源端口（读侧，单向）：由 ERP mssql 实现或本地 fixture 实现注入 */
export interface ISalesDispatchSource {
  fetchSalesDispatch(limit: number, offset?: number): Promise<ErpSalesDispatchLike[]>;
}

export interface SyncErpSalesDispatchInput {
  source: ISalesDispatchSource;
  limit?: number;
  /** 分页偏移（全量同步分批拉取用；缺省 0） */
  offset?: number;
  /** 操作人（审计/建单归属）；缺省用用例构造时注入的系统账号 */
  operator?: { operatorId: string; operatorName: string };
}

export interface SyncErpSalesDispatchResult {
  /** ERP 拉取到的总行数 */
  total: number;
  /** 成功新建的 QMS 出货检验单数量 */
  created: number;
  /** 因 QMS 已存在同单号（ERP 单号）而跳过的行数 */
  skipped: number;
  /** 建单失败（如物料主数据缺失 / 被传递门禁拦截）的行数 */
  failed: number;
  createdOrders: InspectionOrderDTO[];
  skippedErpNumbers: string[];
  failures: { erpNumber: string; reason: string }[];
}

/** 系统默认操作人：ERP 自动同步服务（前端/脚本未指定操作人时使用） */
export const ERP_SALES_DISPATCH_SYNC_OPERATOR = {
  operatorId: 'SYS-ERP-SYNC',
  operatorName: 'ERP同步服务',
} as const;

/**
 * 把一行 ERP 销售出库映射为 QMS 出货检验 (OQC_SH) 建单命令。
 *
 * 关键映射：
 *  - 成品编码：直接用 ERP 的 UserCode（ptypeUserCode），这是 QMS materials 主数据的权威键。
 *  - 外部单号 orderNo：以 ERP 销售出库单号（number）为基准，既作 QMS 单号也作幂等去重键；
 *    为空时回落为 `ERP-DLYSALE-{vchCode}`；**同一单据含多成品行时**追加 `#{成品编码}` 区分。
 *  - 批次号 batchNo：优先用 ERP 批号（Blockno），缺失时回落为 `B-{单号}`。
 *  - 出货数量 batchQty：取 |DlySale.Qty|（管家婆销售单数量为负，出库方向，取绝对值）；为 0 时回落 1。
 *  - 销售出库台账字段：customerName / salesOrderNo / dispatchDate 直接透传；
 *    erpStatus 暂按"已出库"语义（如需区分 ERP 审核/拦截状态，应在读取层按 DlyNdx.draft 映射）。
 *  - materialName：不传，交由 CreateInspectionOrderUseCase 按 materialCode 从存货档案补齐。
 */
function mapRowToCommand(
  row: ErpSalesDispatchLike,
  erpNumber: string,
  operator: { operatorId: string; operatorName: string }
): { command: CreateInspectionOrderCommand } {
  const batchNo = row.blockNo && row.blockNo.trim() ? row.blockNo.trim() : `B-${erpNumber}`;
  const batchQty = row.qty !== 0 ? Math.abs(row.qty) : 1;

  // exactOptionalPropertyTypes：可选字段只能确有值时赋值，故用条件赋值。
  const command: CreateInspectionOrderCommand = {
    inspectionType: 'OQC_SH',
    materialCode: row.ptypeUserCode,
    batchNo,
    batchQty,
    orderNo: erpNumber,
    operatorId: operator.operatorId,
    operatorName: operator.operatorName,
  };
  // 物料名称：优先用 ERP 行已带出的 Ptype.FullName；QMS materials 表未同步全（ERP 2.4万 vs QMS 5千），
  // 不依赖它也能建单（与 IQC 同步口径一致：缺失时由用例从存货档案补，但此处直接透传更稳）。
  if (row.ptypeFullName) command.materialName = row.ptypeFullName;
  if (row.customerName) command.customerName = row.customerName;
  if (row.number) command.salesOrderNo = row.number;
  if (row.date) command.dispatchDate = row.date;
  if (row.number) command.erpStatus = '已出库';

  return { command };
}

/**
 * ERP 单据基准号：优先用销售出库单号，缺失时按 vchCode 兜底（保证可重放、不丢行）。
 */
function baseKeyOf(row: ErpSalesDispatchLike): string {
  return row.number && row.number.trim() ? row.number.trim() : `ERP-DLYSALE-${row.vchCode}`;
}

export class SyncErpSalesDispatchUseCase {
  constructor(
    private readonly uow: IUnitOfWork,
    private readonly creator: CreateInspectionOrderUseCase,
    private readonly defaultOperator: { operatorId: string; operatorName: string } = ERP_SALES_DISPATCH_SYNC_OPERATOR
  ) {}

  public async execute(
    input: SyncErpSalesDispatchInput
  ): Promise<SyncErpSalesDispatchResult> {
    const operator = input.operator ?? this.defaultOperator;
    const rows = await input.source.fetchSalesDispatch(input.limit ?? 500, input.offset ?? 0);

    const createdOrders: InspectionOrderDTO[] = [];
    const skippedErpNumbers: string[] = [];
    const failures: { erpNumber: string; reason: string }[] = [];

    // 0. 预分组：统计每个 ERP 单据号下有几行（DlySale 一行一个成品），
    //    据此决定单号是否需要按成品拆分，保证"N 个成品出库 -> N 张 QMS 出货检验单"。
    const lineCountByDoc = new Map<string, number>();
    for (const row of rows) {
      const base = baseKeyOf(row);
      lineCountByDoc.set(base, (lineCountByDoc.get(base) ?? 0) + 1);
    }
    const usedKeys = new Set<string>();

    for (const row of rows) {
      const base = baseKeyOf(row);
      const multiLine = (lineCountByDoc.get(base) ?? 0) > 1;
      const candidate = multiLine ? `${base}#${row.ptypeUserCode || 'NOMAT'}` : base;
      let erpNumber = candidate;
      let seq = 2;
      while (usedKeys.has(erpNumber)) {
        erpNumber = `${candidate}-${seq}`;
        seq += 1;
      }
      usedKeys.add(erpNumber);

      const { command } = mapRowToCommand(row, erpNumber, operator);

      // 1. 幂等去重：QMS 已存在相同 ERP 单号（orderNo）则跳过，不重复建单
      const existing = await this.uow.execute((ctx) =>
        ctx.inspectionOrders.findByOrderNo(erpNumber)
      );
      if (existing) {
        skippedErpNumbers.push(erpNumber);
        continue;
      }

      // 2. 成品编码缺失（ERP 行未带 UserCode）：无法映射为 QMS 物料，直接记失败
      if (!command.materialCode) {
        failures.push({
          erpNumber,
          reason: 'ERP 销售出库行缺少成品 UserCode，无法映射为 QMS 物料编码',
        });
        continue;
      }

      // 3. 调用领域建单用例（方案快照 / PBAC / 传递门禁 / 审计 / Outbox 全部生效）；逐行容错
      try {
        const order = await this.creator.execute(command);
        createdOrders.push(order);
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
      createdOrders,
      skippedErpNumbers,
      failures,
    };
  }
}
