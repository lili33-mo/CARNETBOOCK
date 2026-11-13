@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js n'est pas installe.
  echo  Telechargez la version LTS sur https://nodejs.org puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo  Premiere utilisation : installation des composants...
  call npm install --omit=dev
  if errorlevel 1 ( pause & exit /b 1 )
)
start "" /min cmd /c "timeout /t 3 >nul & start http://localhost:3000"
call npm start
pause
