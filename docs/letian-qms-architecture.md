# 乐天质量管理系统 (Letian QMS) - 系统技术架构设计与规范说明书

> **版本**：v2.5.0 (生产基准级)  
> **设计原则**：严格遵循 DDD 领域驱动设计、六边形分层架构（Ports & Adapters）、Contract-First（契约先行）、零 IO 纯领域模型、PostgreSQL 14+ 事务并发防重与 Append-Only 审计追踪。

---

## 1. Monorepo 工程分层与边界结构

```text
letian-qms/
├── packages/
│   ├── contracts/            # 【单一真理源】OpenAPI 3.1、Zod Schemas、共享 DTO、RFC 7807 统一错误码、Auth Subject
│   ├── domain/               # 【纯业务内核】聚合根（方案/检验单/MRB/追溯）、状态机引擎、公差判标、三维纯内存 PBAC、六边形端口接口
│   ├── application/          # 【用例总指挥】用例编排、方案与流程快照深拷贝、事务边界 (Unit of Work)、放行排他锁、装配 PBAC 上下文
│   └── infrastructure/       # 【外部适配器】Kysely PG14+ 迁移、CamelCasePlugin 映射、三维 PBAC SQL 翻译、Outbox、CTE 追溯仓储、ERP/MES 适配
├── apps/
│   ├── api/                  # 【HTTP 协议适配器】Fastify 引擎、Zod 运行时校验插件、RFC 7807 错误拦截、控制器（严禁写 SQL 与事务）
│   └── web/                  # 【React 工作台】React + Vite + TailwindCSS、ECharts、MSW 契约先行 Mock（强制 Zod.parse 校验）、高保真 21 页还原
└── docs/                     # 乐天 QMS 专属工程文档与原子任务库
```

---

## 2. 核心领域聚合与状态机引擎 (Domain)

### 2.1 质检方案聚合根 (InspectionPlan) 与版本快照机制
- **聚合根组成**：
  - `InspectionPlan`：主元数据（方案编码、物料编码/分类绑定、质检类型：IQC/IPQC/OQC/委外）；
  - `InspectionPlanVersion`：版本实体（版本号 v1.0.0、状态：`DRAFT` / `ACTIVE` / `INACTIVE`、生效时间、AQL 抽样规则）；
  - `InspectionPlanItem`：指标明细（名称、测量工具、判定类型、基准值、公差上限、公差下限、单位）。
- **版本状态转移矩阵**：
  - `DRAFT -> ACTIVE`：必须通过完整性校验（至少包含1个有效指标项、AQL 规则完整）；同一物料及检验类型下，激活新版本时自动将旧版本转为 `INACTIVE`；
  - `ACTIVE -> INACTIVE`：手动停用；
  - `INACTIVE -> ACTIVE`：重新启用；
  - **防篡改约束**：处于 `ACTIVE` 和 `INACTIVE` 的版本**物理只读**，严禁就地修改；修改需求必须克隆生成新的 `DRAFT` 版本。

### 2.2 检验单状态机与快照绑定 (InspectionOrder)
- **方案快照深拷贝 (Snapshot)**：
  - 检验单在实例化（`PENDING`）时，通过 Application 层拉取当前物料生效的 `ACTIVE` 方案版本，生成深拷贝的 `InspectionOrderSnapshot`（包含当时的指标公差与抽样规则）。
  - **法律效力与审计一致性**：历史单据判定永远依据当时绑定的快照，杜绝由于方案后期修改导致的历史判定失真。
