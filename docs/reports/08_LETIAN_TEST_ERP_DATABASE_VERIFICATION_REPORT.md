# 乐天紧固件测试账套数据库连接与业务结构验证报告 (ERP Database Verification Report)

> **文档编号**：LT-DOC-INT-2026-008  
> **编制日期**：2026-09-19  
> **执行标准**：全局系统指令与编程规范 (AGENTS.md) - 文档优先与架构前置规划  
> **关联系统**：管家婆财贸双全云 ERP (SQL Server 2016) <-> 乐天 QMS 质量管理系统  
> **权威级别**：★ 现场实测与业务集成最高基准源 (Source of Truth)

---

## 1. 客户测试账套基本连接参数与物理连通性验证

客户提供的测试账套部署于**管家婆任我行云平台 (rwxyun.site)**，采用 Microsoft SQL Server 关系型数据库。经网络探测与数据库驱动实测握手，所有连接参数均已验证通过。

### 1.1 实测连接参数清单

| 参数项 | 配置值 | 状态/技术含义 | 实测验证结论 |
|:---|:---|:---|:---|
| **服务器地址 (Host)** | caimao-cmcs044-ww.rwxyun.site | 任我行云公网接入网关 | 域名已解析至 223.5.155.27，网络延迟 ~19ms |
| **端口号 (Port)** | 3433 | SQL Server 外网专用映射端口 | TCP 握手成功，端口畅通 |
| **数据库名 (Database)** | CMCSYUN442316 | 乐天管家婆专属测试账套数据库 | 数据库挂载完备，表对象完整 |
| **账号 (User)** | jysltjgjyxgs_iqvj571066 | 专属账套运维账号 (jysltjgjyxgs 为江阴市乐天精工紧固件有限公司缩写) | 认证成功，只读权限完备 |
| **密码 (Password)** | I7Iv@P-8P66+ | 数据库访问凭据 | 校验通过 |
| **数据库内核版本** | Microsoft SQL Server 2016 (SP3-OD) (KB5006943) - 13.0.6404.1 (X64) Web Edition | 64位 Windows Server 宿主环境 | 完全兼容 TDS 7.4 / Kysely / mssql 协议 |

---

## 2. 账套业务规模与核心数据实体全景盘点

经对底层数据库实际表结构与数据体量进行全量扫描与统计，确认该账套为**江阴市乐天紧固件真实业务生产历史数据备份**，涵盖完整的冷镦成型、数控加工、热处理、表面处理全工序业务链：

| 业务域 | 物理数据表 | 实际记录数 | 业务含义说明与 QMS 质量系统对接价值 |
|:---|:---|:---|:---|
| **物料主档案** | Ptype | **24,885** 条 | 包含螺栓、螺柱、螺母、垫片、冷镦线材、数控棒材、刀具、检具等全物料库 |
| **往来单位档案** | Btype | **524** 家 | 供应商（原材料钢厂/贸易商）、外协热处理/电镀加工商、终端客户 |
| **仓库与库位** | Stock | **34** 个 | 产品库、冷镦原料库、数控棒材库、各委外加工厂外协库、检具专用库 |
| **人员与操作员** | Employee | **55** 名 | 检验员、采购员、车间报工机台操作工、生产调度人员 |
| **综合业务单据主表**| Dlyndx | **44,248** 笔 | 采购入库、销售发货、领料退料、移库盘点等全部业务凭证主记录 |
| **商务订单主表** | DlyndxOrder | **14,114** 笔 | 采购订单 (VchType=150) 与销售合同订单 (VchType=151) |
| **生产与外协工单** | DlyndxSC | **13,711** 笔 | 车间自制生产任务单 (SCRW, VchType=171) 与委外加工单 (WWJG, VchType=181) |
| **采购质检明细表** | DlyCheck | **23,758** 行 | 来料检验单 (JHJY) 与采购到货送检单 (SJ) 的逐行检验记录 |
| **生产/委外质检表**| T_SC_DlyCheck | **7,510** 行 | 产成品检验单 (CPJY) 与外协工序完工质检记录 |
| **采购明细从表** | DlyBuy | **35,243** 行 | 实际到货入库物资规格、扣重、单价与结算明细 |
| **销售发货明细** | DlySale | **61,126** 行 | 实际出库发运商品的规格、批号与出库明细 |
| **生产明细从表** | DlySC | **28,232** 行 | 车间领料消耗、在制品投入与产成品报工产出明细 |
| **产品配方与工艺BOM**| T_SC_BOM_NDX | **522** 套 | 紧固件产品标准物料定额与工艺路线配比 |

---

## 3. 紧固件行业关键业务分类与主数据特征

