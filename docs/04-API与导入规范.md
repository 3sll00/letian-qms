# 乐天质量管理系统 (Letian QMS) - API 契约体系与接口规范说明 (API & Contract Specs)

> **版本**：v2.6.0  
> **更新时间**：2026-09-19  
> **规范基线**：OpenAPI 3.1 / RFC 7807 Problem Details / Zod 运行时强校验  
> **文档权威级别**：★ 最高基准源

---

## 1. 契约优先设计原则 (Contract-First Principles)

系统严格贯彻**契约驱动开发**：
1. 所有接口的入参（Request Query / Body / Params）与出参（Response DTO）均由 `packages/contracts/src/schemas` 中的 Zod Schema 单点定义。
2. 严禁在控制器（Controllers）中直接解析未校验的 `req.body`，必须通过验证中间件或 Schema 解析器。
3. 接口类型自动导出至 `packages/contracts/src/dtos`，供后端 API 与前端 Web SPA 双向共享，实现编译期类型绝对一致。

---

## 2. 全局统一错误规范 (RFC 7807 Problem Details)

当接口发生业务错误或验证失败时，统一返回 `Content-Type: application/problem+json` 格式：

```json
{
  "type": "https://errors.letian.com/ERR_RELEASE_GATE_BLOCKED",
  "title": "Release Gate Blocked",
  "status": 409,
  "detail": "工单 WO-20260903-888 在工序 P02 存在未处置的不合格质量记录，生产阻断。",
  "instance": "/api/v1/release-gates/check?work_order_no=WO-20260903-888&process_code=P02",
  "code": "ERR_RELEASE_GATE_BLOCKED",
  "timestamp": "2026-09-19T09:00:00.000Z",
  "invalidParams": []
}
```

### 2.1 核心业务错误码字典 (Error Code Catalog)

| 错误码 (Code) | HTTP 状态 | 触发场景说明 | 客户端应对建议 |
|:---|:---:|:---|:---|
| `ERR_RELEASE_GATE_BLOCKED` | 409 | 尝试进行下游报工或领料，但前道工序未检或存在不合格未闭环 | 弹出阻断报警，引导车间质检员完成质检或 MRB 审批 |
| `ERR_OPTIMISTIC_LOCK_CONFLICT` | 409 | 提交保存时，单据 `version` 与数据库不一致，已被他人修改 | 提示用户刷新单据最新数据后重新编辑提交 |
| `ERR_SNAPSHOT_TAMPER_DETECTED` | 403 | 非法尝试在检验单生成后修改其固化的 `plan_snapshot` | 严正拒绝，该行为视为安全违规 |
| `ERR_PBAC_ACCESS_DENIED` | 403 | 当前用户无权查看或修改该存货分类/供应商管辖的数据 | 提示数据权限越权，联系管理员配置 PBAC 策略 |
| `ERR_AQL_SAMPLE_INVALID` | 422 | 提交的总到货批量不在国标 AQL 抽样表覆盖范围（如批量 <= 1） | 检查到货数量输入是否合法 |
| `ERR_GENEALOGY_CYCLE_DETECTED` | 422 | 炉批号追溯链路中出现自引用或循环拓扑图 | 检查批次上下游关联关系输入，消除环路 |
| `ERR_MRB_SIGNOFF_INCOMPLETE` | 422 | 尝试将 MRB 单终审通过，但尚未集齐质量、技术、生产的必需签字 | 提示补全会签部门意见 |

---

## 3. RESTful 核心接口全景清单

### 3.1 身份认证与权限 (`/api/v1/auth`)
- `POST /api/v1/auth/login`: 用户登录，换取 JWT Token 与用户基础资料。
- `GET /api/v1/auth/me`: 获取当前登录用户信息及 PBAC 数据权限上下文（管辖存货大类前缀、供应商白名单等）。

### 3.2 质量全景看板 (`/api/v1/dashboard`)
- `GET /api/v1/dashboard/metrics`: 获取今日 IQC / IPQC / 委外 / OQC 统计、待审核池积压数、炉批号异常数。
- `GET /api/v1/dashboard/pareto`: 获取指定时间范围内的缺陷柏拉图（Pareto）频次与占比。
- `GET /api/v1/dashboard/trends`: 获取过去 7 天 / 30 天合格率波动趋势图。

### 3.3 质量检验单生命周期 (`/api/v1/inspections`)
- `GET /api/v1/inspections`: 分页查询检验单列表（支持高级 DSL 组合过滤与 PBAC 隔离）。
  - 出货检验台账等页面的派生列「检验状态」（待检验/检验中/已合格/不合格）对应查询参数 `inspectionState`
    （`PENDING` / `INSPECTING` / `PASSED` / `FAILED`），由后端按 `status` + `judgment` 统一翻译，
    保证**筛选结果与台账列显示的字样一致**；按契约枚举精确查询仍可用 `status` / `statuses`（见文档 16 §5.1）。
