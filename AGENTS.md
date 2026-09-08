# AGENTS.md

Durable context for any coding agent (Claude Code, Copilot, Cursor, etc.) working in
this repository. Keep this file current; it is the single source of architectural,
product, and process truth. `.github/copilot-instructions.md` is a thin pointer to
this file.

## What this project is

**Mission Control** is a touch-first household calendar dashboard for a wall-mounted
27-inch 4K (3840x2160, 16:9) touchscreen running a full-screen browser 24/7. It is an
*ambient household appliance*, not a desktop web app and not an Outlook/Google Calendar
clone.

- The browser client is disposable and mostly stateless: it renders provider-neutral
  calendar snapshots and owns only view state (current mode, focused date, filters)
  and app-only presentation preferences (colour mode, week start, per-calendar colour).
- The server owns everything durable: provider access, OAuth tokens, credentials,
  household state, timers, and AI/audio/video processing — with one deliberate
  exception, the voice assistant's Gemini Live session, which the browser holds
  directly using a short-lived backend-minted token. The Azure and local voice
  providers run through the backend (`WS /api/voice/live` / `/api/voice/local`);
  see **Voice assistant** below.
- The default calendar provider is an in-memory mock. Configuration-driven Microsoft
  Graph *read* providers also exist for both an Azure AD tenant
  (`MISSION_CONTROL_CALENDAR_PROVIDER=graph`, app-only) and a personal
  outlook.com / hotmail.com account (`outlook_personal`, delegated / device-code),
  with no in-app account management. No persistence, no auth for the frontend yet.

The voice assistant exists and is a running bake-off: tap-to-talk, five selectable
providers (Gemini Live, three Azure paths, and an experimental on-device Local /
Hybrid pipeline). It answers schedule questions, drives the dashboard, controls
one kitchen timer, and manages the household grocery list — the two documented
exceptions to read-only; it cannot write the calendar. It can also turn *on*
**privacy mode** (a houseguest redact-and-lock state; see **Privacy mode**) but
never turn it off. Wake-word activation ("Mission Control") is **integrated but off
by default**, and is itself a bake-off: an in-browser openWakeWord detector (a
locally-trained model ships; its ONNX feature maths and recall still need hardware
validation) and a backend-spotted Azure custom keyword, swappable at runtime (see
**Wake word** below). Long-term direction (do **not** build
until explicitly asked): a Google Calendar provider, Home Assistant, voice-driven
calendar writes, and optional local media processing. `.prompts/` holds the dated
prompt history that produced the repo and is useful background.

## Repository layout

```
backend/                FastAPI service (Python 3.12+)
  app/main.py            ASGI app + CORS
  app/api.py             HTTP + WebSocket routes under /api; provider selection
  app/config.py          MISSION_CONTROL_* settings (pydantic-settings)
  app/models.py          Pydantic v2 domain + API models (the contract)
  app/calendar/provider.py  CalendarProvider protocol + MockCalendarProvider
  app/calendar/graph.py  MicrosoftGraphCalendarProvider (tenant, app-only) + shared mapping
  app/calendar/outlook_personal.py  PersonalOutlookCalendarProvider (MSA, delegated/MSAL)
  app/calendar/personal_auth.py  device-code sign-in for the kiosk + CLI
  app/auth.py            `python -m app.auth {login,status,logout}` headless sign-in
  app/voice/            shared voice plumbing (prompt/tools/cache/base) + providers/ adapters
  app/voice/local/      Local / Hybrid pipeline: STT seam + engines/ + intents/entities/dates/interpreter
  tests/                 pytest
  .env.example           documented MISSION_CONTROL_* variables
  pyproject.toml
frontend/                React 19 + TypeScript (strict) + Vite
  src/App.tsx            App shell + Home/Week/Month views + helpers
  src/App.css            Design tokens, layout, semantic markers (single stylesheet)
  src/App.test.tsx       Vitest + Testing Library
  src/voice/             tap-to-talk session, audio pipeline, wake word, tools, providers
  src/timers/            Timer tab: useTimers store, TimerView, chime
  e2e/                   Playwright kiosk-layout checks
.prompts/                Historical build prompts (context, not instructions)
```

## Product & design principles

1. **Ambient appliance, not a web app.** Optimize each primary screen in this order:
   (a) what a person grasps in ~2 seconds walking past from 6–10 ft; (b) what they can
   do in one or two touches at arm's length; (c) only then, information density.
2. **Two viewing distances.** Ambient: date/time, today's schedule, and actionable
   status readable across a room. Interactive: richer detail and controls appear on
   touch (progressive disclosure) rather than living on screen permanently.
3. **Prioritize NOW, NEXT, and UNUSUAL.** Near-future household information beats
   treating every date/entity equally. Actionable exceptions (e.g. "Garage open 43
   minutes") earn prominent space; normal status ("all quiet") earns little or none.
4. **Low cognitive load is not low information density.** The screen may be
   information-rich if the hierarchy is instantly clear. Whitespace must separate
   useful information, build hierarchy, aid distance readability, or form touch
   targets — never substitute for content or fill fixed-height containers.
5. **One authoritative location per fact.** Do not render the same date, time,
   navigation, or status prominently twice. Let region size follow real content;
   collapse sparse regions instead of stretching them.
6. **4K is for legibility, not desktop density.** Large, crisp typography and semantic
   color, not tiny controls or hover-dependent affordances.
7. **Distinct purpose-built modes.** Home/Today, Week, Month now; Tasks and
   Home-control anticipated. Every normal mode must fit a 16:9 kiosk viewport with no
   document-level scrolling at 3840x2160 and 1920x1080. Overlays/dialogs may scroll
   internally.
8. **The display is the assistant's output surface.** Future voice should navigate,
   highlight, propose, and confirm within this UI — not become a detached chatbot
   panel. Keep the contextual region (right rail / detail sheet) able to host event
   detail, exceptions, and later assistant proposals with Confirm/Cancel.

## Comparative product research

When a feature is user-facing behaviour or UX and someone outside this repo has
almost certainly shipped something adjacent (a smart display, a family calendar, a
shared list, a kiosk-lockdown tool), do a short comparative pass before settling
the design. **`docs/comparative-product-research.md`** holds the method, a reusable
comparison template, and a maintained catalogue of comparison-worthy products
grouped by tier — so "does anyone else do this, and what works?" is a ~30–60 minute
question, not a from-scratch investigation. Fold the findings into a *Pattern
inspirations* section in the feature's plan doc (as `docs/timer-plan.md`,
`docs/lists-plan.md`, and `docs/privacy-mode-plan.md` did), and add anything
durable — a new product, a lasting principle — back to the research doc.

## Persistent chrome (header, status, navigation)

The frame around the calendar is not a dashboard. Keep it minimal so the recovered
space goes to schedule content.

