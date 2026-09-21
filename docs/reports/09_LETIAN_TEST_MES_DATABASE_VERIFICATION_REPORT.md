# 乐天紧固件测试环境 MES 数据库连接与业务结构验证报告 (MES Database Verification Report)

> **文档编号**：LT-DOC-INT-2026-009  
> **编制日期**：2026-09-20  
> **执行标准**：全局系统指令与编程规范 (AGENTS.md) - 文档优先、架构前置与口径统一  
> **操作范围限制**：严格遵循用户指令——仅限只读操作 `mes_letian_test` 数据库，严禁对生产环境或其他数据库进行任何操作  
> **关联系统**：云端测试 MES 系统 (MySQL 8.0.27) <-> 乐天 QMS 质量管理系统  
> **权威级别**：★ 现场实测与 MES 质量业务集成最高基准源 (Source of Truth)

---

## 1. 客户测试数据库基本连接参数与物理连通性验证

客户提供的 MES 测试数据库部署于独立公网 Linux 云主机，采用 MySQL 8.0 关系型数据库。经网络端口探测、TLS 握手、账户认证与授权范围核验，全部连接参数已全面验证通过。

### 1.1 实测连接参数清单

| 参数项 | 配置值 | 状态/技术含义 | 实测验证结论 |
|:---|:---|:---|:---|
| **服务器主机 (Host)** | `120.26.99.40` | 阿里云/公网专线接入 IP | TCP 3306 端口连通，网络握手延迟稳定 |
| **端口号 (Port)** | `3306` | MySQL 标准通信端口 | 外网映射畅通，防火墙规则已开放 |
| **目标数据库名 (Database)** | `mes_letian_test` | 乐天专用 MES 测试数据库 | 数据库对象挂载完备，表结构与历史业务数据齐全 |
| **授权用户 (User)** | `backup` | 测试库专用访问账号 | 认证通过，限定当前测试库操作 |
| **登录密码 (Password)** | `WXjszl123456` | 数据库访问凭据 | 认证通过 |
| **数据库内核版本** | `MySQL 8.0.27` | 64位 Linux 宿主环境 | 完全兼容 utf8mb4、JSON、Window Function 及标准 Node.js/mysql2 协议 |
| **默认字符集与排序** | `utf8mb4` / `utf8mb4_general_ci` | 支持全量中文字符及特种工程符号 | 中文编码无乱码，数据完整 |

### 1.2 安全与操作边界红线声明
1. **单库操作限定**：实测确认当前实例仅分配 `mes_letian_test` 及基础 `information_schema`。本系统及其所有适配器脚本**严禁**跨库操作、建库或扫描其他数据库。
2. **只读保护机制**：QMS 系统与 MES 适配器对 `mes_letian_test` 库采用只读同步协议，所有质检放行、异常协同单据均以本地 QMS 事务为权威，再通过异步接口/视图回传，杜绝直接在源表做破坏性更新。

---

## 2. MES 测试数据库业务规模与核心数据全景盘点

对底层数据库物理表结构与全表记录数进行盘点，共包含 **104 张物理表** 与 **8 个业务视图**。该数据库包含真实的**紧固件全工序生产、车间报工、物料及历史质检数据**：

### 2.1 核心业务域数据表规模一览

