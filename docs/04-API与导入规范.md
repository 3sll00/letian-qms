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
- `PATCH /api/v1/inspections/:id/measurements`: 批量录入或暂存抽样实测数值。
- `POST /api/v1/inspections/:id/evaluate`: 触发 AQL 与公差自动裁决，更新单据状态为 `PASS` 或 `FAIL`。

### 3.4 生产强制放行关卡 (`/api/v1/release-gates`)
- `GET /api/v1/release-gates/check`:
  - **请求参数**：`work_order_no` (必填), `process_code` (必填), `material_code` (可选)。
  - **响应结果**：
    - 放行：`{ "released": true, "status": "RELEASED", "inspection_no": "IPQC-..." }` (HTTP 200)
    - 阻断：抛出 RFC 7807 `ERR_RELEASE_GATE_BLOCKED` (HTTP 409 Conflict)。

### 3.5 不合格待审核池与 MRB 评审 (`/api/v1/mrb`)
- `GET /api/v1/mrb/pending-pool`: 查询待审核池列表（过滤未分配、已分配状态）。
- `POST /api/v1/mrb/pending-pool/batch-assign`: 批量指派责任审核人。
- `POST /api/v1/mrb/pending-pool/merge`: 合并同类缺陷条目。
- `POST /api/v1/mrb/orders`: 基于待审核条目正式发起 MRB 评审单。
- `POST /api/v1/mrb/orders/:id/signoff`: 各部门负责人录入会签决策（批准/驳回/意见）。

### 3.6 炉批号双向追溯 (`/api/v1/trace`)
- `GET /api/v1/trace/genealogy`:
  - **请求参数**：`direction` (`FORWARD` 或 `BACKWARD`), `heat_no`, `lot_no`, `max_depth` (默认 8)。
  - **响应结果**：返回 DAG 拓扑图节点与连线数组，前端一键渲染谱系树。

### 3.7 质检方案管理 (`/api/v1/plans`)
- `GET /api/v1/plans`: 查询质检方案库。
- `POST /api/v1/plans`: 新建/更新质检方案及检验特征指标。
- `GET /api/v1/plans/match`: 根据输入的物料编码与存货分类，返回智能继承计算后的生效方案。

### 3.8 报表打印与矢量导出 (`/api/v1/reports`)
- `GET /api/v1/reports/templates`: 获取可用的打印报表模板清单。
- `POST /api/v1/reports/render-pdf/:inspectionId`: 渲染并输出带防伪矢量印章的官方质检报告。

---

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
| **采购入库单号** | ERP 采购入库/送检单号 | Dlyndx.Number (VchType=161) | purchaseReceiptNo / receiptNo | `RK-20260706-001` / `GR-2022-03-10-00001` |
| **入库日期** | 到货/采购入库登记日期 | Dlyndx.Date (CONVERT varchar 120) | receiptDate / inDate | `2026-07-06` |
| **物料编号** | 物料存货编码 | Ptype.UserCode | materialCode / partNumber | `CL-001` |
| **物料名称** | 物料存货全称 | Ptype.FullName | materialName / partName | `不锈钢棒料` |
| **规格型号** | 物料规格尺寸与型号 | Ptype.Standard | spec / specification | `Φ20mm` |
| **数量** | 到货/入库总数量 (含单位) | DlyBuy.Qty + Ptype.Unit | totalQty / qtyDisplay | `500 件` |
| **供应商** | 往来单位/供货厂商全称 | Btype.FullName | supplierName / supplier | `宝钢` |
| **批次号** | 原材料进厂炉批号/流水批次 | DlyBuy.BatchNo / DlyCheck.Blockno | batchNo / lotNo | `LOT-20260706-001` |
| **检验状态** | 来料质检流转状态 | DlyCheck.Verdict / 内部状态枚举 | status (`待检验`/`检验中`/`已合格`/`不合格`/`已关闭`) | `待检验` |
| **检验人** | 经办质检员姓名 | Etype.FullName (来自 DlyndxCheck.EtypeId) | inspectorName | `张检验` / `-` |
| **操作** | 业务动作流 | 状态驱动 (`检验` / `详情` / `追溯`) | actions | 待检验显示检验/详情；完结显示详情/追溯 |
