# 不合格判定自动发起 MRB 评审设计（取消人工发起闸门）

> **版本**：v1.0.0 ｜ **更新日期**：2026-09-23 ｜ **状态**：已实施
> **变更动因**：客户确认口径 —— 不合格判定后**不需要人工发起环节**，判定不合格即进入 MRB 评审流程。
> **关联文档**：[01-PRD.md](./01-PRD.md) §3.6 ｜ [17-检验录入界面说明与质检方案匹配口径.md](./17-检验录入界面说明与质检方案匹配口径.md) §4/§6 ｜ [19-MRB不合格品处置页整合设计.md](./19-MRB不合格品处置页整合设计.md) ｜ [21-MRB不合格品处置数据字段与接口打通设计.md](./21-MRB不合格品处置数据字段与接口打通设计.md) ｜ [39-不合格判定自动入池与MRB页可见性打通设计.md](./39-不合格判定自动入池与MRB页可见性打通设计.md)

---

## 1. 口径变更

| 维度 | 旧口径（两阶段，`docs/19`/`docs/21`/`docs/39`） | 新口径（本文件） |
|:---|:---|:---|
| 判定不合格后 | 只**自动入池**（`pending_mrb_items.status = PENDING_INITIATE`），MRB 工单**不产生** | **自动入池 + 自动生成 MRB 评审单**，同事务提交，工单直接进入 `PENDING_REVIEW` |
| 发起评审 | 质检主管在页内抽屉**逐条人工点击【发起评审】**，选用评审流程与紧急程度 | **无人工发起环节**：评审流程按不合格来源类型（`INCOMING_FAIL` 等）**自动绑定生效流程**，紧急程度默认 `NORMAL` |
| 检验单状态 | 判不合格停留在 `FAILED`，发起后才转 `IN_MRB_REVIEW` | 判不合格当次事务内即转 `IN_MRB_REVIEW` |
| 待审核池定位 | 人工发起的**工作队列**（页面主入口之一） | 不合格品**全量留痕台账**（只读，不再承载人工动作；条目落 `INITIATED` 并回填 `mrb_review_id`） |
| 拟定处置 | 由发起人选择 | 由检验员终判口径映射（见 §4.4），缺省 `REWORK` |

**不变的链路**：MRB 多级会签（`PENDING_REVIEW → UNDER_REVIEW → DISPOSED / REJECTED`）、四类处置决策（退货 / 返工 / 特采 / 报废）、特采客户书面签核闸门、返工自动派生复检轮次、批次放行关卡 `GATE_UNDER_MRB`、PBAC 三维行级权限与审计留痕，全部一字不改。

---

## 2. 改造后的完整链路

```text
IQC / IPQC / 委外 / OQC 检验员终判不合格
        │
        ▼  同一事务（一个 PostgreSQL 事务，要么全成立要么全回滚）
  ① 检验单状态与结论落库（FAILED + 数量 + 终判时间 + 备注）
  ② 不合格汇入留痕台账 pending_mrb_items（幂等 upsert）
  ③ 追溯节点登记（docs/41，节点状态仍取终判态，口径不变）
  ④ 自动创建 MRB 评审单并绑定生效评审流程（本文件 §4）
  ⑤ 台账条目转 INITIATED + 回填 mrb_review_id
  ⑥ 检验单转 IN_MRB_REVIEW
  ⑦ Outbox 事件 MRBReviewTriggered + 审计留痕
        │
        ▼
  MRB 不合格品处置页「待评审」页签直接可见 → 会签 → 处置 → 闭环
```

页面侧：MRB 列表**无需任何人工发起动作**即可看到新记录；页头【+ 发起评审】按钮与「待发起评审 N 条」胶囊**移除**（无人工发起逻辑），页头副标题改为说明「判定不合格自动进入评审流程」。

---

## 3. 改造清单（分层）

