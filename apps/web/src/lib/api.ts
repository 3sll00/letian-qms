/**
 * 统一的 REST 客户端。
 *
 * 后端业务路由全部挂载在 `/api/v1` 之下并要求 JWT（`fastify.authenticate`），
 * 因此这里集中处理三件事，页面只关心路径与返回值：
 * 1. 基址解析（`resolveApiBase`）：浏览器同源用相对路径，桌面端用「服务器设置」中配置的绝对地址；
 * 2. 开发态登录取令牌并缓存，请求自动附带 `Authorization: Bearer`；
 *   收到 401 时清掉缓存令牌重登一次（令牌过期/后端重启场景）；
 * 3. RFC 7807 `application/problem+json` 错误体统一收敛为 ApiError，
 *    页面只需读取 message 即可展示后端给出的业务原因。
 */
import type { z } from 'zod';
import type { ProblemDetailsSchema } from '@letian/contracts';

/** 后端 RFC 7807 错误体（Zod schema 为唯一真理源，这里只取其推导类型） */
type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

/**
 * 校验并归一化服务器地址：只接受 http/https；
 * 只填主机（如 http://192.168.1.10:3000）时自动补 /api/v1 路径；
 * 非法输入返回 null，由调用方继续回退到下一优先级。
 */
function normalizeServerUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim();
  if (text === '') return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.pathname === '' || url.pathname === '/') url.pathname = '/api/v1';
    // 去掉末尾斜杠，保证与 DEV_LOGIN_PATH 等相对路径可以直接字符串拼接
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * API 基地址解析优先级：
 * 1. 离线 Mock 构建（VITE_USE_MOCK=true）：恒定相对路径，让 MSW 在同源拦截；
 * 2. 桌面端运行时配置（window.desktop.getServerUrl，Electron「服务器设置」持久化）；
 * 3. 构建期环境变量 VITE_API_BASE（把服务器地址固化进产物的部署方式）；
 * 4. 相对路径 /api/v1（浏览器同源：开发态 Vite 代理、生产态 nginx 反代）。
 */
function resolveApiBase(): string {
  if (import.meta.env.VITE_USE_MOCK === 'true') return '/api/v1';
  const desktop = normalizeServerUrl(
    typeof window !== 'undefined' ? window.desktop?.getServerUrl?.() : undefined
  );
  if (desktop !== null) return desktop;
  const baked = normalizeServerUrl(import.meta.env.VITE_API_BASE);
  if (baked !== null) return baked;
  return '/api/v1';
}

/** 与后端路由前缀保持一致（apps/api/src/app.ts 中的 securedScope 前缀） */
export const API_BASE = resolveApiBase();

/** 开发态登录接口：后端 POST /api/v1/auth/login 在 NODE_ENV=production 时不会注册 */
const DEV_LOGIN_PATH = '/auth/login';
const AUTH_USERS_PATH = '/auth/users';

/** 登录会话（与后端 LoginResponse.user 对齐） */
export interface SessionUser {
  userId: string;
  userName: string;
  role: string;
  roleName?: string | undefined;
  activeRulesCount?: number | undefined;
}

/** 登录页可选用户（GET /auth/users，职员档案 + 主角色） */
export interface AuthUserOption {
  id: string;
  name: string;
  employeeCode?: string | undefined;
  department?: string | undefined;
  roleCode?: string | undefined;
  roleName?: string | undefined;
}

const TOKEN_STORAGE_KEY = 'letian_qms_token';
const USER_STORAGE_KEY = 'letian_qms_user';

/** 存储读写兜底：桌面端 file:// 或隐私模式下 localStorage 可能抛异常 */
function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readStoredSession(): { token: string | null; user: SessionUser | null } {
  const storage = safeStorage();
  if (storage === null) return { token: null, user: null };
  try {
    const token = storage.getItem(TOKEN_STORAGE_KEY);
    const raw = storage.getItem(USER_STORAGE_KEY);
    const user = raw !== null ? (JSON.parse(raw) as SessionUser) : null;
    return { token, user };
  } catch {
    return { token: null, user: null };
  }
}

/** 内存会话：登录/登出即变更，request() 从这里读令牌 */
let session = readStoredSession();

/** 当前登录用户；null 表示未登录（App 据此渲染登录页） */
export function getCurrentUser(): SessionUser | null {
  return session.user;
}

/** 订阅登录态变化（401 被动登出时通知 App 切回登录页） */
export function subscribeAuthChange(listener: (user: SessionUser | null) => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}
const authListeners = new Set<(user: SessionUser | null) => void>();

function emitAuthChange(): void {
  for (const listener of authListeners) {
    try {
      listener(session.user);
    } catch {
      /* 单个监听器异常不影响其他订阅者 */
    }
  }
}

