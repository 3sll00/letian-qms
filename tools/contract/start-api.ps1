#Requires -Version 5.1
<#
.SYNOPSIS
    前台启动 Schemathesis 契约测试专用 API 实例（PORT=3101 → letian_qms_contract_test）。
.DESCRIPTION
    与真实 API（:3100 → letian_qms_db）完全隔离。前台运行，Ctrl+C 即停。
    后台运行可自行 Start-Process，日志建议落 logs\contract-api-3101.log。
.EXAMPLE
    pnpm contract:api
#>
[CmdletBinding()]
param(
    [int]$Port = 3101,
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

$env:PORT = "$Port"
$env:DATABASE_URL = "postgresql://${dbUser}:${dbPass}@127.0.0.1:${dbPort}/${TestDbName}"
$env:NODE_ENV = 'development'

Write-Host "== 契约测试 API：http://localhost:$Port → $TestDbName（前台，Ctrl+C 停止）"
Push-Location $repoRoot
try {
    & pnpm --filter @letian/api dev
} finally {
    Pop-Location
}
