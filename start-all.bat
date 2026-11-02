@echo off
setlocal enabledelayedexpansion
title Accio Client & Gateway Bridge (Magpie Style)
cd /d "%~dp0"

echo ================================================================
echo        ACCIO CLIENT & GATEWAY BRIDGE (TERMINAL ONLY)
echo ================================================================
echo.

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js 18+ from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Step 1: Start Bridge background daemon via CLI
echo [1/3] Starting Accio Gateway Bridge daemon...
node "%~dp0bin\cli.js" daemon start

:: Step 2: Display Magpie-style terminal status card
echo.
echo [2/3] Inspecting Accio Work Client and Gateway Status:
echo ----------------------------------------------------------------
node "%~dp0bin\cli.js" status
echo ----------------------------------------------------------------

:: Step 3: Launch Accio Work Client directly via CLI launcher
echo.
echo [3/3] Launching Accio Work Client with GATEWAY_BASE_URL injected...
node "%~dp0bin\cli.js" launch

echo.
echo ================================================================
echo [READY] Bridge is active in background and Accio is hooked!
echo   - Check status : accio status
echo   - Test model   : accio test [model] [prompt]
echo   - Stop daemon  : accio daemon stop
echo ================================================================
echo.
timeout /t 5 >nul
