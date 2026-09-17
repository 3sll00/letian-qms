import {
  InspectionOrder as InspectionOrderDTO,
  InspectionItem as InspectionItemDTO,
  PlanSnapshot as PlanSnapshotDTO,
  InspectionPlanVersion as InspectionPlanVersionDTO,
  InspectionType,
  InspectionStatus,
  OverallDecision
} from '@letian/contracts';
import { InspectionStateMachine } from '../state-machines/inspection-state-machine';
import { evaluateInspectionItem } from '../services/tolerance-evaluator';

/**
 * 检验单聚合根 (InspectionOrder)
 * 纯内存领域聚合，负责管理生命周期流转、方案版本快照深拷贝绑定、实测值录入与整单综合判定
 */
export class InspectionOrder {
  private id: string;
  private orderNo: string;
  private inspectionType: InspectionType;
  private status: InspectionStatus;
  private materialCode: string;
  private materialName: string;
  private batchNo: string;
  private batchQty: number;
  private sampleQty: number;
  private passQty: number = 0;
  private failQty: number = 0;
  private _isMandatoryGate: boolean = false;
  private planVersionId?: string | undefined;
  private supplierCode?: string | undefined;
  private supplierName?: string | undefined;
  private overallDecision?: OverallDecision | undefined;
  private planSnapshot?: PlanSnapshotDTO | undefined;
  private items: InspectionItemDTO[];
  private createdAt: string;
  private completedAt?: string | undefined;

  constructor(params: {
    id: string;
    orderNo: string;
    inspectionType: InspectionType;
    status?: InspectionStatus | undefined;
    materialCode: string;
    materialName: string;
    batchNo: string;
    batchQty: number;
    sampleQty?: number | undefined;
    passQty?: number | undefined;
    failQty?: number | undefined;
    isMandatoryGate?: boolean | undefined;
    planVersionId?: string | undefined;
    supplierCode?: string | undefined;
    supplierName?: string | undefined;
    overallDecision?: OverallDecision | undefined;
    planSnapshot?: PlanSnapshotDTO | undefined;
    items?: InspectionItemDTO[] | undefined;
    createdAt?: string | undefined;
    completedAt?: string | undefined;
  }) {
    this.id = params.id;
    this.orderNo = params.orderNo;
    this.inspectionType = params.inspectionType;
    this.status = params.status ?? 'PENDING';
    this.materialCode = params.materialCode;
    this.materialName = params.materialName;
    this.batchNo = params.batchNo;
    this.batchQty = params.batchQty;
    this.sampleQty = params.sampleQty ?? Math.min(params.batchQty, 13);
    this.passQty = params.passQty ?? 0;
    this.failQty = params.failQty ?? 0;
    this._isMandatoryGate = params.isMandatoryGate ?? false;
    this.planVersionId = params.planVersionId;
    this.supplierCode = params.supplierCode;
    this.supplierName = params.supplierName;
    this.overallDecision = params.overallDecision;
    this.planSnapshot = params.planSnapshot ? JSON.parse(JSON.stringify(params.planSnapshot)) : undefined;
    this.items = params.items ? JSON.parse(JSON.stringify(params.items)) : [];
    this.createdAt = params.createdAt ?? new Date().toISOString();
    this.completedAt = params.completedAt;
  }

  public getId(): string {
    return this.id;
  }

  public getOrderNo(): string {
    return this.orderNo;
  }

  public getInspectionType(): InspectionType {
    return this.inspectionType;
  }

  public getStatus(): InspectionStatus {
    return this.status;
  }

  public getMaterialCode(): string {
    return this.materialCode;
  }

  public getBatchNo(): string {
    return this.batchNo;
  }

  public getBatchQty(): number {
    return this.batchQty;
  }

  public getSampleQty(): number {
    return this.sampleQty;
  }

  public getPassQty(): number {
    return this.passQty;
  }

  public getFailQty(): number {
    return this.failQty;
  }

  public isMandatoryGate(): boolean {
    return this._isMandatoryGate;
  }

  public getPlanVersionId(): string | undefined {
    return this.planVersionId;
  }

  public getSupplierCode(): string | undefined {
    return this.supplierCode;
  }

