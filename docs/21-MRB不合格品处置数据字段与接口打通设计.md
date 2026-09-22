# MRB 不合格品处置数据字段与接口打通技术方案

> **版本**：v1.1
> **更新时间**：2026-09-21
> **对应原型**：WPS图片(13)
> **对应页面**：不合格品处置 → MRB不合格品处置（`apps/web/src/pages/mrb/index.tsx` + 两个抽屉）
> **对应迁移**：`015_mrb_pool_and_flow_wiring.ts`
> **配套文档**：`19-MRB不合格品处置页整合设计.md`（页面结构与视觉）、`03-数据模型.md`、`04-API与导入规范.md`

---

## 1. 背景与业务目标

PRD（`01-PRD.md` §3.7）与原型 `prototypes/WPS图片(13).png` 要求 MRB 不合格品处置是「不合格判定 → 待审核池 → 多方会签评审 → 最终处置闭环」的单一入口。上一阶段已把原【不合格待审核池】与【MRB评审工单】两个独立页面合并为单页（见 `19-MRB不合格品处置页整合设计.md`），但合并只解决了**界面层**的入口收敛。

本方案解决**数据层**问题：界面每个字段、每个交互参数字段，是否真的落到 PostgreSQL 物理列、并由 Fastify 接口读写。凡「界面有、链路断」的字段一次性改造打通，交付物包含：数据库迁移脚本、`@letian/contracts` 契约、Fastify API、Kysely 仓储、用例编排、种子数据与 OpenAPI 文档。

---

## 2. 核查方法与证据链

| 核查手段 | 具体动作 |
|:---|:---|
| 物理库结构核对 | 直连 `letian_qms_db` 查询 `information_schema.columns`，逐列比对 `mrb_reviews`（改造前 18 列 / 改造后 24 列）、`pending_mrb_items`（改造前 16 列 / 改造后 22 列）、`review_flows`（9 列）、`inspection_orders`（相关 9 列） |
| 接口实测 | `POST /api/v1/auth/login` 取 JWT 后实调 `GET /mrb/records`、`GET /mrb/pending-pool`（PENDING_INITIATE / INITIATED 两态）、`GET /review-flows`、`POST /mrb/records/:id/sign`、`POST /mrb/records/:id/disposition`，记录真实状态码与响应体字段 |
| 数据链路比对 | 界面字段 → 契约 schema → 控制器入参/出参 → 仓储映射 → 物理列，五段逐段对照 |
| 代码走查 | `contracts/schemas/mrb.ts`、`mrb.controller.ts`、`review-flows.controller.ts`、`mrb-review-repository.ts`、`use-cases/mrb/*`、`pages/mrb/*` |

---

## 3. 核查结论

### 3.1 已打通字段（无需改造）

**处置列表页 10 列 —— 全部已通**

| 界面列 | 契约字段 | 物理列（`mrb_reviews`） | 接口 | 结论 |
|:---|:---|:---|:---|:---:|
| MRB单号 | `mrbNo` | `mrb_no VARCHAR(64) UNIQUE NOT NULL` | `GET /mrb/records` | ✅ 已通 |
| 来源检验单 | `sourceOrderNo` | `source_order_no VARCHAR(64) NOT NULL` | `GET /mrb/records` | ✅ 已通 |
| 物料编码 | `materialCode` | `material_code VARCHAR(64) NOT NULL` | `GET /mrb/records` | ✅ 已通 |
| 物料名称 | `materialName` | `material_name VARCHAR(255) NOT NULL` | `GET /mrb/records` | ✅ 已通 |
| 不合格原因 | `defectDescription` | `defect_description TEXT NOT NULL` | `GET /mrb/records` | ✅ 已通 |
| 不合格数量 | `defectQty` | `defect_qty NUMERIC NOT NULL` | `GET /mrb/records` | ✅ 已通 |
| 检验人 | `inspectorName` | 读侧按 `source_order_no = inspection_orders.order_no` 派生 | `GET /mrb/records` | ✅ 已通（派生列，非物理列，见 §6.3） |
| 发现日期 | `createdAt` | `created_at TIMESTAMPTZ NOT NULL` | `GET /mrb/records` | ✅ 已通 |
| 评审状态 | `status` | `status VARCHAR(32) NOT NULL`（4 态 CHECK） | `GET /mrb/records` | ✅ 已通 |
| 处置方式 | `disposition` | `disposition VARCHAR(32)`（4 类 CHECK） | `GET /mrb/records` | ✅ 已通 |

**待审核池已通字段**（实测响应体字段：`id, inspectionOrderId, orderNo, inspectionType, batchNo, materialCode, materialName, defectQty, totalQty, defectDescription, status, inspectorId, inspectorName, createdAt`）：
来源检验单、检验环节、物料、批次、不合格数量、报检总数、不合格描述、检验人、状态 —— 由 `inspection_orders` 实时投影（fallback 分支）已可用。

**会签链路**：`POST /mrb/records/:id/sign` 实测 `200`，`roleCode / approverName / action / comment` 四字段落 `mrb_reviews.approvers`（JSONB），四方席位渲染正常 —— 已通。

### 3.2 断链清单（本次改造对象）

