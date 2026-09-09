---
status: reference
summary: Design record for the header / dock / settings layout grammar.
---

# Controls & settings layout design

Design record for a 2026-09-08 pass over three interactive surfaces that had drifted:
the **bottom dock**, the **Timer view**, and the **Settings flyout**. The brief:
establish layout principles for each (leaning on kiosk / smart-display precedent and
general good taste), then implement them. Decisions here were made autonomously and are
reversible; this doc is the rationale so a later reader knows what was deliberate.

Target device unchanged: a wall-mounted 27" 4K touchscreen, read from 6–10 ft, touched
at arm's length. Touch and voice are the primary modalities. See `AGENTS.md` →
"Product & design principles" and "Persistent chrome" for the durable rules this pass
sits under; nothing here overrides those.

## Shared vocabulary these surfaces now use

1. **One primary action per state.** Every screen/among-a-group has exactly one control
   with the strong fill (coral for live/appliance, ink for calendar). Everything else is
   an outline or a ghost. A passer-by's eye should land on the primary without reading.
2. **Group by role, separate by space.** Related controls sit together with a tight gap;
   unrelated clusters are separated by a generous gap and, where the split matters at a
   glance, a hairline. Never rely on a 1–2px hairline alone to carry a grouping at 3 m.
3. **Matched targets in a group.** Controls that share a row share a height, corner
   radius, and type size. Secondary function is expressed with fill/weight, not by
   shrinking the target.
4. **Ambient badges never resize their host.** A count or countdown that rides on a
   button is an overlay (absolute, corner) so the button — and its neighbours — never
   move as the value changes. Reinforces "persistent controls stay spatially stable".
5. **Distance-first type.** Control labels are `clamp()`-scaled for the room. Captions
   that only orient (an "optional", a section name) are one step down and muted; they
   never compete with the control label.
6. **Household controls out front, engineering controls behind a door.** The kiosk is a
   home appliance. Bake-off / diagnostic switches (voice provider, keyword provider, mic
   routing) are real but belong in an "Advanced" area, not on the same shelf as
   "week starts on".

## Dock tokens

`App.css` `:root` gained a small dock scale so every dock control is defined once:

```
--dock-control-h    : clamp(48px, 3.4vw, 84px);   /* every dock button */
--dock-control-px   : clamp(16px, 1.2vw, 36px);
--dock-control-font : clamp(15px, .84vw, 26px);
--dock-radius       : 12px;
--dock-gap-in       : clamp(4px, .4vw, 10px);      /* within a cluster */
--dock-gap-out      : clamp(14px, 1.4vw, 34px);    /* between clusters */
```

`--timer-*` and the settings sheet reuse the existing global tokens.

---

## 1. Bottom dock

### What was wrong

- **Three different button specs in one bar.** The mode buttons, the People filter, and
  the Settings toggle each had their own height / padding / type size. People and
  Settings read as small, dim afterthoughts next to the mode group — the opposite of
  their real importance.
- **The Timer / Lists separation was invisible at distance.** `AGENTS.md` calls Timer
  and Lists "role/appliance modes … set apart … a gap + hairline". The hairline was a
  1px `--line` rule and a `clamp(6px…)` gap — gone by 2 m.
- **The running-timer countdown resized the Timer button**, nudging Lists sideways every
  time the minute digit changed and again each time a timer started or ended.
- **No stated grammar.** Left = "navigation", right = "the two poppy things", but there
  was no articulated logic for what goes where.

### Principles adopted

- **The dock answers exactly two questions, left to right: "what am I looking at?" and
  "adjust what I see."** Navigation on the left, adjustment on the right. Global *actions*
  (Ask / Add) stay in the header, per the persistent-chrome rule — the dock gets no
  center "actions" group, because there is no third question.
- **Two clusters inside navigation: calendar views, then appliances.** Home / Week /
  Month are peers. Timer / Lists are a distinct kind of thing (an appliance you operate,
  not a period you view) and get their own cluster — a real `--dock-gap-out` gap plus a
  full-height hairline that is visible across the room, and they keep their identity
  colours (coral / fern). Set apart, **not** elevated: they stay in reading order after
  the views, same size, no center-stage promotion.
- **Every dock control is the same object.** One height (`--dock-control-h`), one radius,
  one type size. People and Settings are now the same size as a mode button — quiet
  (surface fill, `--line` border) until active/open (People shows its count; Settings
  fills `--warm` while its sheet is up).
