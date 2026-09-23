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
 * 纯内存领域聚合，负责管理生命周期流转、方案版本快照深拷贝绑定、实测值录入、不解检标记与整单综合判定
 */
export class InspectionOrder {
  private id: string;
  private orderNo: string;
  private inspectionType: InspectionType;
  private status: InspectionStatus;
  private materialCode: string;
  private materialName: string;
  private batchNo: string;
  private heatBatchNo?: string | undefined;
  private batchQty: number;
  private sampleQty: number;
  private passQty: number = 0;
  private failQty: number = 0;
  private exemptQty: number = 0;
  private _isMandatoryGate: boolean = false;
  private planVersionId?: string | undefined;
  private supplierCode?: string | undefined;
  private supplierName?: string | undefined;
  private customerCode?: string | undefined;
  private customerName?: string | undefined;
  // 检验人快照（姓名冗余自员工主数据，台账/证书直接展示；写入方为实际承担检验的操作人）
  private inspectorId?: string | undefined;
  private inspectorName?: string | undefined;
  // 006 来料检验 (IQC) 入库单号 / 入库日期 / 规格型号对账字段
  private inboundNo?: string | undefined;
  private inboundDate?: string | undefined;
  private specification?: string | undefined;
  private unit?: string | undefined;
  // 008 出货检验 (OQC_SH) 销售出库台账字段
  private salesOrderNo?: string | undefined;
  private dispatchDate?: string | undefined;
  private salesOrderPoNo?: string | undefined;
  private erpStatus?: string | undefined;
  // 009 委外检验 (OQC 七分类) 台账字段
  private outsourceNo?: string | undefined;
  private processType?: string | undefined;
  private returnDate?: string | undefined;
  private vendorName?: string | undefined;
  // 030 委外检验录入页业务事实字段（docs/36）：材质牌号 / 执行技术标准 / 检验日期
  private materialGrade?: string | undefined;
  private techStandard?: string | undefined;
  private inspectedDate?: string | undefined;
  // 007 过程检验 (IPQC: 下料检验/滚丝检验/成品检) 工序追溯字段
  private workOrderNo?: string | undefined;
  private blankingLength?: number | undefined;
  private operatorName?: string | undefined;
  private operatorId?: string | undefined;
  private equipmentCode?: string | undefined;
  private equipmentName?: string | undefined;
  private threadSpec?: string | undefined;
  private inspectionTeam?: string | undefined;
  private processStep?: string | undefined;
  // 报检批量（物理列 total_qty，过程检验台账「数量」列）；与 batchQty 语义一致但允许缺省，
  // 缺省时不落库、不推导 —— 避免用 sampleQty 顶替批量数造成假值（见 docs/29 §2 第 5 列）
  private totalQty?: number | undefined;
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
    heatBatchNo?: string | undefined;
    batchQty: number;
    sampleQty?: number | undefined;
    passQty?: number | undefined;
    failQty?: number | undefined;
    exemptQty?: number | undefined;
    isMandatoryGate?: boolean | undefined;
    planVersionId?: string | undefined;
    supplierCode?: string | undefined;
    supplierName?: string | undefined;
    customerCode?: string | undefined;
    customerName?: string | undefined;
    inspectorId?: string | undefined;
    inspectorName?: string | undefined;
    inboundNo?: string | undefined;
    inboundDate?: string | undefined;
    specification?: string | undefined;
    unit?: string | undefined;
    salesOrderNo?: string | undefined;
    dispatchDate?: string | undefined;
    salesOrderPoNo?: string | undefined;
    erpStatus?: string | undefined;
    outsourceNo?: string | undefined;
    processType?: string | undefined;
    returnDate?: string | undefined;
    vendorName?: string | undefined;
    materialGrade?: string | undefined;
    techStandard?: string | undefined;
    inspectedDate?: string | undefined;
    workOrderNo?: string | undefined;
    blankingLength?: number | undefined;
    operatorName?: string | undefined;
    operatorId?: string | undefined;
    equipmentCode?: string | undefined;
    equipmentName?: string | undefined;
    threadSpec?: string | undefined;
    inspectionTeam?: string | undefined;
    processStep?: string | undefined;
    totalQty?: number | undefined;
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
    this.heatBatchNo = params.heatBatchNo;
    this.batchQty = params.batchQty;
    this.sampleQty = params.sampleQty ?? Math.min(params.batchQty, 13);
    this.passQty = params.passQty ?? 0;
    this.failQty = params.failQty ?? 0;
    this.exemptQty = params.exemptQty ?? 0;
    this._isMandatoryGate = params.isMandatoryGate ?? false;
    this.planVersionId = params.planVersionId;
    this.supplierCode = params.supplierCode;
    this.supplierName = params.supplierName;
    this.customerCode = params.customerCode;
    this.customerName = params.customerName;
    this.inspectorId = params.inspectorId;
    this.inspectorName = params.inspectorName;
    this.inboundNo = params.inboundNo;
    this.inboundDate = params.inboundDate;
    this.specification = params.specification;
    this.unit = params.unit;
    this.salesOrderNo = params.salesOrderNo;
    this.dispatchDate = params.dispatchDate;
    this.salesOrderPoNo = params.salesOrderPoNo;
    this.erpStatus = params.erpStatus;
    this.outsourceNo = params.outsourceNo;
    this.processType = params.processType;
    this.returnDate = params.returnDate;
    this.vendorName = params.vendorName;
    this.materialGrade = params.materialGrade;
    this.techStandard = params.techStandard;
    this.inspectedDate = params.inspectedDate;
    this.workOrderNo = params.workOrderNo;
    this.blankingLength = params.blankingLength;
    this.operatorName = params.operatorName;
    this.operatorId = params.operatorId;
    this.equipmentCode = params.equipmentCode;
    this.equipmentName = params.equipmentName;
    this.threadSpec = params.threadSpec;
    this.inspectionTeam = params.inspectionTeam;
    this.processStep = params.processStep;
    this.totalQty = params.totalQty;
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

