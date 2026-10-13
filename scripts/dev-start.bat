@echo off
rem ============================================================
rem  Letian QMS local dev launcher (Windows double-click entry)
rem  Wraps dev-start.ps1 with -ExecutionPolicy Bypass so the
rem  script actually runs instead of opening in Notepad, and
rem  pauses on exit so any error stays visible.
rem ============================================================

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%dev-start.ps1"

if not exist "%PS_SCRIPT%" (
    echo [ERROR] dev-start.ps1 not found at "%PS_SCRIPT%"
    pause
    exit /b 1
)

rem --- Probe PowerShell binaries in well-known locations ---
rem Explorer-launched CMD often has a stripped PATH, so don't
rem rely on `where`. Try PowerShell 7 first, fall back to 5.1.

set "PS_EXE="
if exist "%ProgramFiles%\PowerShell\7\pwsh.exe"        set "PS_EXE=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not defined PS_EXE if exist "%ProgramFiles%\PowerShell\6\pwsh.exe" set "PS_EXE=%ProgramFiles%\PowerShell\6\pwsh.exe"
if not defined PS_EXE if exist "%LocalAppData%\Microsoft\PowerShell\7\pwsh.exe" set "PS_EXE=%LocalAppData%\Microsoft\PowerShell\7\pwsh.exe"
if not defined PS_EXE if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

rem Last resort: trust PATH
if not defined PS_EXE (
    where pwsh >nul 2>nul
    if %ERRORLEVEL% equ 0 set "PS_EXE=pwsh"
)
if not defined PS_EXE (
    where powershell >nul 2>nul
    if %ERRORLEVEL% equ 0 set "PS_EXE=powershell"
)

if not defined PS_EXE (
    echo [ERROR] Neither PowerShell 7 ^(pwsh.exe^) nor PowerShell 5.1 found.
    echo          Tried standard install locations under %%ProgramFiles%%,
    echo          %%LocalAppData%% and %%SystemRoot%%\System32\WindowsPowerShell.
    pause
    exit /b 1
)

echo ============================================================
echo  Letian QMS - local dev launcher
echo  PowerShell : %PS_EXE%
echo  Script     : %PS_SCRIPT%
echo  Press Ctrl-C to stop (auto-kills API and Web children)
echo ============================================================
echo.

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo [dev-start] Script exited cleanly.
) else (
    echo [dev-start] Script exited with code %RC%.
)
endlocal & pause
exit /b %RC%
