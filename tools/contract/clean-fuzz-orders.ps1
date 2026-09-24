#Requires -Version 5.1
<#
.SYNOPSIS
    修复契约测试库中 fuzz 产生的脏检验单（items[].sampleSize 非整数，
    就地 ceil 取整，与 domain 修复后行为一致）。
    仅限 letian_qms_contract_test，绝不触碰真实库。
#>
[CmdletBinding()]
param(
    [string]$TestDbName = 'letian_qms_contract_test',
    [string]$PgBin = $(if ($env:LETIAN_PGBIN) { $env:LETIAN_PGBIN } else { 'D:\PostgreSQL\17\bin' }),
    [switch]$Apply
)
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envFile = Join-Path $repoRoot '.env'
$psqlExe = Join-Path $PgBin 'psql.exe'
$map = @{}
foreach ($line in (Get-Content -LiteralPath $envFile -Encoding UTF8)) {
    $t = $line.Trim(); if ($t.Length -eq 0 -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('='); if ($i -lt 1) { continue }
    $map[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim().Trim('"').Trim("'")
}
$dbPort = if ($map['DB_PORT']) { $map['DB_PORT'] } else { '5432' }
$dbUser = if ($map['DB_USER']) { $map['DB_USER'] } else { 'letian_user' }
$env:PGPASSWORD = $map['DB_PASSWORD']; $env:PGCLIENTENCODING = 'UTF8'

# 非整数判定：值是 JSON 数字且去尾小数部分非零（5e-324 → true；50 / 50.0 → false）
$findSql = @"
SELECT o.id, o.order_no, it.elem->>'sampleSize' AS bad_sample_size
FROM inspection_orders o
CROSS JOIN LATERAL jsonb_array_elements(o.items) AS it(elem)
WHERE jsonb_typeof(it.elem->'sampleSize') = 'number'
  AND (it.elem->>'sampleSize')::numeric <> floor((it.elem->>'sampleSize')::numeric)
"@
Write-Host "== 脏行（items[].sampleSize 非整数）=="
& $psqlExe -h 127.0.0.1 -p $dbPort -U $dbUser -d $TestDbName -X -w -c $findSql

if ($Apply) {
    $fixSql = @"
UPDATE inspection_orders o
SET items = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(it.elem->'sampleSize') = 'number'
       AND (it.elem->>'sampleSize')::numeric <> floor((it.elem->>'sampleSize')::numeric)
      THEN jsonb_set(it.elem, '{sampleSize}',
                     to_jsonb(greatest(1, ceil((it.elem->>'sampleSize')::numeric)::int)))
      ELSE it.elem
    END
  )
  FROM jsonb_array_elements(o.items) AS it(elem)
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(o.items) AS it(elem)
  WHERE jsonb_typeof(it.elem->'sampleSize') = 'number'
    AND (it.elem->>'sampleSize')::numeric <> floor((it.elem->>'sampleSize')::numeric)
)
"@
    Write-Host "== 修复（ceil 取整，min 1）=="
    & $psqlExe -h 127.0.0.1 -p $dbPort -U $dbUser -d $TestDbName -X -w -c $fixSql
}
