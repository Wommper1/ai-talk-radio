# Create (or refresh) the "Local Talk Radio" shortcut on the Desktop.
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

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($linkPath)

# -WindowStyle Normal keeps the log visible; closing the window stops the app.
$link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$link.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
$link.WorkingDirectory = $root
$link.IconLocation = "$icon,0"
$link.Description = 'Two AI hosts talk to each other and the result is mixed into a radio show.'
$link.WindowStyle = 1
$link.Save()

# ── And the one that pre-records the openers.
#
# Not part of running the app, but the single most useful thing to have within
# reach: one run of it is the difference between a show that starts in half a
# second and one that spends minutes writing commercials before anybody speaks.
# It points at the .bat rather than at npm, because npm reads package.json from
# whatever folder you happen to be standing in.
$openersPath = Join-Path $desktop 'Make Radio Openers.lnk'
$openers = $shell.CreateShortcut($openersPath)
$openers.TargetPath = Join-Path $root 'Make-Openers.bat'
$openers.WorkingDirectory = $root
$openers.IconLocation = "$icon,0"
$openers.Description = 'Pre-record the station openers and commercials, so the show starts instantly instead of waiting on the model.'
$openers.WindowStyle = 1
$openers.Save()

Write-Host ""
Write-Host "  Shortcuts created:" -ForegroundColor Green
Write-Host "    $linkPath" -ForegroundColor DarkGray
Write-Host "    $openersPath" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Double-click the first to start the app." -ForegroundColor DarkGray
Write-Host "  Run the second once, with LM Studio open, to pre-record the openings." -ForegroundColor DarkGray
Write-Host ""
