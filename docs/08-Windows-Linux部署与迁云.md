# 乐天质量管理系统 (Letian QMS) - Windows/Linux 部署与迁云架构方案

> **版本**：v2.6.0  
> **面向场景**：工厂车间本地局域网私有化部署、混合云部署、公有云迁移  
> **服务组件**：PostgreSQL 15+、Fastify API 后端、Vite Web 前端、Electron 桌面客户端

---

## 1. Windows 本地化轻量级部署方案 (推荐现场初期使用)

针对工厂车间服务器常采用 Windows Server 或高配 Windows 10/11 工业主机的特点，系统提供高可靠的原生服务自启方案：

### 1.1 基础环境准备
1. 安装 **Node.js 20.x LTS**（配置系统环境变量 `PATH`）。
2. 安装 **PostgreSQL 15+**（设置端口为 5432，密码写入 `.env`）。
3. 确保防火墙放行前端 HTTP 端口（如 `31100` 或 `80`）及 API 端口（`8080`）。

> **客户服务器为 Windows Server 2008 R2 时的特殊口径（2026-10 已适配）**：
> 不走本节流程，直接使用 `deploy/` 自包含部署包（见包内 README.txt）。要点：
> - 运行时内置 **Node 14.21.3**（最后一个支持 2008 R2 的版本），需系统已打 **SP1**，
>   并安装包内 `redist\vc_redist.x64.exe`（VC++ 2015-2019，14.29 系列）。
> - 数据库下限为 **PostgreSQL 13**（迁移使用 `gen_random_uuid()`，PG 13 起内置；
>   PG 13 也是支持 2008 R2 的最后大版本），或使用内网远程 PG 13+。
> - 服务端已按 Node 14 重新编译（target ES2020）并通过兼容性审计与真机冒烟；
>   `pg` 锁定 8.16.0（8.18+ 依赖 Node 15+ 的 webcrypto），kysely / openapi3-ts /
>   mssql / tedious 由 `scripts/deploy/node14-patches/` 打语义等价补丁。
> - Node 14 已 EOL，仅限纯内网部署，严禁暴露公网。

### 1.2 利用 NSSM 配置服务开机自启
使用 NSSM (Non-Sucking Service Manager) 将服务注册为 Windows 原生系统服务：
```powershell
# 1. 注册 PostgreSQL 数据库自启（官方安装包通常已默认注册服务）

# 2. 注册后端 API 服务
nssm install LetianQmsApi "D:\Node.js\node.exe" "D:\乐天\letian-qms\apps\api\dist\server.js"
nssm set LetianQmsApi AppDirectory "D:\乐天\letian-qms"
nssm set LetianQmsApi AppStdout "D:\乐天\letian-qms\logs\api_server.log"
nssm set LetianQmsApi AppStderr "D:\乐天\letian-qms\logs\api_server.log"
nssm start LetianQmsApi

# 3. 注册前端 Web 静态托管服务 (使用 http-server 或 nginx)
nssm install LetianQmsWeb "D:\Node.js\node.exe" "C:\Users\Sll91\AppData\Roaming\npm\node_modules\http-server\bin\http-server" "D:\乐天\letian-qms\apps\web\dist -p 80 --proxy http://localhost:8080"
nssm start LetianQmsWeb
```

---

## 2. Linux 容器化生产部署方案 (Docker Compose)

对于标准化服务器环境，推荐采用 Docker Compose 一键拉起完整隔离容器：

### 2.1 编排架构 (`docker-compose.yml`)
```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15-alpine
    container_name: letian-postgres
    restart: always
    environment:
      POSTGRES_DB: letian_qms
      POSTGRES_USER: ${DB_USER:-postgres}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-letian123}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    container_name: letian-api
    restart: always
    environment:
      DATABASE_URL: postgresql://${DB_USER:-postgres}:${DB_PASSWORD:-letian123}@postgres:5432/letian_qms
      PORT: 8080
    depends_on:
      - postgres
    ports:
      - "8080:8080"

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    container_name: letian-web
    restart: always
    ports:
      - "80:80"
    depends_on:
      - api

volumes:
  pgdata:
```

### 2.2 Nginx 反向代理与 SSL 配置
```nginx
server {
    listen 80;
    server_name qms.letian.com;

    # 前端静态单页应用
    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }

    # 后端接口代理
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 50m;
    }
}
```

---

## 3. Electron 桌面客户端打包与分发 (`apps/desktop`)