| # | 断链点 | 现网现象（实测） | 根因 |
|:---:|:---|:---|:---|
| **D1** | 待审核池「供应商 / 客户 / 不合格指标项 / 检验人 / 不良率」 | `GET /mrb/pending-pool` 响应体**无** `supplierName`、`customerName`、`defectItemCode`；抽屉中「供应商:」「客户:」「指标项:」永远不会渲染，「不良率」只能靠 `defectQty/totalQty` 前端近似 | `pending_mrb_items` 缺 `supplier_name`、`customer_name`、`defect_item_code`、`inspector_id`、`inspector_name`、`total_qty` 六列；池读取一旦命中该表，这些字段全部丢失 |
| **D2** | 待审核池状态口径 | 表 `status` 默认值为 `'PENDING_REVIEW'`，而契约 `PendingDefectStatusEnum` 只有 `PENDING_INITIATE / INITIATED / DISMISSED`；按「待发起评审」筛池（`status=PENDING_INITIATE`）在 SQL 层匹配 0 行 | 004 迁移建表时沿用了 MRB 评审单的状态词表，与池契约枚举分叉；且无 CHECK 约束兜底 |
| **D3** | 待审核池**入池写入方** | `pending_mrb_items` 实测 **0 行**（库内 3 条 `FAILED` + 1 条 `IN_MRB_REVIEW` 检验单全靠 fallback 分支投影）；判定不合格的用例只写 Outbox 事件 | 「不合格品自动汇入待审核池」的写入链路从未实现，池表是孤儿表 |
| **D4** | 发起评审的入参字段 | 契约 `InitiateReviewRequest` 的 `flowId`、`urgencyLevel`、`pendingDefectId` **无任何落点**；`mrb_reviews` 无 `pending_defect_id`、`review_flow_id`、`urgency_level`、`review_notes` 列，`InitiateReviewRequest` 里只有 `reviewNotes` 被拼进 `defectDescription` 文本 | 迁移与仓储 `save()` 未随契约演进补齐列；`mapRow()` 也因此无法回吐 `pendingDefectId`（契约字段恒空） |
| **D5** | 评审流程匹配 | `trigger-mrb-review` 以 `cmd.failCategory ?? 'CRITICAL_DIMENSION'` 调 `findApplicableFlow()`，该值**不在** `MRBFailCategoryEnum` 内；命中 4 条 ACTIVE 流程的概率为 0，首节点角色退化为硬编码 `QUALITY_MANAGER` | 默认值与契约枚举脱节；且发起时用户明确选中的 `flowId` 未被消费（选了流程也不生效） |
| **D6** | 处置接口响应体 | `POST /mrb/records/:id/disposition` 实测返回顶层 `{ mrbReview: {...} }`，而契约声明返回 `MRBRecord` | 控制器直接 `send(useCaseResult)`，把用例的包装对象当 DTO 下发；前端按 `MRBRecord` 解析后 `status/disposition` 全为 `undefined`，抽屉状态不刷新 |
| **D7** | 处置请求体的签署凭证 | 契约 `DisposeMRBRequest.approvers`（`min(1)`）与 `dispositionNotes`（`min(2)`）在运行时**不校验**：控制器另用宽松 body schema，前端实际发的是 `dispositionReason` | 契约与控制器两套口径，最终裁决人凭证不入 `approvers`，处置说明的字段名也对不上 |
| **D8** | 特采凭证真实性 | `POST /disposition { disposition: 'CONCESSION' }` **不带任何附件实测返回 200**：控制器兜底写入 `/attachments/concession_signed.pdf` | 控制器在 CONCESSION 分支无条件补默认路径，绕过了「特采必须客户书面签核」强制校验（PRD §3.7 硬规则） |
| **D9** | 池读取实现方式 | 池用例以 `(ctx as any).db` 直连 Kysely 并 `catch {}` 静默吞错 | 缺少 `PendingDefectPoolRepository` 端口，字段映射散落在用例里，类型不安全且错误被隐藏 |
| **D10** | 池条目与源检验单的一致性 | E2E 清理删除检验单后，`pending_mrb_items` 仍残留 6 条同源条目：池列表里可见，点「发起评审」永远 `404 待审核条目或源检验单未找到`（实测）。`mrb_reviews` 侧同样残留 | 池表 `source_order_id` 为 `VARCHAR`，与 `inspection_orders.id`（UUID）之间无外键；**删除检验单的一侧未同批撤销池条目与评审工单** |

---

## 4. 目标字段映射（改造后全量）

### 4.1 待审核池 `pending_mrb_items`（新增 6 列 + 口径归一）

| 界面字段 | 契约字段 | 物理列 | 来源 | 状态 |
|:---|:---|:---|:---|:---:|
| 来源检验单 | `orderNo` | `source_order_no` | 检验单 | 现有 |
| 检验环节 | `inspectionType` | `source_stage` | 检验单 `inspection_type` | 现有 |
| 物料编码 / 名称 | `materialCode` / `materialName` | `material_code` / `material_name` | 检验单 | 现有 |
| 批次号 | `batchNo` | `batch_no` | 检验单 | 现有 |
| 不合格数量 | `defectQty` | `defect_qty` | 检验单 `fail_qty` | 现有 |
| **报检总数量** | `totalQty` | **`total_qty NUMERIC`**（新增） | 检验单 `total_qty ?? sample_qty` | 新增 |
| **不良率** | `defectRate` | `defect_rate`（已有列，接口首次回吐） | `defect_qty / total_qty * 100` | 打通 |
| 不合格描述 | `defectDescription` | `fail_reason` | 检验单 `inspection_notes` 或超差项 | 现有 |
| **不合格指标项** | `defectItemCode` | **`defect_item_code VARCHAR(64)`**（新增） | 首个 FAILED 检验项 `itemCode` | 新增 |
| **供应商** | `supplierName` | **`supplier_name VARCHAR(255)`**（新增） | 检验单 `supplier_name`（IQC/委外） | 新增 |
| **客户** | `customerName` | **`customer_name VARCHAR(255)`**（新增） | 检验单 `customer_name`（OQC） | 新增 |
| **检验人** | `inspectorId` / `inspectorName` | **`inspector_id VARCHAR(64)`** / **`inspector_name VARCHAR(64)`**（新增） | 检验单同名列 | 新增 |
| 池状态 | `status` | `status`（默认改 `PENDING_INITIATE`，加 3 态 CHECK） | 入池/发起时写入 | 口径归一 |
| 关联 MRB | `mrbId` | `mrb_review_id` | 发起评审后回写 | 现有 |
| 汇入时间 | `createdAt` | `created_at` | 入池时间 | 现有 |

> **既有列收紧（迁移 018）**：入池幂等键 `source_order_id` 由 `VARCHAR(64)` 收敛为 **`UUID`**，
> 并补外键 `fk_pending_mrb_source_order → inspection_orders(id) ON DELETE CASCADE`。
> 收敛前先删除该列非 UUID 的历史脏行（这些行本来就无法关联到任何检验单）。
> 至此源检验单删除时池条目由**数据库级联**回收，D10 从"靠调用方纪律"变为"结构上不可能出现孤儿"。

### 4.2 评审单 `mrb_reviews`（新增 6 列）

| 界面/契约字段 | 物理列 | 说明 |
|:---|:---|:---|
| `pendingDefectId` | **`pending_defect_id UUID`**（FK → `pending_mrb_items.id`，`ON DELETE SET NULL`） | 池 → MRB 的正向溯源（此前只能靠池表反向找） |
| `reviewFlowId` | **`review_flow_id UUID`**（FK → `review_flows.id`，`ON DELETE SET NULL`） | 发起时选用的评审流程定义，不再被丢弃 |
| `urgencyLevel` | **`urgency_level VARCHAR(16) NOT NULL DEFAULT 'NORMAL'`**（3 值 CHECK） | 发起弹窗的紧急程度 |
| `reviewNotes` | **`review_notes TEXT`** | 发起说明（此前被拼进不合格描述文本，混淆了字段语义） |
| `disposedAt` | **`disposed_at TIMESTAMPTZ`** | 处置闭环时间（KPI「本月评审率」的处置侧时间锚点） |
| `disposedBy` | **`disposed_by VARCHAR(64)`** | 最终裁决人 |

索引：`idx_mrb_pending_defect(pending_defect_id)`、`idx_mrb_review_flow(review_flow_id)`、池表 `uq_pending_mrb_source_order UNIQUE (source_order_id)`（入池幂等键）。

