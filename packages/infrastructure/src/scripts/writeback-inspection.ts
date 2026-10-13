/**
 * ERP 回写 CLI（管家婆 采购送检单 146 / 采购检验单 147）
 * ───────────────────────────────────────────────────────────────────────────
 * 把指定 QMS 检验单的检验结果写回 ERP。默认方案（与用户拍板口径一致）：
 *   ① Draft 状态默认 1（草稿，不触碰库存/财务，最安全）
 *   ② 指定单：--order=<id|orderNo>（单条）；或 --since/--until 按检验日期批量
 *   ③ period 按「检验日期(docDate)」推导 YYYYMM（可用 --period 覆盖）
 *   ④ 映射优先查 `qms_erp_code_mapping` 表（迁移 041，可由 `build-code-mapping.ts` 回填），
 *      未命中再回退 erp-reads 按 ERP UserCode 反查，最后才用 --ptype/--btype/--etype 覆盖；
 *      检验员按 ERP Employee 名称命中（无代码链路，可用 --etype 覆盖）
 *
 * 安全模型：
 *   - 默认 dryRun=true：事务内 INSERT 后 ROLLBACK，**不落库**，仅验证 SQL/映射正确性。
 *   - 必须显式 --commit 才真正 COMMIT 写入生产 ERP（账号是 ERP db_owner，不可逆）。
 *   - 建议流程：先 `--order=<单> `（dryRun 默认）核对映射与生成编号 → 确认无误 →
 *    `--order=<单> --commit` 试写 1 条 → 再批量。
 *
 * 运行（Git Bash，直接调 tsx，绕过 pnpm）：
 *   cd D:/乐天/letian-qms
 *   node node_modules/tsx/dist/cli.mjs packages/infrastructure/src/scripts/writeback-inspection.ts \
 *       --order=IQC-2023-001            # 先 dryRun 看映射
 *   node node_modules/tsx/dist/cli.mjs packages/infrastructure/src/scripts/writeback-inspection.ts \
 *       --order=IQC-2023-001 --commit   # 真正写 1 条草稿
 *
 * 清理已落的草稿（仅草稿态、误写/需更正时用，默认 DRY-RUN 预览）：
 *   node node_modules/tsx/dist/cli.mjs packages/infrastructure/src/scripts/writeback-inspection.ts \
 *       --delete-vchcodes=9639,9640          # 先预览将删除的表头(ROLLBACK)
 *   node node_modules/tsx/dist/cli.mjs packages/infrastructure/src/scripts/writeback-inspection.ts \
 *       --delete-vchcodes=9639,9640 --commit  # 真正删除(不可逆)
 *   可同时带 --order=... 在同一 run 内「先删后写」完成更正重写。
 */
import dotenv from 'dotenv';
dotenv.config();
import { db } from '../database/connection.js';
import { closeErpConnectionPool, getErpConnectionPool } from '../adapters/erp-pool.js';
import {
  createMssqlErpReads,
  type ErpMaterialRow,
  type ErpSupplierRow,
} from '../sync/erp-reads.js';
import {
  queryErpReadOnly,
  type ErpQueryParam,
  type ErpQueryRunner,
} from '../sync/erp-readonly.js';
import {
  writeBackInspection,
  type ErpCheckDetailInput,
  type ErpDraftStatus,
  type ErpWriteBackInput,
} from '../sync/erp-writeback.js';
import { resolveErpTypeId } from '../sync/code-mapping.js';
import sql from 'mssql';
/* ------------------------------- CLI 参数 ------------------------------- */

interface CliArgs {
  order: string | null;
  since: string | null;
  until: string | null;
  commit: boolean;
  draft: ErpDraftStatus;
  date: string | null;
  period: number | null;
  mode: string;
  limit: number;
  // 映射覆盖（ERP typeId），任一命中失败又不想改数据时用
  ptype: string | null;
  btype: string | null;
  etype: string | null;
  ktype: string | null;
  project: string | null;
  /** 来源采购订单号（写进 146 明细 Mode，真实库口径），如 JD-2024-11-21-00002 */
  poNumber: string | null;
  /** 来源采购订单 Vchcode（写进 146 明细 SourceVchcode，SourceVchtype=150） */
  poVchcode: number | null;
  // 删除指定 Vchcode 的草稿（仅 DRAFT 态更正用；默认 DRY-RUN 预览）
  deleteVchcodes: number[] | null;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const read = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? null : hit.slice(name.length + 3);
  };
  const draftRaw = Number(read('draft'));
  const periodRaw = Number(read('period'));
  const limitRaw = Number(read('limit'));
  return {
    order: read('order'),
    since: read('since'),
    until: read('until'),
    commit: argv.includes('--commit'),
    draft: draftRaw === 2 || draftRaw === 4 ? (draftRaw as ErpDraftStatus) : 1,
    date: read('date'),
    period: Number.isFinite(periodRaw) && periodRaw > 0 ? Math.floor(periodRaw) : null,
    mode: read('mode') ?? '全检',
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50,
    ptype: read('ptype'),
    btype: read('btype'),
    etype: read('etype'),
    ktype: read('ktype'),
    project: read('project'),
    poNumber: read('po-number'),
    poVchcode: (() => {
      const n = Number(read('po-vchcode'));
      return Number.isInteger(n) && n > 0 ? n : null;
    })(),
    deleteVchcodes: (() => {
      const raw = read('delete-vchcodes');
      if (!raw) return null;
      const nums = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
      return nums.length ? nums : null;
    })(),
  };
}

