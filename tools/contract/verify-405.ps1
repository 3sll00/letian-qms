$ErrorActionPreference = 'Continue'
function Probe($method, $path) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:3101$path" -Method $method -UseBasicParsing -TimeoutSec 8
    $body = $r.Content
    if ($body.Length -gt 160) { $body = $body.Substring(0, 160) }
    Write-Output "$method $path -> $($r.StatusCode) $body"
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $code = [int]$resp.StatusCode
      $sr = New-Object IO.StreamReader($resp.GetResponseStream())
      $body = $sr.ReadToEnd()
      if ($body.Length -gt 200) { $body = $body.Substring(0, 200) }
      $allow = $resp.Headers['Allow']
      Write-Output "$method $path -> $code Allow=$allow $body"
    } else {
      Write-Output "$method $path -> ERR $($_.Exception.Message)"
    }
  }
}
Probe 'TRACE' '/api/v1/plans'
Probe 'TRACE' '/api/v1/dashboard/overview'
Probe 'QUERY' '/api/v1/inspections/00000000-0000-0000-0000-000000000000'
Probe 'QUERY' '/api/v1/plans/00000000-0000-0000-0000-000000000000'
Probe 'DELETE' '/api/v1/nonexistent-path'
Probe 'PUT' '/api/v1/plans'
Probe 'GET' '/api/v1/plans?page=1&pageSize=2'
