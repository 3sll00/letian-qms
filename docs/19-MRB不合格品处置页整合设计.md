# 乐天质量管理系统 (Letian QMS) - MRB 不合格品处置页整合设计

> **版本**：v1.0.0 ｜ **更新日期**：2026-09-21 ｜ **状态**：已定稿并实施
> **原型基准**：`docs/prototypes/WPS图片(13).png`（MRB不合格品处置）、`docs/prototypes/WPS图片(14).png`（评审流程设置）
> **关联文档**：[01-PRD.md](./01-PRD.md) §3.6 ｜ [04-API与导入规范.md](./04-API与导入规范.md) §3.5 ｜ [09-界面与开源组件.md](./09-界面与开源组件.md) §2.5 ｜ [17-检验录入界面说明与质检方案匹配口径.md](./17-检验录入界面说明与质检方案匹配口径.md) §5

---

## 1. 变更动因（为什么要整合）

1. **客户确认基线只有两项**：`docs/requirements/doc_dump.txt` §3.7 与 21 项功能确认清单第 10、11 项，不合格品处置模块只承认 **MRB处置列表** 与 **评审流程设置**（原型 WPS图片(13)/(14)）。
2. **原实现是三项并列**：侧边栏「不合格品处置」下为 `不合格待审核池` / `MRB评审工单` / `评审流程设置`，菜单口径与客户基线不一致。
3. **原「MRB评审工单」页存在真实缺陷**：
   - 会签提交打 `POST /mrb/records/{id}/signatures`——后端**不存在**该路由（仅 MSW mock 有），真机必然 404；
   - 页面**没有处置结论提交入口**，退货/返工/特采/报废四类决策无处落地；
   - 深色皮肤遗留自 initial commit，与全站浅色（WPS 原型）不一致；页内还内嵌了与侧边栏重复的「MRB 评审流程设置」子页签。
4. **整合结论**：两页合并为单页 **「MRB不合格品处置」**；待审核池降级为页内抽屉；评审流程设置保留独立菜单。

---

## 2. 信息架构（菜单口径）

| 分组 | 菜单项 | 导航键 | 承载组件 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| 不合格品处置 | **MRB不合格品处置** | `mrb` | `apps/web/src/pages/mrb/index.tsx` | 新的整合单页（KPI + 筛选 + 3 状态页签 + 处置列表 + 评审处置抽屉） |
| 不合格品处置 | 评审流程设置 | `review-workflow` | `apps/web/src/pages/mrb/ReviewWorkflowView.tsx` | 保持不变（独立菜单，页面内不再重复内嵌） |

- **删除**：`不合格待审核池`（键 `mrb-pending`）独立菜单项；`MRB评审工单` 旧菜单名。
- **角标口径**：`mrb` 菜单角标 = **待评审数**（`GET /mrb/records` 返回的 `pendingCount`）。
- **面包屑**：`不合格品处置 / MRB不合格品处置`（与原型一致）。

---

## 3. 页面结构（自上而下，对齐 WPS图片(13)）

1. **页头**：标题「MRB不合格品处置」+ 副标题「不合格品评审与处置 · 判定不合格自动进入评审」；右侧只有 `导出报表`。

> **已废止（2026-09-23，`docs/43`）**：`docs/39` §2 D3 曾以「待发起评审红色胶囊 +【+ 发起评审】按钮数量角标」暴露池内待发起条目。
> 客户口径确认「不合格判定后不需要人工发起环节」后，判定不合格即**自动创建 MRB 评审单**并进入会签，
> 页面不再有人工发起入口，胶囊、角标与发起抽屉一并移除；`pendingPoolCount` 字段保留但正常链路恒为 0。

2. **5 张 KPI 卡**：待评审 / 评审中 / 已评审 / 已处置 / 本月评审率。
3. **筛选栏**：MRB单号、来源检验单、评审状态（下拉：全部 / 待评审 / 评审中 / 已评审）、处置方式、日期 + `重置` / `查询`。
4. **3 个状态页签**：待评审 / 评审中 / 已评审（默认选中「待评审」，与 `WPS图片(13)` 一致；跨状态检索用筛选栏「评审状态 = 全部」）；
   **2026-09-23**：原「已处置」页签**并入「已评审」**（合并口径见 §4.1），页签行不再单独出现「已处置」。