| 层 | 文件 | 改造内容 |
|:---|:---|:---|
| 契约 | `packages/contracts/src/schemas/inspection.ts` | `FinalizeInspectionStatusRequestSchema` 新增可选 `preliminaryDisposition`（拟定处置，受 `MRBDispositionEnum` 约束），供终判表单表达检验员的处置意图 |
| 用例 | `packages/application/src/use-cases/mrb/trigger-mrb-review.ts` | 抽出 `executeInTransaction(ctx, cmd, securityCtx)`：允许调用方**复用已有事务上下文**（此前只有 `execute()`，内部自开事务，嵌套调用会另起连接，事务与咨询锁都会失效） |
| 用例 | `packages/application/src/use-cases/mrb/auto-initiate-mrb-review.ts`（新增） | 自动发起唯一入口：前置条件校验 → 幂等查重 → 委托 `TriggerMrbReviewUseCase` → 回填台账条目 `INITIATED` |
| 用例 | `packages/application/src/use-cases/inspections/finalize-inspection-status.ts` | 入池后同事务调用 `autoInitiateMrbReview`；返回值改为**回读后的最终单据**（状态 `IN_MRB_REVIEW`） |
| 用例 | `packages/application/src/use-cases/inspections/record-measurements-and-judge.ts` | 同上（该路径此前也会入池，若不补自动发起会留下永远无人发起的孤儿条目） |
| 前端 | `apps/web/src/pages/mrb/index.tsx` | 移除页头【+ 发起评审】按钮、待发起计数胶囊与 `InitiateReviewDrawer` 挂载；副标题改为自动进入评审的口径说明 |
| 前端 | `apps/web/src/pages/mrb/InitiateReviewDrawer.tsx` | **删除**（人工发起抽屉不再是产品能力） |
| 前端 | `apps/web/src/pages/inspections/components/IqcRecordForm.tsx`、`OqcRecordForm.tsx` | 终判请求带上拟定处置；回执文案说明已自动进入 MRB 评审 |
| 测试 | `apps/api/test/integration/inspection-finalize-pool-link.test.ts` | 断言从「入池」升级为「入池 + 自动建 MRB + 检验单 IN_MRB_REVIEW + 台账转 INITIATED」 |
| 测试 | `apps/api/test/integration/e2e.test.ts` | 2.3 段落同步升级：判定不合格的**返回体与落库状态**改为 `IN_MRB_REVIEW`（综合结论仍为 `FAILED`）；旧「待审核池查询 + 人工发起评审闭环」区块改为「自动建单 + 台账 `INITIATED` + 回填 MRB 单」；并新增**保留接口的边界**（§4.6）：已在评审中的单再调 `POST /mrb/pending-pool/initiate` 必须 **409**，且 MRB 单仍为 1 张 |

---

## 4. 关键设计决策

1. **同一事务**：发起 MRB 与终判、入池、追溯节点、审计必须在一个事务内完成。因此自动发起走 `executeInTransaction(ctx, ...)`，**不得**再调用会自开事务的 `execute()`（嵌套事务会另取连接，既破坏原子性，也会与 `pg_advisory_xact_lock` 批次锁形成死锁风险）。
2. **幂等**：以 `mrb_reviews.source_order_no` 为天然键 —— 同一检验单重复终判（含网络重试）复用既有 MRB 单，不产生第二张工单；台账回填同样幂等。已处于 `IN_MRB_REVIEW` 的在途单不被回改。
3. **流程绑定**：按来源类型自动匹配生效流程（`reviewFlows.findApplicableFlow(sourceType)`）。映射口径的**唯一实现**是契约层 `inspectionTypeToFailCategory()`（与 `INSPECTION_GROUPS` 同源；逐环节对照表见 `docs/44-过程委外出货不合格自动进MRB口径补齐设计.md` §1）：`IQC → INCOMING_FAIL`、`IPQC_CT / IPQC_RL / IPQC_FN → PROCESS_FAIL`、`OQC_SH → SHIPMENT_FAIL`、委外八类（`OQC_SF` / `OQC_HEAT` / `OQC_BLACK` / `OQC_ZINC` / `OQC_NICKEL` / `OQC_PHOSPH` / `OQC_DACRO` / `OQC_MACH`）→ `SUBCONTRACT_FAIL`（改造前只做精确值匹配，委外与出货都被错绑到过程流程，见 `docs/44` §2）。库内无生效流程时**不阻断终判**：仍建单并落 `PENDING_REVIEW`（首审角色回退 `QUALITY_MANAGER`），避免"没配流程就不能判不合格"这种把质量判定卡死的降级。
4. **拟定处置映射**（决定列表「处置方式」列初值，终审时由处置决策覆盖）：
   - 来料检验「✕ 不合格退货」→ `RETURN_TO_VENDOR`；「让步接收」→ `CONCESSION`（最终放行仍需 MRB 会签 + 客户书面签核）；
   - 出货检验「特采」→ `CONCESSION`；其余环节缺省 `REWORK`。
