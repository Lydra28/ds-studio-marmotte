@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js absent du PATH. Installez Node.js LTS puis suivez README.md.
  pause
  exit /b 1
)
node scripts\launch.mjs
if errorlevel 1 pause
