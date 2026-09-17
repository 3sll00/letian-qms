/**
 * PostgreSQL 咨询锁端口 (用于业务排他与放行校验)
 *
 * 采用 pg_advisory_xact_lock 语义：锁自动绑定在当前数据库事务生命周期中，
 * 事务 COMMIT 或 ROLLBACK 时由数据库自动释放，无需手动 unlock，避免死锁与连接泄漏。
 */
export interface ILockPort {
  /**
   * 针对字符串标识（如 batchNo）计算 64 位整型 hash 并获取事务级排他咨询锁
   * 底层等价于 SELECT pg_advisory_xact_lock(hashtext(lockKey))
   */
  acquireXactLock(lockKey: string): Promise<void>;

  /**
   * 针对两个 32 位整型参数获取事务级排他咨询锁
   * 底层等价于 SELECT pg_advisory_xact_lock(classId, objId)
   */
  acquireXactLock2(classId: number, objId: number): Promise<void>;
}