5. **不合并不写池**：台账条目仍然写入（不合格品全量留痕、追溯来源、PBAC 供应商维度换算都依赖它），只是**不再停留在 `PENDING_INITIATE`**。
6. **保留接口**：`GET /mrb/pending-pool`、`POST /mrb/pending-pool/initiate` 与 `POST /mrb/records` 保留（历史数据与外部集成可继续读写，补发起仍可用），但**页面不再暴露发起入口**，正常链路下不会出现 `PENDING_INITIATE` 条目。
7. **复用即对账**（2026-09-23 补，详见 `docs/21` §14）：「不合格数量」的唯一口径是源检验单 `fail_qty`
   （= 检验员在录入弹窗填写的不合格数），但**建单与填写值落地分属两次调用** —— 录入弹窗先
   `submit-measurements`（判定即建单）、后 `POST /status`（写数量），建单那一刻读到的可能是领域派生兜底值
   （首次判定时 `failQty = sampleQty - passQty - exemptQty` 恒等于整批抽样数，即页面上的「检测数」）。
   因此**复用既有单据时必须按源单 `fail_qty` 对齐**（`alignMrbDefectQtyWithSourceOrder()`），且**两个复用入口都要走**：
   `triggerMrbReviewInTransaction` 自身的幂等分支 + `autoInitiateMrbReview` 的「先查后建」分支
   （终判 / 录入用例的实际入口，漏掉它订正就不会发生）。源单 `fail_qty = 0` 视为检验员未填写 -> 保留现值，不回退成 0。

---

## 5. 兼容性与影响面

- **历史数据**：库内既有 `PENDING_INITIATE` 条目不受影响，仍可在接口层发起；页面不再显示「待发起」入口后，如需批量收口由运维按 `docs/21` §5 口径处理。
- **KPI 口径**：MRB 页 5 项 KPI 全部来自 `mrb_reviews`，自动建单后「待评审」计数自然覆盖判不合格单据，无需页面口径改动；`pendingPoolCount` 字段保留（正常链路恒为 0）。
- **权限**：自动发起复用终判调用者的安全上下文（三维 PBAC 已在终判处通过），不放大可见范围；MRB 列表/池的 PBAC 规则不变。
- **审计**：终判审计新增 `mrbAutoTriggered` / `mrbReviewNo` 两个字段，让「判不合格却没进评审」在日志里一眼可判。

---

## 6. 验证

