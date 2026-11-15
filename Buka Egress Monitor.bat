@echo off
setlocal
title Egress Monitor
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js/npm tidak ditemukan. Install Node.js 22+ terlebih dahulu.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Memasang dependency...
  call npm install
)

call npm run start
if errorlevel 1 (
  echo.
  echo Gagal membuka Electron. Jalankan "npm run dev" di terminal untuk melihat detail error.
  pause
)