- `POST /api/v1/inspections`: 创建新检验单（自动深拷贝生成 `plan_snapshot`）。
- `GET /api/v1/inspections/:id`: 获取检验单完整详情（包含检验特征项、实测矩阵、挂载委外元数据）。
- `POST /api/v1/inspections/:id/submit-measurements` / `POST /api/v1/inspections/:id/status`: 录入实测值与终判的**真实写路径**。
  - IQC / OQC / 委外三个录入表单的「提交」都走这两步；回执直接显示服务端返回的检验单号与判定，前端不 alert 假成功（口径见 `docs/35` §4）。
- `POST /api/v1/inspections/:id/approve`: 质量负责人签核（写入 `approver_id` / `approver_name` / `approved_at`，并在同一事务写一条 `diff_patch.event='QUALITY_APPROVAL'` 的审计留痕）。
  - 签核人 = 当前登录用户：请求体**不接受**「自称的签核人」；角色门禁 `QA_MANAGER` / `ADMIN` / `SYSTEM`，其余角色 403；重复签核幂等覆盖（换人 / 换时间），历史动作留在审计日志里（口径见 `docs/35` §5）。
- `PATCH /api/v1/inspections/:id/measurements`: 批量录入或暂存抽样实测数值。
- `POST /api/v1/inspections/:id/evaluate`: 触发 AQL 与公差自动裁决，更新单据状态为 `PASS` 或 `FAIL`。

### 3.4 生产强制放行关卡 (`/api/v1/release-gates`)
- `GET /api/v1/release-gates/check`:
  - **请求参数**：`work_order_no` (必填), `process_code` (必填), `material_code` (可选)。
  - **响应结果**：
    - 放行：`{ "released": true, "status": "RELEASED", "inspection_no": "IPQC-..." }` (HTTP 200)
    - 阻断：抛出 RFC 7807 `ERR_RELEASE_GATE_BLOCKED` (HTTP 409 Conflict)。

### 3.5 不合格品处置与 MRB 评审 (`/api/v1/mrb`)
- `GET /api/v1/mrb/pending-pool`: 查询待审核池列表（`sourceStage`/`stage`/`inspectionType`/`materialCode`/`batchNo`/`status` + 分页）。
  - `status` **只接受契约三态** `PENDING_INITIATE` / `INITIATED` / `DISMISSED`；004 建表时的历史词表
    （`PENDING_REVIEW` / `REVIEWING` / `RESOLVED`）已由迁移 015 归一，传入旧值直接 `400`，**不做静默映射**；
  - **行级权限随查询下推 SQL**：三维 PBAC 条件（物料分类 / 物料编码 / 供应商）与过滤条件、分页一并进入 SQL，
    因此 `total` 与当页数据同口径。物料分类维度经 `materials.category_code` 子查询换算（池表不需要冗余分类列）；
    池表无供应商编码列，**限定供应商的规则按 fail-closed 处理**（不匹配任何行，不会放宽为"分类命中即可见"）；
  - 无生效规则的用户同理 fail-closed（返回 0 条），与 `GET /mrb/records` 口径一致。
- `POST /api/v1/mrb/pending-pool/initiate`: 基于待审条目逐条发起独立 MRB 评审单（`pendingDefectId`/`flowId`/`urgencyLevel`/`reviewNotes`）。
- `GET /api/v1/mrb/records`: 查询 MRB 处置列表 + 5 项 KPI 统计（服务端按 PBAC 过滤后计算）。
  - 查询参数：`categoryTab`、`status`、`mrbNo`（模糊）、`sourceOrderNo`（模糊）、`disposition`、`dateFrom`/`dateTo`、`page`、`pageSize`；
  - 响应：`items`/`list`/`total` + `pendingCount`/`underReviewCount`/`totalReviewedCount`/`disposedCount`/`monthlyReviewRate`；
  - 单据字段含联表派生 `inspectorName`（源检验单检验人）。
- `POST /api/v1/mrb/records/:id/reviews`: 节点会签提交（契约对齐路径，`action`/`comment`/`signatureUrl`）。
- `POST /api/v1/mrb/records/:id/sign`: 节点会签提交（旧标准路径，等价于上一条）。
- `POST /api/v1/mrb/records/:id/disposition`: 提交最终处置结论（`RETURN_TO_VENDOR`/`REWORK`/`CONCESSION`/`SCRAP`，兼容别名 `RETURN`）。
  - 请求体：`disposition` 必填 + `dispositionReason` / `dispositionNotes` / `reason` **至少一项**（前端页面字段名为 `dispositionReason`，服务端 `z.refine` 强校验，缺失返回 400）；
    可选 `approvers[]`（本次共同签署人，省略时沿用会签历史，最终裁决人记入 `disposed_by`）；
  - **特采硬规则**：`disposition = CONCESSION` 必须携带 `concessionAttachmentUrl`（客户书面签核件），缺失返回 `400 CONCESSION_NOT_SIGNED_OFF`，服务端**不做任何默认兜底**；
  - 响应为**裸 `MRBRecord`**（非 `{ mrbReview }` 包装对象，契约名 `DisposeMRBResponse`），并写入 `disposed_at` / `disposed_by`；
    `disposition = REWORK` 时**额外追加** `reinspectionOrderId` / `reinspectionOrderNo`（口径恒为 `{来源检验单号}-R{轮次}`），
    两个字段均为可选追加，既有按 `MRBRecord` 解析的调用方完全向后兼容（见 `docs/21` §11）。