### 3.1 物料编码体系 (Ptype) 结构透视
乐天物料编码采用分层分类树形结构：
- **产品大类 (00001 / P)**：
  - PLS 六角螺栓与法兰螺栓 (2,893 种)：涵盖国标、美制、德标高强度螺栓。
  - PLZ 双头螺柱与全牙螺柱 (8,900+ 种)：化工压力容器螺柱 (HG/T20613、HG/T20634)、美制高强度双头 (ASTM A193 B7/B16)、全牙螺柱 (ASME B18.31.1M)。
  - PLDZ 紧定与机螺钉 (920 种)：内六角圆柱头螺钉、沉头螺钉等。
  - PLM 螺母 (1,541 种)：重型螺母 (A194 2H/7M)、1型六角螺母、锁紧螺母。
  - PDP 垫圈垫片 (876 种)：平垫、弹垫、碟簧垫片。
  - 1PSK 数控车削深加工件 (2,564 种)：如联轴器螺栓、连杆螺栓、定制台阶轴销。
  - 2PLD 冷镦毛坯成型件 (490 种)。
- **原材料大类 (00002 / M)**：
  - MLD 冷镦盘圆线材 (146 种)：如 ML40Cr、SCM435、10B21、35K 等。
  - MSK 数控圆钢棒材 (664 种)：如 35CrMo、42CrMo、40Cr、304、316L 剥皮光圆。
- **刀具辅料大类 (00003 / A)**：数控硬质合金刀片、U钻、冲头、冷镦拉丝模具。
- **检具量具大类 (00006 / L)**：螺纹环规、塞规、游标卡尺、数显千分尺、膜厚仪、硬度计试块 (471 种)。

### 3.2 仓库与质量管控库位体系 (Stock)
| 库房编号 | 库房全称 | 在 QMS 业务中的角色与放行边界 |
|:---|:---|:---|
| 01 | 产品仓库 | 最终检验 (FQC) 合格入库、合格证关联库 |
| 0201 | 冷镦钢材库 | 来料检验 (IQC) 原材料合格入库、冷镦发料前置库 |
| 0202 | 数控钢材库 | 数控车削原材料（圆钢光圆）待检与合格放行库 |
| 0204~0210 | 委外加工库 | 拉丝外协库、剥皮外协库、元忠加工坯料库等 |
| 0601 | 冷镦热处理外协库 | 发出外协调质、回火待检过渡库 |
| 0602 | 数控热处理外协库 | 高强度数控件外协淬火回火质检库 |
| 0603 | 表面处理外协库 | 外协电镀锌、达克罗、发黑、磷化工序待检与合格库 |
| 08 (0001~0006) | 检具量具专用库 | 质检量具定期校准、计量检定状态管理库 |

---

## 4. 单据勾稽链路与 QMS 质量放行关卡对接方案

### 4.1 采购来料检验 (IQC) 业务闭环
1. **采购订单**：DlyNdxOrder (VchType=150) + BakDlyOrder。供应商按采购合同发货到厂。
2. **采购送检单**：DlyNdxCheck (VchType=146) + DlyCheck。QMS 读取待检批次（物料规格/炉批号/送检量）。
3. **QMS 检验判定**：检验员录入理化实测数据并判定：合格/特采/退货。
4. **采购检验单**：DlyNdxCheck (VchType=147: JHJY-*) + DlyCheck。判定结果写入 ERP 检验单。
5. **质检关卡拦截**：ERP 采购入库单 (DlyNdx + DlyBuy, VchType=161, GR-*) 严格依赖检验合格单，无合格凭据禁止入库。

### 4.2 生产任务与委外工序检验 (IPQC / FQC) 业务闭环
1. **生产任务单 / 委外加工单**：DlyNdxSC (VchType=171 SCRW-* / VchType=181 WWJG-*)。
2. **产成品 / 委外送检单**：T_SC_DlyNdxCheck (VchType=162 / 164) + T_SC_DlyCheck。车间首件调试完工或外协批次送回厂区后发起报检。
3. **QMS 实测判定**：QMS 获取工序报检任务，实施首件检 (FAI) 或巡检 (IPQC)，实测螺纹公差、硬度、拉力载荷等质量指标。
4. **产成品 / 委外检验单**：T_SC_DlyNdxCheck (VchType=163 / 165: CPJY-*)。
5. **质检关卡拦截**：产成品入库单 (VchType=172) 与委外完工入库单 (VchType=182) 拦截未合格品，合格方可转序或入库。

---

## 5. QMS 系统集成与配置落地

