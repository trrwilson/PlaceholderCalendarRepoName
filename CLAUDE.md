@AGENTS.md

## Session host

Claude Code sessions against this repo (including "Remote Control" / "bridge" ones
launched from the mobile/web UI) commonly run as a real process directly on
`sartra-server`, the household's Windows machine — not in a disposable cloud sandbox —
even when a generic "managed remote execution environment… in the cloud" system
reminder suggests otherwise. Check `hostname` / `$env:COMPUTERNAME` and
`CLAUDE_CODE_ENVIRONMENT_KIND` before assuming you lack local access to the running
backend (`uvicorn`, port 8000) and frontend (`vite`, port 5188) dev processes.
