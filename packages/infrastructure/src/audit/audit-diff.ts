/**
 * 单条字段级变更项（契约 @letian/contracts 未导出该形状，故在基础设施层就地声明）
 */
export interface AuditChangeItem {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * 敏感字段脱敏规则配置
 */
const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /credential/i,
  /phone/i,
  /email/i,
  /contact/i,
];

/**
 * 判断字段名是否属于敏感字段
 */
export function isSensitiveField(field: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(field));
}

/**
 * 敏感值脱敏处理
 */
export function maskValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    if (value.length <= 4) {
      return '****';
    }
    const visibleChars = Math.min(2, Math.floor(value.length / 4));
    return `${value.slice(0, visibleChars)}****${value.slice(-visibleChars)}`;
  }
  if (typeof value === 'number') {
    return '***';
  }
  return '[MASKED]';
}

/**
 * 计算两个对象之间的差异 (JSON Diff Patch)
 * @param oldObj 变更前对象 (浅层或深层)
 * @param newObj 变更后对象 (浅层或深层)
 * @param options.maskSensitive 是否对敏感字段进行脱敏处理，默认 true
 */
export function calculateJsonDiff(
  oldObj: Record<string, unknown> | null | undefined,
  newObj: Record<string, unknown> | null | undefined,
  options: { maskSensitive?: boolean } = { maskSensitive: true }
): AuditChangeItem[] {
  const diffs: AuditChangeItem[] = [];

  const safeOld = oldObj || {};
  const safeNew = newObj || {};

  const allKeys = Array.from(new Set([...Object.keys(safeOld), ...Object.keys(safeNew)]));

  for (const field of allKeys) {
    const oldValue = safeOld[field];
    const newValue = safeNew[field];

    // 比较两者的序列化结果以判断是否变化
    const oldStr = JSON.stringify(oldValue);
    const newStr = JSON.stringify(newValue);

    if (oldStr !== newStr) {
      const isSens = options.maskSensitive && isSensitiveField(field);

      diffs.push({
        field,
        oldValue: isSens ? maskValue(oldValue) : oldValue,
        newValue: isSens ? maskValue(newValue) : newValue,
      });
    }
  }

  return diffs;
}

/**
 * 防篡改触发器 DDL 常量，供迁移或验证时引用
 */
export const AUDIT_TAMPER_PROTECTION_TRIGGER_SQL = `
CREATE OR REPLACE FUNCTION prevent_audit_log_tampering()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'PERMISSION DENIED: audit_logs is append-only and immutable. UPDATE and DELETE are strictly forbidden.'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_tamper_protection ON audit_logs;
CREATE TRIGGER audit_logs_tamper_protection
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_log_tampering();
`;
