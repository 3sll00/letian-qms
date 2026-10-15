#Requires -Version 5.1
<#
.SYNOPSIS
    乐天 QMS 本地开发环境一键启动 (PostgreSQL + 数据库迁移 + API + Web)。

.DESCRIPTION
    面向 D:\乐天\letian-qms 的 Windows 开发机，复用现有脚本能力：
      * scripts/db/local-db.ps1 start  -> 启动本地 PostgreSQL（幂等，已运行则跳过）
      * pnpm db:migrate                 -> 跑到目前为止的迁移
      * pnpm --filter @letian/api run dev  -> 后台拉起 API（端口取自 .env.API_PORT，默认 3100）
      * pnpm --filter @letian/web run dev  -> 后台拉起 Web（端口取自 .env.WEB_PORT，默认 31100）

    子进程通过 Start-Process 脱离当前会话，日志分别写入 logs\dev-start-api.log /
    logs\dev-start-web.log。按 Ctrl-C 触发 Stop-AllChildren 干净回收所有子进程。

.PARAMETER SkipMigrate
    跳过数据库迁移步骤（用于纯前端调试或迁移已就绪的场景）。

.PARAMETER SkipDb
    跳过本地数据库启动与迁移检查（假设数据库已在外部由 db:local:start 启动）。

.PARAMETER ApiOnly
    只启动 API（不启动 Web）。

.PARAMETER WebOnly
    只启动 Web（不启动 API；依然会检查数据库，因为 Web 在 dev 模式直连）。

.PARAMETER WaitSeconds
    数据库就绪检查的等待超时秒数，默认 30。

.EXAMPLE
    .\scripts\dev-start.ps1
.EXAMPLE
    .\scripts\dev-start.ps1 -SkipMigrate
.EXAMPLE
    .\scripts\dev-start.ps1 -ApiOnly
#>
[CmdletBinding()]
param(
    [switch]$SkipMigrate,
    [switch]$SkipDb,
    [switch]$ApiOnly,
    [switch]$WebOnly,
    [int]$WaitSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot  = Split-Path -Parent $PSScriptRoot
$envFile   = Join-Path $repoRoot '.env'
$logsDir   = Join-Path $repoRoot 'logs'
$apiLog    = Join-Path $logsDir 'dev-start-api.log'
$webLog    = Join-Path $logsDir 'dev-start-web.log'
$dbScript  = Join-Path $PSScriptRoot 'db\local-db.ps1'

if ($ApiOnly -and $WebOnly) { throw '-ApiOnly 与 -WebOnly 互斥，只能选其一。' }

# 探测本机可用的 PowerShell 可执行文件（按 7 -> 6 -> 5.1 顺序）
# 子进程复用同一解释器，避免硬编码 pwsh 在只装了 5.1 的机器上炸
function Get-PowerShellExe {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
        (Join-Path $env:ProgramFiles 'PowerShell\6\pwsh.exe'),
        (Join-Path $env:LocalAppData 'Microsoft\PowerShell\7\pwsh.exe'),
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    )
    foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
    return 'powershell.exe'
}
$PSExe = Get-PowerShellExe

# 把 .env 解析到当前进程环境（Process 级），子进程继承
function Import-DotEnv {
    if (-not (Test-Path $envFile)) { return }
    Get-Content $envFile -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $eq = $line.IndexOf('=')
            $k  = $line.Substring(0, $eq).Trim()
            $v  = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
            [Environment]::SetEnvironmentVariable($k, $v, 'Process')
        }
    }
}

