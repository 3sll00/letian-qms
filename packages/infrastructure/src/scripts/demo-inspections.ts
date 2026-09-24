/**
 * 演示 / 测试检验单的「方案快照 + 指标行」体检与修复（一条命令即可重复执行）
 *
 * 文档口径：docs/46-演示检验单方案快照与指标行补齐设计.md
 *
 * 背景：`inspection_orders.plan_snapshot` 的库默认值是 `'{}'`、`items` 是 `'[]'`。
 * 任何**绕过建单链路**的写入（裸 SQL 造数、外部批量导入）都会落下一张"能查得到、但没有判定依据"的检验单，
 * 而读侧（服务端契约 + 前端 Zod）会严格拒绝它 —— 页面表现就是
 * 「检验单方案快照加载失败 / 待检指标清单未就绪」且检验项总数 0（即"检视无数据"）。
 *
 * 用法（仓库根目录）：
 *   pnpm db:demo:check                                    # 只读体检：有违规行即退出码 1
 *   pnpm db:demo:repair                                   # 修复：按真实匹配口径补齐快照 / 指标行
 *   pnpm db:demo:repair -- --demo-batch=TEST2609-         # 允许"物料归位"的演示批次前缀（可逗号分隔，默认同值）
 *   pnpm db:demo:repair -- --dry-run                      # 只算不写
 *   pnpm db:demo:heat-trace                               # 播种「炉批号关联链路」演示单（docs/47 §3.8，带 TEST 标记）
 *   pnpm db:demo:heat-trace -- --dry-run                  # 只算不写
 *
 * 违规判据（两条，都直指"检视必然空白"）：
 *   ① 工单本体不符合 `InspectionOrderSchema`（服务端 / 前端校验用的**同一份契约**）；
 *   ② 方案快照里带着指标项，但工单 `items` 为空 —— 有方案无待检行，页面同样渲染不出任何指标。
 *
 * 修复口径（唯一真相见 docs/46 §3）：
 *   1. 方案一律按 `findActivePlan(物料编码, 检验类型, 物料分类)` 解析 —— 与建单链路同一套两级匹配
 *      （物料专属方案 → 存货分类通用方案兜底），不做任何"猜一个方案"的兜底；
 *   2. 匹配不到方案、且属于演示批次的行：按其检验类型下 ACTIVE 方案的覆盖范围把**物料归位**
 *      （物料名称 / 规格型号 / 计量单位随物料主数据同步，MRB / 不合格待审池 / 追溯节点上的同名字段一并联动）；
 *      这类演示行的物料原本是"全表轮询"随机落下的，与所挂方案毫无对应关系，正是本次缺陷的根因；
 *   3. 非演示行匹配不到方案时**只报告、不擅改**（人工确认后再处理）；
 *   4. 快照字段全部取自被引用的方案版本行；实测值只对数值型指标按"公差内 / 公差外"生成，
 *      定性指标取方案可接受值清单首项 —— 清单缺失即保持 PENDING 交人工判定，绝不编造。
 *
 * 播种口径（唯一真相见 docs/47 §3.8）：演示单一律 `batch_no` 前缀 `TEST2609-`、炉批号以 `TEST-` 开头，
 * 只用真实 `findActivePlan` 命中的方案建快照，绝不改主数据、不碰任何真实行；清理入口 `pnpm db:test:purge`。
 *
 * 退出码：0 = 全部合规 / 播种成功；1 = 仍存在违规行或播种失败（结论本身就是失败信号）；2 = 用法 / IO 错误。
 */
import { InspectionOrderSchema } from '@letian/contracts';
import type {
  InspectionOrder,
  InspectionPlan,
  InspectionPlanVersion,
  InspectionStatus,
  InspectionType,
  OverallDecision,
} from '@letian/contracts';
import { HeatBatchTraceService } from '@letian/domain';
import { db } from '../database/connection.js';
import { KyselyInspectionOrderRepository } from '../repositories/inspection-order-repository.js';
import { KyselyInspectionPlanRepository } from '../repositories/inspection-plan-repository.js';
import {
  buildOrderItems,
  buildSnapshot,
  deriveQty,
  itemResultKindOf,
} from '../seeds/order-builders.js';

const DEFAULT_DEMO_BATCH_PREFIXES = ['TEST2609-'] as const;

interface CliArgs {
  mode: 'check' | 'repair' | 'seed';
  demoBatchPrefixes: readonly string[];
  dryRun: boolean;
}

/** 物料主数据（修复"物料归位"时按它回填名称 / 规格型号 / 计量单位） */
interface MaterialRef {
  materialCode: string;
  materialName: string;
  categoryCode: string;
  specModel: string | null;
  unit: string;
}

/** 单行修复结果：`repaired` 与 `realigned` 都是"已写入（或 dry-run 下将写入）" */
type RepairOutcome =
  | { kind: 'repaired'; planCode: string; itemCount: number; realignedTo: string | null }
  | { kind: 'no-plan' }
  | { kind: 'no-active-version'; planCode: string }
  | { kind: 'still-invalid'; detail: string };

