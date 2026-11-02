@echo off
setlocal enabledelayedexpansion
title Launch Accio with Custom Gateway
cd /d "%~dp0"

echo ================================================================
echo                ACCIO WORK CLIENT LAUNCHER
echo ================================================================
echo.

set GATEWAY_BASE_URL=http://127.0.0.1:8080
echo [CONFIG] Set GATEWAY_BASE_URL=%GATEWAY_BASE_URL%

set ACCIO_EXE=%LOCALAPPDATA%\Programs\Accio\Accio.exe

if not exist "%ACCIO_EXE%" (
    if exist "%ProgramFiles%\Accio\Accio.exe" (
        set ACCIO_EXE=%ProgramFiles%\Accio\Accio.exe
    ) else if exist "%ProgramFiles(x86)%\Accio\Accio.exe" (
        set ACCIO_EXE=%ProgramFiles(x86)%\Accio\Accio.exe
    ) else if exist "%USERPROFILE%\AppData\Local\Programs\Accio\Accio.exe" (
        set ACCIO_EXE=%USERPROFILE%\AppData\Local\Programs\Accio\Accio.exe
    )
)

if not exist "%ACCIO_EXE%" (
    echo [ERROR] Accio client executable was not found!
    echo Looked for: "%LOCALAPPDATA%\Programs\Accio\Accio.exe"
    echo.
    echo Please verify that Accio is installed, or set ACCIO_EXE manually:
    echo set ACCIO_EXE="C:\path\to\Accio.exe"
    echo.
    pause
    exit /b 1
)

echo [OK] Found Accio client: "%ACCIO_EXE%"
echo [OK] Launching Accio Desktop client via Gateway Bridge...
echo.

start "" "%ACCIO_EXE%"

echo [OK] Accio client started successfully!
timeout /t 3 >nul
