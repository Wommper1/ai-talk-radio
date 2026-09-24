$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$godot = Join-Path $projectRoot "tools\godot-4.7.2\Godot_v4.7.2-stable_win64.exe"
$healthUrl = "http://127.0.0.1:3000/api/world/v1/health"

if (-not (Test-Path -LiteralPath $godot)) {
    throw "Godot 4.7.2 was not found at $godot"
}

try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
} catch {
    $logDir = Join-Path $projectRoot "output"
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $stdout = Join-Path $logDir "realm-server.log"
    $stderr = Join-Path $logDir "realm-server-error.log"
    $server = Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev") `
        -WorkingDirectory $projectRoot -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $deadline = (Get-Date).AddSeconds(35)
    do {
        Start-Sleep -Milliseconds 500
        if ($server.HasExited) {
            throw "The realm server stopped during startup. See $stderr"
        }
        try {
            $null = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
            break
        } catch {}
    } while ((Get-Date) -lt $deadline)
    if ((Get-Date) -ge $deadline) {
        throw "The realm server did not become ready. See $stderr"
    }
}

Start-Process -FilePath $godot -ArgumentList @("--path", $PSScriptRoot) -WorkingDirectory $PSScriptRoot
