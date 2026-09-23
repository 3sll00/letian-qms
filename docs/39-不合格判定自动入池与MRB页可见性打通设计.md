# 不合格判定自动入池与 MRB 页可见性打通设计

> **版本**：v1.0.1 ｜ **更新日期**：2026-09-23 ｜ **状态**：已实施并实测验证（§5）
> **触发来源**：用户实测反馈 ——「【来料检验】把 INS-20231013-0001 判为不合格后，在【MRB不合格品处置】里看不到记录」
> **关联文档**：[01-PRD.md](./01-PRD.md) §3.6/§3.7 ｜ [17-检验录入界面说明与质检方案匹配口径.md](./17-检验录入界面说明与质检方案匹配口径.md) §4 ｜ [19-MRB不合格品处置页整合设计.md](./19-MRB不合格品处置页整合设计.md) ｜ [21-MRB不合格品处置数据字段与接口打通设计.md](./21-MRB不合格品处置数据字段与接口打通设计.md)

> **⚠️ 部分口径已被 `43-不合格判定自动发起MRB评审设计.md` 取代（2026-09-23）**：客户确认「不合格判定后不需要人工发起环节」，
> 本文档 §4 第 5 条「两阶段不变（人工逐条发起）」与 §2 D3 的「待发起评审胶囊 / 按钮角标」已废止；
> 现在判定不合格即**同事务自动创建 MRB 评审单**，页面无人工发起入口。本文档其余内容（D1 终判入池、D2/D4 供应商维度换算、
> 事务边界与幂等、兜底文案）**继续有效**。

---

## 1. 问题现象与复现

用户路径：打开【来料检验】→ 进入检验单 `INS-20231013-0001` 录入表单 → 填入 4 项实测值（`直径 = 5.03mm` 超差）→ 判定「退货」→ 提交 → 返回【MRB不合格品处置】页面，**该单在页面上看不到任何记录**。

真实库 + 真实 HTTP 复现（2026-09-23）：

| 复现动作 | 实测结果 | 结论 |
|:---|:---|:---|
| 用户路径 ①（录入实测值后提交） | 库内 `pending_mrb_items` 生成 `INS-20231013-0001` 行（`status = PENDING_INITIATE`） | 该路径**入池正常** |
| 复现路径 ②：建单 → `POST /inspections/{id}/status {status:'FAILED'}` | 检验单 `status = FAILED` / `judgment = FAILED`，`pending_mrb_items` **无任何行** | **终判路径不入池（断链）** |
| 页面读侧：`GET /mrb/records` | 只回吐 `mrb_reviews`，待发起池条目**不在其中**；`pendingCount` KPI 也只统计 `mrb_reviews` | 池条目在页面上**没有计数入口**，只能靠「+ 发起评审」抽屉才发现 |
| 权限对比：`GET /mrb/pending-pool`（陈静 · IQC检验员） | `total = 0`，但同一用户在 `GET /inspections?type=IQC` 能看到该单 | 池读侧 PBAC **供应商维度被整条跳过**（fail-closed 误伤） |

---

## 2. 根因（四条断链）

| # | 断链点 | 根因 | 影响面 |
|:---:|:---|:---|:---|
| **D1** | 终判写路径不入池 | `POST /inspections/:id/status` 在控制器里**直接调读侧仓储**（`orders.updateStatus` + `orders.updateStatsAndVerdict`），绕过了用例层与 `collectPendingDefect`；而「自动入池」只写在 `RecordMeasurementsAndJudgeUseCase`（`submit-measurements`）里 | 四个录入表单（IQC / IPQC / 委外 / OQC）的**终判**都走 `/status`：整批判退、让步/特采申请、未录满实测值（草稿）后再终判……这些单**全部不会入池**，MRB 页永远看不到 |
| **D2** | 池读侧 PBAC 供应商维度失效 | 池表无 `supplier_code` 列，翻译器对「限定供应商」的规则**整条 `continue` 跳过**（`hasSupplierColumn:false`）→ 该用户池内可见行 = 0 | 检验员账号（如 `陈静`：分类 + 编码 + 供应商三维限定）在台账能看到单据，却在池里看不到自己判不合格的单 |
| **D3** | 页面无「待发起」计数入口 | `GET /mrb/records` 的 5 项 KPI 全部来自 `mrb_reviews`；池条目不进列表也不进 KPI，【+ 发起评审】按钮上没有数量角标 | 判不合格后页面「看起来什么都没有」，用户无法判断是「没入池」还是「入池了但要发起评审」 |
| **D4** | MRB 处置列表同 D2 | `mrb_reviews` 亦无 `supplier_code` 列，翻译器同样整条跳过供应商维度 | 检验员发起评审后，**自己发起的 MRB 单在处置列表里也看不到** |

> 口径依据（文档最高权威）：`docs/01-PRD.md` §3.7「IQC / IPQC / 委外检验 / OQC 判定不合格的记录，**全量自动汇总**至『不合格待审核池』」；
> `docs/17` §4「不合格只**自动入池**，评审必须由人工**逐条发起**」——因此本次**不改**两阶段机制，只把「自动入池」补全、把「看得见」补上。