function parseArgs(argv: readonly string[]): CliArgs {
  const read = (name: string): string | null => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit === undefined ? null : hit.slice(name.length + 3);
  };
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const requested = positional[0];
  const mode: CliArgs['mode'] =
    requested === 'repair' ? 'repair' : requested === 'seed' ? 'seed' : 'check';
  const demoBatchRaw = read('demo-batch');
  const demoBatchPrefixes =
    demoBatchRaw === null
      ? DEFAULT_DEMO_BATCH_PREFIXES
      : demoBatchRaw
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value !== '');
  return { mode, demoBatchPrefixes, dryRun: argv.includes('--dry-run') };
}

/** 数组列的运行时读数：裸 SQL 造出来的行可能把 jsonb 落成 `{}` / 非数组，这里一律按"读不到就是 0 项"处理 */
function arrayLengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** 违规原因摘要（只取前 3 条 issue，避免刷屏） */
function violationReasons(order: InspectionOrder): string[] {
  const reasons: string[] = [];
  const parsed = InspectionOrderSchema.safeParse(order);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 3)) {
      reasons.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  }
  // 快照本体可能被写成 `{}`（列默认值），故这里不做类型断言，直接按运行时值判断
  const snapshotItems = arrayLengthOf(
    (order.planSnapshot as unknown as { items?: unknown } | undefined)?.items
  );
  if (snapshotItems > 0 && arrayLengthOf(order.items) === 0) {
    reasons.push('方案快照含指标项，但工单 items 为空（有方案无待检行）');
  }
  return reasons;
}

async function loadMaterials(): Promise<Map<string, MaterialRef>> {
  const rows = await db
    .selectFrom('materials')
    .select(['materialCode', 'materialName', 'categoryCode', 'specModel', 'unit'])
    .execute();
  return new Map(
    rows.map((row) => [
      row.materialCode,
      {
        materialCode: row.materialCode,
        materialName: row.materialName,
        categoryCode: row.categoryCode,
        specModel: row.specModel,
        unit: row.unit,
      },
    ])
  );
}

function isDemoRow(order: InspectionOrder, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => order.batchNo.startsWith(prefix));
}

/** 该分类下编码最小的物料（确定性取法，保证重复执行结果一致） */
function firstMaterialOfCategory(
  materials: ReadonlyMap<string, MaterialRef>,
  categoryCode: string
): MaterialRef | undefined {
  return [...materials.values()]
    .filter((material) => material.categoryCode === categoryCode)
    .sort((left, right) => left.materialCode.localeCompare(right.materialCode))[0];
}

/** 方案的 ACTIVE 且非空版本（空指标版本在建单链路就被拒，此处同样不接受） */
function activeVersionOf(plan: InspectionPlan): InspectionPlanVersion | undefined {
  return plan.versions?.find((version) => version.status === 'ACTIVE' && version.items.length > 0);
}

/** 一个"能用且自洽"的方案绑定：方案 + 其 ACTIVE 版本 + 该方案覆盖的物料 */
interface BoundPlan {
  plan: InspectionPlan;
  version: InspectionPlanVersion;
  material: MaterialRef;
}

/**
 * 为某个检验类型挑出 `limit` 个"能用且自洽"的方案：物料取自方案自身（专属方案取方案物料，
 * 分类通用方案取该分类下的物料），再用 `findActivePlan` **反向验证**命中同一方案 ——
 * 保证补出来 / 播出来的演示单与建单链路今天会命中的方案完全一致。
 * 同一物料只取一次（不同方案的物料互不重样，演示样例之间才互相独立）。
 */
async function pickCoveringPlans(
  planRepo: KyselyInspectionPlanRepository,
  materials: ReadonlyMap<string, MaterialRef>,
  inspectionType: InspectionType,
  limit: number
): Promise<BoundPlan[]> {
  const { list } = await planRepo.listPlans({
    inspectionType,
    activeOnly: true,
    page: 1,
    pageSize: 200,
  });
  const candidates = [...list].sort((left, right) => left.planCode.localeCompare(right.planCode));

  const picked: BoundPlan[] = [];
  const usedMaterials = new Set<string>();
  for (const plan of candidates) {
    if (picked.length >= limit) break;
    const version = activeVersionOf(plan);
    if (version === undefined) continue;
    const specificCode = plan.materialCode ?? '';
    const material =
      specificCode !== ''
        ? materials.get(specificCode)
        : firstMaterialOfCategory(materials, plan.categoryCode ?? '');
    if (material === undefined || usedMaterials.has(material.materialCode)) continue;
    const matched = await planRepo.findActivePlan(
      material.materialCode,
      inspectionType,
      material.categoryCode
    );
    if (matched?.planCode !== plan.planCode) continue;
    usedMaterials.add(material.materialCode);
    picked.push({ plan, version, material });
  }
  return picked;
}

