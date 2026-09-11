# Mission Control kiosk startup — one shortcut brings the wall panel up clean.
#
# 1. Kill any running backend (uvicorn app.main) and start a fresh one via
#    backend/dev.ps1 (which also does its own stop-then-start).
# 2. Kill any running frontend Vite dev server and start a fresh one.
# 3. Open a browser window at the kiosk URL with device scale forced to 100%,
#    so the panel renders 1:1 regardless of the host's Windows display scaling.
#
# Configuring the Invoke (voice / Wi-Fi speaker) is deliberately out of scope here.

param(
    [int]$BackendPort  = 8000,
    [int]$FrontendPort = 5173,
    [string]$KioskUrl  = ''
)

$ErrorActionPreference = 'Stop'
$repo     = Split-Path -Parent $PSScriptRoot
$backend  = Join-Path $repo 'backend'
$frontend = Join-Path $repo 'frontend'
if (-not $KioskUrl) { $KioskUrl = "http://localhost:$FrontendPort" }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# --- helpers ---------------------------------------------------------------

function Stop-ByCommandLine {
    param([string]$NameLike, [string]$CmdLike, [string]$What)
    Get-CimInstance Win32_Process -Filter "name='$NameLike'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like $CmdLike } |
        ForEach-Object {
            Write-Host "    stopping $What pid $($_.ProcessId)"
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { }
        }
}

function Stop-ByPort {
    param([int]$Port, [string]$What)
    try {
        $pids = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
                Select-Object -ExpandProperty OwningProcess -Unique
    } catch { $pids = @() }
    foreach ($processId in $pids) {
        Write-Host "    stopping $What on port $Port (pid $processId)"
        try { Stop-Process -Id $processId -Force -ErrorAction Stop } catch { }
    }
}

function Wait-ForPortFree {
    param([int]$Port, [int]$TimeoutSec = 10)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        } catch { $busy = $null }
        if (-not $busy) { return }
        Start-Sleep -Milliseconds 300
    }
    Write-Warning "port $Port still busy after ${TimeoutSec}s — the fresh server may pick a different port"
}

function Wait-ForHttp {
    param([string]$Url, [int]$TimeoutSec = 40)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 | Out-Null
            return $true
        } catch {
            # A 4xx/5xx still means the server is listening — good enough.
            if ($_.Exception.Response) { return $true }
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Find-Browser {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
    return $null
}

# --- 1. backend ----------------------------------------------------------------

Write-Step "Stopping any running backend"
Stop-ByCommandLine -NameLike 'python.exe' -CmdLike '*uvicorn*app.main*' -What 'backend'
Stop-ByPort -Port $BackendPort -What 'backend'
Wait-ForPortFree -Port $BackendPort

Write-Step "Starting a fresh backend (backend/dev.ps1)"
# dev.ps1 cd's to backend/, stops any stragglers again, then runs uvicorn in the
# foreground — so give it its own window.
Start-Process -FilePath 'pwsh.exe' `
    -ArgumentList '-NoLogo', '-NoProfile', '-NoExit', '-File', (Join-Path $backend 'dev.ps1') `
    -WorkingDirectory $backend

# --- 2. frontend -------------------------------------------------------------

Write-Step "Stopping any running frontend Vite dev server"
Stop-ByCommandLine -NameLike 'node.exe' -CmdLike '*vite*' -What 'vite'
Stop-ByPort -Port $FrontendPort -What 'frontend'
Wait-ForPortFree -Port $FrontendPort

Write-Step "Starting a fresh frontend (npm run dev)"
Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/k', 'npm', 'run', 'dev' `
    -WorkingDirectory $frontend

# --- 3. browser -------------------------------------------------------------

Write-Step "Waiting for $KioskUrl"
if (Wait-ForHttp -Url $KioskUrl -TimeoutSec 60) {
    Write-Host "    up" -ForegroundColor Green
} else {
    Write-Warning "frontend did not answer in time — opening the browser anyway"
}

$browser = Find-Browser
if (-not $browser) {
    Write-Warning "No Chrome or Edge found — open $KioskUrl manually."
    return
}

Write-Step "Opening $KioskUrl in $(Split-Path -Leaf $browser) at 100% device scale"
Start-Process -FilePath $browser -ArgumentList @(
    '--new-window',
    '--force-device-scale-factor=1',
    $KioskUrl
)

Write-Host ""
Write-Host "Kiosk starting. Backend and frontend each run in their own window;" -ForegroundColor Green
Write-Host "close those windows to stop them." -ForegroundColor Green