5. **处置列表（主表格，10 列）**：MRB单号、来源检验单、物料编码、物料名称、不合格原因、不合格数量、检验人、发现日期、评审状态、操作。
6. **分页**：沿用 `page` / `pageSize`，默认 20 条/页。

---

## 4. 状态与 KPI 口径（定稿）

### 4.1 页签 → 状态谓词（2026-09-23 合并后）

| 页签 | 状态谓词 | 说明 |
| :--- | :--- | :--- |
| 待评审 | `status = PENDING_REVIEW` | 已发起、尚未开始会签 |
| 评审中 | `status = UNDER_REVIEW` | 会签流转中 |
| 已评审 | `status IN (DISPOSED, REJECTED)` | 已有评审结论：处置闭环（`DISPOSED`）+ 驳回终止（`REJECTED`） |

> **口径说明（重要，2026-09-23 变更）**：「已评审」与「已处置」原为**包含关系**（`DISPOSED ⊆ DISPOSED + REJECTED`，「已处置」是「已评审」的子集），
> 页签行上因此存在两个集合重叠的入口；现**合并为单个「已评审」页签**。合并后**谓词不变**（仍是 `DISPOSED,REJECTED`）：
> 没有单据被漏掉，且**不改状态机、不加数据库迁移、不改接口契约**（`GET /mrb/records?status=` 仍接受 `DISPOSED,REJECTED` 多值）。
> 单条单据的处置结果改由列表「评审状态」胶囊区分（已处置 emerald / 已驳回 rose）。
> 筛选栏「评审状态」下拉与页签**同源**（`MRB_TABS`），故同步收敛为 全部 / 待评审 / 评审中 / 已评审。
> **口径单点**：`apps/web/src/pages/mrb/mrbMeta.ts` 的 `MRB_TABS`；后端 `totalReviewedCount` 口径见 `packages/infrastructure/src/repositories/mrb-review-repository.ts`（本次未改动）。

### 4.2 KPI 定义

| KPI | 取值 | 来源 |
| :--- | :--- | :--- |
| 待评审 | `pendingCount` | 库内 `status = PENDING_REVIEW` 计数 |
| 评审中 | `underReviewCount` | 库内 `status = UNDER_REVIEW` 计数 |
| 已评审 | `totalReviewedCount` | 评审中 + 已处置 + 已驳回（累计已评审） |
| 已处置 | `disposedCount` | 库内 `status = DISPOSED` 计数（**页签已于 2026-09-23 并入「已评审」，该 KPI 保留**：它是「闭环终态」计数，与累计口径 `totalReviewedCount` 含义不同，两者不可互相替代） |
| 本月评审率 | `monthlyReviewRate` | 本月 `DISPOSED` ÷ 本月发起总数 × 100% |
| ~~待发起评审~~ | `pendingPoolCount` | **2026-09-23 废止（`docs/43`）**：判定不合格即自动建单，台账条目即时落 `INITIATED`，不再存在待发起队列；该字段保留仅为兼容，正常链路恒为 0 |

> KPI 全部由服务端在**当前用户 PBAC 过滤之后**计算，页面不得自行用当页数据推算（否则分页下必然失真）。

---

## 5. 字段映射（页面列 → 数据来源）

| 表格列 | 字段 | 来源 |
| :--- | :--- | :--- |
| MRB单号 | `mrbNo` | `mrb_reviews.mrb_no` |
| 来源检验单 | `sourceOrderNo` | `mrb_reviews.source_order_no` |
| 物料编码 | `materialCode` | `mrb_reviews.material_code` |
| 物料名称 | `materialName` | `mrb_reviews.material_name` |
| 不合格原因 | `defectDescription` | `mrb_reviews.defect_description`（胶囊展示；表头用词对齐 `WPS图片(13)`） |
| 不合格数量 | `defectQty` | `mrb_reviews.defect_qty` |
| 检验人 | `inspectorName` | **联表派生**：`inspection_orders.inspector_name`（按 `source_order_no = order_no`），本期不加列、不落快照 |
| 发现日期 | `createdAt` | `mrb_reviews.created_at` |
| 评审状态 | `status` | `mrb_reviews.status` |
| 操作 | — | `评审` 打开评审处置抽屉 |

---

## 6. 接口清单

### 6.1 本次新增/扩展

