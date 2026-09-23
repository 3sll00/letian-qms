# 35-遗留项二轮收口设计（ERP 号段校验 + 三表单写路径 + 企业档案主数据 + 证书入口统一）

需求原文：承接 `docs/34-遗留项收口设计（委外单号与批次口径 + 证书去编造 + 委外录入写路径）.md` §9 的遗留 M1~M9，用户指令「需要解决，替我修改」。

> 一句话口径：把上一轮的「没有真实来源就留空」再往前推一步 —— **能接上真实来源的一律接上真实来源**（签核动作、企业档案、物料主数据、实测项），只有确实不存在的业务事实才留白，并在界面上说清「为什么空」。

---

## 1. 结论（先给答案）

| 编号 | 事项 | 本轮处置 | 依据 |
|:---|:---|:---|:---|
| **M1** | ERP `DlyndxSC.Number` 的流水段形态（本机无 ERP 连接） | **改**：号段口径单点化 —— 新增 `packages/domain/src/services/outsource-reference.ts`（前缀常量 + `parseOutsourceNo` 形态识别 + 仅接受 `WWJG-` 前缀的守门函数），适配器的 `Number \|\| 'WWJG-'+VchCode` 兜底收敛为**纯函数 + 单测**，并新增扫库校验脚本；ERP 样例到位后只需补一条断言，不改业务代码 | 本设计 §2 |
| **M2** | 2023 两条历史行是否补号 | **口径固化 + 守门**：仍不补号（`NULL`），台账渲染 `—`（探针已守）；把「拿到对账单后如何回填」写成**可执行步骤**（复用留痕表，无需新迁移），并纳入扫库校验脚本的「允许为 NULL 的说明」白名单 | 本设计 §3 |
| **M3** | IQC / 过程检 / 出货检三个录入表单写路径仍是 `alert` | **改（范围核实后收窄）**：过程检三视图**早已真写**（`IpqcViews.handleSubmitInspect` → `submit-measurements` + `status`）；本轮打通 **IQC 与 OQC** 两个表单的写路径，并撤除父页 `alert` 假成功 | 本设计 §4 |
| **M4** | 制造证书「质量负责人签核」无数据源 | **改**：新增**签核动作本身**（迁移 029 三列 `approver_id / approver_name / approved_at` + `POST /inspections/{id}/approve` + 表单页头「质量负责人签核」按钮）→ 证书读真实签核人，未签核才留白 | 本设计 §5 |
| **M5** | 质量证书「签发主体 / 供货单位 / 产地」无企业档案主数据（现为模板硬编码常量） | **改**：迁移 029 建 **`company_profile` 单行表**，把两处模板里已存在的硬编码抬头常量**迁入**主数据（种子初始行，值不变），新增 `GET/PUT /master-data/company-profile` + 主数据页「企业档案」Tab；模板抬头 / 印章 / 供货单位·产地一律读主数据 | 本设计 §6 |
| **M6** | 证书实测分段可见性依赖工单实测值（现状：静默不渲染） | **改（改为显式解释）**：证书弹窗新增非打印提示条，列出「本单未录入实测值、故不打印」的分段；打印区口径不变（绝不打印未发生的检验结果） | 本设计 §7 |
| **M7** | 委外表单「新建」路径 UI 不可达 | **改**：`OutsourceList` 顶部新增「新建委外检验单」入口；表单内新增**物料编码选择器**（`GET /master-data/inventory`），物料编码由只读派生改为可维护状态 | 本设计 §8 |
| **M8** | IQC / OQC 录入表单自建证书对象仍用旧键名 | **改**：两个表单的 `handleOpenCert` 一律改走 `certificateDataService.buildIqcCertificateData` / `buildOqcCertificateData`，删除手搓对象（键名与模板读取口径由服务统一） | 本设计 §9 |
| **M9** | 证书入口交互不统一（文字按钮 / 纯图标 / 藏在详情弹窗） | **改**：四处台账统一为**操作列文字按钮「证书」**、同一可见性口径（每行可点，数据缺失即留白）、同一 `title` 说明 | 本设计 §10 |

---

## 2. M1：ERP 委外单号流水段（本机无 ERP 连接）