| 手段 | 结果 |
|:---|:---|
| `pnpm -r run typecheck` | ✅ 退出码 0（2026-09-23 实测，7 个包全过） |
| `pnpm --filter @letian/api test`（含 `inspection-finalize-pool-link.test.ts` 升级断言 + `e2e.test.ts` 同步断言） | ✅ 退出码 0（2026-09-23 实测）：`inspection-finalize-pool-link.test.ts` 逐条通过（终判不合格 → 同事务入池 + 自动建 MRB + 台账 `INITIATED` + 回填 `mrb_review_id`；重复终判幂等仍各 1 条；合格终判不入池不建单；三维权限 fail-closed 未被放大）；`e2e.test.ts` 新增一行证据 `✔ 判定不合格：台账转 INITIATED 并回填 MRB-…；重复人工发起被 409 拒绝且 MRB 单仍为 1 张`。`pnpm -r run test` 全仓退出码 0 |
| 真实 HTTP 探针：判定不合格 → `GET /mrb/records?status=PENDING_REVIEW` 命中新单 | ✅ **真实库 + 真实 HTTP**（另起独立实例 `:41100`，不打扰常驻 `:3100`；2026-09-23 实测）：建 IQC 单 `INS-20260923-0107`（`PENDING`）→ 录 `DIA-001 = 6.02`（超上限）走 `POST /inspections/{id}/submit-measurements` → 返回 **`status = IN_MRB_REVIEW`** / `overallDecision = FAILED`；`GET /mrb/records?status=PENDING_REVIEW` **命中新单** `MRB-1790139827729-830`（`sourceType = INCOMING_FAIL`、未传拟定处置时缺省 `REWORK`，符合 §4.4）；`GET /mrb/pending-pool` 该单条目 `status = INITIATED` 且 `mrbId` 已回填。探针单据 / MRB 单 / 台账条目均已清理（`inspection_orders` / `mrb_reviews` / `pending_mrb_items` 各剩 0 行） |
| `node scripts/testing/mrb-wiring-verify.cjs`（独立实例 `:3101`，不打扰常驻 `:3100`） | ✅ **35/35 PASS**（2026-09-23 实测）：返工链路自建单 → 越界判定 → `status = IN_MRB_REVIEW` 且自动建单命中 `PENDING_REVIEW` → `REWORK` 处置回吐复检单 `…-R2` 并逐字段落库；台账条目 `INITIATED` + `mrb_review_id` / `pending_defect_id` 双向回填；`review_flow_id` / `urgency_level` / `review_notes` 落库；会签 → 特采缺客户凭证 400 → 携凭证处置返回裸 `MRBRecord` |
| `pnpm --filter @letian/web run build` + `validate:mocks` | ✅ 退出码 0；离线 mock 场景校验 20/20（演示态同样自动建单，见 §3 前端行） |
| 用例 / 脚本自清理加固（本次同步修复） | ✅ 终判自动建单后，凡「建单 → 判不合格 → 删单」的用例与探针都必须连 MRB 一起回收，否则留下「源单已删」的孤儿评审工单（派生检验人为空、列表可见但点不开处置）。已在 `apps/api/test/integration/trace-node-registration.test.ts`、`scripts/testing/ipqc-ledger-verify.cjs`（单条 + 批量两处）补齐按单号回溯删除 `mrb_reviews`；`scripts/testing/mrb-wiring-verify.cjs` 的「列表回吐派生检验人」断言由「赌列表前 5 条」改为与库内可回溯工单逐条对齐（避免被历史遗留行误伤）。加固后复核：`mrb_reviews` 孤儿行 = 0，库内恢复 6 条演示工单 |

---

## 7. 变更记录

| 日期 | 版本 | 说明 |
|:---|:---|:---|
| 2026-09-23 | v1.1.0 | 补 §4.7「复用即对账」：复用既有 MRB 单时把「不合格数量」对齐源单 `fail_qty`。旧时序（先建单、后落填写值）会把建单那一刻的派生兜底值（= 抽样数/检测数）固化进单据，客户实测即为此现象（`docs/21` §14）。回归 `apps/api/test/integration/mrb-defect-qty-parity.test.ts`。 |
| 2026-09-23 | v1.0.0 | 首次定稿并实施：取消人工发起闸门，判定不合格即同事务自动创建 MRB 评审单并转 `IN_MRB_REVIEW`；台账条目转 `INITIATED`；前端移除发起抽屉。 |
| 2026-09-23 | v1.0.1 | 补齐验证证据（`pnpm -r run typecheck` / `pnpm -r run test` / web 构建 + mock 校验 / `mrb-wiring-verify` 35/35）；同步加固用例与探针的 MRB 回收（`trace-node-registration.test.ts`、`ipqc-ledger-verify.cjs` 两处），并把「列表回吐派生检验人」断言改为与库内可回溯工单对齐；清理库内 7 条历史遗留的孤儿评审工单。 |
