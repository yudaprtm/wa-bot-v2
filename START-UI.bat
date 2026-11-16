@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js belum ditemukan. Instal Node.js 24 LTS, lalu buka ulang terminal.
  pause
  exit /b 1
)
node web/server.js
pause