| 项 | 口径 |
|:---|:---|
| 事实 | `inspection_orders.outsource_no` 是 ERP `DlyndxSC.Number`（VchType=181）的镜像列；本机无 ERP 连接，**流水段真实形态无法核对** |
| 本轮能做且已做 | ① 前缀/形态判定**单点化**为纯函数，业务侧不再各写各的字符串拼装；② 适配器兜底路径（`Number` 为空时用 `VchCode` 拼）保留原行为但**集中一处 + 注释 + 单测**；③ 扫库脚本把「非 `WWJG-` 前缀的非空值」判为失败，把「NULL」判为**待回填**而非错误 |
| 不能做 | 不能凭空断言 `DlyndxSC.Number` 的数字段就是 `{YYYYMMDD}-{NNN}`；样例到位后按 `docs/31` 先例做一次改号迁移（留痕表 `outsource_reference_renumberings` 已就绪） |
| 交接物 | `packages/domain/src/services/outsource-reference.ts`、`outsource-reference.test.ts`、`scripts/testing/outsource-no-check.cjs` |

形态识别口径（`parseOutsourceNo`）：

| shape | 形态 | 例 | 含义 |
|:---|:---|:---|:---|
| `ERP_NUMBER` | `WWJG-` 前缀 + 任意分段 | `WWJG-20260706-001` | 已按 ERP 号段镜像（当前库内 7 行） |
| `LEGACY` | `WW-` 前缀 | `WW-20260706-001` | 迁移 028 之前的旧形态，**应为 0 行** |
| `DERIVED` | `WWJG-{VchCode}` 兜底（无 `Number`） | `WWJG-1234` | 适配器兜底产物，流水段待 ERP 样例核对 |
| `UNKNOWN` | 其它非空值 | — | 校验脚本判失败 |
| `EMPTY` | `NULL` / 空串 | — | 2023 历史行，属既定口径 |

---

## 3. M2：两条 2023 历史行（不补号）

| 项 | 口径 |
|:---|:---|
| 现状 | `outsource_no IS NULL`（`external_document_mappings` 0 行、ERP 无对账单），台账渲染 `—` + `title="ERP 无委外加工单（历史导入行）"` |
| 本轮 | 口径不变；**补号预案落成步骤**：拿到对账单 → 在 `outsource_reference_renumberings` 写入 `kind='OUTSOURCE_NO'`、`old_value=NULL` 留痕 → 事务内更新 `inspection_orders.outsource_no` 与活引用 → 不需要新迁移文件 |
| 守门 | 校验脚本对 `NULL` **不报错**（属口径允许），但把「`NULL` 行数」打印出来（当前 2 行），行数变化即提醒复核口径 |

---

## 4. M3：IQC / OQC 录入表单写路径

范围核实结论（先纠正 `docs/34` §9 M3 的描述）：

| 表单 | 现状 | 本轮 |
|:---|:---|:---|
| 过程检（下料 / 滚丝 / 成品检） | 已真写：`submit-measurements`（只下发已填且属于本单方案快照的指标）→ `status`（判定 + 合格/不合格数 + 备注），失败 `alert` 文案 | 只把失败提示从 `alert` 收成表单内红字（与其余表单同口径） |
| IQC 来料检验 | `handleInternalSubmit` → 父页 `alert('来料检验单已保存提交！')` | **打通**：`POST /inspections/{id}/submit-measurements` → `POST /inspections/{id}/status` |
| OQC 出货检验 | 提交按钮 → 父页 `alert('出货检验单已提交完成！')` | **打通**：同上 |

> **补充（本轮实测发现，同批一并改）**：`OqcRecordForm` 抬头仍有预置演示值（`QC-2026-07-0062`、`江阴开益特种压缩机有限公司`、`ML40Cr`、`张检验 (QC)`、`2026-07-06`、判定结论长文等），与 `docs/27` §6.1 / `docs/33` §2.1 同款缺陷。若只做 §9 M8 的「键名改走 certificateDataService」，这些演示值会**原样打印进对外质量证书**（换键名不换值，等于把编造值换个字段名继续编造）。故 M8 拆成两步：**先清抬头演示值（接列表行 / 本单快照，无来源即留空 + 占位提示）→ 再换证书组装口径**。