  public getMaterialName(): string {
    return this.materialName;
  }

  public getBatchNo(): string {
    return this.batchNo;
  }

  public getHeatBatchNo(): string | undefined {
    return this.heatBatchNo;
  }

  public setHeatBatchNo(heatBatchNo: string | undefined): void {
    this.heatBatchNo = heatBatchNo;
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

  public getExemptQty(): number {
    return this.exemptQty;
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

  public getCustomerCode(): string | undefined {
    return this.customerCode;
  }

  public getCustomerName(): string | undefined {
    return this.customerName;
  }

  public getInspectorId(): string | undefined {
    return this.inspectorId;
  }

  public getInspectorName(): string | undefined {
    return this.inspectorName;
  }

  public getInboundNo(): string | undefined {
    return this.inboundNo;
  }

  public getInboundDate(): string | undefined {
    return this.inboundDate;
  }

  public getSpecification(): string | undefined {
    return this.specification;
  }

  public getUnit(): string | undefined {
    return this.unit;
  }

  public getSalesOrderNo(): string | undefined {
    return this.salesOrderNo;
  }

  public getDispatchDate(): string | undefined {
    return this.dispatchDate;
  }

  public getSalesOrderPoNo(): string | undefined {
    return this.salesOrderPoNo;
  }

  public getErpStatus(): string | undefined {
    return this.erpStatus;
  }

  public getOutsourceNo(): string | undefined {
    return this.outsourceNo;
  }

  public getProcessType(): string | undefined {
    return this.processType;
  }

  public getReturnDate(): string | undefined {
    return this.returnDate;
  }

  public getVendorName(): string | undefined {
    return this.vendorName;
  }

  public getMaterialGrade(): string | undefined {
    return this.materialGrade;
  }

  public getTechStandard(): string | undefined {
    return this.techStandard;
  }

  public getInspectedDate(): string | undefined {
    return this.inspectedDate;
  }

  public getWorkOrderNo(): string | undefined {
    return this.workOrderNo;
  }

  public getBlankingLength(): number | undefined {
    return this.blankingLength;
  }

  public getOperatorName(): string | undefined {
    return this.operatorName;
  }

  public getOperatorId(): string | undefined {
    return this.operatorId;
  }

  public getEquipmentCode(): string | undefined {
    return this.equipmentCode;
  }

  public getEquipmentName(): string | undefined {
    return this.equipmentName;
  }

  public getThreadSpec(): string | undefined {
    return this.threadSpec;
  }

  public getInspectionTeam(): string | undefined {
    return this.inspectionTeam;
  }

  public getProcessStep(): string | undefined {
    return this.processStep;
  }

  public getTotalQty(): number | undefined {
    return this.totalQty;
  }

  public getCompletedAt(): string | undefined {
    return this.completedAt;
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
   * 绑定质检方案版本快照 (深拷贝隔离)
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
      acceptableValues: pItem.acceptableValues,
      unit: pItem.unit,
      sampleSize: this.sampleQty,
      result: 'PENDING',
      isExempt: false,
      isManuallyModified: false,
    }));
  }

  public startInspection(): void {
    InspectionStateMachine.assertTransition(this.status, 'INSPECTING');
    this.status = 'INSPECTING';
  }

  public saveDraft(): void {
    InspectionStateMachine.assertTransition(this.status, 'DRAFT');
    this.status = 'DRAFT';
  }

  /**
   * 标记某个检验项为免检 / 不解检 (过程检验抽检支持)
   */
  public markItemExempt(params: {
    itemCode: string;
    isExempt: boolean;
    exemptReason?: string;
  }): InspectionItemDTO {
    if (this.status !== 'INSPECTING' && this.status !== 'DRAFT') {
      throw new Error(`ORDER_NOT_EDITABLE: 工单当前处于 [${this.status}] 状态，禁止标记免检`);
    }

    const item = this.items.find(i => i.itemCode === params.itemCode);
    if (!item) {
      throw new Error(`ORDER_ITEM_NOT_FOUND: 未找到指标编码为 [${params.itemCode}] 的检验项`);
    }

    item.isExempt = params.isExempt;
    item.exemptReason = params.exemptReason;
    item.result = evaluateInspectionItem(item);

    return { ...item };
  }

  /**
   * 录入或更新单个检验项实测数据并触发判定
   */
  public recordItemMeasurement(params: {
    itemCode: string;
    measuredVal?: number;
    measuredText?: string;
    inheritedHeatValue?: number | string;
    isManuallyModified?: boolean;
    modificationReason?: string;
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
    if (params.inheritedHeatValue !== undefined) {
      item.originalInheritedValue = params.inheritedHeatValue;
    }
    if (params.isManuallyModified !== undefined) {
      item.isManuallyModified = params.isManuallyModified;
    }
    if (params.modificationReason !== undefined) {
      item.modifiedReason = params.modificationReason;
    }

    item.result = evaluateInspectionItem(item);
    return { ...item };
  }

  /**
   * 提交检验单并执行终检判定
   * 工业安全核心逻辑：
   * 1. 任何一个检验项为 FAILED -> 整单判定为 FAILED；
   * 2. 若存在任何检验项为 PENDING（非免检未录入） -> 整单判为 FAILED 阻断；
   * 3. 处于 EXEMPT 的项目不阻塞判定，跳过合格率分母；
   * 4. 只有所有非免检项均为 PASSED -> 整单判定为 PASSED。
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
    let exemptCount = 0;

    for (const item of this.items) {
      const decision = evaluateInspectionItem(item);
      item.result = decision;
      if (decision === 'FAILED') {
        hasFailure = true;
      } else if (decision === 'PENDING') {
        hasPending = true;
      } else if (decision === 'EXEMPT') {
        exemptCount++;
      }
    }

    this.exemptQty = exemptCount;

    if (hasFailure || hasPending) {
      InspectionStateMachine.assertTransition(this.status, 'FAILED');
      this.status = 'FAILED';
      this.overallDecision = 'FAILED';
      this.failQty = this.sampleQty - this.passQty - this.exemptQty;
      if (this.failQty < 0) this.failQty = this.sampleQty;
    } else {
      InspectionStateMachine.assertTransition(this.status, 'PASSED');
      this.status = 'PASSED';
      this.overallDecision = 'PASSED';
      this.passQty = this.sampleQty - this.exemptQty;
      this.failQty = 0;
    }

    return this.overallDecision;
  }

  public routeToMRB(): void {
    InspectionStateMachine.assertTransition(this.status, 'IN_MRB_REVIEW');
    this.status = 'IN_MRB_REVIEW';
  }

  public markInMrb(): void {
    this.routeToMRB();
  }

  public markReInspecting(): void {
    InspectionStateMachine.assertTransition(this.status, 'RE_INSPECTING');
    this.status = 'RE_INSPECTING';
  }

  public complete(): void {
    InspectionStateMachine.assertTransition(this.status, 'COMPLETED');
    this.status = 'COMPLETED';
    this.completedAt = new Date().toISOString();
  }

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
      ...(this.totalQty !== undefined ? { totalQty: this.totalQty } : {}),
      passQty: this.passQty,
      failQty: this.failQty,
      isMandatoryGate: this._isMandatoryGate,
      planVersionId: this.planVersionId,
      planSnapshot: snapshot,
      items: JSON.parse(JSON.stringify(this.items)),
      createdAt: this.createdAt,
      ...(this.heatBatchNo !== undefined ? { heatBatchNo: this.heatBatchNo } : {}),
      ...(this.exemptQty !== undefined ? { exemptQty: this.exemptQty } : {}),
      ...(this.supplierCode !== undefined ? { supplierCode: this.supplierCode } : {}),
      ...(this.supplierName !== undefined ? { supplierName: this.supplierName } : {}),
      ...(this.customerCode !== undefined ? { customerCode: this.customerCode } : {}),
      ...(this.customerName !== undefined ? { customerName: this.customerName } : {}),
      ...(this.inspectorId !== undefined ? { inspectorId: this.inspectorId } : {}),
      ...(this.inspectorName !== undefined ? { inspectorName: this.inspectorName } : {}),
      // 006 入库单号 / 入库日期 / 规格型号 / 计量单位：
      // specification 同时回填契约里的别名字段 spec，保证两个口径一致
      ...(this.inboundNo !== undefined ? { inboundNo: this.inboundNo } : {}),
      ...(this.inboundDate !== undefined ? { inboundDate: this.inboundDate } : {}),
      ...(this.specification !== undefined
        ? { specification: this.specification, spec: this.specification }
        : {}),
      ...(this.unit !== undefined ? { unit: this.unit } : {}),
      ...(this.salesOrderNo !== undefined ? { salesOrderNo: this.salesOrderNo } : {}),
      ...(this.dispatchDate !== undefined ? { dispatchDate: this.dispatchDate } : {}),
      ...(this.salesOrderPoNo !== undefined ? { salesOrderPoNo: this.salesOrderPoNo } : {}),
      ...(this.erpStatus !== undefined ? { erpStatus: this.erpStatus } : {}),
      ...(this.outsourceNo !== undefined ? { outsourceNo: this.outsourceNo } : {}),
      ...(this.processType !== undefined ? { processType: this.processType } : {}),
      ...(this.returnDate !== undefined ? { returnDate: this.returnDate } : {}),
      ...(this.vendorName !== undefined ? { vendorName: this.vendorName } : {}),
      ...(this.materialGrade !== undefined ? { materialGrade: this.materialGrade } : {}),
      ...(this.techStandard !== undefined ? { techStandard: this.techStandard } : {}),
      ...(this.inspectedDate !== undefined ? { inspectedDate: this.inspectedDate } : {}),
      // 007 过程检验工序追溯字段：此前聚合根完全没有这些属性，重建型用例的 `...orderDto` 展开
      // 传进来后被构造签名静默吞掉，序列化回去就丢了（下料检验台账的断料长度/操作员/设备列）
      ...(this.workOrderNo !== undefined ? { workOrderNo: this.workOrderNo } : {}),
      ...(this.blankingLength !== undefined ? { blankingLength: this.blankingLength } : {}),
      ...(this.operatorName !== undefined ? { operatorName: this.operatorName } : {}),
      ...(this.operatorId !== undefined ? { operatorId: this.operatorId } : {}),
      ...(this.equipmentCode !== undefined ? { equipmentCode: this.equipmentCode } : {}),
      ...(this.equipmentName !== undefined ? { equipmentName: this.equipmentName } : {}),
      ...(this.threadSpec !== undefined ? { threadSpec: this.threadSpec } : {}),
      ...(this.inspectionTeam !== undefined ? { inspectionTeam: this.inspectionTeam } : {}),
      ...(this.processStep !== undefined ? { processStep: this.processStep } : {}),
      ...(this.overallDecision !== undefined ? { overallDecision: this.overallDecision } : {}),
      // 完成时间就是 completedAt：此前这里把它写进了 updatedAt，调用方拿到的「完成时间」
      // 与库列 completed_at 对不上（读侧 mapRow 用的是 completed_at）—— 口径统一
      ...(this.completedAt !== undefined ? { completedAt: this.completedAt } : {}),
    };
  }
}
