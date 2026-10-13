import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * 职员独立登录口令（迁移 048 employees.password_hash）
 *
 * 实现选型：Node 内置 `crypto.scrypt`，零第三方依赖（Windows 车间部署
 * 不需要 bcrypt/argon2 的原生编译链）。存储格式自描述：
 *
 *   `scrypt:<N>:<r>:<p>:<salt_hex>:<hash_hex>`
 *
 * 校验侧先解析参数再计算，参数未来上调时存量哈希仍可校验。
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const FORMAT_PREFIX = 'scrypt';

/** 生成口令哈希（每次随机盐） */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(plain, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    FORMAT_PREFIX,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('hex'),
    derived.toString('hex'),
  ].join(':');
}

/**
 * 校验口令与存储哈希是否匹配。
 * 格式不符 / 长度不等一律返回 false（恒定时间比对在长度一致时才启用）。
 */
export function verifyPassword(plain: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  const [prefix, nStr, rStr, pStr, saltHex, hashHex] = parts;
  if (parts.length !== 6 || prefix !== FORMAT_PREFIX || !saltHex || !hashHex) return false;

  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;

  const derived = scryptSync(plain, salt, KEY_LENGTH, { N: n, r, p });
  return timingSafeEqual(derived, expected);
}