---

## 5. 改造清单

| 层 | 文件 | 改造内容 |
|:---|:---|:---|
| 迁移 | `packages/infrastructure/src/migrations/015_mrb_pool_and_flow_wiring.ts` | §4 全部列/约束/索引；池状态历史值归一（`PENDING_REVIEW → PENDING_INITIATE`、`REVIEWING/RESOLVED → INITIATED`）；从 `inspection_orders` 回填池字段与**存量 `FAILED` / `IN_MRB_REVIEW` 工单补录池记录**；`mrb_reviews.pending_defect_id` 由池表 `mrb_review_id` 反向回填、`review_flow_id` 按 `source_type = applicable_type AND is_active` 回填、`disposed_at` 由 `updated_at` 回填；`down()` 完整可逆。**供应商回填口径**：`pending_mrb_items.supplier_name` → 源单 `vendor_name`（委外加工商）→ `suppliers.supplier_name`（按 `supplier_code` 回查）→ `inspection_orders.supplier_name`；客户同理走 `customers` 回查。只认 `inspection_orders.supplier_name` 会让存量行的「供应商」依旧是空（该列在真实库中普遍为空，已实测修正） |
| 契约 | `packages/contracts/src/schemas/mrb.ts` | 新增 `MRBUrgencyLevelEnum`；`MRBReviewSchema` 增 `reviewFlowId / urgencyLevel / reviewNotes / disposedAt / disposedBy`；`PendingDefectItemSchema` 增可选 `defectRate`；`DisposeMRBRequestSchema` 收口为「`dispositionReason` 或 `dispositionNotes` 至少一项 + `approvers` 可选默认 `[]` + 特采附件」，与控制器/前端三处同名 |
| 端口 | `packages/domain/src/ports/repositories.ts`、`packages/application/src/tx/unit-of-work.ts` | 新增 `PendingDefectPoolRepository` 端口与 `ctx.pendingDefects`；`ReviewFlowRepository` 补 `findById / listAll` |
| 仓储 | `packages/infrastructure/src/repositories/pending-defect-pool-repository.ts`（新建）、`mrb-review-repository.ts` | 池仓储实现 `list / findById / findBySourceOrderId / save(按 source_order_id 幂等 upsert) / markInitiated / markDismissed`；MRB 仓储 `save()` 与 `mapRow()` 持久化并回吐 §4.2 六列 |
| 用例 | `use-cases/mrb/collect-pending-defect.ts`（新建）、`pending-mrb-pool-use-case.ts`、`trigger-mrb-review.ts`、`decide-mrb-disposition.ts`、`inspections/record-measurements-and-judge.ts` | 判定 `FAILED` 时**同步入池**（供应商/客户/检验人/总数/指标项一次写全）；池读用例改走端口（去掉 `(ctx as any).db` 与静默 `catch`）；`initiateReview` 透传 `flowId / urgencyLevel / pendingDefectId / reviewNotes` 并回写池状态；`trigger` 消费 `flowId`（`findById`）+ 按工单环节映射 `failCategory`；处置用例合并 `approvers` 并写 `disposedAt / disposedBy` |
| 控制器 | `apps/api/src/controllers/mrb.controller.ts` | 处置接口：请求体与契约同名同校验、返回裸 `MRBRecord`（修 D6）、**删除特采附件伪造兜底**（修 D8）；发起接口透传池条目 id |
| 前端 | `apps/web/src/pages/mrb/InitiateReviewDrawer.tsx` | 「不良率」优先取接口 `defectRate`（与库内口径一致），缺失时回退前端计算 |
| 种子 | `packages/infrastructure/src/seeds/{data.ts,runner.ts}` | 新增 `seedPendingMrbItems`（3 条 `PENDING_INITIATE` + 1 条 `INITIATED` 关联种子 MRB，字段含供应商/客户/检验人/总数/不良率）；`pendingMrbItems` 纳入清表与行数汇总 |
| Mock | `apps/web/src/mocks/{data.ts,handlers.ts}` | 与真实接口同形：池字段补 `defectRate`、处置响应裸 `MRBRecord`、`mrb_reviews` 侧新字段 |
| 文档 | `docs/api/letian-qms-openapi.yaml`、`docs/03-数据模型.md`、`docs/04-API与导入规范.md`、`docs/19-*.md`、`docs/实施进度.md` | 同步 schema、列、接口与进度 |
| 迁移（遗留 2 闭环） | `packages/infrastructure/src/migrations/018_pending_pool_hardening.ts`（新建） | ① 删除 `source_order_id` 非 UUID 的历史脏行；② 列类型 `VARCHAR(64) → UUID`（已是 `uuid` 时跳过，可重复执行）；③ 补 `fk_pending_mrb_source_order → inspection_orders(id) ON DELETE CASCADE`。`down()` 反向（drop FK + 改回 `VARCHAR`），已实测可上可下 |
| 仓储 / 用例（遗留 1、3 闭环） | `packages/infrastructure/src/repositories/pending-defect-pool-repository.ts`、`packages/application/src/use-cases/mrb/pending-mrb-pool-use-case.ts`、`packages/domain/src/ports/repositories.ts` | 池查询改为「过滤条件 + 三维 PBAC + 分页」**整体下推 SQL**：`PendingDefectQuery.permissions` 新增，仓储复用 `buildMaterialPermissionWhere`（`targetRef: 'pending_mrb_items'`、`hasSupplierColumn: false`），同一套条件同时用于当页数据与 `total`；删除 `POOL_SCAN_LIMIT = 500`、用例层逐条 `assertAccess`、`STATUS_ALIASES` 与 `normalizePoolStatus`；`findBySourceOrderId` / `markInitiated` / `markDismissed` 加 UUID 格式守卫（避免 `22P02`） |
| 控制器（遗留 3 闭环） | `apps/api/src/controllers/mrb.controller.ts` | `/mrb/pending-pool` 的 `status` 收口为 `PendingDefectStatusEnum` 三态，004 历史词表（`PENDING_REVIEW` / `REVIEWING` / `RESOLVED`）直接 `400`，不再静默映射；行级权限改取 `getRequestPermissions` 并随查询下推 |
| 验收 | `scripts/testing/mrb-wiring-verify.cjs`（新建，`pnpm run verify:mrb-wiring`）、`apps/api/test/integration/e2e.test.ts` | 把 §7 验收口径固化为 26 条可重复 HTTP + 物理列 + PBAC 断言；E2E 清理阶段同批删除本次新建检验单关联的 `mrb_reviews` 与 `pending_mrb_items`（修 D10），不再留下孤儿池条目 |

---

## 6. 数据口径与业务约束

### 6.1 池状态机（与 `PendingDefectStatusEnum` 严格一致）