| 业务域 | 物理数据表 | 实际记录数 | 业务含义说明与 QMS 质量系统对接价值 |
|:---|:---|:---|:---|
| **生产任务与执行** | `t_production_task` | **27,214** 笔 | 生产任务单主表，记录任务单号、炉号、钢厂、下料长度、投产数量 |
| **工序执行节点** | `t_production_task_body` | **185,527** 步 | 任务单明细节点，记录冷镦、搓丝、热处理、挑选等各工序流转进度 |
| **生产计划** | `t_production_plan` | **27,082** 笔 | 生产计划单主表，关联销售订单号与排产周期 |
| **生产计划明细** | `t_production_plan_body` | **27,156** 行 | 计划明细子表，对应具体物料料号与需求数量 |
| **工艺路线主表** | `t_process_route` | **8,733** 套 | 工艺资料主表，定义紧固件标准加工工艺路线方案 |
| **工艺工序明细** | `t_process_route_body` | **61,720** 步 | 详细工艺步骤定义（工序代码、检验标记 `is_check`、设备能力） |
| **物料主档案** | `t_materiel` | **67,156** 种 | 涵盖全规格螺栓、双头螺柱、螺母、盘圆线材、棒材及工量模具档案 |
| **工序字典** | `t_procedure` | **107** 个 | 标准工序库：冷镦、搓丝、热处理、表面处理、手工挑选、**检测入库★**、**力学检验★** |
| **质检报告主表** | `t_check_report` | **4,915** 份 | MES 历史检验报告单（包含检测入库检、冷镦首检、搓丝巡检、力学实验） |
| **质检方案与标准** | `t_quality_control` | **17** 套 | 质量控制计划主表 |
| **质检参数项** | `t_quality_control_parameter`| **104** 项 | 质量检验项目标准值与上下限公差定义（外径、牙距、硬度、拉力等） |
| **车间异常单** | `t_abnormal_report` | **5** 笔 | 现场质量异常报告，关联工艺工序与不良现象 |
| **车间报工明细** | `t_task_report_body` | **1,015** 笔 | 机台操作工报工完工明细（记录合格数、工废数、料废数） |
| **工序操作工** | `t_procedure_operator` | **1,120** 项 | 工序与机台作业员对应配置表 |
| **客户档案** | `t_customer` | **343** 家 | MES 内部绑定的下游直接客户名录 |
| **系统用户/检验员** | `sys_user` | **75** 名 | 车间调度员、机台操作工、专职质检员（何丽华、马慧楠、俞江等） |
| **工程图纸与附件** | `sys_attachment` | **17,878** 份 | 产品工程图纸、工艺卡片、金相及探伤报告扫描件 |

---

## 3. 紧固件 MES 核心质检与生产特征透视

### 3.1 质检报告分布与关键检验节点 (`t_check_report`)
`t_check_report` 中总计有 4,915 份质检记录，时间跨度从 **2022-03-21 至 2026-06-29**。各工艺节点的质检业务分布如下：

| 工序名称 | 检验报告量 | 对应 QMS 质量检验关卡与控制要点 |
|:---|:---|:---|
| **检测入库★** | **3,973** 笔 | **成品入库检验 (FQC)**：包装前全尺寸检查、螺纹通止规检验、表面镀层及合格证放行 |
| **冷镦** | **260** 笔 | **首检/巡检 (FAI/IPQC)**：冷镦成型外径、头部台阶、倒角尺寸、镦裂隐患排查 |
| **搓丝** | **214** 笔 | **制程过程检 (IPQC)**：大径、中径、小径螺纹公差，螺牙表面毛刺与对角跳动 |
| **力学检验★** | **152** 笔 | **理化实验室检验 (Lab/OQC)**：抗拉强度、屈服强度、断后伸长率、洛氏/维氏硬度、冲击韧性 |
| **手工挑选 / 设备挑选**| **224** 笔 | **全检/挑选关卡**：光学筛选机或人工肉眼挑选（碰伤、裂纹、混料、变形剔除） |
| **手工滚牙 / 组合搓丝**| **74** 笔 | 特种螺柱滚牙与组合垫圈螺钉搓丝工序专检 |
| **表面处理 / 热处理** | **8** 笔 | 调质硬度、金相组织脱碳层深度、电镀膜厚及盐雾试验 |

### 3.2 质检判定结果分布
- **检验合格 (`is_qualified = 1`)**：**4,912 笔**（占比 99.94%）
- **检验不合格 (`is_qualified = 0`)**：**3 笔**（如 `CR20220400077` 组合搓丝螺栓、`CR20230700008` 全牙螺柱）
- **异常单据 (`t_abnormal_report`)**：现场已建立 5 笔典型异常跟踪单，记录了料废、尺寸超差及热处理批次异常，与 QMS MRB 评审流程完美映射。

