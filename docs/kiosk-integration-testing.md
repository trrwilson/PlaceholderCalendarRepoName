---
status: reference
summary: Running a topic branch on sartra-server for hands-on testing, and migrating credentials it creates back to the main checkout on merge. Includes the open migration log.
---

# Kiosk integration testing from a topic branch

How to put an unmerged branch on the household kiosk (`sartra-server`) for
hands-on evaluation without losing household state, and how to hand back
anything it changed when the branch merges.

## Running a branch on the device

The main checkout (the repo root, not a `.claude/worktrees/` worktree) is what
normally serves the kiosk. A topic branch runs from its own worktree.

1. **Dependencies:** create `backend/.venv` with the same packages as the main
   checkout's venv (voice/speech extras are installed there, not in
   `pyproject.toml`), run `npm ci` in `frontend/` and `eufy-bridge/`, and copy the
   git-ignored per-install model files (`frontend/public/models/wake/*.table`).
2. **`backend/.env`:** start from the main checkout's `.env`. Point every
   **household-state** file at the main checkout's copy by absolute path, so the
   list, notes, privacy lock, To Do state and eufy session aren't forked:
   `CALENDAR_SECONDARY_STATE_FILE`, `LISTS_FILE`, `TODO_STATE_FILE`, `NOTES_FILE`,
   `PRIVACY_STATE_FILE`, `EUFY_SESSION_FILE`, `EUFY_MEGA_SESSION_FILE`,
   `EUFY_CLIP_CACHE_DIR`, `EUFY_GALLERY_CACHE_DIR`, `PHOTOS_CACHE_DIR`, `VOICE_DEBUG_CAPTURE_DIR`
   (all `MISSION_CONTROL_`-prefixed). Then add the branch's own feature settings.
3. **Credentials:** the branch gets its **own copy** of
   `backend/.msal_token_cache.json`. Back up the main checkout's copy outside the
   repo first. Sign-ins done during the test (e.g. re-consent for a new scope) land
   only in the branch's copy, and main keeps working unchanged if the branch is
   abandoned.
4. **Switch over:** stop the main checkout's Vite on the kiosk port, then run the
   worktree's `scripts\restart-dev.ps1 -FrontendPort 5188`. The script replaces the
   backend from any checkout but only stops its own checkout's Vite.
5. **Switch back** (branch abandoned, or after merging): run the main checkout's
   `scripts\restart-dev.ps1 -FrontendPort 5188` after stopping the worktree's Vite.

## On merge: migrate branch-created credentials to main

Credentials created or upgraded during a branch's integration test **replace the
main checkout's copies when the branch merges.** Otherwise the household has to
sign in again, and the merged feature lacks its consent until someone notices.

1. Merge, then pull in the main checkout.
2. Stop the running backend. Back up the main checkout's credential files outside
   the repo.
3. Copy the branch worktree's credential files over the main checkout's (e.g.
   `backend/.msal_token_cache.json`).
4. Carry over the branch's feature settings from its `.env` into the main
   checkout's `.env`, leaving out the absolute household-state paths from step 2
   above.
5. Restart from the main checkout and check `python -m app.auth status` lists
   every account that was signed in before, and that the new feature's status is
   healthy.
6. Remove the entry from the log below.

Credential files are git-ignored and never committed. This doc records what to
move, not the secrets.

## Open migrations

| Branch / PR | Credential | What changed | Migrate to main |
|---|---|---|---|
| `claude/magical-hopper-amppbu` (PR #6, photo stream) | `backend/.msal_token_cache.json` | The photo-folder owner's account re-consents with `Files.Read` added (kiosk Settings → Add calendar) | Copy the worktree cache over main's. Copy the `MISSION_CONTROL_PHOTOS_*` lines from the worktree's `.env` into main's. |
| `worktree-bridge-cse_01EyabTcJ5H5KpCC1oqzyTx3` (To Do assignee + completion) | `backend/.msal_token_cache.json` (copied from the photo worktree, so it already holds `Files.Read`) | Members re-consent with `Tasks.ReadWrite` added (kiosk Settings → Add calendar) to tick tasks off | Copy this worktree's cache over main's; it supersedes the photo row above. No new `.env` settings. Its `backend/.venv` is a junction to the photo worktree's venv. |
