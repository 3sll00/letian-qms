# 过程 / 委外 / 出货检验「判定不合格即进 MRB」口径补齐设计（四环节统一）

> **版本**：v1.0.0 ｜ **更新日期**：2026-09-23 ｜ **状态**：已实施
> **变更动因**：客户要求【过程检验】【委外检验】【出货检验】与【来料检验】一致 —— 判定不合格后**直接进入 MRB 不合格品处置**，
> 不得停在「不合格」等人工动作。
> **关联文档**：[43-不合格判定自动发起MRB评审设计.md](./43-不合格判定自动发起MRB评审设计.md)（自动发起机制本体）｜
> [19-MRB不合格品处置页整合设计.md](./19-MRB不合格品处置页整合设计.md) ｜ [21-MRB不合格品处置数据字段与接口打通设计.md](./21-MRB不合格品处置数据字段与接口打通设计.md) ｜
> [29-过程检验下料检验台账字段与接口打通设计.md](./29-过程检验下料检验台账字段与接口打通设计.md) ｜ [30-过程检验滚丝与成品检台账字段与接口打通设计.md](./30-过程检验滚丝与成品检台账字段与接口打通设计.md) ｜
> [36-委外检验数据字段与数据库接口对接核查设计.md](./36-委外检验数据字段与数据库接口对接核查设计.md) ｜ [37-出货检验族级分类通用方案补齐设计（市面QMS口径）.md](./37-出货检验族级分类通用方案补齐设计（市面QMS口径）.md)

---

## 1. 口径

| 检验环节 | 检验类型（契约 `InspectionTypeEnum`） | 不合格来源分类（`MRBFailCategoryEnum`） | 自动绑定的评审流程（`review_flows.applicable_type`） |
|:---|:---|:---|:---|
| 来料检验 | `IQC` | `INCOMING_FAIL` | `FLOW-IQC-FAIL` |
| 过程检验 | `IPQC_CT` 下料 / `IPQC_RL` 滚丝 / `IPQC_FN` 成品检 | `PROCESS_FAIL` | `FLOW-PROCESS-FAIL` |
| 委外加工（通用表面处理 + 七分类） | `OQC_SF` / `OQC_HEAT` / `OQC_BLACK` / `OQC_ZINC` / `OQC_NICKEL` / `OQC_PHOSPH` / `OQC_DACRO` / `OQC_MACH` | `SUBCONTRACT_FAIL` | `FLOW-SUBCONTRACT-FAIL` |
| 出货检验 | `OQC_SH` | `SHIPMENT_FAIL` | `FLOW-SHIPMENT-FAIL` |

- 四个环节**共用同一条写路径**（`POST /inspections/:id/status` 终判 / `POST /inspections/:id/submit-measurements` 录值判定）：
  判定不合格时在**同一事务**内入池 + 自动建 MRB 单（机制见 docs/43），**没有人工发起环节**；检验单当次转 `IN_MRB_REVIEW`。
- 映射口径的**唯一实现**：`@letian/contracts` 的 `inspectionTypeToFailCategory()`（与 `INSPECTION_GROUPS` 同源）。
  后端不再各自写精确匹配，前端 mock（离线演示）复用同一函数，杜绝三处口径漂移。
- 兼容别名：`FQC*` / `SHIPMENT*` → `SHIPMENT_FAIL`；`OUTSOURCE*` / `SUBCONTRACT*` → `SUBCONTRACT_FAIL`。
- 兜底：未知 / 新增环节一律回落 `PROCESS_FAIL`（宁可落到过程流程这条可视分支，也不静默放行）；库内该来源无生效流程时
  **不阻断终判**（仍建单、落 `PENDING_REVIEW`，首审角色回落 `QUALITY_MANAGER`，见 docs/43 §4.3）。

---

## 2. 改造前的问题

