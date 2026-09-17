/**
 * 统一的 REST 客户端。
 *
 * 后端业务路由全部挂载在 `/api/v1` 之下并要求 JWT（`fastify.authenticate`），
 * 因此这里集中处理三件事，页面只关心路径与返回值：
 * 1. 相对路径拼接 `/api/v1` 前缀（开发态由 Vite `server.proxy` 转发到 API 进程）；
 * 2. 开发态登录取令牌并缓存，请求自动附带 `Authorization: Bearer`；
 *   收到 401 时清掉缓存令牌重登一次（令牌过期/后端重启场景）；
 * 3. RFC 7807 `application/problem+json` 错误体统一收敛为 ApiError，
 *    页面只需读取 message 即可展示后端给出的业务原因。
 */
import type { z } from 'zod';
import type { ProblemDetailsSchema } from '@letian/contracts';

/** 后端 RFC 7807 错误体（Zod schema 为唯一真理源，这里只取其推导类型） */
type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

/** 与后端路由前缀保持一致（apps/api/src/app.ts 中的 securedScope 前缀） */
export const API_BASE = '/api/v1';

/** 开发态登录身份：后端 POST /api/v1/auth/login 在 NODE_ENV=production 时不会注册 */
const DEV_LOGIN_PATH = '/auth/login';

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;
  public readonly detail: unknown;

  constructor(status: number, message: string, code?: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

let tokenPromise: Promise<string> | null = null;

/** 取开发态令牌（并发调用共享同一个请求） */
function loadToken(): Promise<string> {
  if (tokenPromise === null) {
    tokenPromise = fetch(`${API_BASE}${DEV_LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new ApiError(res.status, '开发态登录失败：请确认后端服务已启动');
        }
        const data = (await res.json()) as { token?: string };
        if (!data.token) {
          throw new ApiError(500, '开发态登录响应缺少 token 字段');
        }
        return data.token;
      })
      .catch((err: unknown) => {
        // 失败不缓存，允许下次请求重试
        tokenPromise = null;
        throw err;
      });
  }
  return tokenPromise;
}

function resetToken(): void {
  tokenPromise = null;
}

/** 拼装查询串，忽略 undefined / 空串，避免出现 `?type=&keyword=` 这类空参数 */
export function buildQuery(params?: Record<string, string | number | undefined>): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

async function parseErrorResponse(res: Response): Promise<ApiError> {
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }

  const problem = body as Partial<ProblemDetails> | undefined;
  const message =
    (problem && typeof problem.detail === 'string' && problem.detail) ||
    (problem && typeof problem.title === 'string' && problem.title) ||
    (typeof body === 'string' && body) ||
    `请求失败 (HTTP ${res.status})`;

  const code = problem && typeof problem.code === 'string' ? problem.code : undefined;
  return new ApiError(res.status, message, code, body);
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** 需要原始文本（如 CSV 导出）时置 true */
  rawText?: boolean;
  /** 内部递归标记：401 重试用，避免无限循环 */
  retried?: boolean;
}

async function request<T>(options: RequestOptions): Promise<T> {
  const token = await loadToken();
  const url = `${API_BASE}${options.path}${buildQuery(options.query)}`;

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const init: RequestInit = { method: options.method, headers };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, init);

  if (res.status === 401 && options.retried !== true) {
    resetToken();
    return request<T>({ ...options, retried: true });
  }

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  if (options.rawText === true) {
    return (await res.text()) as unknown as T;
  }

  if (res.status === 204) {
    return undefined as unknown as T;
  }

  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, query?: Record<string, string | number | undefined>) =>
    request<T>({ method: 'GET', path, ...(query !== undefined ? { query } : {}) }),

  getText: (path: string, query?: Record<string, string | number | undefined>) =>
    request<string>({
      method: 'GET',
      path,
      rawText: true,
      ...(query !== undefined ? { query } : {}),
    }),

  post: <T>(path: string, body?: unknown) =>
    request<T>({ method: 'POST', path, ...(body !== undefined ? { body } : {}) }),

  put: <T>(path: string, body?: unknown) =>
    request<T>({ method: 'PUT', path, ...(body !== undefined ? { body } : {}) }),
};

/** 统一把未知异常转成可展示文案（ApiError 直接给出后端 detail） */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return '未知错误';
}