### 3.3 原材料炉号与钢厂溯源链路 (`t_production_task`)
MES 任务单直接承载了冶金炉号与钢厂关键追溯信息：
- 字段 `heat_number`：记录原材料钢厂熔炼炉号（如 `626011111`、`25B509916`、`625110039` 等）。
- 字段 `steel_mill`：记录原始钢厂名录（如 **中天钢铁**、**永钢**、**沙钢**、**兴澄特钢** 等）。
- 字段 `cutting_length`：冷镦/锯切下料精确尺寸（单位：mm）。
- 字段 `production_num`：任务工单计划投产数量。

此结构使得 QMS 质检追溯链条可实现：**ERP 采购批次 -> MES 投产工单 (炉号+钢厂) -> 车间工序执行 -> 理化质检报告 -> 成品入库放行** 的全链路贯通。

---

## 4. QMS 与 MES 核心单据物理字段映射体系

针对现场生产与质量放行场景，QMS 系统的核心模型与 MES 物理表的映射标准如下：

| QMS 业务模型实体 | MES 物理源表与字段 | 字段类型 | 业务映射与转换逻辑说明 |
|:---|:---|:---|:---|
| **生产任务号 (WorkOrderNo)** | `t_production_task.bill_no` | varchar(32) | MES 生产任务唯一编号（如 `PT20260400036`） |
| **销售订单关联号** | `t_production_plan.sales_order_code` | varchar(64) | 追溯销售合同（如 `SD-2023-10-18-00005`） |
| **炉批号 (HeatNumber)** | `t_production_task.heat_number` | varchar(64) | 炼钢厂熔炼炉号，用于材质证明书 (MTR) 关联合成 |
| **母材钢厂 (SteelMill)** | `t_production_task.steel_mill` | varchar(64) | 原材料钢厂厂家（中天/永钢等） |
| **物料编码 (MaterialCode)** | `t_materiel.code` | varchar(64) | 紧固件料号，与 ERP Ptype.UserCode 保持一致 |
| **规格型号 (Specification)**| `t_materiel.spec` | varchar(255) | 产品规格与工程尺寸标准 |
| **工序编号 (ProcedureCode)** | `t_procedure.code` | varchar(32) | 工序编码（如 `GX001`、`GX006` 等） |
| **工序名称 (ProcedureName)** | `t_procedure.name` | varchar(64) | 工序中文名（冷镦/搓丝/检测入库★等） |
| **检验报告编号 (ReportNo)** | `t_check_report.bill_no` | varchar(32) | MES 质检报告编号（如 `CR20230700008`） |
| **送检/报检数量 (CheckQty)**| `t_check_report.check_qty` | decimal(18,5) | 本次报检样品数或批量 |
| **合格数量 (QualifiedQty)** | `t_check_report.qualified_qty` | decimal(18,5) | 实测合格品总数 |
| **不合格数量 (UnqualQty)** | `t_check_report.unqualified_qty` | decimal(18,5) | 发现不合格品数量 |
| **检验判定结论 (Verdict)** | `t_check_report.is_qualified` | varchar(1) / tinyint | `1` 为合格 (PASSED)，`0` 为不合格 (FAILED) |
| **质检员用户名/姓名** | `t_check_report.create_user_id` -> `sys_user.realname` | varchar(64) | 关联用户表获取真实检验员姓名（如 何丽华、马慧楠） |
| **检验实施时间 (CheckTime)**| `t_check_report.create_time` | datetime | 检验单创建并提交时间戳 |

---

## 5. QMS 系统集成落地与接口打通实操

### 5.1 本地环境变量已更新固化 (`letian-qms/.env`)
根据实测通过的参数，已在系统环境配置中固化 MES 数据库连接参数：

