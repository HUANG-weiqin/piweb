@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-piweb.ps1" -Mode production

if errorlevel 1 (
  echo.
  echo Pi Web 启动失败。请查看上面的错误信息。
  pause
  exit /b 1
)

endlocal
