@echo off
chcp 65001 >nul
title DeepSeek Harness Desktop
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\.bin\electron.cmd" (
  echo 首次运行：正在安装依赖（Electron），请稍候……
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

call npm start
if errorlevel 1 pause