async function pickCoveringPlan(
  planRepo: KyselyInspectionPlanRepository,
  materials: ReadonlyMap<string, MaterialRef>,
  inspectionType: InspectionType
): Promise<BoundPlan | null> {
  const [first] = await pickCoveringPlans(planRepo, materials, inspectionType, 1);
  return first ?? null;
}

/** 指定物料 + 检验类型解析方案（建单链路同一套两级匹配）；解析不到返回 null，由调用方 fail-loud */
async function resolvePlanForMaterial(
  planRepo: KyselyInspectionPlanRepository,
  materials: ReadonlyMap<string, MaterialRef>,
  materialCode: string,
  inspectionType: InspectionType
): Promise<BoundPlan | null> {
  const material = materials.get(materialCode);
  if (material === undefined) return null;
  const plan = await planRepo.findActivePlan(materialCode, inspectionType, material.categoryCode);
  if (plan === null) return null;
  const version = activeVersionOf(plan);
  if (version === undefined) return null;
  return { plan, version, material };
}

/**
 * 物料归位后同步"同一业务事实的副本列"：MRB 评审单 / 不合格待审池 / 批次追溯节点上都冗余了
 * 物料编码与名称，只改检验单会让三处互相打架（台账查一个样、追溯查另一个样）。
 */
async function syncDependentRows(orderNo: string, material: MaterialRef): Promise<void> {
  const patch = { materialCode: material.materialCode, materialName: material.materialName };
  await db.updateTable('mrbReviews').set(patch).where('sourceOrderNo', '=', orderNo).execute();
  await db.updateTable('pendingMrbItems').set(patch).where('sourceOrderNo', '=', orderNo).execute();
  await db.updateTable('batchTraceNodes').set(patch).where('orderNo', '=', orderNo).execute();
}

async function repairOrder(
  order: InspectionOrder,
  ctx: {
    orderRepo: KyselyInspectionOrderRepository;
    planRepo: KyselyInspectionPlanRepository;
    materials: ReadonlyMap<string, MaterialRef>;
    demoBatchPrefixes: readonly string[];
    dryRun: boolean;
  }
): Promise<RepairOutcome> {
  const material = ctx.materials.get(order.materialCode);
  let plan = await ctx.planRepo.findActivePlan(
    order.materialCode,
    order.inspectionType,
    material?.categoryCode
  );
  let realigned: MaterialRef | undefined;

  if (plan === null && isDemoRow(order, ctx.demoBatchPrefixes)) {
    const covering = await pickCoveringPlan(ctx.planRepo, ctx.materials, order.inspectionType);
    if (covering !== null) {
      plan = covering.plan;
      realigned = covering.material;
    }
  }
  if (plan === null) return { kind: 'no-plan' };

  const version = activeVersionOf(plan);
  if (version === undefined) return { kind: 'no-active-version', planCode: plan.planCode };
  const versionId = version.id ?? plan.id;
  if (versionId === undefined) return { kind: 'no-active-version', planCode: plan.planCode };

  const itemKind = itemResultKindOf(order.overallDecision);
  const { passQty, failQty } = deriveQty(order.sampleQty, itemKind);

  const next: InspectionOrder = {
    ...order,
    ...(realigned !== undefined
      ? {
          materialCode: realigned.materialCode,
          materialName: realigned.materialName,
          specification: realigned.specModel ?? '',
          unit: realigned.unit,
        }
      : {}),
    planVersionId: versionId,
    planSnapshot: buildSnapshot(
      { planCode: plan.planCode, planName: plan.planName },
      {
        id: versionId,
        versionNo: version.versionNo,
        items: version.items,
        ...(version.samplingScheme !== undefined ? { samplingScheme: version.samplingScheme } : {}),
        ...(version.aqlLevel !== undefined ? { aqlLevel: version.aqlLevel } : {}),
        ...(version.strictness !== undefined ? { strictness: version.strictness } : {}),
      },
      // 快照时间取该单的建单时间：快照本就是"建单当时固化"的产物，不用"现在"冒充历史时间
      order.createdAt ?? new Date().toISOString()
    ),
    items: buildOrderItems(version.items, itemKind),
    passQty,
    failQty,
  };

  // 写库前先用同一份契约校验：修完仍不合规就宁可不写（fail-closed）
  const parsed = InspectionOrderSchema.safeParse(next);
  if (!parsed.success) {
    return {
      kind: 'still-invalid',
      detail: parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join(' | '),
    };
  }

  if (!ctx.dryRun) {
    await ctx.orderRepo.save(parsed.data);
    if (realigned !== undefined) {
      await syncDependentRows(order.orderNo, realigned);
    }
  }

  return {
    kind: 'repaired',
    planCode: plan.planCode,
    itemCount: next.items.length,
    realignedTo: realigned?.materialCode ?? null,
  };
}

// ---------------------------------------------------------------------------
// 演示播种（docs/47 §3.8）：带 TEST 标记的炉批号关联链路演示单
// ---------------------------------------------------------------------------

/** 演示批次前缀：与 §3.8 的标记载体口径一致（`pnpm db:test:purge` 正是按它划边界） */
const HEAT_TRACE_DEMO_BATCH_PREFIX = 'TEST2609-';