  public getSupplierName(): string | undefined {
    return this.supplierName;
  }

  public getOverallDecision(): OverallDecision | undefined {
    return this.overallDecision;
  }

  public getPlanSnapshot(): PlanSnapshotDTO | undefined {
    return this.planSnapshot ? JSON.parse(JSON.stringify(this.planSnapshot)) : undefined;
  }

  public getItems(): readonly InspectionItemDTO[] {
    return this.items;
  }

  /**
   * 核心业务方法：绑定质检方案版本快照 (深拷贝隔离)
   * 必须在工单初始化或未完成检验前调用，确保后续方案版本的变更不影响本批历史工单的标准基准
   */
  public bindPlanSnapshot(
    planVersion: InspectionPlanVersionDTO,
    planInfo: { planId: string; planCode: string; planName?: string } | string
  ): void {
    if (this.status !== 'PENDING' && this.status !== 'DRAFT') {
      throw new Error(`ORDER_CANNOT_BIND_SNAPSHOT: 处于 [${this.status}] 状态的工单禁止重新绑定质检方案快照`);
    }

    if (!planVersion.items || planVersion.items.length === 0) {
      throw new Error(`ORDER_EMPTY_PLAN_ITEMS: 方案版本 [${planVersion.versionNo}] 不包含任何指标项，无法绑定`);
    }

    const planId = typeof planInfo === 'string' ? planVersion.planId : planInfo.planId;
    const planCode = typeof planInfo === 'string' ? planInfo : planInfo.planCode;
    const planName = typeof planInfo === 'string' ? `Plan-${planCode}` : (planInfo.planName ?? `Plan-${planCode}`);

    this.planVersionId = planVersion.id ?? planVersion.planId;

    // 执行深拷贝绑定，对齐契约 PlanSnapshot 扁平结构
    this.planSnapshot = {
      planId,
      planCode,
      planName,
      versionId: planVersion.id ?? planVersion.planId,
      versionNo: planVersion.versionNo,
      samplingScheme: planVersion.samplingScheme,
      aqlLevel: planVersion.aqlLevel,
      strictness: planVersion.strictness,
      items: JSON.parse(JSON.stringify(planVersion.items)),
      snapshotAt: new Date().toISOString(),
    };

    // 基于方案指标项初始化工单检验项实测模型
    // 检验项 id 必须满足契约 InspectionItemSchema.id (z.string().uuid())：
    // 早期实现使用 `${orderId}-${itemCode}` 复合串，会让所有经 API 创建的工单响应违反自身契约。
    // 该 id 对下游只是不透明标识（更新工单时由库中已存 DTO 原样带回，不重新生成），改为 UUID 不改变业务语义。
    this.items = planVersion.items.map((pItem, index) => ({
      id: crypto.randomUUID(),
      seq: index + 1,
      itemCode: pItem.itemCode,
      name: pItem.name,
      dataType: pItem.dataType,
      metricCategory: pItem.metricCategory,
      nominalValue: pItem.nominalValue,
      upperTolerance: pItem.upperTolerance,
      lowerTolerance: pItem.lowerTolerance,
      standardText: pItem.standardText,
      unit: pItem.unit,
      sampleSize: this.sampleQty,
      result: 'PENDING',
    }));
  }

  /**
   * 状态流转：开始检验
   */
  public startInspection(): void {
    InspectionStateMachine.assertTransition(this.status, 'INSPECTING');
    this.status = 'INSPECTING';
  }

  /**
   * 状态流转：暂存为草稿
   */
  public saveDraft(): void {
    InspectionStateMachine.assertTransition(this.status, 'DRAFT');
    this.status = 'DRAFT';
  }

  /**
   * 录入或更新单个检验项实测数据并触发判定
   */
  public recordItemMeasurement(params: {
    itemCode: string;
    measuredVal?: number;
    measuredText?: string;
  }): InspectionItemDTO {
    if (this.status !== 'INSPECTING' && this.status !== 'DRAFT') {
      throw new Error(`ORDER_NOT_EDITABLE: 工单当前处于 [${this.status}] 状态，禁止录入或修改检验指标`);
    }

    const item = this.items.find(i => i.itemCode === params.itemCode);
    if (!item) {
      throw new Error(`ORDER_ITEM_NOT_FOUND: 未找到指标编码为 [${params.itemCode}] 的检验项`);
    }

    item.measuredVal = params.measuredVal;
    item.measuredText = params.measuredText;
    // 调用领域服务进行实测判定
    item.result = evaluateInspectionItem(item);

    return { ...item };
  }

