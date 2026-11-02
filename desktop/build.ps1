# 构建 Accio Bridge 桌面宿主（Go + WebView2，无 CGO）
$ErrorActionPreference = "Stop"

$desktop = Split-Path -Parent $MyInvocation.MyCommand.Path
$root    = Split-Path -Parent $desktop
$out     = Join-Path $root "accio-desktop.exe"

$env:GOPROXY = "https://goproxy.cn,direct"
$env:CGO_ENABLED = "0"
if (-not $env:GOTOOLCHAIN) { $env:GOTOOLCHAIN = "local" }

Push-Location $desktop
try {
    Write-Host "go build -trimpath -ldflags '-H windowsgui -s -w' -o $out"
    go build -trimpath -ldflags "-H windowsgui -s -w" -o $out .
    if ($LASTEXITCODE -ne 0) { throw "go build 失败，退出码 $LASTEXITCODE" }
} finally {
    Pop-Location
}

if (-not (Test-Path $out)) { throw "构建产物不存在：$out" }
Write-Host "OK: $out"
exit 0