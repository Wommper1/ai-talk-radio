$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root 'tools\edge-tts'
$python = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path $python)) {
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($null -eq $launcher) {
        throw 'Python launcher not found. Install Python from python.org, then run npm run setup-edge-tts again.'
    }
    Write-Host 'Creating the station voice environment...'
    & $launcher.Source -3 -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Edge TTS environment.' }
}

Write-Host 'Installing the current Edge neural voice client...'
& $python -m pip install --disable-pip-version-check --upgrade edge-tts
if ($LASTEXITCODE -ne 0) { throw 'edge-tts installation failed.' }

Write-Host 'Checking available voices...'
& $python -m edge_tts --list-voices | Select-Object -First 8
if ($LASTEXITCODE -ne 0) { throw 'edge-tts installed but could not contact the voice service.' }

Write-Host ''
Write-Host 'Edge TTS is ready. Run npm run doctor for the complete station check.' -ForegroundColor Green
