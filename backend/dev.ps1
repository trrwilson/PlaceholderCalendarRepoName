# Restart the Mission Control backend: stop any running uvicorn, start a fresh one.
# Run from anywhere:  C:\src\PlaceholderCalendarRepoName\backend\dev.ps1
# Must run from backend/ so .env and the token cache resolve — this script cd's there.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Get-CimInstance Win32_Process -Filter "name='python.exe'" |
    Where-Object { $_.CommandLine -like '*uvicorn*app.main*' } |
    ForEach-Object { Write-Host "stopping pid $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }

& "$PSScriptRoot\.venv\Scripts\python.exe" -m uvicorn app.main:app --port 8000