```
检验单判定 FAILED ──(自动汇入)──▶ PENDING_INITIATE ──(POST /mrb/pending-pool/initiate)──▶ INITIATED
                                        │
                                        └──(误判撤销/免审)──▶ DISMISSED
```

- 入池幂等键：`source_order_id` 唯一索引，重复汇入按 upsert 更新（不产生重复条目）；
- 发起评审后：池记录 `status = INITIATED`、`mrb_review_id` 回填、`review_started_at/by` 记录操作人；
- 「已发起评审」不回退：同一检验单重复发起由 `mrb_reviews.mrb_no` 与检验单 `IN_MRB_REVIEW` 双重拦截。

### 6.2 特采（让步接收）硬规则

`disposition = CONCESSION` 必须携带 `concessionAttachmentUrl`（客户书面签核件），服务端在用例层与控制器层双重校验，**不再生成任何默认附件路径**；缺失时返回 `400 CONCESSION_NOT_SIGNED_OFF`。

### 6.3 「检验人」派生口径

`mrb_reviews` 无 `inspector_name` 物理列，读侧按 `source_order_no` 关联 `inspection_orders.order_no` 派生；池发起生成的 MRB 其 `source_order_no` 即检验单号，因此派生链路对「池发起」与「自动触发」两条路径同时成立。派生字段在 `GET /mrb/records` 与导出报表中共用同一口径，不做前端二次拼装。

### 6.4 KPI 口径（不变）

待评审 / 评审中 / 累计已评审（评审中+已处置+已驳回）/ 已处置 / 本月评审率（本月 `DISPOSED` ÷ 本月创建总数），全部在 PBAC 行级过滤后统计，页面不得用当页数据自行推算。

---

## 7. 验证方案

| 验证项 | 命令 / 动作 | 通过标准 |
|:---|:---|:---|
| 迁移可上可下 | `pnpm db:migrate` → `pnpm db:migrate:down` → `pnpm db:migrate` | 两次 `up` 幂等，`down` 后列/约束/索引全部消失 |
| 物理列核对 | 直连库查 `information_schema.columns` | 池 6 列 + MRB 6 列存在，类型与默认值符合 §4 |
| 存量回填 | `select count(*) from pending_mrb_items` | 与 `inspection_orders` 中 `FAILED`/`IN_MRB_REVIEW` 条数一致 |
| 接口实测 | `GET /mrb/pending-pool` 两态 + `GET /mrb/records` + `GET /review-flows` | 池响应含供应商/客户/指标项/检验人/不良率；列表含 `inspectorName` |
| 写链路闭环 | `POST /pending-pool/initiate` → `POST /records/:id/sign` → `POST /records/:id/disposition` | 池记录转 `INITIATED` 且 `mrb_review_id` 回填；MRB 落 `pending_defect_id`/`review_flow_id`/`urgency_level`；处置返回裸 `MRBRecord` 且 `disposed_at/by` 有值 |
| 特采拦截 | `POST /disposition { disposition: 'CONCESSION' }`（无附件） | `400 CONCESSION_NOT_SIGNED_OFF` |
| 池 PBAC 下推 | `GET /mrb/pending-pool` 分别以全通配 / 分类白名单 / 限定供应商 / 无生效规则的员工身份调用 | 全通配看到全量；分类白名单只看到白名单分类的条目；限定供应商与无生效规则者 **fail-closed 看到 0 条**；`total` 恒等于过滤后命中数（与分页无关） |
| 池状态口径收敛 | `GET /mrb/pending-pool?status=PENDING_REVIEW` | `400`（旧词表不再兼容，绝不静默映射） |
| 外键级联 | 事务内 `delete from inspection_orders where id = <池条目源单>` → 查池 → `ROLLBACK` | 同源池条目一并消失，`ON DELETE CASCADE` 生效 |
| 静态与回归 | `pnpm -r run typecheck`、`pnpm --filter @letian/api run test`、`pnpm --filter @letian/web run validate:mocks`、`pnpm run verify:mrb`、`node scripts/testing/audit_check.js` | 全绿 |

### 7.1 自动化验收脚本

`scripts/testing/mrb-wiring-verify.cjs`（入口 `pnpm run verify:mrb-wiring`）把上表固化为 26 条可重复断言：
登录取 JWT → 实调 `pending-pool` / `records` / `initiate` / `sign` / `disposition` → 直连库核对
`mrb_reviews` 与 `pending_mrb_items` 物理列 → 末尾还原验收数据（删验收 MRB、池条目回 `PENDING_INITIATE`、工单回 `FAILED`）。

其中 6 条专测**池 PBAC 下推**（遗留 1 与遗留 3 的回归护栏）：按 `userId` 换登录身份即可切换 PBAC 规则，
期望条数一律从库内实际分布推导（`materials.category_code` 分组统计），不写死种子条数。

| 前置条件 | 说明 |
|:---|:---|
| 数据库 | 已迁移至 018 且执行过 `pnpm db:seed`（脚本按演示数据断言：广州发黑厂 / COA-001 / 李检验 / 200 件 / 12.5%） |
| 目标 API | 默认 `http://127.0.0.1:3101/api/v1`，可用 `MRB_WIRING_BASE` 覆盖；**不要指向 `:3100` 常驻实例**，避免与人工操作互相干扰 |
| 退出码 | `0` = 26/26 通过；非 `0` = 存在 FAIL |

### 7.2 实测结果（2026-09-21）

| 验证项 | 结果 |
|:---|:---|
| `pnpm db:migrate` | ✅ 015 执行成功；物理列核对：池 6 列 + MRB 6 列齐全，状态 CHECK 与 `uq_pending_mrb_source_order` 唯一索引就位 |
| `pnpm db:seed` | ✅ 20 表 / 162 行；`pending_mrb_items = 4`、`mrb_reviews = 6`（新列 `review_flow_id` / `pending_defect_id` / `disposed_at` / `disposed_by` 均已回填） |
| `pnpm run verify:mrb-wiring` | ✅ **20/20 通过**：池回吐供应商（广州发黑厂）/指标项（COA-001）/检验人（李检验）/受检数量 200/不良率 12.5%；发起后 `urgency_level=URGENT`、`review_flow_id`、`review_notes` 落库且池条目 `INITIATED` + 回填 `mrb_review_id`；会签转 `UNDER_REVIEW`；特采无凭证 `400 CONCESSION_NOT_SIGNED_OFF`；处置返回裸 `MRBRecord` 且 `disposed_at/by` 有值、附件按提交值落库 |
| `pnpm -r run typecheck` | ✅ 7/7 包通过 |
| `pnpm --filter @letian/api run test` | ✅ 契约校验 / 端到端 / 委外台账 / 物料权限回归全部通过（E2E 清理已同批删除池与 MRB 行） |
| 孤儿池条目 | ✅ 池 4 条、MRB 6 条与源检验单全部关联得上，孤儿 = 0 |