function persistSession(token: string, user: SessionUser): void {
  session = { token, user };
  const storage = safeStorage();
  if (storage !== null) {
    try {
      storage.setItem(TOKEN_STORAGE_KEY, token);
      storage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
    } catch {
      /* 存储失败不阻断登录（内存会话仍然有效） */
    }
  }
  emitAuthChange();
}

/** 登录成功写入会话；后端 LoginResponse.user 缺字段时以兜底值补全 */
function acceptLogin(data: { token?: string; user?: Partial<SessionUser> & { userId?: string; userName?: string; role?: string } }): SessionUser {
  if (typeof data.token !== 'string' || data.token === '') {
    throw new ApiError(500, '登录响应缺少 token 字段');
  }
  const user: SessionUser = {
    userId: data.user?.userId ?? '00000000-0000-0000-0000-000000000000',
    userName: data.user?.userName ?? '未知用户',
    role: data.user?.role ?? 'GUEST',
    ...(data.user?.roleName !== undefined ? { roleName: data.user.roleName } : {}),
    ...(data.user?.activeRulesCount !== undefined ? { activeRulesCount: data.user.activeRulesCount } : {}),
  };
  persistSession(data.token, user);
  return user;
}

/** 登录页：拉取可选职员列表 */
export async function fetchAuthUsers(): Promise<AuthUserOption[]> {
  const res = await fetch(`${API_BASE}${AUTH_USERS_PATH}`);
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return (await res.json()) as AuthUserOption[];
}

/** 登录页：按职员 UUID 一键登录 */
export async function loginUser(userId: string): Promise<SessionUser> {
  const res = await fetch(`${API_BASE}${DEV_LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return acceptLogin((await res.json()) as { token?: string; user?: Partial<SessionUser> });
}

/**
 * 登录页主路径：用户名（职员工号或姓名）+ 密码。
 * 口令错误由后端统一返回 401「用户名或密码错误」，前端原样透出，不在前端判断用户名是否存在。
 */
export async function loginWithPassword(userName: string, password: string): Promise<SessionUser> {
  const res = await fetch(`${API_BASE}${DEV_LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName, password }),
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return acceptLogin((await res.json()) as { token?: string; user?: Partial<SessionUser> });
}

/** Mock 模式兜底：以默认演示身份登录（MSW 拦截 /auth/login，不依赖后端） */
export async function loginAsDefault(): Promise<SessionUser> {
  const res = await fetch(`${API_BASE}${DEV_LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    throw new ApiError(res.status, '登录失败：请确认后端服务已启动');
  }
  return acceptLogin((await res.json()) as { token?: string; user?: Partial<SessionUser> });
}

/** 退出登录：清除会话并通知 App 切回登录页 */
export function logout(): void {
  session = { token: null, user: null };
  const storage = safeStorage();
  if (storage !== null) {
    try {
      storage.removeItem(TOKEN_STORAGE_KEY);
      storage.removeItem(USER_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  emitAuthChange();
}

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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** 需要原始文本（如 CSV 导出）时置 true */
  rawText?: boolean;
  /** 需要二进制 Blob（如 PDF/Excel 导出）时置 true */
  rawBlob?: boolean;
  /** 内部递归标记：401 重试用，避免无限循环 */
  retried?: boolean;
}

async function request<T>(options: RequestOptions): Promise<T> {
  // 未登录不发业务请求：App 层的登录页门控是主防线，这里兜底防御
  if (session.token === null) {
    throw new ApiError(401, '未登录：请先在登录页选择用户');
  }
  const url = `${API_BASE}${options.path}${buildQuery(options.query)}`;

  const headers: Record<string, string> = { Authorization: `Bearer ${session.token}` };
  const init: RequestInit = { method: options.method, headers };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, init);

  // 令牌过期/后端重启：清除会话，App 监听到登出事件后切回登录页
  if (res.status === 401 && options.retried !== true) {
    logout();
    throw await parseErrorResponse(res);
  }

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  if (options.rawBlob === true) {
    return (await res.blob()) as unknown as T;
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

  /** PATCH：局部更新既有资源（如 PATCH /inspections/{id}/header 的炉批号表头字段） */
  patch: <T>(path: string, body?: unknown) =>
    request<T>({ method: 'PATCH', path, ...(body !== undefined ? { body } : {}) }),

  del: <T>(path: string) => request<T>({ method: 'DELETE', path }),
  postBlob: (path: string, body?: unknown) =>
    request<Blob>({ method: 'POST', path, rawBlob: true, ...(body !== undefined ? { body } : {}) }),
};

/** 统一把未知异常转成可展示文案（ApiError 直接给出后端 detail） */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return '未知错误';
}