/**
 * 演示炉批号一律以 `TEST-` 开头：外溢到台账 / 质保书 / 追溯看板时一眼可辨，
 * 绝不与真实钢厂炉号或真实 MTC 混同（§3.8 硬边界）。
 */
const DEMO_HEAT_L1 = 'TEST-HT-2609-001';
const DEMO_HEAT_L2 = 'TEST-HT-2609-002';
const DEMO_HEAT_NONE = 'TEST-HT-2609-003';
/** 组④：同炉**存在不合格记录**（TBD-01 提示场景：空态 + 提示，不带出任何值） */
const DEMO_HEAT_FAILED = 'TEST-HT-2609-004';

const HEAT_TRACE_DEMO_HEAT_NOS: readonly { heatNo: string; expectation: string }[] = [
  {
    heatNo: DEMO_HEAT_L1,
    expectation: '组①：OQC_HEAT 与 IQC 各一条 -> 只取 L1 委外热处理（另有 1 张 MRB 未结案 -> 附 UPSTREAM_UNDER_MRB 提示）',
  },
  { heatNo: DEMO_HEAT_L2, expectation: '组②：只有 IQC -> 回退 L2 来料检验' },
  { heatNo: DEMO_HEAT_NONE, expectation: '组③：两处均无 -> NONE 静默空态' },
  {
    heatNo: DEMO_HEAT_FAILED,
    expectation: '组④：同炉存在不合格 -> NONE 空态 + UPSTREAM_FAILED 提示（只提示不带值）',
  },
];

/** 物料族：'BOLT' = 委外热处理 / 出货检验共同覆盖的成品族；'IQC_A' / 'IQC_B' = 两套不同的来料检验方案 */
type DemoMaterialFamily = 'BOLT' | 'IQC_A' | 'IQC_B';

interface HeatTraceDemoSpec {
  orderNo: string;
  inspectionType: InspectionType;
  batchNo: string;
  furnaceHeatNo: string;
  status: InspectionStatus;
  overallDecision: OverallDecision | null;
  materialFamily: DemoMaterialFamily;
  sampleQty: number;
  totalQty: number;
  /** 业务检验日期（`inspected_date`，界面回显与 `inspectedAt` 都读它） */
  inspectedDate: string;
  /** 终判时间：写入 `updated_at`（AC-05「取最近一次终判」靠它区分先后，不用"播种时刻"冒充） */
  decidedAt: string;
  purpose: string;
}

/**
 * 五组演示样例（docs/47 §3.8 / §9.4），共 11 张单：
 *   组① `TEST-HT-2609-001`：OQC_HEAT 3 张（不同终判时间，验 AC-05）+ IQC 1 张（验 AC-02 L1 优先）
 *                           + 出货目标单 1 张（材质与 OQC_HEAT 相同 -> 同物料命中，可写溯源留痕）；
 *   组② `TEST-HT-2609-002`：只有 IQC（验 AC-03 回退 L2，并带出该方案的力学 / 化学成分实测值）；
 *   组③ `TEST-HT-2609-003`：两处均无（验 AC-04 静默空态）。
 *   组① 追加 1 张 `IN_MRB_REVIEW` 的 OQC_HEAT（验 TBD-01「带出 + MRB 未结案提示」），
 *        它不参与带出（未终判合格），因此 AC-05「取最近一次终判」的期望值不变；
 *   组④ `TEST-HT-2609-004`：同炉 1 张 `FAILED` + 交接目标单 1 张（验 TBD-01「空态 + 不合格提示」）；
 *   组⑤ `OQC-SH-20260923-9005`（批次 `TEST2609-SH-AC08`，炉批号留空）：AC-08 验收目标单 ——
 *        `heat-batch-trace-verify` 对它 PATCH 炉号 + 草稿暂存写 inheritedFrom / 带出原值 /
 *        手工修改标记并回读断言，终判不落、脚本可复跑。
 *
 * 单号固定为当日 `-9xxx` 段：与真实取号池（`inspection_order_no_sequences` 的当日流水）互不干扰，
 * 也永远不会被真实建单命中；重复执行先删同名 TEST 行再写，结果幂等。
 */