- **状态转移图与回边控制**：
```text
[PENDING] 待检
    │
    ▼ (质检员开始录入)
[INSPECTING] 检验中 ──(暂存草稿)──► [DRAFT] 草稿
    │                                  │
    │ ◄───────(重新打开编辑)───────────┘
    ▼ (实测值全部录入并判定)
┌───┴───────────────────────────────────────┐
│                                           │
▼ (全部指标项合格)                            ▼ (存在超标项)
[PASSED] 合格                                [FAILED] 不合格
│                                           │
│ (成品检/出货放行校验通过)                    ▼ (自动触发 MRB 评审流程)
▼                                          [IN_MRB_REVIEW] 评审中
[COMPLETED] 已结单                            │
                                            ├──► [RETURN] 退货 ──────────┐
                                            ├──► [SCRAP] 报废 ───────────┼─► [COMPLETED] 已结单
                                            ├──► [CONCESSION] 让步接收 ──┘   (质量档案归档)
                                            │    (需技术与客户联合签核)
                                            │
                                            └──► [REWORK] 返工/返修
                                                 │
                                                 ▼ (状态机关键回边)
                                            [RE_INSPECTING] 触发复检工单
                                                 │
                                                 ▼ (系统自动流向)
                                            [PENDING] (生成第 N+1 轮次检验单，关联原工单)
```

### 2.3 可配置评审流程引擎模型 (ReviewFlowDefinition) 与状态映射
为对齐确认文档第 14 页与设计稿《WPS图片(14).png》，不合格品评审采用轻量可配置工作流模型：
- **流程定义与快照绑定**：
  - `ReviewFlowDefinition`：流程编号（FL-001）、流程名称、适用类型（`INCOMING_FAIL`、`PROCESS_FAIL`、`SHIPMENT_FAIL`、`SUBCONTRACT_FAIL`）、状态（`ACTIVE`/`INACTIVE`）、版本号；
  - `ReviewFlowNode`：节点层级（1级、2级、3级）、节点名称（如“技术部评审”、“质量部裁决”）、审批角色编码、通过条件（全员会签/一人通过）、是否必须附带客户特采签核凭证；
  - **快照绑定原则**：MRB 实例在创建时，深拷贝绑定触发时刻生效的流程定义版本（`flow_snapshot`），避免流程配置在审批中途被修改导致审批断层。
- **流程实例 (ReviewFlowInstance) 与检验单状态 (InspectionOrder) 的 N:1 映射机制**：
  - 检验单处于 `IN_MRB_REVIEW` 期间，内部的 `ReviewFlowInstance` 历经节点级流转（`Node 1: PENDING -> APPROVED`，`Node 2: PENDING -> ...`）；
  - **驳回分支决策**：若评审流程中任意节点裁定**驳回修改**，检验单状态退回为 `FAILED`，解除评审锁定并允许质检员补充复测证据重新发起；
  - **最终决案裁决**：当所有预设节点均会签批准并出具处置方式（退货/报废/让步接收）后，检验单流转至 `COMPLETED`；若决策为返工，则流向 `RE_INSPECTING`。

---

## 3. 数据库核心物理设计 (Infrastructure)

### 3.1 命名规范与双向映射
- PostgreSQL 数据库列名与表名统一遵循 `snake_case`；
- API 与前端 TypeScript 契约统一遵循 `camelCase`；
- 数据层通过 Kysely `CamelCasePlugin` 进行全局透明双向转换；
- **JSONB 内部键名强制约定**：所有写入 JSONB 列的内部属性名统一强制使用 `camelCase`。

### 3.2 检验工单与指标实测明细表
```sql
-- 1. 检验工单主表
CREATE TABLE inspection_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_no VARCHAR(64) NOT NULL UNIQUE,
    inspection_type VARCHAR(32) NOT NULL, -- IQC, IPQC_CT, IPQC_RL, IPQC_FN, OQC_SF, OQC_SH
    material_code VARCHAR(64) NOT NULL,
    batch_no VARCHAR(64) NOT NULL,
    supplier_code VARCHAR(64),
    customer_code VARCHAR(64),
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- PENDING, INSPECTING, DRAFT, PASSED, FAILED, IN_MRB_REVIEW, RE_INSPECTING, COMPLETED
    overall_decision VARCHAR(32), -- PASSED, FAILED, CONCESSION (仅在 MRB 流程批准特采让步接收后由系统更新回填)
    inspector_id UUID,
    inspection_notes TEXT,
    plan_version_id UUID NOT NULL,
    plan_snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. 检验工单指标实测明细表 (复合唯一约束防止快照展开重复)
CREATE TABLE inspection_order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES inspection_orders(id) ON DELETE RESTRICT,
    item_code VARCHAR(64) NOT NULL,
    item_name VARCHAR(128) NOT NULL,
    metric_category VARCHAR(32) NOT NULL, -- DIMENSION, APPEARANCE, HARDNESS, COATING_THICKNESS, TEXT_INTERVAL (业务维度分类)
    data_type VARCHAR(16) NOT NULL, -- NUMERIC, TEXT, QUALITATIVE (算法判定维度：决定公差带比较/区间匹配/正反判定)
    target_val NUMERIC(12, 4),
    upper_tolerance NUMERIC(12, 4),
    lower_tolerance NUMERIC(12, 4),
    unit VARCHAR(16),
    measured_val NUMERIC(12, 4),
    measured_text VARCHAR(255),
    decision VARCHAR(16) NOT NULL DEFAULT 'PENDING', -- PENDING / PASSED / FAILED
    defect_reason VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_order_item UNIQUE (order_id, item_code)
);
CREATE INDEX idx_order_items_metric ON inspection_order_items(item_code, decision);
CREATE INDEX idx_order_items_category ON inspection_order_items(metric_category, data_type);
```

