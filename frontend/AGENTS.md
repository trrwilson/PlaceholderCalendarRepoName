---
name: Mission Control frontend
description: Durable UI/UX judgement for the kiosk display — chrome, event legibility, holidays, colour.
---

# Frontend — UI/UX rules

React 19 + TS strict + Vite, one stylesheet (`src/App.css`), pointer/touch-first.
Read the repo-root `AGENTS.md` first. This file is the design judgement that the code
does not make obvious; layout mechanics live in `docs/controls-layout-design.md`.

## Persistent chrome (header, status, nav)

The frame around the calendar is not a dashboard — reclaimed space goes to schedule
content.

- **The header carries actionable/contextual info only:** temporal context (month +
  year / visible range / date), a subordinate current time, the two global actions
  (Ask / Add). No branding that sets height, no boilerplate, no filler widgets. One
  compact band, same grammar in every view.
- **Normal status consumes no chrome.** No persistent "live sync" indicator. A reserved
  header slot shows warnings/errors (offline, sign-in needed) only when unhealthy — an
  icon with detail behind a tap, never inline text.
- **Bottom dock: nav (left) + adjust (right).** Left = mode nav ("what am I looking
  at?"); right = People then Settings ("change what I see"). No third zone — global
  actions stay in the header. Every dock control is one object (`--dock-control-*`
  tokens): one height, one radius, one type size.
- **Mode nav is spatially stable.** Home / Week / Month are equal-weight peers whose
  positions never move. Timer and Lists are *appliance modes*, set apart in the same
  nav by a wider gap + a full-height hairline and their identity colours (coral /
  fern) — set apart, not elevated: same size, same reading order.
- **Ambient badges ride a dock button's top-right corner** (soonest timer remaining,
  unchecked-item count) as absolute overlays, so the button and its neighbours never
  resize or shift when a timer starts, ticks, or ends.
- **Contextual actions are not modes.** "Today" appears only when Week/Month is off
  today, styled distinctly and placed outside the mode cluster; its show/hide never
  shifts the mode buttons.
- **Settings is a categorised centred sheet** (`.detail-scrim` / `.detail-sheet`
  family, Escape + scrim dismiss). Everyday display prefs are the default view;
  bake-off / diagnostic knobs sit behind an "Advanced" disclosure, collapsed, and
  never show raw engine error strings on the wall. Add a setting to the category it
  belongs to; add a category only for a genuinely distinct area.

## Calendar event legibility & overflow

- **Events are sized for the room, not the desktop.** Event rows are tall touch
  surfaces; the time is part of the event, never shrunk to metadata. Surrounding
  typography (headings, day numbers, status microcopy) is balanced *around* events,
  not scaled uniformly.
- **Never shrink ambient event type or touch size to solve overflow** — a busy day
  gets a progressive-disclosure affordance instead.
- **Month overflow:** a day cell renders as many full-size rows as comfortably fit
  (ceiling follows viewport height — ~3 at 4K, 2 at 1080p, never a per-day shrink),
  then a touch-friendly "+N more" opens the day's list in a contextual sheet. The grid
  is fixed: cells never expand or scroll internally.
- **Week view** has more room — show more detail directly, at the same baseline type
  and touch standards.

## Holidays

US public holidays are ambient context, **not events**. `src/holidays.ts` computes
them as a pure function of the date (browser local zone, no provider, no network, no
persistence — same class as `dates.ts`). The set mirrors the "Holidays in United
States" calendar; each carries one thematic emoji (no regional-indicator flag emoji —
Windows renders them as letters).

- **A holiday is a label, never a chip** — muted text + emoji, one step smaller than
  surrounding type, `pointer-events: none`, a `<span>` not a `<button>`. It never
  looks tappable and never opens a sheet.
- **It never moves real content** — it renders in space that already exists (Month day
  heading, Week all-day lane, Home headline), and the all-day lane is never made
  taller for it. Extend the set by adding rows in `holidays.ts`.

## Semantic colour

- **Calendar/person identity is the dominant ambient signal** — a fixed named palette
  (`CalendarColor`: coral, ocean, gold, fern, violet), rendered through shared
  `.calendar-<name>` marker classes in `App.css` (a new colour needs a token plus
  those rules). **Event category is a restrained secondary marker.** Never paint one
  large surface with both classifications competing.
- **Category colour is data-driven, not per-colour CSS:** the provider resolves a
  category to a concrete `#rrggbb`, the frontend passes it through a `--category-color`
  custom property, and `.category-*` rules derive fill (and a `color-mix` tint) from
  it. An unknown category or an unreadable mailbox degrades to the neutral marker.
- **Per-calendar colour is viewer presentation, not provider data.** A household member
  can remap any calendar to another palette colour from Settings; the choice is stored
  per-viewer in `localStorage` (`mission-control.calendar-colors`) and applied by
  remapping the snapshot before render — never written back to a provider. Same class
  of app-only state as the colour-mode and week-start prefs.
- Keep identity/category treatment consistent across Home, Week, Month, filters, and
  detail. Popovers dismiss on outside interaction, Escape, and navigation without
  swallowing intended inside clicks.