写路径口径（与 `docs/34` §6.2 完全一致，避免第二套）：

1. 指标行实测值**只下发本单方案快照内、且已填写**的项；存在空项时按**草稿**落库（`isDraft: true`）——用「未录入」触发领域终判会把整单判成不合格并汇入不合格待审池，那不是检验员的真实结论。
2. 终判单独调用 `status`：判定 → `PASSED` / `FAILED` / `RE_INSPECTING`（返工），并带 `passQty` / `failQty` / `judgment` / `remark`。
3. 回执：绿字显示**服务端返回的检验单号**；失败按 `ApiError` 文案红字就地提示（抽公共 `errorMessage`，不再 `alert` 假成功）。
4. 表单没有 `id`（未落库的历史行）时给明确红字提示，不静默成功。

---

## 5. M4：质量负责人签核（新增真实数据源）

| 层 | 内容 |
|:---|:---|
| 迁移 029 | `inspection_orders` 增 `approver_id uuid NULL`（`fk_inspection_orders_approver → employees(id) ON DELETE SET NULL`）、`approver_name varchar(64) NULL`、`approved_at timestamptz NULL`；`down()` 反向删列 |
| 契约 | `ApproveInspectionOrderRequestSchema { remark?: string }`，响应复用检验单 DTO（新增 `approverName` / `approvedAt` 只读字段） |
| API | `POST /inspections/{id}/approve`：签核人 = **当前登录用户**（`operatorOf(request)`，与「检验人」落库同一来源），写 `approver_id` / `approver_name` / `approved_at = now()`；重复签核幂等覆盖并留 `remark` 到 `inspection_notes` |
| Web | 复用组件 `ApprovalButton`：委外表单、IQC 表单、OQC 表单页头各一处；点击后调 API 并就地回执「已由 X 签核」 |
| 证书 | 制造证书 `qaManagerName` = `approverName`；质量证书 `approver` = `approverName`（`reviewer` 保持留白：系统内没有第二道复核动作）；**未签核即留白**，不打印任何人名 |

---

## 6. M5：企业档案主数据（`company_profile`）

| 项 | 口径 |
|:---|:---|
| 表结构 | 单行表（`profile_id boolean PRIMARY KEY DEFAULT true CHECK (profile_id)`）：`legal_name` / `legal_name_en` / `short_name` / `address` / `origin_place` / `phone` / `email` / `quality_stamp` / `updated_by` / `updated_at` |
| 初始值 | 由**现有模板里的硬编码常量迁移而来**（`宁波乐天紧固件制造有限公司` / `NINGBO LETIAN FASTENERS MANUFACTURING CO., LTD.` / 印章 `宁波乐天质检`），不新增任何未经确认的信息；`address` / `origin_place` / `phone` / `email` 留空等业务填写 |
| API | `GET /master-data/company-profile`（无行返回 `null`）、`PUT /master-data/company-profile`（upsert，`updated_by` = 当前登录用户） |
| Web | 主数据页新增「企业档案」Tab（表单读写 + 保存回执）；证书调用侧统一经 `loadCompanyProfile()`（模块级缓存）取一次 |
| 证书口径 | 质量证书：抬头中文/英文、印章文字、`供货单位/产地` 单元格 = 主数据 `legal_name` + `origin_place`（OQC 出厂场景的供货单位即本企业）；IQC 的供货单位仍取**供应商主数据**（真实来源不同，不混用）；制造证书：抬头中文/英文读主数据 |
| 缺失行为 | 主数据为空 → 单元格留白（**不回落硬编码常量**），界面提示「企业档案未维护」 |

---

## 7. M6：证书实测分段可见性

- 事实：IQC / IPQC / OQC 证书的「化学成分 / 力学性能 / 尺寸」三段，只渲染**本单已录入实测值**的项；`PENDING` 单实测值为空 → 整段不渲染（**这是正确行为**，不是接口缺字段）。
- 问题：界面上「什么都没有」与「数据缺失」不可区分，容易被读成接口坏了。
- 改法：组装证书时同步算出缺失分段，随 `CertificatePrintModal` 以提示条展示（**非打印区**，如「本单未录入实测值：化学成分、力学性能 —— 证书不打印该分段」）。打印区口径不变。