- **The header's budget belongs to actionable and contextual information**, not
  branding or a hero clock. It carries: the current temporal context (Month → month
  + year; Week → the visible date range; other views → the date), a subordinate
  current time, the two global actions (Ask / Add), and nothing else. Branding stays
  present but must never set the header height. No descriptive boilerplate ("the
  household calendar"), no widgets added to fill reclaimed space. Aim for a single
  compact band and give the height back to the calendar. Apply the same header
  grammar to every view.
- **Normal status consumes no visible chrome; exceptions earn attention.** There is
  no persistent "Live sync" / "all good" indicator. A compact slot in the header is
  reserved for warnings/errors (offline, calendar sign-in needed): visually absent
  when healthy, a clear touch-sized icon when not, with the detail message behind a
  tap (transient popover, Escape + outside-click dismiss) — never spelled out inline
  in the header.
- **The bottom dock has two zones: navigation (left) and adjust (right).** Left
  answers "what am I looking at?" — the mode nav; right holds "change what I see" —
  People (calendar scope) then Settings (config). Global *actions* (Ask / Add) stay
  in the header; the dock gets no third "actions" zone. **Every dock control is one
  object**: one height, one radius, one type size (the `--dock-control-*` tokens).
  People and Settings are the same size as a mode button — quiet until active/open —
  never small secondary chrome. See `docs/controls-layout-design.md`.
- **Persistent mode navigation must stay spatially stable.** Home / Week / Month
  are peer controls with equal, generous touch targets — inactive ones quieter than
  the selected one, but never styled as mouse-oriented text links. Their positions
  never move. **Timer and Lists are not calendar-viewing peers** — they are
  role/appliance modes, set apart from the views as their own cluster inside the
  nav: the wider between-cluster gap plus a full-height hairline (visible across the
  room, not a 1px rule), and their identity colours (coral / fern). Set apart, not
  elevated — same size, same reading order, no centre-stage promotion. Each keeps a
  warm self-contained view panel rather than the borderless calendar grids. Same
  "different kind of thing → distinct grouping, placed within the nav but apart"
  grammar as the contextual Today action. See `docs/timer-plan.md` → "Visual
  separation" and `docs/controls-layout-design.md`.
- **Ambient state on a dock button rides as a corner badge, never inline.** The
  soonest timer's remaining time and the unchecked-list count are absolutely-
  positioned overlays straddling the button's top-right corner, so the button — and
  everything beside it — is a fixed size in every state. Nothing in the dock moves
  when a timer starts, ticks, or ends.
- **Contextual actions are not primary modes.** "Today" is a return-to-current-date
  action, shown only when Week/Month is displaced from today, styled distinctly from
  the mode selector and placed visually outside it (trailing the views cluster). Its
  appearance/disappearance must not shift the mode buttons. The same rule applies to
  any future contextual action.
- **Settings is a categorised centred sheet, not a scrolling popover.** It joins the
  `.detail-scrim` / `.detail-sheet` family (Escape + scrim dismiss) with a category
  rail (Display · Calendars · Voice & sound) and a scrolling panel. Everyday display
  preferences (event colour, week start, per-calendar colour) are the default view;
  bake-off / diagnostic knobs (voice provider, keyword provider, mic routing) sit
  behind an **Advanced** disclosure under "Voice & sound", collapsed by default, and
  never show raw engine error strings on the wall. Control grammar follows the
  choice shape: a segmented control for a small mutually-exclusive set, a switch for
  on/off, swatch groups for colour. Add a new setting to the category it belongs to;
  add a new category only for a genuinely distinct area. See
  `docs/controls-layout-design.md`.

## Calendar event legibility & overflow

The target device is a 27-inch 4K touchscreen read from 6–10 ft and touched at
arm's length. Events are the primary information.

- **Event content is sized for the room, not the desktop.** Event rows are
  comfortably tall touch surfaces and the title/time carry strong ambient value —
  the time is a real part of the event, never shrunk to metadata. Surrounding
  typography (month/week heading, day numbers, weekday labels, status microcopy) is
  balanced *around* the events, not scaled uniformly: the heading establishes
  context without dominating, config/status microcopy never competes with the
  schedule.
- **Never shrink ambient event typography or touch size to solve overflow.** A busy
  day does not get denser events — it gets a progressive-disclosure affordance.
- **Month overflow.** A Month day cell renders as many full-size event rows as
  comfortably fit (the ceiling follows viewport height — roughly three rows at 4K,
  two at 1080p — never a dynamic per-day shrink), then collapses the remainder into
  a touch-friendly "+N more" row that opens the day's full list in a contextual
  sheet. The Month grid stays fixed: cells never expand, never scroll internally.
  All-day / multi-day bars keep their existing overlay treatment.
- **Week view** has more room — show more event detail directly, at the same
  baseline event typography and touch standards.

## Holidays

US public holidays are shown as ambient context, **not** as events.
`frontend/src/holidays.ts` computes them — a pure function of the date, in the browser's
local zone, with no provider, no network, and no persistence (the same class of
client-only helper as `dates.ts`). The set mirrors the "Holidays in United States"
calendar people already see in Google / Outlook: the federal holidays plus widely-observed
cultural days (Valentine's, St. Patrick's, Easter, Mother's / Father's Day, Halloween,
Christmas Eve, New Year's Eve). Each carries one small thematic emoji.

- **A holiday is a label, never a chip.** It renders in space that already exists — right
  of the date number in the Month day heading (vertically centred on the number,
  `HolidayNote`), on the Week all-day lane (`.allday-holiday`, centred under its date), and
  under the day's headline on Home (today / tomorrow) — one step smaller than the
  surrounding type, muted, `pointer-events: none`, and a `<span>` not a `<button>`. It
  must never look tappable and never open a sheet.
- **In the Week all-day lane, holidays and events stay visually distinct and share the
  row.** Holidays are plain muted text + emoji with no fill or border; real all-day /
  multi-day events are the coral- / identity-tinted rounded `span-bar` buttons that
  stretch across days. The lane is **not** made taller for holidays: a holiday sits on the
  top lane and events that don't touch that day stay on the same line beside it. A
  holiday's day column is passed to `layoutSpans` as a reserved top-lane column, so an
  event that *does* cover that day is packed onto the next lane — the non-interactive
  holiday always reads ahead of the interactive event on a shared day.
- **It must not move real content.** The Month note is one clipped line inside the
  fixed-height heading (`--month-heading-h`); it never changes the presence, position, or
  spacing of calendar events, the "+N" overflow, or the spanning bars.
- Extend the set by adding rows in `holidays.ts`. Keep icons emoji (no committed asset —
  see `docs/credits.md`) and avoid regional-indicator flag emoji (Windows renders them as
  letters). A non-US holiday set would be a future locale choice, not a provider feed.

## Semantic color

- **Calendar/person identity** is the dominant ambient signal and uses a fixed named
  palette (`CalendarColor`: coral, ocean, gold, fern, violet). **Event category** is a
  restrained secondary marker. Never paint one large surface with both classifications
  competing.
- Categories carry a stable id, display name, and a concrete `#rrggbb` color, without
  leaking provider SDK types into React. Names stay authoritative; accessibility and
  contrast beat exact provider colors.
- Calendar identity colors render through shared `.calendar-<name>` marker classes in
  `App.css` (swatches, dots, bars, event surfaces), so a new `CalendarColor` needs a
  token plus those rules. Category color is different: the provider resolves it to a
  hex value (`EventCategory.color`), the frontend passes that through a
  `--category-color` custom property, and `.category-dominant` / `.category-dot` /
  `.category-label` derive their fill (and a `color-mix` tint for event surfaces) from
  it — no per-color CSS. The Graph/personal-Outlook providers read the mailbox's
  `masterCategories` list and map each Outlook `presetN` swatch to hex
  (`_PRESET_HEX` in `graph.py`); a name missing from that list, or a mailbox the
  provider can't read categories from, degrades to the neutral `_NEUTRAL_CATEGORY_HEX`
  marker. Keep any new provider's category colors as hex with the same neutral fallback.
- Keep identity/category treatment consistent across Home, Week, Month, filters, and
  detail. Popovers dismiss on outside interaction, Escape, and navigation without
  swallowing intended inside clicks.
- **Per-calendar colour is viewer presentation, not provider data.** Providers hand
  each `HouseholdCalendar` a default `CalendarColor`; the kiosk lets a household
  member re-assign any calendar to another palette colour from Settings → "Calendar
  colours". The choice is stored per-viewer in `localStorage`
  (`mission-control.calendar-colors`, a `{calendarId: CalendarColor}` map), applied by
  remapping the snapshot's calendars before render, and never written back to a
  provider. Re-picking the provider default drops the override. This is the same
  class of app-only presentation state as the category-first / people-first mode and
  the week-start choice — presentation preferences live on the frontend; account
  onboarding and credentials stay backend-config only.

## Architecture & boundaries

- **Provider-neutral domain.** Frontend and API speak only the models in
  `app/models.py`. Providers (`MockCalendarProvider`, `MicrosoftGraphCalendarProvider`,
  `PersonalOutlookCalendarProvider`, a future `GoogleCalendarProvider`) return these
  models, never provider SDK types, and convert any timezone-aware datetimes to naive
  local time at the boundary.
- **Household calendar identity.** `HouseholdCalendar` carries `name` (raw handle —
  email local-part / UPN prefix / mock label; stable id + last-resort fallback),
  `display_name` (the account holder's natural name — given/first name > full name >
  `name`), and `source` (`CalendarSource`: `mock` / `outlook` / `google`) for the
  kiosk's provider badge. Providers resolve `display_name` best-effort: the Microsoft
  providers use `graph.ProfileNameCache` (`GET /me` or `/users/{id}`,
  `$select=givenName,displayName`, 1-hour TTL) and the personal provider prefers the
  sign-in's ID-token claims (`given_name` / `name`) since `Calendars.Read` alone
  usually can't read `/me`. Any lookup failure silently falls back to `name` —
  never fail a snapshot for a name. People-facing surfaces and the voice assistant
  show/speak `display_name`; see `docs/natural-names-notes.md`. New providers satisfy the `CalendarProvider` protocol;
  seams are annotated with that protocol, not a concrete class. `api.py` picks the
  provider from `get_settings().calendar_provider` and caches it; each real provider is
  imported lazily so the mock path never needs `msal`/Graph credentials.
- **Two Microsoft providers, different auth.** App-only client-credentials only works
  for Azure AD tenants (`graph.py`). Personal accounts (outlook.com/hotmail.com) require
  delegated auth, so `outlook_personal.py` uses MSAL device-code sign-in and a
  git-ignored on-disk refresh-token cache (`MISSION_CONTROL_GRAPH_TOKEN_CACHE`), kept in
  sync across the provider, the CLI, and the sign-in poll thread via one process-wide
  MSAL client. Both providers share the event-mapping helpers in `graph.py` (imported by
  name) and are read-focused (`outlook_personal` raises on `create_event`).
- **Kiosk sign-in.** `personal_auth.py` runs the device-code flow non-blocking (a daemon
  thread blocks on MSAL; the kiosk polls `GET /api/calendar/auth`). `POST
  …/auth/device` starts it and returns the code + an `segno` QR data-URI;
  `DELETE …/auth/device` cancels; `DELETE …/auth` signs out. These endpoints are
  loopback/LAN-only unless `allow_remote_auth`. The frontend surfaces "needs sign-in" as
  a header pill + Home exception card and shows the code/QR in a sheet; credentials are
  never entered on the kiosk. The initial zero-account prompt and Settings both use
  this same flow; Settings can add another Outlook account, and the personal provider
  exposes each cached account as a separate household calendar.
- **Persistence.** No general datastore; two single JSON files — the MSAL token
  cache, and the grocery list's `lists.json` (`app/lists.py`, `MISSION_CONTROL_LISTS_FILE`).
  A SQLite-backed provider / token / list store should drop in behind the same
  protocol without any frontend change.
- **Real-time.** `/api/ws` is a deliberately small typed endpoint. Do not build a
  generalized event bus. `ApplicationMessage` in `app/models.py` is the server→client
  envelope. **Timers are its first real use:** `app/realtime.py` holds a tiny
  connection registry + `broadcast()`, the socket sends the current timer list on
  connect, and the timer store pushes `timer-started` / `-extended` / `-paused` /
  `-resumed` / `-restarted` / `-dismissed` / `-fired` messages (each carrying
  `timers`, and `timer` / `replaced` as relevant). The **list store** uses the same
  envelope (`lists` / `list` / `removed`) and channel — `list-item-added` / `-removed`
  / `-checked` / `-unchecked` / `-cleared` / `-restored`; the socket also sends the
  current lists on connect. On the frontend one shared connection
  (`frontend/src/realtime/appSocket.ts` + `useAppSocket`) feeds both `useTimers` and
  `useLists`. Keep any further push a small typed addition to this envelope, not a bus.

## Voice assistant

Initial voice support (see `docs/voice-support-plan.md`). Tap-to-talk. It answers
schedule questions and moves the display; it **cannot change the calendar**. There
are **two** documented, narrow exceptions to read-only, both local single-household
appliance state with no external side effect:
1. the **kitchen timer** — `start_timer` / `cancel_timer` / `extend_timer` /
   `pause_timer` / `resume_timer` / `restart_timer` / `get_timer`;
2. the **grocery list** — `add_to_list` / `remove_from_list` / `check_off_item` /
   `clear_list` / `get_list` (see **Lists** below and `docs/lists-plan.md`).
Calendar writes stay out of scope.

**Audio itself — microphone capture, the one software gain stage, sample rates,
echo cancellation, playout and every audio setting — is documented once in
`docs/audio-pipeline.md`.** It is deliberately *not* per-provider: one mic, one
gain, one output bus, shared by voice, wake word and the timer chime. Read it
before changing anything that touches samples or level.

- **Provider seam (four-way bake-off).** `MISSION_CONTROL_VOICE_PROVIDER` (default
  `gemini`; also `azure_voice_live`, `azure_openai_realtime`, `azure_openai_realtime_mini`)
  selects the conversational provider — see `docs/voice-provider-bakeoff-plan.md`. Only
  Gemini is verified end to end; the Azure paths are wired but **unverified against live
  Azure** (deployment names / api-version / auth need a spike). Backend:
  `app/voice/providers/` holds one `VoiceProviderAdapter` per provider (`create_grant` +
  `missing_config`); `get_adapter` reads an *effective* provider (a process-memory
  override from `PUT /api/voice/config`, else the setting). The shared prompt
  (`prompt.py`), tool contract (`tools.py`, one neutral spec → `as_gemini_tools` /
  `as_openai_tools`), and grant caching/freshness (`cache.py`) sit **above** the adapters
  and don't know which is active. Frontend: `voice/providers/` holds one
  `ConversationalVoiceProvider` per provider; `createVoiceProvider` fetches the grant and
  branches on `grant.provider`; `useVoiceSession` drives every one through the same narrow
  interface (`connect` / `startActivity` / `endActivity` / `sendAudio` / `respondTool` /
  `close` / `inputSampleRate` / `outputSampleRate` / `endpointing`) + `VoiceEvent` union
  and never sees a wire protocol. Selecting an unconfigured provider is a 409, never a
  silent fallback.
- **End-of-speech ownership is negotiated per provider** — `grant.endpointing`
  (`client` | `hybrid` | `provider`; backend `app.models.Endpointing`, carried on
  `ConversationalVoiceProvider.endpointing`), *not* an assumption that the shared layer
  always owns it. `client` (the default / fallback): no provider VAD, the kiosk's mic-RMS
  silence detector + `MAX_LISTEN_MS` + Stop tap are the whole endpointer and the kiosk
  brackets the turn (`startActivity`/`endActivity`). `hybrid`: the provider VAD runs (for
  streaming ASR / its echo canceller) with `create_response` off and emits
  `speech-started` / `speech-stopped`; the kiosk endpoints on `speech-stopped` (primary),
  keeps the mic-RMS check as a `SERVER_VAD_BACKSTOP_MS` backstop, and still sends a
  finalise marker. `provider`: the provider VAD owns end-of-speech *and* the response
  trigger; the kiosk runs no mic-RMS endpointing and sends no finalise. Each adapter
  declares a `default_endpointing` and writes the effective mode onto the grant in
  `create_grant` (operator settings can override — `voice_manual_activity=true` forces
  Gemini to `client`; `azure_openai_realtime_endpointing` /
  `azure_voice_live_endpointing`). Replaces the old `manual_activity` bool.
  See `docs/voice-provider-bakeoff-plan.md` → "End-of-speech ownership".
- **`GET/PUT /api/voice/config`** (`VoiceConfig`, LAN-gated). Reports `enabled`, the
  effective `provider`, and every contestant with `implemented` / `configured` flags. `PUT`
  sets the process-memory override (reverts on restart — a bake-off A/B affordance, not a
  persisted preference) and clears the token cache. Settings → "Voice provider" is the
  picker; unimplemented / unconfigured contestants are disabled. Wake-word selection stays
  a separate control — orthogonal, per the Provider architecture principle above.
- **Direct-connect via ephemeral token (Gemini).** `POST /api/voice/token`
  (loopback/LAN-gated, 409 unless `MISSION_CONTROL_VOICE_ENABLED`) calls Google's
  `auth_tokens.create` and returns a grant with the model, system instruction, tools,
  voice, and transcription config **locked in**. The Gemini API key
  (`GEMINI_API_KEY_MISSION_CONTROL`, aliased in `config.py`) never leaves the backend.
  The kiosk opens the Gemini Live session itself (`frontend/src/voice/providers/gemini.ts`),
  streaming 16 kHz mic audio and playing the reply; `@google/genai` is lazy-loaded.
  End-of-speech is `hybrid` by default (service VAD streams ASR, kiosk sends
  `audioStreamEnd` on its own silence detection) or `client` when
  `MISSION_CONTROL_VOICE_MANUAL_ACTIVITY=true` (service VAD off, activityStart/End).
- **Backend relay for the Azure contestants** (`app/voice/relay.py`, `WS /api/voice/live`).
  The browser `WebSocket` API can't set the `api-key` header, so Azure Voice Live *and*
  Azure OpenAI Realtime both connect to our relay with a **single-use ticket** (in the
  grant — so relay grants are `reusable_grant = False` and never enter the token cache,
  which would 4401 the second turn); the backend holds the upstream socket + credentials
  and translates realtime events ↔ our `VoiceEvent` JSON both directions. It holds the
  kiosk's audio until `session.updated` (our config applied) so early frames aren't run
  under the provider's default VAD. `RelayVoiceProvider` on the frontend is thin — it
  forwards our own event JSON. Input audio is 24 kHz for this path
  (`ConversationalVoiceProvider.inputSampleRate`). The two Azure products differ and each
  gets its own session builder. **End-of-speech follows `grant.endpointing`** (above):
  `client` → `turn_detection: null`, kiosk brackets the turn; `hybrid` (default) →
  `semantic_vad` / `azure_semantic_vad` with `create_response: false` (streaming ASR +
  forwarded `speech_stopped`, kiosk still asks for the reply on `activity-end`);
  `provider` → `create_response: true` and `activity-end` only commits.
  `openai_turn_detection` / `voice_live_turn_detection` in `relay.py` build the
  `turn_detection` block from the mode; `UpstreamConfig.endpointing` / `_RelayTurn.endpointing`
  gate `translate_client`. `activity-end` → `input_audio_buffer.commit` is best-effort (a
  benign `input_audio_buffer_commit_empty` is logged and swallowed).
  **Azure OpenAI Realtime** is the GA `/openai/v1/realtime` surface (OpenAI-parity —
  `?model=<deployment>`, **no `api-version`**, GA event model: `session.type` /
  `output_modalities` / nested `audio.input`·`audio.output` / `response.output_audio.delta`).
  **Azure Voice Live** is a separate product on
  `?api-version=2026-07-15&model=…`, the flat session (`modalities`, a `voice` object);
  its `azure_semantic_vad` must stay on (it rejects echo cancellation with turn detection
  off), so `client` end-of-speech is not available there — `hybrid` or `provider` only.
  One `translate_upstream` accepts both event-name sets. **Tool-call rounds are
  stateful** (`_RelayTurn`): a response that makes function calls does *not* end the turn
  — the relay withholds `generation-complete`, and sends exactly one follow-up
  `response.create` once every tool output is in (one-per-tool raced the still-generating
  response and aborted the turn); a response calling > `_MAX_TOOL_CALLS_PER_RESPONSE` (8)
  tools is a loop → `response.cancel`. **Tool-result formatting is provider-specific:**
  `useVoiceSession` hands each provider the *raw* dispatch result; Gemini wraps it
  `{ output }` / `{ error }` (its FunctionResponse contract), the relay sends a JSON
  *string* (the realtime `function_call_output.output` contract) — double-wrapping made
  `gpt-realtime` loop on `get_events` ~25x. User transcription is opt-in —
  `MISSION_CONTROL_AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT` (default `gpt-4o-transcribe`, a real
  deployment on `mc-foundry-eastus2`); it runs *after* the commit, not word-by-word. The
  shared Foundry key is read from `FOUNDRY_API_KEY_MC_EASTUS2`.
  `backend/scripts/verify_voice_providers.py` (`--turn` raw, `--relay` drives `run_relay`)
  verifies each provider live — all three Azure contestants complete a full multi-turn
  round-trip with tools.
- **Token + snapshot caching** (`app/voice/cache.py`, `docs/voice-token-caching-notes.md`).
  The endpoint caches the calendar snapshot its prompt is built from (a blocking Graph
  request otherwise) for every provider, and — for Gemini only (`reusable_grant`) — the
  minted token itself. The token carries a wall-clock stamp,
  so a cached one is re-served only until the **next calendar event boundary**, the next
  **local midnight**, or `MISSION_CONTROL_VOICE_TOKEN_MAX_STALE_SECONDS` — whichever is
  first — so "what's next" can't answer from a stale clock. To make this work the token
  is now longer-lived (`expire_time` = `MISSION_CONTROL_VOICE_TOKEN_TTL_SECONDS`, default
  4 h, API max <20 h) and multi-use (`uses` = `MISSION_CONTROL_VOICE_TOKEN_USES`, default
  0 = unlimited). Acceptable because the endpoint is LAN-gated and the constraints stay
  locked; set `voice_token_uses` positive to tighten it.
- **One session per turn.** Simple and robust against Live session limits. A wake-word
  front end would call the same `startTurn()` / `stopTurn()` on the hook. (Lingering the
  session for fast follow-ups is a noted follow-up in the caching doc.)
- **Classified failures + recovery.** `useVoiceSession` tags every failed turn with a
  `VoiceError.kind` (`disabled` / `network` / `microphone` / `session` / `unknown`).
  After 3 in a row — or an immediate `disabled` (backend 409) — `status` goes
  `unavailable`: the Ask button reads "Voice off" and a transient `VoiceToast` names the
  reason. `disabled` also disables the button until reload; every other kind stays
  tappable (and the toast offers "Try again"). `VoiceOverlay` shows the retryable
  `error` state before the third strike.
- **Debug audio capture.** `frontend/src/voice/debugRecorder.ts` (`voiceDebugRecorder`)
  retains the exact PCM streamed to the speech provider for the last N activations
  (default 10) — every `sendAudio` chunk, in order, at the provider input rate. A
  push-to-talk capture starts at the first mic chunk; a wake capture leads with the
  flushed pre-roll (starts shortly before the keyword) then the live mic. **On by
  default.** In-browser: `window.__voiceDebug` (`list` / `wav` / `wavBytes` /
  `samples` / `save` / `clear`) — no kiosk UI, per **Wake word**. On disk: each
  finished capture is POSTed to `POST /api/voice/debug/capture` (LAN-gated), which
  writes a headered WAV + `.json` sidecar under
  `MISSION_CONTROL_VOICE_DEBUG_CAPTURE_DIR` (default `backend/voice-captures/`,
  git-ignored) and prunes to `…_KEEP` pairs (`app/voice/debug_capture.py`). Upload
  is best-effort — the in-memory ring stands if the backend is down.
  `MISSION_CONTROL_VOICE_DEBUG_CAPTURE_ENABLED=false` (or
  `localStorage['voice.debug.capture']='off'`) turns it off; ring size is
  `localStorage['voice.debug.count']`.
- **Echo cancellation is a hard requirement** for every voice scenario (barge-in,
  wake-during-reply, the listening cue) — and for the timer chime, which rings
  while someone is talking to the kiosk. Chromium's `getUserMedia({ echoCancellation:
  true })` only references *remote* (peer-connection) streams, never WebAudio
  playout, so **everything the appliance plays** — assistant reply, cue, chime —
  routes through a local loopback `RTCPeerConnection` (`frontend/src/voice/aecPlayback.ts`)
  to get into the AEC3 reference. That let the old cue-silencing workaround go
  (`deafUntil` / `CUE_GUARD_MS` deleted from `useVoiceSession`; a 250 ms
  `AEC_SETTLE_MS` covers canceller convergence only). This covers audio *this page*
  plays; audio from other processes on the kiosk box (a debug capture opened in a
  media player, Windows sounds) needs the phase-2 backend path — a Windows audio
  worker capturing the mic + WASAPI render loopback as the reference and streaming
  clean PCM over `WS /api/voice/capture`, to be gated by a
  `MISSION_CONTROL_VOICE_AEC_ENABLED` off switch for a hardware-AEC microphone.
  **Neither the worker nor that setting exists yet**; see the AEC plan.
- **Tools = explicit application tools, never providers.** `backend/app/voice/tools.py`
  is the contract, mirrored in `frontend/src/voice/tools.ts`. `show_view` / `focus_date`
  / `highlight_event` / `set_people_filter` mutate local view state only; `get_events` /
  `get_agenda` / `check_conflicts` are answered from `GET /api/calendar`; `start_timer` /
  `cancel_timer` / `extend_timer` / `pause_timer` / `resume_timer` / `restart_timer` /
  `get_timer` call `/api/timers`; `add_to_list` / `remove_from_list` / `check_off_item` /
  `clear_list` / `get_list` call `/api/lists` (remove/check resolve the item name against
  the live list in the browser first). Agent code must
  never reach a calendar provider directly. The local intent router
  (`app/voice/local/`) plans the same tool calls without a speech-to-speech provider.
  Adding a tool = update both files (the backend copy is what gets locked into the token),
  the `DashboardActions` type + `App.tsx` `voiceActions`, and the `test_voice.py` /
  `test_voice_relay.py` locked-set assertions.
- **Keep `docs/voice-commands.md` current.** That doc is the human-facing list of
  everything voice understands — the phrasings, what each does, and its limits. Any
  change to the tool set (`tools.py` / `tools.ts`), to the spoken behaviour in
  `prompt.py`, or to what voice is allowed to touch (calendar read scope, the timer
  and grocery-list exceptions, wake word) must update `docs/voice-commands.md` in the
  same change, alongside the code and `test_voice.py`.
- **The display is the output surface.** Spoken replies are one-sentence confirmations;
  the dashboard carries the answer. The `VoiceOverlay` is transient, not a chat panel.
- **Single-turn, no follow-up questions.** Every activation is one self-contained
  exchange — there is no running conversation and no idea of a "next step". The prompt
  (`prompt.py`) forbids follow-up offers ("Do you want me to…", "Should I…", "Would you
  like…", "Let me know if…"): answer what was asked, then stop. This is a hard rule for
  the speech-to-speech providers, whose models otherwise drift into assistant-chat
  patterns; keep any new spoken-behaviour guidance consistent with it.
- **The prompt carries the schedule, not just the calendar names.** The system
  instruction bakes in a compact digest of the next `MISSION_CONTROL_VOICE_CONTEXT_DAYS`
  (default 30) of events — per day, `who — title, time, @ location` — built by
  `prompt.build_schedule_digest` from the same `[today, +N]` snapshot the token cache
  already fetches (`app/voice/cache.py`). This is what lets a loose reference ("that
  doctor appointment in Bellevue later this month" → a "new patient visit" at a Bellevue
  clinic) resolve with **no tool call**: the prompt tells the model to match the spoken
  words against **both** the title and the location. `get_events` is for dates past the
  window or a detail a line does not carry. The digest costs ~a line per busy day; the
  token cache amortises it, and event-boundary freshness is unchanged (the *next*
  boundary still dominates `freshness_horizon`). The Local / Hybrid pipeline resolves
  entities against the same `voice_context_days` window (`api._local_snapshot`), and
  `entities.resolve_event` matches location as well as title/category.
- **Transcript assembly lives in the provider, not `useVoiceSession`.** Each
  `user-transcript` `VoiceEvent` carries the **whole best-so-far string** (Gemini
  concatenates its VERBATIM `inputTranscription` fragments; the relay accumulates
  `input_audio_transcription` deltas and the `completed` frame replaces). The hook just
  shows the latest — a revised final hypothesis **replaces** the earlier one rather than
  appending, so an inaccurate early partial does not linger on screen through the
  model's thinking time. The interim preview shows only until the first settled text.
- `surface` is accepted on the token request and threaded through unused — reserved for
  a future multi-screen setup where one screen's command drives another.

### Provider architecture — integrated cloud *and* future local/hybrid

**Durable principle.** Mission Control's voice architecture must support both integrated
cloud speech-to-speech providers *and* composition of local/hybrid speech, routing, tool,
reasoning, and TTS components. Do not couple core application behavior to the assumption
that a single provider owns the complete conversational audio pipeline. Add abstractions
only when a concrete implementation needs them — do not prematurely construct a
generalized voice framework.

Context: there is a four-way **cloud bake-off** — Gemini Live, Azure Voice
Live, Azure OpenAI Realtime (`gpt-realtime-2.1`), and Azure OpenAI Realtime
(`gpt-realtime-2.1-mini`) — plus a fifth **experimental** contestant, **Local /
Hybrid** (`MISSION_CONTROL_VOICE_PROVIDER=local`), that composes stages
independently: wake-word → local STT → local intent recognition/entity resolution →
(local tool execution | cloud escalation) → response → (cloud TTS, later). It is
selectable in Settings and has its own **### Local / Hybrid pipeline** section
below. The cloud contestants are unchanged by it.

What this requires of anyone touching voice now:

- The cloud contestants implement the experience as integrated realtime
  speech-to-speech providers. Do **not** artificially decompose them internally to satisfy
  a hypothetical abstraction — the Local / Hybrid path is where decomposition lives.
- The generalized STT / intent / escalation seams now exist **only inside
  `app/voice/local/`**. Do not hoist them into the shared voice layer or build a
  generalized voice framework around them; the shared layer still just sees a
  `ConversationalVoiceProvider` emitting `VoiceEvent`s.
- Keep the application-level voice-provider contract from assuming every provider is an
  indivisible speech-to-speech service. Shared conversational semantics and Mission
  Control operations stay **above** provider-specific protocols; a future local/hybrid
  path must be able to join the same conversation/tool flow without pretending to speak
  the Gemini Live, Azure Voice Live, or Azure OpenAI Realtime wire protocol.
- **End-of-speech detection is negotiated, not fixed at the shared layer.** A provider
  with suitable end-of-speech detection uses it (`grant.endpointing` `hybrid` /
  `provider`); the shared mic-RMS silence detector is the *default*, applied when a
  provider declares nothing suitable (`client`). The shared turn state machine
  (`useVoiceSession`) must switch strategy on the declared mode — it must not assume it
  always owns endpointing, nor infer ownership from whether a provider event happened to
  arrive.
- **Wake-word selection stays orthogonal to conversational-voice selection.**
  `WakeWordProvider` answers "what makes Mission Control start listening?"; the
  conversational-voice config answers "what handles the interaction after activation?".
  Neither depends on the other. (See **Wake word**.)
- **Tool execution must not depend on a speech-to-speech provider.** Core Mission Control
  tool execution stays reachable from an eventual local intent router exactly as it is
  from Gemini / Azure tool calls — the existing "tools are explicit application tools,
  never providers" rule already points this way; keep it that way.
- Settings changes should leave room for later controls *beneath* a Local / Hybrid
  option (speech-recognition provider, local intent/router, escalation provider/model,
  speech-output provider) without adding any of them now.
- **Bake-off instrumentation measures the whole user-perceived interaction**, not just
  model/API timing. Preserve milestone seams that a hybrid path can reuse: activation /
  input start, end of user speech, transcription availability (where applicable),
  intent/tool decision, tool invocation/completion, cloud escalation (where applicable),
  first response audio, interruption/cancellation, errors and recovery. (`instrument.ts`
  `VoiceTimeline` is the current home of these marks.) The turn report also records
  `endpointing` (from the `token-received` mark) so the bake-off can compare
  end-of-speech modes.

### Local / Hybrid pipeline

`MISSION_CONTROL_VOICE_PROVIDER=local` (`backend/app/voice/local/`,
`frontend/src/voice/providers/local.ts`, `docs/local-voice-plan.md`,
`docs/local-stt-evaluation.md`). On-device STT + intent/entity interpretation;
the cloud is an **escalation capability, not a mandatory hop**. Experimental, but
wired end to end and selectable in Settings. **Durable decisions:**

- **The pipeline runs on the backend, driven over `WS /api/voice/local`** (a
  relay-style single-use ticket in the grant, `reusable_grant = False`, LAN-gated
  — same shape as the Azure relay). The kiosk streams 16 kHz mic audio and drives
  the same `ConversationalVoiceProvider` interface as every other contestant; it
  never sees the STT engine or the interpreter. Two extra `VoiceEvent`s —
  `diagnostic` and `escalation` — are additive and ignored by the cloud paths.
- **Four layers, each separately replaceable and text-testable** (no mic, no
  model): `recognizer` (STT seam) → `intents` (weighted-regex catalogue, never
  exact-string, never a giant static grammar) → `dates` + `entities` (fuzzy
  resolution against the **live `CalendarSnapshot` passed in per turn**, no
  baked-in name list) → `interpreter` (confidence, tier, plan). Keep raw
  transcription, semantic parsing, entity resolution and execution logically
  separable so each evolves independently.
- **Mission Control never imports faster-whisper / sherpa-onnx directly** — only
  `SpeechRecognizer` (`app/voice/local/recognizer.py`). Engines
  (`engines/`, lazily imported) are a config choice; the dependency-free
  `scripted` engine backs tests and the text bypass. A discrete GPU is an
  **opt-in accelerator, never required** — `device=auto` is CPU, and CPU int8
  already meets the interactive target (see the evaluation doc).
- **Tool execution stays in the browser through the existing dispatcher.** The
  interpreter only *decides which tools to call*, exactly as a cloud model would
  — extends "tools are explicit application tools, never providers".
  `set_people_filter` was added to the shared tool contract as part of this
  (a view-state tool, like `show_view`).
- **`Interpretation.disposition` is the explicit local-vs-escalate representation:**
  `handled_locally` / `needs_clarification` / `rejected` / `escalate_to_cloud`.
  Tiers: 0 deterministic-local, 1 local + live entity resolution, 2 local STT +
  cloud *text* reasoning (escalate with only the bounded structured context), 3
  fully conversational. **The cloud text call is a stub / extension point
  (`CloudEscalator`)** — do not treat Tier 2 as done.
- **Safety: a mutating request below the mutation-confidence threshold is never
  executed on a guess** — it becomes `needs_clarification`. Calendar writes stay
  `rejected` unconditionally (voice is read-only). "Recognised but unsupported"
  (display power, shopping lists) is a clean "can't do that yet", never a
  fallback to guessing.
- **Observability:** every turn emits a `diagnostic` event with the full
  interpretation trace (transcript, intent scores, entity candidates, resolved
  entities, confidence, reason, timings); `window.__voiceLocal` holds the latest.
  `POST /api/voice/local/interpret {text}` returns the same object with no audio —
  the way to test the semantic layer and the documented voice bypass.
- **Model provenance** (weights vs. runtime licence) is tracked in
  `docs/credits.md` + `docs/local-stt-evaluation.md`; model binaries are
  provisioned per install, never committed (`backend/voice-samples/` and the STT
  caches are git-ignored). The reusable command corpus is text
  (`backend/tests/data/voice_commands.jsonl`) — no personal recordings in git.
- **Keep `docs/voice-commands.md` and the corpus current** when the intent
  catalogue, the supported/unsupported line, or the tool set changes — same rule
  as the cloud path.

## Wake word

Local "Mission Control" activation (`docs/wake-word-plan.md`,
`docs/wake-word-model-training.md`, `docs/wake-word-provider-bakeoff.md`).
**Off by default**; a missing model, runtime, or backend degrades silently to
push-to-talk, which is always independent of any of this.

- **It is not conversational AI.** The detector answers only "did someone say the
  phrase?" — it never touches Gemini, tools, or the transcript. On detection it
  calls the *same* `startTurn()` the Ask button does.
- **Providers (a bake-off, orthogonal to the voice-provider one).**
  `WakeProviderId = "openwakeword" | "azure"`, selected at runtime from Settings
  (`PUT /api/voice/wake-config` → process-memory override, like the voice
  provider) and defaulted by `MISSION_CONTROL_WAKE_WORD_PROVIDER`.
  - `openwakeword` (default): **browser-resident** — no host process; all
    idle-listening audio stays in the browser and only the turn *after* the
    phrase reaches the voice provider.
  - `azure`: an Azure Speech Studio custom-keyword `.table`, spotted **on the
    backend** by the native Speech SDK (`backend/app/voice/wake_azure.py`, the
    optional `.[azure-wake]` dependency). The JS Speech SDK has no working
    `.table` loader, so the kiosk streams 16 kHz mic PCM to
    `WS /api/voice/wake/azure` (`AzureKeywordDetector`) and the backend answers
    `{type:"wake"}`. Spotting is still on-device (no key, no network) but the
    audio reaches the backend — a **deliberate exception** to "no host process",
    at the same localhost/LAN trust boundary as the Azure voice relay.
- **Seam.** `frontend/src/voice/wake/` — `WakeDetector` interface +
  `createWakeDetector()` (picks the impl from `config.provider`);
  `OpenWakeWordDetector` (local ONNX via lazily-imported `onnxruntime-web`, a
  package dependency, kept out of Vite's dep pre-bundle so it resolves its own
  `.wasm` same-origin); `AzureKeywordDetector` (the backend WS relay above);
  `FakeWakeDetector` (`VITE_WAKE_FAKE=1`, mic-free, for tests/manual UI);
  `WakePreroll` is the shared pre-roll ring buffer. `useWakeWord` owns the
  detector lifecycle, the provider switch, and diagnostics. Mock it the way
  `./session` / `./audio` are mocked.
- **One microphone, one gain.** `audio.ts` has a reference-counted `MicSource` (one
  `getUserMedia` + `AudioContext` + capture worklet, many listeners). Never open
  a second mic stack — push-to-talk and the detector are both just listeners.
  *Which* input device that one stream opens is `useAudioInput` →
  `micSource.setInputDeviceId()` (per-browser `localStorage['mission-control.audio-input']`,
  default `"auto"`, which prefers a **VB-CABLE** virtual input when present); pure
  logic in `voice/audioInput.ts`, picker in Settings → Microphone. Never put a
  `deviceId` constraint anywhere else.
  `MicSource` also owns the **only** gain stage (`voice/gain.ts`): a dB-denominated
  amplitude multiplier (`10^(dB/20)`, 0 dB = off, the default — the hardware mic
  path carries the level; opt in per install) applied to every
  native frame *before* fan-out, so wake word and the provider both get the
  adjusted, ±1-saturated audio and neither knows it happened. Configured by
  `MISSION_CONTROL_MIC_INPUT_GAIN_DB` → `VoiceConfig.mic_input_gain_db` on `GET
  /api/voice/config` → `useVoiceConfig` pushes it to `micSource.setInputGainDb()`.
  Tune it from the throttled `[voice] mic input level` console line
  (peak / RMS / clip%); `micSource.inputGainStats()` exposes the same numbers.
  Nothing else may change level: `autoGainControl` is off so browser AGC can't
  fight it, `voice/pcm.ts` (the one home for format/rate conversion) never touches
  amplitude, and the client's speech/silence thresholds are normalised back to
  `LEVEL_REFERENCE_GAIN_DB` so turning the knob does not silently re-tune the
  endpointer. **`docs/audio-pipeline.md` is the authority** on all of this — the
  capture and playout chains, every audio setting and where it lives, and the
  rules for adding one. Read it before touching anything audio.
- **State.** `useVoiceSession` gains an `armed` status (behaves like `idle` for
  every control). Detection → immediate `connecting` overlay (no network wait) →
  normal turn → re-arm. Detector suspended during
  `connecting/listening/thinking/speaking` so the assistant's own audio and
  stray detections cannot open a second session. `resume()` **clears the whole
  feature pipeline** (mel/embedding windows) and resets the cooldown — otherwise
  the phrase that opened the *previous* turn is still inside the model's window
  and re-fires the instant we re-arm, opening a spurious turn the model then
  answers from nothing.
- **Pre-roll.** A 16 kHz ring buffer (`wake/ringBuffer.ts`, rate conversion
  delegated to `voice/pcm.ts`) captures continuously
  while armed; on a wake fire `useVoiceSession` reads back the run-up + command
  start, **resamples it to the provider's input rate** (`resampleFrom16k` — 16 kHz
  for Gemini, 24 kHz for the Azure relay; a mismatch plays the lead-in 1.5x fast
  and unintelligible), and flushes it via `session.sendAudio()` right after
  connect, before the live mic, so single-shot ("Mission Control, what's on
  today?") keeps its start. **Retention must continue through `connecting`** — the
  turn suspends the detector seconds before the live mic starts streaming, so
  `OpenWakeWordDetector.suspend()` stops inference but keeps `retaining` on;
  `takeRetainedAudio()` is what turns it off (until `resume()` re-arms). Dropping
  retention at suspend loses the whole command on a single-shot phrase.
- **Config.** `MISSION_CONTROL_WAKE_WORD_*` in `config.py` (enabled, phrase,
  threshold, cooldown_ms, model_path, models_base_url, **provider**,
  **azure_model_path**); `GET /api/voice/wake-config` (`_require_local`-gated)
  reports `enabled` only when both wake word and voice are on, plus the active
  `provider` and the selectable `providers[]` (`configured` is false for `azure`
  until the SDK + `.table` are present). `PUT` swaps the provider. Resolution +
  labels live in `app/voice/wake.py` (mirrors `app/voice/providers/`).
- **Settings.** A "Wake word" control (on/off + status/detail/last-latency note)
  and, when more than one back end is offered, a "Keyword provider" button list —
  both shown only when the backend permits it. No permanent dashboard space; no
  debugging console in the kiosk UI.
- Web Speech API is **ruled out** — Chrome sends its audio to Google, breaking
  local-by-default. (The `azure` provider's `.table` spotting is genuinely
  on-device — the audio goes only to our own backend, never to Azure.)

## Timers

A dedicated Timer tab (`docs/timer-plan.md`). One active timer at a time,
**backend-owned and in-memory** — a restart clears it (accepted). No feature flag;
timers are core.

- **State.** `Timer` / `TimerCreateRequest` / `TimerExtendRequest` /
  `TimerMutationResult` in `app/models.py`; the store + `asyncio` scheduler is
  `app/timers.py` (a process singleton, keyed by id so *N* concurrent timers is a
  later config change). `/api/timers` `GET`/`POST`/`PATCH`/`DELETE` plus
  `POST /api/timers/{id}/pause|resume|restart` in `app/api.py`, all
  `_require_local`-gated. Creating a timer while one exists **replaces it
  silently**; every result/broadcast carries `replaced` so every surface can say so.
- **Pause / resume / restart.** `pause` freezes the countdown into
  `Timer.remaining_seconds` and sets `state = "paused"` (`fires_at` goes stale —
  read `remaining_seconds`); `resume` rebases `created_at`/`fires_at` from now so the
  original `duration_seconds` and the progress ring stay honest; `restart` resets to
  the full `duration_seconds` from any state. Extending a paused timer keeps it
  paused. Voice tools mirror all three (`pause_timer` / `resume_timer` /
  `restart_timer`).
- **Six-hour cap** (`MISSION_CONTROL_TIMER_MAX_SECONDS`, default 21600) enforced in
  three places: the Pydantic model (source of truth), the voice tool check, and the
  touch dial (cannot travel past 6h).
- **Frontend.** `frontend/src/timers/` — `useTimers()` owns the single timer, the
  `/api/ws` subscription, a 1 Hz countdown *only while a timer is active*, a
  local-clock safety-net fire if the socket is down, `navigator.wakeLock('screen')`
  while active, and the alarm chime. `TimerView` renders setup / running / fired.
  Setup is a vertical stack with one hero (the dial) and one primary (Start);
  duration presets feed the dial, the label is a separate optional block below a
  divider. Running groups the controls by concern — *add time* (`+1`/`+5`) apart
  from *controls* (Pause/Resume primary·coral, Restart, Cancel·ghost). One primary
  per state. See `docs/controls-layout-design.md` → "Timer view".
  The chime (`timers/chime.ts`) plays through the shared echo-cancelled output bus
  (`voice/aecPlayback.ts`), not `context.destination` — it routinely rings while
  someone is speaking to the kiosk, and uncancelled playout is heard by the open
  mic as speech. See `docs/audio-pipeline.md`.
- **Default view — ambient, not a lock.** While a timer is active the Timer view
  is the view the app settles on *when it chooses*: starting a timer switches to
  it, `fired` force-switches to it, and a timer already running at cold boot (or
  arriving from another screen) shows it via a one-shot `hasActiveTimer`
  `false→true` edge effect. **Explicit navigation is never overridden** — a mode
  tab, the brand / Home control (`goHome()` goes Home, no `defaultView()`
  indirection), and voice `show_view` all go exactly where asked while the timer
  keeps counting. A future idle-revert / display-wake must honour the same "Timer
  while active, Home otherwise" rule (see `docs/camera-support-plan.md`).
- **Cross-view tracking.** When the Timer view is off screen, the soonest-to-fire
  timer's remaining time rides on the **Timer dock button** (`M:SS` under an hour,
  `H:MM` past it, `Done` while firing) — not the header, not a floating chip. It is
  hidden on the Timer view itself (the full-bleed countdown repeats it). See
  `docs/timer-plan.md` → "Cross-view timer tracking" / "Visual separation".
- **Alarm.** Chime loops while `fired`, stops after
  `MISSION_CONTROL_TIMER_ALARM_MAX_RING_SECONDS` (default 5 min); the visual
  finished-state persists until dismissed (tab, tapping the alarm surface, or voice
  "stop").
- **Display keep-awake seam.** `useTimers()` exposes `hasActiveTimer` / `alarm` as
  semantic booleans for the future display-power controller (see
  `docs/camera-support-plan.md`): a timer must count as a keep-awake vote and, when
  the policy would otherwise sleep the panel, switch to the Timer tab instead.

## Lists

A "lists" utility, currently one **grocery list** (`docs/lists-plan.md`). Like the
Timer tab it is a **role/appliance mode**, not a calendar view — set apart in the
dock (gap + hairline, `fern` identity not `coral`, an unchecked-item count badge)
with a warm self-contained panel. `ViewMode` gains `'lists'`.

- **State — backend-owned and *durable*.** `GroceryList` / `ListItem` /
  `ListItem*Request` / `ListMutationResult` in `app/models.py`; the store is
  `app/lists.py` (process singleton, keyed by id so several named lists is a later
  config change). Unlike timers it **persists to one JSON file**
  (`MISSION_CONTROL_LISTS_FILE`, default `lists.json`, git-ignored, atomic write,
  reloaded at startup) — a wall appliance that forgets the grocery list on reboot is
  broken UX. Same "one file, no datastore" class as the MSAL cache; a SQLite store
  drops in behind the store's shape. `MISSION_CONTROL_LISTS_RECENT_ITEMS_MAX` caps
  the remembered item-name history.
- **`/api/lists`** `GET` (all / one), `POST /{id}/items` (add — `name` or `names[]`,
  deduped: an unchecked match is a no-op, a checked match is un-checked),
  `PATCH /{id}/items/{itemId}` (check/uncheck/edit), `DELETE /{id}/items/{itemId}`,
  `POST /{id}/clear` (`scope` `checked` default / `all`), `POST /{id}/restore` (Undo),
  `POST /{id}/reorder` (`item_ids` in the new drag order — a partial list keeps
  unnamed items after; the order is persisted, so `restore` no longer re-sorts).
  All `_require_local`-gated and `_require_unlocked` (privacy mode). Every mutation
  returns the state **and** broadcasts.
- **Real-time.** Reuses `ApplicationMessage` (now also `lists` / `list` / `removed`)
  and the `/api/ws` push — `list-item-added` / `-removed` / `-checked` / `-unchecked`
  / `-cleared` / `-restored` / `-reordered`. `app/realtime.py` sends the current lists on connect.
  **One socket:** `frontend/src/realtime/appSocket.ts` + `useAppSocket` is the shared
  `/api/ws` connection that both `useTimers` and `useLists` subscribe to (no second
  socket, no bus).
- **Frontend.** `frontend/src/lists/` — `useLists()` owns the list, reconciles via
  `GET /api/lists/{id}` on (re)open, applies pushes, and fires `onRemoved` so a clear
  shows an on-screen **"Cleared N · Undo"** (`lists.restore`). `ListsView` renders the
  unchecked rows (tap = check off, `×` = remove), a "Got it" strip of checked items,
  and a **recent-items quick-add grid** — the touch path for adding, since there is
  no on-screen keyboard (novel items come from voice, matching the timer-label
  precedent). "Clear all" is behind an overflow `⋯` + confirm. Unchecked rows have a
  **drag grip** (`frontend/src/lists/dragReorder.ts` — pointer-capture drag, touch-first,
  no HTML5 DnD) that reorders them and persists via `POST .../reorder`; a stale
  `list-reordered` echo is suppressed briefly after a local drag. The dock **Lists**
  button carries the unchecked count when another view is on screen.
- **Voice** is the second read-only exception (above): `add_to_list` (splits
  "x, y and z"), `remove_from_list`, `check_off_item`, `clear_list`, `get_list`; any
  list change also calls `show_view('lists')`. The local pipeline's `list.*` intents
  (`intents.py`) are `supported=True` and planned in `interpreter.py`;
  `entities.resolve_list` matches grocery aliases and asks (never guesses) for an
  unknown named list. `docs/voice-commands.md` carries the phrasings.

## Privacy mode

A houseguest-facing state that **redacts the specifics** (event/list title,
location, category → `•••` and identity-colour only; the *when / how many / whose*
stay) **and locks the appliance read-only** until a PIN is entered on screen. One
household-global flag drives both. `docs/privacy-mode-plan.md` is the design
record + the ratified resolutions. **It is a social / glance barrier, not a
security control** — physical access to the host defeats it.

- **Backend-owned, persisted, broadcast.** `app/privacy.py` is a `PrivacyStore`
  singleton in the same mould as `app/timers.py` / `app/lists.py` (injected clock
  + broadcast, no socket import). State persists to
  `MISSION_CONTROL_PRIVACY_STATE_FILE` (default `privacy.json`, git-ignored) so a
  power-cycle does not clear it; wrong-PIN lockout counters are process memory
  only. `PrivacyState` rides `ApplicationMessage.privacy` on the `/api/ws` hello
  and every lock / unlock.
- **The read-only gate is one line.** `_require_unlocked()` in `app/api.py`
  returns **423 Locked** while privacy mode is on, and is called after
  `_require_local` on every mutating endpoint (timers, lists, calendar sign-in,
  `PUT /api/voice/config`). **A new mutating endpoint MUST add
  `_require_unlocked()`** — the Definition of Done has a line for it. The one
  exception: `DELETE /api/timers/{id}` is allowed while locked *iff* that timer
  is `fired`, so a ringing alarm can still be silenced.
- **Voice stays reachable; commands do not.** The session is **not** gated — the
  assistant answers — but `frontend/src/voice/tools.ts` refuses every tool while
  locked (reads included, so no titles are spoken) **except**
  `request_privacy_unlock` (brings up the keypad) and `enter_privacy_mode`. Voice
  can turn privacy mode *on* and *ask* for the keypad; it can never turn it
  *off* (speaking a PIN aloud would defeat it).
- **Entry is understated, exit is gated.** A ~600 ms press-and-hold on the brand
  lockup (`BrandLockup` in `App.tsx`), a Settings row, or the voice tool enters
  it — no secret, the safe direction, plus an 8 s no-PIN "Undo". Exit is a
  header padlock → `PrivacyPad` (a fixed `7-8-9 / 4-5-6 / 1-2-3 / 0` keypad, no
  text field — the kiosk has no keyboard) → `POST /api/privacy/unlock`. MVP is
  **exactly four digits**, backend-configured (`MISSION_CONTROL_PRIVACY_MODE_PIN`,
  default `8426`); **blank disables the whole feature** (entry affordances
  hidden, `lock` 409s — nobody can be locked out).
- **Redaction is a render choice, not a data change.** `App.tsx` maps events
  through `redactEvent` and forces `people-first` colour + a no-op `onSelect`
  while locked; `ListsView` takes a `redacted` prop. The snapshot the backend
  sent is untouched, so unlock is instant. No React context was added (the
  prop/transform path was lighter — see the plan's §0).

## Bundled media

Any media asset committed to the repo (or generated at runtime in place of one)
gets its source + licence noted in `docs/credits.md`. One line per asset;
lightweight, not a review process.

## ML / audio / vision model artifacts

Any trained model artifact (wake-word, and future camera/presence models per
`docs/camera-support-plan.md`) gets its **licence and provenance reviewed
independently of the software library that executes it** — an Apache-2.0 or MIT
runtime says nothing about the weights. Record, before adopting one: the runtime
licence; the licence on the actual weights; where they came from; how they were
trained or obtained; and any redistribution/commercial restriction. Keep the
record in `docs/credits.md` (one line) with the detail in the feature's doc
(e.g. `docs/wake-word-model-training.md`). Model binaries are provisioned per
install, not committed.

## The frontend/backend contract

`app/models.py` is authoritative. `frontend/src/App.tsx` currently re-declares the
matching TypeScript types by hand — when you change a model, update both sides in the
same change, or generate types from the API's OpenAPI schema
(`http://localhost:8000/openapi.json`). Field names are `snake_case` on both sides.