### 3.3 审计日志流水线设计 (标准实体表 + 不可篡改触发器)
*针对 PG 14 兼容性优化：放弃容易引起下推异常的分区父表触发器，采用标准的单表设计结合行级防篡改触发器。按年/月归档时采用后台归档表流转。*
```sql
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id VARCHAR(64) NOT NULL,
    user_id UUID NOT NULL,
    user_name VARCHAR(64) NOT NULL,
    action VARCHAR(32) NOT NULL, -- CREATE, UPDATE, STATUS_CHANGE, DISPOSE, GATE_BLOCKED, AUTH_FAILED, VALIDATION_REJECTED, SYNC_TRIGGER
    resource_type VARCHAR(64) NOT NULL,
    resource_id VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'SUCCESS', -- SUCCESS, FAILED, REJECTED
    diff_patch JSONB, -- 变更快照补丁：UPDATE 操作存储变更前后字段差异；CREATE 操作存储初始完整关键字段快照；STATUS_CHANGE 记录状态转移前后值
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_logs_filter ON audit_logs(action, status, created_at);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_logs_user_composite ON audit_logs(user_id, action, created_at DESC);

-- 数据库行级防篡改触发器 (彻底免疫 UPDATE 和 DELETE)
CREATE OR REPLACE FUNCTION forbid_audit_tampering() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'QMS_AUDIT_LOG_IMMUTABLE: 审计日志严禁任何物理修改或物理删除操作';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION forbid_audit_tampering();
```

### 3.4 权限校验日志表 (authorization_logs)
```sql
CREATE TABLE authorization_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id VARCHAR(64) NOT NULL,
    user_id UUID NOT NULL,
    user_role VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL, -- QUERY_INSPECTION, EXPORT_TRACE, BATCH_LOOKUP
    requested_resource VARCHAR(128) NOT NULL,
    filter_rules_applied JSONB NOT NULL, -- 记录生效的物料分类、物料编码、供应商白名单
    matched_count INT NOT NULL DEFAULT 0,
    is_intercepted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_auth_logs_created ON authorization_logs(created_at);
-- 保留策略：由系统后台定时任务执行清理（DELETE FROM authorization_logs WHERE created_at < NOW() - INTERVAL '180 days'），确保满足 PRD 至少保留 180 天合规要求的同时控制表膨胀。
```

