/**
 * ERP 回写（管家婆 SQL Server）—— 把 QMS 检验结果写回 ERP 的「采购送检单(146) / 采购检验单(147)」。
 *
 * ⚠️ 安全模型（与 erp-readonly.ts 互补）：
 *   - 此前 QMS 对 ERP 是**单向只读**（queryErpReadOnly 守门 + 运维 db_datareader）。
 *   - 本模块是**唯一的 ERP 写路径**，默认 `dryRun = true`：在事务内执行 INSERT 后 **ROLLBACK**，
 *     既验证 SQL 正确性（把所有 NOT NULL 列、自增读回、编号生成、单据关联都跑一遍），又不留任何痕迹。
 *   - 只有显式 `dryRun = false` 才会真正 COMMIT —— 这一步必须由人工明确确认（账号是 ERP 的 db_owner，无 DB 层保险）。
 *
 * 实测核对结论（probe，2026-10-10，账户为 ERP db_owner）：
 *   - 表：DlyNdxCheck（索引/表头，含 Vchcode identity） + DlyCheck（明细，58 列）。
 *   - 单据类型：146=采购送检单(numberhead SJ)，147=采购检验单(numberhead JHJY)；两张表的 cNdx/cDly 都指向它们。
 *   - NUMBER 规则：`{numberhead}-{YYYY-MM-DD}-{5位序号}`，序号按 单据类型+日期 取 MAX+1。
 * 口径订正（2026-10-10，依据《(管家婆财贸事业部)主要数据结构》+ 真实库抽样 vchcode 9595~9628）：
 *   - 146 采购送检单明细：Qty=送检数、Qty2=0、Qty3=0、ToQty=送检数、ToQty2=0、Mode=来源采购订单号(如 JD-2024-11-21-00002)。
 *   - 147 采购检验单明细：Qty=合格数、Qty2=验货数、Qty3=不合格数、ToQty=0、ToQty2=0、Mode=检验/接收类型(如 全检)。
 *   - 关联：送检单明细 SourceVchtype=150(采购订单)+SourceVchcode=订单 Vchcode；
 *     检验单明细 SourceVchtype=146、SourceVchcode=对应送检单 Vchcode。
 *   - 会计期间：T_GBL_MonthProc 已建到 203312，且 2023~2026 全部 isjxc=0（未月末结账）→
 *     period 按 docDate 取 YYYYMM 即可，不存在「2026 未开账」。
 *   - 大量未文档化但 NOT NULL 的列必须给安全默认值，否则 INSERT 直接失败（见 detailColumns / headerColumns）。
 */
import sql from 'mssql';

/** 单据类型（来自 T_GBL_Vchtype 实测） */
export const ERP_VCHTYPE = {
  /** 采购送检单 */
  SUBMIT: 146,
  /** 采购检验单 */
  INSPECT: 147,
  /** 采购订单（送检单的来源单据类型） */
  PURCHASE_ORDER: 150,
} as const;

/** 回写状态（Draft 列）—— 由调用方决定 */
export type ErpDraftStatus = 1 | 2 | 4; // 1=草稿 2=过账 4=待审核

/** 一行检验明细（映射到 DlyCheck 一行） */
export interface ErpCheckDetailInput {
  /** ERP 存货 typeId（Ptype.typeId，如 000010000801701）—— 必须能映射到 QMS 物料 */
  ptypeId: string;
  /** 合格数 */
  qualifiedQty: number;
  /** 验货数 */
  inspectedQty: number;
  /** 不合格数 */
  rejectedQty: number;
  /**
   * 送检数（146 采购送检单的 Qty / ToQty）。
   * 不传则取 inspectedQty（真实库全检场景下两者相等，如 146 Qty=100 / 147 Qty2=100）。
   */
  submittedQty?: number;
  /** 不合格原因（QMReason） */
  rejectReason?: string;
  /** 批号（Blockno） */
  batchNo?: string;
  /** 仓库 typeId（KtypeID） */
  ktypeId?: string;
  /** 行号（RowNo），缺省按明细顺序 1..n */
  rowNo?: number;
}