- `GET /api/v1/review-flows`: 评审流程定义清单（发起评审抽屉内选用，同时是「评审流程设置」子页的数据源），另有 `POST /api/v1/review-flows` 新建/整体保存、`POST /api/v1/review-flows/:id/toggle-active` 启停。
  - 响应 `{ total, items[] }`，每条含 `id` / `flowCode` / `flowName` / `description` / `applicableType` / `version` / `isActive` / `nodes[]`；
  - `nodes[]` 字段口径：`nodeLevel`（审批层级序号，**唯一排序键**）、`nodeName`、`roleCode`、`roleName`（显示名，缺省读侧回退 `roleCode`）、`isRequired`（默认 `true`）、`allowConcession`（默认 `false`，仅终审层级为 `true`）、`requireCustomerSign`；
  - `POST /api/v1/review-flows` 请求体即 `ReviewFlow`（整体替换语义，按 `(flow_code, version)` upsert 整份 `nodes`）；`description` 落 `review_flows.description`，缺省默认值为空，不产生破坏性变更；
  - **启停路径只有 `POST /api/v1/review-flows/:id/toggle-active`**（无 `/toggle` 别名），返回 `{ success, id, isActive }` 并真实写回 `review_flows.is_active`；请求须带 JSON 体（`{}` 即可），Fastify 对 `content-type: application/json` 的空体直接拒绝。
  - 「评审流程设置」子页此前三处断链（流程说明恒空 / 节点四列恒空 / 启停假成功）的根因与闭环见 `docs/21-MRB不合格品处置数据字段与接口打通设计.md` §10。
- **待审核池条目字段**（`PendingDefectItem`）：`id`、`inspectionOrderId`、`orderNo`、`inspectionType`、`batchNo`、`materialCode`、`materialName`、`defectQty`、
  `totalQty`（**受检数量，不良率分母口径 = 检验单抽样数量**）、`defectRate`、`defectDescription`、`defectItemCode`、`supplierName`、`customerName`、
  `inspectorId`、`inspectorName`、`status`（三态）、`mrbId`、`createdAt`。
  物理列与读写链路见 `docs/03-数据模型.md` §2.3。
- **发起评审落库口径**（`POST /mrb/pending-pool/initiate`）：`flowId` → `mrb_reviews.review_flow_id`（省略时按 `source_type` 匹配启用流程）、
  `urgencyLevel` → `mrb_reviews.urgency_level`（默认 `NORMAL`）、`reviewNotes` → `mrb_reviews.review_notes`（不再拼进不合格描述）、
  池条目回写 `status = INITIATED` + `mrb_review_id` + `review_started_at/by`，并由 MRB 侧写 `pending_defect_id` 形成双向链接。
- **MRB 单据新增字段**（`GET /mrb/records` 回吐）：`reviewFlowId`、`urgencyLevel`、`reviewNotes`、`disposedAt`、`disposedBy`、`pendingDefectId`。
- 页面口径与字段映射见 `docs/19-MRB不合格品处置页整合设计.md`；字段链路核查、断链清单与验收口径见 `docs/21-MRB不合格品处置数据字段与接口打通设计.md`。

### 3.6 批次/炉批号双向追溯 (`/api/v1/traceability`)

> **口径**：追溯主键是**批次号 / 炉批号**（`batch_trace_nodes.batch_no` 唯一）；订单号、物料编码、成品名称只是**检索条件**。
> 因此接口分成「先检索、再开图」两步，页面点选某一行后才以该批次为根穿透。
> 页面分区口径、字段链路对照与验收标准见 `docs/24-质量追溯看板界面评审与改造建议.md`。

- `GET /api/v1/traceability/batches` —— **批次检索**：按批次号/炉批号、订单号、物料编码、成品名命中**批次清单**。
  - **请求参数**：`batchNo`（批次号**或**炉批号，模糊）、`orderNo`（同时匹配 `sales_order_po_no` / `sales_order_no` / `work_order_no` / `order_no`）、
    `materialCode`（模糊）、`productName`（成品/物料名称，模糊）、`page`（默认 1）、`pageSize`（默认 20，上限 100）。
  - **响应结果**：`TraceBatchSearchResponse` = `{ total, page, pageSize, items }`，每行 `TraceBatchSummary`。
  - **数据来源是两路并集**：`batch_trace_nodes`（已建血缘的批次）与 `inspection_orders`（有检验台账的批次）；
    每行用 `sources: ['TRACE_NODE' | 'INSPECTION_ORDER']` 标明命中来源，界面据此区分「已建血缘」与「仅检验台账」。
  - **过滤一律下沉 SQL**（`ILIKE` + 服务端分页），前端不得做二次过滤。
  - PBAC 按**清单语义**处理：越权批次被**剔除**而不是整个请求 403。
