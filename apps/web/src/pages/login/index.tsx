import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Lock,
  LogIn,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import {
  fetchAuthUsers,
  loginAsDefault,
  loginUser,
  loginWithPassword,
  errorMessage,
  type AuthUserOption,
  type SessionUser,
} from '../../lib/api';

interface LoginPageProps {
  /** 登录成功回调：App 保存会话并渲染主界面 */
  onLoggedIn: (user: SessionUser) => void;
}

/** 开发/演示环境统一初始密码，与后端 auth.controller 的 defaultLoginPassword() 保持一致 */
const DEFAULT_PASSWORD = '123456';

/** 姓名首字作为头像字符（中文取第一个字，其他取首字母大写） */
function initialOf(name: string): string {
  const text = name.trim();
  if (text === '') return '?';
  return /[一-龥]/.test(text[0] as string) ? (text[0] as string) : (text[0] as string).toUpperCase();
}

const USERNAME_STORAGE_KEY = 'letian_qms_last_username';

/** 读取上次输入的用户名：便于演示环境重复登录，localStorage 不可用时静默降级 */
function readLastUsername(): string {
  try {
    return typeof window !== 'undefined' ? (window.localStorage.getItem(USERNAME_STORAGE_KEY) ?? '') : '';
  } catch {
    return '';
  }
}

function writeLastUsername(value: string): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(USERNAME_STORAGE_KEY, value);
  } catch {
    /* 隐私模式/桌面端 file:// 下可能抛异常，忽略即可 */
  }
}

/**
 * 独立登录页（开发/演示环境）：
 * 主路径为「用户名（工号或姓名）+ 密码」；另保留折叠的演示身份切换区，
 * 用于快速对比不同职员的三维物料权限。
 * 生产环境后端不注册 /auth 路由，登录接口 404 时展示环境提示。
 */
