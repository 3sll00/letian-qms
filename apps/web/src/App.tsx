import React, { useEffect, useState } from 'react';
import { AppLayout, NavItemKey } from './components/AppLayout';
import { DashboardPage } from './pages/dashboard';
import { InspectionHistoryPage } from './pages/dashboard/history';
import { TraceabilityPage } from './pages/traceability';
import { InspectionsPage } from './pages/inspections';
import { PlansPage } from './pages/plans';
import { MrbPage } from './pages/mrb';
import { ReviewWorkflowView } from './pages/mrb/ReviewWorkflowView';
import { MaterialCategoriesPage } from './pages/master-data/categories';
import { MasterDataPage } from './pages/master-data';
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

  const renderContent = () => {
    switch (currentNav) {
      case 'dashboard':
        return <DashboardPage />;
      case 'history':
        return <InspectionHistoryPage />;
      case 'traceability':
        return <TraceabilityPage />;
      case 'iqc':
        return <InspectionsPage key={`iqc-${sessionEpoch}`} initialStage="iqc" />;
      case 'ipqc':
        return <InspectionsPage key={`ipqc-${sessionEpoch}`} initialStage="ipqc" />;
      case 'outsource':
        return <InspectionsPage key={`outsource-${sessionEpoch}`} initialStage="outsource" />;
      case 'oqc':
        return <InspectionsPage key={`oqc-${sessionEpoch}`} initialStage="oqc" />;
      case 'plans':
        return <PlansPage />;
      case 'mrb':
        // MRB 不合格品处置整合单页：待审核池（阶段 1）与评审处置（阶段 2）都在页内抽屉完成
        return <MrbPage key={`mrb-${sessionEpoch}`} />;
      case 'review-workflow':
        return <ReviewWorkflowView />;
      case 'permissions':
        return <IntegrationPage key={`perm-${sessionEpoch}`} initialTab="permissions" />;
      case 'categories':
        return <MaterialCategoriesPage />;
      case 'logs':
        return <IntegrationPage initialTab="logs" />;
      case 'erp-inventory':
        return <MasterDataPage initialTab="inventory" />;
      case 'erp-supplier':
        return <MasterDataPage initialTab="supplier" />;
      case 'erp-customer':
        return <MasterDataPage initialTab="customer" />;
      default:
        return <DashboardPage />;
    }
  };

  return (
    <AppLayout
      currentKey={currentNav}
      onSelectKey={setCurrentNav}
      user={user}
      onLogout={handleLogout}
    >
      {renderContent()}
    </AppLayout>
  );
}

export default App;