## Time handling

All datetimes in the domain are **naive local time** for the household's location.
Providers that return timezone-aware datetimes must convert at the provider boundary
before constructing domain models. Revisit if the product ever spans time zones.

## Conventions

**Backend:** Python 3.12+, FastAPI, Pydantic v2, type hints throughout, async handlers
where they help. Ruff is configured in `pyproject.toml` (`ruff check`, `ruff format`).
Keep modules small; avoid interfaces with no foreseeable second implementation.

**Frontend:** React + TypeScript strict + Vite, no component framework. Keep state
local until real complexity demands otherwise. Pointer/touch-first; do not rely on
keyboard or hover for primary functionality (defensive Escape/`aria-*` handlers are
fine). Establish spacing/type/color/touch sizing as CSS custom properties rather than
scattering magic numbers.

**Both:** small, readable changes tied directly to the requested behavior. No
credentials, fake secrets, or vendor SDKs committed. Secrets live in git-ignored
`.env` files.

## Testing expectations

Test meaningful behavior, not a coverage number. At minimum keep coverage for:

- calendar time-range querying and mock-provider behavior
- domain-model validation (event time ordering, all-day boundaries, range ordering)
- category vs. calendar-identity classification staying separate
- Graph providers: event mapping, all-day handling, tz→naive conversion, pagination,
  token caching, missing-credential / not-signed-in errors (HTTP mocked with `respx`,
  MSAL exercised offline against a temp cache — no network)
