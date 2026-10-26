@echo off
rem ============================================================
rem  QwenWave - one-click local server launcher (Windows)
rem  Tries: py -> python -> node. Opens the browser itself.
rem ============================================================
cd /d "%~dp0"
title QwenWave

where py >nul 2>nul
if %errorlevel%==0 (
    echo [QwenWave] starting via: py
    py -3 serve.py
    goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
    echo [QwenWave] starting via: python
    python serve.py
    goto :end
)

where node >nul 2>nul
if %errorlevel%==0 (
    echo [QwenWave] starting via: node
    start "" http://localhost:8000
    node server.cjs
    goto :end
)

echo.
echo  [!] Neither Python nor Node.js was found on this PC.
echo.
echo  Easiest fix: install Python from  https://www.python.org/downloads/
echo  IMPORTANT: tick the box  "Add python.exe to PATH"  during install,
echo  then double-click start.bat again.
echo.
pause

:end