- `GET /api/v1/mrb/records`（**扩展查询参数**，契约仍以控制器 Zod 为准）
  - 新增：`mrbNo`（模糊）、`sourceOrderNo`（模糊）、`disposition`（等值）、`dateFrom` / `dateTo`（`created_at` 区间，`YYYY-MM-DD`）
  - 既有：`categoryTab`、`status`、`page`、`pageSize`
  - 返回：`items` / `list` / `total` + 5 项 KPI（`pendingCount`、`underReviewCount`、`totalReviewedCount`、`disposedCount`、`monthlyReviewRate`）
  - 新增返回字段：`pendingPoolCount`（不合格待审核池待发起评审条数，PBAC 过滤后统计；`docs/39` §2 D3）
  - 新增返回字段：`inspectorName`（联表派生）

### 6.2 沿用（不改造）

| 接口 | 用途 |
| :--- | :--- |
| `GET /api/v1/mrb/pending-pool` | 不合格台账只读查询（页面已无发起入口；接口保留供集成与历史数据使用） |
| `POST /api/v1/mrb/pending-pool/initiate` | 补发起通道（正常链路不再使用，判不合格已自动建单） |
| `GET /api/v1/review-flows` | 评审流程定义选择（**替换原 404 的 `GET /mrb/flows`**） |
| `POST /api/v1/mrb/records/{id}/reviews` | 评审处置抽屉：节点会签提交（**替换原 404 的 `/signatures`**） |
| `POST /api/v1/mrb/records/{id}/disposition` | 评审处置抽屉：处置结论提交（退货/返工/特采/报废，特采强制客户签核凭证） |

---

## 7. 交互定义

1. ~~**+ 发起评审**~~ **（2026-09-23 移除，`docs/43`）**：判定不合格即**自动创建 MRB 工单**并进入会签，页面无人工发起入口。原交互（右侧抽屉「不合格待审核池」清单 + 行内「选用流程 + 紧急程度 + 发起说明」弹窗）保留在 `docs/39` 的历史口径中，接口层（`GET /mrb/pending-pool`、`POST /mrb/pending-pool/initiate`）仍可用作补发起通道。
2. **行内 评审** → 右侧抽屉「评审与处置」：单据概览（批次/影响数量/处置决策/发起时间）、不合格缺陷描述、四方签核进展（质量/工程/生产/管理，读 `approvers` 真实签署记录）、电子签核表单、处置结论提交表单（特采必须填写客户签核凭证路径，否则后端按 `MRB_CONCESSION_REQUIRES_CUSTOMER_APPROVAL` 拒绝）。
3. **导出报表** → 导出当前查询条件下的处置列表（CSV / Excel），实现方式复用 `apps/web/src/pages/dashboard/history.tsx` 的 `toCsv` / `toExcelHtml` / `downloadFile`。
4. **浅色主题**：整页使用白底卡片 + `border-slate-200` + 主色 `#2563EB`；状态胶囊配色：待评审 amber、评审中 blue、已评审 purple、已处置 emerald、评审率 rose。

---

## 8. 代码落点

