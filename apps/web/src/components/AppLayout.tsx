import React, { useState } from 'react';
import {
  LayoutDashboard,
  ClipboardCheck,
  GitBranch,
  ShieldAlert,
  Server,
  Database,
  CalendarCheck,
  FolderTree,
  Bell,
  Activity,
  ChevronRight,
  Menu,
  Search,
  Lock,
} from 'lucide-react';
import { cn } from '../lib/utils';

export type NavItemKey =
  | 'dashboard'
  | 'plans'
  | 'inspections'
  | 'traceability'
  | 'mrb'
  | 'integration'
  | 'master-data'
  | 'categories';

interface NavItem {
  key: NavItemKey;
  label: string;
  subLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  badgeTone?: 'red' | 'blue' | 'emerald';
}

const NAV_ITEMS: NavItem[] = [
  {
    key: 'dashboard',
    label: '质量驾驶舱',
    subLabel: 'KPI / 态势中枢',
    icon: LayoutDashboard,
  },
  {
    key: 'inspections',
    label: '质检执行台',
    subLabel: 'IQC/IPQC/FQC/下料',
    icon: ClipboardCheck,
    badge: '3 待检',
    badgeTone: 'blue',
  },
  {
    key: 'mrb',
    label: 'MRB 评审流',
    subLabel: '不合格品/特采签核',
    icon: ShieldAlert,
    badge: '1 阻断',
    badgeTone: 'red',
  },
  {
    key: 'traceability',
    label: '批次追溯 DAG',
    subLabel: '全链路树/防倒流',
    icon: GitBranch,
  },
  {
    key: 'plans',
    label: '检验计划中心',
    subLabel: 'AQL/抽样规程',
    icon: CalendarCheck,
  },
  {
    key: 'integration',
    label: 'MES 集成中枢',
    subLabel: '停机拦截/PLC指令',
    icon: Server,
    badge: '在线 48',
    badgeTone: 'emerald',
  },
  {
    key: 'master-data',
    label: '主数据管理',
    subLabel: '供应商/存货/车间/人员',
    icon: Database,
  },
  {
    key: 'categories',
    label: '物料分类树',
    subLabel: '母料/胚料/成品层级',
    icon: FolderTree,
  },
];

interface AppLayoutProps {
  currentKey: NavItemKey;
  onSelectKey: (key: NavItemKey) => void;
  children: React.ReactNode;
}

export function AppLayout({ currentKey, onSelectKey, children }: AppLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-screen w-full bg-[#0B1120] text-slate-100 overflow-hidden select-none">
      {/* Sidebar */}
      <aside
        className={cn(
          'flex flex-col border-r border-slate-800 bg-[#0F172A] transition-all duration-300 z-30',
          collapsed ? 'w-20' : 'w-64'
        )}
      >
        {/* Brand Header */}
        <div className="h-16 flex items-center px-4 border-b border-slate-800 justify-between bg-slate-900/60">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-tr from-sky-600 to-blue-500 flex items-center justify-center font-bold text-white shadow-lg shadow-sky-500/20 shrink-0">
              <Activity className="w-6 h-6 text-white" />
            </div>
            {!collapsed && (
              <div className="truncate">
                <div className="font-bold text-sm tracking-tight text-white flex items-center gap-1.5">
                  乐天紧固件 QMS
                  <span className="text-[10px] bg-sky-500/20 text-sky-400 px-1.5 py-0.5 rounded font-mono border border-sky-500/30">
                    V2.5
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 truncate">质量管控与放行阻断中枢</div>
              </div>
            )}
          </div>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-800 transition"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>

        {/* Navigation list */}
        <div className="flex-1 py-4 px-2 space-y-1.5 overflow-y-auto">
          {!collapsed && (
            <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              核心业务域
            </div>
          )}
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = currentKey === item.key;
            return (
              <button
                key={item.key}
                onClick={() => onSelectKey(item.key)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all group relative',
                  active
                    ? 'bg-sky-600/20 text-sky-400 border border-sky-500/30 shadow-[inset_0_0_12px_rgba(14,165,233,0.15)]'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/60'
                )}
                title={collapsed ? `${item.label} (${item.subLabel})` : undefined}
              >
                <Icon
                  className={cn(
                    'w-5 h-5 shrink-0 transition-colors',
                    active ? 'text-sky-400' : 'text-slate-400 group-hover:text-slate-200'
                  )}
                />
                {!collapsed && (
                  <div className="flex-1 text-left truncate">
                    <div className="leading-none text-[13px]">{item.label}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5 font-mono">{item.subLabel}</div>
                  </div>
                )}
                {!collapsed && item.badge && (
                  <span
                    className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded font-mono font-medium border',
                      item.badgeTone === 'red' &&
                        'bg-rose-950/80 text-rose-400 border-rose-500/40 animate-pulse',
                      item.badgeTone === 'blue' &&
                        'bg-sky-950/80 text-sky-400 border-sky-500/40',
                      item.badgeTone === 'emerald' &&
                        'bg-emerald-950/80 text-emerald-400 border-emerald-500/40'
                    )}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Bottom Status Card */}
        {!collapsed && (
          <div className="p-3 m-2 rounded-lg bg-slate-900/80 border border-slate-800 text-xs space-y-2">
            <div className="flex items-center justify-between text-slate-400">
              <span className="flex items-center gap-1.5 text-emerald-400">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block" />
                MES 阻断网关在线
              </span>
              <Lock className="w-3.5 h-3.5 text-rose-400" />
            </div>
            <div className="text-[11px] text-slate-400">当前拦截锁定: 1 批 (CH-04 下料机)</div>
          </div>
        )}
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[#0B1120]">
        {/* Top Header */}
        <header className="h-16 border-b border-slate-800 bg-[#0F172A]/70 backdrop-blur px-6 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold text-white tracking-wide flex items-center gap-2">
              <span>
                {NAV_ITEMS.find((n) => n.key === currentKey)?.label || '工作台'}
              </span>
              <span className="text-xs text-slate-400 font-normal">
                | {NAV_ITEMS.find((n) => n.key === currentKey)?.subLabel}
              </span>
            </h1>
          </div>

          <div className="flex items-center gap-4">
            {/* Quick Search */}
            <div className="relative hidden md:block">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                placeholder="快速全局搜索批次号 / 物料..."
                className="bg-slate-900 border border-slate-700/80 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-sky-500 w-64"
              />
            </div>

            {/* Notification */}
            <button className="relative p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition">
              <Bell className="w-4 h-4" />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-rose-500 rounded-full" />
            </button>

            {/* Current user */}
            <div className="flex items-center gap-2.5 pl-3 border-l border-slate-800">
              <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-semibold text-sky-400 font-mono">
                QC
              </div>
              <div className="text-left hidden sm:block">
                <div className="text-xs font-medium text-slate-200 leading-none">张强 (工号1042)</div>
                <div className="text-[10px] text-slate-400 mt-0.5">首席质量主管 · MRB 委员</div>
              </div>
            </div>
          </div>
        </header>

        {/* Content View Container */}
        <main className="flex-1 overflow-y-auto p-6 bg-[#0B1120]">
          {children}
        </main>
      </div>
    </div>
  );
}
