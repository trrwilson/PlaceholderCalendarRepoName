# Restart the Mission Control backend: stop any running uvicorn, start a fresh one.
# Run from anywhere:  C:\src\PlaceholderCalendarRepoName\backend\dev.ps1
# Must run from backend/ so .env and the token cache resolve — this script cd's there.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Get-CimInstance Win32_Process -Filter "name='python.exe'" |
    Where-Object { $_.CommandLine -like '*uvicorn*app.main*' } |
    ForEach-Object { Write-Host "stopping pid $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }

# Mirror stdout+stderr to backend/uvicorn.out.log (gitignored) as well as the
# console, so an agent session can read what a live -- or just-crashed --
# backend actually logged, even though this script was started by hand rather
# than via a redirected/backgrounded launch. The previous run's log is kept
# as uvicorn.out.log.previous (one rotation) instead of being overwritten:
# the most common reason to re-run this script is recovering from exactly the
# crash whose evidence overwriting it would destroy.
$logPath = Join-Path $PSScriptRoot 'uvicorn.out.log'
if (Test-Path $logPath) {
    Move-Item -Force $logPath (Join-Path $PSScriptRoot 'uvicorn.out.log.previous')
}
Write-Host "logging to $logPath (previous run, if any, is uvicorn.out.log.previous)"

# uvicorn/the app log routine INFO lines to stderr; with $ErrorActionPreference
# = 'Stop' still in effect, merging that into the success stream via 2>&1 would
# make PowerShell treat every one of those lines as a terminating
# NativeCommandError and kill the server after its first log line. Routine
# output from this long-running process is expected, not a script error, so
# relax back to the default for just this last command.
$ErrorActionPreference = 'Continue'
# Not Tee-Object: its default encoding is UTF-16, which reads as
# null-padded garbage through Unix-style tooling (grep/tail/an agent's own
# file-reading tools) even though PowerShell itself reads it fine -- the
# whole point here is a log any tool can read. Tee-Object's -Encoding param
# also doesn't exist on Windows PowerShell 5.1 (only pwsh 7+), and this
# script is launched by hand in whichever shell is at hand, so write the
# file directly with an explicit BOM-less UTF8Encoding instead -- portable
# across both.
$writer = [System.IO.StreamWriter]::new($logPath, $false, [System.Text.UTF8Encoding]::new($false))
try {
    & "$PSScriptRoot\.venv\Scripts\python.exe" -m uvicorn app.main:app --port 8000 2>&1 |
        ForEach-Object {
            $line = $_.ToString()
            Write-Host $line
            $writer.WriteLine($line)
            $writer.Flush()
        }
} finally {
    $writer.Dispose()
}