### 7.3 遗留闭环复测（2026-09-21 第二轮）

| 验证项 | 结果 |
|:---|:---|
| `pnpm -r run typecheck` | ✅ 7/7 包通过 |
| `pnpm db:migrate`（018） | ✅ `018_pending_pool_hardening` 执行成功；`source_order_id` = `uuid`（`NOT NULL`），外键 = `FOREIGN KEY (source_order_id) REFERENCES inspection_orders(id) ON DELETE CASCADE`，池 4 行完好 |
| 迁移可上可下 | ✅ `pnpm db:migrate:down` 回退 018：列回 `character varying`、外键消失、数据不动；再 `pnpm db:migrate` 重新应用后列回 `uuid`、外键重建。两次 `up` 幂等（根脚本 `db:migrate:down` 为本轮新增，此前只能 `pnpm --filter @letian/infrastructure run migrate:down`） |
| 外键级联实测 | ✅ 事务内 `delete from inspection_orders where id = 30000000-0000-4000-8000-000000000027`：删除前池命中 1 条 → 删除后 0 条 → `ROLLBACK` 后池恢复 4 条 |
| `pnpm run verify:mrb-wiring` | ✅ **26/26 通过**（新增 6 条 PBAC / 状态口径断言：张强全量 4 条；刘芳分类白名单 1 条且 `material_code` 恰为 `MAT-BLT-109-M10`；`page=2&pageSize=1` 仍报 `total=1`；陈静限定供应商 → 0 条；王建国规则停用 → 0 条；`?status=PENDING_REVIEW` → `400 validation-failed`） |
| `pnpm --filter @letian/api run test` | ✅ 契约 / 端到端 / 委外台账 / 物料权限全部通过；E2E 清理"同批删除 MRB 工单 1 条 + 待审核池条目 3 条" |
| `pnpm --filter @letian/web run test`（`validate:mocks` + 方案快照） | ✅ 15 组契约校验 + 方案快照用例全通过 |
| `pnpm --filter @letian/web run build` | ✅ 构建成功（`dist/assets/index-*.js` 2.30 MB / gzip 718 kB） |
| `pnpm run verify:mrb`（离线 Mock UI 走查） | ✅ **15/15 通过**：浅色主题、十列表头、4 页签、5 张 KPI、池抽屉与评审抽屉均正常 |
| `node scripts/testing/audit_check.js` | ✅ 通过（`any` 138/138 预算内、`@ts-ignore` 0） |
| `pnpm db:seed` | ✅ 20 表 / 162 行；`pending_mrb_items = 4`、`mrb_reviews = 6` |

---

## 8. 风险与回滚

| 风险 | 处置 |
|:---|:---|
| 池表历史脏状态值导致 CHECK 约束失败 | 迁移先 `UPDATE` 归一历史值再 `ADD CONSTRAINT`；索引建立在去重之后 |
| 存量重复池记录导致唯一索引冲突 | 迁移先按 `source_order_id` 保留最新一条去重，再建唯一索引 |
| 新增列影响既有 E2E 断言 | 新列全部可空或有默认值；`urgency_level` 默认 `NORMAL`，旧数据自动满足 |
| 回滚 | `015.down()` 逐项 `DROP COLUMN / DROP CONSTRAINT / DROP INDEX`，不改动任何既有列 |
| 池表 `source_order_id` 收紧为 UUID 时遇历史脏行 | `018.up()` 先 `DELETE` 该列非 UUID 的行再 `ALTER TYPE`，避免转换失败；`018.down()` 只 `DROP CONSTRAINT` + 改回 `VARCHAR(64)`，不改动列数据（已实测双向可逆） |
| 池 PBAC 分类维度改用 `materials` 子查询换算的代价 | 每行一次 `EXISTS` 子查询，走 `materials.material_code` 索引；换来池表零冗余列，避免"物料分类改归属后池表快照过期"的新脏源 |

---

## 9. 遗留与后续

§3.2 的三项遗留已于 2026-09-21 第二轮**全部闭环**，无未决项：

| # | 事项 | 闭环方式与实测证据 |
|:---:|:---|:---|
| 1 | 池 PBAC 过滤在应用层完成 | **已闭环**：三维权限条件改为随查询下推 SQL，复用 `buildMaterialPermissionWhere`（`targetRef: 'pending_mrb_items'`、`hasSupplierColumn: false`）。物料**分类维度不需要冗余列**——归属由 `materials.category_code` 子查询换算，池表既有 `material_code` 已足够；供应商维度因池表无供应商编码列，按翻译器与领域评估器一致的语义 **fail-closed**（限定供应商的规则不匹配任何行，绝不放宽成"分类命中即可见"）。`POOL_SCAN_LIMIT = 500` 与应用层逐条过滤已删除，`total` 与当页数据同口径。实测见 §7.3 |
| 2 | 孤儿池条目（D10） | **已闭环（结构上根治）**：迁移 `018_pending_pool_hardening` 把 `source_order_id` 由 `VARCHAR(64)` 收敛为 `UUID` 并补 `ON DELETE CASCADE` 外键，源检验单删除时池条目由数据库级联回收，不再依赖调用方纪律；仓储三个按 ID 读写的方法加 UUID 格式守卫避免 `22P02`。实测级联生效（§7.3） |
| 3 | 池状态历史别名 | **已闭环**：用例内 `STATUS_ALIASES` / `normalizePoolStatus` 已删除，控制器 `status` 收口为 `PendingDefectStatusEnum` 三态，旧值由契约校验直接 `400`（实测 `?status=PENDING_REVIEW` → `400 validation-failed`）。库内 CHECK 约束、契约枚举与代码口径三者完全一致 |

**后续登记（非本方案范围）**：池表若将来新增"供应商编码"列，可把供应商维度由 fail-closed 升级为精确过滤；
在此之前，**限定供应商的角色在池视图看到 0 条属于预期行为，不是缺陷**（与 `/mrb/records` 的既有语义保持一致）。

---

## 10. 评审流程设置子页字段与接口打通（2026-09-21 第三轮）

「评审流程设置」（菜单 `mrb-workflow`，`apps/web/src/pages/mrb/ReviewWorkflowView.tsx`）是 PRD §3.6 与
本页并列的 MRB 模块菜单项（对齐客户确认清单第 10、11 项），与【MRB不合格品处置】共用 `review_flows`
与 `GET /review-flows`，因此本轮一并核查其字段链路，发现 3 处「界面有、链路断」。

### 10.1 断链清单（E1~E3）

