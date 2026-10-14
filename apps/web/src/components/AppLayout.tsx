import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { PanelLeftClose, PanelLeftOpen, Search, LogOut } from 'lucide-react';
import { cn } from '../lib/utils';
import type { SessionUser } from '../lib/api';

// Import exact cropped sidebar icons
import bellIcon from '../assets/bell_icon.png';
import helpIcon from '../assets/help_icon.png';

import dashboardIcon from '../assets/sidebar-icons/dashboard.png';
import historyIcon from '../assets/sidebar-icons/history.png';
import traceabilityIcon from '../assets/sidebar-icons/traceability.png';
import iqcIcon from '../assets/sidebar-icons/iqc.png';
import ipqcIcon from '../assets/sidebar-icons/ipqc.png';
import outsourceIcon from '../assets/sidebar-icons/outsource.png';
import oqcIcon from '../assets/sidebar-icons/oqc.png';
import planDesignIcon from '../assets/sidebar-icons/plan_design.png';
import mrbIcon from '../assets/sidebar-icons/mrb.png';
import reviewWorkflowIcon from '../assets/sidebar-icons/review_workflow.png';
import permissionsIcon from '../assets/sidebar-icons/permissions.png';
import categoriesIcon from '../assets/sidebar-icons/categories.png';
import logsIcon from '../assets/sidebar-icons/logs.png';
import equipmentIcon from '../assets/sidebar-icons/equipment.png';

export type NavItemKey =
  | 'progress-overview'
  | 'dashboard'
  | 'history'
  | 'traceability'
  | 'iqc'
  | 'ipqc'
  | 'outsource'
  | 'oqc'
  | 'plans'
  | 'pending-pool'
  | 'mrb'
  | 'review-workflow'
  | 'permissions'
  | 'categories'
  | 'logs'
  | 'equipment';

interface NavMenuItem {
  key: NavItemKey;
  label: string;
  icon: string;
  badge?: number;
}

interface NavGroup {
  groupName: string;
  items: NavMenuItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    groupName: '质量总览',
    items: [
      { key: 'progress-overview', label: '进度总览', icon: dashboardIcon },
      { key: 'dashboard', label: '检验进度总览', icon: dashboardIcon },
      { key: 'history', label: '检验进度明细', icon: historyIcon },
      { key: 'traceability', label: '质量追溯看板', icon: traceabilityIcon },
    ],
  },
  {
    groupName: '检验管理',
    items: [
      { key: 'iqc', label: '来料检验(IQC)', icon: iqcIcon },
      { key: 'ipqc', label: '过程检验(IPQC)', icon: ipqcIcon },
      { key: 'outsource', label: '委外检验', icon: outsourceIcon },
      { key: 'oqc', label: '出货检验 (OQC)', icon: oqcIcon },
    ],
  },
  {
    groupName: '质检方案',
    items: [
      { key: 'plans', label: '质检方案设计', icon: planDesignIcon },
    ],
  },
  {
    groupName: '不合格品处置',
    items: [
      { key: 'pending-pool', label: '不合格待审核池', icon: mrbIcon },
      { key: 'mrb', label: 'MRB不合格品处置', icon: mrbIcon },
      { key: 'review-workflow', label: '评审流程设置', icon: reviewWorkflowIcon },
    ],
  },
  {
    groupName: '系统管理',
    items: [
      { key: 'equipment', label: '设备管理', icon: equipmentIcon },
      { key: 'permissions', label: '物料权限管理', icon: permissionsIcon },
      { key: 'categories', label: '存货分类', icon: categoriesIcon },
      { key: 'logs', label: '操作日志', icon: logsIcon },
    ],
  },
];

interface AppLayoutProps {
  currentKey: NavItemKey;
  onSelectKey: (key: NavItemKey) => void;
  /** 当前登录用户（姓名 + 角色），渲染在顶栏右侧 */
  user: SessionUser;
  /** 退出登录回调 */
  onLogout: () => void;
  children: React.ReactNode;
}

function userInitial(name: string): string {
  const text = name.trim();
  if (text === '') return '?';
  return /[一-龥]/.test(text[0] as string) ? (text[0] as string) : (text[0] as string).toUpperCase();
}