/** 一次回写的完整输入（一张送检单 + 一张检验单，共用同一批物料明细） */
export interface ErpWriteBackInput {
  /** 单据日期 YYYY-MM-DD（同时决定 NUMBER 里的日期段与 period 推导基准） */
  docDate: string;
  /** 供应商 ERP typeId（Btype.typeId，如 0019900001） */
  btypeId: string;
  /** 制单员/检验员 ERP typeId（Employee.typeId） */
  etypeId: string;
  /** 部门 ERP typeId（Department.typeId，作成本中心代理；可空） */
  projectId?: string;
  /** 制单人全名（InputNo） */
  inputName: string;
  /** 摘要（Summary） */
  summary: string;
  /**
   * 明细。
   * 146 送检单只取「送检数」(submittedQty ?? inspectedQty)，合格/不合格一律 0；
   * 147 检验单按 合格/验货/不合格 语义填写。
   */
  details: ErpCheckDetailInput[];
  /** 来源采购订单 Vchcode（可选）：送检单 SourceVchtype=150 + SourceVchcode=该值 */
  sourcePoVchcode?: number;
  /** 来源采购订单号（可选，如 JD-2024-11-21-00002）：送检单明细 Mode 列，真实库如此 */
  sourcePoNumber?: string;
  /** 来源单号兜底（无采购订单时，如 QMS 检验单号）：送检单明细 Mode 列兜底，避免退化为「全检」 */
  sourceOrderNo?: string;
}

export interface ErpWriteBackOptions {
  /** true（默认）= 事务内 INSERT 后 ROLLBACK，仅验证、不落库；false = 真正 COMMIT */
  dryRun?: boolean;
  /** Draft 状态，默认 1（草稿，最安全，不触碰库存/财务） */
  draftStatus?: ErpDraftStatus;
  /** 会计期间 YYYYMM；不传则按 docDate 推导 */
  period?: number;
  /** 明细行 Mode 默认值 */
  defaultMode?: string;
}

export interface ErpWriteBackResult {
  dryRun: boolean;
  submittedNumber: string;
  inspectedNumber: string;
  submittedVchcode: number;
  inspectedVchcode: number;
  detailRows: number;
  note: string;
}

/** 取某单据类型+日期的下一个编号：numberhead + 日期 + 5位序号(当日 MAX+1) */
async function nextCheckNumber(pool: sql.ConnectionPool, vchType: number, docDate: string): Promise<string> {
  const headReq = await pool.request().input('vt', sql.Int, vchType).query<{ numberhead: string }>(
    `SELECT TOP 1 numberhead FROM T_GBL_Vchtype WHERE vchtype = @vt`,
  );
  const head = (headReq.recordset[0]?.numberhead || (vchType === ERP_VCHTYPE.INSPECT ? 'JHJY' : 'SJ')).trim();
  const maxReq = await pool.request()
    .input('vt', sql.Int, vchType)
    .input('d', sql.NVarChar(10), docDate)
    .input('pat', sql.NVarChar(60), `${head}-${docDate}-%`)
    .query<{ m: number | null }>(
      `SELECT MAX(TRY_CAST(RIGHT(NUMBER, 5) AS int)) AS m
         FROM DlyNdxCheck WHERE VchType = @vt AND DATE = @d AND NUMBER LIKE @pat`,
    );
  const maxSeq = maxReq.recordset[0]?.m ?? 0;
  return `${head}-${docDate}-${String(maxSeq + 1).padStart(5, '0')}`;
}

