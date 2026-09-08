@echo off
setlocal
cd /d "%~dp0"

rem ===== 自动定位 node =====
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "D:\Program Files\nodejs\node.exe" set "NODE_EXE=D:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE goto NONODE

echo.
echo ============================================
echo    claude-codebuddy-bridge  启动器
echo ============================================
echo    Base URL : http://127.0.0.1:8788
echo    配置     : config.json (日志开关/端口等, 详见 README)
echo    按 Ctrl+C 停止
echo --------------------------------------------
echo    可追加参数覆盖配置, 例如:
echo      start.bat --no-log             关闭日志
echo      start.bat --port 8789          换端口
echo      start.bat --doctor             预检后退出
echo --------------------------------------------
echo.

"%NODE_EXE%" src/index.js %*

echo.
echo 桥已退出（错误码 %errorlevel%）。
echo 若提示"端口被占用"，请换端口运行：start.bat --port 8789
pause
exit /b 0

:NONODE
echo [错误] 未找到 Node.js，请先安装 Node.js 18+：https://nodejs.org
pause
exit /b 1