- `GET /api/v1/traceability/orders/:orderNo` —— **本订单检验环节**（订单维度台账视图，**不是**血缘链路）。
  - **响应结果**：`TraceOrderChainResponse` = 客户/客户订单号/销售出库单号/ERP 状态/成品编码与名称/出货数量/涉及批次 + `stages[]`。
  - `stages[]` 每行 = `seq`（**按工艺序位**，非时间序）+ 环节名 + 检验单号 + 受检批次 + 来源单据 + 状态 + 检验人 + 时间 + 耗时（无终检时间则缺省，界面显示 `—`）。
  - `matchedBy` 回显本次命中字段：`SALES_ORDER_PO_NO` / `SALES_ORDER_NO` / `ORDER_NO` / `WORK_ORDER_NO`。
  - 未找到检验单返回 404 `TRACE_ORDER_NOT_FOUND`；订单维度是**详情视图**，PBAC 未授权直接 403（fail-closed）。
  - **术语约束**：该分区标题只能是「本订单检验环节」，同一订单下的多条环节彼此**并列**，不得表述为「完整质量追溯链路」。
- `GET /api/v1/traceability/graph/:batchNo` —— **批次血缘图谱**。
  - **请求参数**：`direction`（`FORWARD` 正向 / `BACKWARD` 反向 / `BOTH` 双向，默认 `BOTH`）、`maxDepth`（1~10，默认 5）。
  - **响应结果**：`TraceabilityGraphResponse` = `{ batchNo, hasCycle, nodes, edges, impact }`。
  - 节点 `TraceNode` 携带 `batchNo` / `furnaceHeatBatchNo` / `materialCode` / `inspectionOrderNo` / `orderNo` / `supplierOrCustomer` / `operatorName` / `timestamp` / `nodeStatus`；
    缺值一律**缺省或 `null`**，界面显示 `—`，不得用空串或占位符填充。
  - `nodeStatus` 取 6 个枚举值之一：`PASSED` / `STORED` / `CONCESSION` / `FAILED` / `INSPECTING` / `PENDING`。
    `CONCESSION`（特采 / 让步接收）节点额外携带 `mrbNo` 与 `concessionAttachmentUrl`（由 `mrb_reviews` 按 `batch_no` + `disposition='CONCESSION'` 反查补齐）；
    授权件缺失即表示未取得客户授权，界面必须显式提示。
  - `impact`（`TraceImpactSummary`）—— 沿 `batch_trace_relations` 的 `parent_batch → child_batch` 方向做递归闭包（深度上限 10、按路径数组去重防环），
    统计 `downstreamBatchCount` / `upstreamBatchCount` / `downstreamOrderCount` / `downstreamPartyCount` 及对应清单。
    **恒按生产流向计算，与查询方向无关**；节点表只有单一 `supplier_or_customer` 列、不区分客户与供应商，因此界面文案只能是「**下游单位**」，不得写「客户数」。
  - PBAC 命中拦截返回 403，界面提示「权限拦截」而不是「无数据」。
- `GET /api/v1/trace/:batchNo` —— 历史别名，与上一条同义（保持向后兼容），参数与响应完全一致。

> 历史漂移更正：本节曾长期写作 `GET /api/v1/trace/genealogy?heat_no&lot_no&max_depth`，该路由在实现中**并不存在**，
> 现按真实路由与真实参数重写（见 `docs/24` §9.2）。

### 3.7 质检方案管理 (`/api/v1/plans`)
- `GET /api/v1/plans`: 查询质检方案库（一行 = 一个 `plan_code` 聚合，按最新版本更新时间倒序）。
  - **请求参数**：`inspectionType`（契约检验类型枚举，单值精确匹配）、`materialCode`（专属物料编码，模糊匹配）、
    `categoryCode`（存货分类编码，命中方案自身的 `category_code` **或** 经 `materials` 反查的物料分类）、`keyword`（方案编码 / 方案名称模糊匹配）、
    `isActive`（`true` 时只返回存在 `ACTIVE` 版本的方案）、`page`（默认 1）、`pageSize`（默认 20，上限 100）。
  - **响应结果**：`{ total, page, pageSize, items, list }`，`total` 为去重后的方案编码命中总数（不是版本行数），
    `items` 与兼容别名 `list` 指向同一份当页数据，元素为 `InspectionPlan`（含 `versions[]` 版本与 `items[]` 指标项）。
  - **派生字段（读时 JOIN，不落冗余列，见 docs/20 §2.3）**：`materialName`（`materials.material_name`）、
    `categoryName` / `categoryId`（`inventory_categories`，按 `category_code`）、`status`（由该方案全部版本行的
    `version_status` 派生：有 `ACTIVE`=已启用，仅 `DRAFT`=待审批，否则已停用）、
    版本级 `createdByName`（`employees.name`，按 `created_by`）。前端不得再自行映射主数据名称或推导方案状态。
  - **筛选口径**：页面上的「方案名称 / 产品编码 / 产品分类 / 质检类型」四个条件与上述参数一一对应，
    一律下沉到后端 SQL 过滤，前端不对返回结果做二次过滤。