| 文件 | 动作 |
| :--- | :--- |
| `apps/web/src/pages/mrb/index.tsx` | 重写为浅色整合单页（页头 + KPI + 筛选 + 3 页签 + 表格 + 分页 + 评审处置抽屉挂载）；2026-09-23 起移除发起抽屉挂载与发起按钮（`docs/43`）；同日「已处置」页签并入「已评审」（§4.1） |
| `apps/web/src/pages/mrb/mrbMeta.ts` | 页签口径单点（`MRB_TABS` / `MrbTabKey`）：2026-09-23 删除 `DISPOSED` 页签项，`REVIEWED` 谓词保持 `DISPOSED,REJECTED` 不变 |
| `apps/web/src/pages/mrb/InitiateReviewDrawer.tsx` | **新增**：待审核池抽屉（由原 `PendingMRBPoolPage.tsx` 迁入）；**2026-09-23 已删除**（`docs/43`：判定不合格自动发起，无人工发起入口） |
| `apps/web/src/pages/mrb/ReviewDispositionDrawer.tsx` | **新增**：评审与处置抽屉（由原 `index.tsx` 深色工作台迁入并浅色化，修正会签接口、补处置提交） |
| `apps/web/src/pages/mrb/PendingMRBPoolPage.tsx` | **删除**（能力已迁入抽屉，避免死文件） |
| `apps/web/src/pages/mrb/ReviewWorkflowView.tsx` | 保持不变 |
| `apps/web/src/components/AppLayout.tsx` | 删除两个菜单项与 `NavItemKey` 成员；角标改为 `pendingCount` |
| `apps/web/src/App.tsx` | 删除 `mrb-pending` 分支；`mrb` 指向整合单页；`review-workflow` 直接渲染 `ReviewWorkflowView` |
| `apps/api/src/controllers/mrb.controller.ts` | `MRBQuerySchema` 扩展查询参数并透传 |
| `packages/infrastructure/src/repositories/mrb-review-repository.ts` | `listMrbReviews` 增加筛选条件 + 联表带出 `inspectorName` |
| `packages/contracts/src/schemas/mrb.ts` | `MRBReviewSchema` 增加可选 `inspectorName` |
| `apps/web/src/mocks/{handlers,data}.ts` | 同步新查询参数与 `inspectorName`，保持 MSW Zod 校验通过 |
| `docs/api/letian-qms-openapi.yaml` | 同步 `/mrb/records` 查询参数与 `MRBRecord.inspectorName` |

---

## 9. 验证与验收

### 9.1 已执行（2026-09-21）

| 检查项 | 命令 | 结果 |
| :--- | :--- | :--- |
| 全仓类型检查 | `pnpm -r --no-bail run typecheck` | 7/7 包通过 |
| 前端生产构建 | `pnpm --filter @letian/web run build` | 通过（`tsc` + `vite build`） |
| Mock 数据契约校验 | `pnpm --filter @letian/web run validate:mocks` | 13 组数据集全部通过（含新增 `PendingDefectItem` / `ReviewFlow`） |
| 源码审计（不新增 `any` / `@ts-ignore`） | `node scripts/testing/audit_check.js` | 通过（`any` 167 / 预算 177） |
| 页面级走查（离线 Mock） | `node scripts/testing/mrb-verify.cjs`（`pnpm run verify:mrb`） | 15/15 断言通过（第四轮扩充至 **23/23**，见 `docs/21` §11）；截图 `scripts/logs/mrb-*.png` |

### 9.2 走查断言（15 项）

1. 页头标题「MRB不合格品处置」+ 副标题「不合格品评审与处置 · 支持多级评审流程」；
2. 十列表头与 `WPS图片(13)` 逐字一致（第 5 列为**不合格原因**）；
3. 页签行 = 待评审 / 评审中 / 已评审（不渲染「全部」；2026-09-23 起「已处置」已并入「已评审」），且**默认选中「待评审」**；
4. 5 张 KPI 卡齐全，取值来自 `GET /mrb/records`（Mock 层实算：待评审 0 / 评审中 2 / 已评审 3 / 已处置 1 / 本月评审率 33.33%）；
5. 「待评审」页签空态、切「评审中」取到 2 条记录、`检验人` 列由 `sourceOrderNo` 派生（李伟 / 刘芳，非占位值）；
6. 浅色主题：MRB 页面子树内不存在深色（亮度 < 140 且不透明）容器；
7. 页头**不存在**「+ 发起评审」按钮，副标题为「不合格品评审与处置 · 判定不合格自动进入评审」（`docs/43`：判定不合格自动进入评审）；
8. 行内「评审」抽屉渲染四方会签席位、电子签核与处置结论表单。

### 9.3 未在本环境执行

- `pnpm --filter @letian/api run test`（集成测试依赖 `pnpm db:up` 启动的 PostgreSQL 与迁移/种子数据）。接口层改动以 `MRBQuerySchema` 参数校验、控制器透传、仓储读侧投影与 13 组契约校验作为替代证据；正式联调前需补跑一次。
- 发起评审 → 会签 → 处置的**写库闭环**走查（同上依赖数据库）。离线 Mock 已覆盖三个写接口的请求体、状态流转（`PENDING_REVIEW → UNDER_REVIEW / REJECTED → DISPOSED`）与特采客户凭证校验分支。

### 9.4 页签合并后的复验（2026-09-23）

