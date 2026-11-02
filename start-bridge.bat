@echo off
setlocal enabledelayedexpansion
title Accio Gateway Bridge
cd /d "%~dp0"

echo ================================================================
echo                    ACCIO GATEWAY BRIDGE
echo       Local Router for Custom AI Models in Accio Desktop
echo ================================================================
echo.

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not found in your PATH!
    echo Please install Node.js 18 or higher from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VERSION=%%v
echo [OK] Node.js runtime detected: %NODE_VERSION%

:: Check if package.json has dependencies to install
if exist "package.json" (
    if not exist "node_modules" (
        echo [INFO] Verifying packages...
        call npm install --no-audit --no-fund --silent >nul 2>&1
    )
)

echo [OK] Dependencies verified.
echo.
echo ----------------------------------------------------------------
echo   Bridge Server:   http://127.0.0.1:8080
echo   CLI Management:  accio status ^| providers ^| models ^| test
echo ----------------------------------------------------------------
echo.
echo [INFO] Gateway running in foreground. Press Ctrl+C to stop.
echo Use 'start-all.bat' or 'accio launch' to run Accio Desktop.
echo Starting bridge process...
echo.

node src/server.js

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Bridge server exited with error code %ERRORLEVEL%.
    pause
)