- `GET /api/v1/plans/stats`: 「质检方案设计」页 4 张 KPI 卡的服务端聚合，返回
  `{ total, enabled, pending, productCount }`（`PlanStats` 契约）。
  - `total` = 去重方案数；`enabled` = 存在 `ACTIVE` 版本的方案数；`pending` = 无 `ACTIVE` 版本但有 `DRAFT` 版本的方案数；
    `productCount` = `material_code <> ''` 的去重物料数（分类通用方案不计入覆盖产品）。
  - 只施加 PBAC 物料权限过滤，**不受列表筛选条件与分页影响**：严禁用当页列表数据推算全局 KPI
    （方案数超过一页时数字必然失真）。
- `POST /api/v1/plans`: 新建质检方案及首个版本与检验特征指标。
  - **请求体契约是 `CreateInspectionPlanRequestSchema`（不是读模型 `InspectionPlanSchema`）**：两者字段逐字一致，
    唯一差别是 `versions[].id / planId / createdBy` 由服务端派生（版本行 UUID 落库时才生成、创建人取 JWT 操作人），
    调用方不得传也无法传。用读模型校验请求体会让「方案设计页新建」恒定 400
    （`versions.0.planId: Required; versions.0.createdBy: Required`），故两者必须分开，不得合并。
  - 首个版本一律以 `DRAFT` 落库（待质量主管审批后启用），请求体携带的 `versions[].status` 被服务端忽略。
  - **`planCode` 可省略（TBD-11）**：留空（**不传该字段**）时由服务端按 `QP-{YYYYMMDD}-{NNN}` 取号 ——
    `QP` 固定前缀 + 本地时区当日日期 + 3 位左补零的当日流水（每日归零），规则由 `@letian/domain` 的
    `inspection-plan-number` 定义，落库经迁移 `017` 的 `inspection_plan_code_sequences` 池按 (前缀, 日期)
    原子 upsert 取号（与检验单号的迁移 `012` 同构）。**显式传入则按原值使用** —— 库中 `QP-IQC-304SS`
    这类人工语义编码仍然合法、不会被自动取号改写；但**传空串会被 400 `validation-failed` 拒绝**：
    留空只能"不传字段"，不允许用空串表达"请帮我取号"（否则会落出编码为空串的脏方案）。口径见 docs/17 §7.5.7。
  - 版本级 `effectiveStartDate / effectiveEndDate`（`YYYY-MM-DD`）随请求体的 `versions[0]` 提交，
    落 `inspection_plans.sampling_config`（JSONB，**无新增列**）：起始日到达后该版本才参与自动匹配，
    截止日过后自动退出并继续往存货分类级兜底；两项都留空 = 即刻生效、长期有效（口径见 docs/17 §7.3）。
  - `categoryCode` 缺省时回落到绑定物料的真实存货分类；`versions[].items[]` 支持
    `acceptableValues?: string[]`（定性 / 文本型的可接受值清单，见 docs/17 §7.5.4）。
  - **指标项为空必须被拒**：契约允许省略 `versions`，但领域规则 `PLAN_EMPTY_ITEMS` 要求版本至少 1 个指标项，
    `CreatePlanUseCase` 把该领域异常收敛为 **400 `validation-failed`**（含 `invalidParams`），
    **不得放行空草稿**（否则建单时方案快照给不出待检指标清单），也不得冒成 500。
- `GET /api/v1/plans/match`: 按「物料编码 + 检验类型」匹配生效方案，返回 `planVersionId` + 待检指标清单 + `matchSource`。
  - 两级兜底：物料专属方案（`material_code` 精确相等）→ 存货分类通用方案（`material_code = ''` 且
    `category_code` = 该物料分类）；多命中取最新创建的一行；未命中返回 404 `inspection-plan-not-found`。
  - 只认 `version_status = ACTIVE` **且**生效周期覆盖当天的版本（`effectiveStartDate <= CURRENT_DATE <= effectiveEndDate`，
    两侧都可为空）：周期外的版本直接失效，继续往下一级兜底。