---

## 8. M7：委外新建链路可达

| 项 | 内容 |
|:---|:---|
| 入口 | `OutsourceList` 顶部「新建委外检验单」按钮 → `onInspect(null)`（`OutsourceInspectionForm` 已支持无 `id` 建单） |
| 物料 | 表单内新增「物料编码」选择器，选项来自 `GET /master-data/inventory`；选中后回填物料名称 / 规格型号（仅在该字段为空时），并驱动 `useMatchedPlan(materialCode, ...)` 重新匹配方案 |
| 存量单 | 有 `id` 时该字段只读展示（历史单据的物料编码不允许被改写），口径与只读回看一致 |
| 物料保护 | 新建时必须先选物料编码：空值即红字「请先选择物料编码」，不再由 `materialCode === ''` 静默拦下 |

---

## 9. M8：IQC / OQC 证书对象改走 certificateDataService

- 现状：两表单 `handleOpenCert` 手搓对象用旧键（`date` / `spec` / `materialGrade` / `lotNo` / `deliveryStatus`），模板读 `issueDate` / `specification` / `steelGrade` / `batchNo` / `surfaceFinish` → 抬头恒空白。
- 改法：删除手搓对象，改为 `buildIqcCertificateData({ orderNo, materialName, specification, ... , items })` / `buildOqcCertificateData(...)`，键名口径由服务统一维护（唯一真相），并传入 `companyProfile`。

---

## 10. M9：证书入口统一

| 台账 | 现状 | 改后 |
|:---|:---|:---|
| 委外 | 文字按钮「证书」 | 不变（作为基准） |
| 来料 IQC | 纯图标按钮，仅「已合格」行显示 | 文字按钮「证书」，每行可点 |
| 过程检 IPQC | 只在「详情」弹窗内 | 操作列文字按钮「证书」+ 详情弹窗内保留 |
| 出货 OQC | 台账无入口（只能在录入表单里打印） | 操作列文字按钮「证书」 |

统一口径：按钮文案 `证书`；`title="按本行数据导出证书（未录入的项留白）"`；可见性 = **所有行**（数据缺失由证书留白体现，不用「按钮消失」表达）。

---

## 11. 同步面

| 面 | 文件 |
|:---|:---|
| 迁移 / 种子 | `029_company_profile_and_order_approval.ts`、`migrations/runner.ts`、`migrations/index.ts`、`database/schema.ts`、`seeds/data.ts`、`seeds/runner.ts`（表数 25 → **26**） |
| 契约 | `packages/contracts/src/schemas/inspection.ts`（签核请求 + DTO 字段）、`…/master-data` 相关 schema、`packages/contracts/src/openapi/generator.ts`（如需要）、`docs/api/letian-qms-openapi.yaml` |
| 领域 | `packages/domain/src/services/outsource-reference.ts` + 单测 |
| API | `apps/api/src/controllers/inspections.controller.ts`（approve）、`master-data.controller.ts`（company-profile）、`apps/api/src/lib/permission-guard.ts`（`assertQualityApprover`）、`packages/infrastructure/src/repositories/{inspection-order,master-data}-repository.ts` |
| Web | `certificateDataService.ts`、`components/certificate/{QualityCertificateTemplate,ManufacturingCertTemplate,CertificatePrintModal}.tsx`、`lib/companyProfile.ts`、`components/common/ApprovalButton.tsx`、`pages/inspections/components/{OutsourceInspectionForm,OutsourceList,IqcRecordForm,IqcList,OqcRecordForm,OqcList,IpqcViews}.tsx`、`pages/inspections/index.tsx`、`pages/master-data/{index,CompanyProfileView,CreateMasterDataModal}.tsx`、`mocks/{data,handlers,validate}.ts` |
| 脚本 | `scripts/testing/outsource-no-check.cjs`（扫库校验）、`scripts/testing/ipqc-ledger-verify.cjs`（操作列断言同步）、`scripts/testing/leftovers2-probe.cjs`（CDP 走查 29 项，`pnpm verify:leftovers2`） |

---

## 12. 验证（实测回填）

**迁移 / 库**

