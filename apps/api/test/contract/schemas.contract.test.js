"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const contracts_1 = require("@letian/contracts");
console.log('--- 开始 @letian/contracts Zod 契约模式校验测试 ---');
// 1. 测试 AuditStatsResponseSchema 结构
const validAuditStats = {
    totalLogs: 100,
    successCount: 95,
    failedCount: 5,
    todayCount: 20,
};
const parsedAuditStats = contracts_1.AuditStatsResponseSchema.safeParse(validAuditStats);
strict_1.default.equal(parsedAuditStats.success, true, 'AuditStatsResponseSchema 应当成功解析有效数据');
// 2. 测试 ProblemDetailsSchema 结构
const validProblemDetails = {
    type: 'https://letian-qms.com/errors/gate-blocked',
    title: '成品检强制关卡拦截',
    status: 409,
    detail: '批次未送检',
    instance: '/api/v1/release-gates/BATCH-001',
    code: 'GATE_NOT_INSPECTED',
    invalidParams: [
        { name: 'batchNo', reason: '不能为空' },
    ],
};
const parsedProblemDetails = contracts_1.ProblemDetailsSchema.safeParse(validProblemDetails);
strict_1.default.equal(parsedProblemDetails.success, true, 'ProblemDetailsSchema 应当成功解析 RFC 7807 对象');
// 3. 测试 CreateInspectionOrderRequestSchema 结构
const validOrderReq = {
    orderNo: 'IQC-20260901-001',
    inspectionType: 'IQC',
    materialCode: 'CL-001',
    materialName: '圆钢 Φ20',
    batchNo: 'BATCH-20260901-01',
    sampleQty: 50,
    planVersionId: '11111111-1111-1111-1111-111111111111',
};
const parsedOrderReq = contracts_1.CreateInspectionOrderRequestSchema.safeParse(validOrderReq);
strict_1.default.equal(parsedOrderReq.success, true, 'CreateInspectionOrderRequestSchema 应当通过有效入参');
// 4. 测试 SubmitMeasurementsRequestSchema 结构
const validMeasurementsReq = {
    items: [
        {
            itemCode: 'ITEM-01',
            measuredVal: 20.02,
            remark: '合格',
        },
    ],
    isDraft: false,
};
const parsedMeasurementsReq = contracts_1.SubmitMeasurementsRequestSchema.safeParse(validMeasurementsReq);
strict_1.default.equal(parsedMeasurementsReq.success, true, 'SubmitMeasurementsRequestSchema 应当通过有效入参');
// 5. 测试 CreateMRBRecordRequestSchema 结构
const validMRBReq = {
    title: '螺栓表面划痕缺陷',
    category: 'DIMENSION_DEFECT',
    batchNo: 'BATCH-20260901-01',
    materialCode: 'CP-001',
    materialName: '六角螺栓',
    defectDescription: '表面有明显划伤',
    defectQuantity: 10,
};
const parsedMRBReq = contracts_1.CreateMRBRecordRequestSchema.safeParse(validMRBReq);
strict_1.default.equal(parsedMRBReq.success, true, 'CreateMRBRecordRequestSchema 应当通过有效入参');
// 6. 测试 SubmitMRBReviewRequestSchema 结构
const validMRBReviewReq = {
    decision: 'CONCESSION',
    comment: '不影响装配强度，让步接收',
};
const parsedMRBReviewReq = contracts_1.SubmitMRBReviewRequestSchema.safeParse(validMRBReviewReq);
strict_1.default.equal(parsedMRBReviewReq.success, true, 'SubmitMRBReviewRequestSchema 应当通过有效入参');
// 7. 测试 TraceDAGResponseSchema 结构
const validDAG = {
    rootBatchNo: 'BATCH-001',
    materialCode: 'CP-001',
    materialName: '成品螺栓',
    direction: 'BOTH',
    nodes: [
        {
            batchNo: 'BATCH-001',
            nodeType: 'INSPECTION',
            materialCode: 'CP-001',
            materialName: '成品螺栓',
            operatorName: '质检员A',
            timestamp: '2026-09-01T08:00:00.000Z',
            status: 'PASSED',
        },
    ],
    edges: [],
};
const parsedDAG = contracts_1.TraceDAGResponseSchema.safeParse(validDAG);
strict_1.default.equal(parsedDAG.success, true, 'TraceDAGResponseSchema 应当通过有效结构');
console.log('✓ @letian/contracts 契约 Zod Schema 验证全部通过！');
//# sourceMappingURL=schemas.contract.test.js.map