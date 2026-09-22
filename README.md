# 乐天质量管理系统 (Letian QMS)

> **面向工业紧固件制造的数字化质量协同与物理放行阻断管控中枢**  
> 严格对齐《乐天QMS_开发确认文档.docx》21 项核心能力与 21 张高保真设计图，实现 IQC 来料检验、IPQC 过程检验（下料/滚丝/成品检）、OQC 委外与出货检验、批次 DAG 追溯、可配置 MRB 评审流程引擎、PBAC 行级数据隔离与 ERP/MES 双向中枢。

---

## 一、 项目工程结构 (Monorepo 规范)

本项目严格遵循契约先行（Contract-First）、领域驱动设计（DDD 严格四层架构）与高并发数据安全规范：

```text
D:\乐天\letian-qms/
├── packages/
│   ├── contracts/          # 共享契约层：Zod 严格校验 Schema、DTO 类型、RFC 7807 统一错误模型 (单一真理源)
│   ├── domain/             # 纯领域模型：检验方案聚合、状态机引擎、公差判标、AQL抽样、纯内存 PBAC 规则评估 (零 IO 依赖)
│   ├── application/        # 用例编排层：方案版本快照绑定、放行排他锁控制、MRB 流程实例协调、PBAC 上下文装配 (事务边界)
│   └── infrastructure/     # 基础设施层：PostgreSQL 14+ Kysely 迁移、CamelCasePlugin 映射、DAG 递归追溯、Outbox 事务发信
├── apps/
│   ├── api/                # 后端服务：Fastify REST API、放行关卡 409 物理阻断、基于 contracts Zod 的契约自动化测试
│   └── web/                # 前端服务：React + Vite + TailwindCSS 工业质检工作台、ECharts 图表、MSW 契约先行 Mock
└── docs/
    ├── letian-qms-prd.md            # 乐天 QMS 产品需求规格说明书 (v2.5.0 对齐 21 项业务)
    ├── letian-qms-architecture.md   # 核心技术架构、表 DDL、并发控制与事务边界规范 (v2.5.0 生产基准级)
    ├── api/
        └── letian-qms-openapi.yaml  # 乐天 QMS 标准 OpenAPI 3.1 接口契约规范 (v2.7.0)
    └── tasks/
        └── tasks.json               # 细粒度实施任务矩阵与独立双轨验收标准 (QMS-000 ~ QMS-010)
```

---

## 二、 核心架构设计与工程标准

1. **强契约先行 (Contract-First)**：
   - 所有接口入参、出参和公差规则均由 `packages/contracts` 的 Zod Schema 作为系统唯一权威源，自动推导导出 TypeScript DTO。API 运行时校验与前端表单共享同一套验证逻辑。
2. **状态机与不变式强约束**：
   - 检验工单状态机受控流转（`PENDING` -> `INSPECTING` -> `PASSED` / `FAILED` -> `IN_MRB_REVIEW` -> `COMPLETED`），支持 `REWORK`（返工）状态机回边生成复检工单（`RE_INSPECTING`）。
   - **成品检强制物理关卡（MANDATORY_GATE）**：未检或不合格批次在调用放行接口时严格返回 `409 Conflict` 阻断，MES 同步闭锁机台，异步通过 Outbox 投递 `BATCH_LOCKED` 事件。
3. **检验方案快照绑定 (InspectionPlan Snapshot)**：
   - 检验工单创建时刻深拷贝当前生效版本的全部检验项与抽样规则至 `plan_snapshot` JSONB 与 `inspection_order_items` 明细行表，确保质检基准具备不可篡改的法律效力。
4. **批次追溯 DAG 与防死锁递归 CTE**：
   - 原材料批次、工序流转、委外加工与销售订单构成有向无环图（DAG），采用 PostgreSQL 14+ 原生 `CYCLE` 子句避免无限展开，由应用层标记环路闭环，支撑毫秒级穿透追溯。
5. **不可篡改审计流 (Append-Only Audit)**：
   - 操作审计表 `audit_logs` 具备数据库行级防篡改触发器，严禁任何物理 `UPDATE` 或 `DELETE`，合规历史追溯有据可查。

---

## 三、 快速启动与验证

### 1. 容器环境与数据库一键初始化
```bash
cd D:\乐天\letian-qms

# 1.1 一键拉起本地 PostgreSQL 14 容器
pnpm db:up

# 1.2 执行全量数据库表结构迁移
pnpm db:migrate

# 1.3 注入与 21 张设计原型一致的基础档案与方案种子数据
pnpm db:seed
```

> **本机（开发机）走本地实例，不走容器**：本机 PostgreSQL 实例的唯一启停方式与端口口径见
> `docs/23-本地数据库运行手册与端口口径.md`（端口固定 `5432`；历史端口 `55432` 已废弃）。
> 本机 **Docker 守护进程未运行**，`pnpm db:up`（容器路线）不可用，请改用本地实例：
>
> ```bash
> pnpm db:local:doctor   # 体检：端口一致性 / 迁移滞后 / API 连通 / Docker 可用性
> pnpm db:local:start    # 启动本地实例（端口永远取自 .env 的 DB_PORT）
> ```

### 2. 安装依赖与构建全包
```bash
pnpm install
pnpm -r run build
```

### 3. 运行类型检查、Lint 与测试

根目录脚本会递归执行全部子包，且单个子包失败不会中断其余子包（`--no-bail`），
因此一次执行即可看到 6 个包各自的状态，最后以非 0 退出码表示「存在失败项」。