---

## 3. 改造方案（分层）

| 层 | 文件 | 改造内容 |
|:---|:---|:---|
| 契约 | `packages/contracts/src/schemas/inspection.ts` | 新增 `FinalizeInspectionStatusRequestSchema`（`status` 必填且受 `InspectionStatusEnum` 约束，`judgment / passQty / failQty / sampleQty / remark / inspectionNotes` 可选）；`packages/contracts/src/schemas/mrb.ts` 的 `PaginatedMRBRecordsSchema` 增 `pendingPoolCount` |
| 端口 | `packages/domain/src/ports/repositories.ts` | `InspectionOrderRepository` 增 `updateStatsAndVerdict`（此前只有实现类有、端口没有，控制器只能拿读侧仓储硬写） |
| 用例 | `packages/application/src/use-cases/inspections/finalize-inspection-status.ts`（新增） | 终判唯一写入口：同一事务内 `updateStatus` → `updateStatsAndVerdict` → 回读单据 → **判不合格即 `collectPendingDefect` 入池** → 审计留痕 |
| 用例 | `packages/application/src/use-cases/mrb/collect-pending-defect.ts` | `buildPendingDefectDraft` 增可选 `fallbackReason`：备注为空且无超差项时用**如实描述**（「检验判定不合格（未录入具体超差项）」），不再写「实测超出公差判定不合格」这类与事实不符的兜底文案 |
| 仓储 | `packages/infrastructure/src/repositories/pbac-sql-translator.ts` | `PbacWhereOptions` 增 `supplierCodeExpr`：允许无 `supplier_code` 列的业务表**经关联子查询**提供供应商上下文（默认仍取 `${targetRef}.supplier_code`）；`hasSupplierColumn:false` 且未给表达式时维持原 fail-closed 语义 |
| 仓储 | `.../repositories/pending-defect-pool-repository.ts` | 池查询改传 `supplierCodeExpr` = 源检验单 `inspection_orders.supplier_code`（按 `source_order_id` 关联） |
| 仓储 | `.../repositories/mrb-review-repository.ts` | MRB 列表同法：`supplierCodeExpr` = 源检验单 `supplier_code`（按 `source_order_no = order_no` 关联） |
| 接口 | `apps/api/src/controllers/inspections.controller.ts` | `POST /:id/status` 改为经 `useCases.finalizeInspectionStatus`（请求体走契约校验），保留原响应形态（回吐更新后的检验单） |
| 接口 | `apps/api/src/controllers/mrb.controller.ts` | `GET /mrb/records` 返回值增 `pendingPoolCount`（当前用户 PBAC 过滤后的池内 `PENDING_INITIATE` 条数） |
| 前端 | `apps/web/src/pages/mrb/index.tsx` | 【+ 发起评审】按钮渲染待发起数量角标（>0 时高亮），并在页头给出「不合格待审核池有 N 条待发起评审」的提示行——判不合格后**一眼可见**有记录待处理 |
| 前端 | `apps/web/src/mocks/handlers.ts` | 离线 Mock 同步 `pendingPoolCount`（与接口同名同义） |

---

## 4. 口径定义（定稿）

1. **「判为不合格」判定式**（唯一口径）：终判后 `inspection_orders.status = 'FAILED'` **或** `judgment = 'FAILED'`。
   - 覆盖 IQC「退货」、委外「不合格」、OQC「特采（转 MRB 评审）」、IPQC 快速终判「不合格」四种表单口径；
   - `RE_INSPECTING`（返工回边）与 `COMPLETED`（结单）**不触发**入池：前者由 MRB 返工处置回流，后者是归档终态。
2. **同事务**：状态写入与入池必须在同一事务提交（要么都成立、要么都回滚），与 `submit-measurements` 口径一致。
3. **幂等**：入池由 `pending_mrb_items.source_order_id` 唯一键 upsert（迁移 018），重复终判不产生重复条目；已发起评审（`INITIATED`）的条目**不被回改**。
4. **审计**：终判写入审计日志（`STATUS_CHANGE` / `INSPECTION_ORDER`），补上此前 `/status` 无审计留痕的空缺。
5. ~~**两阶段不变**：不合格只**自动入池**，MRB 评审工单仍由质检主管在页面【+ 发起评审】逐条发起~~ **已于 2026-09-23 废止，改为自动发起（`docs/43`）**。
6. **供应商维度换算**：池表 / MRB 表均无供应商编码列，供应商维度统一**经源检验单**（池按 `source_order_id`、MRB 按 `source_order_no = order_no`）换算；源单缺失即该规则不匹配（保持 fail-closed，不放大可见范围）。

---

## 5. 验证

