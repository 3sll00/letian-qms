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
| API | `apps/api/src/controllers/inspections.controller.ts`（approve）、`master-data.controller.ts`（company-profile）、`packages/infrastructure/src/repositories/{inspection-order,master-data}-repository.ts` |
| Web | `certificateDataService.ts`、`components/certificate/{QualityCertificateTemplate,ManufacturingCertTemplate,CertificatePrintModal}.tsx`、`lib/companyProfile.ts`、`components/common/ApprovalButton.tsx`、`pages/inspections/components/{OutsourceInspectionForm,OutsourceList,IqcRecordForm,IqcList,OqcRecordForm,OqcList,IpqcViews}.tsx`、`pages/inspections/index.tsx`、`pages/master-data/*`、`mocks/{data,handlers}.ts` |
| 脚本 | `scripts/testing/outsource-no-check.cjs`、`scripts/logs/leftovers2-probe.cjs`（CDP 走查） |

---

## 12. 验证（实测回填）

（本轮实测完成后回填：迁移 029 up/down 往返、API 冒烟、CDP 走查、回归数字。）

---

## 13. 遗留

（本轮实测后回填：确实无法在本机闭环的项 + 原因。）

---

## 14. 变更记录

| 版本 | 日期 | 变更 |
|:---|:---|:---|
| v1.0.0 | 2026-09-22 | 新建。承接 `docs/34` §9 的 M1~M9：ERP 号段形态单点化与扫库校验（M1）、2023 历史行口径固化与回填预案（M2）、IQC/OQC 写路径打通（M3）、质量负责人签核数据源（M4）、企业档案主数据 `company_profile`（M5）、证书实测分段可见性解释（M6）、委外新建链路（M7）、IQC/OQC 证书改走 certificateDataService（M8）、证书入口统一（M9） |