| # | 断链点 | 现网现象 | 根因 |
|:---:|:---|:---|:---|
| **E1** | 流程卡片「流程说明」 | 左侧流程列表恒显示占位文案「无详细描述」，右侧详情标题下的描述行恒空白 | 前端读的 `flow.description` 在契约 `ReviewFlowSchema` 与物理表 `review_flows` 中**均不存在**；而 `POST /review-flows` 的请求体 schema 正是 `ReviewFlowSchema`，用户提交的说明会被 Zod 静默剥离（字段无处可落） |
| **E2** | 节点卡片与「节点配置清单」五列中的四列 | 「顺序」列恒空、「授权签署角色」恒空、「是否必签」恒「否」、「特采审批权」恒「不支持」，卡片上的「必审」角标恒不显示 | 前端自建了局部 `ReviewNode` 接口（`nodeSeq / roleName / isRequired / allowConcession`），与契约 `ReviewFlowNodeSchema`（`nodeLevel / nodeName / roleCode / requireCustomerSign`）及库内 `nodes` JSONB **字段名既不统一、后三个在库里根本不存在**；文件内另有一份带这些字段的 `defaults` 兜底数据，只在接口异常时才生效，正好掩盖了该不一致 |
| **E3** | 「启用 / 停用此流程」按钮 | 点击后弹「流程状态已更新！」，但刷新即回退——**状态从未落库** | 前端打 `POST /review-flows/{id}/toggle`，控制器只注册了 `POST /review-flows/{id}/toggle-active` → 恒 `404`，被 `catch` 当成"网络异常"走了本地翻转兜底（兜底里还 `alert` 成功文案，属**假成功**） |

### 10.2 目标字段映射（改造后）

| 界面字段 | 契约字段 | 物理落点 | 来源 | 状态 |
|:---|:---|:---|:---|:---:|
| 流程说明 | `description` | **`review_flows.description VARCHAR(255)`** | 迁移 019 新增 | 新增 |
| 节点顺序 | `nodeLevel` | `review_flows.nodes[].nodeLevel` | 既有 | 打通（前端改用契约字段，自建的 `nodeSeq` 删除） |
| 节点名称 | `nodeName` | `review_flows.nodes[].nodeName` | 既有 | 打通 |
| 授权签署角色 | `roleCode` / `roleName` | `nodes[].roleCode` / **`nodes[].roleName`** | 既有 + 019 回填 | 打通 |
| 是否必签 | `isRequired` | **`nodes[].isRequired`** | 019 回填，默认 `true` | 新增 |
| 特采审批权 | `allowConcession` | **`nodes[].allowConcession`** | 019 回填：终审节点 `true` | 新增 |
| 客户书面签核闸门 | `requireCustomerSign` | `nodes[].requireCustomerSign` | 既有 | 打通 |
| 适用范围 | `applicableType` | `review_flows.applicable_type` | 既有 | 打通 |
| 流程编码 / 名称 / 版本 / 启停 | `flowCode` / `flowName` / `version` / `isActive` | 同名列 | 既有 | 打通 |

节点字段全部落在既有 `nodes` JSONB 内，**不新增节点明细表**：流程定义是整体替换式配置（`save()` 按
`(flow_code, version)` upsert 整份 `nodes`），拆表会让"整体替换"变成多表事务，得不偿失。

### 10.3 口径决策（为什么这样改）

1. **顺序只保留 `nodeLevel`**：`nodeSeq` 与 `nodeLevel` 是同一概念（PRD §3.6「1~3 级审批节点」），
   再加第二个排序键只会制造漂移源，因此**改前端读 `nodeLevel`**，不新增 `nodeSeq`。
2. **`roleName` 允许回退 `roleCode`**：历史 `nodes` 的 `roleCode` 写入的是中文角色显示名（如「检验员」），
   019 回填 `roleName = coalesce(roleName, roleCode)`，读侧再兜底一次，保证「授权签署角色」列不再为空；
   将来接企业统一角色字典只需回填 `roleName`，前端不动。
3. **`isRequired` 默认 `true`**：现网 4 条流程都是 3 级会签链，没有任何跳签语义，默认必签是与现况唯一一致的口径。
4. **`allowConcession` 回填为「终审节点 = true」**：PRD §3.6 规定特采「必须由技术部门与客户代表联合双签」，
   让步接收裁决权归属终审层级；按每条流程 `nodeLevel` 最大的节点回填，其余 `false`。
5. **启停路径收敛到 `/:id/toggle-active`**：文档（`docs/04` §3.5、OpenAPI）一直只有这一条路径。本轮修前端，
   并**移除前端 catch 里的假成功兜底**——接口失败必须让用户看到失败，而不是本地翻转后弹「已更新」。
6. **契约新增字段一律给 `default`（`isRequired` / `allowConcession`）或 `optional`（`description` / `roleName`）**：
   `POST /review-flows` 是整体保存语义，旧消费方少传字段时按默认值落库，不产生破坏性变更。

### 10.4 改造清单

| 层 | 文件 | 改造内容 |
|:---|:---|:---|
| 迁移 | `packages/infrastructure/src/migrations/019_review_flow_field_wiring.ts`（新建，已在 `runner.ts` 注册） | ① `review_flows` 新增 `description VARCHAR(255) NULL`；② 回填存量 `nodes` JSONB：补 `roleName`（`coalesce(roleName, roleCode)`）、`isRequired`（默认 `true`）、`allowConcession`（该流程 `nodeLevel` 最大者为 `true`，其余 `false`）；③ 幂等（`ADD COLUMN IF NOT EXISTS` + 按 key 存在性判断）。`down()` 删除 `description` 列；**不回滚 `nodes` 内的新增键**（追加键对旧读侧无副作用，避免把已保存的必签/特采权配置抹掉） |
| 契约 | `packages/contracts/src/schemas/mrb.ts` | `ReviewFlowNodeSchema` 增 `roleName?`、`isRequired`（默认 `true`）、`allowConcession`（默认 `false`）；`ReviewFlowSchema` 增 `description?` |
| 表类型 | `packages/infrastructure/src/database/schema.ts` | `ReviewFlowsTable` 增 `description: string \| null` |
| 仓储 | `packages/infrastructure/src/repositories/review-flow-repository.ts` | `save()` 写入 `description`；`mapRow()` 回吐 `description` 并对 `nodes` 做**读侧归一**（缺 `roleName` 时回退 `roleCode`、缺 `isRequired`/`allowConcession` 时补默认值），避免历史行再次渲染成空白 |
| 控制器 | `apps/api/src/controllers/review-flows.controller.ts` | 无需改路径（`/:id/toggle-active` 早已注册，是前端打错）；`POST /` 的请求体 schema 随契约自动收下新字段 |
| 前端 | `apps/web/src/pages/mrb/ReviewWorkflowView.tsx` | 删除自建 `ReviewFlow` / `ReviewNode` 局部接口，改用 `@letian/contracts` 的 `ReviewFlow`；`node.nodeSeq` → `node.nodeLevel`；角色列 `node.roleName ?? node.roleCode`；启停路径改 `POST /review-flows/{id}/toggle-active`；**删除 catch 内的本地翻转 + `alert` 假成功**；接口异常改为可见错误态；`loadFlows()` 按 `id` 把选中项重挂到**本次取回的新对象**（见 §10.5 顺带闭环 1） |
| 种子 / Mock | `packages/infrastructure/src/seeds/data.ts`、`apps/web/src/mocks/{data,handlers}.ts` | 4 条流程补 `description` 与节点 `roleName`/`isRequired`/`allowConcession`；Mock 补 `POST /api/v1/review-flows/:id/toggle-active` 处理器（此前 Mock 层只有 GET，前端启停连 Mock 都打不通） |
| 文档 | `docs/03-数据模型.md`、`docs/04-API与导入规范.md` §3.5、`docs/19-*.md` 变更记录、`docs/api/letian-qms-openapi.yaml`、`docs/实施进度.md`、`scripts/testing/README.md` | 同步列、字段、路径与验收口径；OpenAPI 补 `POST /review-flows` 与 `POST /review-flows/{id}/toggle-active` 两条**此前只写在 markdown 里、spec 缺失**的路径，`ReviewFlow` / `nodes[]` 组件补 `description` / `roleName` / `isRequired` / `allowConcession` |
| 验收 | `scripts/testing/mrb-wiring-verify.cjs`、`scripts/testing/mrb-verify.cjs`、`apps/api/test/integration/e2e.test.ts` | 打通验收补 4 条断言（`GET /review-flows` 回吐 `description` 与节点三个新字段且非默认值空洞、接口与库内 `description` 逐条一致、`POST /:id/toggle-active` 真实落库 `is_active` 且往返切回原值）；走查脚本补 6 条子页断言（说明非空 / 五列表头 / 四列真实回吐 / 浅色 / 启停按钮真实翻转，并自动放行原生 `alert`）；e2e 新增第 7 组「评审流程定义」用例 |