- API endpoint behavior via `fastapi.testclient`: health, `/api/calendar` range params /
  defaults / reversed-range 422, and `/api/calendar/auth*` (state machine, local guard,
  provider guard) with MSAL patched
- meaningful frontend interactions (mode switching, event detail, filters, color mode,
  week start, per-calendar color override + persistence, calendar sign-in prompt +
  device-code sheet); the persistent Home/Week/Month group staying spatially stable;
  the contextual Today action appearing only off-today and not shifting the mode
  group; the sync-status indicator absent while healthy and its detail popover on
  warning; Month "+N more" overflow and its day-detail sheet
- voice: `/api/voice/token` (disabled → 409, unconfigured provider → 409, non-LAN → 403,
  grant locks tools + calendar names; cache hit vs re-mint across event boundaries,
  midnight, timezone, and provider change) with the `google-genai` client faked;
  `/api/voice/config` GET/PUT (provider list + switch, LAN gate); the Azure adapters +
  relay translation both directions + one end-to-end relay run against a fake upstream +
  the `WS /api/voice/live` ticket/LAN gate (`test_voice_relay.py`); frontend tool
  dispatch, the `useVoiceSession` state machine (provider seam mocked),
  `RelayVoiceProvider` (`providers/relay.test.ts`, fake `WebSocket`), the debug
  audio recorder (`debugRecorder.test.ts` — capture ring, WAV encode,
  enable/count flags, best-effort upload) and `POST /api/voice/debug/capture`
  (writes WAV + sidecar, prunes to keep, 409 off / 403 non-LAN / 422 non-WAV)