- **Ambient state rides as a corner badge.** The soonest timer's remaining time and the
  unchecked-list count are absolutely-positioned pills on the top-right corner of their
  button (translated to straddle the edge, like a notification badge). The buttons are a
  fixed size in every state; nothing in the dock moves when a timer starts, ticks, or
  ends. The Timer view itself still hides the badge (the full-bleed countdown repeats
  it).
- **The contextual Today pill** stays a coral pill, appearing only off-today, trailing
  the whole nav (`.dock-primary` sibling of `.mode-nav`, `margin-right: auto` keeps the
  nav from shifting when it toggles). Unchanged in behaviour, resized to the dock scale.

### Layout

```
┌ VIEWS ──────────┐ ┊ ┌ APPLIANCES ┐                       ┌ ADJUST ────────────┐
│ Home  Week  Month │ ┊ │ Timer  Lists │  [Today]  ········  │ People 2/2   ⚙ Settings │
└──────────────────┘ ┊ └─────────────┘                       └────────────────────┘
   calendar periods       things you run     (space-between)      scope + config
```

`.mode-nav` holds both clusters (`.dock-views` + `.dock-appliances`); all five mode
buttons remain its descendants, so their DOM order and the spatial-stability tests are
unchanged. `.dock-primary` wraps `.mode-nav` + the Today pill; `.dock-adjust` holds
People + Settings. The `┊` is the full-height `.dock-appliances::before` hairline.

---

## 2. Timer view

"Timer items" = the interactive pieces inside the Timer view: the duration dial, the
preset chips, the label chips, and the running-timer control set.

### What was wrong

- **Two identical-looking chip rows** (duration presets and label chips) with nothing but
  a tiny kicker to say which is which. A glance couldn't tell "15 min" from "Laundry".
- **Ragged preset wrap.** Nine presets (`1 3 5 10 15 30 45 60 120`) wrapped 7 + 2, and
  mixed units inline ("45" next to "1 hr" next to "2 hr").
- **Flat running-control row.** `Pause · +1 min · +5 min · Restart · Cancel` — five
  same-weight buttons in a wrapping line, mixing "change the running timer's state" with
  "add time", and painting **Cancel** with the loudest fill (solid ink) so the eye went
  straight to the destructive control.

### Principles adopted

- **The dial is the hero of setup.** It is the biggest thing on the screen and the only
  serif numeral. Presets and the stepper are *inputs to the dial*; the label and Start
  are a separate block below a divider.
- **Presets are one tidy row, one unit grammar.** `5 · 10 · 15 · 20 · 30 · 45 min` then
  `1 · 2 hr` — evenly spaced, centre-aligned, wrapping symmetrically (4 + 4 at 1080p)
  rather than raggedly. A "Quick set" caption names the row.
- **The label is visibly optional and secondary.** Its own block under a hairline, a
  muted "Label (optional)" caption, chips one step quieter than the presets. Choosing a
  duration and choosing a label are different decisions and now look different.
- **Running controls are grouped by concern with the primary carrying the fill.**
  - *Add time* — `+1 min`, `+5 min` — a small pair on the left under an "Add time" caption.
  - *Timer* — `Pause`/`Resume` (coral, the one primary), `Restart` (outline), `Cancel`
    (ghost: transparent, `--ink-soft`, `--line` border — reachable, not shouty).
  - A `--dock-gap-out`-scale gap separates the two groups.
- **One primary per state** holds across the view: setup → **Start timer**; running →
  **Pause/Resume**; firing → **Dismiss** (unchanged — the alarm screen was already right).

### Layout (setup)

```
            NEW TIMER
        ┌─────────────────┐
   −    │     12:00       │    +          ← dial: hero, serif, tabular
        └─────────────────┘
   Quick set
   [5][10][15][20][30][45] min  [1][2] hr
  ───────────────────────────────────────
   Label (optional)
   [Food] [Oven] [Laundry] [Kids] [Homework]

           [   Start timer   ]
```

### Layout (running)

```
              (progress ring + countdown)

   Add time              Timer
   [+1 min] [+5 min]     [ Pause ]  [ Restart ]  [ Cancel ]
                          ^coral      ^outline     ^ghost
```

---

## 3. Settings flyout

### What was wrong

`.settings-popover` was a 360-px, 72vh **corner popover** holding a flat stack of eight
`<strong>`-headed sections:

`Calendars · Event colors · Week starts on · Microphone · Voice provider · Wake word ·
Keyword provider · Calendar colors`

- **No categorisation.** Everyday display prefs (event colour, week start, per-calendar
  colour) sat in the same scroll as the voice bake-off (five conversational providers,
  two keyword providers, VB-CABLE mic routing) — four of eight sections, and most of the
  height, were engineering knobs a household never touches.
