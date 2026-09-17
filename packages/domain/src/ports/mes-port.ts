import { OutboxEvent } from '@letian/contracts';

export interface GateCheckResult {
  allowed: boolean;
  code: 'GATE_RELEASED' | 'GATE_NOT_INSPECTED' | 'GATE_INSPECTING' | 'GATE_FAILED' | 'GATE_UNDER_MRB';
  reason?: string;
  orderNo?: string;
}

/**
 * MES 生产工序控制集成输出端口 (MesPort)
 * 双轨制拦截规范：
 * 1. 同步准入校验 (checkReleaseGate)：向 MES 工单/下料/包装/入库节点返回校验判定；
 * 2. 异步 Outbox 广播 (publishOutboxEvents)：当成品检门禁不合格或处于 MRB 冻结状态时，将 BATCH_LOCKED / BATCH_RELEASED 事件推入事务外件箱。
 */
export interface MesPort {
  /**
   * 同步拦截/放行判定：根据批次号与工序关卡，判定当前流转是否允许放行
   */
  checkReleaseGate(params: {
    batchNo: string;
    stage: 'BLANKING' | 'THREADING' | 'FINAL_GATE' | 'WAREHOUSE_ENTRY';
  }): Promise<GateCheckResult>;

  /**
   * 批次锁定/解锁状态变更通知（或写入 Outbox 事件队列）
   */
  notifyBatchLockStatus(event: OutboxEvent): Promise<void>;
}