为方便质检现场快速打开、连接本地蓝牙/USB量具（鲁班量具接口），提供原生跨平台桌面应用打包：
1. **打包构建指令**：
   ```bash
   pnpm --filter @letian/desktop run build
   ```
2. **产物输出目录**：`apps/desktop/release/`
   - 生成绿色免安装免配置版本：`Letian-QMS-Portable.exe`
   - 生成 Windows 标准安装包：`Letian-QMS-Setup-2.6.0.exe`
3. **现场离线模式**：桌面端支持本地 IndexedDB 缓存未提交的检验数据，防止车间弱网掉线导致录入数据丢失。

---

## 4. 迁云架构方案 (混合云 / 公有云上云路线图)

当企业将 IT 系统逐步迁入公有云（阿里云/腾讯云/华为云）时，推荐采用**混合云安全架构**：

```
┌────────────────────────────────────────────────────────┐
│                   公有云 VPC 安全内网                  │
│  ┌───────────────────────┐   ┌──────────────────────┐  │
│  │ SLB 负载均衡 (HTTPS)  │───│ ECS 应用集群 (Docker) │  │
│  └───────────────────────┘   └──────────┬───────────┘  │
│                                         │              │
│                              ┌──────────▼───────────┐  │
│                              │ 云 RDS PostgreSQL 15 │  │
│                              └──────────────────────┘  │
└───────────────────────────▲────────────────────────────┘
                            │ IPsec VPN / 专线加密穿透
┌───────────────────────────▼────────────────────────────┐
│                    工厂车间现场本地局域网              │
│  ┌─────────────────────────┐   ┌────────────────────┐  │
│  │ 管家婆 ERP (SQL Server) │   │ 车间质检工位 PC    │  │
│  └─────────────────────────┘   └────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

1. **核心原则**：云端 QMS 通过安全加密隧道（IPsec VPN 或 SD-WAN 专线）反向安全读取工厂本地管家婆数据库，严禁将工厂 ERP 直接暴露于公网。
2. **数据迁移**：通过 `pg_dump` 逻辑导出本地 PostgreSQL 数据表，在云 RDS 上直接恢复，平滑上云无停机时间损耗。
3. **备份与容灾**：开启 RDS 多可用区高可用与跨地域自动备份，恢复点目标 (RPO) < 5 分钟。

---

## 5. 客户 Windows Server 交接清单（2026-10-13 定稿口径）

客户现场确认口径：Windows Server 单机部署、纯内网访问、无域账号承诺、无第二台备份机。

| # | 事项 | 口径与操作 |
|---|------|-----------|
| 1 | **登录认证** | 职员独立口令（迁移 048）：`employees.password_hash` 存 scrypt 哈希；未设置的职员用共享初始口令（`DEFAULT_LOGIN_PASSWORD`，交付时必须改成高强度值并只告知管理员）首次登录后被强制改密（登录页弹「设置个人密码」，接口 `POST /api/v1/auth/change-password`）。管理员重置口令 = 把 `password_hash` 置 NULL。二期若客户确认有 AD 域，再接 LDAP |
| 2 | **HTTPS** | 客户确认纯内网，本期不做。交付文档注明「系统仅在内网以 HTTP 提供服务，不得将该端口映射至公网」 |
| 3 | **数据库备份** | 交付 `scripts/backup/`：`backup-qms.ps1`（pg_dump 每日全备 + 30 天轮换，Docker/原生两形态自适配，参数读 `.env`）+ `install-backup-task.ps1`（注册 Windows 计划任务，默认每日 02:00）。**遗留风险**：客户仅一台服务器，本机备份不防整机故障——交接时必须书面建议客户每天把 `D:\backups\qms` 拷到 NAS/移动硬盘（`scripts/backup/README.md` 内有 robocopy 命令模板） |
| 4 | **服务自启** | 走 §1.2 NSSM 原生方案（Windows Server 不装 Docker Desktop 亦可跑）；若客户已装 Docker 可用 `docker-compose.prod.yml` |
| 5 | **上线日顺序** | 装 PostgreSQL/Node → `pnpm db:migrate`（迁移 001–048）→ 配置 `.env`（DB/JWT/DEFAULT_LOGIN_PASSWORD）→ NSSM 注册 API 与 Web → 安装备份计划任务 → 管理员首次登录改密 → 按 `docs/UAT验收报告.md` 签字 |