| 手段 | 结果 |
|:---|:---|
| `pnpm -r run typecheck` | ✅ **7/7 包通过**（2026-09-23 实测） |
| `pnpm --filter @letian/api test` | ✅ 全绿，含本轮新增回归用例 `apps/api/test/integration/inspection-finalize-pool-link.test.ts`（7 组断言，已登记进 `apps/api/package.json` 的 `test` 脚本） |
| `pnpm --filter @letian/infrastructure test`、`pnpm --filter @letian/web test` | ✅ 全绿（PBAC 翻译器新用例随 infrastructure 包执行） |
| PBAC 翻译器单测（`packages/infrastructure/src/__tests__/pbac-translator.test.ts`） | ✅ 新增「无供应商列 + 传 `supplierCodeExpr`」用例：断言生成供应商 `IN` 子查询（编译后 SQL 含 `src.supplier_code … IS NOT NULL … IN ($1)`）**而非** `1 = 0` |
| 真实 HTTP 探针（真实 PostgreSQL + 临时进程 `PORT=3121`，不占用户常驻端口） | ✅ 建单 → `POST /inspections/{id}/status {status:'FAILED'}` → `GET /mrb/pending-pool` 命中该单（含供应商快照与 `fail_reason` = 终判备注）→ `pendingPoolCount` 同步 +1 → 重复终判仍为 1 条（幂等）→ 清理 |
| 真实权限探针（同库双账号对比） | ✅ `陈静`（分类 + 编码 + 供应商三维限定）`GET /mrb/pending-pool` 能命中其可见范围内的池条目（**修复前 = 0 行**）；`刘芳`（无该维度）不命中。旁证：同库 `:3100` 旧代码实例上陈静池 `total = 0`，`:3121` 新代码上 `total = 1` |
| 真实前后端浏览器走查（临时 Vite `VITE_API_TARGET=http://127.0.0.1:3121` + CDP 驱动 Chromium） | ✅ 页头显示「待发起评审 2 条」、主按钮文案带数量角标「发起评审 2」、抽屉内可见已判不合格单（不良率 100%、不合格描述「检验判定不合格（未录入具体超差项）」、供应商「江苏大明不锈钢特钢有限公司」），控制台异常 0 条；截图 `logs/ui-probe-01-mrb-header.png`、`logs/ui-probe-02-pool-drawer.png` |
| 库回基线 | ✅ 探针单 / 池条目 / MRB 单全部清理：`pending_mrb_items` 6 -> 4、`mrb_reviews` 7 -> 6、`inspection_orders` 中 `INS-20260923-%` 残留 0（`audit_logs` 是 append-only 红线，5 条探针审计按设计**保留**） |

---

## 6. 变更记录

| 日期 | 版本 | 说明 |
|:---|:---|:---|
| 2026-09-23 | v1.0.0 | 首次定稿并实施：补齐终判入池（D1）、池与 MRB 列表的供应商维度换算（D2/D4）、页面待发起计数（D3） |
| 2026-09-23 | v1.0.1 | §5 回填实测结果（类型检查 / 三包测试 / PBAC 单测 / 真实 HTTP 与双账号权限探针 / 真实前后端浏览器走查 / 库回基线）；新增 §7 遗留项 |
| 2026-09-23 | v1.0.2 | **口径部分废止**：客户确认「不合格判定后不需要人工发起环节」，本文档 §4 第 5 条与 §2 D3 的相关口径改由 `43-不合格判定自动发起MRB评审设计.md` 取代（判定不合格即同事务自动建 MRB 单）；D1 终判入池、D2/D4 供应商维度换算与事务 / 幂等口径继续有效 |

---

## 7. 遗留与后续（本轮未做）

| # | 项 | 说明 |
|:---:|:---|:---|
| **R1** | UI 断言未固化 | 本轮的浏览器走查用的是**一次性探针**（跑完即删），页头计数与抽屉内容尚未固化为 `scripts/testing/` 下的常驻渲染级走查（同 `mrb-verify.cjs` 那种断言数入册的形式）。后续建议并入 `mrb-verify.cjs` 或新增 `mrb-pool-verify.cjs`，并登记进 `scripts/testing/README.md` 的断言与截图清单 |
| **R2** | 前端四个录入表单未改 | 故意不动：终判已收敛到 `POST /inspections/{id}/status` 唯一写入口，四个表单（IQC 退货、委外不合格、OQC 特采、IPQC 快速终判）**无需改造**；若日后新增终判入口，必须同样走该用例，不得直连仓储 |
| **R3** | ~~池条目仍不进处置列表~~ **已随 `docs/43` 消解** | 原两阶段设计使然（池 = 待发起，列表 = 已发起）。自动发起后台账条目即时转 `INITIATED` 并与 MRB 单一一对应，页面不再需要靠 `pendingPoolCount` 与抽屉暴露 |
| **R4** | 兜底文案统一 | `fail_reason` 在「无备注 + 无超差项」时写「检验判定不合格（未录入具体超差项）」。历史种子/存量行中仍存在旧文案「实测超出公差判定不合格」，如需统一需一次数据订正（本轮未做，避免动历史证据） |
