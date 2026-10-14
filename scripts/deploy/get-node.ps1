# get-node.ps1 — 下载便携版 Node 运行时到 deploy/node.exe
#
# 适用：客户服务器为 Windows Server 2008 R2 及以上 64 位。
# 说明：
#   - 默认下载 Node 16（适用于 Windows Server 2012 R2 及更新系统）。
#   - 若客户服务器「确为」Windows Server 2008 R2，请改用变量 $Version = "14.21.3"
#     （Node 14 是最后一个支持 Win7/2008 R2 的版本；Node 15+ 需要 Windows 8.1+）。
#   - 使用 BITS 传输，遇到网络抖动会自动重试/断点续传。
#
# 运行（在仓库根目录，需要 PowerShell 5.1+）：
#   powershell -ExecutionPolicy Bypass -File scripts/deploy/get-node.ps1

param(
  [string]$Version = "16.20.2",
  [string]$DestDir = "deploy"
)

$ErrorActionPreference = 'Stop'
$url = "https://nodejs.org/dist/v$Version/win-x64/node.exe"
$dest = Join-Path $Pwd $DestDir
if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }
$out = Join-Path $dest 'node.exe'

Write-Host "[get-node] 下载 $url -> $out"

# 若已存在部分文件，BITS 会从断点续传
$job = Start-BitsTransfer -Source $url -Destination $out -RetryInterval 60 -RetryTimeout 600 -Asynchronous
while ($job.JobState -eq 'Transferring' -or $job.JobState -eq 'Connecting' -or $job.JobState -eq 'Queued') {
  Start-Sleep -Seconds 5
  $pct = if ($job.BytesTotal -gt 0) { [math]::Round($job.BytesTransferred / $job.BytesTotal * 100) } else { 0 }
  Write-Host ("[get-node] 进度 {0}% ({1:N0}/{2:N0} bytes)" -f $pct, $job.BytesTransferred, $job.BytesTotal)
}
if ($job.JobState -eq 'Transferred') {
  Complete-BitsTransfer -BitsJob $job
  Write-Host "[get-node] 完成。文件大小: $((Get-Item $out).Length) 字节"
} else {
  Write-Error "[get-node] 下载失败，状态: $($job.JobState)"
  exit 1
}