export function LoginPage({ onLoggedIn }: LoginPageProps) {
  const [userName, setUserName] = useState<string>(() => readLastUsername());
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 演示身份切换区（折叠，按需加载）
  const [showDemo, setShowDemo] = useState(false);
  const [users, setUsers] = useState<AuthUserOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(false);

  /** 用户名+密码登录：用户名/密码为空时本地拦截，不发请求 */
  async function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault();
    const name = userName.trim();
    if (name === '') {
      setError('请输入用户名');
      return;
    }
    if (password === '') {
      setError('请输入密码');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const user = await loginWithPassword(name, password);
      writeLastUsername(name);
      onLoggedIn(user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** 展开演示区时才拉取职员名单，避免每次进登录页都打一次接口 */
  useEffect(() => {
    if (!showDemo || users.length > 0 || loadingUsers) return;
    void (async () => {
      setLoadingUsers(true);
      setError(null);
      try {
        const list = await fetchAuthUsers();
        setUsers(list);
        const preferred = list.find((u) => u.roleCode === 'QA_MANAGER') ?? list[0];
        setSelectedId(preferred?.id ?? null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoadingUsers(false);
      }
    })();
  }, [showDemo, users.length, loadingUsers]);

  /** 演示身份一键登录（不校验密码，仅开发态可用） */
  async function enterAs(userId: string) {
    if (userId === '') return;
    setSubmitting(true);
    setError(null);
    try {
      onLoggedIn(await loginUser(userId));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** 名单接口不可用时（后端未启动）的兜底：以默认演示身份「张强」进入 */
  async function handleDefaultLogin() {
    setSubmitting(true);
    setError(null);
    try {
      onLoggedIn(await loginAsDefault());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleToggleDemo() {
    setShowDemo((prev) => !prev);
    setError(null);
  }

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-[#1E293B] font-sans antialiased p-6">
      <div className="w-full max-w-[880px] flex rounded-xl overflow-hidden shadow-2xl bg-white">
        {/* 左侧品牌区 */}
        <div className="hidden md:flex w-[320px] shrink-0 bg-gradient-to-b from-[#203055] to-[#1E293B] text-white p-8 flex-col justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-[9px] bg-gradient-to-br from-[#325CEE] to-[#5D64F0] shadow-sm flex items-center justify-center text-white text-[19px] font-bold leading-none select-none">
                L
              </span>
              <span className="text-lg font-semibold tracking-wide">乐天QMS</span>
            </div>
            <p className="text-[13px] text-slate-300/90 mt-6 leading-relaxed">
              质量管理系统 · 物料权限演示
            </p>
          </div>
          <div className="space-y-4 text-[12px] text-slate-300/80">
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
              <p>登录后，检验台账 / MRB / 看板 / 追溯等全部模块的数据均按三维物料权限（分类 / 编码 / 供应商）自动过滤。</p>
            </div>
            <div className="flex items-start gap-2.5">
              <UserRound className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
              <p>切换不同用户登录，可直观对比各自可见的数据范围；未配置任何权限规则的用户登录后看不到数据（安全默认）。</p>
            </div>
          </div>
          <p className="text-[11px] text-slate-400/70 leading-relaxed">
            仅限开发 / 演示环境使用：生产环境由统一身份认证（SSO）接管，本页面不会注册登录接口。
          </p>
        </div>

        {/* 右侧登录区 */}
        <div className="flex-1 p-8 flex flex-col min-h-[520px]">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-lg font-bold text-slate-800">用户登录</h1>
              <p className="text-xs text-slate-400 mt-1">请输入职员工号或姓名登录系统</p>
            </div>
            {showDemo && (
              <button
                type="button"
                onClick={() => {
                  setLoadingUsers(true);
                  void (async () => {
                    try {
                      const list = await fetchAuthUsers();
                      setUsers(list);
                      const preferred = list.find((u) => u.roleCode === 'QA_MANAGER') ?? list[0];
                      setSelectedId(preferred?.id ?? null);
                    } catch (err) {
                      setError(errorMessage(err));
                    } finally {
                      setLoadingUsers(false);
                    }
                  })();
                }}
                disabled={loadingUsers}
                title="刷新用户列表"
                className="w-8 h-8 flex items-center justify-center rounded border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${loadingUsers ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>

          <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
            {/* 用户名 */}
            <div>
              <label htmlFor="login-username" className="block text-xs font-medium text-slate-600 mb-1.5">
                用户名
              </label>
              <div className="relative">
                <UserRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                <input
                  id="login-username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  autoFocus
                  value={userName}
                  onChange={(e) => {
                    setUserName(e.target.value);
                    if (error !== null) setError(null);
                  }}
                  placeholder="请输入工号或姓名"
                  className="w-full h-10 pl-9 pr-3 rounded border border-slate-300 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition"
                />
              </div>
            </div>

            {/* 密码 */}
            <div>
              <label htmlFor="login-password" className="block text-xs font-medium text-slate-600 mb-1.5">
                密码
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                <input
                  id="login-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error !== null) setError(null);
                  }}
                  placeholder="请输入密码"
                  className="w-full h-10 pl-9 pr-10 rounded border border-slate-300 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  title={showPassword ? '隐藏密码' : '显示密码'}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-slate-600 hover:bg-slate-50"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              <LogIn className="w-4 h-4" />
              {submitting ? '登录中...' : '登录'}
            </button>
          </form>

          <p className="mt-3 text-[11px] text-slate-400">
            演示环境初始密码：<span className="font-mono text-slate-500">{DEFAULT_PASSWORD}</span>
          </p>

          {/* 演示：身份切换（开发态专用，绕过口令以快速对比物料权限） */}
          <div className="mt-4 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={handleToggleDemo}
              className="w-full flex items-center justify-between text-xs text-slate-500 hover:text-slate-700"
            >
              <span>演示：以其他身份快速进入（不校验密码）</span>
              {showDemo ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            {showDemo && (
              <div className="mt-3">
                <div className="max-h-[168px] overflow-y-auto border border-slate-200/80 rounded-lg divide-y divide-slate-100">
                  {loadingUsers && (
                    <div className="flex items-center justify-center text-sm text-slate-400 py-10">
                      正在加载用户列表...
                    </div>
                  )}
                  {!loadingUsers && users.length === 0 && (
                    <div className="py-8 text-center space-y-3">
                      <p className="text-xs text-slate-500 px-4">
                        未能获取用户列表（后端服务未启动或登录接口不可用）
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleDefaultLogin()}
                        disabled={submitting}
                        className="px-3 py-1.5 rounded bg-slate-800 text-white text-xs font-medium hover:bg-slate-900 disabled:opacity-60"
                      >
                        以默认身份（张强 · 质量主管）进入
                      </button>
                    </div>
                  )}
                  {!loadingUsers &&
                    users.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => void enterAs(u.id)}
                        disabled={submitting}
                        className="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-slate-50 disabled:opacity-60"
                      >
                        <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium shrink-0 bg-slate-200 text-slate-600">
                          {initialOf(u.name)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-medium text-slate-800">
                            {u.name}
                            {u.employeeCode && (
                              <span className="ml-2 text-[11px] font-normal text-slate-400">{u.employeeCode}</span>
                            )}
                          </span>
                          <span className="block text-[11px] text-slate-500 truncate">
                            {u.roleName ?? u.roleCode ?? '未分配角色'}
                          </span>
                        </span>
                      </button>
                    ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default LoginPage;