- **Raw diagnostic strings on the wall.** e.g. *"Unavailable — push-to-talk still works —
  microphone unavailable for wake word: NotAllowedError: Perm…"*.
- **The densest surface in the app used its least roomy container** — a cramped corner
  popover, while a single event's detail gets a centred sheet.
- **One control grammar for everything:** a left-aligned button whose selected state is a
  border. No segmented controls, no switches.

### Principles adopted

- **Settings is a centred sheet, not a popover.** It joins the `.detail-scrim` /
  `.detail-sheet` family every other substantial surface already uses. Room to breathe,
  legible at distance, internal scroll only (per kiosk rule 7).
- **Two levels: a category rail, then a panel.** Categories:
  - **Display** (default) — Event colours, Week starts on, Calendar colours.
  - **Calendars** — linked accounts + "Add another Outlook calendar" (personal-Outlook
    only), else hidden.
  - **Voice & sound** — the one household control (Wake word on/off, with a
    plain-language status) up top; then an **Advanced (bake-off)** disclosure, collapsed
    by default, holding Voice provider, Keyword provider, and Microphone. Hidden entirely
    when voice is off and no mic diagnostics are available.
- **Control grammar by choice shape.**
  - *Segmented control* (`.seg`) for a small mutually-exclusive set: Event colours,
    Week start, and the provider pickers. Selected = ink fill, inline, no border dance.
  - *Switch* (`.switch`) for Wake word on/off.
  - *Swatch group* unchanged for colours.
- **Plain language only.** Wake-word states map to short sentences ("Listening for
  "Mission Control"", "Needs microphone access", "Push-to-talk only"); the raw engine
  string is kept for the Advanced disclosure and the console, not the wall.

### Layout

```
┌ Settings ─────────────────────────────────────────────┐
│ Display        │  EVENT COLOURS                        │
│ Calendars      │  [ By category | By person ]          │
│ Voice & sound  │                                       │
│                │  WEEK STARTS ON                       │
│                │  [ Monday | Sunday ]                  │
│                │                                       │
│                │  CALENDAR COLOURS                     │
│                │  Sarah  ● ● ● ● ●                     │
│                │  Travis ● ● ● ● ●                     │
└────────────────┴───────────────────────────────────────┘
```

Rail ~30% width (min 220 px), panel scrolls. `role="dialog"` name "Settings",
Escape + scrim/outside dismiss unchanged.

### Follow-up fix (2026-09-08): the panel must actually scroll

The first cut made `.settings-panel` a `display: grid` scroll container and gave
`.settings-advanced` `overflow: hidden` (for rounded-corner clipping). On a viewport
shorter than the content — the disclosure expanded, all five voice contestants + both
keyword providers + the mic list — the grid compressed the `.settings-advanced` track
(its `overflow: hidden` drops its automatic minimum size to 0) and clipped the rest
*unreachably*: the panel's own `overflow-y: auto` never engaged because its grid
content now "fit". The bake-off pickers below the fold could not be reached at all.

Fixes:
- `.settings-panel` is now a `flex` column with `flex: 0 0 auto` children, so an
  overflowing child always pushes the panel's scrollbar instead of being compressed.
  `overscroll-behavior: contain` keeps the wall calendar behind from scrolling too.
- `.settings-advanced` drops `overflow: hidden` (its children have transparent
  backgrounds, so the rounded border stays clean; this also stops it clipping the
  toggle's focus ring).
- The **Advanced (bake-off)** disclosure now remembers open/closed across sessions
  (`localStorage['mission-control.settings-advanced-open']`) — a tinkerer switching
  providers repeatedly gets there in one tap, not three.

## Test / behaviour deltas

- `.mode-nav` still contains exactly `Home, Week, Month, Timer, Lists` in order — the
  spatial-stability tests are untouched. New wrapper `<div>`s inside `.mode-nav` don't
  change `querySelectorAll('button')`.
- People button keeps its `/People/` name + `N/M` text.
- `.dock-timer-remaining` / `.dock-lists-count` still render (now as `.is-badge`
  overlays); the Timer view still omits the remaining badge.
- Settings is still one `role="dialog"` named "Settings"; the voice-provider tests now
  click the **Voice & sound** category (and expand **Advanced**) first — updated in
  `App.test.tsx` and `e2e/voice.spec.ts`.
- Backend CORS now also allows the repo dev port `5188` (from `.claude/launch.json`) so
  the Browser-pane preview can reach the API; previously only `5173` was allowed.
