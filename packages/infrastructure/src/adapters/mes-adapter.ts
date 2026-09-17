import { Kysely } from 'kysely';
import type { GateCheckResult, MesPort } from '@letian/domain';
import type { OutboxEvent } from '@letian/contracts';
import type { Database } from '../database/schema.js';
import { KyselyOutboxRepository } from '../repositories/outbox-repository.js';

export interface MesAdapterConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * MES 集成适配器：双轨制拦截。
 *
 * 1. 同步准入校验 checkReleaseGate：直接读取本地检验工单镜像表判定能否放行；
 * 2. 异步广播 notifyBatchLockStatus：写入 Outbox 事件，由派发任务投递给 MES。
 */
export class MesAdapter implements MesPort {
  private readonly outbox: KyselyOutboxRepository;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly config: MesAdapterConfig = {
      baseUrl: 'http://localhost:8080/mes/api',
      timeoutMs: 5000,
    }
  ) {
    this.outbox = new KyselyOutboxRepository(db);
  }

  /** 读取该批次最新的检验工单，判定当前关卡是否允许放行 */
  public async checkReleaseGate(params: {
    batchNo: string;
    stage: 'BLANKING' | 'THREADING' | 'FINAL_GATE' | 'WAREHOUSE_ENTRY';
  }): Promise<GateCheckResult> {
    const row = await this.db
      .selectFrom('inspectionOrders')
      .selectAll()
      .where('batchNo', '=', params.batchNo)
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();

    if (!row) {
      return {
        allowed: false,
        code: 'GATE_NOT_INSPECTED',
        reason: `批次 [${params.batchNo}] 尚无检验工单记录`,
      };
    }

    const base = { orderNo: row.orderNo };

    // 终判为合格或让步接收（特采放行）时才真正放行
    if (row.judgment === 'PASSED' || row.judgment === 'CONCESSION') {
      return { allowed: true, code: 'GATE_RELEASED', ...base };
    }

    if (row.status === 'PASSED' || row.status === 'COMPLETED') {
      return { allowed: true, code: 'GATE_RELEASED', ...base };
    }

    if (row.status === 'IN_MRB_REVIEW') {
      return {
        allowed: false,
        code: 'GATE_UNDER_MRB',
        reason: `批次 [${params.batchNo}] 处于 MRB 会签冻结中`,
        ...base,
      };
    }

    if (row.status === 'FAILED' || row.judgment === 'FAILED') {
      return {
        allowed: false,
        code: 'GATE_FAILED',
        reason: `批次 [${params.batchNo}] 检验判定不合格`,
        ...base,
      };
    }

    return {
      allowed: false,
      code: 'GATE_INSPECTING',
      reason: `批次 [${params.batchNo}] 检验尚未完成（当前状态 ${row.status}）`,
      ...base,
    };
  }

  /** 批次锁定/解锁通知：以 Outbox 事件形式落入本地事务外件箱 */
  public async notifyBatchLockStatus(event: OutboxEvent): Promise<void> {
    await this.outbox.append({
      id: event.id,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
      traceId: event.traceId,
      occurredAt: new Date(event.occurredAt),
      // 新写入的事件一律为待投递状态，由 Outbox 派发任务接管后续状态流转
      status: 'PENDING',
      retryCount: 0,
    });
  }

  /** 用于日志标识当前配置；不参与拦截判定逻辑 */
  public getBaseUrl(): string {
    return this.config.baseUrl;
  }
}