### 3.5 ERP/MES 集成管理配置与同步日志表
```sql
-- 1. 系统通用集成配置表 (ERP / MES 共享)
-- 架构约束与适用场景：
-- 一期设计基于标准单工厂业务架构，即“单一主 ERP 账套 + 单一车间 MES 服务”。若后期演进为多工厂独立 MES 或多 ERP 账套，则将 UNIQUE (system_type) 约束升级为 UNIQUE (system_type, instance_code)。
-- 字段分化说明：subscribed_workshops 与 subscribed_processes 仅用于 MES 车间工序拉取，ERP 同步时保持空数组 []；service_url 与 auth_token 为通用连接认证凭据。
CREATE TABLE integration_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    system_type VARCHAR(32) NOT NULL DEFAULT 'MES', -- MES / ERP
    service_url VARCHAR(255) NOT NULL,
    auth_token VARCHAR(255),
    subscribed_workshops JSONB NOT NULL DEFAULT '[]', -- 仅 MES 适用：订阅的车间编码数组
    subscribed_processes JSONB NOT NULL DEFAULT '[]', -- 仅 MES 适用：订阅的工序数组（下料、滚丝等）
    cron_schedule VARCHAR(64) NOT NULL DEFAULT '0 */5 * * * *', -- 默认每5分钟轮询（与 PRD 对齐）
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_integration_system UNIQUE (system_type)
);

-- 2. 集成批次流水日志表 (去唯一约束，支持多轮拉取/重试流水追加)
CREATE TABLE integration_sync_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_no VARCHAR(64) NOT NULL, -- 批次号（允许同一批次在多次轮询或重试时产生多条流水）
    system_type VARCHAR(32) NOT NULL, -- MES / ERP
    sync_direction VARCHAR(16) NOT NULL, -- PULL / PUSH
    status VARCHAR(16) NOT NULL, -- SUCCESS / PARTIAL_FAIL / FAILED
    records_count INT NOT NULL DEFAULT 0,
    error_details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sync_logs_batch ON integration_sync_logs(batch_no, created_at DESC);
CREATE INDEX idx_sync_logs_system ON integration_sync_logs(system_type, status, created_at DESC);
```

### 3.6 事务性外发信箱与批次追溯拓扑表 (Outbox & DAG Edges)
```sql
-- 1. 事务性发件箱 (Transactional Outbox 表，保证事件高可靠与消费端幂等)
-- 重试与死信策略：默认最大重试次数为 5 次（指数退避 1s, 2s, 4s, 8s, 16s）。超过 5 次投递失败后，状态置为 'DEAD_LETTER'（死信），触发告警并人工介入。
CREATE TABLE outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL UNIQUE,  -- UUIDv7，全局唯一标识，消费端必须按 event_id 做消费幂等去重
    event_type VARCHAR(64) NOT NULL,  -- BATCH_LOCKED, MRB_TRIGGERED, INSPECTION_COMPLETED
    aggregate_type VARCHAR(32) NOT NULL DEFAULT 'BATCH', -- BATCH（物料批次）或 ORDER（检验工单）
    aggregate_id VARCHAR(64) NOT NULL,  -- 聚合根物理业务主键（如 batch_no 或 order_no，与 aggregate_type 配对使用）
    payload JSONB NOT NULL, -- 事件体（包含批次号、锁定原因、触发时间等，统一 camelCase）
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING',  -- PENDING / SENT / FAILED / DEAD_LETTER
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 5,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_outbox_pending ON outbox_events(status, created_at);

-- 2. 批次追溯 DAG 边关系表
-- 关系类型语义：由 QMS-003 domain 领域模型定义，严格对应制造全生命周期的 5 类流转关系
CREATE TABLE batch_trace_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_batch_no VARCHAR(64) NOT NULL,
    target_batch_no VARCHAR(64) NOT NULL,
    relation_type VARCHAR(32) NOT NULL,  -- RAW_TO_PROCESS(原材料到工序), PROCESS_TO_PROCESS(工序到工序), PROCESS_TO_OUTSOURCE(工序到委外), OUTSOURCE_TO_FINISH(委外到成品), FINISH_TO_SHIPMENT(成品到出货)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_trace_edge UNIQUE (source_batch_no, target_batch_no)
);
CREATE INDEX idx_trace_edges_source ON batch_trace_edges(source_batch_no);
CREATE INDEX idx_trace_edges_target ON batch_trace_edges(target_batch_no);
```

### 3.7 幂等控制防重表 (Idempotency Keys)
```sql
CREATE TABLE idempotency_keys (
    user_id UUID NOT NULL,
    endpoint VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL, -- 规范命名为 idempotency_key，规避 SQL 保留字 key
    payload_hash CHAR(64) NOT NULL, -- SHA-256 哈希比对
    response_code INT NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, endpoint, idempotency_key)
);
```

---

## 4. 六边形集成端口与双向同步中枢 (Integration)

