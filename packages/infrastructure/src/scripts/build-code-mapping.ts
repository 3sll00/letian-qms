/**
 * 回填 QMS↔ERP 编码映射（写 `qms_erp_code_mapping`，迁移 041）。
 * ───────────────────────────────────────────────────────────────────────────
 * 扫描 `inspection_orders` 的去重编码（物料/供应商/检验员），按 ERP `UserCode`/`Name`
 * 自动解析出 ERP `typeId`，以 `source='auto'` 落表。无法自动解析的（合成码等）打印出来，
 * 交运维用 SQL 手工补 `source='manual'`（见下方示例）。
 *
 * 安全模型：默认 dryRun（只打印将要写入的条数，不落库）；`--commit` 才真正 INSERT。
 * 落库用 `ON CONFLICT DO NOTHING`，重跑幂等（不会覆盖已有映射）。
 *
 * 运行（Git Bash，直接调 tsx，绕过 pnpm）：
 *   cd D:/乐天/letian-qms
 *   node node_modules/tsx/dist/cli.mjs packages/infrastructure/src/scripts/build-code-mapping.ts            # 预览
 *   node node_modules/tsx/dist/cli.mjs packages/infrastructure/src/scripts/build-code-mapping.ts --commit   # 真正写
 *
 * 手工补合成码示例（落 'manual' 后回写即可命中）：
 *   INSERT INTO qms_erp_code_mapping (entity_type, qms_code, erp_type_id, source)
 *   VALUES ('SUPPLIER', 'SUP-001', '0019900001', 'manual');
 */
import dotenv from 'dotenv';
dotenv.config();
import { db } from '../database/connection.js';
import { closeErpConnectionPool, getErpConnectionPool } from '../adapters/erp-pool.js';
import { createMssqlErpReads, type ErpMaterialRow, type ErpSupplierRow } from '../sync/erp-reads.js';
import { queryErpReadOnly, type ErpQueryRunner } from '../sync/erp-readonly.js';
import {
  insertMappings,
  listUnmappedCodes,
  type CodeMappingRecord,
} from '../sync/code-mapping.js';
import sql from 'mssql';

interface CliArgs {
  commit: boolean;
  limit: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const read = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? null : hit.slice(name.length + 3);
  };
  const limitRaw = Number(read('limit'));
  return {
    commit: argv.includes('--commit'),
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 20000,
  };
}

const norm = (s: string | null | undefined): string =>
  (s ?? '').trim().toUpperCase();

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[build-mapping] commit=${args.commit ? 'YES(真实写入)' : 'NO(仅预览)'} ` +
      `erpFetchLimit=${args.limit}`,
  );

  // 1) 取 QMS 尚未映射的编码（已映射的跳过，保证幂等）
  const unmapped = await listUnmappedCodes(db);
  console.log(
    `[build-mapping] QMS 未映射编码：物料 ${unmapped.materials.length} / ` +
      `供应商 ${unmapped.suppliers.length} / 检验员 ${unmapped.employees.length}`,
  );

  // 2) 连 ERP，建立反查字典
  const pool = await getErpConnectionPool();
  if (pool === null) {
    console.warn('[build-mapping] ⚠️ ERP 连接不可用：跳过自动解析，仅输出待手工补的清单');
    printManual(unmapped);
    return;
  }

  const reads = createMssqlErpReads(pool);
  const materials: ErpMaterialRow[] = await reads.fetchMaterials(args.limit);
  const suppliers: ErpSupplierRow[] = await reads.fetchSuppliers(args.limit);
  const matByCode = new Map(materials.map((m) => [norm(m.userCode), m] as const));
  const supByCode = new Map(suppliers.map((s) => [norm(s.userCode), s] as const));

  const runner: ErpQueryRunner = {
    async query(sqlText: string, params: readonly { name: string; value: unknown }[] = []) {
      const request = pool.request();
      for (const p of params) request.input(p.name, p.value);
      const result = await request.query(sqlText);
      return { recordset: (result?.recordset ?? []) as unknown[] };
    },
  };
  const empRows = await queryErpReadOnly<{ typeId: string; name: string | null }>(
    runner,
    `SELECT typeId, Name FROM Employee`,
  );
  const empByName = new Map(empRows.filter((e) => e.name).map((e) => [norm(e.name), e.typeId] as const));
  console.log(
    `[build-mapping] ERP 字典装载：物料 ${materials.length} / 供应商 ${suppliers.length} / 员工 ${empRows.length}`,
  );

  // 3) 自动解析
  const recs: CodeMappingRecord[] = [];
  const stillManual: typeof unmapped = { materials: [], suppliers: [], employees: [] };

  for (const code of unmapped.materials) {
    const m = matByCode.get(norm(code));
    if (m) {
      recs.push({
        entityType: 'MATERIAL',
        qmsCode: code.trim(),
        erpTypeId: m.typeId,
        erpUserCode: m.userCode,
        erpFullName: m.fullName,
        source: 'auto',
      });
    } else {
      stillManual.materials.push(code);
    }
  }
  for (const code of unmapped.suppliers) {
    const s = supByCode.get(norm(code));
    if (s) {
      recs.push({
        entityType: 'SUPPLIER',
        qmsCode: code.trim(),
        erpTypeId: s.typeId,
        erpUserCode: s.userCode,
        erpFullName: s.fullName,
        source: 'auto',
      });
    } else {
      stillManual.suppliers.push(code);
    }
  }
  for (const name of unmapped.employees) {
    const t = empByName.get(norm(name));
    if (t) {
      recs.push({
        entityType: 'EMPLOYEE',
        qmsCode: name.trim(),
        erpTypeId: t,
        erpUserCode: null,
        erpFullName: name.trim(),
        source: 'auto',
      });
    } else {
      stillManual.employees.push(name);
    }
  }

  // 4) 落库（仅新增；DO NOTHING 幂等）
  console.log(
    `[build-mapping] 自动解析命中 ${recs.length} 条；待手工补 ${stillManual.materials.length + stillManual.suppliers.length + stillManual.employees.length} 条`,
  );
  const inserted = await insertMappings(db, recs, args.commit);
  console.log(
    `[build-mapping] ${args.commit ? '已写入' : '将写入（dryRun）'} 映射 ${inserted} 条` +
      (args.commit ? '' : '（追加 --commit 真正写入）'),
  );

  if (stillManual.materials.length || stillManual.suppliers.length || stillManual.employees.length) {
    printManual(stillManual);
  }
}

function printManual(u: { materials: string[]; suppliers: string[]; employees: string[] }): void {
  console.log('\n[build-mapping] ── 待手工补的编码（用 source=manual 的 INSERT 落表）──');
  if (u.materials.length) console.log('  物料(MATERIAL):', u.materials.join(', '));
  if (u.suppliers.length) console.log('  供应商(SUPPLIER):', u.suppliers.join(', '));
  if (u.employees.length) console.log('  检验员(EMPLOYEE):', u.employees.join(', '));
  if (!u.materials.length && !u.suppliers.length && !u.employees.length) {
    console.log('  （无，全部已解析）');
  }
}

run()
  .catch(async (err: unknown) => {
    const message = (err as { message?: string })?.message ?? String(err);
    console.error(`[build-mapping] 失败：${message}`);
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
