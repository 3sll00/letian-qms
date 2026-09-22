#Requires -Version 5.1
<#
.SYNOPSIS
    乐天 QMS 本地 PostgreSQL 实例启停与体检（本机唯一受支持的数据库入口）。
.DESCRIPTION
    口径以 docs/23-本地数据库运行手册与端口口径.md 为准：
      * 数据目录：D:\letian-qms-pgdata（-DataDir 或环境变量 LETIAN_PGDATA 可覆盖）
      * 端口信源：仓库根 .env 的 DB_PORT（缺失时解析 DATABASE_URL，最后回落 5432）
      * 结构性防漂移：本脚本没有端口参数，启动端口永远等于 .env 的 DB_PORT
.PARAMETER Action
    status（默认，只读）/ doctor（完整体检）/ start / stop / restart
.PARAMETER DataDir
    PostgreSQL 数据目录，默认 D:\letian-qms-pgdata
.PARAMETER PgBin
    PostgreSQL 可执行目录，默认 D:\PostgreSQL\17\bin
.PARAMETER WaitSeconds
    pg_ctl 等待超时秒数，默认 60
.EXAMPLE
    pnpm db:local:start
.EXAMPLE
    pnpm db:local:doctor
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'doctor', 'start', 'stop', 'restart')]
    [string]$Action = 'status',

    [string]$DataDir = $(if ($env:LETIAN_PGDATA) { $env:LETIAN_PGDATA } else { 'D:\letian-qms-pgdata' }),

    [string]$PgBin = $(if ($env:LETIAN_PGBIN) { $env:LETIAN_PGBIN } else { 'D:\PostgreSQL\17\bin' }),

    [int]$WaitSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envFile  = Join-Path $repoRoot '.env'
$pgCtl    = Join-Path $PgBin 'pg_ctl.exe'
$pgReady  = Join-Path $PgBin 'pg_isready.exe'
$psqlExe  = Join-Path $PgBin 'psql.exe'
$logFile  = Join-Path $DataDir 'server.log'
$runnerTs = Join-Path $repoRoot 'packages\infrastructure\src\migrations\runner.ts'
$legacyPort = 55432

$script:Problems = New-Object System.Collections.Generic.List[string]
$script:Warnings = New-Object System.Collections.Generic.List[string]

function Write-Heading { param([string]$Text) Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok      { param([string]$Text) Write-Host "  [OK]   $Text" -ForegroundColor Green }
function Write-Info    { param([string]$Text) Write-Host "  [INFO] $Text" }
function Write-Warn    { param([string]$Text) Write-Host "  [WARN] $Text" -ForegroundColor Yellow; $script:Warnings.Add($Text) }
function Write-Fail    { param([string]$Text) Write-Host "  [FAIL] $Text" -ForegroundColor Red; $script:Problems.Add($Text) }

# 统一封装外部命令调用：外部命令往 stderr 写内容时，在 $ErrorActionPreference='Stop' 下
# 会被 PowerShell 转成终止性错误，这里临时放宽并统一把输出收敛成字符串行。
function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments)
    $code = -1
    $lines = @()
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $FilePath @Arguments 2>&1 | ForEach-Object { [string]$_ })
        $code = $LASTEXITCODE
    } catch {
        $lines = @([string]$_.Exception.Message)
    } finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ ExitCode = $code; Lines = $lines }
}