```bash
# 全仓类型检查：contracts / domain / application / infrastructure / api / web
pnpm typecheck

# 全仓测试：domain(98 项断言) + infrastructure(3 个用例文件) + api(契约/e2e 三套)
pnpm test

# 全仓 ESLint
pnpm lint

# 前端单独复核（可选，已包含在 pnpm typecheck 中）
pnpm --filter @letian/web run typecheck
pnpm --filter @letian/web run validate:mocks   # 校验前端 Mock 数据与契约 schema 一致
```

> 测试通过 `tsx` 直接运行 TypeScript 源码，但跨包引用（`@letian/contracts` 等）走的是各包
> `dist` 产物，因此首次执行测试前请先 `pnpm build`（或 `pnpm typecheck`，`tsc -b` 会一并产出）。

> 已知状态：`pnpm typecheck` 目前会因 `packages/infrastructure/src` 数据访问层的历史错误而
> 以非 0 退出，其余 5 个包均通过；`apps/api`、`apps/web` 的类型检查已恢复为 0 错误。


### 4. 启动前端工作台 (开发模式)
```bash
cd apps/web
pnpm dev
```
前端默认基于 MSW (Mock Service Worker) 运行，所有 Mock 数据构建期自动经由 `packages/contracts` 的 Zod schema 进行 `.parse()` 强校验，实现脱离后端的独立高保真交互验证。

---

## 四、 实施任务生命周期矩阵 (QMS-000 ~ QMS-010)

全系统已拆解为完整的 11 项任务卡，按严格的分层分类与依赖序执行，并支持双轨独立验收：
- **[infra] QMS-000**：开发环境容器基建与运行时配置管理 (`docker-compose.yml`, `.env.example`)
- **[infra] QMS-001**：项目规范、Monorepo 脚手架与 CI 质量门禁 (Project References, TypeScript Strict)
- **[contracts] QMS-002**：共享契约源头与 Zod 校验模式生成器 (`packages/contracts`, DTOs)
- **[domain] QMS-003**：纯业务领域模型、端口定义与状态机引擎 (`packages/domain`, 8态状态机, AQL)
- **[application] QMS-004**：应用服务编排、PBAC 上下文装配与事务边界 (`packages/application`, 方案快照, Advisory Lock)
- **[infrastructure] QMS-005**：数据库表设计、仓储适配与集成端口实现 (`packages/infrastructure`, Kysely 迁移, CTE 追溯)
- **[api] QMS-006**：Fastify API 服务端、统一鉴权与契约校验测试 (`apps/api`, RFC 7807, 阻断关卡)
- **[web] QMS-007**：React 工业级质量工作台与 Mock 契约先行协同 (`apps/web`, ECharts, 21张高保真页面)
- **[seed] QMS-008**：生产基础档案与质检方案初始化种子数据 (`pnpm db:seed`, 6类档案与正式方案)
- **[ops] QMS-009**：后台运维守护进程与自动化调度中心 (Outbox 死信告警、超时催办、日志清理)
- **[deploy] QMS-010**：生产容器化构建、反向代理与全链路交付验收 (`Dockerfile`, `nginx.conf`, UAT 签字)

---

## 五、桌面客户端 (Electron)

除浏览器版外，系统提供 Windows 原生桌面客户端（`apps/desktop`）：Electron 壳加载
`@letian/web` 构建产物，由主进程内置的回环静态服务器（`127.0.0.1` 固定端口）托管前端资源，
所有业务请求直达远程 Fastify 后端（API 已开放 CORS）。适合工厂内网工位机部署，无需浏览器。

### 1. 构建与运行

| 命令 | 说明 |
| --- | --- |
| `pnpm desktop:build` | 正式安装包：electron-builder 产出 NSIS 安装器与 portable 便携版（`apps/desktop/release/`），首次启动在「设置 → 服务器设置」中配置后端地址 |
| `pnpm desktop:demo` | **离线演示包**：web 以 MSW Mock 模式构建（内置演示数据），无需后端与数据库即可完整走查界面 |
| `pnpm desktop:dev` | 开发调试：直连本机 Vite 开发服务器（先 `pnpm dev:all` 启动 API 与 web） |
| `pnpm desktop:start` | 不打包，本地直接运行客户端（自动完成 web 构建） |
| `pnpm desktop:smoke` | 冒烟自检：启动 → 加载 → 截图至 `apps/desktop/smoke-output/screenshot.png` → 退出，供流水线断言 |

### 2. 服务器地址解析优先级

`apps/web/src/lib/api.ts` 的 `resolveApiBase()` 按以下顺序解析（与浏览器版共用同一实现）：

1. Mock 构建（`VITE_USE_MOCK=true`）：恒定相对路径，由 MSW 同源拦截；
2. 桌面端「服务器设置」（持久化于 `%APPDATA%/乐天QMS工作台/config.json`，保存即重载生效）；
3. 构建期环境变量 `VITE_API_BASE`（固化进安装包的默认地址，见 `.env.example`）；
4. 相对路径 `/api/v1`（浏览器同源部署：Vite 代理 / nginx 反代）。

只填主机与端口（如 `http://192.168.1.10:3000`）会自动补全 `/api/v1`；设置窗口的
「测试连接」通过主进程探测后端 `GET /health`。

### 3. 已知约束

- 后端在 `NODE_ENV=production` 下不注册开发态登录路由，而前端正式登录 UI 尚未实现，
  因此桌面客户端当前面向开发/测试环境后端（浏览器版同受此限）；生产部署前需先补齐正式登录流程。
- Fastify + PostgreSQL 仍集中部署在服务器，桌面客户端仅是展示层原生化；
  放行阻断、PBAC 行级隔离等中心化管控语义与浏览器版完全一致。
