# tools/contract — Schemathesis 契约测试工作区

> 依据：`docs/49-质量流程测试能力建设方案.md` §5 / §9.6（P2 · 契约漂移场景 · **独立测试库方案**）。
> Schemathesis 是**发请求**的黑盒 fuzz（含 POST/PATCH 写路径），因此**只打独立测试库**，
> 绝不打 `letian_qms_db` 真实库。

## 组成

| 文件 | 作用 |
|:---|:---|
| `.venv/` | Python 虚拟环境（`schemathesis==4.28.0`，Windows Python 3.14 安装；**不入库**） |
| `schemathesis.toml` | 鉴权配置：`[auth.dynamic.openapi.bearerAuth]` 自动走 `POST /api/v1/auth/login` 取 JWT |
| `prepare-test-db.ps1` | 一键准备测试库：建库 → 迁移 → 种子（幂等） |
| `start-api.ps1` | 以前台方式起 API（`PORT=3101` + `DATABASE_URL→letian_qms_contract_test`） |
| `run.ps1` | 执行 `st run`（默认参数打 `:3101`，可加 `-ExtraArgs` 透传） |
| `reports/` | 运行产物（JUnit / JSON / crash 文件；**不入库**） |

## 快速开始（三个终端 / 三步）

```powershell
# 1. 准备环境（首次 / 重建）
pnpm db:local:start            # 本地 PG 实例（D:\letian-qms-pgdata）
pnpm contract:db:prepare       # 建 letian_qms_contract_test + 迁移 + 种子

# 2. 起独立 API（前台，另开终端）
pnpm contract:api              # http://localhost:3101 → contract_test 库

# 3. 跑契约 fuzz（另开终端）
pnpm contract:run              # 全量 4 阶段（examples/coverage/fuzzing/stateful）
pnpm contract:run:get          # 只读模式：仅 GET，不写库（也可打真实库）
```

常用调节：
```powershell
# 限制时间预算 / 每操作例数 / 复现种子
tools\contract\.venv\Scripts\st.exe run docs/api/letian-qms-openapi.yaml `
  --origin http://localhost:3101 --max-time 300 -n 20 --seed 42
```

## 测试库生命周期

```powershell
pnpm contract:db:status        # 查看测试库规模
pnpm contract:db:drop          # 删除测试库（可重建，无副作用）
```

## 排障

- **鉴权 401**：`contract_test` 库未种子 → 跑 `pnpm contract:db:prepare`；
  登录端点仅在 `NODE_ENV!=production` 注册（`auth.controller.ts`）。
- **连不上 :3101**：`pnpm contract:api` 终端是否在前台运行；看 `logs/contract-api-3101.log`。
- **端口口径**：契约测试固定用 **3101**，与真实 API 的 **3100** 隔离，互不占用。