const HEAT_TRACE_DEMO_SPECS: readonly HeatTraceDemoSpec[] = [
  {
    orderNo: 'OQC-HT-20260923-9101',
    inspectionType: 'OQC_HEAT',
    batchNo: `${HEAT_TRACE_DEMO_BATCH_PREFIX}HT-001A`,
    furnaceHeatNo: DEMO_HEAT_L1,
    status: 'COMPLETED',
    overallDecision: 'PASSED',
    materialFamily: 'BOLT',
    sampleQty: 8,
    totalQty: 500,
    inspectedDate: '2026-09-08',
    decidedAt: '2026-09-08T02:00:00.000Z',
    purpose: '组①：L1 源单（最早终判，AC-05 应排除）',
  },
  {
    orderNo: 'OQC-HT-20260923-9102',
    inspectionType: 'OQC_HEAT',
    batchNo: `${HEAT_TRACE_DEMO_BATCH_PREFIX}HT-001B`,
    furnaceHeatNo: DEMO_HEAT_L1,
    status: 'COMPLETED',
    overallDecision: 'PASSED',
    materialFamily: 'BOLT',
    sampleQty: 8,
    totalQty: 520,
    inspectedDate: '2026-09-15',
    decidedAt: '2026-09-15T02:00:00.000Z',
    purpose: '组①：L1 源单（中间一次终判，AC-05 应排除）',
  },
  {
    orderNo: 'OQC-HT-20260923-9103',
    inspectionType: 'OQC_HEAT',
    batchNo: `${HEAT_TRACE_DEMO_BATCH_PREFIX}HT-001C`,
    furnaceHeatNo: DEMO_HEAT_L1,
    status: 'COMPLETED',
    overallDecision: 'PASSED',
    materialFamily: 'BOLT',
    sampleQty: 8,
    totalQty: 480,
    inspectedDate: '2026-09-20',
    decidedAt: '2026-09-20T02:00:00.000Z',
    purpose: '组①：L1 源单（最近一次终判，AC-05 应命中这张）',
  },
  {
    orderNo: 'IQC-20260923-9001',
    inspectionType: 'IQC',
    batchNo: `${HEAT_TRACE_DEMO_BATCH_PREFIX}IQC-001`,
    furnaceHeatNo: DEMO_HEAT_L1,
    status: 'PASSED',
    overallDecision: 'PASSED',
    materialFamily: 'IQC_A',
    sampleQty: 5,
    totalQty: 1200,
    inspectedDate: '2026-09-05',
    decidedAt: '2026-09-05T02:00:00.000Z',
    purpose: '组①：L2 源单（L1 命中时不得混入它的指标项，验 AC-02）',
  },
  {
    orderNo: 'OQC-SH-20260923-9001',
    inspectionType: 'OQC_SH',
    batchNo: `${HEAT_TRACE_DEMO_BATCH_PREFIX}SH-001`,
    furnaceHeatNo: DEMO_HEAT_L1,
    status: 'INSPECTING',
    overallDecision: null,
    materialFamily: 'BOLT',
    sampleQty: 20,
    totalQty: 1000,
    inspectedDate: '2026-09-23',
    decidedAt: '2026-09-23T01:00:00.000Z',
    purpose: '组①：出货检验目标单（炉批号填进去即命中 L1）',
  },
  {
    orderNo: 'IQC-20260923-9002',
    inspectionType: 'IQC',
    batchNo: `${HEAT_TRACE_DEMO_BATCH_PREFIX}IQC-002`,
    furnaceHeatNo: DEMO_HEAT_L2,
    status: 'PASSED',
    overallDecision: 'PASSED',
    materialFamily: 'IQC_B',
    sampleQty: 5,
    totalQty: 800,
    inspectedDate: '2026-09-12',
    decidedAt: '2026-09-12T02:00:00.000Z',
    purpose: '组②：唯一源单（只有 IQC，验 AC-03 回退 L2）',
  },
  {
    orderNo: 'OQC-SH-20260923-9003',
    inspectionType: 'OQC_SH',
    batchNo: `${HEAT_TRACE_DEMO_BATCH_PREFIX}SH-003`,
    furnaceHeatNo: DEMO_HEAT_NONE,
    status: 'INSPECTING',
    overallDecision: null,
    materialFamily: 'BOLT',
    sampleQty: 20,
    totalQty: 600,
    inspectedDate: '2026-09-23',
    decidedAt: '2026-09-23T01:00:00.000Z',
    purpose: '组③：出货检验目标单（上游两处均无记录，验 AC-04）',
  },
  {
    orderNo: 'OQC-HT-20260923-9104',
    inspectionType: 'OQC_HEAT',
    batchNo: `${HEAT_TRACE_DEMO_BATCH_PREFIX}HT-001D`,
    furnaceHeatNo: DEMO_HEAT_L1,
    status: 'IN_MRB_REVIEW',
    overallDecision: 'FAILED',
    materialFamily: 'BOLT',
    sampleQty: 8,
    totalQty: 460,
    inspectedDate: '2026-09-18',
    decidedAt: '2026-09-18T02:00:00.000Z',
    purpose: '组①：同炉 MRB 未结案记录（TBD-01：带出照常 + UPSTREAM_UNDER_MRB 提示；不参与带出，故不影响 AC-05）',
  },
  {
    orderNo: 'OQC-HT-20260923-9105',
    inspectionType: 'OQC_HEAT',
    batchNo: `${HEAT_TRACE_DEMO_BATCH_PREFIX}HT-004A`,
    furnaceHeatNo: DEMO_HEAT_FAILED,
    status: 'FAILED',
    overallDecision: 'FAILED',
    materialFamily: 'BOLT',
    sampleQty: 8,
    totalQty: 400,
    inspectedDate: '2026-09-19',
    decidedAt: '2026-09-19T02:00:00.000Z',
    purpose: '组④：同炉不合格记录（TBD-01：空态 + UPSTREAM_FAILED 提示，不带出任何值）',
  },
  {
    orderNo: 'OQC-SH-20260923-9004',
    inspectionType: 'OQC_SH',
    batchNo: `${HEAT_TRACE_DEMO_BATCH_PREFIX}SH-004`,
    furnaceHeatNo: DEMO_HEAT_FAILED,
    status: 'INSPECTING',
    overallDecision: null,
    materialFamily: 'BOLT',
    sampleQty: 20,
    totalQty: 700,
    inspectedDate: '2026-09-23',
    decidedAt: '2026-09-23T01:00:00.000Z',
    purpose: '组④：出货检验目标单（同炉不合格 -> 界面为「空态 + 同炉不合格提示」）',
  },
  {
    orderNo: 'OQC-SH-20260923-9005',
    inspectionType: 'OQC_SH',
    batchNo: `${HEAT_TRACE_DEMO_BATCH_PREFIX}SH-AC08`,
    furnaceHeatNo: '',
    status: 'INSPECTING',
    overallDecision: null,
    materialFamily: 'BOLT',
    sampleQty: 20,
    totalQty: 300,
    inspectedDate: '2026-09-23',
    decidedAt: '2026-09-23T01:00:00.000Z',
    purpose: '组⑤：AC-08 inheritedFrom 留痕验收目标单（验收脚本写入带出标记 + 手工修改标记，终判不落）',
  },
];

