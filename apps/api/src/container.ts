import {
  AdvanceMrbStepUseCase,
  CheckReleaseGateUseCase,
  CheckTransferPermitUseCase,
  CheckPermissionUseCase,
  CreateInspectionOrderUseCase,
  CreatePlanUseCase,
  CreateReinspectionUseCase,
  CustomerSignOffUseCase,
  DecideMrbDispositionUseCase,
  ExportInspectionReportUseCase,
  ExportTraceReportUseCase,
  FinalizeInspectionStatusUseCase,
  GetChainStatusUseCase,
  GetOrderTraceChainUseCase,
  PenetrateBatchDagUseCase,
  RecordMeasurementsAndJudgeUseCase,
  SaveInspectionDraftUseCase,
  SearchTraceBatchesUseCase,
  TogglePlanVersionUseCase,
  TriggerMrbReviewUseCase,
  UpgradePlanVersionUseCase,
  PendingMRBPoolUseCase,
  UpdateInspectionHeatFieldsUseCase,
  CreateTransferOverrideTicketUseCase,
  ReviewTransferOverrideTicketUseCase,
  ListTransferOverrideTicketsUseCase,
  BatchFreezeTerminatedChainsUseCase,
  GetTransferKpisUseCase,
  SyncErpIncomingInspectionsUseCase,
  SyncErpOutsourceInspectionsUseCase,
  SyncErpSalesDispatchUseCase,
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
  KyselyPendingDefectPoolRepository,
  KyselyMasterDataRepository,
  KyselyMaterialPermissionRepository,
  KyselyRoleRepository,
  KyselyAuthorizationLogRepository,
  KyselyReviewFlowRepository,
  KyselyEquipmentRepository,
  StandardReportEngine,
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
    pendingDefects: KyselyPendingDefectPoolRepository;
    auditLogs: KyselyAuditLogRepository;
    traces: KyselyBatchTraceRepository;
    masterData: KyselyMasterDataRepository;
    equipment: KyselyEquipmentRepository;
    integration: KyselyIntegrationRepository;
    dashboard: KyselyDashboardRepository;
    reviewFlows: KyselyReviewFlowRepository;
    materialPermissions: KyselyMaterialPermissionRepository;
    roles: KyselyRoleRepository;
    authorizationLogs: KyselyAuthorizationLogRepository;
  };

  /** 应用层用例（写侧唯一入口） */
  readonly useCases: {
    checkPermission: CheckPermissionUseCase;
    createInspectionOrder: CreateInspectionOrderUseCase;
    recordMeasurementsAndJudge: RecordMeasurementsAndJudgeUseCase;
    saveInspectionDraft: SaveInspectionDraftUseCase;
    /** 炉批号表头写入口（PATCH /inspections/{id}/header）：落炉批号 / 材质牌号 / 标准 / 检验日期（docs/47 §4.5） */
    updateInspectionHeatFields: UpdateInspectionHeatFieldsUseCase;
    /** 终判唯一写入口：状态 / 结论 / 终判时间落库，判不合格时同事务入不合格待审核池（docs/39 §2 D1） */
    finalizeInspectionStatus: FinalizeInspectionStatusUseCase;
    createReinspection: CreateReinspectionUseCase;
    triggerMrbReview: TriggerMrbReviewUseCase;
    advanceMrbStep: AdvanceMrbStepUseCase;
    customerSignOff: CustomerSignOffUseCase;
    decideMrbDisposition: DecideMrbDispositionUseCase;
    createPlan: CreatePlanUseCase;
    upgradePlanVersion: UpgradePlanVersionUseCase;
    togglePlanVersion: TogglePlanVersionUseCase;
    checkReleaseGate: CheckReleaseGateUseCase;
    /** 「合格后传递」传递许可（纯读）：建单前预览 / 台账与看板的派生字段（docs/48 §4.5） */
    checkTransferPermit: CheckTransferPermitUseCase;
    createTransferOverrideTicket: CreateTransferOverrideTicketUseCase;
    reviewTransferOverrideTicket: ReviewTransferOverrideTicketUseCase;
    listTransferOverrideTickets: ListTransferOverrideTicketsUseCase;
    batchFreezeTerminatedChains: BatchFreezeTerminatedChainsUseCase;
    getTransferKpis: GetTransferKpisUseCase;
    penetrateBatchDag: PenetrateBatchDagUseCase;
    /** 批次检索：按批次号/炉批号/订单号/物料/成品名命中批次列表（追溯主键是批次号） */
    searchTraceBatches: SearchTraceBatchesUseCase;
    /** 订单维度检验环节台账（「本订单检验环节」，不是血缘链路） */
    getOrderTraceChain: GetOrderTraceChainUseCase;
    /** 看板「传递链状态」：链路各环节排序 + 每环节的传递判定（纯读，docs/48 §4.6 P1） */
    getChainStatus: GetChainStatusUseCase;
    exportInspectionReport: ExportInspectionReportUseCase;
    exportTraceReport: ExportTraceReportUseCase;
    pendingMRBPool: PendingMRBPoolUseCase;
    /** ERP 来料检验拉取并生成 QMS 来料检验单（IQC）用例（第①段闭环编排） */
    syncErpIncomingInspections: SyncErpIncomingInspectionsUseCase;
    /** ERP 委外加工单拉取并生成 QMS 委外检验单（OQC_SF/MACH/HEAT）用例（委外检验第①段闭环编排） */
    syncErpOutsourceInspections: SyncErpOutsourceInspectionsUseCase;
    /** ERP 销售出库拉取并生成 QMS 出货检验单（OQC_SH）用例（出货检验第①段闭环编排） */
    syncErpSalesDispatch: SyncErpSalesDispatchUseCase;
  };
  readonly reportEngine: StandardReportEngine;

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
    pendingDefects: new KyselyPendingDefectPoolRepository(db),
    auditLogs: new KyselyAuditLogRepository(db),
    traces: new KyselyBatchTraceRepository(db),
    masterData: new KyselyMasterDataRepository(db),
    equipment: new KyselyEquipmentRepository(db),
    integration: new KyselyIntegrationRepository(db),
    dashboard: new KyselyDashboardRepository(db),
    reviewFlows: new KyselyReviewFlowRepository(db),
    materialPermissions: new KyselyMaterialPermissionRepository(db),
    roles: new KyselyRoleRepository(db),
    authorizationLogs: new KyselyAuthorizationLogRepository(db),
  };

  // 追溯穿透用例被追溯报表用例复用，保证两处穿透逻辑与成环检测完全一致
  const penetrateBatchDag = new PenetrateBatchDagUseCase(uow);

  const useCases = {
    checkPermission: new CheckPermissionUseCase(uow),
    createInspectionOrder: new CreateInspectionOrderUseCase(uow),
    recordMeasurementsAndJudge: new RecordMeasurementsAndJudgeUseCase(uow),
    saveInspectionDraft: new SaveInspectionDraftUseCase(uow),
    updateInspectionHeatFields: new UpdateInspectionHeatFieldsUseCase(uow),
    finalizeInspectionStatus: new FinalizeInspectionStatusUseCase(uow),
    createReinspection: new CreateReinspectionUseCase(uow),
    triggerMrbReview: new TriggerMrbReviewUseCase(uow),
    advanceMrbStep: new AdvanceMrbStepUseCase(uow),
    customerSignOff: new CustomerSignOffUseCase(uow),
    decideMrbDisposition: new DecideMrbDispositionUseCase(uow),
    createPlan: new CreatePlanUseCase(uow),
    upgradePlanVersion: new UpgradePlanVersionUseCase(uow),
    togglePlanVersion: new TogglePlanVersionUseCase(uow),
    checkReleaseGate: new CheckReleaseGateUseCase(uow),
    checkTransferPermit: new CheckTransferPermitUseCase(uow),
    penetrateBatchDag,
    searchTraceBatches: new SearchTraceBatchesUseCase(uow),
    getOrderTraceChain: new GetOrderTraceChainUseCase(uow),
    getChainStatus: new GetChainStatusUseCase(uow),
    exportInspectionReport: new ExportInspectionReportUseCase(uow),
    exportTraceReport: new ExportTraceReportUseCase(uow, penetrateBatchDag),
    pendingMRBPool: new PendingMRBPoolUseCase(uow),
    createTransferOverrideTicket: new CreateTransferOverrideTicketUseCase(uow),
    reviewTransferOverrideTicket: new ReviewTransferOverrideTicketUseCase(uow),
    listTransferOverrideTickets: new ListTransferOverrideTicketsUseCase(uow),
    batchFreezeTerminatedChains: new BatchFreezeTerminatedChainsUseCase(uow),
    getTransferKpis: new GetTransferKpisUseCase(uow),
  };
  // ERP 来料检验同步用例需要复用建单用例（保证方案快照/审计/Outbox 一致），
  // 必须在 useCases 对象构造完成后才能引用其 createInspectionOrder 实例。
  const syncErpIncomingInspections = new SyncErpIncomingInspectionsUseCase(uow, useCases.createInspectionOrder);
  const syncErpOutsourceInspections = new SyncErpOutsourceInspectionsUseCase(uow, useCases.createInspectionOrder);
  const syncErpSalesDispatch = new SyncErpSalesDispatchUseCase(uow, useCases.createInspectionOrder);
  const reportEngine = new StandardReportEngine();
  return {
    db,
    uow,
    repositories,
    useCases: { ...useCases, syncErpIncomingInspections, syncErpOutsourceInspections, syncErpSalesDispatch },
    reportEngine,
    dispose: async () => {
      if (!externalDb) {
        await db.destroy();
      }
    },
  };
}