### 10.5 验收结果与顺带闭环

**验收**（2026-09-21）：

- `pnpm run verify:mrb-wiring` → **30/30**（迁移 `019` 回退→重跑→`pnpm db:seed` 复原后复跑仍 30/30，证明迁移 `down()` 只删列、不回滚 `nodes` 新键的口径与文档一致）；
- `pnpm run verify:mrb`（离线 Mock 走查）→ **21/21**（本轮当时的断言数；第四轮扩充为 **23/23**，见 §11），含子页启停按钮真实翻转；
- `pnpm --filter @letian/api run test` → 全部通过，含新增第 7 组「评审流程定义」用例；
- `pnpm -r run typecheck` 7/7；`pnpm --filter @letian/web run build` 通过；`node scripts/testing/audit_check.js` 通过（`any` 137/138、`@ts-ignore` 0）。

**顺带闭环（真缺陷 1 · 前端选中项持有旧对象）**：`loadFlows()` 刷新后仍把**上一次取回的对象引用**留在 `selectedFlow` 中，导致启停后左侧卡片角标已翻转为「已停用」、右侧详情的状态标签与启停按钮文案却停在旧值——用户看到的是「点了没反应」，与 E3 同属「界面状态 ≠ 库内状态」。修法：`setSelectedFlow` 按 `id` 把选中项重挂到本次取回的新对象（找不到则回退首条，列表为空则置 `null`），不改交互。

**顺带闭环（真缺陷 2 · 框架 400 被冒充成 500）**：全局 `errorHandler` 原先只对 401/403/404/409 分支回吐 `statusCode`，**Fastify 自身抛出的 400 会落到默认 500 兜底**——例如声明 `content-type: application/json` 却提交空体（`FST_ERR_CTP_EMPTY_JSON_BODY`）时，调用方看到的是「系统内部错误 · 请联系管理员」，把「请求写错了」误报成「服务端崩了」。修法：新增 400 分支回吐 `validation-failed`（`invalidParams: []`），401/403/404/409/500 口径不变。本轮的 e2e 用例已把该行为钉死。

**排障提示**：`POST /review-flows/:id/toggle-active` **必须带 JSON 体**（`{}` 即可）。前端 `api.post(path, {})` 天然满足；用 `curl`/验收脚本裸发不带体的 POST 会撞上上面那条 400 分支——这正是本轮先把 400 与 500 分清的原因。

---

## 11. 处置响应回吐复检单标识（2026-09-22 第四轮）

「返工（`REWORK`）」是本页唯一会**连带产生下一轮复检单**的处置结论：用例
`decide-mrb-disposition.ts` 在同一事务内调用 `create-reinspection.ts`，并把新复检单的
`reinspectionOrderId` / `reinspectionOrderNo` 随返回值上抛。第四轮复查发现链路在**控制器出口**断掉。

### 11.1 断链清单（D1~D2）

| # | 断链点 | 现网现象 | 根因 |
|:---:|:---|:---|:---|
| **D1** | 处置接口响应 | `POST /mrb/records/{id}/disposition` 处置 `REWORK` 后，响应体只有 MRB 单据本身，调用方（前端 / ERP）**拿不到新复检单号**，只能事后按 `batchNo` 反查——而反查在复检单尚未提交时必然为空 | 用例已返回 `reinspectionOrderId` / `reinspectionOrderNo`，控制器却 `return updated.mrbReview` 把这两个字段**整体丢弃**；`MRBRecord` 走 `MRBReviewSchema` 的 `parse`，多余键被静默剔除 |
| **D2** | 离线 Mock 保真度 | `apps/web/src/mocks/handlers.ts` 的处置处理器**从不创建复检单**，`REWORK` 只把 MRB 单置为已处置；真实后端却会在同一事务里插入 `{原单号}-R{n}` 行。于是「离线演示正常、真实环境多出一张单」 | Mock 只复刻了 MRB 单自身状态，没有复刻 `create-reinspection.ts` 的复检单生成与源单状态翻转（`RE_INSPECTING`） |

### 11.2 目标契约（改造后）

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| `reinspectionOrderId` | `string`（UUID，可选） | 本次处置连带生成的复检单主键；非 `REWORK` 处置不返回 |
| `reinspectionOrderNo` | `string`（可选） | 复检单号，口径恒为 `{来源检验单号}-R{轮次}`，轮次 = 该批次既有检验单数 + 1 |

响应体其余部分**仍是裸 `MRBRecord`**（`docs/04` §3.5 的既有口径不变），两个新字段是**向后兼容的可选追加**：
既有按 `MRBRecord` 解析的调用方不受影响。

### 11.3 改造清单