- `POST /api/v1/plans/versions/{versionId}/status`: **方案版本启停（审批）**。
  - **请求体契约 `TogglePlanVersionStatusRequestSchema`**：只传 `{ action: 'ACTIVATE' | 'DEACTIVATE' }`
    （`PlanVersionStatusActionEnum`）。目标版本由 URL 的 **`versionId` = 版本行 UUID** 唯一确定，
    服务端**不做任何「按方案编码回退」**（避免审批动作落到非预期版本上）；非契约动作 → 400。
  - **角色门禁**：仅 `QA_MANAGER` / `ADMIN` / `SYSTEM` 可执行，其余角色 **403 `forbidden`**
    （`assertPlanApprover`）。此处按**角色**判定而非权限位：登录签发的 JWT 只带 `role`、不带 `permissions`，
    用权限位会让真实登录一律 403。
  - **状态机口径**（`@letian/domain` 的 `InspectionPlan`）：
    ① `ACTIVATE` 后该版本为 `ACTIVE`，同方案其它 `ACTIVE` 版本自动转 `INACTIVE`（**单激活态**），
    已 `ACTIVE` 的版本重复启用为幂等放行；
    ② 目标版本**指标项为空时拒绝启用**（`PLAN_ACTIVE_EMPTY_ITEMS` → 400）；
    ③ `DEACTIVATE` 只接受当前为 `ACTIVE` 的版本（其余状态 → 400），已 `INACTIVE` 为幂等；
    ④ 目标版本不存在时 404（`PLAN_NOT_FOUND`）。
  - **响应结果**：`200` + `InspectionPlan`（读模型），其中 `status` 为方案级派生状态
    （全部版本停用后回到 `DISABLED`）。
  - **用途**：`POST /api/v1/plans` 一律落 `DRAFT`，而 `GET /plans/match` 只认 `ACTIVE` ——
    该路由是草稿版本进入自动匹配的**唯一入口**（页面「审批」/「停用」按钮的数据源，见 docs/09 §2.6）。
- `POST /api/v1/plans/versions/{versionId}/upgrade`: **方案版本升版**（以 URL 版本行为模板产出新草稿）。
  - **请求体契约 `UpgradePlanVersionRequestSchema`**：
    `{ versionNo?, items?, samplingScheme?, aqlLevel?, strictness?, effectiveStartDate?, effectiveEndDate? }`。
    **空对象 `{}` 合法** —— 每个字段都是「省略即派生」；显式传入 `items` 时至少 1 项（`min(1)`），
    传 `versionNo: ''` 或 `items: []` 一律 400（留空只能用**字段缺席**表达，不接受空串 / 空数组）。
  - **省略字段的派生口径**：模板版本行由 URL 的 `versionId`（版本行 UUID）唯一确定，服务端不做「按方案编码回退」；
    ① `versionNo` 省略 → 领域规则 `nextInspectionPlanVersionNo` 在**现有最大版本号**上自动升位
        （`v2.4/v2.5 → v2.6`，保留原前缀写法与段数，撞号继续递增），显式传入则按原值使用，与 `plan_code`
        的服务端取号（TBD-11）**完全对称**；
    ② `items` / `samplingScheme` / `aqlLevel` / `strictness` 省略 → **沿用模板版本行**；
    ③ `effectiveStartDate` / `effectiveEndDate` **不继承**：省略即长期有效（照抄旧周期会让新草稿「出生即过期」）。
  - **门禁口径**：只做 **PBAC 物料权限**校验，**不做角色门禁** —— 升版只产出一个 `DRAFT`、不改变生效状态，
    与「新建方案」`POST /plans` 同级；改变生效状态的 `…/status` 才需质量主管（见上一条）。
  - **状态机口径**（`@letian/domain` 的 `InspectionPlan.createDraftVersion`）：
    ① 新版本一律落 `DRAFT`，**既有版本行的状态与指标项原样不动**（历史检验单的 `plan_snapshot` 不会被追溯改写）；
    ② 同一方案**已有 `DRAFT` 版本时拒绝**（`PLAN_DRAFT_ALREADY_EXISTS` → 400），保证「升版」连点不会造出多份待审批版本；
    ③ 模板版本行不属于该方案 / 不存在 → 404 `plan-not-found`。
  - **响应结果**：`201` + `InspectionPlan`（读模型，`versions[]` 含新草稿）。成功后新版本仍需经
    `…/status` 的 `ACTIVATE` 审批才参与自动匹配。页面入口见 docs/09 §2.6，口径见 docs/17 §7.5.8。

### 3.8 报表打印与矢量导出 (`/api/v1/reports`)
- `GET /api/v1/reports/templates`: 获取可用的打印报表模板清单。
- `POST /api/v1/reports/render-pdf/:inspectionId`: 渲染并输出带防伪矢量印章的官方质检报告。

---

### 3.9 主数据档案与企业档案 (`/api/v1/master-data`)

