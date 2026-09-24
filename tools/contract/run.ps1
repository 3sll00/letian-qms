#Requires -Version 5.1
<#
.SYNOPSIS
    运行 Schemathesis 契约 fuzz（docs/49 P2）。
.DESCRIPTION
    默认打独立测试库 API（:3101 → letian_qms_contract_test）。
    -Get 只读模式仅跑 GET 操作（不写库，亦可在真实库上安全使用，需先起真实 API）。
.EXAMPLE
    pnpm contract:run                 # 全量 4 阶段打 :3101
.EXAMPLE
    pnpm contract:run:get             # 只 GET（只读）
.EXAMPLE
    tools\contract\run.ps1 -Origin http://localhost:3101 -MaxTime 600 -Examples 30
#>
[CmdletBinding()]
param(
    [string]$Origin = 'http://localhost:3101',
    [string]$Schema = 'docs/api/letian-qms-openapi.yaml',
    [int]$MaxTime = 300,
    [int]$Examples = 20,
    [int]$Workers = 4,
    [switch]$Get,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workDir  = $PSScriptRoot                             # tools\contract
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$stExe = Join-Path $workDir '.venv\Scripts\schemathesis.exe'
if (-not (Test-Path -LiteralPath $stExe)) {
    $stExe = Join-Path $workDir '.venv\Scripts\st.exe'
}
if (-not (Test-Path -LiteralPath $stExe)) {
    Write-Error "找不到 schemathesis 可执行文件：$workDir\.venv\Scripts（先 python -m venv tools\contract\.venv 并 pip install schemathesis==4.28.0）"
    exit 2
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportDir = Join-Path $workDir "reports\run-$stamp"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

$argsList = @(
    '--config-file', (Join-Path $workDir 'schemathesis.toml'),
    'run', (Join-Path $repoRoot $Schema),
    '--origin', $Origin,
    '--workers', "$Workers",
    '--max-time', "$MaxTime",
    '--max-examples', "$Examples",
    '--report', 'junit,json',
    '--report-dir', $reportDir
)
if ($Get) { $argsList += @('--include-method', 'GET') }
if ($ExtraArgs) { $argsList += $ExtraArgs }

# GBK 控制台下 rich 打印 ✅ 等字符会 UnicodeEncodeError，强制 Python UTF-8 输出
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

Write-Host "== Schemathesis run → $Origin（Get 模式=$($Get.IsPresent)）"
Write-Host "   报告目录：$reportDir"
Push-Location $workDir
try {
    & $stExe @argsList
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $code