| 项 | 实测结果 |
|:---|:---|
| 迁移 `029` up | `company_profile` 建表 + `inspection_orders` 增 3 列；`information_schema.tables` = **34**；`kysely_migration` 最新 = `029_company_profile_and_order_approval` |
| 迁移 `029` down | 3 列与 `company_profile` 全部回退，库结构回到 `028` 状态（up/down 往返实测） |
| 迁移前备份 | `D:\乐天\db-backup-20260922-143515\letian_qms_db-pre029.sql`（190,810 字节） |
| 种子 | `pnpm db:seed` → **26 表 165 行**（`company_profile` 1 行，值 = 迁移前两处硬编码常量的原值） |

**接口（真实库）**

| 用例 | 实测 |
|:---|:---|
| `GET /master-data/company-profile` | 200，返回种子行（`legalName` / `legalNameEn` / `qualityStamp` 非空） |
| `PUT /master-data/company-profile` 传非法邮箱 | **400**（契约 `z.string().email()` 生效，不静默接受） |
| `POST /inspections/:id/approve`（`IQC_INSPECTOR` 陈静） | **403**（门禁在服务端，前端不猜角色） |
| `POST /inspections/:id/approve`（`QA_MANAGER` 张强） | **200**，回吐 `approverName='张强'`；重新 `GET` 仍在（真实落库，非响应体内存值） |
| 审计留痕 | `audit_logs` 出现 `diff_patch.event='QUALITY_APPROVAL'` 行；**主动试删被触发器拒绝**（append-only 是数据库层强制约束，不是文档里的一句话） |
| 重复签核 | 幂等覆盖：返回新的 `approvedAt`，不冲突、不重复建单 |

**前端 CDP 走查 29/29**（`pnpm verify:leftovers2` → `scripts/testing/leftovers2-probe.cjs`：真实写路径 + 四个台账 + 企业档案页）

- **M5 企业档案**：页签存在且回显种子值；保存出现绿字回执；接口回读 `address` = 探针值（真实落库）；`updated_by` = `张强`；清空字段后再回读为空；企业档案页签下**不出现**「新增」入口
- **M4 签核**：录入表单页头出现签核按钮（未签核 = 质量负责人签核 / 已签核 = 重新签核，均由真实签核状态驱动）
- **M3 写路径**：IQC 提交回执 = `已保存并终判：INS-20231013-0001（判定：合格）`（服务端返回，非 `alert` 假成功）
- **M7 委外新建**：入口可达；物料编码下拉 = 存货主数据 17 条；选中 `MAT-10B21-06` 即回填物料名称「冷镦钢 10B21 Φ6.0mm」
- **M9 证书入口**：来料 / 过程检 / 委外 / 出货**四个台账**操作列均含「证书」，点击可开证书且弹窗含本行单号；弹窗出现非打印提示条「提示：本单未录入实测值：化学成分、力学性能、尺寸与外观 —— 证书不打印该分段」

**离线 Mock 同步实测 4/4**（`pnpm verify:leftovers2:mock` → MSW 浏览器冒烟 `scripts/testing/leftovers2-mock-probe.cjs`，本轮已从 `scripts/logs/` 提升为仓库内门禁）

- `GET /master-data/company-profile`：企业档案页回显 `mockCompanyProfile` 法定名称（值与种子同源）
- `PUT /master-data/company-profile`：保存出现绿字回执；`updated_by` = 页面顶栏当前 Mock 登录身份（服务端会话口径，客户端不可自称）；清空字段再保存生效
- `POST /inspections/:id/approve`：签核后 `data-testid="approval-state"` 显示「已由 <登录身份> 签核 · <服务端时间>」

本轮同时收口了两处 **Mock ↔ 真实后端的身份口径分叉**（原状：离线演示的回执会写出与页面顶栏不一致的编造姓名）：