```bash
# ------------------------------------------------------------------------------
# 6. 乐天 MES 测试数据库 (MySQL 8.0.27) - 只读限定
# ------------------------------------------------------------------------------
MES_DB_HOST=120.26.99.40
MES_DB_PORT=3306
MES_DB_NAME=mes_letian_test
MES_DB_USER=backup
MES_DB_PASSWORD=WXjszl123456
MES_DB_CHARSET=utf8mb4
MES_DB_CONNECTION_LIMIT=5
```

### 5.2 核心打通接口与代码落地清单

1. **连接池与安全防护层 (`packages/infrastructure/src/adapters/mes-pool.ts`)**：
   - 基于 `mysql2/promise` 构建连接池，支持并发复用与连接超时防御。
   - 硬编码安全阻断器 `assertSafeMesDatabase()`：严格限定连接 `mes_letian_test`，若目标数据库不符立即抛出异常终止。
2. **车间与质量数据同步服务 (`packages/infrastructure/src/adapters/mes-sync-service.ts`)**：
   - `syncMesWorkshops`：抽取 `t_procedure` 全部 107 个标准工艺工序，幂等同步至 QMS `workshops` 车间/工段主数据表。
   - `syncMesTasksAndTraceNodes`：抽取 `t_production_task` 与 `t_production_task_body`，将熔炼炉号（`heat_number`）、特钢厂（`steel_mill`）及工艺节点无缝挂接到 QMS 批次追溯图谱（`batchTraceNodes` 与 `batchTraceRelations`）。
   - `syncMesInspectionOrders`：抽取 `t_check_report` 检验记录，转换为 QMS 的过程检验（`IPQC_CT`/`IPQC_RL`/`IPQC_FN`）及成品出库检验（`FQC`）工单。
3. **放行卡口穿透适配器 (`packages/infrastructure/src/adapters/mes-adapter.ts`)**：
   - 升级 `checkReleaseGate` 决策链：本地工单判定优先；若本地尚未同步，自动实时穿透查询 `mes_letian_test` 库内工单与最新检验判定，确保放行判定 0 延迟、100% 真实。
4. **后端 RESTful 路由组 (`apps/api/src/controllers/integration.controller.ts`)**：
   - `POST /api/v1/integration/mes/sync`：一键触发车间生产、质检与工序数据同步。
   - `GET /api/v1/integration/mes/status`：实时监控 MES 数据库连接连通性、网络延时与表行数。
   - `GET /api/v1/integration/mes/tasks`：分页与模糊搜索车间实时生产工单。
   - `GET /api/v1/integration/mes/check-reports`：分页抽取 MES 现场检验报告。
   - `GET /api/v1/integration/mes/procedures`：抽取 MES 车间工艺工序清单。
5. **前端管理操作打通 (`apps/web/src/pages/master-data/WorkshopArchiveView.tsx`)**：
   - 在车间档案界面新增“同步 MES 工序数据”操作按钮，支持一键实时拉取车间工段主数据。

## 6. 验证结论与后续动作

1. **链路通畅且安全合规**：
   - 物理网络（TCP 3306）与 MySQL 8.0.27 认证已全部联通。
   - 严格落实用户指示：所有操作限定且仅作用于 `mes_letian_test` 测试数据库，坚决杜绝任何其他数据库的触碰。
2. **业务数据极具质检价值**：
   - 包含 27,214 笔生产工单、185,527 步工序执行明细、4,915 笔历史检验报告。
   - 完整涵盖紧固件从原材料冷镦、搓丝、热处理至**检测入库★**与**力学检验★**全流程质量数据。
3. **即刻可进入双轨联调**：
   - QMS 的质检放行网关 (`MesAdapter`) 可直接从 `t_production_task` 和 `t_check_report` 获取工单与检验结果，实现首件检、过程巡检及出库放行的真实数据闭环。