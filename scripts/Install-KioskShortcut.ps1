# Create (or refresh) a "Mission Control Kiosk" shortcut on the Desktop that runs
# scripts/kiosk-start.ps1. Run this once:
#
#   pwsh -ExecutionPolicy Bypass -File scripts\Install-KioskShortcut.ps1

$ErrorActionPreference = 'Stop'
$repo    = Split-Path -Parent $PSScriptRoot
$target  = Join-Path $PSScriptRoot 'kiosk-start.ps1'
$pwsh    = (Get-Command pwsh.exe -ErrorAction SilentlyContinue)?.Source
if (-not $pwsh) { $pwsh = (Get-Command powershell.exe).Source }

$lnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mission Control Kiosk.lnk'

$icon = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath       = $pwsh
$lnk.Arguments        = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$target`""
$lnk.WorkingDirectory = $repo
if ($icon) { $lnk.IconLocation = "$icon,0" }
$lnk.Description       = 'Restart the Mission Control backend + frontend and open the kiosk browser window'
$lnk.WindowStyle      = 7   # minimized — the launcher just spawns the two dev windows
$lnk.Save()

Write-Host "Shortcut written: $lnkPath" -ForegroundColor Green
