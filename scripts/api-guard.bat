@echo off
rem ============================================================
rem  Letian QMS - API guard launcher (double-click entry)
rem  Starts scripts/api-guard.cjs which keeps apps/api alive:
rem  auto-restarts on crash and re-launches on health-check
rem  failure (frozen process). Logs go to logs\api-guard.log
rem  and logs\api.out.log
rem ============================================================

setlocal
set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
set "GUARD=%SCRIPT_DIR%api-guard.cjs"

if not exist "%GUARD%" (
    echo [ERROR] api-guard.cjs not found at "%GUARD%"
    pause
    exit /b 1
)

rem --- Locate node.exe ---
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "D:\Node.js\node.exe"             set "NODE_EXE=D:\Node.js\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
    echo [ERROR] node.exe not found in PATH or standard locations.
    pause
    exit /b 1
)

echo ============================================================
echo  Letian QMS - API guard
echo  Node   : %NODE_EXE%
echo  Guard  : %GUARD%
echo  Logs   : %REPO_ROOT%\logs\api-guard.log
echo  Press Ctrl-C in this window to stop the API.
echo ============================================================
echo.

pushd "%REPO_ROOT%"
"%NODE_EXE%" "%GUARD%"
set "RC=%ERRORLEVEL%"
popd

echo.
echo [api-guard] exited with code %RC%.
endlocal & pause
exit /b %RC%