export function AppLayout({ currentKey, onSelectKey, user, onLogout, children }: AppLayoutProps) {
  const [topSearch, setTopSearch] = useState('');
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const refreshBadges = useCallback(async () => {
    try {
      const counts: Record<string, number> = {
        iqc: 0,
        ipqc: 0,
        outsource: 0,
        oqc: 0,
        'pending-pool': 0,
        mrb: 0,
      };

      // 1. 实时获取所有待检验状态单据并按工序分类归集
      const res = await api.get<{ list?: any[]; items?: any[] }>('/inspections', {
        status: 'PENDING',
        limit: 100,
      });
      const list = res.list || res.items || [];
      for (const item of list) {
        const type = String(item.inspectionType || item.orderType || '').toUpperCase();
        if (type.includes('IQC')) {
          counts.iqc++;
        } else if (type.includes('IPQC')) {
          counts.ipqc++;
        } else if (
          type.includes('OUTSOURCE') ||
          // 委外七分类 (OQC_SF/OQC_HEAT/OQC_MACH/OQC_BLACK/OQC_ZINC/OQC_NICKEL/OQC_PHOSPH/OQC_DACRO)
          // 全部归入「委外检验」菜单；OQC_SH 属出货检验，走下一分支
          (type.startsWith('OQC_') && type !== 'OQC_SH')
        ) {
          counts.outsource++;
        } else if (type.includes('OQC')) {
          counts.oqc++;
        }
      }

      // 2. 实时获取待评审 MRB 工单数量
      //    角标口径 = 待评审数（pendingCount），与 docs/19-MRB不合格品处置页整合设计.md §2 一致；
      //    不再使用 dashboard 的「评审中 + 待评审」合并口径，避免角标与页面 KPI 首卡对不上。
      try {
        const mrbRes = await api.get<{ pendingCount?: number; pendingPoolCount?: number }>(
          '/mrb/records',
          {
            page: 1,
            pageSize: 1,
          }
        );
        counts.mrb = mrbRes.pendingCount ?? 0;
        // 待审核池「待发起评审」滞留条数（docs/39 §2 D3 口径，同一接口顺带回吐）
        counts['pending-pool'] = mrbRes.pendingPoolCount ?? 0;
      } catch {
        // ignore
      }

      setBadges(counts);
    } catch {
      // 容错处理
    }
  }, []);

  useEffect(() => {
    void refreshBadges();
    const timer = setInterval(() => {
      void refreshBadges();
    }, 30000);
    return () => clearInterval(timer);
  }, [refreshBadges, currentKey]);

  // 面包屑定位：分组节点（分组名 + 分组入口页 = 该分组第一个菜单项）与当前菜单节点
  // 口径见 docs/38-导航菜单与面包屑跳转交互设计.md §3.2：分组在系统内不是页面，一律落到分组入口页
  const activeGroup = NAV_GROUPS.find((group) => group.items.some((i) => i.key === currentKey));
  const activeItemLabel = activeGroup?.items.find((i) => i.key === currentKey)?.label ?? '';
  const groupEntryItem = activeGroup?.items[0];

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#F5F7FA] text-[#1E293B] font-sans antialiased">
      <aside
        className={cn(
          'bg-[#1E293B] flex flex-col h-full border-r border-slate-800 select-none z-20 shrink-0 transition-[width] duration-200 ease-in-out',
          sidebarCollapsed ? 'w-[56px] min-w-[56px] max-w-[56px]' : 'w-[195px] min-w-[195px] max-w-[195px]'
        )}
      >
        {/* Brand Logo Header */}
        <div className={cn('relative h-[58px] flex items-center border-b border-slate-800/80 shrink-0', sidebarCollapsed ? 'justify-center px-2' : 'px-4 gap-2.5')}>
          <span className={cn('w-7 h-7 rounded-[7px] bg-gradient-to-br from-[#325CEE] to-[#5D64F0] shadow-sm flex items-center justify-center text-white text-[15px] font-bold leading-none select-none', sidebarCollapsed && 'hidden')}>
            L
          </span>
          <span className={cn('text-white text-[15px] font-semibold tracking-wide', sidebarCollapsed && 'hidden')}>乐天QMS</span>
          <button
            type="button"
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            className={cn(
              'flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-slate-700/70 transition-colors',
              sidebarCollapsed ? 'absolute right-1 w-7 h-7' : 'ml-auto w-7 h-7'
            )}
          >
            {sidebarCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
        </div>

        {/* Navigation Menus with custom scrollbar */}
        <nav className="flex-1 overflow-y-auto py-2.5 px-2 space-y-3.5 scrollbar-thin">
          {NAV_GROUPS.map((group) => (
            <div key={group.groupName} className="space-y-0.5">
              <div className={cn('px-2.5 py-1 text-[11px] font-medium text-slate-400/80', sidebarCollapsed && 'hidden')}>
                {group.groupName}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const isActive = currentKey === item.key;
                  return (
                    <button
                      key={item.key}
                      onClick={() => onSelectKey(item.key)}
                      title={isActive ? `${item.label}（点击返回初始界面）` : item.label}
                      className={cn(
                        'w-full flex items-center rounded text-[13px] transition-colors group text-left relative',
                        sidebarCollapsed ? 'justify-center px-0 py-2' : 'justify-between px-2.5 py-2',
                        isActive
                          ? 'bg-[#203055] text-white font-medium'
                          : 'text-slate-300 hover:text-white hover:bg-slate-800/60'
                      )}
                    >
                      <div className={cn('flex items-center min-w-0', sidebarCollapsed ? 'justify-center' : 'gap-2.5')}>
                        <img
                          src={item.icon}
                          alt={item.label}
                          className="w-4 h-4 object-contain shrink-0 opacity-90 group-hover:opacity-100"
                        />
                        <span className={cn('truncate', sidebarCollapsed && 'hidden')}>{item.label}</span>
                      </div>
                      {(() => {
                        const count = badges[item.key] ?? (typeof item.badge === 'number' ? item.badge : 0);
                        if (!count || count <= 0 || sidebarCollapsed) return null;
                        return (
                          <span className="ml-1 shrink-0 bg-[#EF4444] text-white text-[10px] font-semibold px-1.5 py-0.2 rounded-full min-w-[18px] text-center leading-[16px]">
                            {count > 99 ? '99+' : count}
                          </span>
                        );
                      })()}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
        {/* Top Navbar */}
        <header className="h-[58px] bg-white border-b border-[#E2E8F0] px-6 flex items-center justify-between shrink-0 z-10">
          {/* Breadcrumb */}
          <div className="flex items-center gap-2 text-[13px] text-slate-500">
            {activeGroup && groupEntryItem && (
              <>
                <button
                  type="button"
                  onClick={() => onSelectKey(groupEntryItem.key)}
                  title={`进入「${activeGroup.groupName}」分组入口：${groupEntryItem.label}`}
                  className="transition-colors hover:text-blue-600 hover:underline underline-offset-2"
                >
                  {activeGroup.groupName}
                </button>
                <span className="text-slate-300">/</span>
              </>
            )}
            <button
              type="button"
              onClick={() => onSelectKey(currentKey)}
              title={`点击返回「${activeItemLabel}」初始界面`}
              className="font-bold text-slate-900 transition-colors hover:text-blue-600 hover:underline underline-offset-2"
            >
              {activeItemLabel}
            </button>
          </div>

          {/* Right Action Icons & User */}
          <div className="flex items-center gap-4">
            {/* Global Search Box */}
            <div className="relative w-[280px]">
              <input
                type="text"
                placeholder="搜索检验单号、物料编码..."
                value={topSearch}
                onChange={(e) => setTopSearch(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-full pl-8 pr-3 py-1.5 text-[12px] text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:bg-white transition-all"
              />
              <Search className="w-3.5 h-3.5 text-blue-500 absolute left-3 top-1/2 -translate-y-1/2" />
            </div>

            {/* Notification Bell */}
            <button
              title="通知"
              className="relative w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors"
            >
              <img src={bellIcon} alt="通知" className="w-5 h-5 object-contain" draggable={false} />
            </button>

            {/* Help Icon */}
            <button
              title="帮助"
              className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors"
            >
              <img src={helpIcon} alt="帮助" className="w-5 h-5 object-contain" draggable={false} />
            </button>

            {/* User Profile Avatar */}
            <div className="flex items-center gap-2 pl-1 border-l border-slate-200">
              <div
                className="w-7 h-7 rounded-full bg-[#2563EB] text-white flex items-center justify-center text-xs font-medium shadow-sm shrink-0"
                title={`${user.userName}（${user.roleName ?? user.role}）`}
              >
                {userInitial(user.userName)}
              </div>
              <div className="leading-tight">
                <span className="block text-[13px] text-slate-700 font-medium">{user.userName}</span>
                <span className="block text-[10px] text-slate-400">{user.roleName ?? user.role}</span>
              </div>
              <button
                type="button"
                onClick={onLogout}
                title="退出登录（切换用户）"
                className="ml-1 w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </header>

        {/* Scrollable Content Body */}
        <main className="flex-1 overflow-y-auto bg-[#F5F7FA] p-6">
          <div className="w-full mx-auto min-h-full">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
