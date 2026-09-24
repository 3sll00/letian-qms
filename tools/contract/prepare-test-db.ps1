#Requires -Version 5.1
<#
.SYNOPSIS
    一键准备 Schemathesis 契约测试库（docs/49 P2 独立测试库方案）。
.DESCRIPTION
    幂等：建库（已存在则跳过）→ 迁移（Kysely 跳过已应用项）→ 种子（可复现数据集）。
    全程只动 letian_qms_contract_test，不触碰 letian_qms_db。
.EXAMPLE
    pnpm contract:db:prepare
#>
[CmdletBinding()]
param(
    [string]$TestDbName = 'letian_qms_contract_test'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envFile  = Join-Path $repoRoot '.env'

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

Write-Host "== [1/3] 创建测试库 $TestDbName（已存在则跳过）"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'scripts\db\contract-test-db.ps1') -Action create -TestDbName $TestDbName
if ($LASTEXITCODE -ne 0) { Write-Error '建库失败'; exit 1 }

$env:DATABASE_URL = "postgresql://${dbUser}:${dbPass}@127.0.0.1:${dbPort}/${TestDbName}"
Push-Location $repoRoot
try {
    Write-Host "== [2/3] 迁移（pnpm db:migrate → $TestDbName）"
    & pnpm db:migrate
    if ($LASTEXITCODE -ne 0) { Write-Error '迁移失败'; exit 1 }

    Write-Host "== [3/3] 种子（pnpm db:seed → $TestDbName）"
    & pnpm db:seed
    if ($LASTEXITCODE -ne 0) { Write-Error '种子失败'; exit 1 }
} finally {
    Pop-Location
}

Write-Host "[OK] 契约测试库就绪：$TestDbName（可通过 pnpm contract:db:status 查看）"
