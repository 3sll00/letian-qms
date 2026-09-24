$ErrorActionPreference = 'Continue'
$login = Invoke-RestMethod -Uri "http://localhost:3101/api/v1/auth/login" -Method Post -ContentType "application/json" -Body '{"userId":"11000000-0000-4000-8000-000000000001"}'
$tok = $login.token
if (-not $tok) { $tok = $login.accessToken }
Write-Output "token: $($tok.Substring(0,20))..."

# 1. GET 字面路径 /inspections/transfer-permits → 405（不再被 :id 吞掉）
$code = & curl.exe -s -o NUL -w "%{http_code}" -H "Authorization: Bearer $tok" http://localhost:3101/api/v1/inspections/transfer-permits
Write-Output "GET /inspections/transfer-permits -> $code (期望 405)"

# 2. POST /integration/sync/trigger MES → 200（task_name 不再超宽）
$resp = & curl.exe -s -w "`nHTTP:%{http_code}" -X POST -H "Authorization: Bearer $tok" -H "Content-Type: application/json" -d '{\"systemType\":\"MES\",\"syncScope\":\"ALL\"}' http://localhost:3101/api/v1/integration/sync/trigger
Write-Output "POST /integration/sync/trigger MES -> $resp"

# 3. POST /plans versionNo 空串 → 400（impl 拒绝，spec 现在也不生成）
$resp3 = & curl.exe -s -w "`nHTTP:%{http_code}" -X POST -H "Authorization: Bearer $tok" -H "Content-Type: application/json" -d '{\"planCode\":\"TEST-PLAN-X\",\"planName\":\"x\",\"inspectionType\":\"IQC\",\"versions\":[{\"versionNo\":\"\"}]}' http://localhost:3101/api/v1/plans
Write-Output "POST /plans versionNo='' -> $resp3"
