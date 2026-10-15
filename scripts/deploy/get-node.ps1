# get-node.ps1 — 下载便携版 Node 运行时到 deploy/node.exe
#
# 适用：客户服务器为 Windows Server 2008 R2 及以上 64 位。
# 说明：
#   - 2008 R2 必须用 $Version = "14.17.6"（默认值）。这不是随口一说的"Node 14 都行"：
#     官方 win-x64 构建从 v14.18.0 起静态导入 WS2_32.dll 的 GetHostNameW
#     （Windows 8 / Server 2012+ 才有该导出），在 2008 R2 上运行 node.exe 会弹
#     「无法定位程序输入点 GetHostNameW 于动态链接库 WS2_32.dll 上。」
#     2026-10-14 经 PE 导入表二分实测：12.22.12 / 14.0.0 / 14.17.6 干净，
#     14.18.0 / 14.18.1 / 14.19.3 / 14.21.1+ 均带该导入；16.20.2 意外干净
#     （libuv 后期改动态解析），但 Node 16 官方不支持 2008 R2，不要用。
#   - 14.17.6 不支持 require('node:xxx') 前缀（14.18.0 才引入），部署包靠
#     node14-prefix-shim.cjs 垫片解决（start.bat / migrate.bat 已带 -r 参数）。
#   - Windows Server 2012 R2 及更新系统才可改用 Node 16（16.20.2）。
#   - 使用 BITS 传输，遇到网络抖动会自动重试/断点续传。
#
# 运行（在仓库根目录，需要 PowerShell 5.1+）：
#   powershell -ExecutionPolicy Bypass -File scripts/deploy/get-node.ps1

param(
  [string]$Version = "14.17.6",
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