  /**
   * 提交检验单并执行终检判定
   * 工业安全核心逻辑：
   * 1. 任何一个检验项为 FAILED -> 整单必须判定为 REJECTED，状态转为 FAILED；
   * 2. 若存在任何检验项为 PENDING（未录入或无标准） -> 严禁通过，状态转为 FAILED 阻断；
   * 3. 只有全量检验项均为 PASSED -> 整单判定为 ACCEPTED，状态转为 PASSED；
   */
  public submitAndEvaluate(): OverallDecision {
    if (this.status !== 'INSPECTING') {
      throw new Error(`ORDER_CANNOT_SUBMIT: 仅有处于 INSPECTING 状态的工单可提交判定，当前状态为 [${this.status}]`);
    }

    if (this.items.length === 0) {
      throw new Error(`ORDER_HAS_NO_ITEMS: 检验单无任何检验项，严禁提交评定`);
    }

    let hasFailure = false;
    let hasPending = false;

    for (const item of this.items) {
      const decision = evaluateInspectionItem(item);
      item.result = decision;
      if (decision === 'FAILED') {
        hasFailure = true;
      } else if (decision === 'PENDING') {
        hasPending = true;
      }
    }

    if (hasFailure || hasPending) {
      InspectionStateMachine.assertTransition(this.status, 'FAILED');
      this.status = 'FAILED';
      this.overallDecision = 'FAILED';
    } else {
      InspectionStateMachine.assertTransition(this.status, 'PASSED');
      this.status = 'PASSED';
      this.overallDecision = 'PASSED';
    }

    return this.overallDecision;
  }

  /**
   * 触发 MRB 会签评审流转
   */
  public routeToMRB(): void {
    InspectionStateMachine.assertTransition(this.status, 'IN_MRB_REVIEW');
    this.status = 'IN_MRB_REVIEW';
  }

  /**
   * 兼容别名：标记进入 MRB
   */
  public markInMrb(): void {
    this.routeToMRB();
  }

  /**
   * 触发返工/复检回边
   */
  public markReInspecting(): void {
    InspectionStateMachine.assertTransition(this.status, 'RE_INSPECTING');
    this.status = 'RE_INSPECTING';
  }

  /**
   * 归档完成结单
   */
  public complete(): void {
    InspectionStateMachine.assertTransition(this.status, 'COMPLETED');
    this.status = 'COMPLETED';
    this.completedAt = new Date().toISOString();
  }

  /**
   * 导出契约 DTO 视图
   */
  public toDTO(): InspectionOrderDTO {
    const snapshot = this.getPlanSnapshot();
    if (!this.planVersionId || !snapshot) {
      throw new Error(`ORDER_SNAPSHOT_NOT_BOUND: 工单 [${this.orderNo}] 尚未绑定质检方案快照，无法序列化为完整契约 DTO`);
    }

    return {
      id: this.id,
      orderNo: this.orderNo,
      inspectionType: this.inspectionType,
      status: this.status,
      materialCode: this.materialCode,
      materialName: this.materialName,
      batchNo: this.batchNo,
      sampleQty: this.sampleQty,
      passQty: this.passQty,
      failQty: this.failQty,
      isMandatoryGate: this._isMandatoryGate,
      planVersionId: this.planVersionId,
      planSnapshot: snapshot,
      items: JSON.parse(JSON.stringify(this.items)),
      createdAt: this.createdAt,
      ...(this.supplierCode !== undefined ? { supplierCode: this.supplierCode } : {}),
      ...(this.supplierName !== undefined ? { supplierName: this.supplierName } : {}),
      ...(this.overallDecision !== undefined ? { overallDecision: this.overallDecision } : {}),
      ...(this.completedAt !== undefined ? { updatedAt: this.completedAt } : {}),
    };
  }
}
