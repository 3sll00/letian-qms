/**
 * Ptype -> materials 同步 CLI（ERP -> QMS **单向**：只读 ERP、只写 QMS 镜像表）
 *
 * 用法（根目录）：
 *   pnpm erp:sync:ptype                                   # 本地样例源：无 ERP 也能跑通的最小闭环
 *   pnpm erp:sync:ptype -- --dry-run                      # 只算不写
 *   pnpm erp:sync:ptype -- --limit=200 --category=CAT-FIN-BOLT
 *   pnpm erp:sync:ptype -- --source=erp --limit=500       # 真 ERP（需 ERP_DB_* 已配且网络可达）
 *   pnpm erp:sync:ptype -- --map=packages/infrastructure/fixtures/erp-category-map.sample.json
 *
 * 退出码：0 成功；1 其它失败；2 **ERP 只读守门拦截**（有代码试图写 ERP，按事故处理）。
 */
import dotenv from 'dotenv';
dotenv.config();
import fs from 'node:fs';
import path from 'node:path';
import { closeErpConnectionPool, getErpConnectionPool } from '../adapters/erp-pool.js';
import { db } from '../database/connection.js';
import { erpReadOnlyAudit, resetErpReadOnlyAudit } from '../sync/erp-readonly.js';
import { createMssqlErpSource, loadFixtureErpSource, type ErpSource } from '../sync/erp-source.js';
import { syncPtypeToMaterials, type PtypeSyncOptions } from '../sync/ptype-sync.js';

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', 'fixtures');
const DEFAULT_FIXTURE = path.join(FIXTURE_DIR, 'erp-ptype.sample.json');
const DEFAULT_MAP = path.join(FIXTURE_DIR, 'erp-category-map.sample.json');

interface CliArgs {
  source: 'fixture' | 'erp';
  limit: number;
  dryRun: boolean;
  category: string | null;
  mapPath: string | null;
  fixture: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const read = (name: string): string | null => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit === undefined ? null : hit.slice(name.length + 3);
  };
  const limitRaw = Number(read('limit'));
  return {
    source: read('source') === 'erp' ? 'erp' : 'fixture',
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 500,
    dryRun: argv.includes('--dry-run'),
    category: read('category'),
    mapPath: read('map'),
    fixture: read('fixture') ?? DEFAULT_FIXTURE,
  };
}

function loadCategoryMap(args: CliArgs): { map: Record<string, string>; file: string | null } {
  const file = args.mapPath ?? (fs.existsSync(DEFAULT_MAP) ? DEFAULT_MAP : null);
  if (file === null) {
    return { map: {}, file: null };
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[sync-ptype] 分类映射文件必须是 JSON 对象：${file}`);
  }
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim() !== '') {
      map[key] = value.trim();
    }
  }
  return { map, file };
}

async function buildSource(args: CliArgs): Promise<ErpSource> {
  if (args.source === 'fixture') {
    return loadFixtureErpSource(args.fixture);
  }
  const pool = await getErpConnectionPool();
  if (pool === null) {
    throw new Error(
      'ERP 连接不可用：请检查 .env 的 ERP_DB_HOST/PORT/NAME/USER/PASSWORD 与本机到 ERP 的网络可达性'
    );
  }
  return createMssqlErpSource(pool);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const { map, file } = loadCategoryMap(args);
  const options: PtypeSyncOptions = {
    limit: args.limit,
    dryRun: args.dryRun,
    defaultCategoryCode: args.category,
    categoryMap: map,
  };
  console.log(
    `[sync-ptype] 数据源=${args.source} 分类映射=${file ?? '(未使用)'} 兜底分类=${args.category ?? '(未设置)'} limit=${args.limit} dryRun=${args.dryRun}`
  );
  resetErpReadOnlyAudit();
  const source = await buildSource(args);
  const outcome = await syncPtypeToMaterials(db, source, options);
  console.log(JSON.stringify(outcome, null, 2));
  console.log(
    `[erp-readonly] 本次向 ERP 发出的查询 ${erpReadOnlyAudit.length} 条，全部为 SELECT（写语句在下发前即抛错中止）`
  );
  for (const entry of erpReadOnlyAudit) {
    console.log(`  - ${entry.sqlText.slice(0, 120)}`);
  }
  if (args.source === 'fixture') {
    console.log('[erp-readonly] 样例源未访问 ERP：本次没有建立任何 ERP 连接');
  }
  await closeErpConnectionPool();
  await db.destroy();
  process.exit(0);
})().catch(async (err: unknown) => {
  const violation = (err as { name?: string })?.name === 'ErpReadOnlyViolation';
  const message = (err as { message?: string })?.message ?? String(err);
  console.error(violation ? `[erp-readonly] 拦截：${message}` : `[sync-ptype] 失败：${message}`);
  try {
    await closeErpConnectionPool();
    await db.destroy();
  } catch {
    /* 关闭失败不影响退出码 */
  }
  process.exit(violation ? 2 : 1);
});