- Mock 补 `GET /api/v1/auth/users`（`mockAuthUsers`：9 名职员与真实 `employees` **同 UUID、同姓名、同主角色**）。此前该接口未被 mock，登录页在离线环境下拿不到名单、只能退化为「以默认身份进入」。
- Mock `POST /api/v1/auth/login` 改为与后端 `authController` 同口径：传 `userId` 必须能在职员档案里查到（查不到即 **401**，不接受请求体自称），缺省身份固定为质量主管「张强」。此前缺省返回的是 `张三 (测试质检员)` + `role: INSPECTOR`，于是 `updated_by` / `approver_name` 会写出一个页面顶栏上根本不存在的人。
- 新增与种子同行的**待检验**来料单 `INS-20231013-0001`（与真实库 `INS-20231013-0001` 同单号、同物料、同批次）：此前 Mock 的两张 IQC 单都已判定，离线演示根本走不到「录入 → 签核」链路。
- 两个探针都在导航前清掉浏览器会话，并在登录后确认已进入应用：Chrome 用户目录是复用的，残留会话会让顶栏身份停在上一轮用户（这正是起初「回执身份 ≠ 顶栏身份」假失败的成因）。Mock 探针还要求 `VITE_API_TARGET` 指向**未监听**端口 —— 否则未被 mock 的接口会打到真实后端并 401，前端安全登出会把人踢回登录页，断言全灭。
**回归门禁**

| 命令 | 结果 |
|:---|:---|
| `pnpm typecheck` | **7/7** 通过 |
| `pnpm test` | 全绿（契约 Zod 校验、领域规则、端到端集成、委外台账、物料权限、MRB 联动） |
| `pnpm --filter @letian/web run validate:mocks` | **19 组**（新增「企业档案 `mockCompanyProfile`」一组） |
| `pnpm audit:code` | 通过：`any` **137** / 预算 138（本轮把 `certificateDataService.ts` 的 5 处 `any` 收敛为 `unknown` + 显式收窄） |
| `pnpm verify:inspections` | **18/18** |
| `pnpm verify:ipqc-ledger` | **29/29**（断言同步为「操作列按状态分派 + 行级证书入口」） |
| `pnpm verify:oqc` | **8/8** |
| `pnpm verify:mrb-wiring`（独立 `:3101` 实例） | **35/35** |
| `pnpm verify:outsource-no` | PASS（`ERP_NUMBER` 7 行 / `EMPTY` 17 行 / `DERIVED` 0 行） |
| `information_schema.tables` | **34** |

**静态检查与端到端门禁（二轮补做：把「注册了但从没跑过」的脚本真正跑通）**

| 命令 | 结果 |
|:---|:---|
| `pnpm lint` | **0 error / 297 warning**（首次接入实测）。修前为 **234 error**：`no-explicit-any` 176、`no-unused-vars` 57、`no-irregular-whitespace` 1 —— 也就是说 `lint` 脚本从注册起就没通过过 |
| `pnpm verify:leftovers2:mock` | **4/4**（本轮把它从 `scripts/logs/` 提升为仓库内门禁，并注册 `package.json` 脚本） |
| `pnpm verify:smoke` | **7/7**，未捕获异常 **0**；同步重出 `docs/screenshots/` 六张验收图 |
| `pnpm desktop:demo` | **PASS**：`apps/desktop/release/LetianQMS-Desktop-1.0.0.exe`（78.5 MB）、`.../LetianQMS-Portable-1.0.0.exe`（78.3 MB）、`.../win-unpacked/乐天QMS工作台.exe`（180 MB）—— **R5 的桌面端离线包已重新构建验证** |
| `pnpm audit:code` | 通过：`any` **136** / 预算 138（清理死代码后比上一轮少 1 处） |
| `pnpm verify:mrb`（离线 Mock，`WEB_BASE` 锁定干净 `dev:mock` 实例） | **24/24**（原记 19/23，病因见 R7：探针打到了真实后端代理实例） |
| `pnpm verify:eol`（新增门禁） | PASS：已跟踪文本文件 **0 个混行 / 0 个全 CRLF**（归一前 75 个） |

`pnpm lint` 的处置口径（重点：消除同一条口径上的两个执行点）：

