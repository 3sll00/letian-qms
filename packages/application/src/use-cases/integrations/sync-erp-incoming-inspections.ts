import type { InspectionOrder as InspectionOrderDTO } from '@letian/contracts';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';
import {
  CreateInspectionOrderUseCase,
  type CreateInspectionOrderCommand,
} from '../inspections/create-inspection-order.js';

/**
 * ERP 来料检验 -> QMS 来料检验单 (IQC) 同步用例（第①段闭环：ERP 读取 -> QMS 建单）。
 *
 * 为什么单独成用例：建单必须用 `CreateInspectionOrderUseCase`（它负责方案快照深拷贝、PBAC、
 * 传递门禁、审计、Outbox、单号流水），绝不能绕过它直接写表。本用例只做"编排"——
 * 拉取 ERP 数据、映射字段、幂等去重、逐行容错，真正的建单交给领域用例。
 *
 * 分层约束：本用例不依赖基础设施的 `ErpReads` 具体实现，只依赖下面这个最小端口
 * `IIncomingInspectionSource`（结构性兼容 `ErpReads.fetchIncomingInspections`），
 * 由组合根（apps/api 容器 / 控制器）注入真实或 fixture 源，避免 application 反向依赖 infrastructure。
 */

/** ERP 来料检验行（最小结构，作为端口契约；与基础设施 ErpIncomingInspectionRow 字段对齐） */
export interface ErpIncomingInspectionLike {
  vchCode: number;
  number: string;
  date: string;
  /** 物料 ERP 用户编码（Ptype.UserCode）= QMS materialCode */
  ptypeUserCode: string;
  /** 供应商 ERP 用户编码（Btype.UserCode）= QMS supplierCode */
  btypeUserCode: string;
  qty: number;
  /** 报检/送检数量：送检单(146)上 qty 常为 0、真实数量落在 qty2，故两者都要看 */
  qty2: number;
  blockNo: string | null;
  qmReason: string | null;
  sourceVchCode: number;
}

/** 来料检验数据源端口（读侧，单向）：由 ERP mssql 实现或本地 fixture 实现注入 */
export interface IIncomingInspectionSource {
  fetchIncomingInspections(limit: number): Promise<ErpIncomingInspectionLike[]>;
}

export interface SyncErpIncomingInspectionsInput {
  source: IIncomingInspectionSource;
  limit?: number;
  /** 操作人（审计/建单归属）；缺省用用例构造时注入的系统账号 */
  operator?: { operatorId: string; operatorName: string };
}

export interface SyncErpIncomingInspectionsResult {
  /** ERP 拉取到的总行数 */
  total: number;
  /** 成功新建的 QMS 来料检验单数量 */
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
export const ERP_SYNC_SYSTEM_OPERATOR = {
  operatorId: 'SYS-ERP-SYNC',
  operatorName: 'ERP同步服务',
} as const;

/**
 * 把一行 ERP 来料检验映射为 QMS 来料检验 (IQC) 建单命令。
 *
 * 关键映射：
 *  - 物料编码 / 供应商编码：直接用 ERP 的 UserCode（ptypeUserCode / btypeUserCode），
 *    这是 QMS materials / suppliers 主数据的权威键（见 sync-master-data.ts 的映射口径）。
 *  - 外部单号 orderNo：以 ERP 送检单号（number）为基准，既作 QMS 单号也作幂等去重键；
 *    为空时回落为 `ERP-DLYCHECK-{vchCode}`；**同一单据含多物料行时**追加 `#{物料编码}`
 *    区分（DlyCheck 一行一个物料，一张单 20 个物料就该生成 20 张 QMS 单）。
 *  - 批次号 batchNo：优先用 ERP 批号（Blockno），缺失时回落为 `B-{单号}`（建单 lock 与台账都要求非空）。
 *  - 报检批量 batchQty：取 max(qty, qty2)。送检单(146)上 qty 常为 0、真实报检数落在 qty2；
 *    检验单(147)上 qty 是合格数、qty2 是报检总数，取大值即报检总数；两者都为 0 时回落 1。
 *  - 入库单号 / 入库日期：透传 ERP 送检单号与日期（006 来料检验对账字段）。
 *  - materialName / specification / unit：不传，交由 CreateInspectionOrderUseCase 按 materialCode 从存货档案补齐；
 *    若主数据缺失则建单抛错，由同步按行记入 failures（提示"先同步 ERP 主数据"）。
 */
function mapRowToCommand(
  row: ErpIncomingInspectionLike,
  erpNumber: string,
  operator: { operatorId: string; operatorName: string }
): { command: CreateInspectionOrderCommand } {
  const batchNo = row.blockNo && row.blockNo.trim() ? row.blockNo.trim() : `B-${erpNumber}`;
  const batchQty = Math.max(row.qty, row.qty2) > 0 ? Math.max(row.qty, row.qty2) : 1;

  // 注意：本仓库开启 exactOptionalPropertyTypes，可选字段不能显式赋 undefined，
  // 只能在确有值时赋值（否则用条件赋值 / 省略），因此下面用条件赋值。
  const command: CreateInspectionOrderCommand = {
    inspectionType: 'IQC',
    materialCode: row.ptypeUserCode,
    batchNo,
    batchQty,
    orderNo: erpNumber,
    operatorId: operator.operatorId,
    operatorName: operator.operatorName,
  };
  if (row.btypeUserCode) command.supplierCode = row.btypeUserCode;
  if (row.number) command.inboundNo = row.number;
  if (row.date) command.inboundDate = row.date;

  return { command };
}

/**
 * ERP 单据基准号：优先用送检单号，缺失时按 vchCode 兜底（保证可重放、不丢行）。
 */
function baseKeyOf(row: ErpIncomingInspectionLike): string {
  return row.number && row.number.trim() ? row.number.trim() : `ERP-DLYCHECK-${row.vchCode}`;
}

export class SyncErpIncomingInspectionsUseCase {
  constructor(
    private readonly uow: IUnitOfWork,
    private readonly creator: CreateInspectionOrderUseCase,
    private readonly defaultOperator: { operatorId: string; operatorName: string } = ERP_SYNC_SYSTEM_OPERATOR
  ) {}

  public async execute(
    input: SyncErpIncomingInspectionsInput
  ): Promise<SyncErpIncomingInspectionsResult> {
    const operator = input.operator ?? this.defaultOperator;
    const rows = await input.source.fetchIncomingInspections(input.limit ?? 500);

    const createdOrders: InspectionOrderDTO[] = [];
    const skippedErpNumbers: string[] = [];
    const failures: { erpNumber: string; reason: string }[] = [];

    // 0. 预分组：统计每个 ERP 单据号下有几行（DlyCheck 一行一个物料），
    //    据此决定单号是否需要按物料拆分，保证"20 个物料送检 -> 20 张 QMS 单"。
    const lineCountByDoc = new Map<string, number>();
    for (const row of rows) {
      const base = baseKeyOf(row);
      lineCountByDoc.set(base, (lineCountByDoc.get(base) ?? 0) + 1);
    }
    const usedKeys = new Set<string>();

    for (const row of rows) {
      const base = baseKeyOf(row);
      const multiLine = (lineCountByDoc.get(base) ?? 0) > 1;
      // 多物料单据：单号追加 #物料编码；同单据同物料的重复行再追加序号，保证唯一且可重放
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

      // 2. 物料编码缺失（ERP 行未带 UserCode）：无法映射为 QMS 物料，直接记失败
      if (!command.materialCode) {
        failures.push({
          erpNumber,
          reason: 'ERP 来料检验行缺少物料 UserCode，无法映射为 QMS 物料编码',
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