| 层 | 文件 | 改造内容 |
|:---|:---|:---|
| 契约 | `packages/contracts/src/schemas/mrb.ts` | 新增 `DisposeMRBResponseSchema = MRBReviewSchema.extend({ reinspectionOrderId?, reinspectionOrderNo? })`；**不把两字段并进 `MRBRecord`**，避免污染 `GET /mrb/records` 的条目契约 |
| 契约导出 | `packages/contracts/src/dtos/index.ts`、`packages/contracts/src/index.ts` | 导出 `DisposeMRBResponse` 类型与 `DisposeMRBResponseSchema` |
| 控制器 | `apps/api/src/controllers/mrb.controller.ts` | 处置响应改为展开 `updated.mrbReview` 并按需追加两个字段（用例早已算出，此前被丢弃） |
| 前端 | `apps/web/src/pages/mrb/ReviewDispositionDrawer.tsx` | 响应按 `DisposeMRBResponse` 解析；新增 `reinspectionOrderNo` 态，**只在切换单据时清空**（处置成功后父组件会回填新状态，跟着 `record.disposition` 一起重置会把刚拿到的单号立刻擦掉）；处置成功后在提交行上方渲染绿色横幅「返工处置已生效，系统已生成下一轮复检单：{单号}」 |
| 前端（父级） | `apps/web/src/pages/mrb/index.tsx` | `onChanged` 把最新单据状态回填 `activeRecord` 并重载列表，保证抽屉与列表同口径 |
| Mock | `apps/web/src/mocks/handlers.ts` | 新增 `buildReinspectionOrder(source, round)`，逐字段复刻 `create-reinspection.ts` 的沿承口径（携带批次凭证快照、实测值/判定/检验人/结果重置为 `PENDING`、经 `InspectionOrderSchema.parse` 校验）；`REWORK` 分支：按 `sourceOrderNo` 定位源单 → 统计批内单数得轮次 → 源单翻 `RE_INSPECTING` → 复检单入列表 → 响应按 `DisposeMRBResponseSchema.parse` 回吐 |
| 验收 | `apps/api/test/integration/e2e.test.ts` §2.3.2、`scripts/testing/mrb-wiring-verify.cjs`、`scripts/testing/mrb-verify.cjs` | ① **e2e**（进程内真实库）断言响应体 `reinspectionOrderNo` = `{原单号}-R2` 且与库内行 `id` / `order_no` 逐一对齐；② **wiring 走查**（真实库 + 真实 HTTP，第四轮新增第 9 组 5 条断言）自建来源单走完整链路后核对响应与库内复检行（含沿承快照、源单翻 `RE_INSPECTING`），清理挂在成功与异常两条路径上；③ **离线 Mock 走查**在评审抽屉内真实提交一次 `REWORK`（原生 setter + `input`/`change` 事件），断言绿色横幅出现、单号符合 `-R\d+$`，并截图 `mrb-disposition-rework.png` |
| 文档 / 契约规范 | `docs/api/letian-qms-openapi.yaml`、`docs/04-API与导入规范.md` §3.5、`scripts/testing/README.md`、本文件 | 新增 `DisposeMRBResponse` 组件（`allOf: [MRBRecord, {两字段}]`，本 spec 首处复用型组合）并把处置接口 200 响应指向它（`info.version` 2.11.0 -> 2.12.0）；断言数 21 -> 23；截图清单补 `mrb-disposition-rework.png` |

### 11.4 为什么不动数据库

两个新字段都是**读侧回吐**，不是新落库列：`reinspectionOrderId` / `reinspectionOrderNo` 的来源是
`decide-mrb-disposition.ts` 事务内的返回值，实际写入位置是既有的 `inspection_orders`（006 / 008 / 009
起的物理列，沿承口径见 `docs/26` §5.2）。因此**MRB 表不新增列、无迁移脚本**，也就没有回滚动作。

### 11.5 验收结果（2026-09-22）

| 验证 | 命令 / 操作 | 结果 |
|:---|:---|:---|
| 类型检查 | `pnpm typecheck` | ✅ 7/7 包通过 |
| API 全量测试 | `pnpm test` | ✅ 契约 / 端到端 / 委外台账 / 物料权限全绿（含 §2.3.2 新增响应字段断言） |
| 前端 Mock 校验 | `pnpm --filter @letian/web run validate:mocks` | ✅ 18 组契约校验通过 |
| 离线 Mock 走查 | `node scripts/testing/mrb-verify.cjs` | ✅ **23/23 通过**（截图 `scripts/logs/mrb-disposition-rework.png` 可见横幅与 `INS-20231012-0002-R2`；截图前把抽屉滚动容器**直接置底**并按视口截图，日志同时打印 banner 的 `inView` 矩形，版式微调后证据图不会静默失效） |
| 真实库 + 真实 HTTP 打通常驻验收 | `PORT=3101 pnpm --filter @letian/api run dev` + `MRB_WIRING_BASE=http://127.0.0.1:3101/api/v1 node scripts/testing/mrb-wiring-verify.cjs` | ✅ **35/35 通过**（30 + 本轮 5 条）：`REWORK` 响应 `reinspectionOrderNo=WIRING-REWORK-INS-…-R2` 与库内复检行 `id` / `order_no` 逐一对齐、`status=PENDING`、`inbound_no` / `specification` / `unit` 逐字段等于原单、源单翻 `RE_INSPECTING`；跑完库回基线 24 单 / 6 MRB / 4 池（1 条待发起）/ 11 追溯边，`WIRING-%`、`PROBE-%` 残留 0 |
| 来料检验走查回归 | `node scripts/testing/inspections-verify.cjs` | ✅ 18/18 通过 |
| 真实 HTTP 探针 | `POST /api/v1/mrb/records/{id}/disposition`（`REWORK`） | ✅ 建单 `201` -> `FAILED` -> 入池 -> 发起评审 `201` -> 处置 `200`：回包 `disposition=REWORK`、`reinspectionOrderId=851aa1ea-…`、`reinspectionOrderNo=PROBE-REI-…-R2`（与 `{原单号}-R2` 完全一致）；源单翻 `RE_INSPECTING`，`GET /inspections?orderNo=PROBE-REI-…` 命中 2 行且 `-R2` 行的 `inboundNo` / `specification` 等于原单（探针行已清理，库回 24 单 / 6 MRB / 4 池 / 11 追溯边） |
| 代码审计 | `node scripts/testing/audit_check.js` | ✅ 通过（`any` 133/138 预算内、`@ts-ignore` 0） |
| OpenAPI 校验 | `node scripts/logs/openapi-check.cjs` | ✅ 24 路径 / 54 ref / 断链 0，YAML 解析 OK |
| 走查截图重跑 | `node scripts/testing/cdp-runner.js`（`:5200` 真实前后端联动） | ✅ **7/7 PASS，未捕获运行时异常 0 条**；`docs/screenshots/` 6 张 PNG 整体重新捕获（`screenshot_04_mrb.png` 等），实测列日期同步为 2026-09-22 |