- `@typescript-eslint/no-explicit-any` 由 `error` 降为 `warn`：仓库内 **`any` 的执行点是 `pnpm audit:code`**（预算 138 / 基线文件 / 「不得新增」语义，见 `scripts/testing/README.md` §三）。此前 eslint 判 error、audit 判「在预算内」，同一条口径出现两个互相矛盾的结论，任何一次 `pnpm lint` 都必然失败。
- `no-unused-vars` 的 57 条**全部按真·死代码修掉**（未使用的 import、只写不读的 `useState`、未使用入参改 `_` 前缀），不是关规则；其中 `apps/web/src/pages/inspections/components/IqcRecordForm.tsx` 删掉的是一个**点了没有任何反应**的「预览与打印质量保证证书 (PDF)」按钮 —— 它的弹窗在 M8 改造中已改走 `certificateDataService`，按钮与 `templateModalOpen` 状态成了残留（同类残留：`IpqcViews` 的只写不读 `statusCounts`、`categories` 的未使用 `totalMaterialCount`）。
- `no-irregular-whitespace` 1 条：`apps/web/src/pages/master-data/index.tsx` 第 5 行混入了一个 BOM 字符（`U+FEFF`），已删除。
- `scripts/logs/`（一次性产物目录，已 gitignore）移出扫描范围；剩余 297 条 warning 为 `any` 175 + `no-console` 122，见 R8。

> 探针会真实推进一单的实测值与终判（这是「实测」的定义），跑完执行 `pnpm db:seed` 回到演示基线；
> 签核三列由探针在收尾时置回 `NULL`，`QUALITY_APPROVAL` 审计留痕**不删**（也删不掉）。

---

## 13. 遗留

| 编号 | 事项 | 说明 |
|:---|:---|:---|
| R1 | ERP `DlyndxSC.Number` 的**流水段**真实形态 | 本机无 ERP 连接：`verify:outsource-no` 实测 `DERIVED` **0** 行（没有 `Number` 为空、需要拿 `VchCode` 拼的样例）。拿到 ERP 导出样例后按 `docs/31` 先例补一条断言即可，业务代码不动（形态判定已单点化到 `packages/domain/src/services/outsource-reference.ts`） |
| R2 | 两条 2023 历史行委外加工单号仍为 `NULL` | 既定口径是**不补号**（ERP 侧无对账单）；拿到对账单后按 §3 用同一张留痕表回填 |
| R3 | 企业档案除「法定名称中英文 / 印章文字」外的字段 | 种子留空（地址 / 产地 / 电话 / 邮箱 / 简称）→ 证书对应单元格按设计**留白**；需业务侧在「主数据 · 企业档案」维护后才打印 |
| R4 | 历史单据证书的「批准人」栏 | 没有发生过签核动作就留白（`approver_name` 为空）——这是**设计口径**而不是缺陷：要打印，就得有人真的签核 |
| R5 | 桌面端（Electron）离线包 | **已收口**：`pnpm desktop:demo` 实测 PASS（NSIS 安装包 78.5 MB / 免安装 78.3 MB / `win-unpacked` 180 MB）。仍未做的是**人眼安装与启动验收**（本机无交互式会话）——构建产物本身已可复现 |
| R6 | 仓库范围的行尾（EOL）混行 | **已收口**。实测 `git ls-files --eol`：索引（HEAD blob）里**文本文件本来就是 LF**（无一条 CRLF blob），脏的只是**工作区** —— 75 个文本文件带 CRLF（56 混行 + 19 全 CRLF），根因是仓库**没有 `.gitattributes`**，各编辑器/工具各写各的行尾。处置：补根 `.gitattributes`（`* text=auto eol=lf` + 二进制 `binary`）→ 按索引口径把工作区 75 个文件整文件归一为 LF → 新增 `pnpm verify:eol`（`scripts/testing/eol-check.cjs`）纳入提交前检查，实测 **0 混行 / 0 全 CRLF**。`core.autocrlf=true` 对已跟踪文本文件不再起作用（`.gitattributes` 的 `eol=lf` 优先级高于 `core.autocrlf`），因此**不需要改本机 git 配置** |
| R7 | `pnpm verify:mrb`（离线 Mock）4 条失败 | **已收口；病因与初判不同**。先把 `WEB_BASE` 显式指向一个**干净的 `dev:mock` 实例**复测：**24/24 通过**，Mock 侧「评审中 = 2 条」「待审核池（待发起评审）= 3 条」与脚本期望**完全一致** —— 所以**不是 Mock 数据漂移**。真因是**探针的运行目标没锁死**：`mrb-verify.cjs` 自动探测 `5201 → 5200 → 5202`，多会话环境里会落到**真实后端代理**实例上，断言于是照着真实库取值（真实库 `PENDING_INITIATE` 只有 1 条）；更糟的是脚本的返工处置会真的 `POST /mrb/records/:id/disposition` **写真实库**，把一条 `UNDER_REVIEW` 改成 `DISPOSED`，所以**同一条命令第二次跑**连「评审中 = 2」也对不上（脏库实测 KPI：评审中 1 / 已处置 3 / 评审率 50%；`pnpm db:seed` 复位后为 2 / 2 / 33.33%）。处置：探针加**运行目标自检** —— 页面内 `navigator.serviceWorker.getRegistrations()` 必须命中 `mockServiceWorker`，不是离线 Mock 就 `exit 3` 并打印正确启动方式；顺带修正一处误导断言名（「待评审」页签断言 `rowCount === 1` 却命名为「空态」）。权威 MRB 门禁仍是 `pnpm verify:mrb-wiring`（真实库 **35/35**） |
| R8 | 静态检查剩余 297 条 warning | `any` **175**（执行点已统一到 `audit:code` 预算）+ `no-console` **122**（多为种子 / 同步脚本的正常进度输出，建议按目录给 eslint `overrides`，而不是逐条加注释） |

