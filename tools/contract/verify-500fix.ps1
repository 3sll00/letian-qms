#Requires -Version 5.1
# 复验 docs/49 §12.4 R1/R2 修复（临时脚本，跑完可删）
param([string]$Origin = 'http://localhost:3101')
$ErrorActionPreference = 'Continue'

$token = (Invoke-RestMethod -Uri "$Origin/api/v1/auth/login" -Method Post -ContentType 'application/json' -Body '{}').token
$headers = @{ Authorization = "Bearer $token" }

function Show-Result($name, $scriptBlock) {
    try {
        $r = & $scriptBlock
        Write-Host "== $name => HTTP $($r.StatusCode)"
        Write-Host ("   " + $r.Content.Substring(0, [Math]::Min(260, $r.Content.Length)))
    } catch {
        $resp = $_.Exception.Response
        if ($resp) {
            $code = [int]$resp.StatusCode
            $sr = New-Object IO.StreamReader($resp.GetResponseStream())
            $body = $sr.ReadToEnd()
            Write-Host "== $name => HTTP $code"
            Write-Host ("   " + $body.Substring(0, [Math]::Min(260, $body.Length)))
        } else {
            Write-Host "== $name => ERR $($_.Exception.Message)"
        }
    }
}

# R1: 垃圾路径参数 → 期望 400（不再 500）
Show-Result 'R1 toggle-active 垃圾 id' {
    Invoke-WebRequest -Uri "$Origin/api/v1/review-flows/x-not-a-uuid/toggle-active" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -UseBasicParsing
}

# R2a: 先取一个已存在的 flow id
$flows = Invoke-RestMethod -Uri "$Origin/api/v1/review-flows" -Headers $headers
$existingId = $flows.items[0].id
Write-Host "   existing flow id = $existingId (flowCode=$($flows.items[0].flowCode))"

# R2: POST 带已占用 id + 不同 flowCode → 期望 409（不再 500）
$body = @{
    id = $existingId
    flowCode = 'ZZ-CONFLICT-PROBE'
    flowName = 'conflict probe'
    applicableType = 'PROCESS_FAIL'
    version = 'v9.9.9'
    isActive = $false
    nodes = @(@{ roleCode = 'QA_MANAGER'; roleName = 'x'; nodeName = 'n'; nodeLevel = 1 })
} | ConvertTo-Json -Depth 6
Show-Result 'R2 POST /review-flows 重复主键' {
    Invoke-WebRequest -Uri "$Origin/api/v1/review-flows" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -UseBasicParsing
}

# 回归：合法 id 的 toggle-active 应 200（同一 id 往返两次回到原态）
Show-Result '回归 toggle-active 合法 id (1/2)' {
    Invoke-WebRequest -Uri "$Origin/api/v1/review-flows/$existingId/toggle-active" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -UseBasicParsing
}
Show-Result '回归 toggle-active 合法 id (2/2)' {
    Invoke-WebRequest -Uri "$Origin/api/v1/review-flows/$existingId/toggle-active" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -UseBasicParsing
}

# 无 Content-Type 的 POST → 期望 415（不再 500）
Show-Result '无 Content-Type POST → 415' {
    Invoke-WebRequest -Uri "$Origin/api/v1/review-flows/$existingId/toggle-active" -Method Post -Headers $headers -UseBasicParsing
}
