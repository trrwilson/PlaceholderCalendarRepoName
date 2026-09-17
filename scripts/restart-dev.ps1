# Bounce the Mission Control backend + frontend dev processes running from THIS
# checkout, after pulling/merging a change during agent-driven development — the
# same stop-then-start dance an agent session otherwise repeats by hand every time.
# Unlike scripts/kiosk-start.ps1 (full device boot: backend + frontend + a fresh
# kiosk browser window), this is the tighter dev-loop version: no browser is opened,
# and each process is only stopped if it's actually running from this repo's own
# backend/frontend directories, so it's safe to run alongside other worktrees'
# dev servers on the same machine.
#
# Cycles the Invoke's mic feeder (`invokectl mic off` / `mic on`) around the
# backend restart by default — a backend restart has repeatedly left the feeder
# talking to a now-dead backend process, silently killing mic input until someone
# notices and cycles it by hand. Pass -SkipMic to leave the mic alone (e.g. this
# machine has no Invoke configured).
#
# Usage (from anywhere):
#   C:\...\PlaceholderCalendarRepoName\scripts\restart-dev.ps1
#   C:\...\PlaceholderCalendarRepoName\scripts\restart-dev.ps1 -SkipMic
#   C:\...\PlaceholderCalendarRepoName\scripts\restart-dev.ps1 -BackendPort 8000 -FrontendPort 5188
#
# Each port is auto-detected from whatever's currently listening (so it comes back
# up on the same port it was already using) and only falls back to the -BackendPort
# / -FrontendPort defaults when nothing was running yet.

param(
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5173,
    [switch]$SkipMic
)

$ErrorActionPreference = 'Stop'
$repo      = Split-Path -Parent $PSScriptRoot
$backend   = Join-Path $repo 'backend'
$frontend  = Join-Path $repo 'frontend'
# ReInvoke2026 is a separate sibling repo; not every checkout of this repo has it
# (or an Invoke to control), so its absence is a warning, never a hard failure.
$invokectl = 'C:\Users\trrwi\source\repos\ReInvoke2026\invoke\invokectl.ps1'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Get-CommandLinePort {
    param([string]$CommandLine, [string]$Flag)
    if ($CommandLine -match [regex]::Escape($Flag) + '\s+(\d+)') { return [int]$Matches[1] }
    return $null
}

function Stop-ThisRepoProcess {
    param([string]$NameLike, [string]$CmdLike, [string]$What)
    $matched = @()
    Get-CimInstance Win32_Process -Filter "name='$NameLike'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like $CmdLike } |
        ForEach-Object {
            $matched += $_.CommandLine
            Write-Host "    stopping $What pid $($_.ProcessId)"
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { }
        }
    return $matched
}

function Wait-ForPortFree {
    param([int]$Port, [int]$TimeoutSec = 10)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try { $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop } catch { $busy = $null }
        if (-not $busy) { return }
        Start-Sleep -Milliseconds 300
    }
    Write-Warning "port $Port still busy after ${TimeoutSec}s — the fresh process may pick a different port"
}

function Wait-ForHttp {
    param([string]$Url, [int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try { Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 | Out-Null; return $true }
        catch { if ($_.Exception.Response) { return $true } }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# --- mic off (before the bounce) --------------------------------------------

if (-not $SkipMic) {
    if (Test-Path $invokectl) {
        Write-Step "invokectl mic off"
        try { & $invokectl mic off } catch { Write-Warning "invokectl mic off failed: $_" }
    } else {
        Write-Warning "invokectl not found at $invokectl — skipping the mic cycle (-SkipMic silences this warning)"
        $SkipMic = $true
    }
}

# --- backend -----------------------------------------------------------------

Write-Step "Stopping backend"
# Not directory-scoped like frontend below: launching `python -m uvicorn` re-execs
# into a second interpreter (the venv shim, then the real Python312 process) and
# only the *first* hop's command line still carries this repo's path — the actual
# server-running process reports a bare `-m uvicorn app.main:app --port N` with no
# path at all. Killing only the first hop leaves the second one holding the port.
# In practice only one Mission Control backend runs at a time on a given machine,
# so the unscoped match is safe.
$backendCmds = Stop-ThisRepoProcess -NameLike 'python.exe' -CmdLike '*uvicorn*app.main*' -What 'backend'
foreach ($cmd in $backendCmds) { $found = Get-CommandLinePort -CommandLine $cmd -Flag '--port'; if ($found) { $BackendPort = $found } }
Wait-ForPortFree -Port $BackendPort

Write-Step "Starting a fresh backend on port $BackendPort (backend/dev.ps1)"
Start-Process -FilePath 'pwsh.exe' `
    -ArgumentList '-NoLogo', '-NoProfile', '-NoExit', '-File', (Join-Path $backend 'dev.ps1') `
    -WorkingDirectory $backend

# --- frontend ------------------------------------------------------------------

Write-Step "Stopping frontend"
# Scoped to this checkout's own frontend/node_modules — other worktrees run their
# own Vite dev servers on other ports and must not be touched by this script.
$frontendCmds = Stop-ThisRepoProcess -NameLike 'node.exe' -CmdLike "*vite*$frontend*" -What 'vite'
foreach ($cmd in $frontendCmds) { $found = Get-CommandLinePort -CommandLine $cmd -Flag '--port'; if ($found) { $FrontendPort = $found } }
# The npm wrapper's own script path is global (Program Files, not this repo), so it
# can't be directory-scoped like Vite above — scope it by the port it was told to
# forward instead, so a sibling worktree's npm wrapper (a different port) is left alone.
Stop-ThisRepoProcess -NameLike 'node.exe' -CmdLike "*npm-cli.js*--port $FrontendPort*" -What 'npm wrapper' | Out-Null
Wait-ForPortFree -Port $FrontendPort

Write-Step "Starting a fresh frontend on port $FrontendPort"
Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/k', 'npm', 'run', 'dev', '--', '--port', $FrontendPort, '--strictPort' `
    -WorkingDirectory $frontend

# --- mic on (after the backend is back) ---------------------------------------

if (-not $SkipMic) {
    Write-Step "Waiting for the backend before re-enabling the mic"
    # /api/privacy (not /api/calendar): a plain in-memory read with no upstream
    # provider round-trip, so it can't read as "still down" just because Graph is
    # slow to answer the calendar snapshot.
    if (Wait-ForHttp -Url "http://localhost:$BackendPort/api/privacy" -TimeoutSec 30) {
        Write-Step "invokectl mic on"
        try { & $invokectl mic on } catch { Write-Warning "invokectl mic on failed: $_" }
    } else {
        Write-Warning "backend didn't answer in time — run 'invokectl mic on' by hand once it's up"
    }
}

Write-Host ""
Write-Host "Restarted. Backend: http://localhost:$BackendPort  Frontend: http://localhost:$FrontendPort" -ForegroundColor Green
