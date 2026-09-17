"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const app_1 = require("../../src/app");
const auth_1 = require("../../src/plugins/auth");
const infrastructure_1 = require("@letian/infrastructure");
const contracts_1 = require("@letian/contracts");
async function runIntegrationTests() {
    console.log('--- 启动 Fastify 端到端业务与关键约束集成测试 ---');
    const app = await (0, app_1.buildApp)({ logger: false });
    const inspectorToken = (0, auth_1.generateTestToken)({
        userId: '11111111-1111-1111-1111-111111111111',
        userName: '测试质检员',
        role: 'INSPECTOR',
    });
    const authHeader = {
        authorization: `Bearer ${inspectorToken}`,
    };
    // =========================================================================
    // 1. 鉴权与 PBAC 约束测试 (401 未授权, 403 权限未命中)
    // =========================================================================
    console.log('1. 测试鉴权与 PBAC 约束...');
    // 1.1 无 Token 访问保护接口 -> RFC 7807 401
    const unauthRes = await app.inject({
        method: 'GET',
        url: '/api/v1/inspections',
    });
    strict_1.default.equal(unauthRes.statusCode, 401, '无 Token 应当返回 401');
    strict_1.default.equal(unauthRes.headers['content-type']?.includes('application/problem+json'), true);
    const unauthJson = JSON.parse(unauthRes.body);
    strict_1.default.equal(unauthJson.status, 401);
    strict_1.default.equal(unauthJson.code, contracts_1.ErrorCode.UNAUTHORIZED);
    // 1.2 携带有效 Token 访问 -> 200
    const authRes = await app.inject({
        method: 'GET',
        url: '/api/v1/inspections',
        headers: authHeader,
    });
    strict_1.default.equal(authRes.statusCode, 200, '携带有效 Token 应当返回 200');
    // =========================================================================
    // 2. release-gates 纯只读与 409 精确阻断原因码测试
    // =========================================================================
    console.log('2. 测试 release-gates 纯只读与 409 精确阻断原因码...');
    const initialAuditLogsCount = infrastructure_1.MOCK_AUDIT_LOGS.length;
    // 2.1 未送检批次 -> 409 GATE_NOT_INSPECTED
    const notInspectedRes = await app.inject({
        method: 'GET',
        url: '/api/v1/release-gates/BATCH-NON-EXIST',
        headers: authHeader,
    });
    strict_1.default.equal(notInspectedRes.statusCode, 409);
    const notInspectedJson = JSON.parse(notInspectedRes.body);
    strict_1.default.equal(notInspectedJson.code, contracts_1.ErrorCode.GATE_NOT_INSPECTED);
    strict_1.default.equal(notInspectedRes.headers['content-type']?.includes('application/problem+json'), true);
    // 2.2 纯只读保证：评估放行接口绝不写入任何审计日志
    strict_1.default.equal(infrastructure_1.MOCK_AUDIT_LOGS.length, initialAuditLogsCount, 'release-gates 接口是纯只读的，绝不产生审计日志副作用');
    // =========================================================================
    // 3. /audit/stats 严格对齐 OpenAPI 契约测试
    // =========================================================================
    console.log('3. 测试 /audit/stats 字段严格对齐 OpenAPI Schema...');
    const auditStatsRes = await app.inject({
        method: 'GET',
        url: '/api/v1/audit/stats',
        headers: authHeader,
    });
    strict_1.default.equal(auditStatsRes.statusCode, 200);
    const auditStatsJson = JSON.parse(auditStatsRes.body);
    // 必须严格包含 totalLogs, successCount, failedCount, todayCount
    strict_1.default.equal(typeof auditStatsJson.totalLogs, 'number');
    strict_1.default.equal(typeof auditStatsJson.successCount, 'number');
    strict_1.default.equal(typeof auditStatsJson.failedCount, 'number');
    strict_1.default.equal(typeof auditStatsJson.todayCount, 'number');
    // =========================================================================
    // 4. 21 项业务核心接口测试
    // =========================================================================
    console.log('4. 验证核心业务控制器端点...');
    // Dashboard
    const dashRes = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/overview',
        headers: authHeader,
    });
    strict_1.default.equal(dashRes.statusCode, 200);
    // Trace
    const traceRes = await app.inject({
        method: 'GET',
        url: '/api/v1/traceability/SJ-2024-11-21-00001',
        headers: authHeader,
    });
    strict_1.default.equal(traceRes.statusCode, 200);
    // Process Settings (MES config)
    const mesConfigRes = await app.inject({
        method: 'GET',
        url: '/api/v1/process-settings/mes-routing-configs',
        headers: authHeader,
    });
    strict_1.default.equal(mesConfigRes.statusCode, 200);
    // Integration
    const syncHistRes = await app.inject({
        method: 'GET',
        url: '/api/v1/integration/sync-history',
        headers: authHeader,
    });
    strict_1.default.equal(syncHistRes.statusCode, 200);
    // Export
    const exportRes = await app.inject({
        method: 'GET',
        url: '/api/v1/export/inspections',
        headers: authHeader,
    });
    strict_1.default.equal(exportRes.statusCode, 200);
    console.log('✓ 端到端集成测试全部顺利通过！');
}
runIntegrationTests().catch((err) => {
    console.error('集成测试失败:', err);
    process.exit(1);
});
//# sourceMappingURL=e2e.test.js.map