import React, { useState } from 'react';
import { AppLayout, NavItemKey } from './components/AppLayout';
import { DashboardPage } from './pages/dashboard';
import { PlansPage } from './pages/plans';
import { InspectionsPage } from './pages/inspections';
import { MrbPage } from './pages/mrb';
import { TraceabilityPage } from './pages/traceability';
import { IntegrationPage } from './pages/integration';
import { MasterDataPage } from './pages/master-data';
import { MaterialCategoriesPage } from './pages/master-data/categories';

export function App() {
  const [currentKey, setCurrentKey] = useState<NavItemKey>('dashboard');

  return (
    <AppLayout currentKey={currentKey} onSelectKey={setCurrentKey}>
      {currentKey === 'dashboard' && <DashboardPage />}
      {currentKey === 'plans' && <PlansPage />}
      {currentKey === 'inspections' && <InspectionsPage />}
      {currentKey === 'mrb' && <MrbPage />}
      {currentKey === 'traceability' && <TraceabilityPage />}
      {currentKey === 'integration' && <IntegrationPage />}
      {currentKey === 'master-data' && <MasterDataPage />}
      {currentKey === 'categories' && <MaterialCategoriesPage />}
    </AppLayout>
  );
}