| 检查项 | 命令 | 结果 |
| :--- | :--- | :--- |
| 前端 / 接口类型检查 | `pnpm --filter @letian/web run typecheck`、`pnpm --filter @letian/api run typecheck` | 均通过 |
| Mock 契约校验 | `pnpm --filter @letian/web run validate:mocks` | 20/20 组通过 |
| 页面走查断言同步 | `scripts/testing/mrb-verify.cjs` | 断言改为 **3 个页签**（待评审 / 评审中 / 已评审）+ 新增「筛选栏「评审状态」下拉与页签同源」检查；全脚本复跑 **26/26 PASS**（2026-09-23 实测，离线 Mock `:5201`） |
| 页签合并专项复验（离线 Mock） | 同断言临时探针（CDP 端口 9340，未入库） | **10/10 通过** |

专项复验要点：① 页签行 = 待评审 / 评审中 / 已评审，页面内**不再存在文本为「已处置」的按钮**；② 筛选栏「评审状态」下拉 = 全部 / 待评审 / 评审中 / 已评审；③ 5 项 KPI 齐全（含 `disposedCount`「已处置」卡，口径未动）；④ 十列表头未变；⑤ 合并后的「已评审」页签渲染行数与接口口径交叉核对一致 —— `status=DISPOSED,REJECTED`（1 条）= `status=DISPOSED`（1 条）+ `status=REJECTED`（0 条），**合并前后取数完全相同，无单据被漏掉**。

> **复验环境说明**：本机 CDP 端口 `9336`（`mrb-verify.cjs` 的常量端口）被其它进程的本地套接字占用，Chrome 退化为只监听 `[::1]:9336`，探针按 `127.0.0.1:9336` 轮询即报 `FATAL: Chrome CDP not reachable`（exit 2）。该现象与本次改动无关，属**运行环境端口冲突**；故在空闲端口上以同一套断言复验。真实库门禁仍是 `pnpm verify:mrb-wiring`（未在本环境执行）。

---

## 10. 未纳入本次范围（后续可选项）

1. ~~「已评审 / 已处置」严格互斥口径~~：**2026-09-23 由「两页签合并为一个已评审」取代** —— 客户选择的是「重叠的两个入口合一」，因此**不引入** `REVIEWED` 状态；若日后仍需要「只看已处置」的独立入口，可按本项实施（新增 `REVIEWED` 状态 + 数据库迁移 + 状态机与用例改造）。
2. `mrb_reviews.inspector_name` 快照列：当前采用联表派生，若客户要求「快照即证据」可加迁移与发起时写入。
3. 超时催办（>24h 未决策红标告警）在前端列表的可视化标识。

---

## 11. 变更记录

