---
status: plan
summary: Photo Stream (#4): data-source vetting (OneDrive vs Google) and an implementation sketch for a Home slideshow tile.
---

# Mission Control: Photo Stream: research and design plan

Issue: [#4 "[Feature] Photo Stream"](https://github.com/trrwilson/PlaceholderCalendarRepoName/issues/4).
Status: **initial implementation (2026-11-09), behind `photos_enabled`.** The
OneDrive-folder path (§3) is built and covered by tests; see §8 for what was
built, the provisional defaults it chose, and the remaining gaps. Open questions
(§7) are still for the household to decide.

**Requirement as refined:** a Home tile that works like a digital photo frame. It
shows a slideshow of a household-curated set of photos, with a timed fade and
touch/swipe to go forward and back. It is display-only: nothing is deleted,
edited or given effects. On top of that, the photos come from an
**account-based cloud source the household curates** (an album or folder), not
just files on the server. The backend keeps a **cached local copy on disk** and
keeps it current with **incremental, rolling updates**, the same pattern as
`app/calendar/outlook_personal.py` and the eufy clip cache (`app/eufy/cache.py`).

> **Verification caveat.** `learn.microsoft.com` and `developers.google.com`
> could not be fetched directly from the research session (blocked by its
> network policy), so the claims below come from web-search excerpts of those
> pages and from established API behaviour. Claims marked **[verify]** must be
> confirmed against the live account with the validation script (§5.3) before
> implementation starts.

---

## 1. Recommendation (TL;DR)

**Use a OneDrive folder on the household's personal Microsoft account, read
through Microsoft Graph with delegated `Files.Read`, synced with
`/drive/items/{folder-id}/delta`, with downloaded display-sized renditions
(`c{W}x{H}` thumbnails) cached on disk.**

- It meets every part of the requirement. The household curates in a place they
  already use (drag photos into a folder from phone, PC or the OneDrive app).
  Delta gives true incremental sync. Thumbnails give server-side resizing and
  HEIC→JPEG conversion.
- It reuses the existing MSAL device-code flow, the token cache, and the
  first-party Graph CLI client. No new vendor, SDK or credential type.
- **OneDrive albums are a fallback, not the primary.** They exist only on
  personal accounts, and there is no documented incremental (delta) feed for
  album membership, so syncing one means polling its children.
- **Google is not needed and is weak.** Since 31 March 2025 the Photos Library
  API can no longer read a user's albums or shared albums. The Picker API is a
  one-off, user-driven selection, not a curated album that updates itself.
  Google Drive `changes.list` would work technically, but needs a *restricted*
  scope and brings in a second identity provider.

---

## 2. Phase 1: data-source vetting

### 2.1 Candidate A: OneDrive folder (Microsoft Graph). **Recommended**

| Aspect | Detail |
|---|---|
| Curation model | One folder, e.g. `Pictures/Mission Control`. Anything in it (optionally including subfolders) is in the stream. The household adds or removes photos with any OneDrive client. |
| Resolve folder | `GET /me/drive/root:/{path}` → `id`, once at startup; store the id in state. Moving or renaming the folder doesn't break it, because sync follows the id. |
| Initial list | `GET /me/drive/items/{id}/delta?$select=id,name,file,image,photo,deleted,parentReference,cTag,eTag,size,lastModifiedDateTime` and follow `@odata.nextLink` to the end. The last page carries `@odata.deltaLink`. (`children` paging works too, but delta gives you the deltaLink for free.) |
| Incremental | Call the stored `@odata.deltaLink`. It returns only changed items: new, modified (new `cTag`), or tombstones with a `deleted` facet. Persist the new deltaLink after **every** fully consumed round. |
| Delta scope | Folder-scoped delta is documented for **personal OneDrive**. On **OneDrive for Business / SharePoint, delta is only supported on the drive root** ([driveItem delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0), Remarks, as quoted in [this mirrored SO thread](https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/56133533/onedrive-shared-folder-deltas)) **[verify]**. For a work account: root delta, then filter on `parentReference.path` under the folder. That works, but every change in the drive comes through. |
| Delta expiry / resync | An expired or unusable token returns **HTTP 410 Gone** with a `resyncRequired`-family error code and a `Location` header holding a fresh enumeration link ([driveItem delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta)). Handling: start a full enumeration, build the set of ids seen, **reconcile** (evict cache entries not seen, download new ones), then store the new deltaLink. Nothing visible happens to the household; the tile keeps showing the cache throughout. |
| Images for 4K | `GET /me/drive/items/{id}/thumbnails/0/c{W}x{H}/content` gives a server-rendered JPEG at a custom size ([list thumbnails](https://learn.microsoft.com/en-us/graph/api/driveitem-list-thumbnails)). A larger image than requested may come back. Request the tile's maximum on-screen size (e.g. `c2560x1440`; the tile will never be full 4K), not the original. This also handles **HEIC** (iPhone default) and huge originals, which browsers may not decode. `$expand=thumbnails` is available on list calls but returns only the standard sizes. Whether custom sizes are limited on Business is unclear: the Remarks text was truncated in search **[verify]**. |
| Originals (fallback) | `@microsoft.graph.downloadUrl` on the item: a short-lived, pre-authenticated URL (minutes to an hour), so use it straight away and never store it. Use it only when a thumbnail fails, and only for JPEG/PNG/WebP. |
| Metadata worth keeping | `image.width/height` (orientation and letterboxing before the bytes arrive), `photo.takenDateTime` (ordering, "on this day" later), `file.mimeType` (skip videos), `cTag` (content changed → re-download). |
| Auth | Delegated only. Personal: `Files.Read` (the user's own files). `Files.Read.All` is needed only for **items shared with** the account (e.g. a folder another household member shares) **[verify]**. Application permissions don't apply to personal accounts. |
| Existing app reuse | `outlook_personal.py` uses the **Microsoft Graph Command Line Tools** first-party client (`14d82eec-…`) against `/consumers`. That client supports dynamic consent, so a device-code sign-in asking for `["Files.Read"]` (or `Calendars.Read Files.Read`) should work with **no new app registration** **[verify]**. MSAL stores the extra refresh-token grant in the same `.msal_token_cache.json`; `acquire_token_silent(["Files.Read"], account)` then works next to the calendar scope. Calendar code is unaffected. |
| Throttling | Graph returns 429/503 with `Retry-After`; honour it and back off ([throttling](https://learn.microsoft.com/en-us/graph/throttling)). At one delta call every few minutes plus a handful of thumbnail downloads a day, this household stays orders of magnitude under any limit. Spread the initial download (e.g. 2–4 at a time) instead of fetching 500 thumbnails in parallel. |
| Rate of change | Curated folders change rarely (a few photos a week). A 5–15 minute delta interval is plenty, and an empty delta round costs one small request. |
| ToS / policy | First-party, documented, supported API used for its intended purpose (read your own files). No ToS concern, unlike eufy. |
| **Verdict** | **Meets the requirement fully on personal accounts; workable but noisier on work/school accounts (root-only delta). Recommended.** |

### 2.2 Candidate B: OneDrive albums (driveItem `bundle` + `album` facet)

| Aspect | Detail |
|---|---|
| List albums | `GET /me/drive/bundles?$filter=bundle/album ne null` ([list bundles](https://learn.microsoft.com/graph/api/bundle-list?view=graph-rest-1.0)). |
| Album contents | `GET /me/drive/items/{bundle-id}/children`. Bundles hold *references*: the photos stay where they live (usually Camera Roll), so a single photo can be in several albums. |
| Account support | **Personal OneDrive only**: "Collection of bundles (albums and multi-select-shared sets of items). Only in personal OneDrive." ([drive resource](https://learn.microsoft.com/en-us/graph/api/resources/drive)). Not available on work/school accounts. |
| Incremental | **No documented album-scoped delta.** Root delta reports changes to the underlying files, but it is not documented to report *album membership* changes **[verify]**. In practice: re-list `children` on every poll and diff ids and `cTag`s against the manifest. That's cheap for a few hundred photos, but it isn't the delta pattern the requirement names. |
| Auth / images | Same as A: `Files.Read`, thumbnails, downloadUrl. |
| UX | Probably the most natural curation for the household ("add to the Mission Control album" in the OneDrive Photos view, without moving files). Microsoft has been reworking OneDrive's Photos experience; album support in the API is long-standing but gets little attention. |
| **Verdict** | **Viable secondary mode on personal accounts, with polling instead of delta.** Worth it only if the household strongly prefers albums to a folder (open question Q1). The sync design (§3) handles both, because only the "list changes" step is different. |

### 2.3 Candidate C: Google Photos (Library API / Picker API)

| Aspect | Detail |
|---|---|
| Library API (since 31 Mar 2025) | `photoslibrary.readonly`, `photoslibrary.sharing` and `photoslibrary` were **removed**. Calls that rely on them return 403. The API can now only list, search and retrieve albums and media items **created by the app itself**. Shared-album get/list/join return 403 ([Updates to the Google Photos APIs](https://developers.google.com/photos/support/updates); [developer blog](https://developers.googleblog.com/id/google-photos-picker-api-launch-and-library-api-updates)). A household-curated album **cannot be read**. Open-source photo frames hit exactly this ([MMM-GooglePhotos #194](https://github.com/hermanho/MMM-GooglePhotos/issues/194), [rclone forum](https://forum.rclone.org/t/add-the-new-google-photos-picker-api-to-rclone/47938)). |
| Workaround (app-created album) | Have the app create an album with `appendonly` and add to it… but photos have to be *uploaded through the app*. The household can't curate from the Photos app. Fails the requirement. |
| Picker API | Scope `photospicker.mediaitems.readonly`. The app creates a session (`POST /v1/sessions`), sends the user to `pickerUri` on a device with a browser, polls, then lists `mediaItems`. Each selection is a **one-off session**: picking more photos later means a new picker session. `baseUrl`s last **60 minutes** ([Picker media items](https://developers.google.cn/photos/picker/guides/media-items), [sessions](https://developers.google.com/photos/picker/reference/rest/v1/sessions)), so bytes must be downloaded right away and cached for good. No incremental sync: adding a photo in Google Photos does nothing until someone runs the picker again. |
| Google Drive folder | `changes.getStartPageToken` + `changes.list` is a proper incremental feed. But reading arbitrary Drive files needs `drive.readonly`, a **restricted** scope (OAuth verification plus an annual security assessment for a public app, or living with "unverified app" / test-user limits for a personal project). `drive.file` only covers files the app created or the user opened with it. It also means a second identity provider and a second token cache. **[verify]** current restricted-scope list. |
| **Verdict** | **Not recommended.** Google Photos can no longer sync a curated or shared album read-only. The Picker gives you a manual snapshot, not a stream. Drive works technically but costs a restricted scope and a second auth stack, and Microsoft already meets the requirement. |

### 2.4 Not cloud, noted for completeness

A local or SMB folder on `sartra-server` (a `watchdog`, or an mtime scan) is the
simplest build, and it could be a "provider" behind the same interface for dev
and tests (see §3.1). It doesn't meet the account-based requirement, so it is
not the product path.

---

## 3. Phase 2: implementation sketch (OneDrive folder)

### 3.1 Backend shape

New package `backend/app/photos/` in the eufy mould: isolated, feature-flagged,
severable.

```
app/photos/
  source.py     PhotoSource protocol: list_changes(state) -> (upserts, deletes, new_state); fetch_rendition(item, w, h) -> bytes
  onedrive.py   OneDriveFolderSource (and later OneDriveAlbumSource), Graph via httpx + the shared MSAL app
  local.py      LocalFolderSource, for dev/tests only (optional)
  cache.py      PhotoCache: manifest JSON + atomic writes + size-capped eviction (copy of EufyClipCache's shape)
  service.py    PhotoStreamService: sync loop thread/task, snapshot(), broadcast hook
```

A `PhotoSource` protocol is justified here (AGENTS.md: "avoid an interface with
no foreseeable second implementation") because folder, album and the local test
source are three real implementations.

**Config** (`app/config.py`, `MISSION_CONTROL_*`):

- `photos_enabled: bool = False`: the feature flag. When false, nothing is
  imported, no thread starts, and the routes return `{"enabled": false}`.
- `photos_source: Literal["onedrive_folder", "onedrive_album"] = "onedrive_folder"`
- `photos_folder_path: str` (e.g. `"Pictures/Mission Control"`) or `photos_album_name`
- `photos_account: str | None`: which signed-in household account owns the
  folder. The token cache is multi-account (one per calendar person). See Q3.
- `photos_cache_dir: str = ".photo_cache"` (git-ignored, next to the other caches)
- `photos_cache_max_mb: int = 2048`, `photos_cache_max_items: int = 1000`
- `photos_sync_interval_seconds: int = 600`, `photos_rendition: str = "c2560x1440"`

**Sync loop** (`service.py`):

1. On startup, `PhotoCache.load()` runs synchronously (like `EufyEventService`),
   so `/api/photos` is served from disk before any network call.
2. A daemon thread loops: `acquire_token_silent(["Files.Read"])` → call the
   deltaLink (or the folder delta on first run) → for each upsert whose `cTag`
   changed and whose `file.mimeType` starts with `image/`, queue a rendition
   download → for each `deleted` item or one moved out of the folder, evict →
   persist the manifest and **then** the deltaLink (never advance the token
   past work that isn't saved).
3. A 410 resync runs a full enumeration with a mark-and-sweep reconcile. A
   429/503 honours `Retry-After`. Any other error: log it, record
   `last_error` for status, sleep with exponential backoff (capped at the
   interval), and keep serving the cache.
4. After a round that changed something, `broadcast(ApplicationMessage(type="photos_changed", …))`,
   a small typed extension of the existing envelope. The client refetches the
   manifest. No second socket.

**State file:** `{cache_dir}/state.json`: `{source, folder_id, delta_link,
last_sync, last_error}`. A single JSON file with atomic write; corrupt or
missing → full resync. No new datastore. (The deltaLink is an opaque URL
containing the token; it isn't a secret on its own but stays git-ignored.)

**Disk cache** (`cache.py`): `manifest.json` (`id, name, width, height,
taken, ctag, bytes, file`) plus `{safe_id}.jpg`. Eviction:

- Items deleted or moved upstream → removed right away (the household curated
  them out; Mission Control mirrors, never keeps).
- Over `max_mb` or `max_items` → evict by a stable rule (oldest `taken`, or
  least recently added; see Q6) and **skip** them rather than re-fetching in a
  loop. The cache is a *mirror with a cap*, not an LRU of what was viewed.
- An orphan sweep at load, like `EufyClipCache._sweep_orphans`.

**Failure isolation:** the service owns its own thread and never raises into
the calendar path. Graph errors, a full disk or an expired token only change
`photos` status. Imports are lazy behind the flag (like the real calendar
providers). If photo sign-in is missing, the tile shows the cache (or hides
itself if the cache is empty) and the existing header warning slot can show
"Photos sign-in needed" (frontend AGENTS.md: warnings only when unhealthy).

**Auth integration:** extend `personal_auth.py` / `python -m app.auth login`
with a `--scope photos` (or have the kiosk sign-in ask for `Calendars.Read
Files.Read` when photos are enabled), reusing the shared MSAL app and cache.
**[verify]** that the first-party Graph CLI client grants `Files.Read` to a
personal account by device code; if not, fall back to the existing
`MISSION_CONTROL_GRAPH_CLIENT_ID` path (the household's own registration with
`Files.Read` added).

**API routes** (`app/api.py`):

| Route | Gate | Purpose |
|---|---|---|
| `GET /api/photos` | `_require_local` | `{enabled, status, photos: [{id, width, height, taken, version}]}` |
| `GET /api/photos/{id}` | `_require_local` | Serves the cached JPEG from disk (`FileResponse`, `Cache-Control: max-age, immutable` keyed by `?v={ctag}`). Never proxies Graph live. |
| `POST /api/photos/sync` (optional) | `_require_local` + `_require_unlocked` | "Refresh now" from Settings. It's a mutation of server state, so it gets the privacy gate per Definition of Done. |

There is **no delete/edit route**: the issue says display-only, and the token
is read-only (`Files.Read`) anyway. Models (`PhotoItem`, `PhotoStreamStatus`)
go in `app/models.py`, mirrored by hand in the frontend in the same commit.
Privacy-mode read behaviour of `GET` is open (Q2).

### 3.2 Frontend shape

`frontend/src/photos/`: `usePhotoStream` (fetch manifest, react to the
`photos_changed` socket message through the shared `useAppSocket`) and
`PhotoTile`.

- **Placement:** a Home grid region. Home is NOW/NEXT/UNUSUAL first
  (principles 1, 3, 5), so the tile **gives way** to schedule content and to the
  "needs attention" exception card, collapses when there are no photos, and is
  never stretched to fill space. Size and position are Q4, and need a pass
  against `docs/controls-layout-design.md` and the e2e no-scroll checks at
  3840×2160 and 1920×1080.
- **Rendering:** two stacked `<img>` layers with a CSS opacity crossfade (token
  `--photo-fade-ms`, ~1–1.5 s), `object-fit: contain` on a neutral or blurred
  matte so photos are never cropped or altered ("no effects"; whether a
  blurred-fill matte counts as an effect is Q7). Decode the next image ahead
  of time (`img.decode()`) before starting the fade, so there's no flash.
- **Timing:** dwell `--photo-dwell` (Q5); pause while a sheet or overlay is
  open and when the display is dimmed (`docs/display-dimming-plan.md`).
- **Touch:** horizontal swipe = previous/next (reuse the swipe/tap
  disambiguation in `ViewPager` / `BrandLockup`), and a tap on the left or right
  third does the same, so it works without a swipe gesture. A manual flip
  restarts the dwell timer. Tap-to-fullscreen is Q8. No hover affordances.
- **Order:** shuffle vs. date order is Q6. Keep the order stable across
  manifest refreshes so a sync doesn't make the tile jump.

### 3.3 Pattern inspirations (short pass, per `comparative-product-research.md`)

Surveyed: Nest Hub (Ambient Mode / Google Photos albums), Echo Show (Amazon
Photos), Skylight / Aura frames, Hearth, DAKboard photo block, MagicMirror
photo modules.

| Capability | Who | Relevance |
|---|---|---|
| Source = "pick an album, it stays in sync" | Nest Hub, Aura, DAKboard | The model the household expects. A OneDrive folder gives the same "drop it in and it appears". |
| Photos keep showing in guest mode | Nest Hub | One data point for Q2 (see the privacy-mode plan, line 104). |
| Shuffle + long dwell, tap to pause/next | Aura, Nest Hub | Typical dwell 10 s–5 min, user-set. |
| Smart crop / portrait pairing | Nest Hub, Aura | Out of scope for MVP; the issue says "no effects". |

**Don't copy:** photos *replacing* the calendar (Hearth privacy wallpaper,
already rejected in `docs/privacy-mode-plan.md`); Google-Photos-only
integrations (their Library API path has been cut off since March 2025, which
broke many DIY frames).

---

## 4. Effort and rollout (indicative)

1. Validation script against the live account (§5.3). This decides folder vs
   album and confirms consent on the CLI client.
2. Backend: cache + OneDrive folder source + service + routes behind
   `photos_enabled`, with pytest.
3. Frontend: tile, crossfade, swipe; e2e layout checks.
4. Optional: album source; Settings "refresh now" and status.

## 5. Testing approach

### 5.1 Backend (pytest, mocked Graph)

- Mock Graph with `respx` / `httpx.MockTransport` (or the pattern in the
  existing Graph provider tests). No live calls in CI.
- **Delta:** initial multi-page enumeration → deltaLink persisted; an
  incremental round with add / modify (`cTag` change → re-download) /
  `deleted` tombstone / moved-out-of-folder → cache matches; a 410 →
  full-resync mark-and-sweep evicts stale items; deltaLink is **not**
  advanced when a download fails mid-round.
- **Throttling:** 429 + `Retry-After` honoured (inject a clock/sleep).
- **Cache:** size/item cap eviction; orphan sweep; corrupt manifest/state →
  reseed; atomic write.
- **Isolation:** with `photos_enabled=False` nothing is imported or started;
  a raising source never breaks `/api/calendar`; token missing → status
  `needs_sign_in`, cache still served.
- **Gates:** routes reject non-LAN callers; `POST /api/photos/sync` returns 423
  while privacy-locked; whatever Q2 decides for `GET`.
- Non-image (video) items are skipped.

### 5.2 Frontend (vitest + Playwright)

- `usePhotoStream` reacts to `photos_changed`; order stays stable across
  refreshes.
- `PhotoTile`: advances after the dwell, swipe/tap navigation, pauses under an
  overlay, collapses when empty.
- e2e: Home with and without photos at 3840×2160 and 1920×1080, with no
  document scroll.

### 5.3 Live validation script: `backend/scripts/verify_photo_source.py`

Run by hand on `sartra-server` against the household account, like the other
`backend/scripts/` hardware checks:

1. Device-code sign-in for `Files.Read` with the default first-party client →
   reports whether consent succeeds and the refresh token lands in the
   existing cache next to `Calendars.Read`.
2. Resolve the folder path; run folder delta to completion; print counts and
   the deltaLink; add a photo in OneDrive, wait, re-run and confirm it appears.
3. List albums (`bundles?$filter=bundle/album ne null`); list one album's
   children; run root delta after adding a photo to the album, to see whether
   membership changes show up (settles Candidate B's **[verify]**).
4. Fetch `c2560x1440` and `c3840x2160` thumbnails for a JPEG and a HEIC; report
   actual dimensions, format and bytes.
5. Optional `--business`: repeat 2 and 4 on a work account to confirm the
   root-only delta restriction.

---

## 6. Risks

- **First-party client consent** for `Files.Read` (mitigation: own app
  registration, already supported by config).
- **Which account owns the photos** in a multi-account token cache (Q3).
- **Large initial sync** of an un-curated folder (mitigation: item/MB caps,
  throttled downloads, newest-first).
- **Work-account delta noise** (root-only). Acceptable, or support personal
  accounts only.
- **Album API stagnation.** That's another reason to prefer folders.

## 7. Open product/design questions (not decided here)

1. **Folder or album?** Folder (true delta, both account types) or OneDrive
   album (personal only, polled, but curates without moving files)? Or both?
2. **Privacy mode.** Keep showing photos (Nest Hub does), hide the tile, or
   show a neutral subset? Household photos may be exactly what a houseguest
   shouldn't see, or exactly what's nice to show them. Does `GET /api/photos`
   stay readable while locked?
3. **Whose account?** One designated household member's OneDrive, a shared
   folder (needs `Files.Read.All`), or a dedicated household Microsoft account?
4. **Tile size and position on Home,** and what it gives way to on a busy day or
   when an exception card is up. Does it ever take over Home when idle
   (screensaver-like), or is it always just a tile?
5. **Dwell time and fade length,** fixed or a Setting?
6. **Order and cap:** shuffle, newest first, or taken-date order; which photos
   are dropped when the cap is hit?
7. **Letterboxing:** a plain matte or a blurred fill of the photo itself? (Is a
   blurred fill an "effect"?)
8. **Tap behaviour:** next/prev only, or tap to open a full-screen view?
9. **Captions/metadata:** show the taken date or filename, or nothing?
10. **Videos and Live Photos** in the folder: skip (proposed) or show a still?
11. **Voice:** should "next photo" or "show the beach photos" be voice tools
    later? (Read-only, so it fits the tool rules.)
12. **Dimming and night:** pause or hide photos when the display dims?

---

## 8. Implementation status (initial build, 2026-11-09)

**Built:**

- `backend/app/photos/` — `cache.py` (manifest + `state.json`, atomic writes,
  orphan sweep, item/MB caps, thread-safe), `onedrive.py` (folder resolve,
  folder-scoped delta with paging, 410 → full re-enumeration, 429/503 →
  `Throttled(retry_after)`, 401/403 → `NeedsSignIn`, `c{W}x{H}` thumbnail
  fetch), `service.py` (async loop + worker-thread rounds, mark-and-sweep on
  full rounds, delta link only advanced when every download succeeded,
  exponential backoff, `photos` push on change), `__init__.py` (lazy singleton,
  `Files.Read` silent token from the shared MSAL cache, lifespan start/stop).
- Config `MISSION_CONTROL_PHOTOS_*` (see `backend/.env.example`); the kiosk/CLI
  device-code sign-in adds `Files.Read` only while photos are enabled
  (`personal_auth.sign_in_scopes`).
- API: `GET /api/photos`, `GET /api/photos/{id}` (cache-only, immutable
  `?v=` URLs), `POST /api/photos/sync` (`_require_local` + `_require_unlocked`).
  `/api/ws` sends the snapshot on connect and after changes.
- Frontend: `src/photos/` (`usePhotoStream`, `PhotoTile`): two-layer
  decode-then-crossfade, 20 s dwell, swipe or side-third tap to step,
  `object-fit: contain` on a dark matte, reduced-motion respected.
- Tests: `backend/tests/test_photos.py` (respx-mocked Graph, cache, service,
  gates), `src/photos/*.test.ts(x)`, `e2e/photos.spec.ts` (fit at both kiosk
  sizes). Live check: `backend/scripts/verify_photo_source.py`.

**Provisional defaults (chosen to ship something; each maps to an open question):**

| Default | Question |
|---|---|
| Tile takes the rail's lower slot only when there is no sign-in alert and no camera clips (alert > camera > photos) | Q4 |
| Tile is hidden while privacy mode is on; `GET /api/photos` stays readable (like the eufy gallery) | Q2 |
| Fixed 20 s dwell, 1.2 s fade, both constants/tokens | Q5 |
| Newest-taken first, undated last; cap keeps the newest; no shuffle | Q6 |
| Dark plain matte, no blur fill; no captions | Q7, Q9 |
| Tap on side thirds steps; centre tap does nothing | Q8 |
| Videos skipped | Q10 |

**Gaps / not yet done:**

- **Not validated against a live account.** The [verify] items (first-party
  client consent for `Files.Read`, items moved out of the folder appearing as
  `deleted` in folder delta, custom thumbnail sizes, HEIC) need
  `scripts/verify_photo_source.py` run on `sartra-server`.
- **Work/school accounts:** folder delta is personal-only; root delta +
  `parentReference.path` filtering is not implemented.
- **No sign-in surfacing:** a `needs_sign_in` status is reported by
  `/api/photos` but not yet shown in the header warning slot, and the kiosk
  sign-in sheet doesn't say that photos need a re-consent.
- **No Settings UI** (refresh-now, status, folder name) — the sync route exists.
- **Not paused on display dim** (`docs/display-dimming-plan.md`) — Q12.
- **Albums** (Candidate B) not implemented.
- Thumbnail fetch has no fallback to the original (`downloadUrl`) when a
  rendition is unavailable; such photos are retried each round.
- A capped-out photo is skipped, not queued: if the cap later frees up, it only
  appears on the next full (410/re-config) enumeration.
