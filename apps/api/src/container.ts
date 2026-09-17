import {
  AdvanceMrbStepUseCase,
  CheckReleaseGateUseCase,
  CreateInspectionOrderUseCase,
  CreatePlanUseCase,
  CreateReinspectionUseCase,
  CustomerSignOffUseCase,
  DecideMrbDispositionUseCase,
  ExportInspectionReportUseCase,
  ExportTraceReportUseCase,
  PenetrateBatchDagUseCase,
  RecordMeasurementsAndJudgeUseCase,
  SaveInspectionDraftUseCase,
  TogglePlanVersionUseCase,
  TriggerMrbReviewUseCase,
  UpgradePlanVersionUseCase,
  type IUnitOfWork,
} from '@letian/application';
import {
  KyselyAuditLogRepository,
  KyselyBatchTraceRepository,
  KyselyDashboardRepository,
  KyselyInspectionOrderRepository,
  KyselyInspectionPlanRepository,
  KyselyIntegrationRepository,
  KyselyMRBReviewRepository,
  KyselyMasterDataRepository,
  KyselyMaterialPermissionRepository,
  KyselyReviewFlowRepository,
  createDatabaseConnection,
  createUnitOfWork,
} from '@letian/infrastructure';

/**
 * 数据库连接类型：直接由 createDatabaseConnection 的返回类型推导，
 * 从而不必让 apps/api 直接依赖 kysely 的类型包。
 */
type DatabaseConnection = ReturnType<typeof createDatabaseConnection>;

/**
 * API 进程级依赖容器。
 *
 * 设计要点：
 * 1. 连接与事务边界：整个进程共享一个 Kysely 实例（内部是 pg 连接池），
 *    每个用例各自通过 IUnitOfWork 开启/提交事务，控制器不直接写 SQL。
 * 2. 用例只依赖 IUnitOfWork，因此容器只负责构造一次并复用；
 *    用例本身无状态，可安全地跨请求复用同一实例。
 * 3. 仓储实例同样无状态（仅持有 Kysely 引用），读侧查询直接走仓储，
 *    写侧一律走用例，保证审计日志 / Outbox / 事务原子性不被绕过。
 */
export interface ApiContainer {
  readonly db: DatabaseConnection;
  readonly uow: IUnitOfWork;

  /** 读侧仓储（列表 / 统计 / 看板 / 配置查询） */
  readonly repositories: {
    plans: KyselyInspectionPlanRepository;
    orders: KyselyInspectionOrderRepository;
    mrbReviews: KyselyMRBReviewRepository;
    auditLogs: KyselyAuditLogRepository;
    traces: KyselyBatchTraceRepository;
    masterData: KyselyMasterDataRepository;
    integration: KyselyIntegrationRepository;
    dashboard: KyselyDashboardRepository;
    reviewFlows: KyselyReviewFlowRepository;
    materialPermissions: KyselyMaterialPermissionRepository;
  };

  /** 应用层用例（写侧唯一入口） */
  readonly useCases: {
    createInspectionOrder: CreateInspectionOrderUseCase;
    recordMeasurementsAndJudge: RecordMeasurementsAndJudgeUseCase;
    saveInspectionDraft: SaveInspectionDraftUseCase;
    createReinspection: CreateReinspectionUseCase;
    triggerMrbReview: TriggerMrbReviewUseCase;
    advanceMrbStep: AdvanceMrbStepUseCase;
    customerSignOff: CustomerSignOffUseCase;
    decideMrbDisposition: DecideMrbDispositionUseCase;
    createPlan: CreatePlanUseCase;
    upgradePlanVersion: UpgradePlanVersionUseCase;
    togglePlanVersion: TogglePlanVersionUseCase;
    checkReleaseGate: CheckReleaseGateUseCase;
    penetrateBatchDag: PenetrateBatchDagUseCase;
    exportInspectionReport: ExportInspectionReportUseCase;
    exportTraceReport: ExportTraceReportUseCase;
  };

  /** 仅在容器自己创建了连接时才会真正销毁连接池 */
  dispose(): Promise<void>;
}

export interface CreateApiContainerOptions {
  /** 复用外部已建连接（测试注入），此时 dispose() 不会销毁它 */
  db?: DatabaseConnection;
}

export function createApiContainer(options: CreateApiContainerOptions = {}): ApiContainer {
  const externalDb = options.db;
  const db: DatabaseConnection = externalDb ?? createDatabaseConnection();
  const uow = createUnitOfWork(db);

  const repositories = {
    plans: new KyselyInspectionPlanRepository(db),
    orders: new KyselyInspectionOrderRepository(db),
    mrbReviews: new KyselyMRBReviewRepository(db),
    auditLogs: new KyselyAuditLogRepository(db),
    traces: new KyselyBatchTraceRepository(db),
    masterData: new KyselyMasterDataRepository(db),
    integration: new KyselyIntegrationRepository(db),
    dashboard: new KyselyDashboardRepository(db),
    reviewFlows: new KyselyReviewFlowRepository(db),
    materialPermissions: new KyselyMaterialPermissionRepository(db),
  };

  // 追溯穿透用例被追溯报表用例复用，保证两处穿透逻辑与成环检测完全一致
  const penetrateBatchDag = new PenetrateBatchDagUseCase(uow);

  const useCases = {
    createInspectionOrder: new CreateInspectionOrderUseCase(uow),
    recordMeasurementsAndJudge: new RecordMeasurementsAndJudgeUseCase(uow),
    saveInspectionDraft: new SaveInspectionDraftUseCase(uow),
    createReinspection: new CreateReinspectionUseCase(uow),
    triggerMrbReview: new TriggerMrbReviewUseCase(uow),
    advanceMrbStep: new AdvanceMrbStepUseCase(uow),
    customerSignOff: new CustomerSignOffUseCase(uow),
    decideMrbDisposition: new DecideMrbDispositionUseCase(uow),
    createPlan: new CreatePlanUseCase(uow),
    upgradePlanVersion: new UpgradePlanVersionUseCase(uow),
    togglePlanVersion: new TogglePlanVersionUseCase(uow),
    checkReleaseGate: new CheckReleaseGateUseCase(uow),
    penetrateBatchDag,
    exportInspectionReport: new ExportInspectionReportUseCase(uow),
    exportTraceReport: new ExportTraceReportUseCase(uow, penetrateBatchDag),
  };
  return {
    db,
    uow,
    repositories,
    useCases,
    dispose: async () => {
      if (!externalDb) {
        await db.destroy();
      }
    },
  };
}