- `GET /api/v1/master-data/{suppliers|customers|inventory|workshops|employees|categories}`: 各类主数据只读清单。
- `GET /api/v1/master-data/company-profile`: 读取**企业档案单行主数据**（质量 / 制造证书抬头、印章文字、「供货单位·产地」的唯一来源）。
  - **无行时返回 `null`**（不是空对象、更不是编造默认值）：调用方据此提示「企业档案未维护」，并让证书对应单元格留白。
- `PUT /api/v1/master-data/company-profile`: 维护企业档案（服务端 upsert）。
  - **只更新请求体显式给出的字段**（空串 = 清空）；`email` 受契约 `z.string().email()` 约束，**留空须不下发该字段**（传空串会被判非法 → 400）。
  - `updated_by` / `updated_at` 由服务端按**当前登录用户**与 `now()` 写入，客户端不可传入。
  - 设计口径见 `docs/35` §6，物理表定义见 `docs/03` §2.14。

## 4. 高级复合过滤 DSL 规范 (Query Filter DSL)

所有列表接口统一支持扁平与复合过滤参数：

```
GET /api/v1/inspections?page=1&pageSize=20&filter[type]=IQC&filter[status]=PASS&filter[created_at][gte]=2026-09-01T00:00:00Z&sortField=created_at&sortOrder=desc
```

- 字段操作符支持：
  - `[eq]`：精确相等（默认）
  - `[like]`：模糊匹配（支持单号、品名、规格）
  - `[gte]` / `[lte]`：时间与数值范围检索
  - `[in]`：多值枚举过滤（如 `filter[status][in]=PASS,CONCESSION`）


---

## 5. 数据导入与导出规范 (Excel / CSV Batch Import Standards)

针对制造现场高频的批量维护需求，系统提供标准 Excel / CSV 导入管道，严格遵循以下数据导入校验规则：

### 5.1 存货分类与质检方案批量关联导入
- **支持格式**：`.xlsx`, `.csv` (UTF-8 编码)
- **模板必填列**：
  1. `分类编码` (category_code): 必填，对应 ERP 树形分类码（如 `01.02.05`）。
  2. `分类名称` (category_name): 必填，中文品类描述。
  3. `方案编号` (plan_id): 必填，已激活的质检方案全局唯一 ID。
  4. `有效生效期` (effective_from): 可选，默认为当前日期（YYYY-MM-DD）。
  5. `失效截止期` (effective_to): 可选，超出该日期自动降级为默认兜底方案。
- **校验规则**：
  - 系统在导入事务中先验证 `plan_id` 存在且状态为 `ACTIVE`；
  - 若同一分类已存在处于生效区间内的关联方案，执行**版本覆盖更新**并在审计表中记录变更历史。

### 5.2 质检指标项与抽样规则批量导入
- **模板必填列**：
  1. `方案编号` (plan_id): 所属方案编码。
  2. `检验项目名称` (item_name): 如“外径公差”、“抗拉强度”、“镀层膜厚”、“碳含量C”。
  3. `指标类型` (item_type): 枚举值 `QUANTITATIVE` (定量数值) / `QUALITATIVE` (定性外观)。
  4. `标称值` (nominal_value): 定量项必填（如 `12.00`）。
  5. `公差上限` (upper_tolerance): 如 `+0.05`。
  6. `公差下限` (lower_tolerance): 如 `-0.02`。
  7. `单位` (unit): 如 `mm`, `MPa`, `μm`, `%`。
  8. `检验方法/工具` (inspection_tool): 如“数显千分尺”、“万能拉力机”、“光谱仪”。
  9. `检验阶段` (stage): `IQC` / `IPQC_CUTTING` / `IPQC_ROLLING` / `IPQC_FINAL` / `OQC`。
  10. `严重等级` (defect_class): `CRITICAL` / `MAJOR` / `MINOR`。
- **容错处理**：
  - 采用逐行原子化校验，若发现单行格式错误，返回包含 `行号 + 字段名 + 错误原因` 的明细错误列表，整批事务回滚，杜绝半导入脏数据。

### 5.3 管家婆 ERP 存货档案批量同步接入
- 支持通过直连 SQL Server 批量同步 `caimao_tables_list.txt` 中的存货档案视图。
- 同步字段映射：`存货编号 -> part_number`、`存货全名 -> part_name`、`规格型号 -> specification`、`计量单位 -> unit`。
- 采用增量 `MERGE / ON CONFLICT DO UPDATE` 机制，自动同步 ERP 中新增或修改的物料。


### 5.4 管家婆 ERP 扩展字段接入与对账映射规范
根据现场真实 ERP 物理结构及业务配置，QMS 与 ERP 接入时按以下规范提取扩展业务字段：

