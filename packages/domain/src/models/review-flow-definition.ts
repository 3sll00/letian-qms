import {
  ReviewFlow as ReviewFlowDTO,
  ReviewStepConfig,
  MRBDisposition,
  MRBFailCategory
} from '@letian/contracts';

/**
 * 可配置 MRB 评审流程聚合 (ReviewFlowDefinition)
 * 纯内存领域聚合，支持针对不同不合格品分类与处置方式定义多级会签节点
 */
export class ReviewFlowDefinition {
  private id: string;
  private flowName: string;
  private applicableCategory: MRBFailCategory;
  private applicableDisposition: MRBDisposition;
  private steps: ReviewStepConfig[];
  private isActive: boolean;

  constructor(params: {
    id: string;
    flowName: string;
    applicableCategory: MRBFailCategory;
    applicableDisposition: MRBDisposition;
    steps: ReviewStepConfig[];
    isActive?: boolean;
  }) {
    if (!params.steps || params.steps.length === 0) {
      throw new Error(`FLOW_EMPTY_STEPS: 评审流程 [${params.flowName}] 必须至少定义一个审核步骤`);
    }

    // 校验节点顺序合法性
    const sortedSteps = [...params.steps].sort((a, b) => a.stepNo - b.stepNo);
    for (let i = 0; i < sortedSteps.length; i++) {
      const step = sortedSteps[i];
      if (step === undefined || step.stepNo !== i + 1) {
        throw new Error(`FLOW_INVALID_STEP_ORDER: 审批节点顺序必须从 1 开始严格连续递增`);
      }
    }

    this.id = params.id;
    this.flowName = params.flowName;
    this.applicableCategory = params.applicableCategory;
    this.applicableDisposition = params.applicableDisposition;
    this.steps = sortedSteps.map(s => ({ ...s }));
    this.isActive = params.isActive ?? true;
  }

  public getId(): string {
    return this.id;
  }

  public getFlowName(): string {
    return this.flowName;
  }

  public getApplicableCategory(): MRBFailCategory {
    return this.applicableCategory;
  }

  public getApplicableDisposition(): MRBDisposition {
    return this.applicableDisposition;
  }

  public getSteps(): readonly ReviewStepConfig[] {
    return this.steps;
  }

  public isFlowActive(): boolean {
    return this.isActive;
  }

  public activate(): void {
    this.isActive = true;
  }

  public deactivate(): void {
    this.isActive = false;
  }

  /**
   * 判断当前流程是否匹配指定的评审分类与拟定处置
   */
  public matches(category: MRBFailCategory, disposition: MRBDisposition): boolean {
    return this.isActive && this.applicableCategory === category && this.applicableDisposition === disposition;
  }

  /**
   * 导出契约 DTO 视图
   */
  public toDTO(): ReviewFlowDTO {
    return {
      id: this.id,
      flowCode: this.id,
      flowName: this.flowName,
      applicableType: this.applicableCategory,
      version: 'v1.0.0',
      isActive: this.isActive,
      nodes: this.steps.map(s => ({
        nodeLevel: s.stepNo,
        nodeName: s.stepName,
        roleCode: s.approverRole,
        requireCustomerSign: false,
      })),
    };
  }
}