- local / hybrid voice: the semantic layer with **text input only**
  (`test_voice_local_intent.py`) — multiple phrasings per intent, date/time
  expressions, dynamic + fuzzy + ambiguous entity matching, unsupported requests,
  low-confidence recognition, **no unsafe ambiguous mutation**, and the
  local-vs-escalate decision (bounded escalation payload); the WS pipeline +
  grant + `POST /api/voice/local/interpret` + ticket/LAN gates with the scripted
  recogniser (`test_voice_local_pipeline.py`); `LocalHybridVoiceProvider`
  (`providers/local.test.ts`, fake `WebSocket` — forwards `VoiceEvent`s +
  `diagnostic`/`escalation`, JSON-string tool results). The real STT engine is
  benchmarked on hardware (`scripts/benchmark_local_stt.py`), not in CI.
- lists: the store (`test_lists.py` — add dedupe / un-check-on-re-add, check/uncheck
  timestamps, remove + clear(checked|all) + restore, reorder (custom order, partial id
  list, no-op, survives reload + undo), capped recent-names surviving a clear, broadcast
  on every mutation, JSON reload + corrupt-file reseed); the endpoints (happy paths,
  404s, 422 blank name, reorder persists, `_require_local` 403, WS lists-on-connect
  + broadcast); frontend `useLists` (reconcile, apply push, ignore non-list frames,
  `onRemoved` → Undo, optimistic reorder + stale-echo suppression), `moveItem`
  (`dragReorder.test.ts`), the five list tool dispatches (`tools.test.ts`), an App-level
  view + check-off + dock-count test, and Playwright kiosk-fit + quick-add + check-off
  + drag-reorder-sticks-after-reload.
