@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20 or newer is required: https://nodejs.org & pause & exit /b 1)
if not exist .env copy .env.example .env >nul
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
