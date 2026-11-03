@echo off
chcp 65001 >nul
title 天翼云电脑多账号自动化管理平台
cd /d "%~dp0"

echo ==========================================================
echo    天翼云电脑可视化多账号自动化控制平台 (Bun)
echo ==========================================================
echo.

where bun >nul 2>&1
if errorlevel 1 goto NO_BUN

if not exist node_modules goto INSTALL_DEPS
if not exist bun.lock goto INSTALL_DEPS

:START_SERVER
if "%ADMIN_PASSWORD%"=="" (
    echo [!] 首次启动请设置环境变量 ADMIN_PASSWORD（默认账号 ADMIN）
    echo     例如: set ADMIN_PASSWORD=your-strong-password
    echo     若 data 目录里已经有管理员账号，可忽略本提示。
    echo.
)
echo [*] 正在启动 Web 控制台服务...
echo [*] 启动后请在浏览器中访问: http://127.0.0.1:8571
echo.
bun server.ts
echo.
echo [!] 服务已停止运行。
pause
exit /b

:NO_BUN
echo [!] 错误: 检测到当前系统尚未安装 Bun 运行环境！
echo [*] 正在为您打开 Bun 官方安装说明...
start https://bun.com/docs/installation
echo.
echo [*] 请安装 Bun 1.4.4 或更高版本后，重新双击运行本脚本。
pause
exit /b 1

:INSTALL_DEPS
echo [*] 检测到首次运行，正在自动安装必要依赖...
call bun install --production --registry=https://registry.npmmirror.com
if errorlevel 1 (
    echo [!] 依赖安装失败，请检查网络连接后重试。
    pause
    exit /b 1
)
echo [*] 依赖安装完成！
echo.
goto START_SERVER