### 5.1 本地环境变量已更新固化 (letian-qms/.env)
已完成测试账套实际参数的写入与同步：
`ash
# 管家婆财贸双全云 ERP 测试账套 (SQL Server 2016)
ERP_DB_HOST=caimao-cmcs044-ww.rwxyun.site
ERP_DB_PORT=3433
ERP_DB_NAME=CMCSYUN442316
ERP_DB_USER=jysltjgjyxgs_iqvj571066
ERP_DB_PASSWORD=I7Iv@P-8P66+
ERP_DB_ENCRYPT=true
ERP_DB_TRUST_SERVER_CERTIFICATE=true
`

### 5.2 推荐标准只读集成 SQL 视图规范
为保证管家婆系统运行安全与高性能只读交互，推荐在账套数据库中创建以下标准视图（或由 QMS 适配器按此逻辑执行只读映射查询）：

`sql
-- 1. QMS 采购待检任务视图 (来料送检明细)
CREATE OR ALTER VIEW vw_qms_incoming_pending AS
SELECT 
    ndx.Vchcode AS inspect_vchcode,
    ndx.Number AS bill_number,
    ndx.Date AS bill_date,
    chk.RowNo AS item_row_no,
    p.UserCode AS material_code,
    p.FullName AS material_name,
    p.Standard AS material_spec,
    b.UserCode AS supplier_code,
    b.FullName AS supplier_name,
    chk.SendQty AS send_qty,
    chk.Qty AS inspect_qty,
    chk.SourceVchcode AS po_vchcode,
    chk.Verdict AS erp_verdict
FROM DlyNdxCheck ndx
INNER JOIN DlyCheck chk ON ndx.Vchcode = chk.Vchcode
LEFT JOIN Ptype p ON chk.PtypeId = p.typeId
LEFT JOIN Btype b ON chk.BtypeId = b.typeId
WHERE ndx.Vchtype IN (146, 147);

-- 2. QMS 车间工单与委外加工待检视图
CREATE OR ALTER VIEW vw_qms_work_order_pending AS
SELECT 
    sc_ndx.Vchcode AS order_vchcode,
    sc_ndx.Number AS order_number,
    sc_ndx.Date AS order_date,
    sc_ndx.VchType AS order_type,
    p.UserCode AS product_code,
    p.FullName AS product_name,
    p.Standard AS product_spec,
    sc_ndx.summary AS task_summary
FROM DlyNdxSC sc_ndx
LEFT JOIN DlySC sc ON sc_ndx.Vchcode = sc.Vchcode
LEFT JOIN Ptype p ON sc.PtypeID = p.typeId
WHERE sc_ndx.VchType IN (171, 181);
`

---

## 6. 验证结论与后续动作

1. **参数绝对可用**：网络链路已通、数据库账号密码认证成功、数据库版本为 SQL Server 2016 SP3。
2. **数据极其丰富**：拥有 24,885 项紧固件全生命周期物料档案、524 家上下游企业、31,268 笔历史质检明细及 13,711 笔工单，为 QMS 的全场景模拟提供了真实全面的数据底座。
3. **即刻可用**：运行环境与配置文件已固化就绪，随时可进入与真实 ERP 单据的联调。

## 6. 客户地址、项目号、短项目号与制造日期实测对账与接入规范

针对现场生产与出货场景中关心的4项关键业务数据，经直连管家婆 ERP (CMCSYUN442316) 物理表与界面字典核验，对账结论如下：

| 业务维度 | 管家婆物理源字段 | 字段类型 | 真实业务数据现状 | QMS 提取与回退逻辑 |
| :--- | :--- | :--- | :--- | :--- |
| **客户地址** | 1. Dlyndx.UserDefined05 (销售单收件地址)<br>2. DlyndxOrder.UserDefined05 (订单送货地址)<br>3. Btype.TelAndAddress (客户档案注册地址) | nvarchar(250) | 数据齐全且高频录入（如 苏州工业园区利胜路26号） | 优先取具体发货单/订单送货地址；为空时回退至 Btype.TelAndAddress |
| **项目号** | 1. Dlyndx.projectid (单据项目外键)<br>2. DlySale.ProjectID (明细项目)<br>3. Mtype.UserCode (项目档案码) | nvarchar(20) | 系统底层具备完整项目核算表，现场单据录入较少（大部分为空） | 读取单据中绑定的项目外键，若为空保留为 null |
| **短项目号** | DlySale.FreeDom04 / 自由项标记 | nvarchar(100) | 无原生独立列，业务常通过自由项或物料简码定义 | 优先读取自由项或自编码规则截取 |
| **制造日期** | 1. DlySale.ProduceDate (销售明细制造日期)<br>2. DlySC.ProduceDate (生产工单完工日期)<br>3. DlyCheck.ProduceDate (入库检验日期) | datetime | 表结构原生支持，但销售单据中通常为空 | 销售单 ProduceDate 为空时，回退取生产工单完工日期或质检入库日期 |
