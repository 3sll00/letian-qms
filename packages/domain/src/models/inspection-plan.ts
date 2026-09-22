import { 
  InspectionPlan as InspectionPlanDTO, 
  InspectionPlanVersion as InspectionPlanVersionDTO, 
  InspectionPlanItem as InspectionPlanItemDTO,
  InspectionType,
  PlanStatus
} from '@letian/contracts';

/**
 * 质检方案聚合根 (InspectionPlan)
 * 纯业务内核聚合，严禁包含任何持久化与网络 I/O
 */
export class InspectionPlan {
  private id: string;
  private planCode: string;
  private planName: string;
  private materialCode?: string | undefined;
  private materialCategory?: string | undefined;
  private categoryCode?: string | undefined;
  private categoryName?: string | undefined;
  private inspectionType: InspectionType;
  private versions: InspectionPlanVersionDTO[];

  constructor(params: {
    id: string;
    planCode: string;
    planName: string;
    materialCode?: string | undefined;
    materialCategory?: string | undefined;
    categoryCode?: string | undefined;
    categoryName?: string | undefined;
    inspectionType: InspectionType;
    versions?: InspectionPlanVersionDTO[];
  }) {
    this.id = params.id;
    this.planCode = params.planCode;
    this.planName = params.planName;
    this.materialCode = params.materialCode;
    this.materialCategory = params.materialCategory ?? params.categoryName;
    this.categoryCode = params.categoryCode;
    this.categoryName = params.categoryName;
    this.inspectionType = params.inspectionType;
    this.versions = params.versions ? [...params.versions] : [];
  }

  public getId(): string {
    return this.id;
  }

  public getPlanCode(): string {
    return this.planCode;
  }

  public getPlanName(): string {
    return this.planName;
  }

  public getMaterialCode(): string | undefined {
    return this.materialCode;
  }

  public getMaterialCategory(): string | undefined {
    return this.materialCategory;
  }

  /** 方案归属的存货分类编码（分类级兜底匹配依据；material_code 为空时表示该分类的通用方案） */
  public getCategoryCode(): string | undefined {
    return this.categoryCode;
  }

  public getInspectionType(): InspectionType {
    return this.inspectionType;
  }

  public getCategoryName(): string | undefined {
    return this.categoryName;
  }

  /**
   * 方案级状态（口径与契约 PlanStatusEnum 一致，是"已启用/待审批/已停用"的唯一判定源）：
   * 存在 ACTIVE 版本 = 已启用；无 ACTIVE 但有 DRAFT 版本 = 待审批；其余（仅剩 INACTIVE）= 已停用。
   */
  public getStatus(): PlanStatus {
    if (this.versions.some(v => v.status === 'ACTIVE')) return 'ENABLED';
    if (this.versions.some(v => v.status === 'DRAFT')) return 'PENDING_APPROVAL';
    return 'DISABLED';
  }

  public getVersions(): readonly InspectionPlanVersionDTO[] {
    return this.versions;
  }

  /**
   * 获取当前激活生效的版本
   */
  public getActiveVersion(): InspectionPlanVersionDTO | undefined {
    return this.versions.find(v => v.status === 'ACTIVE');
  }

  /**
   * 创建新的草稿版本
   * 业务规则：如果已有 DRAFT 版本，严禁并发创建多个草稿，必须基于现有草稿修改或先激活/废弃
   */
  public createDraftVersion(params: {
    id: string;
    versionNo: string;
    items: InspectionPlanItemDTO[];
    samplingScheme?: string;
    aqlLevel?: string;
    strictness?: string;
    effectiveStartDate?: string;
    effectiveEndDate?: string;
    createdBy: string;
  }): InspectionPlanVersionDTO {
    const existingDraft = this.versions.find(v => v.status === 'DRAFT');
    if (existingDraft) {
      throw new Error(`PLAN_DRAFT_ALREADY_EXISTS: 方案 [${this.planCode}] 已存在草稿版本 [${existingDraft.versionNo}]，禁止重复创建`);
    }

    if (!params.items || params.items.length === 0) {
      throw new Error(`PLAN_EMPTY_ITEMS: 创建草稿必须包含至少一个有效指标项`);
    }

    const newVersion: InspectionPlanVersionDTO = {
      id: params.id,
      planId: this.id,
      versionNo: params.versionNo,
      status: 'DRAFT',
      samplingScheme: params.samplingScheme ?? 'GB_T_2828',
      aqlLevel: params.aqlLevel ?? 'II',
      strictness: params.strictness ?? 'NORMAL',
      ...(params.effectiveStartDate !== undefined
        ? { effectiveStartDate: params.effectiveStartDate }
        : {}),
      ...(params.effectiveEndDate !== undefined ? { effectiveEndDate: params.effectiveEndDate } : {}),
      createdBy: params.createdBy,
      createdAt: new Date().toISOString(),
      items: params.items.map(item => ({ ...item })),
    };

    this.versions.push(newVersion);
    return newVersion;
  }

  /**
   * 激活指定版本
   * 业务规则：
   * 1. 待激活版本必须存在且状态合法；
   * 2. 待激活版本必须包含至少 1 项检验指标；
   * 3. 激活新版本时，自动将当前激活的旧版本转为 INACTIVE（单激活态保证）；
   */
  public activateVersion(versionId: string): void {
    const target = this.versions.find(v => v.id === versionId);
    if (!target) {
      throw new Error(`PLAN_VERSION_NOT_FOUND: 未找到版本 [${versionId}]`);
    }

    if (target.status === 'ACTIVE') {
      return; // 幂等放行
    }

    if (target.items.length === 0) {
      throw new Error(`PLAN_ACTIVE_EMPTY_ITEMS: 版本 [${target.versionNo}] 未配置指标项，严禁激活`);
    }

    // 状态机流转控制：将已激活旧版本转为停用
    for (const v of this.versions) {
      if (v.status === 'ACTIVE') {
        v.status = 'INACTIVE';
      }
    }

    target.status = 'ACTIVE';
  }

  /**
   * 停用指定版本
   */
  public deactivateVersion(versionId: string): void {
    const target = this.versions.find(v => v.id === versionId);
    if (!target) {
      throw new Error(`PLAN_VERSION_NOT_FOUND: 未找到版本 [${versionId}]`);
    }

    if (target.status === 'INACTIVE') {
      return; // 幂等
    }

    if (target.status !== 'ACTIVE') {
      throw new Error(`PLAN_CANNOT_DEACTIVATE: 仅有处于 ACTIVE 状态的版本可执行停用，当前状态为 [${target.status}]`);
    }

    target.status = 'INACTIVE';
  }

  /**
   * 导出契约 DTO 视图
   */
  public toDTO(): InspectionPlanDTO {
    return {
      id: this.id,
      planCode: this.planCode,
      planName: this.planName,
      materialCode: this.materialCode,
      categoryCode: this.categoryCode,
      ...(this.categoryName !== undefined ? { categoryName: this.categoryName } : {}),
      // 分类通用方案口径（014 迁移）：material_code 为空串 + category_code 非空
      isCategoryDefault: (this.materialCode ?? '') === '' && this.categoryCode !== undefined,
      status: this.getStatus(),
      inspectionType: this.inspectionType,
      versions: this.versions.map(v => ({
        ...v,
        items: v.items.map(item => ({ ...item }))
      }))
    };
  }
}
