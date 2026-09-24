# Local Talk Radio launcher.
#
# Starts the server if it is not already up, waits for it to answer, then opens
# the browser. The server runs as a child of this window, so closing the window
# stops the app.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$port = 3000
$url = "http://localhost:$port"
$server = $null

function Test-Health {
    param([string]$Base)
    try {
        $r = Invoke-WebRequest -Uri "$Base/api/health" -TimeoutSec 2 -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Write-Step {
    param([string]$Text)
    Write-Host "  $Text" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  Local Talk Radio" -ForegroundColor Yellow
Write-Host "  ----------------" -ForegroundColor DarkGray
Write-Host ""

# ── Node present? ────────────────────────────────────────────────────
try {
    $nodeVersion = (& node --version) 2>$null
    Write-Step "Node $nodeVersion"
} catch {
    Write-Host "  Node.js is not installed." -ForegroundColor Red
    Write-Host "  Install it from https://nodejs.org and run this again." -ForegroundColor Red
    Read-Host "`n  Press Enter to close"
    exit 1
}

# ── Dependencies up to date? ─────────────────────────────────────────
# The server runs straight from TypeScript source via tsx, so code changes are
# always picked up. Only dependencies can go stale, so compare package.json
# against the node_modules marker and reinstall when it has moved ahead.
$modules = Join-Path $root 'node_modules'
$pkg = Join-Path $root 'package.json'
$stamp = Join-Path $modules '.install-stamp'

$needsInstall = $false
if (-not (Test-Path $modules)) {
    $needsInstall = $true
    Write-Step "Installing dependencies (first run, this takes a minute)..."
} elseif (-not (Test-Path $stamp) -or (Get-Item $pkg).LastWriteTimeUtc -gt (Get-Item $stamp).LastWriteTimeUtc) {
    $needsInstall = $true
    Write-Step "Dependencies changed - updating..."
}

if ($needsInstall) {
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  npm install failed." -ForegroundColor Red
        Read-Host "`n  Press Enter to close"
        exit 1
    }
    New-Item -ItemType File -Path $stamp -Force | Out-Null
}

# A stale production build would be served instead of the current source, so
# make sure we never start in production mode by accident.
$env:NODE_ENV = 'development'
$env:ENABLE_HMR = 'false'

# ── Already running? Replace it, so this launch runs the newest code. ─
if (Test-Health $url) {
    Write-Step "An older instance is running - restarting it on the latest code..."
    $existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $existing) {
        try { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue } catch { }
    }
    # Give the port a moment to be released before rebinding it.
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-Health $url)) { break }
        Start-Sleep -Milliseconds 250
    }
}

# ── Is a model server up? Warn, but do not block. ────────────────────
$llmUp = $false
foreach ($probe in @('http://127.0.0.1:1234/v1/models', 'http://127.0.0.1:11434/v1/models')) {
    try {
        $null = Invoke-WebRequest -Uri $probe -TimeoutSec 2 -UseBasicParsing
        $llmUp = $true
        break
    } catch { }
}
if ($llmUp) {
    Write-Step "Model server detected."
} else {
    Write-Host "  No model server found on the usual ports." -ForegroundColor Yellow
    Write-Host "  Start LM Studio (Developer tab -> load a model -> Start Server)," -ForegroundColor Yellow
    Write-Host "  then pick the model in Settings. The app will still open." -ForegroundColor Yellow
}

# ── Start the server ─────────────────────────────────────────────────
# Say out loud which code this launch is about to run. A window left open all
# day serves whatever it compiled at boot, so "did my change take effect" is a
# question worth answering before the browser even opens.
$codeAt = Get-ChildItem -Path (Join-Path $root "src"), (Join-Path $root "server"), (Join-Path $root "server.ts") -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($codeAt) { Write-Step ("Code last changed {0:ddd HH:mm}" -f $codeAt.LastWriteTime) }

Write-Step "Starting..."

$npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue)
if ($null -eq $npx) { $npx = (Get-Command npx -ErrorAction SilentlyContinue) }
if ($null -eq $npx) {
    Write-Host "  npx was not found on PATH." -ForegroundColor Red
    Read-Host "`n  Press Enter to close"
    exit 1
}

# Deliberately NOT watch mode. tsx compiles from source at startup, so every
# launch already runs the newest code, and a watcher that restarts the server
# mid-show would kill the generation in progress.
$serverArgs = @('tsx', 'server.ts')
$server = Start-Process -FilePath $npx.Source -ArgumentList $serverArgs `
    -WorkingDirectory $root -NoNewWindow -PassThru

# Make sure the server does not outlive this window.
$stop = {
    if ($null -ne $server -and -not $server.HasExited) {
        try { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
}
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action $stop | Out-Null

# ── Wait for it to answer ────────────────────────────────────────────
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    if ($server.HasExited) { break }
    if (Test-Health $url) { $ready = $true; break }
    Start-Sleep -Milliseconds 700
}

if ($ready) {
    Write-Host ""
    Write-Host "  Ready at $url" -ForegroundColor Green
    Write-Host "  Close this window to stop the app." -ForegroundColor DarkGray
    Write-Host ""
    Start-Process $url
} else {
    Write-Host ""
    Write-Host "  The server did not start. Its output is below." -ForegroundColor Red
    Write-Host ""
}

# Hold the window open for as long as the server runs.
if (-not $server.HasExited) {
    Wait-Process -Id $server.Id
}

& $stop
Write-Host ""
Write-Host "  Stopped." -ForegroundColor DarkGray
Start-Sleep -Seconds 2