| 日期 | 版本 | 变更内容 |
| :--- | :--- | :--- |
| 2026-09-21 | v1.0.0 | 首次定稿：待审核池 + MRB 评审工单合并为「MRB不合格品处置」单页，浅色化，口径对齐 WPS图片(13)；修正会签接口 404 并补齐处置提交入口。 |
| 2026-09-21 | v1.0.1 | 联动 `21-MRB不合格品处置数据字段与接口打通设计.md`：本页的字段链路已按该文档完成数据库迁移 `015`、契约、端口/仓储与 API 打通（池 6 列 + MRB 6 列、特采凭证强制校验、处置返回裸 `MRBRecord`）；本页仅描述界面口径与交互，字段落库口径以 21 号文档为准。 |
| 2026-09-21 | v1.0.2 | 联动 `21` 号文档 §9 遗留闭环：①「发起评审」抽屉读的待审核池接口改为**行级权限随查询下推 SQL**（分类维度经 `materials.category_code` 换算、供应商维度 fail-closed），`total` 与页内条数同口径，不再有 500 条扫描上限；② 迁移 `018` 把池表 `source_order_id` 收紧为 `UUID` + 级联外键，源检验单删除后池条目不再残留（抽屉里不会出现点「发起评审」必 404 的死条目）；③ 池接口 `status` 只接受三态，旧词表直接 `400`。**页面与交互口径无变更**。 |
| 2026-09-21 | v1.0.3 | 联动 `21` 号文档 §10，闭环并列菜单**「评审流程设置」子页**（`mrb-workflow`，与本页共用 `review_flows` / `GET /review-flows`）的三处断链：① **流程说明**恒空 —— 契约与物理表都没有 `description`，用户提交的说明被 Zod 静默剥离，迁移 `019` 新增 `review_flows.description` 并打通契约/仓储/种子；② 节点「顺序 / 授权签署角色 / 是否必签 / 特采审批权」四列恒空或恒否 —— 前端自建 `nodeSeq/roleName/isRequired/allowConcession` 与契约 `nodeLevel/roleCode` 及库内 JSONB 对不上，节点字段统一收敛到契约 `nodeLevel` + `roleName`（缺省回退 `roleCode`）/ `isRequired`（默认 `true`）/ `allowConcession`（仅终审层级 `true`），并删除只在接口异常时生效、正好掩盖不一致的写死 `defaults`；③ **启停假成功** —— 前端打 `POST /review-flows/{id}/toggle` 恒 404，被 `catch` 本地翻转后弹「已更新」，现收敛到唯一路径 `POST /review-flows/{id}/toggle-active` 并删除假成功兜底，失败必须可见。**【MRB不合格品处置】主页面的页面与交互口径仍无变更**。 |
| 2026-09-22 | v1.0.4 | 联动 `21` 号文档 §11，闭环「返工处置回吐复检单号」：本页「评审与处置」抽屉提交 `REWORK` 后，**新增绿色成功横幅**「返工处置已生效，系统已生成下一轮复检单：{单号}」（取自处置响应新契约 `DisposeMRBResponse` 的 `reinspectionOrderNo`，此前调用方只能按 `batchNo` 反查、复检单未提交时恒为空）；横幅只在**切换单据**时清空，处置成功回填状态时不会被擦掉。离线 Mock 同步复刻后端「生成 `{原单号}-R{n}` 复检单 + 源单翻 `RE_INSPECTING`」的事务行为，**离线演示与真实环境单数一致**。页面列集、页签与 KPI 口径无变更。 |
| 2026-09-23 | v1.0.5 | 联动 `39-不合格判定自动入池与MRB页可见性打通设计.md`：① 页头新增**待发起评审红色胶囊**与【+ 发起评审】按钮**数量角标**（`GET /mrb/records` 新增 `pendingPoolCount`）—— 此前 5 项 KPI 全部来自 `mrb_reviews`，池条目既不进列表也不进 KPI，判定不合格后页面「看起来什么都没有」；② 本页 5 项 KPI 与列表的 PBAC 供应商维度改由**源检验单**（`source_order_no = inspection_orders.order_no`）换算（此前 MRB 表无 `supplier_code` 列，翻译器把「限定供应商」规则整条跳过，三维限定的检验员**连自己发起的评审单都看不到**）。页面列集、页签与四个工单状态口径无变更。 |
| 2026-09-23 | v1.0.6 | 联动 `43-不合格判定自动发起MRB评审设计.md`：**取消人工发起闸门** —— 判定不合格即自动创建 MRB 评审单并进入会签，页头【+ 发起评审】按钮、待发起红色胶囊与 `InitiateReviewDrawer` 抽屉一并移除，副标题改为「不合格品评审与处置 · 判定不合格自动进入评审」；处置列表 / 页签 / 5 项 KPI / 十列列集与 PBAC 口径**均无变更**（自动建单后「待评审」KPI 自然覆盖判不合格单据）。 |
| 2026-09-23 | v1.0.7 | **页签合并（客户要求）**：原「已评审」与「已处置」两个页签**合并为一个「已评审」**。两者本为包含关系（`DISPOSED ⊆ DISPOSED + REJECTED`），故合并后**状态谓词不变**（仍为 `DISPOSED,REJECTED`，无单据被漏掉、无新增状态、无迁移、无契约变更）；状态页签行由 4 个收敛为 **3 个**（待评审 / 评审中 / 已评审），筛选栏「评审状态」下拉与页签同源（`MRB_TABS`），同步收敛为 全部 / 待评审 / 评审中 / 已评审。处置结果由列表「评审状态」胶囊区分（已处置 emerald / 已驳回 rose）。**5 项 KPI 与十列列集无变更**（「已处置」KPI 保留：闭环终态计数与累计已评审口径含义不同）。代码落点：`apps/web/src/pages/mrb/mrbMeta.ts`、`apps/web/src/pages/mrb/index.tsx`；回归探针 `scripts/testing/mrb-verify.cjs` 断言同步为 3 页签。见 §4.1。 |