### 4.1 ErpPort 端口与 6 类基础档案映射
QMS 必须完整同步管家婆 ERP 的 6 类基础档案，建立统一外部标识映射：
1. **供应商档案 (Suppliers)**：编码、名称、联系人、供货类别（支撑 IQC 检验与供应商合格率看板）；
2. **客户档案 (Customers)**：编码、名称、等级（支撑 OQC 出货检验关联与特采签核）；
3. **存货档案 (Materials)**：编码、名称、规格型号、材质、图号、主计量单位、存货分类编码；
4. **存货分类 (Categories)**：树形编码（如 01.02.01）、分类名称；
5. **车间档案 (Workshops)**：车间编码、车间名称（支撑 IPQC 下料、滚丝工序归属与机台分组）；
6. **职员档案 (Employees)**：工号、姓名、所属部门、职务角色（为 MRB 流程审批人、检验员提供统一主数据源）。

### 4.2 MesPort 端口与双向集成中枢
#### 1. QMS -> MES 强制关卡阻断 (MANDATORY_GATE)
- **同步只读放行校验 (现场报工前置拦截)**：
  - 接口：`GET /api/v1/release-gates/{batchNo}`
  - **纯只读与幂等性保证**：此接口绝不产生审计写放大，绝不改变工单与批次状态；
  - 阻断响应：返回 `409 Conflict`，带标准化错误码：
    - `GATE_NOT_INSPECTED`：未发起成品检验，阻断机台；
    - `GATE_INSPECTING`：成品检验尚在进行中；
    - `GATE_FAILED`：成品检判定不合格，机台物理闭锁；
    - `GATE_UNDER_MRB`：批次处于 MRB 评审中，冻结流转。
- **异步批次锁定推送 (Transactional Outbox)**：
  - 当检验判定不合格或进入 MRB 时，写入 `outbox_events` 表，生成包含全局唯一 `eventId` (UUIDv7) 的 `BATCH_LOCKED` 事件；
  - **MES 消费端幂等约束**：MES 接收端必须建立基于 `eventId` 的消费去重表，防止网络重试造成重复告警。

#### 2. MES -> QMS 生产数据拉取与集成管理配置
为落实确认文档第 21 项，系统提供可视化的 MES 集成管理中心：
- 依据 `integration_configs` 表配置，定时增量拉取 MES 车间在制品工单与批次；
- 记录 `integration_sync_logs`，支持前端一键测试联通性与手动立即同步。

---

## 5. 批次追溯 DAG 与 统一导出规范

### 5.1 批次追溯递归 CTE (PostgreSQL 14+ 方案 A)
```sql
WITH RECURSIVE trace_cte AS (
  SELECT source_batch_no, target_batch_no, 1 as depth
  FROM batch_trace_edges
  WHERE source_batch_no = $1
  UNION ALL
  SELECT e.source_batch_no, e.target_batch_no, t.depth + 1
  FROM batch_trace_edges e
  JOIN trace_cte t ON e.source_batch_no = t.target_batch_no
)
CYCLE target_batch_no SET is_cycle USING path
SELECT source_batch_no, target_batch_no, depth, is_cycle, path FROM trace_cte;
```
- **Application 层业务策略**：当 `is_cycle = true` 时，该节点保留在拓扑图中，标记 `hasCycleWarning: true`，前端呈现为“批次回流环路标记”，既杜绝无穷死循环展开，又防止截断追溯链最后一跳。

### 5.2 统一导出服务规范 (Exporting)
为满足确认文档第 11、12 页及设计图规范，系统设立统一数据导出服务：
1. **检验进度明细导出**：
   - **选型与实现**：基于轻量流式库 `exceljs` 导出 Excel (.xlsx)，支持多维筛选条件下的流式 CSV 生成；
2. **批次追溯全景报告导出**：
   - **选型与实现**：基于服务端 `@react-pdf/renderer`（工业首选，基于 React 组件化构建高保真矢量 PDF，工程必须显式通过 `Font.register({ family: 'SourceHanSansCN', src: '...' })` 注册内置思源黑体中文字体文件，杜绝乱码与 Headless 浏览器庞大开销），输出符合客户验厂标准的 PDF 追溯报告。