/* ------------------------------- 工具函数 ------------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function toYmd(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

interface OrderRow {
  id: string;
  orderNo: string;
  orderType: string;
  batchNo: string | null;
  materialCode: string;
  materialName: string | null;
  supplierCode: string | null;
  supplierName: string | null;
  inspectorName: string | null;
  passQty: number | null;
  failQty: number | null;
  sampleQty: number | null;
  totalQty: number | null;
  inspectionNotes: string | null;
  inboundDate: Date | null;
  inspectedDate: string | null;
  completedAt: Date | null;
  createdAt: Date | null;
}

/** 检验日期优先级：inspectedDate(显式检验日期) → completedAt → inboundDate → createdAt */
function deriveDocDate(o: OrderRow, override: string | null): { date: string; source: string } {
  if (override) {
    if (!YMD_RE.test(override)) throw new Error(`--date 格式必须是 YYYY-MM-DD：${override}`);
    return { date: override, source: '--date 覆盖' };
  }
  const candidates: [string, string | null][] = [
    ['inspectedDate', o.inspectedDate && YMD_RE.test(o.inspectedDate) ? o.inspectedDate : null],
    ['completedAt', toYmd(o.completedAt)],
    ['inboundDate', toYmd(o.inboundDate)],
    ['createdAt', toYmd(o.createdAt)],
  ];
  for (const [src, val] of candidates) {
    if (val) return { date: val, source: src };
  }
  throw new Error(`检验单 ${o.orderNo} 无任何可用日期，请用 --date 显式指定`);
}

/**
 * 删除指定 Vchcode 的 ERP 草稿（表头 DlyNdxCheck + 明细 DlyCheck）。
 * ⚠️ 危险操作：仅在草稿(Draft)态、且确属误写/需更正时使用。
 *   - dryRun（默认）= 事务内 DELETE 后 ROLLBACK，先预览将要删除的行、不落库；
 *   - --commit = 真正删除（不可逆，必须由人工明确确认）。
 */
async function deleteDrafts(pool: sql.ConnectionPool, vchcodes: number[], commit: boolean): Promise<void> {
  const inList = vchcodes.join(', ');
  const preview = await pool.request().query<{ VchType: number; NUMBER: string; Vchcode: number; Draft: number; period: number }>(
    `SELECT VchType, NUMBER, Vchcode, Draft, period FROM DlyNdxCheck WHERE Vchcode IN (${inList}) ORDER BY VchType`,
  );
  console.log(`[delete] 预览将删除表头 ${preview.recordset.length} 行：`, JSON.stringify(preview.recordset));
  if (!preview.recordset.length) {
    console.log('[delete] 未匹配到任何表头，无需删除');
    return;
  }
  const tran = new sql.Transaction(pool);
  await tran.begin();
  try {
    const req = new sql.Request(tran);
    const dDtl = await req.query(`DELETE FROM DlyCheck WHERE Vchcode IN (${inList})`);
    const dHdr = await req.query(`DELETE FROM DlyNdxCheck WHERE Vchcode IN (${inList})`);
    console.log(`[delete] 明细删除 ${dDtl.rowsAffected?.[0] ?? 0} 行；表头删除 ${dHdr.rowsAffected?.[0] ?? 0} 行`);
    if (commit) {
      await tran.commit();
      console.log(`[delete] 已 COMMIT 删除 ${inList}`);
    } else {
      await tran.rollback();
      console.log('[delete] DRY-RUN：已 ROLLBACK，未删除任何数据');
    }
  } catch (err) {
    try { await tran.rollback(); } catch { /* noop */ }
    throw err;
  }
}

/* ------------------------------- 主流程 ------------------------------- */