/**
 * 播种 docs/47 §3.8 的炉批号关联链路演示单（`pnpm db:demo:heat-trace`）。
 *
 * 三条硬约束（本次追加约束的直接落地）：
 *   ① 新增单一律 `batch_no` 前缀 `TEST2609-`、炉批号 `TEST-` 开头 —— 可被 `pnpm db:test:purge` 一次清干净；
 *   ② 方案一律经 `findActivePlan` 反向验证，快照 / 指标行由 `order-builders` 同一实现生成 —— 不编造、不改主数据；
 *   ③ 只碰本组固定单号且带 TEST 前缀的行：删除前若发现同号行不带 TEST 前缀，立即中止（绝不删真实行）。
 */
async function seedHeatTraceDemo(ctx: {
  orderRepo: KyselyInspectionOrderRepository;
  planRepo: KyselyInspectionPlanRepository;
  materials: ReadonlyMap<string, MaterialRef>;
  dryRun: boolean;
}): Promise<number> {
  // 1. 解析物料族绑定的方案（全部走建单链路的同一套两级匹配）
  const boltHeat = await pickCoveringPlan(ctx.planRepo, ctx.materials, 'OQC_HEAT');
  if (boltHeat === null) {
    console.log('[demo-inspections] 播种中止：库中没有"能用且自洽"的 OQC_HEAT 方案（需先有 ACTIVE 且非空的方案版本）');
    return 1;
  }
  const boltShip = await resolvePlanForMaterial(
    ctx.planRepo,
    ctx.materials,
    boltHeat.material.materialCode,
    'OQC_SH'
  );
  const iqcPlans = await pickCoveringPlans(ctx.planRepo, ctx.materials, 'IQC', 2);
  if (boltShip === null || iqcPlans.length < 2) {
    console.log(
      `[demo-inspections] 播种中止：需要"同一个成品物料上既有 OQC_HEAT 又有 OQC_SH 方案"且"至少 2 套 IQC 方案"，` +
        `当前 OQC_SH=${boltShip === null ? '缺失' : boltShip.plan.planCode}、IQC 可用 ${iqcPlans.length} 套`
    );
    return 1;
  }

  const bindings = new Map<string, BoundPlan>();
  bindings.set('OQC_HEAT/BOLT', boltHeat);
  bindings.set('OQC_SH/BOLT', boltShip);
  const [iqcFirst, iqcSecond] = iqcPlans;
  if (iqcFirst === undefined || iqcSecond === undefined) {
    return 1;
  }
  bindings.set('IQC/IQC_A', iqcFirst);
  bindings.set('IQC/IQC_B', iqcSecond);

  console.log(
    `[demo-inspections] 播种方案绑定：OQC_HEAT=${boltHeat.plan.planCode}（物料 ${boltHeat.material.materialCode}）、` +
      `OQC_SH=${boltShip.plan.planCode}、IQC_A=${iqcFirst.plan.planCode}（物料 ${iqcFirst.material.materialCode}）、` +
      `IQC_B=${iqcSecond.plan.planCode}（物料 ${iqcSecond.material.materialCode}）`
  );

  // 2. 单号占用体检：同号行若不带 TEST 前缀 -> 立刻中止（真实行绝不删、绝不覆盖）
  const demoOrderNos = HEAT_TRACE_DEMO_SPECS.map((spec) => spec.orderNo);
  const occupied = await db
    .selectFrom('inspectionOrders')
    .select(['orderNo', 'batchNo'])
    .where('orderNo', 'in', demoOrderNos)
    .execute();
  const foreignRows = occupied.filter(
    (row) => !row.batchNo.startsWith(HEAT_TRACE_DEMO_BATCH_PREFIX)
  );
  if (foreignRows.length > 0) {
    console.log('[demo-inspections] 播种中止：以下演示单号已被非 TEST 行占用（需人工核对，脚本不擅自覆盖）');
    for (const row of foreignRows) {
      console.log(`  - ${row.orderNo} 批次 ${row.batchNo}`);
    }
    return 1;
  }

  // 3. 构造 + 契约校验（fail-closed：校验不过就不写库）
  const prepared: Array<{ spec: HeatTraceDemoSpec; order: InspectionOrder; createdAt: Date }> = [];
  const problems: string[] = [];
  for (const spec of HEAT_TRACE_DEMO_SPECS) {
    const binding = bindings.get(`${spec.inspectionType}/${spec.materialFamily}`);
    if (binding === undefined) {
      problems.push(`${spec.orderNo}：物料族 ${spec.materialFamily} 没有可用方案`);
      continue;
    }
    const versionId = binding.version.id ?? binding.plan.id;
    if (versionId === undefined) {
      problems.push(`${spec.orderNo}：方案 ${binding.plan.planCode} 缺少版本行 UUID`);
      continue;
    }

    const itemKind = itemResultKindOf(spec.overallDecision);
    const { passQty, failQty } = deriveQty(spec.sampleQty, itemKind);
    const decidedMs = Date.parse(spec.decidedAt);
    const createdAt = new Date(decidedMs - 3_600_000);

    const order: InspectionOrder = {
      orderNo: spec.orderNo,
      inspectionType: spec.inspectionType,
      materialCode: binding.material.materialCode,
      materialName: binding.material.materialName,
      batchNo: spec.batchNo,
      furnaceHeatNo: spec.furnaceHeatNo,
      ...(binding.material.specModel !== null && binding.material.specModel !== ''
        ? { specification: binding.material.specModel }
        : {}),
      unit: binding.material.unit,
      sampleQty: spec.sampleQty,
      totalQty: spec.totalQty,
      passQty,
      failQty,
      isMandatoryGate: spec.inspectionType === 'OQC_SH',
      status: spec.status,
      ...(spec.overallDecision !== null ? { overallDecision: spec.overallDecision } : {}),
      inspectedDate: spec.inspectedDate,
      planVersionId: versionId,
      planSnapshot: buildSnapshot(
        { planCode: binding.plan.planCode, planName: binding.plan.planName },
        {
          id: versionId,
          versionNo: binding.version.versionNo,
          items: binding.version.items,
          ...(binding.version.samplingScheme !== undefined
            ? { samplingScheme: binding.version.samplingScheme }
            : {}),
          ...(binding.version.aqlLevel !== undefined ? { aqlLevel: binding.version.aqlLevel } : {}),
          ...(binding.version.strictness !== undefined
            ? { strictness: binding.version.strictness }
            : {}),
        },
        createdAt.toISOString()
      ),
      items: buildOrderItems(binding.version.items, itemKind),
      createdAt: createdAt.toISOString(),
      updatedAt: new Date(decidedMs).toISOString(),
    };

    const parsed = InspectionOrderSchema.safeParse(order);
    if (!parsed.success) {
      problems.push(
        `${spec.orderNo}：播种前契约校验未通过（${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join(' | ')}）`
      );
      continue;
    }
    prepared.push({ spec, order: parsed.data, createdAt });
  }

  if (problems.length > 0) {
    console.log('[demo-inspections] 播种中止：以下演示单构造失败（未写入任何数据）');
    for (const problem of problems) {
      console.log(`  - ${problem}`);
    }
    return 1;
  }

  // 4. 写入（先删同名 TEST 行再插，保证重复执行幂等；时间列随后按 spec 归位）
  if (ctx.dryRun) {
    console.log(`[demo-inspections] 试算：将写入 ${prepared.length} 张演示单（dry-run 未写库）`);
  } else {
    for (const { spec, order } of prepared) {
      await db
        .deleteFrom('inspectionOrders')
        .where('orderNo', '=', spec.orderNo)
        .where('batchNo', 'like', `${HEAT_TRACE_DEMO_BATCH_PREFIX}%`)
        .execute();
      await ctx.orderRepo.save(order);
    }
    for (const { spec } of prepared) {
      const decidedMs = Date.parse(spec.decidedAt);
      await db
        .updateTable('inspectionOrders')
        .set({
          createdAt: new Date(decidedMs - 3_600_000),
          updatedAt: new Date(decidedMs),
          inspectedDate: spec.inspectedDate,
        })
        .where('orderNo', '=', spec.orderNo)
        .where('batchNo', 'like', `${HEAT_TRACE_DEMO_BATCH_PREFIX}%`)
        .execute();
    }
    console.log(`[demo-inspections] 已写入 ${prepared.length} 张演示单`);
  }

  for (const { spec } of prepared) {
    console.log(`  [演示单] ${spec.orderNo} [${spec.inspectionType}] 批次 ${spec.batchNo} 炉批号 ${spec.furnaceHeatNo} —— ${spec.purpose}`);
  }

  // 5. 落库后重新读一遍再判定：结论来自库里真实数据，不是"我调了 save() 所以应该好了"
  if (ctx.dryRun) {
    return 0;
  }
  console.log('[demo-inspections] 播种后按真实查询口径复核三级链路：');
  for (const demo of HEAT_TRACE_DEMO_HEAT_NOS) {
    const candidates = await ctx.orderRepo.findByFurnaceHeatNo(demo.heatNo);
    const trace = HeatBatchTraceService.resolveHeatBatchData({
      heatBatchNo: demo.heatNo,
      historicalOrders: candidates,
    });
    console.log(
      `  - ${demo.heatNo} 命中候选 ${candidates.length} 张 -> sourceType=${trace.sourceType} ` +
        `源单=${trace.sourceOrderNo ?? '-'} 带出项=${trace.inheritedItems.length} 项｜${demo.expectation}`
    );
  }
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const orderRepo = new KyselyInspectionOrderRepository(db);
  const planRepo = new KyselyInspectionPlanRepository(db);
  const materials = await loadMaterials();

  const orders = await orderRepo.findAll();
  const violations = orders
    .map((order) => ({ order, reasons: violationReasons(order) }))
    .filter((entry) => entry.reasons.length > 0);

  console.log(
    `[demo-inspections] 模式=${args.mode} 演示批次前缀=${args.demoBatchPrefixes.join(',') || '(无)'} dryRun=${args.dryRun}`
  );
  console.log(
    `[demo-inspections] 检验单共 ${orders.length} 张，违规 ${violations.length} 张`
  );
  for (const { order, reasons } of violations) {
    console.log(`  - ${order.orderNo} [${order.inspectionType}] 批次 ${order.batchNo}：${reasons.join('；')}`);
  }

  if (args.mode === 'seed') {
    return await seedHeatTraceDemo({
      orderRepo,
      planRepo,
      materials,
      dryRun: args.dryRun,
    });
  }

  if (args.mode === 'check') {
    if (violations.length === 0) {
      console.log('[demo-inspections] 体检通过：全部检验单都带着合规的方案快照与指标行');
      return 0;
    }
    console.log('[demo-inspections] 体检未通过：先跑 `pnpm db:demo:repair` 按建单口径补齐，再复查');
    return 1;
  }

  let repaired = 0;
  const problems: string[] = [];
  for (const { order } of violations) {
    const outcome = await repairOrder(order, {
      orderRepo,
      planRepo,
      materials,
      demoBatchPrefixes: args.demoBatchPrefixes,
      dryRun: args.dryRun,
    });
    switch (outcome.kind) {
      case 'repaired':
        repaired += 1;
        console.log(
          `  [修复] ${order.orderNo} → 方案 ${outcome.planCode}，指标行 ${outcome.itemCount} 项` +
            (outcome.realignedTo === null
              ? ''
              : `，物料按方案覆盖范围归位为 ${outcome.realignedTo}`)
        );
        break;
      case 'no-plan':
        problems.push(`${order.orderNo}：物料 [${order.materialCode}] + 检验类型 [${order.inspectionType}] 无 ACTIVE 方案可依（非演示行不擅改物料）`);
        break;
      case 'no-active-version':
        problems.push(`${order.orderNo}：方案 [${outcome.planCode}] 没有 ACTIVE 且非空的版本`);
        break;
      case 'still-invalid':
        problems.push(`${order.orderNo}：补齐后仍不符合契约（${outcome.detail}）`);
        break;
    }
  }

  console.log(
    `[demo-inspections] ${args.dryRun ? '试算' : '已修复'} ${repaired} 张；无法自动处理的 ${problems.length} 张`
  );
  for (const problem of problems) {
    console.log(`  [待人工] ${problem}`);
  }

  if (args.dryRun) {
    return problems.length === 0 && repaired === violations.length ? 0 : 1;
  }

  // 写库后**重新读一遍**再判定：结论来自库里真实数据，不是"我调了 save() 所以应该好了"
  const after = await orderRepo.findAll();
  const remaining = after
    .map((order) => ({ order, reasons: violationReasons(order) }))
    .filter((entry) => entry.reasons.length > 0);
  console.log(`[demo-inspections] 复查：剩余违规 ${remaining.length} 张`);
  for (const { order, reasons } of remaining) {
    console.log(`  - ${order.orderNo}：${reasons.join('；')}`);
  }
  return remaining.length === 0 ? 0 : 1;
}

(async () => {
  try {
    const code = await main();
    await db.destroy();
    process.exit(code);
  } catch (err: unknown) {
    const message = (err as { message?: string })?.message ?? String(err);
    console.error(`[demo-inspections] 失败：${message}`);
    try {
      await db.destroy();
    } catch {
      /* 关闭失败不影响退出码 */
    }
    process.exit(2);
  }
})();
