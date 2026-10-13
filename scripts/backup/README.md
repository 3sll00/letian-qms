# 乐天 QMS 数据库备份

面向客户 Windows Server 部署的定时备份方案。备份数据表含检验台账、MRB 评审、批次追溯、
审计日志、质检方案等全部业务数据——**丢库等于系统从头再来**，备份是上线前的必做项。

## 组成

| 文件 | 作用 |
|---|---|
| `backup-qms.ps1` | 执行一次备份：`pg_dump -Fc` 全库导出 → `qms-YYYYMMDD-HHmmss.dump`，自动轮换（默认保留 30 天）。自动适配 Docker / 原生两种部署形态，连接参数读项目 `.env` |
| `install-backup-task.ps1` | 在 Windows Server 上注册每日计划任务（默认 02:00，SYSTEM 身份） |

## 使用方法（客户服务器上执行，管理员 PowerShell）

```powershell
# 1. 试跑一次手动备份
powershell -ExecutionPolicy Bypass -File backup-qms.ps1

# 2. 注册每日定时任务（可改 -Time / -BackupDir / -RetainDays）
powershell -ExecutionPolicy Bypass -File install-backup-task.ps1

# 3. 验证：计划任务手动触发一次
schtasks /run /tn "LetianQMS-DbBackup"
```

原生 PostgreSQL 部署如 pg_dump 不在 PATH：`-PgBinDir "C:\Program Files\PostgreSQL\15\bin"`。

## 恢复演练（每季度至少一次）

```powershell
# 还原到临时库核对（不要还原到生产库名）
pg_restore -U postgres -d letian_qms_restore --create "D:\backups\qms\qms-YYYYMMDD-HHmmss.dump"
# 抽查三张表行数与生产库一致：inspection_orders / audit_logs / inspection_plans
```

## ⚠️ 必须告知客户的容灾边界

本方案默认备份落在**同一台服务器**的 `D:\backups\qms`——这只防「误删数据/库损坏」，
**不防服务器硬盘或整机故障**。交接时必须在文档中写明，并建议客户二选一：

1. **推荐**：准备一台 NAS 或另一台机器，每天把备份目录同步过去：
   ```
   robocopy D:\backups\qms \\NAS\qms-backup /MIR /R:3 /W:5
   ```
   可把这条命令追加进第二个计划任务（每天 02:30）。
2. 退而求其次：接一块移动硬盘/U 盘，每周人工拷贝一次。