- privacy mode (`test_privacy.py`): the store (lock idempotent + `since`, unlock
  ok/bad/disabled, lockout after N + doubling cooldown, undo only inside the grace
  window, JSON reload + corrupt-file → unlocked), the config validator (4 digits or
  blank), the endpoints (401/409/429+`Retry-After`/410, `_require_local` 403), the
  **gate** (a mutation per area is 423 while locked, the GETs still 200, a `fired`
  timer still dismissible, `/api/voice/token` **not** 423), WS privacy-on-connect +
  broadcast; frontend `usePrivacy` (reconcile, apply push, cooldown), `PrivacyPad`
  (four-digit submit, wrong-PIN shake, cooldown-disabled, no text input), the
  privacy tool dispatch (refuses others while locked, `request_privacy_unlock`
  opens the pad), an App-level redact + read-only + padlock test, and a Playwright
  long-press-enter → redacted → wrong-then-right-PIN → restored.
- wake word: `/api/voice/wake-config` (default disabled, enabled only with both flags,
  non-LAN → 403); the wake/voice state machine (arm → detect → turn → re-arm, suspend
  during a turn, repeated/late detections don't stack sessions, disable stops it,
  detector-unavailable leaves push-to-talk working) with the detector + mic mocked
  (`frontend/src/voice/wake/wakeSession.test.ts`); the ring buffer / downsample unit
  tests. The real ONNX detector is validated on hardware, not in CI.