/** 构造 DlyNdxCheck 表头 INSERT（含未文档化但 NOT NULL 的安全默认值） */
function headerColumns(
  vchType: number, date: string, number: string, btypeId: string, etypeId: string,
  projectId: string, inputName: string, summary: string, draft: ErpDraftStatus, period: number,
): { names: string; values: string } {
  const esc = (s: string) => s.replace(/'/g, "''");
  const names = [
    'VchType', 'DATE', 'NUMBER', 'Summary', 'Btypeid', 'Etypeid',
    'ProjectID', 'InputNo', 'OrderOver', 'period', 'UserDefined01', 'Draft',
  ];
  const values = [
    String(vchType), `'${date}'`, `'${esc(number)}'`, `'${esc(summary)}'`,
    `'${btypeId}'`, `'${etypeId}'`, `'${projectId}'`, `'${esc(inputName)}'`,
    '0', String(period), `''`, String(draft),
  ];
  return { names: names.join(', '), values: values.join(', ') };
}

/** 构造 DlyCheck 明细 INSERT（含大量 NOT NULL 安全默认值；Qty/Qty2/Qty3 按文档语义填） */
function detailColumns(
  vchType: number, vchcode: number, date: string, d: ErpCheckDetailInput, rowNo: number,
  period: number, draft: ErpDraftStatus, sourceVchcode: number, sourceVchtype: number, mode: string,
  btypeId: string, etypeId: string, projectId: string, poNumber = '', sourceOrderNo = '',
): { names: string; values: string } {
  const esc = (s: string) => s.replace(/'/g, "''");

  // 数量语义按单据类型分流（依据真实库抽样，见文件头注释）
  const isSubmit = vchType === ERP_VCHTYPE.SUBMIT;
  const submittedQty = d.submittedQty ?? d.inspectedQty;
  const qty = isSubmit ? submittedQty : d.qualifiedQty;
  const qty2 = isSubmit ? 0 : d.inspectedQty;
  const qty3 = isSubmit ? 0 : d.rejectedQty;
  const toQty = isSubmit ? submittedQty : 0;
  const toQty2 = 0;
  // 146 的 Mode 存来源单据号（采购订单号优先，无则取 QMS 来源单号）；147 的 Mode 存检验/接收类型（如「全检」）
  const modeValue = isSubmit ? (poNumber.trim() !== '' ? poNumber : sourceOrderNo.trim() !== '' ? sourceOrderNo : mode) : mode;
  const names = [
    'RowNo', 'Vchcode', 'Vchtype', 'Date', 'BtypeId', 'PtypeId', 'EtypeId', 'ProjectID',
    'period', 'Mode', 'Qty', 'Qty2', 'Qty3', 'ToQty', 'ToQty2', 'Discount', 'Comment',
    'QMReason', 'Blockno', 'KtypeID', 'FreeDom01', 'FreeDom02', 'FreeDom03', 'FreeDom04',
    'FreeDom05', 'FreeDom06', 'FreeDom07', 'FreeDom08', 'FreeDom09', 'FreeDom10', 'FreeDom11',
    'FreeDom12', 'FreeDom13', 'FreeDom14', 'FreeDom15', 'FreeDom16', 'FreeDomDateDif',
    'SourceDlyorder', 'SourceVchcode', 'SourceVchtype', 'SourceDlyorder2', 'Draft',
  ];
  const empty = `''`;
  const zero = '0';
  const values = [
    String(rowNo), String(vchcode), String(vchType), `'${date}'`,
    `'${btypeId}'`, `'${d.ptypeId}'`, `'${etypeId}'`, `'${projectId}'`,
    String(period), `'${esc(modeValue)}'`,
    String(qty), String(qty2), String(qty3),
    String(toQty), String(toQty2), '1', empty,
    `'${esc(d.rejectReason ?? '')}'`, `'${esc(d.batchNo ?? '')}'`, `'${d.ktypeId ?? ''}'`,
    empty, empty, empty, empty, empty, empty, empty, empty, empty, empty, empty, empty, empty,
    zero, zero, zero, zero,
    zero, String(sourceVchcode), String(sourceVchtype), zero, String(draft),
  ];
  return { names: names.join(', '), values: values.join(', ') };
}

/**
 * 执行一次回写：送检单(146) + 检验单(147)，各自表头 + 明细，检验单明细回指送检单。
 * dryRun=true（默认）时全程在事务内 INSERT 后 ROLLBACK，不落库。
 */
export async function writeBackInspection(
  pool: sql.ConnectionPool,
  input: ErpWriteBackInput,
  options: ErpWriteBackOptions = {},
): Promise<ErpWriteBackResult> {
  const dryRun = options.dryRun !== false;
  const draft: ErpDraftStatus = options.draftStatus ?? 1;
  const period = options.period ?? Number(input.docDate.replace(/-/g, '').slice(0, 6));
  const mode = options.defaultMode ?? '全检';

  if (!input.details.length) throw new Error('[erp-writeback] details 不能为空');

  const submittedNumber = await nextCheckNumber(pool, ERP_VCHTYPE.SUBMIT, input.docDate);
  const inspectedNumber = await nextCheckNumber(pool, ERP_VCHTYPE.INSPECT, input.docDate);
  const projectId = input.projectId ?? '';

  const tran = new sql.Transaction(pool);
  await tran.begin();
  try {
    const req = () => new sql.Request(tran);

    // 1) 送检单表头(146) —— 用 OUTPUT 直接取回自增 Vchcode
    const h1 = headerColumns(ERP_VCHTYPE.SUBMIT, input.docDate, submittedNumber, input.btypeId, input.etypeId, projectId, input.inputName, input.summary, draft, period);
    const out1 = await req().query<{ Vchcode: number }>(`INSERT INTO DlyNdxCheck (${h1.names}) OUTPUT INSERTED.Vchcode VALUES (${h1.values})`);
    const submittedVchcode = out1.recordset[0]!.Vchcode;

    // 2) 检验单表头(147)
    const h2 = headerColumns(ERP_VCHTYPE.INSPECT, input.docDate, inspectedNumber, input.btypeId, input.etypeId, projectId, input.inputName, input.summary, draft, period);
    const out2 = await req().query<{ Vchcode: number }>(`INSERT INTO DlyNdxCheck (${h2.names}) OUTPUT INSERTED.Vchcode VALUES (${h2.values})`);
    const inspectedVchcode = out2.recordset[0]!.Vchcode;

    // 3) 送检单明细(146) —— 只填送检数(Qty/ToQty)，Qty2/Qty3/ToQty2 置 0；Mode=采购订单号；来源指向采购订单(可选)
    let row = 1;
    for (const d of input.details) {
      const cd = detailColumns(ERP_VCHTYPE.SUBMIT, submittedVchcode, input.docDate, d, row, period, draft, input.sourcePoVchcode ?? 0, ERP_VCHTYPE.PURCHASE_ORDER, mode, input.btypeId, input.etypeId, projectId, input.sourcePoNumber ?? '', input.sourceOrderNo ?? '');
      await req().query(`INSERT INTO DlyCheck (${cd.names}) VALUES (${cd.values})`);
      row++;
    }

    // 4) 检验单明细(147) —— 合格/验货/不合格按文档语义；SourceVchcode 回指送检单
    row = 1;
    for (const d of input.details) {
      const cd = detailColumns(ERP_VCHTYPE.INSPECT, inspectedVchcode, input.docDate, d, row, period, draft, submittedVchcode, ERP_VCHTYPE.SUBMIT, mode, input.btypeId, input.etypeId, projectId, '', '');
      await req().query(`INSERT INTO DlyCheck (${cd.names}) VALUES (${cd.values})`);
      row++;
    }

    if (dryRun) {
      await tran.rollback();
    } else {
      await tran.commit();
    }

    return {
      dryRun,
      submittedNumber,
      inspectedNumber,
      submittedVchcode,
      inspectedVchcode,
      detailRows: input.details.length * 2,
      note: dryRun ? 'DRY-RUN：事务已 ROLLBACK，未写入任何数据（仅验证 SQL 正确性）' : '已 COMMIT 写入生产 ERP',
    };
  } catch (err) {
    try { await tran.rollback(); } catch { /* noop */ }
    throw err;
  }
}