| 位置 | 现象 | 影响 |
|:---|:---|:---|
| `packages/application/src/use-cases/mrb/trigger-mrb-review.ts` 的 `mapOrderStageToSourceType` | 只做**精确值**匹配 `IQC / IPQC / OQC / FQC / OUTSOURCE`，其余一律回落 `PROCESS_FAIL` | 委外八类（`OQC_SF` / `OQC_HEAT` … `OQC_MACH`）与出货（`OQC_SH`）的自动建单都被判成「过程不合格」，绑定到 `FLOW-PROCESS-FAIL` —— 会签角色与节点层级全错 |
| `apps/web/src/mocks/handlers.ts` 的 `failCategoryOfInspectionType` | 与后端实现不一致（`OQC_SH` 归入委外、`SHIPMENT` 走精确值分支） | 离线演示分类 ≠ 真实后端分类 |
| 过程检验台账（`IpqcViews.tsx`） | 快速终判 / 批量检视判不合格后只回执「已判定不合格」，不提示已进 MRB，也没有处置建议 | 检验员不知道后续在哪看；自动建单缺处置意图初值 |
| 委外录入页（`OutsourceInspectionForm.tsx`） | 不合格终判不带拟定处置、回执不提 MRB | 同上 |

> 说明：自动建单本身在 docs/43 已对**所有**终判失效单生效，因此本设计的主体不是「新增建单」，而是**分类 / 流程绑定纠错 + 三类界面口径补齐**。

---

## 3. 改造清单（分层）

| 层 | 文件 | 改动 |
|:---|:---|:---|
| 契约（唯一口径） | `packages/contracts/src/schemas/inspection-groups.ts` | 新增 `inspectionTypeToFailCategory(inspectionType)`：按 `INSPECTION_GROUPS` 分组映射 + 历史别名兼容 + 未知回落 `PROCESS_FAIL` |
| 应用层 | `packages/application/src/use-cases/mrb/trigger-mrb-review.ts` | 删除私有精确匹配函数，改用契约函数；显式传入的 `sourceType` 仍然优先（人工发起路径不变） |
| 前端 mock | `apps/web/src/mocks/handlers.ts` | 删除本地映射函数，复用契约函数，保证离线演示与后端同口径 |
| 过程检验台账 | `apps/web/src/pages/inspections/components/IpqcViews.tsx` | ① 快速终判：判不合格时新增「处置建议」（返工返修 / 让步接收 / 报废，缺省返工返修）随终判下发 `preliminaryDisposition`；判定成功后绿色回执提示「已自动发起 MRB 评审」；② 批量检视：不合格批次同样带处置建议，结果提示追加「已自动发起 MRB 评审」 |
| 委外录入页 | `apps/web/src/pages/inspections/components/OutsourceInspectionForm.tsx` | 判定「不合格」时新增「处置建议」（退货 / 让步接收 / 返工返修 / 报废，缺省退货）→ `preliminaryDisposition`；回执追加「已自动发起 MRB 评审，请到【MRB不合格品处置】查看」 |
| 出货录入页 | `apps/web/src/pages/inspections/components/OqcRecordForm.tsx` | 已具备（特采 → `CONCESSION` + 回执提及自动建单），本次仅核对口径一致，不改行为 |

**不改的部分（红线）**：MRB 多级会签与四类处置（退货 / 返工 / 特采 / 报废）、特采客户书面签核凭证闸门、返工派生复检单
（`{原单号}-R{轮次}`）、放行闸门（`release-gates` 已同时识别 `FAILED` 与 `IN_MRB_REVIEW`）、PBAC 三维规则、审计字段形态。

---

## 4. 关键设计决策

1. **分类映射落在契约层**：该分类既被后端（建单 / 流程路由）使用，也被前端 mock（离线演示）使用；放 `@letian/contracts` 才能一处定义两处复用，
   并与「七分类」`INSPECTION_GROUPS` 同源，避免把委外八类再抄一遍。
