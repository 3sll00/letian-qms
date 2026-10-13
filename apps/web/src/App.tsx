import React, { useEffect, useState } from 'react';
import { AppLayout, NavItemKey } from './components/AppLayout';
import { DashboardPage } from './pages/dashboard';
import { ProgressOverviewPage } from './pages/progress-overview';
import { InspectionHistoryPage } from './pages/dashboard/history';
import { TraceabilityPage } from './pages/traceability';
import { InspectionsPage } from './pages/inspections';
import { PlansPage } from './pages/plans';
import { MrbPage } from './pages/mrb';
import { PendingMRBPoolPage } from './pages/mrb/PendingMRBPoolPage';
import { ReviewWorkflowView } from './pages/mrb/ReviewWorkflowView';
import { MaterialCategoriesPage } from './pages/master-data/categories';
import { IntegrationPage } from './pages/integration';
import { LoginPage } from './pages/login';
import {
  getCurrentUser,
  logout,
  subscribeAuthChange,
  type SessionUser,
} from './lib/api';

export function App() {
  const [currentNav, setCurrentNav] = useState<NavItemKey>('dashboard');
  const [user, setUser] = useState<SessionUser | null>(() => getCurrentUser());
  /** 登录态代数：每次登录/登出 +1，用于整体重置各业务页的查询缓存与本地状态 */
  const [sessionEpoch, setSessionEpoch] = useState(0);
  /** 菜单点击代数：每次点击左侧菜单（含点击当前已选中菜单）都 +1 —— 「点当前菜单回到该菜单初始界面」的实现点 */
  const [navEpoch, setNavEpoch] = useState(0);

  useEffect(() => {
    // 被动登出（401 令牌过期）时也同步回登录页
    const unsubscribe = subscribeAuthChange((next) => {
      setUser(next);
      setSessionEpoch((n) => n + 1);
    });
    return unsubscribe;
  }, []);

  function handleLoggedIn(next: SessionUser) {
    setUser(next);
    setCurrentNav('dashboard');
    setSessionEpoch((n) => n + 1);
  }

  function handleLogout() {
    logout();
    setUser(null);
    setSessionEpoch((n) => n + 1);
  }

  if (user === null) {
    return <LoginPage onLoggedIn={handleLoggedIn} />;
  }

  /**
   * 页面挂载键：登录态变化（sessionEpoch）或菜单点击（navEpoch）都会换键 → 页面重新挂载并回到该菜单的初始界面。
   * 业务页内部的子视图（IPQC 三台账、页签、筛选项、抽屉）因此无需各自再暴露一份 reset 属性。
   */
  function pageKey(nav: NavItemKey): string {
    return `${nav}-${sessionEpoch}-${navEpoch}`;
  }

  /**
   * 菜单点击：即使是同一个 key 也要推进 navEpoch —— 用户停在【过程检验(IPQC) → 下料检验】台账里点【过程检验(IPQC)】，
   * 期望的是回到三工序总览，而不是「无事发生」（口径见 docs/38-导航菜单与面包屑跳转交互设计.md §3.1）。
   */
  function handleSelectNav(next: NavItemKey) {
    setCurrentNav(next);
    setNavEpoch((n) => n + 1);
  }

  const renderContent = () => {
    switch (currentNav) {
      case 'progress-overview':
        return <ProgressOverviewPage key={pageKey('progress-overview')} />;
      case 'dashboard':
        return <DashboardPage key={pageKey('dashboard')} />;
      case 'history':
        return <InspectionHistoryPage key={pageKey('history')} />;
      case 'traceability':
        return <TraceabilityPage key={pageKey('traceability')} />;
      case 'iqc':
        return <InspectionsPage key={pageKey('iqc')} initialStage="iqc" />;
      case 'ipqc':
        return <InspectionsPage key={pageKey('ipqc')} initialStage="ipqc" />;
      case 'outsource':
        return <InspectionsPage key={pageKey('outsource')} initialStage="outsource" />;
      case 'oqc':
        return <InspectionsPage key={pageKey('oqc')} initialStage="oqc" />;
      case 'plans':
        return <PlansPage key={pageKey('plans')} />;
      case 'pending-pool':
        // 不合格待审核池工作台（v2.6.0 未结模块）：各环节滞留条目的发起评审入口
        return <PendingMRBPoolPage key={pageKey('pending-pool')} />;
      case 'mrb':
        // MRB 不合格品处置整合单页：待审核池（阶段 1）与评审处置（阶段 2）都在页内抽屉完成
        return (
          <MrbPage key={pageKey('mrb')} onOpenPendingPool={() => handleSelectNav('pending-pool')} />
        );
      case 'review-workflow':
        return <ReviewWorkflowView key={pageKey('review-workflow')} />;
      case 'permissions':
        return <IntegrationPage key={pageKey('permissions')} initialTab="permissions" />;
      case 'categories':
        return <MaterialCategoriesPage key={pageKey('categories')} />;
      case 'logs':
        return <IntegrationPage key={pageKey('logs')} initialTab="logs" />;
      default:
        return <DashboardPage key={pageKey('dashboard')} />;
    }
  };

  return (
    <AppLayout
      currentKey={currentNav}
      onSelectKey={handleSelectNav}
      user={user}
      onLogout={handleLogout}
    >
      {renderContent()}
    </AppLayout>
  );
}

export default App;
