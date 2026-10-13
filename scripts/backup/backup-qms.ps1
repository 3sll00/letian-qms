<#
.SYNOPSIS
  乐天 QMS PostgreSQL 数据库定时备份脚本（Windows Server / 车间部署）

.DESCRIPTION
  - 用 pg_dump 生成自定义格式（-Fc，可 pg_restore 选择性还原）的全库备份；
  - 自动适配两种部署形态：
      1) Docker 部署   —— compose 里 postgres 服务在跑 → 容器内 pg_dump；
      2) 原生部署     —— NSSM 注册的本地 PostgreSQL → 本机 pg_dump（PgBinDir 指定 bin 目录）；
  - 连接参数从项目 .env 读取（DB_USER / DB_PASSWORD / DB_NAME / DB_PORT），密钥不进命令行；
  - 备份文件命名 qms-YYYYMMDD-HHmmss.dump，超过 RetainDays 天的旧文件自动删除；
  - 全程写日志文件，备份失败以非 0 退出（可接入告警/监控）。

.PARAMETER BackupDir  备份输出目录（默认 D:\backups\qms）
.PARAMETER RetainDays 保留天数（默认 30）
.PARAMETER PgBinDir   原生部署时 PostgreSQL 的 bin 目录（默认自动探测 C:\Program Files\PostgreSQL\*\bin）
.PARAMETER ComposeFile Docker 部署的 compose 文件路径（默认取仓库根目录 docker-compose.prod.yml）

.NOTES
  ⚠️ 备份只写本机 ≠ 真正容灾：服务器硬盘/整机故障会同时带走数据库与备份。
    交接清单必须包含「把 $BackupDir 每天拷到 NAS / 另一台机器 / 移动硬盘」的人工或脚本步骤。
#>
[CmdletBinding()]
param(
  [string]$BackupDir = 'D:\backups\qms',
  [int]$RetainDays = 30,
  [string]$PgBinDir = '',
  [string]$ComposeFile = '',
  [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

if ($RepoRoot -eq '') {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
if ($ComposeFile -eq '') {
  $ComposeFile = Join-Path $RepoRoot 'docker-compose.prod.yml'
}
$envFile = Join-Path $RepoRoot '.env'

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$logDir = Join-Path $BackupDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ('backup-' + (Get-Date -Format 'yyyyMMdd') + '.log')

function Log([string]$msg) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

# ---- 从 .env 读取连接参数（不打印值） ----
$envMap = @{}
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $m = [regex]::Match($_, '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$')
    if ($m.Success -and -not $_.TrimStart().StartsWith('#')) {
      $envMap[$m.Groups[1].Value] = $m.Groups[2].Value.Trim().Trim('"').Trim("'")
    }
  }
}
$dbUser = if ($envMap.ContainsKey('DB_USER') -and $envMap['DB_USER'] -ne '') { $envMap['DB_USER'] } else { 'postgres' }
$dbName = if ($envMap.ContainsKey('DB_NAME') -and $envMap['DB_NAME'] -ne '') { $envMap['DB_NAME'] } else { 'letian_qms' }
$dbPort = if ($envMap.ContainsKey('DB_PORT') -and $envMap['DB_PORT'] -ne '') { $envMap['DB_PORT'] } else { '5432' }
if ($envMap.ContainsKey('DB_PASSWORD') -and $envMap['DB_PASSWORD'] -ne '') {
  $env:PGPASSWORD = $envMap['DB_PASSWORD']
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $BackupDir "qms-$stamp.dump"

try {
  # ---- 形态探测：compose 里 postgres 服务在跑则走容器内 pg_dump ----
  $useDocker = $false
  $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($dockerCmd -and (Test-Path $ComposeFile)) {
    $psOut = & docker compose -f $ComposeFile ps --services --filter status=running 2>$null
    if ($LASTEXITCODE -eq 0 -and $psOut -match '^postgres$') { $useDocker = $true }
  }

  if ($useDocker) {
    Log "备份模式：Docker（compose postgres 服务） -> $dest"
    # 容器内 pg_dump 输出到 stdout，重定向落宿主机文件
    & docker compose -f $ComposeFile exec -T postgres pg_dump -U $dbUser -Fc $dbName | Out-File -FilePath $dest -Encoding Byte
    if ($LASTEXITCODE -ne 0) { throw "docker pg_dump 失败，exit=$LASTEXITCODE" }
  } else {
    # ---- 原生部署：定位 pg_dump ----
    if ($PgBinDir -eq '') {
      $found = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
      if ($found) { $PgBinDir = Split-Path $found.FullName }
    }
    $pgDump = if ($PgBinDir -ne '') { Join-Path $PgBinDir 'pg_dump.exe' } else { 'pg_dump' }
    if (-not (Get-Command $pgDump -ErrorAction SilentlyContinue)) {
      throw "找不到 pg_dump：原生部署请用 -PgBinDir 指定 PostgreSQL bin 目录"
    }
    Log "备份模式：原生（$pgDump，127.0.0.1:$dbPort/$dbName） -> $dest"
    & $pgDump -h 127.0.0.1 -p $dbPort -U $dbUser -Fc -f $dest $dbName
    if ($LASTEXITCODE -ne 0) { throw "pg_dump 失败，exit=$LASTEXITCODE" }
  }

  $size = (Get-Item $dest).Length
  if ($size -lt 1024) { throw "备份文件异常小（$size B），疑似空备份" }
  Log "备份完成：$dest（{0:N1} MB）" -f ($size / 1MB)

  # ---- 轮换：删除超龄备份 ----
  $cutoff = (Get-Date).AddDays(-$RetainDays)
  $removed = 0
  Get-ChildItem $BackupDir -Filter 'qms-*.dump' |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object { Remove-Item $_.FullName -Force; $removed += 1 }
  if ($removed -gt 0) { Log "轮换清理：删除 $removed 个超龄备份（>$RetainDays 天）" }

  Log '成功'
  exit 0
} catch {
  Log "失败：$($_.Exception.Message)"
  if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction SilentlyContinue }
  exit 1
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
