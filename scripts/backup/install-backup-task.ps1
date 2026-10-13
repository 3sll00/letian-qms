<#
.SYNOPSIS
  在客户 Windows Server 上注册「乐天 QMS 数据库每日备份」计划任务。

.DESCRIPTION
  默认每天 02:00 以 SYSTEM 身份执行 backup-qms.ps1，备份目录 D:\backups\qms、保留 30 天。
  需以管理员身份运行。参数与 backup-qms.ps1 一致。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-backup-task.ps1
  powershell -ExecutionPolicy Bypass -File install-backup-task.ps1 -Time 03:30 -BackupDir 'E:\qms-backup'
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'LetianQMS-DbBackup',
  [string]$Time = '02:00',
  [string]$BackupDir = 'D:\backups\qms',
  [int]$RetainDays = 30,
  [string]$PgBinDir = ''
)

$ErrorActionPreference = 'Stop'

$script = Join-Path $PSScriptRoot 'backup-qms.ps1'
if (-not (Test-Path $script)) { throw "找不到备份脚本：$script" }

$extra = if ($PgBinDir -ne '') { " -PgBinDir `"$PgBinDir`"" } else { '' }
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -BackupDir `"$BackupDir`" -RetainDays $RetainDays$extra"

$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Description '乐天 QMS PostgreSQL 每日全库备份（pg_dump -Fc）' -Force | Out-Null

Write-Host "计划任务已注册：$TaskName（每天 $Time，备份到 $BackupDir，保留 $RetainDays 天）"
Write-Host ''
Write-Host '验证（立即试跑一次）：'
Write-Host "  schtasks /run /tn `"$TaskName`""
Write-Host "  然后查看 $BackupDir 下是否生成 qms-*.dump 与 logs\ 目录"