| 业务字段 | ERP 物理字段源 | 默认回退策略 | QMS 领域模型字段 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **客户地址** | 1) Dlyndx.UserDefined05 (送货地址)<br>2) DlyndxOrder.UserDefined05 (订单收件地址)<br>3) Btype.TelAndAddress (基础档案地址) | 优先取出库/订单填写的具体送货地址，为空时自动回退至客户档案注册地址 Btype.TelAndAddress | customerAddress / address | 用于合格证打印、发货检验单、客户报告 |
| **项目号** | 1) Dlyndx.projectid (单据项目外键)<br>2) DlySale.ProjectID (明细项目)<br>3) Mtype.UserCode (项目基础档案) | 单据中存在则直接读取；为空时缺省为 null | projectNo | 对应 ERP 项目核算大类，用于关联专项产品与批次 |
| **短项目号** | 1) DlySale.FreeDom04 / 自由项标记<br>2) projectNo 规则截取 (前缀码) | 无独立物理列，优先从自由项或存货扩展属性中读取，缺省为 null | shortProjectNo | 适用于图纸/简码流转与标签打印 |
| **制造日期** | 1) DlySale.ProduceDate (销售明细制造日期)<br>2) DlySC.ProduceDate (生产工单制造日期)<br>3) DlyCheck.ProduceDate (入库质检日期) | ERP 中销售出库若为空，自动回退取工单完成日期或检验合格入库时间（避免合格证出具空缺） | manufactureDate | 用于合格证溯源、保质期管理、批次追溯 |

### 5.5 管家婆 ERP 采购入库与来料检验 (IQC) 字段映射规范
来料检验工单台账字段与管家婆 ERP (Dlyndx + DlyBuy + DlyNdxCheck + DlyCheck + Ptype + Btype) 保持口径一致：

| UI 列表展示列 | 字段说明 | ERP 物理字段源 | QMS 领域模型字段 | 数据样例 |
| :--- | :--- | :--- | :--- | :--- |
| **检验单号** | QMS 来料检验单编号 | DlyNdxCheck.Number / 系统自增规则 | orderNo / docNo | `IQC-20260706-0001` |
| **入库单号** | ERP 采购入库/送检单号（即原「采购入库单号」，同一业务对象） | Dlyndx.Number (VchType=161) | inboundNo（库列 `inbound_no`，迁移 021） | `RK-20260706-001` / `GR-2022-03-10-00001` |
| **入库日期** | 到货/采购入库登记日期 | Dlyndx.Date (CONVERT varchar 120) | inboundDate（库列 `inbound_date`） | `2026-07-06` |
| **物料编号** | 物料存货编码 | Ptype.UserCode | materialCode / partNumber | `MAT-304SS-05` |
| **物料名称** | 物料存货全称（**只承载品名，不承载规格型号**） | Ptype.FullName | materialName（库列 `material_name`，快照自 `materials.material_name`） | `不锈钢线材 Φ5.0mm` |
| **规格型号** | 物料规格尺寸与型号（**独立列，与品名各归其位**） | Ptype.Standard | specification（库列 `specification`，快照自 `materials.spec_model`；别名 `spec` 只读派生不落库） | `Φ5.0mm / 盘圆 / 304HC` |
| **数量** | 到货/入库总数量 (含单位) | DlyBuy.Qty + Ptype.Unit | totalQty / qtyDisplay（单位取库列 `unit`，快照自 `materials.unit`） | `50 KG` |
| **供应商** | 往来单位/供货厂商全称（展示口径取供应商主数据 `suppliers.supplier_name`，编码仅作兜底） | Btype.FullName | supplierName（兜底 supplierCode）/ supplier | `江苏大明不锈钢特钢有限公司` |
| **批次号** | 原材料进厂炉批号/流水批次 | DlyBuy.BatchNo / DlyCheck.Blockno | batchNo / lotNo | `LOT-20260706-001` |
| **检验状态** | 来料质检流转状态 | DlyCheck.Verdict / 内部状态枚举 | status (`待检验`/`检验中`/`已合格`/`不合格`/`已关闭`) | `待检验` |
| **检验人** | 经办质检员姓名 | Etype.FullName (来自 DlyndxCheck.EtypeId) | inspectorName | `张检验` / `-` |
| **操作** | 业务动作流 | 状态驱动 (`检验` / `详情` / `追溯`) | actions | 待检验显示检验/详情；完结显示详情/追溯 |

> **建单写入口径（`POST /api/v1/inspections`）**：上表「物料名称 / 规格型号 / 数量单位」三列一律以**存货档案为权威来源** ——
> 请求体显式给出时以请求体为准，省略（或传空白）时由服务端按 `materialCode` 回查
> `materials.material_name` / `spec_model` / `unit` 补齐；名称两侧都取不到返回 `400 validation-failed`，
> 规格型号取不到则落 NULL（**绝不从物料名称猜规格**）。详见 `docs/26-来料检验物料名称与规格型号数据字段与接口打通设计.md` §5.1。
