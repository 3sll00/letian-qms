/**
 * @letian/contracts - RFC 7807 统一错误模型与小写短横线规范错误码字典
 */

export * from '../schemas/error';

/**
 * 统一错误码字典 (采用 kebab-case 规范，确保与 RFC 7807 type 属性标准小写 URI 对齐)
 */
export const ErrorCode = {
  // 基础校验与通用错误
  VALIDATION_FAILED: 'validation-failed',
  RESOURCE_NOT_FOUND: 'resource-not-found',
  CONFLICT: 'conflict',
  INTERNAL_SERVER_ERROR: 'internal-server-error',
  BAD_REQUEST: 'bad-request',

  // 认证与权限 (PBAC)
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  PBAC_PERMISSION_DENIED: 'pbac-permission-denied',
  TOKEN_EXPIRED: 'token-expired',

  // 检验单与质检方案
  INSPECTION_NOT_FOUND: 'inspection-not-found',
  INSPECTION_PLAN_NOT_FOUND: 'inspection-plan-not-found',
  INSPECTION_PLAN_NOT_ACTIVE: 'inspection-plan-not-active',
  INSPECTION_ALREADY_COMPLETED: 'inspection-already-completed',
  INVALID_INSPECTION_STATUS: 'invalid-inspection-status',
  INVALID_MEASURED_DATA: 'invalid-measured-data',

  // MRB 不合格品评审流
  MRB_REVIEW_NOT_FOUND: 'mrb-review-not-found',
  MRB_ALREADY_CLOSED: 'mrb-already-closed',
  MRB_CONCESSION_REQUIRES_CUSTOMER_APPROVAL: 'mrb-concession-requires-customer-approval',
  MRB_STEP_NOT_MATCHED: 'mrb-step-not-matched',

  // 成品放行关卡阻断 (MANDATORY_GATE)
  GATE_NOT_INSPECTED: 'gate-not-inspected',
  GATE_INSPECTING: 'gate-inspecting',
  GATE_FAILED: 'gate-failed',
  GATE_UNDER_MRB: 'gate-under-mrb',
  BATCH_LOCKED: 'batch-locked',

  // 批次追溯与集成
  BATCH_NOT_FOUND: 'batch-not-found',
  TRACE_CYCLE_DETECTED: 'trace-cycle-detected',
  ERP_SYNC_FAILED: 'erp-sync-failed',
  MES_GATEWAY_TIMEOUT: 'mes-gateway-timeout',
  IDEMPOTENCY_CONFLICT: 'idempotency-conflict',
} as const;

export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];
