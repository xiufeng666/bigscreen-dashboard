@echo off
rem ==========================================================================
rem  BigScreen 大屏看板 -- Windows 启动脚本（面向最终用户）
rem
rem  用法：双击本脚本启动；或在命令行执行：
rem    start.bat -open                          启动并自动打开浏览器
rem    start.bat -port 9090 -open               指定端口并打开浏览器
rem    start.bat -password 我的密码 -open        开启编辑器/控制鉴权
rem    start.bat -data D:\bigscreen\data        指定数据目录
rem  完整参数：start.bat -h
rem ==========================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "BIN="
if exist "bigscreen-server_windows_amd64.exe" set "BIN=bigscreen-server_windows_amd64.exe"
if not defined BIN if exist "bigscreen-server_windows_386.exe" set "BIN=bigscreen-server_windows_386.exe"
if not defined BIN if exist "dist\bigscreen-server_windows_amd64.exe" set "BIN=dist\bigscreen-server_windows_amd64.exe"
if not defined BIN if exist "dist\bigscreen-server_windows_386.exe" set "BIN=dist\bigscreen-server_windows_386.exe"
if not defined BIN if exist "bigscreen-server.exe" set "BIN=bigscreen-server.exe"

if /i "%~1"=="-h" goto help
if /i "%~1"=="--help" goto help

if not defined BIN (
  echo 错误：未找到 BigScreen Windows 可执行文件。
  echo 请把 bigscreen-server_windows_amd64.exe 与本脚本放在同一目录后重试。
  pause
  exit /b 1
)

echo 正在启动 BigScreen 大屏看板...
echo   可执行文件: %BIN%
echo   大屏展示页: http://127.0.0.1:8080/      （端口以实际参数为准^）
echo   远程编辑器: http://127.0.0.1:8080/editor
echo   按 Ctrl+C 停止服务
echo.
"%BIN%" %*
echo.
echo 服务已停止。
pause
exit /b 0

:help
echo BigScreen 大屏看板 启动脚本
echo.
echo 用法: start.bat [参数]
echo   -port int          监听端口（默认 8080）
echo   -data string       数据目录（默认 .\data）
echo   -password string   编辑/控制鉴权密码，空=不鉴权
echo   -open              启动后自动打开浏览器展示大屏
echo   -version           打印版本号后退出
echo.
echo 示例: start.bat -open
echo       start.bat -port 9090 -password 123456 -open
exit /b 0