async function selectOrders(args: CliArgs): Promise<OrderRow[]> {
  if (args.order) {
    const q = db.selectFrom('inspectionOrders').selectAll();
    const row = UUID_RE.test(args.order)
      ? await q.where('id', '=', args.order).executeTakeFirst()
      : await q.where('orderNo', '=', args.order).executeTakeFirst();
    if (!row) throw new Error(`未找到检验单：${args.order}`);
    return [row as unknown as OrderRow];
  }
  if (!args.since && !args.until) {
    throw new Error('必须指定 --order=<单号/id> 或 --since/--until 之一');
  }
  let q = db
    .selectFrom('inspectionOrders')
    .selectAll()
    .where('status', 'in', ['COMPLETED', 'PASSED'])
    .where('judgment', 'is not', null);
  if (args.since) q = q.where('createdAt', '>=', new Date(args.since));
  if (args.until) q = q.where('createdAt', '<=', new Date(`${args.until}T23:59:59`));
  const rows = await q.limit(args.limit).execute();
  return rows as unknown as OrderRow[];
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[writeback] commit=${args.commit ? 'YES(真实写入)' : 'NO(dryRun,ROLLBACK)'} ` +
      `draft=${args.draft} mode=${args.mode} order=${args.order ?? '(批量)'} ` +
      `since=${args.since ?? '-'} until=${args.until ?? '-'} limit=${args.limit}`,
  );

  const pool = await getErpConnectionPool();
  if (pool === null) {
    throw new Error('ERP 连接不可用：请检查 .env 的 ERP_DB_* 与本机到 ERP 的网络可达性');
  }

  // 清理草稿（默认 DRY-RUN 预览；--commit 才真删）。可先于 --order 重写完成「删后重写」。
  if (args.deleteVchcodes && args.deleteVchcodes.length) {
    await deleteDrafts(pool, args.deleteVchcodes, args.commit);
  }

  // ④ 用 erp-reads 建立映射（物料/供应商按 ERP UserCode；员工按名称）
  const reads = createMssqlErpReads(pool);
  const materials: ErpMaterialRow[] = await reads.fetchMaterials(20000);
  const suppliers: ErpSupplierRow[] = await reads.fetchSuppliers(20000);
  const matByCode = new Map(materials.map((m) => [m.userCode.trim().toUpperCase(), m]));
  const supByCode = new Map(suppliers.map((s) => [s.userCode.trim().toUpperCase(), s]));

  const runner: ErpQueryRunner = {
    async query(sqlText: string, params: readonly ErpQueryParam[] = []) {
      const request = pool.request();
      for (const p of params) request.input(p.name, p.value);
      const result = await request.query(sqlText);
      return { recordset: (result?.recordset ?? []) as unknown[] };
    },
  };
  const empRows = await queryErpReadOnly<{ typeId: string; name: string | null; userCode: string | null }>(
    runner,
    `SELECT typeId, Name, UserCode FROM Employee`,
  );
  const empByName = new Map<string, string>();
  for (const r of empRows) {
    if (r.name) empByName.set(r.name.trim().toUpperCase(), r.typeId);
  }
  console.log(
    `[writeback] ERP 映射装载：物料 ${materials.length} / 供应商 ${suppliers.length} / 员工 ${empRows.length}`,
  );

  const hasOrderSelector = Boolean(args.order || args.since || args.until);
  if (!hasOrderSelector) {
    console.log('[writeback] 未指定回写订单（--order/--since/--until），仅执行删除/预览，结束。');
    console.log(`[writeback] 模式：${args.commit ? '删除已提交' : 'DRY-RUN（删除已 ROLLBACK）'}`);
    return;
  }

  const orders = await selectOrders(args);
  console.log(`[writeback] 命中检验单 ${orders.length} 条`);

  const results: unknown[] = [];
  let okCount = 0;
  for (const o of orders) {
    try {
      const { date: docDate, source: dateSource } = deriveDocDate(o, args.date);
      const period = args.period ?? Number(docDate.replace(/-/g, '').slice(0, 6));

      // 物料映射：override → 映射表 → erp-reads(UserCode)
      const matFromTable = await resolveErpTypeId(db, 'MATERIAL', o.materialCode);
      const mat = args.ptype
        ? { typeId: args.ptype, defaultWarehouseId: args.ktype ?? null }
        : matFromTable
          ? { typeId: matFromTable, defaultWarehouseId: null }
          : matByCode.get(o.materialCode.trim().toUpperCase());
      if (!mat) {
        throw new Error(
          `物料无 ERP 映射：QMS materialCode=${o.materialCode}（映射表与 ERP Ptype.UserCode 均未命中；可用 --ptype 覆盖）`,
        );
      }
      const ptypeId = mat.typeId;
      const ktypeId = args.ktype ?? mat.defaultWarehouseId ?? '';

      // 供应商映射：override → 映射表 → erp-reads(UserCode)
      const supFromTable = o.supplierCode ? await resolveErpTypeId(db, 'SUPPLIER', o.supplierCode) : null;
      const sup = args.btype
        ? { typeId: args.btype }
        : o.supplierCode
          ? supFromTable
            ? { typeId: supFromTable }
            : supByCode.get(o.supplierCode.trim().toUpperCase())
          : null;
      if (!sup) {
        throw new Error(
          `供应商无 ERP 映射：QMS supplierCode=${o.supplierCode ?? '(空)'}（映射表与 ERP Btype.UserCode 均未命中；可用 --btype 覆盖）`,
        );
      }
      const btypeId = sup.typeId;

      // 检验员映射：override → 映射表 → erp-reads(Employee.Name)
      const empFromTable = o.inspectorName ? await resolveErpTypeId(db, 'EMPLOYEE', o.inspectorName) : null;
      const etypeId =
        args.etype
        ?? empFromTable
        ?? (o.inspectorName ? empByName.get(o.inspectorName.trim().toUpperCase()) ?? null : null);
      if (!etypeId) {
        throw new Error(
          `检验员无 ERP 映射：QMS inspectorName=${o.inspectorName ?? '(空)'}（映射表与 ERP Employee.Name 均未命中；可用 --etype 覆盖）`,
        );
      }

      const passQty = Number(o.passQty ?? 0);
      const failQty = Number(o.failQty ?? 0);
      const sampleQty = Number(o.sampleQty ?? 0);
      const totalQty = Number(o.totalQty ?? 0);

      const detail: ErpCheckDetailInput = {
        ptypeId,
        qualifiedQty: passQty,
        inspectedQty: sampleQty,
        rejectedQty: failQty,
      };
      // 146 送检单的「送检数」= 来料总数 totalQty；不传则回退验货数 sampleQty（全检场景二者相等）
      if (totalQty > 0) detail.submittedQty = totalQty;
      if (o.batchNo) detail.batchNo = o.batchNo;
      if (ktypeId) detail.ktypeId = ktypeId;
      if (o.inspectionNotes) detail.rejectReason = o.inspectionNotes;

      const input: ErpWriteBackInput = {
        docDate,
        btypeId,
        etypeId,
        inputName: o.inspectorName ?? 'QMS',
        summary: `QMS回写 ${o.orderNo} ${o.materialName ?? o.materialCode}`,
        details: [detail],
        sourceOrderNo: o.orderNo,
      };
      if (args.project) input.projectId = args.project;

      console.log(
        `[writeback] 准备 ${o.orderNo} | docDate=${docDate}(${dateSource}) period=${period} ` +
          `ptype=${ptypeId} btype=${btypeId} etype=${etypeId} ` +
          `合格=${passQty} 验货=${sampleQty} 不合格=${failQty} 送检=${totalQty > 0 ? totalQty : sampleQty} 批号=${o.batchNo ?? '-'}`,
      );

      const res = await writeBackInspection(pool, input, {
        dryRun: !args.commit,
        draftStatus: args.draft,
        period,
        defaultMode: args.mode,
      });
      results.push({ orderNo: o.orderNo, ...res });
      okCount++;
      console.log(
        `  -> ${args.commit ? 'COMMIT' : 'DRY-RUN'} 送检单=${res.submittedNumber}(${res.submittedVchcode}) ` +
          `检验单=${res.inspectedNumber}(${res.inspectedVchcode}) 明细=${res.detailRows}行`,
      );
    } catch (err) {
      const message = (err as { message?: string })?.message ?? String(err);
      console.error(`[writeback] 跳过 ${o.orderNo}：${message}`);
      results.push({ orderNo: o.orderNo, error: message });
    }
  }

  console.log(`\n[writeback] 完成：成功 ${okCount} / 共 ${orders.length}`);
  console.log(`[writeback] 模式：${args.commit ? '已真实写入生产 ERP' : 'DRY-RUN（已全部 ROLLBACK，未落库）'}`);
  if (!args.commit) {
    console.log('[writeback] 若要真实写入，追加 --commit（建议先用 --order 试写 1 条核对无误）');
  }
  console.log(JSON.stringify(results, null, 2));
}

run()
  .catch(async (err: unknown) => {
    const message = (err as { message?: string })?.message ?? String(err);
    console.error(`[writeback] 失败：${message}`);
    try {
      await closeErpConnectionPool();
      await db.destroy();
    } catch {
      /* noop */
    }
    process.exit(1);
  })
  .then(async () => {
    await closeErpConnectionPool();
    await db.destroy();
    process.exit(0);
  });