# 启动实例专用调用：经临时 .cmd + 文件重定向执行 pg_ctl，再轮询就绪，最后回读输出。
# 为什么不能直接 `& pg_ctl ... start`：无论走管道还是 `*>` 重定向，PowerShell 都会等待输出管道 EOF，
# 而 pg_ctl 派生出的 postgres 会一直持有该管道句柄 → 脚本永久「假死」（实测两次）。
# 也不能用 Start-Process -Wait 代替：PS 5.1 的 -Wait 会等到整棵进程树退出（含 postgres，实测 44.6s）。
function Invoke-PgCtlStart {
    param([int]$Port)
    $stamp = [guid]::NewGuid().ToString('N')
    $tempCmd = Join-Path $env:TEMP ('letian-pgctl-' + $stamp + '.cmd')
    $tempOut = Join-Path $env:TEMP ('letian-pgctl-' + $stamp + '.log')
    $commandLine = '@echo off' + "`r`n" + '"' + $pgCtl + '" -D "' + $DataDir + '" -l "' + $logFile +
        '" -o "-p ' + $Port + '" -w -t ' + $WaitSeconds + ' start > "' + $tempOut + '" 2>&1'
    Set-Content -LiteralPath $tempCmd -Value $commandLine -Encoding ASCII
    try {
        $null = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $tempCmd) -WindowStyle Hidden -PassThru
        $deadline = (Get-Date).AddSeconds($WaitSeconds + 10)
        while ((Get-Date) -lt $deadline) {
            if (Test-PgReady -Port $Port) { break }
            Start-Sleep -Milliseconds 500
            if (Test-Path -LiteralPath $tempOut) {
                $early = Get-Content -LiteralPath $tempOut -Raw -ErrorAction SilentlyContinue
                if ($early -match '(?i)could not|another server might be running|FATAL|failed to start') { break }
            }
        }
        $lines = @()
        if (Test-Path -LiteralPath $tempOut) {
            $lines = @(Get-Content -LiteralPath $tempOut -ErrorAction SilentlyContinue | ForEach-Object { [string]$_ })
        }
        return $lines
    } finally {
        Remove-Item -LiteralPath $tempCmd -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tempOut -Force -ErrorAction SilentlyContinue
    }
}

function Read-DotEnv {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $map }
    foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        $text = $line.Trim()
        if ($text.Length -eq 0) { continue }
        if ($text.StartsWith('#')) { continue }
        $idx = $text.IndexOf('=')
        if ($idx -lt 1) { continue }
        $key = $text.Substring(0, $idx).Trim()
        $val = $text.Substring($idx + 1).Trim()
        if ($val.Length -ge 2) {
            $first = $val.Substring(0, 1)
            $last = $val.Substring($val.Length - 1, 1)
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $val = $val.Substring(1, $val.Length - 2)
            }
        }
        $map[$key] = $val
    }
    return $map
}

function Resolve-DbPort {
    param([hashtable]$Map)
    if ($Map.ContainsKey('DB_PORT') -and "$($Map['DB_PORT'])" -match '^\d+$') { return [int]$Map['DB_PORT'] }
    if ($Map.ContainsKey('DATABASE_URL') -and "$($Map['DATABASE_URL'])" -match ':(\d{2,5})/') { return [int]$Matches[1] }
    return 5432
}

function Test-PgReady {
    param([int]$Port)
    if (-not (Test-Path -LiteralPath $pgReady)) { return $false }
    $result = Invoke-Native -FilePath $pgReady -Arguments @('-h', '127.0.0.1', '-p', "$Port", '-q')
    return ($result.ExitCode -eq 0)
}

function Get-ListenerPids {
    param([int]$Port)
    $pids = @()
    $netstat = Invoke-Native -FilePath 'netstat' -Arguments @('-ano', '-p', 'TCP')
    foreach ($row in $netstat.Lines) {
        if ([string]::IsNullOrWhiteSpace($row)) { continue }
        if ($row -notmatch 'LISTENING') { continue }
        if ($row -notmatch ":$Port\s") { continue }
        $cols = @(($row -split '\s+') | Where-Object { $_ -ne '' })
        if ($cols.Count -lt 4) { continue }
        $candidate = $cols[$cols.Count - 1]
        if ($candidate -match '^\d+$') { $pids += [int]$candidate }
    }
    return @($pids | Sort-Object -Unique)
}

function Invoke-PsqlScalar {
    param([string]$Sql, [int]$Port, [string]$User, [string]$Database, [string]$Password)
    if (-not (Test-Path -LiteralPath $psqlExe)) { return $null }
    $env:PGPASSWORD = $Password
    $env:PGCLIENTENCODING = 'UTF8'
    $result = Invoke-Native -FilePath $psqlExe -Arguments @('-h', '127.0.0.1', '-p', "$Port", '-U', $User, '-d', $Database, '-X', '-w', '-t', '-A', '-c', $Sql)
    if ($result.ExitCode -ne 0) { return $null }
    return (($result.Lines | Where-Object { $_ -ne $null }) -join "`n").Trim()
}

