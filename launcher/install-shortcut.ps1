# Create the "Local Talk Radio" shortcut on the Desktop.
#
# The shortcut runs launch.ps1, which starts the server and opens the browser.
# Run this again after moving the project folder.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'launch.ps1'
$icon = Join-Path $PSScriptRoot 'icon.ico'

if (-not (Test-Path $launcher)) {
    Write-Host "launch.ps1 is missing from $PSScriptRoot" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $icon)) {
    Write-Host "icon.ico is missing - generating it..." -ForegroundColor DarkGray
    Push-Location $root
    & npx tsx scripts/make-icon.ts
    Pop-Location
}

$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop 'Local Talk Radio.lnk'

if (Test-Path -LiteralPath $linkPath) {
    Write-Host "A desktop shortcut already exists at $linkPath. Leaving it untouched." -ForegroundColor Yellow
    exit 1
}

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($linkPath)

# -WindowStyle Normal keeps the log visible; closing the window stops the app.
$link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$link.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
$link.WorkingDirectory = $root
$link.IconLocation = "$icon,0"
$link.Description = 'Open the current local radio source in Google Chrome (or Microsoft Edge if Chrome is unavailable).'
$link.WindowStyle = 1
$link.Save()

Write-Host ""
Write-Host "  Shortcut created:" -ForegroundColor Green
Write-Host "    $linkPath" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Double-click it to start the latest local code." -ForegroundColor DarkGray
Write-Host "  Load the model in LM Studio yourself before making a show." -ForegroundColor DarkGray
Write-Host ""