2. **未知类型回落 `PROCESS_FAIL` 而非抛错**：终判是现场写路径，不能因为「新增一个检验类型」把质量判定卡死；回落分支在本文档与断言中显式声明。
3. **处置建议只是初值**：`preliminaryDisposition` 落 `mrb_reviews.disposition` 初值，终审时由处置决策覆盖（docs/43 §4.4）。
   检验员无权替客户下特采结论 —— 特采仍需 MRB 会签 + 客户书面签核凭证。
4. **委外录入页的「返工」与 MRB 无关**：该页原有的「返工」决策走 `RE_INSPECTING`（退回供应商返工后复检，不建 MRB）；
   只有判「不合格」（`FAILED`）才进 MRB。过程检验台账没有该决策项，判定只有合格 / 不合格 / 检验中三态。

---

## 5. 验证

| # | 手段 | 命令 / 断言 | 结果（2026-09-23 实测） |
|:--|:---|:---|:---|
| 1 | 契约层映射（后端与 mock 同源，编译期守门） | `pnpm -r run typecheck` | ✅ **7/7** 工作区通过（contracts / application / infrastructure / api / web 等） |
| 2 | 逐环节自动建单 + 流程绑定（**真实库**） | `pnpm -r run test` → `apps/api/test/integration/inspection-finalize-pool-link.test.ts` §7 | ✅ 新增 4 组环节断言全绿：`IPQC_CT`→`PROCESS_FAIL` / `FLOW-PROCESS-FAIL`、`IPQC_FN`→`PROCESS_FAIL`、`OQC_SH`→`SHIPMENT_FAIL` / `FLOW-SHIPMENT-FAIL`、`OQC_SF`→`SUBCONTRACT_FAIL` / `FLOW-SUBCONTRACT-FAIL`；每组同时断言 `applicableType`、`PENDING_REVIEW`、缺省 `disposition = REWORK`、台账 `INITIATED` + `mrb_review_id`、检验单 `IN_MRB_REVIEW`、MRB 列表可见（用例自建自清） |
| 3 | 端到端（真实 HTTP，独立实例 `:3122`） | `node scripts/testing/mrb-wiring-verify.cjs` | ✅ **38/38 PASS**（含新增 §7.6 的 `IPQC_CT` / `OQC_SH` / `OQC_SF` 三环节：HTTP 终判 → 库内 join 核对来源分类 + 绑定流程 + 台账 / 单据状态） |
| 4 | 前端构建与离线 Mock 守门 | `pnpm --filter @letian/web run build` + `pnpm --filter @letian/web run validate:mocks` | ✅ 构建通过；`validate:mocks` **20/20** |
| 5 | 离线演示与后端同口径 | `apps/web/src/mocks/handlers.ts` | ✅ 本地映射函数已删除，`/inspections/:id/status` 与池内发起两处调用点均改为契约函数 `inspectionTypeToFailCategory()` |

> 反向证明（改造前必失败）：`OQC_SF` 改造前落在 `PROCESS_FAIL` / `FLOW-PROCESS-FAIL`，而本轮断言明确要求 `SUBCONTRACT_FAIL` /
> `FLOW-SUBCONTRACT-FAIL` —— 该断言不可能在旧代码上通过，避免「断言写了但恒真」的假覆盖。

---

## 6. 变更记录

| 日期 | 版本 | 说明 |
|:---|:---|:---|
| 2026-09-23 | v1.0.0 | 首次定稿并实施：契约层统一「检验环节 → 不合格来源分类」映射（委外八类 / 出货纠错），过程检验台账与委外录入页补齐处置建议与自动建单回执。 |
| 2026-09-23 | v1.0.1 | §5 验证表回填实测结果（typecheck 7/7、真实库四组环节断言、独立实例 `mrb-wiring-verify.cjs` 38/38、web build + `validate:mocks` 20/20）；同步面补 `docs/29` §6/§7、`docs/30` §7、`docs/36` §6、`docs/README.md`（索引 44）、`docs/实施进度.md` §44。 |
