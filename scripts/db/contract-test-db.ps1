#Requires -Version 5.1
<#
.SYNOPSIS
    Schemathesis 契约测试专用独立库准备（docs/49 P2：独立测试库方案）。
.DESCRIPTION
    在同一本地 PG 实例（D:\letian-qms-pgdata，端口取 .env DB_PORT）内创建
    letian_qms_contract_test 库，用于承接 Schemathesis 写路径 fuzz，绝不触碰
    真实库 letian_qms_db。迁移与种子由 pnpm db:migrate / db:seed 在
    DATABASE_URL 指向本库时完成（见 tools/contract/README.md）。
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/db/contract-test-db.ps1 -Action create
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('create', 'drop', 'status')]
    [string]$Action = 'status',

    [string]$TestDbName = 'letian_qms_contract_test',
    [string]$PgBin = $(if ($env:LETIAN_PGBIN) { $env:LETIAN_PGBIN } else { 'D:\PostgreSQL\17\bin' })
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envFile  = Join-Path $repoRoot '.env'
$psqlExe  = Join-Path $PgBin 'psql.exe'

function Read-DotEnv {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $map }
    foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        $text = $line.Trim()
        if ($text.Length -eq 0 -or $text.StartsWith('#')) { continue }
        $idx = $text.IndexOf('=')
        if ($idx -lt 1) { continue }
        $map[$text.Substring(0, $idx).Trim()] = $text.Substring($idx + 1).Trim().Trim('"').Trim("'")
    }
    return $map
}

$envMap = Read-DotEnv -Path $envFile
$dbPort = if ($envMap['DB_PORT']) { $envMap['DB_PORT'] } else { '5432' }
$dbUser = if ($envMap['DB_USER']) { $envMap['DB_USER'] } else { 'letian_user' }
$dbPass = if ($envMap['DB_PASSWORD']) { $envMap['DB_PASSWORD'] } else { '' }
$adminDb = if ($envMap['DB_NAME']) { $envMap['DB_NAME'] } else { 'letian_qms_db' }

$env:PGPASSWORD = $dbPass
$env:PGCLIENTENCODING = 'UTF8'

function Invoke-Psql {
    param([string]$Sql, [string]$Database)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $psqlExe -h 127.0.0.1 -p $dbPort -U $dbUser -d $Database -X -w -t -A -c $Sql 2>&1
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prev }
    return [pscustomobject]@{ ExitCode = $code; Lines = @($out | ForEach-Object { [string]$_ }) }
}

$exists = Invoke-Psql -Sql "SELECT 1 FROM pg_database WHERE datname = '$TestDbName'" -Database $adminDb
$dbExists = ($exists.Lines -join "`n") -match '^\s*1\s*$'

switch ($Action) {
    'status' {
        if ($dbExists) {
            $tables = Invoke-Psql -Sql "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" -Database $TestDbName
            $migrations = Invoke-Psql -Sql "SELECT count(*) FROM kysely_migration" -Database $TestDbName
            Write-Host "[OK] $TestDbName 存在；public 表 $(($tables.Lines -join '').Trim()) 张，已应用迁移 $(($migrations.Lines -join '').Trim()) 条"
        } else {
            Write-Host "[INFO] $TestDbName 不存在"
        }
    }
    'create' {
        if ($dbExists) {
            Write-Host "[OK] $TestDbName 已存在，跳过创建"
        } else {
            $r = Invoke-Psql -Sql "CREATE DATABASE $TestDbName OWNER $dbUser" -Database $adminDb
            if ($r.ExitCode -ne 0) { Write-Error "建库失败：$($r.Lines -join ' ')"; exit 1 }
            Write-Host "[OK] 已创建 $TestDbName（owner=$dbUser）"
        }
        Write-Host "[NEXT] 迁移/种子：DATABASE_URL=postgresql://${dbUser}:***@127.0.0.1:${dbPort}/${TestDbName} pnpm db:migrate && pnpm db:seed"
    }
    'drop' {
        if (-not $dbExists) { Write-Host "[INFO] $TestDbName 不存在，无需删除"; exit 0 }
        $r = Invoke-Psql -Sql "DROP DATABASE $TestDbName" -Database $adminDb
        if ($r.ExitCode -ne 0) { Write-Error "删库失败：$($r.Lines -join ' ')"; exit 1 }
        Write-Host "[OK] 已删除 $TestDbName"
    }
}