- Playwright: each primary mode fits the kiosk viewport with no document overflow at
  3840x2160 and 1920x1080; the Ask button starts a turn, and a 409 disables it and shows
  the "Voice is turned off" toast. Unit: `VoiceToast` (headline per kind, retry only when
  recoverable, auto-dismiss) and `useVoiceSession` failure classification / retry.

## Definition of done

- `pytest` passes from `backend/`.
- `ruff check` and `ruff format --check` pass from `backend/`.
- `npm run test`, `npm run lint`, and `npm run build` pass from `frontend/`.
- Playwright (`npm run test:e2e`) passes when frontend behavior or layout changed.
- Changes are small, readable, and scoped to the requested behavior.
- No document-level scrolling in Home/Week/Month at 3840x2160 or 1920x1080.
- **A new mutating API endpoint calls `_require_unlocked()`** after `_require_local`
  (privacy mode is a read-only lock over *all* mutation — see **Privacy mode**).

## Current non-goals (do not start without an explicit request)

Google Calendar, Home Assistant, frontend authentication / account management,
SQLite / a real datastore (the grocery list's single JSON file is the one durable
store — do not add more), Docker, Redis, Postgres, message brokers, cloud
infrastructure. Voice cannot write the calendar — no voice-driven calendar writes,
no conversation persistence. (Voice may set/cancel/extend/pause/resume/restart the
kitchen timer and manage the grocery list — the two documented exceptions; see
**Timers** and **Lists**.) Lists: one grocery list only — no multiple named lists,
list CRUD, categories/aisle grouping, or an on-screen keyboard yet
(`docs/lists-plan.md` §12). The **Local / Hybrid** voice pipeline (local STT + intent /
entity resolution + cloud escalation) **is** now in scope and integrated, experimentally
(see **Voice assistant → Local / Hybrid pipeline**); keep its seams inside
`app/voice/local/`, do not generalize them into the shared voice layer, and the cloud
*text* escalation and local TTS stay unbuilt (extension points only) until asked. Local
wake-word activation **is** also in scope and integrated (see
**Wake word**); it stays local-only, off by default, and never replaces the
push-to-talk path. (Microsoft Graph *read* providers exist for both tenant and
personal accounts; do not expand them into write-heavy two-way sync without being
asked.)

**Privacy mode is built** (see the **Privacy mode** section) — a redact-the-specifics
+ read-only-lock state for a houseguest, `docs/privacy-mode-plan.md`. Still out of
scope on top of it: an in-app way to set the PIN, a passphrase (needs an on-screen
keyboard), multiple privacy *levels*, server-side title redaction, hold-to-reveal,
and a presence-detection auto-trigger.