function Clear-StalePostmasterPid {
    param([string]$Directory)
    $pidFile = Join-Path $Directory 'postmaster.pid'
    if (-not (Test-Path -LiteralPath $pidFile)) { return $false }
    $first = $null
    try { $first = (Get-Content -LiteralPath $pidFile -TotalCount 1).Trim() } catch { return $false }
    if ($first -notmatch '^\d+$') { return $false }
    $ownerPid = [int]$first
    if (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue) { return $false }
    Remove-Item -LiteralPath $pidFile -Force
    return $true
}

function Get-RegisteredMigrations {
    if (-not (Test-Path -LiteralPath $runnerTs)) { return @() }
    $text = Get-Content -LiteralPath $runnerTs -Raw -Encoding UTF8
    $found = [regex]::Matches($text, "'(?<name>\d{3}_[a-z0-9_]+)'\s*:")
    $names = @()
    foreach ($item in $found) { $names += $item.Groups['name'].Value }
    return @($names | Sort-Object -Unique)
}

function Get-AppliedMigrations {
    param([int]$Port, [string]$User, [string]$Database, [string]$Password)
    $raw = Invoke-PsqlScalar -Sql 'select name from kysely_migration order by name' -Port $Port -User $User -Database $Database -Password $Password
    if ($null -eq $raw) { return [pscustomobject]@{ Ok = $false; Names = @() } }
    $names = @($raw -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d{3}_' })
    return [pscustomobject]@{ Ok = $true; Names = $names }
}

# ---------------------------------------------------------------------------
# 配置解析
# ---------------------------------------------------------------------------
$envMap  = Read-DotEnv -Path $envFile
$dbPort  = Resolve-DbPort -Map $envMap
$dbUser  = if ($envMap.ContainsKey('DB_USER')) { $envMap['DB_USER'] } else { 'letian_user' }
$dbName  = if ($envMap.ContainsKey('DB_NAME')) { $envMap['DB_NAME'] } else { 'letian_qms_db' }
$dbPass  = if ($envMap.ContainsKey('DB_PASSWORD')) { $envMap['DB_PASSWORD'] } else { '' }
$apiPort = if ($envMap.ContainsKey('API_PORT') -and "$($envMap['API_PORT'])" -match '^\d+$') { [int]$envMap['API_PORT'] } else { 0 }

function Show-Status {
    Write-Heading '本地 PostgreSQL 状态'
    Write-Info "仓库根         : $repoRoot"
    Write-Info ".env 的 DB_PORT: $dbPort"
    Write-Info "数据目录（约定）: $DataDir"
    Write-Info "库名 / 账号     : $dbName / $dbUser"

    if (-not (Test-Path -LiteralPath $pgCtl)) {
        Write-Fail "找不到 pg_ctl：$pgCtl（可用 -PgBin 指定 PostgreSQL 可执行目录）"
        return
    }
    if (-not (Test-Path -LiteralPath $DataDir)) {
        Write-Fail "找不到数据目录：$DataDir（可用 -DataDir 指定）"
        return
    }

    $ready = Test-PgReady -Port $dbPort
    $listeners = @(Get-ListenerPids -Port $dbPort)

    if ($ready) {
        Write-Ok "端口 $dbPort 已就绪（accepting connections），监听 PID：$($listeners -join ', ')"
    } else {
        Write-Fail "端口 $dbPort 无可用实例（no response），请执行：pnpm db:local:start"
    }

    if ($listeners.Count -eq 0) { Write-Fail "端口 $dbPort 没有任何监听进程" }

    if (-not $ready) { return }

    $version = Invoke-PsqlScalar -Sql 'show server_version' -Port $dbPort -User $dbUser -Database $dbName -Password $dbPass
    $actualDataDir = Invoke-PsqlScalar -Sql 'show data_directory' -Port $dbPort -User $dbUser -Database $dbName -Password $dbPass
    $actualPort = Invoke-PsqlScalar -Sql 'show port' -Port $dbPort -User $dbUser -Database $dbName -Password $dbPass
    $startedAt = Invoke-PsqlScalar -Sql "select to_char(pg_postmaster_start_time(), 'YYYY-MM-DD HH24:MI:SS')" -Port $dbPort -User $dbUser -Database $dbName -Password $dbPass
    $tableCount = Invoke-PsqlScalar -Sql "select count(*) from information_schema.tables where table_schema = 'public'" -Port $dbPort -User $dbUser -Database $dbName -Password $dbPass
    $migrationCount = Invoke-PsqlScalar -Sql 'select count(*) from kysely_migration' -Port $dbPort -User $dbUser -Database $dbName -Password $dbPass

    if ($null -eq $version) {
        Write-Fail "端口 $dbPort 可连通，但用 $dbUser@$dbName 取数失败：请核对 .env 的 DB_USER / DB_PASSWORD / DB_NAME"
        return
    }

    Write-Info "实例版本       : PostgreSQL $version"
    Write-Info "实例启动时间   : $startedAt"
    Write-Info "实例实际数据目录: $actualDataDir"
    Write-Info "实例实际端口   : $actualPort"
    Write-Info "业务表数量     : $tableCount"
    Write-Info "已应用迁移数   : $migrationCount"

    $normalizedExpected = (Resolve-Path -LiteralPath $DataDir).Path.Replace('\', '/')
    if ($actualDataDir -ne $normalizedExpected) {
        Write-Fail "实例实际数据目录（$actualDataDir）与约定（$normalizedExpected）不一致：可能起了另一个实例"
    } else {
        Write-Ok "实例实际数据目录与约定一致"
    }
    if ("$actualPort" -ne "$dbPort") {
        Write-Fail "实例实际端口（$actualPort）与 .env 的 DB_PORT（$dbPort）不一致：应用会连不上"
    } else {
        Write-Ok "实例实际端口与 .env 一致（$dbPort）"
    }
}

function Invoke-Start {
    Write-Heading "启动本地 PostgreSQL（端口 $dbPort）"
    if (-not (Test-Path -LiteralPath $pgCtl)) { Write-Fail "找不到 pg_ctl：$pgCtl（可用 -PgBin 指定）"; return }
    if (-not (Test-Path -LiteralPath $DataDir)) { Write-Fail "找不到数据目录：$DataDir（可用 -DataDir 指定）"; return }

    if (Test-PgReady -Port $dbPort) {
        Write-Ok "实例已在端口 $dbPort 正常服务，无需启动"
        return
    }

    $occupiers = @(Get-ListenerPids -Port $dbPort)
    if ($occupiers.Count -gt 0) {
        Write-Fail "端口 $dbPort 已被 PID $($occupiers -join ', ') 占用，但它不是可用的 PostgreSQL 实例；请先查明该进程"
        return
    }

    if (Clear-StalePostmasterPid -Directory $DataDir) {
        Write-Warn "已清理陈旧的 postmaster.pid（其中记录的进程已不存在）"
    }

    Write-Info ('执行：pg_ctl -D ' + $DataDir + ' -l server.log -o "-p ' + $dbPort + '" -w -t ' + $WaitSeconds + ' start')
    $lines = @(Invoke-PgCtlStart -Port $dbPort)
    foreach ($line in $lines) { if (-not [string]::IsNullOrWhiteSpace($line)) { Write-Info $line.Trim() } }

    if (Test-PgReady -Port $dbPort) {
        Write-Ok "启动成功：端口 $dbPort 已接受连接"
    } else {
        Write-Fail "启动失败：端口 $dbPort 未就绪，详见 $logFile"
    }
}

function Invoke-Stop {
    Write-Heading "停止本地 PostgreSQL（数据目录 $DataDir）"
    if (-not (Test-Path -LiteralPath $pgCtl)) { Write-Fail "找不到 pg_ctl：$pgCtl（可用 -PgBin 指定）"; return }

    if (-not (Test-PgReady -Port $dbPort) -and @(Get-ListenerPids -Port $dbPort).Count -eq 0) {
        Write-Ok "端口 $dbPort 无监听，实例本就未运行"
        return
    }

    $result = Invoke-Native -FilePath $pgCtl -Arguments @('-D', $DataDir, '-m', 'fast', '-w', '-t', "$WaitSeconds", 'stop')
    foreach ($line in $result.Lines) { if (-not [string]::IsNullOrWhiteSpace($line)) { Write-Info $line.Trim() } }
    if ($result.ExitCode -ne 0) { Write-Fail "pg_ctl stop 退出码 $($result.ExitCode)"; return }

    if (Test-PgReady -Port $dbPort) {
        Write-Fail "pg_ctl 报告成功但端口 $dbPort 仍有响应"
    } else {
        Write-Ok "已停止：端口 $dbPort 无监听"
    }
}

function Invoke-Doctor {
    Show-Status

    Write-Heading '历史端口与遗留物'
    $legacyListeners = @(Get-ListenerPids -Port $legacyPort)
    if ($legacyListeners.Count -gt 0) {
        Write-Fail "历史端口 $legacyPort 仍有监听（PID $($legacyListeners -join ', ')）：端口口径已被破坏，请查明并停止该实例"
    } else {
        Write-Ok "历史端口 $legacyPort 无监听（符合口径：仅 5432 有效）"
    }
    if (Test-Path -LiteralPath 'D:\PostgreSQL\17\data') {
        Write-Info '提示：D:\PostgreSQL\17\data 是安装器自带目录，本项目未使用，请勿用它启动实例'
    }

    Write-Heading '迁移一致性（注册表 vs 数据库）'
    $registered = @(Get-RegisteredMigrations)
    if ($registered.Count -eq 0) {
        Write-Warn "未能从 runner.ts 解析迁移注册表：$runnerTs"
    } else {
        $applied = Get-AppliedMigrations -Port $dbPort -User $dbUser -Database $dbName -Password $dbPass
        if (-not $applied.Ok) {
            Write-Warn '读不到 kysely_migration：数据库不可用或无权限，跳过迁移一致性检查'
        } else {
            $pending = @($registered | Where-Object { $applied.Names -notcontains $_ })
            $unknown = @($applied.Names | Where-Object { $registered -notcontains $_ })
            if ($pending.Count -gt 0) {
                Write-Fail ("未应用迁移 $($pending.Count) 个：" + ($pending -join ', ') + ' → 执行 pnpm db:migrate')
            } else {
                Write-Ok "迁移已到最新（注册表 $($registered.Count) 个，数据库 $($applied.Names.Count) 个）"
            }
            if ($unknown.Count -gt 0) { Write-Warn ("数据库存在注册表之外的迁移记录：" + ($unknown -join ', ')) }
        }
    }

    Write-Heading '应用连通性'
    if ($apiPort -gt 0) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$apiPort/health" -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -eq 200) { Write-Ok "API（:$apiPort）健康检查 200：$($response.Content)" }
            else { Write-Warn "API（:$apiPort）健康检查返回 $($response.StatusCode)" }
        } catch {
            Write-Warn "API（:$apiPort）不可达：$($_.Exception.Message)（若未启动后端可忽略：pnpm dev:all）"
        }
    } else {
        Write-Info '.env 未配置 API_PORT，跳过 API 连通性检查'
    }

    Write-Heading '容器路线可用性'
    $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
    if ($null -eq $dockerCmd) {
        Write-Info '未安装 docker CLI：本机只能走本地实例（pnpm db:local:*）'
    } else {
        $probe = Invoke-Native -FilePath 'docker' -Arguments @('version', '--format', '{{.Server.Version}}')
        if ($probe.ExitCode -eq 0) {
            Write-Warn 'Docker 守护进程可用：注意 pnpm db:up 会再起一个容器，可能与本地实例争抢 5432 端口'
        } else {
            Write-Ok 'Docker 守护进程未运行：pnpm db:up（容器路线）在本机不可用，请使用 pnpm db:local:start'
        }
    }

    Write-Heading '体检结论'
    if ($script:Problems.Count -eq 0) {
        Write-Host '  结论：OK（数据库实例与端口口径一致）' -ForegroundColor Green
    } else {
        Write-Host "  结论：发现 $($script:Problems.Count) 个问题" -ForegroundColor Red
        foreach ($item in $script:Problems) { Write-Host "    - $item" -ForegroundColor Red }
    }
    if ($script:Warnings.Count -gt 0) {
        Write-Host "  另有 $($script:Warnings.Count) 条提示，见上方 [WARN]" -ForegroundColor Yellow
    }
}

switch ($Action) {
    'status'  { Show-Status }
    'doctor'  { Invoke-Doctor }
    'start'   { Invoke-Start }
    'stop'    { Invoke-Stop }
    'restart' { Invoke-Stop; Invoke-Start }
}

if ($script:Problems.Count -gt 0) { exit 1 }
exit 0
