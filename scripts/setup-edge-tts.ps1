$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root 'tools\edge-tts'
$python = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path $python)) {
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($null -eq $launcher) {
        throw 'Python was not found. Install Python 3 from https://www.python.org, then run this setup again.'
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
Write-Host 'Edge voices are ready. In the station, press Check again on the setup screen, or choose Edge under Settings.' -ForegroundColor Green