function Write-Heading { param([string]$Text) Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok      { param([string]$Text) Write-Host "  [OK]   $Text" -ForegroundColor Green }
function Write-Info    { param([string]$Text) Write-Host "  [INFO] $Text" }
function Write-Warn    { param([string]$Text) Write-Host "  [WARN] $Text" -ForegroundColor Yellow }
function Write-Fail    { param([string]$Text) Write-Host "  [FAIL] $Text" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 子进程管理
# ---------------------------------------------------------------------------
$script:Children = New-Object System.Collections.Generic.List[int]
$script:Stopped = $false

function Start-BackgroundPnpm {
    param(
        [Parameter(Mandatory)] [string]$FilterSpec,
        [Parameter(Mandatory)] [string]$LogPath,
        [Parameter(Mandatory)] [string]$Label
    )
    Write-Info "启动 $Label（日志: $LogPath）"
    # -RedirectStandardOutput / -RedirectStandardError：pnpm 与 tsx 的混合输出分流
    # -NoNewWindow：避免每个子进程弹新窗口
    # -WorkingDirectory：保证 pnpm workspace 解析正确
    $argList = @('--filter', $FilterSpec, 'run', 'dev')

    # pnpm 在 Windows 上可能是 .cmd / .exe / .ps1 shim。
    # Start-Process 只接真正的 Win32 可执行，碰到 .ps1 shim 会报
    # "%1 不是有效的 Win32 应用程序"。按文件后缀分派：
    #   .ps1 -> 走 powershell -File
    #   其他 -> 直接 Start-Process（cmd 自己处理 PATHEXT 解析）
    $pnpmCmd = (Get-Command pnpm -ErrorAction Stop).Source
    $pnpmExt = [System.IO.Path]::GetExtension($pnpmCmd).ToLowerInvariant()
    if ($pnpmExt -eq '.ps1') {
        $proc = Start-Process -FilePath $PSExe `
                              -ArgumentList (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $pnpmCmd) + $argList) `
                              -WorkingDirectory $repoRoot `
                              -RedirectStandardOutput $LogPath `
                              -RedirectStandardError ($LogPath + '.err') `
                              -NoNewWindow -PassThru
    } else {
        $proc = Start-Process -FilePath 'cmd.exe' `
                              -ArgumentList (@('/c', $pnpmCmd) + $argList) `
                              -WorkingDirectory $repoRoot `
                              -RedirectStandardOutput $LogPath `
                              -RedirectStandardError ($LogPath + '.err') `
                              -NoNewWindow -PassThru
    }
    $script:Children.Add($proc.Id)
    return $proc
}

function Stop-AllChildren {
    # 幂等：多次调用安全，避免主循环里 finally 与显式调用重复打印
    if ($script:Stopped) { return }
    $script:Stopped = $true
    Write-Heading '正在关闭后台子进程'
    foreach ($childPid in $script:Children) {
        if (-not (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) { continue }
        # /T 递归回收整棵子树：powershell -> pnpm.ps1 -> node -> tsx/vite
        # /F 强制结束。taskkill 自带 WIN32 API 调用，比 Stop-Process 链路更稳。
        # 注意：循环变量不能叫 $PID，那是 PowerShell 内置只读自动变量。
        $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        if (Test-Path $taskkill) {
            & $taskkill /T /F /PID $childPid 2>$null | Out-Null
        } else {
            try { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
    Write-Ok '已回收所有子进程。'
}

# Ctrl-C 触发干净停机（仅在真实控制台下生效；从 cmd /c 或重定向启动时跳过）
$hasConsole = $false
try {
    [void][Console]::CursorSize
    [Console]::TreatControlCAsInput = $false
    $hasConsole = $true
} catch {
    Write-Warn '当前没有真实控制台句柄（被 cmd /c / 重定向启动），跳过 Ctrl-C 处理器。'
}

if ($hasConsole) {
    $handler = [ConsoleCancelEventHandler]{
        param($sender, [ConsoleCancelEventArgs]$e)
        $e.Cancel = $true
        Stop-AllChildren
        exit 0
    }
    [Console]::add_CancelKeyPress($handler)
}

# ---------------------------------------------------------------------------
# 0. 前置体检
# ---------------------------------------------------------------------------
Write-Heading '0. 前置体检'

foreach ($cmd in 'node', 'pnpm') {
    $found = Get-Command $cmd -ErrorAction SilentlyContinue
    if (-not $found) { Write-Fail "$cmd 未在 PATH 中找到，请先安装。" ; throw "缺少 $cmd" }
    Write-Ok ("{0} -> {1}" -f $cmd, $found.Source)
}

if (-not (Test-Path $envFile)) {
    $example = Join-Path $repoRoot '.env.example'
    if (Test-Path $example) {
        Write-Warn ".env 不存在，自动从 .env.example 复制。"
        Copy-Item $example $envFile
    } else {
        Write-Fail ".env 与 .env.example 均不存在，无法继续。" ; throw '缺少 .env'
    }
} else {
    Write-Ok ".env 已存在"
}

Import-DotEnv
$apiPort = if ($env:API_PORT) { [int]$env:API_PORT } else { 3100 }
$webPort = if ($env:WEB_PORT) { [int]$env:WEB_PORT } else { 31100 }
$dbPort  = if ($env:DB_PORT)  { [int]$env:DB_PORT  } else { 5432 }
Write-Ok "端口口径: API=$apiPort  Web=$webPort  DB=$dbPort"

if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }

# ---------------------------------------------------------------------------
# 1. 启动本地 PostgreSQL
# ---------------------------------------------------------------------------
if (-not $SkipDb) {
    Write-Heading '1. 启动本地 PostgreSQL'
    if (-not (Test-Path $dbScript)) {
        Write-Fail "未找到 $dbScript，请确认仓库完整。" ; throw '缺 local-db.ps1'
    }
    & $PSExe -NoProfile -ExecutionPolicy Bypass -File $dbScript start
    if ($LASTEXITCODE -ne 0) { Write-Fail 'PostgreSQL 启动失败，请查看上方输出。' ; throw 'pg 启动失败' }

    # 等数据库就绪
    Write-Info "等待 PostgreSQL 端口 $dbPort 就绪（最多 $WaitSeconds 秒）..."
    $ready = $false
    for ($i = 0; $i -lt $WaitSeconds; $i++) {
        $c = Test-NetConnection -ComputerName 127.0.0.1 -Port $dbPort -InformationLevel Quiet -WarningAction SilentlyContinue
        if ($c) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { Write-Fail "PostgreSQL 端口 $dbPort 在 $WaitSeconds 秒内未就绪。" ; throw 'pg 未就绪' }
    Write-Ok 'PostgreSQL 已就绪。'
} else {
    Write-Heading '1. 跳过本地数据库（-SkipDb）'
}

# ---------------------------------------------------------------------------
# 2. 数据库迁移
# ---------------------------------------------------------------------------
if (-not $SkipMigrate -and -not $SkipDb) {
    Write-Heading '2. 数据库迁移'
    Push-Location $repoRoot
    try {
        pnpm db:migrate
        if ($LASTEXITCODE -ne 0) { Write-Fail '迁移失败，请查看上方输出。' ; throw 'migrate 失败' }
    } finally { Pop-Location }
    Write-Ok '迁移完成。'
} else {
    Write-Heading '2. 跳过迁移'
}

# ---------------------------------------------------------------------------
# 3. 启动 API / Web
# ---------------------------------------------------------------------------
Write-Heading '3. 启动后台服务'

if (-not $WebOnly) {
    $apiProc = Start-BackgroundPnpm -FilterSpec '@letian/api' -LogPath $apiLog -Label "API  :$apiPort"
}
if (-not $ApiOnly) {
    $webProc = Start-BackgroundPnpm -FilterSpec '@letian/web' -LogPath $webLog -Label "Web  :$webPort"
}

Write-Heading '启动完成'
Write-Host ("  API     http://localhost:{0}" -f $apiPort) -ForegroundColor Green
Write-Host ("  Web     http://localhost:{0}" -f $webPort) -ForegroundColor Green
Write-Host ""
Write-Host "  日志路径：" -ForegroundColor Cyan
Write-Host ("    API -> {0}" -f $apiLog)
Write-Host ("    Web -> {0}" -f $webLog)
Write-Host ""
Write-Host '  实时跟踪日志：'
Write-Host ('    Get-Content ''{0}'' -Wait' -f $apiLog)
Write-Host ('    Get-Content ''{0}'' -Wait' -f $webLog)
Write-Host ""
Write-Host "  按 Ctrl-C 干净停机（自动回收所有子进程）。" -ForegroundColor Yellow

# 主进程挂起，每 5 秒巡检一次子进程存活；任一被外部 kill 则一并退出
try {
    while ($true) {
        Start-Sleep -Seconds 5
        foreach ($childPid in @($script:Children)) {
            $p = Get-Process -Id $childPid -ErrorAction SilentlyContinue
            if ($null -eq $p) {
                Write-Warn "子进程 PID=$childPid 已退出，准备回收并退出主脚本。"
                Stop-AllChildren
                exit 1
            }
        }
    }
} finally {
    Stop-AllChildren
}
