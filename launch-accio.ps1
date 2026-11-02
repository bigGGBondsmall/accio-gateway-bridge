<#
.SYNOPSIS
  Launches Accio Work Desktop client connected to the local Accio Gateway Bridge.

.DESCRIPTION
  Sets $env:GATEWAY_BASE_URL = "http://127.0.0.1:8080", checks that the bridge
  server is running (and offers to launch it if not), verifies the Accio executable,
  and starts Accio.
#>

[CmdletBinding()]
param(
    [string]$GatewayUrl = "http://127.0.0.1:8080",
    [string]$AccioPath = "$env:LOCALAPPDATA\Programs\Accio\Accio.exe",
    [switch]$NoBrowser
)

$Host.UI.RawUI.WindowTitle = "Accio Gateway Bridge Launcher"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "             ACCIO WORK CLIENT POWERSHELL LAUNCHER              " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check if Bridge server is responding
Write-Host "[1/3] Checking Accio Gateway Bridge status at $GatewayUrl ..." -ForegroundColor Gray
$bridgeOnline = $false
try {
    $res = Invoke-RestMethod -Uri "$GatewayUrl/healthz" -Method Get -TimeoutSec 2 -ErrorAction Stop
    if ($res.ok -eq $true) {
        $bridgeOnline = $true
        Write-Host "  [OK] Bridge is running (Upstream: $($res.upstream))" -ForegroundColor Green
    }
} catch {
    $bridgeOnline = $false
}

if (-not $bridgeOnline) {
    Write-Host "  [WARNING] Gateway Bridge is NOT running at $GatewayUrl" -ForegroundColor Yellow
    Write-Host "  Starting bridge server in a separate background window..." -ForegroundColor Yellow
    
    $bridgeScript = Join-Path $PSScriptRoot "start-bridge.bat"
    if (Test-Path $bridgeScript) {
        Start-Process -FilePath "cmd.exe" -ArgumentList "/k `"$bridgeScript`""
    } else {
        Start-Process -FilePath "node" -ArgumentList "src/server.js" -WorkingDirectory $PSScriptRoot
    }

    # Wait up to 10 seconds for bridge
    $waited = 0
    while ($waited -lt 20) {
        Start-Sleep -Milliseconds 500
        $waited++
        try {
            $res = Invoke-RestMethod -Uri "$GatewayUrl/healthz" -Method Get -TimeoutSec 1 -ErrorAction Stop
            if ($res.ok -eq $true) {
                $bridgeOnline = $true
                Write-Host "  [OK] Bridge is now active and ready!" -ForegroundColor Green
                break
            }
        } catch {}
    }

    if (-not $bridgeOnline) {
        Write-Host "  [WARNING] Bridge did not respond within 10s. Proceeding with launch..." -ForegroundColor Yellow
    }
}

# 2. Check Accio Executable
Write-Host "[2/3] Locating Accio Desktop client executable..." -ForegroundColor Gray
$candidates = @(
    $AccioPath,
    "$env:ProgramFiles\Accio\Accio.exe",
    "${env:ProgramFiles(x86)}\Accio\Accio.exe",
    "$env:USERPROFILE\AppData\Local\Programs\Accio\Accio.exe"
)

$targetExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $targetExe) {
    Write-Host "  [ERROR] Accio client executable not found!" -ForegroundColor Red
    Write-Host "  Checked standard locations:" -ForegroundColor Red
    $candidates | ForEach-Object { Write-Host "    - $_" -ForegroundColor DarkRed }
    Write-Host "`nPlease verify that Accio is installed, or pass -AccioPath 'C:\path\to\Accio.exe'." -ForegroundColor Yellow
    exit 1
}

Write-Host "  [OK] Located Accio client at: $targetExe" -ForegroundColor Green

# 3. Set Gateway Environment Variable & Launch Accio
Write-Host "[3/3] Setting GATEWAY_BASE_URL=$GatewayUrl and launching..." -ForegroundColor Gray
$env:GATEWAY_BASE_URL = $GatewayUrl

try {
    Start-Process -FilePath $targetExe
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "  [SUCCESS] Accio Desktop successfully launched with Gateway!   " -ForegroundColor Green
    Write-Host "  CLI Management:  accio status | providers | models | test    " -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host ""
} catch {
    Write-Host "  [ERROR] Failed to start Accio process: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