---

## 14. 变更记录

| 版本 | 日期 | 变更 |
|:---|:---|:---|
| v1.0.0 | 2026-09-22 | 新建。承接 `docs/34` §9 的 M1~M9：ERP 号段形态单点化与扫库校验（M1）、2023 历史行口径固化与回填预案（M2）、IQC/OQC 写路径打通（M3）、质量负责人签核数据源（M4）、企业档案主数据 `company_profile`（M5）、证书实测分段可见性解释（M6）、委外新建链路（M7）、IQC/OQC 证书改走 certificateDataService（M8）、证书入口统一（M9） |
| v1.0.1 | 2026-09-22 | 实测回填（§12 / §13）：迁移 `029` up/down 往返；接口 403 / 400 / 200 与审计 append-only 实测；CDP 走查 **29/29**；`typecheck 7/7`、`test` 全绿、`validate:mocks 19 组`、`verify:inspections 18/18` + `verify:ipqc-ledger 29/29` + `verify:oqc 8/8` + `verify:mrb-wiring 35/35` + `verify:outsource-no` PASS、`audit:code` 通过（`any` 137/138）；种子 26 表 165 行、`information_schema.tables` 34。同步补做：离线 Mock（`mockCompanyProfile` + `company-profile` GET/PUT + `inspections/:id/approve`）、`validate:mocks` 新增企业档案契约校验、`CreateMasterDataModal` 补 `companyProfile` 分支、`certificateDataService` 收敛 5 处 `any` |
| v1.0.2 | 2026-09-22 | **门禁与 Mock 口径收口（本轮）**：`pnpm lint` 首次跑通（修前 234 error → 0 error，`any` 规则执行点统一到 `audit:code`，57 条死代码清掉、1 处 BOM 清除）；`verify:leftovers2:mock` 从 `scripts/logs/` 提升为仓库门禁并实测 **4/4**；Mock 补齐 `GET /auth/users` + 登录身份按职员档案解析（与后端 `authController` 同口径）+ 新增待检验来料单；`verify:smoke` **7/7**；`desktop:demo` **PASS**（R5 收口）；新增遗留 R6（EOL 混行）/ R7（`verify:mrb` Mock 漂移）/ R8（297 条 warning） |
| v1.0.3 | 2026-09-22 | **遗留 R6 / R7 收口（本轮）**：新增根 `.gitattributes`（`* text=auto eol=lf` + 二进制 `binary`）并把工作区 75 个带 CRLF 的文本文件归一为 LF（索引本来就是 LF，差异只在工作区）；新增 `pnpm verify:eol` 门禁（`scripts/testing/eol-check.cjs`，纳入 `scripts/testing/README.md`）；`verify:mrb` 加运行目标自检（必须是 MSW 离线 Mock，否则 `exit 3`）后实测 **24/24**，并更正 R7 病因（探针落到真实后端代理 + 探针自身写脏真实库，而非 Mock 数据漂移） |