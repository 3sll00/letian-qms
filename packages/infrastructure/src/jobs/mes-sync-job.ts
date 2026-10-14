/**
 * MES 自动同步调度作业（MesSyncJob）
 *
 * 背景：此前 MES 拉取只能靠人工调用 `POST /integration/sync/trigger`，
 *      没人点就永远不跑，导致「过程检验」看起来像没对接上。
 *      本作业把它改成随服务启动的后台周期调度。
 *
 * 设计要点：
 *   1. 周期调度用**递归 setTimeout**而非 setInterval：一次同步跑完再排下一次，
 *      避免 MES 网络慢时多轮叠加把连接池打满。
 *   2. 单次同步的任何异常都在 tick 内捕获并记录，**绝不让服务进程崩溃**；
 *      失败只是跳过本轮，下一轮照常重试。
 *   3. 默认 unref 定时器：作业不阻止进程退出，生命周期跟随 API 服务。
 *   4. demoMode（MES_SYNC_DEMO=1）：MES 不可达时用本地样例把「读取→映射→落库」
 *      整条管线真实跑通，便于无外网环境验证；落库备注带 [MES演示同步] 前缀以便区分。
 */
import { syncMesAll, syncMesDemoInspectionOrders } from '../adapters/mes-sync-service.js';

export type MesSyncMode = 'MES_REAL' | 'MES_DEMO';

export interface MesSyncJobResult {
  mode: MesSyncMode;
  ok: boolean;
  message: string;
}

export interface MesSyncJobOptions {
  /** 同步周期（毫秒），默认 5 分钟 */
  intervalMs?: number;
  /** 启动后是否立即跑一轮，默认 true */
  runOnStart?: boolean;
  /** 是否走本地演示数据源（MES 不可达时用它把管线跑通），默认 false */
  demoMode?: boolean;
  /** 单次拉取条数上限，默认 200 */
  limit?: number;
  /** 定时器是否 unref（不阻止进程退出），默认 true */
  unref?: boolean;
  /** 日志输出函数，默认 console.log */
  logger?: (message: string) => void;
}

export const DEFAULT_MES_SYNC_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_MES_SYNC_LIMIT = 200;

function numOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolOr(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

/** 从环境变量读取调度配置（未配置时给出安全默认值） */
export function readMesSyncOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): MesSyncJobOptions & { enabled: boolean } {
  return {
    enabled: boolOr(env.MES_SYNC_ENABLED, true),
    intervalMs: numOr(env.MES_SYNC_INTERVAL_MS, DEFAULT_MES_SYNC_INTERVAL_MS),
    runOnStart: boolOr(env.MES_SYNC_RUN_ON_START, true),
    demoMode: boolOr(env.MES_SYNC_DEMO, false),
    limit: numOr(env.MES_SYNC_LIMIT, DEFAULT_MES_SYNC_LIMIT),
    unref: boolOr(env.MES_SYNC_UNREF, true),
  };
}

export class MesSyncJob {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  public constructor(private readonly options: MesSyncJobOptions = {}) {}

  public get intervalMs(): number {
    return this.options.intervalMs ?? DEFAULT_MES_SYNC_INTERVAL_MS;
  }

  public get demoMode(): boolean {
    return this.options.demoMode ?? false;
  }

  public get isRunning(): boolean {
    return !this.stopped;
  }

  /** 单轮同步：演示模式走本地样例，否则连真实 MES */
  public async runOnce(): Promise<MesSyncJobResult> {
    const limit = this.options.limit ?? DEFAULT_MES_SYNC_LIMIT;

    if (this.demoMode) {
      const result = await syncMesDemoInspectionOrders(undefined, limit);
      return {
        mode: 'MES_DEMO',
        ok: true,
        message: `[演示数据源] 读取 ${result.total} 份，新增入库 ${result.inserted} 份`,
      };
    }

    const result = await syncMesAll(undefined, { limit });
    return {
      mode: 'MES_REAL',
      ok: result.success,
      message: result.success
        ? `工序字典 +${result.syncedWorkshops} / 检验单据 +${result.syncedInspectionOrders} / 追溯节点 +${result.syncedTraceNodes} / 委外回厂 +${result.syncedOutsourceReturns}（耗时 ${result.durationMs}ms）`
        : `同步失败：${result.details.join('；')}`,
    };
  }

  /** 启动调度（幂等，重复调用无效） */
  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.log(
      `[MES自动同步] 已启动：周期 ${this.intervalMs}ms，模式 ${this.demoMode ? 'MES演示数据' : 'MES真实库'}`
    );
    if (this.options.runOnStart ?? true) {
      void this.tick();
    } else {
      this.scheduleNext();
    }
  }

  /** 停止调度并清理定时器 */
  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log('[MES自动同步] 已停止');
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);
    if (this.options.unref ?? true) {
      timer.unref();
    }
    this.timer = timer;
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.runOnce();
      this.log(
        `[MES自动同步] ${result.ok ? '完成' : '失败'}（${result.mode}）${result.message}`
      );
    } catch (error: unknown) {
      // 单轮失败只记日志：作业继续存活，下一轮自动重试
      this.log(
        `[MES自动同步] 异常：${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.scheduleNext();
  }

  private log(message: string): void {
    (this.options.logger ?? console.log)(message);
  }
}
