import React, { useEffect, useState } from 'react';
import { LogIn, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import logoIcon from '../../assets/logo_icon.png';
import {
  fetchAuthUsers,
  loginAsDefault,
  loginUser,
  errorMessage,
  type AuthUserOption,
  type SessionUser,
} from '../../lib/api';

interface LoginPageProps {
  /** 登录成功回调：App 保存会话并渲染主界面 */
  onLoggedIn: (user: SessionUser) => void;
}

/** 姓名首字作为头像字符（中文取第一个字，其他取首字母大写） */
function initialOf(name: string): string {
  const text = name.trim();
  if (text === '') return '?';
  return /[一-龥]/.test(text[0] as string) ? (text[0] as string) : (text[0] as string).toUpperCase();
}

/**
 * 独立登录页（开发/演示环境）：
 * 从职员档案拉取在职用户，一键登录并写入会话。
 * 生产环境后端不注册 /auth 路由，列表接口 404 时展示环境提示。
 */
export function LoginPage({ onLoggedIn }: LoginPageProps) {
  const [users, setUsers] = useState<AuthUserOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadUsers() {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchAuthUsers();
      setUsers(list);
      // 默认选中质量主管（张强，全量通配规则），没有则选第一位
      const preferred = list.find((u) => u.roleCode === 'QA_MANAGER') ?? list[0];
      setSelectedId(preferred?.id ?? null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  async function handleEnter() {
    if (selectedId === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const user = await loginUser(selectedId);
      onLoggedIn(user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** Mock 构建或后端异常时的兜底：以默认演示身份（张强）直接进入 */
  async function handleDefaultLogin() {
    setSubmitting(true);
    setError(null);
    try {
      const user = await loginAsDefault();
      onLoggedIn(user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const selectedUser = users.find((u) => u.id === selectedId);

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-[#1E293B] font-sans antialiased p-6">
      <div className="w-full max-w-[880px] flex rounded-xl overflow-hidden shadow-2xl bg-white">
        {/* 左侧品牌区 */}
        <div className="hidden md:flex w-[320px] shrink-0 bg-gradient-to-b from-[#203055] to-[#1E293B] text-white p-8 flex-col justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <img src={logoIcon} alt="Logo" className="w-9 h-9 rounded shadow-sm object-contain" />
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
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold text-slate-800">选择登录用户</h1>
              <p className="text-xs text-slate-400 mt-1">来自职员档案的在职用户 · 一键切换身份体验数据权限隔离</p>
            </div>
            <button
              type="button"
              onClick={() => void loadUsers()}
              disabled={loading}
              title="刷新用户列表"
              className="w-8 h-8 flex items-center justify-center rounded border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="flex-1 mt-4 overflow-y-auto border border-slate-200/80 rounded-lg divide-y divide-slate-100">
            {loading && (
              <div className="h-full flex items-center justify-center text-sm text-slate-400 py-16">
                正在加载用户列表...
              </div>
            )}
            {!loading && users.length === 0 && (
              <div className="py-16 text-center space-y-3">
                <p className="text-sm text-slate-500">未能获取用户列表（后端服务未启动或登录接口不可用）</p>
                <button
                  type="button"
                  onClick={() => void handleDefaultLogin()}
                  disabled={submitting}
                  className="px-4 py-2 rounded bg-slate-800 text-white text-xs font-medium hover:bg-slate-900 disabled:opacity-60"
                >
                  以默认身份（张强 · 质量主管）进入
                </button>
              </div>
            )}
            {!loading &&
              users.map((u) => {
                const active = u.id === selectedId;
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setSelectedId(u.id)}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                      active ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                    }`}
                  >
                    <span
                      className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium shrink-0 ${
                        active ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {initialOf(u.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-slate-800">
                        {u.name}
                        {u.employeeCode && (
                          <span className="ml-2 text-[11px] font-normal text-slate-400">{u.employeeCode}</span>
                        )}
                      </span>
                      <span className="block text-xs text-slate-500 mt-0.5 truncate">
                        {u.roleName ?? u.roleCode ?? '未分配角色'}
                        {u.department ? ` · ${u.department}` : ''}
                      </span>
                    </span>
                    <span
                      className={`w-4 h-4 rounded-full border shrink-0 ${
                        active ? 'border-blue-600 bg-blue-600 ring-2 ring-blue-100' : 'border-slate-300'
                      }`}
                    />
                  </button>
                );
              })}
          </div>

          {error && (
            <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={() => void handleEnter()}
            disabled={selectedId === null || submitting || loading}
            className="mt-4 w-full flex items-center justify-center gap-2 py-2.5 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
          >
            <LogIn className="w-4 h-4" />
            {submitting ? '登录中...' : `进入系统${selectedUser ? `（${selectedUser.name}）` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default LoginPage;
