---
status: reference
summary: Method and maintained catalogue for short comparative passes on user-facing behaviour.
---

# Comparative product research

**Purpose.** Make "does anyone else do this, and what seems to work?" a fast
question instead of a from-scratch investigation every time. Several feature
designs — timers, lists, and now privacy mode — have each independently surveyed
comparable products and folded the findings into a *Pattern inspirations* section.
This document is the shared **method** and the shared **catalogue** so the next
survey starts warm: who is worth looking at, what each one is good for, and where
the last look landed.

This is a reference, not a plan. It has no rollout and no "done" — it is meant to
be picked up mid-task, skimmed, and added to.

---

## When to do a survey

Do a short comparative pass when **all** of these hold:

- The feature is user-facing behaviour or UX, not plumbing. (No point surveying
  "how should the token cache invalidate".)
- More than one reasonable design exists and the choice affects how the household
  experiences the appliance.
- Someone outside this repo has almost certainly shipped something adjacent — a
  smart display, a family calendar, a shared list, a kiosk lockdown tool.

Skip it when the answer is dictated by the repo's own constraints (a 16:9 kiosk
with no keyboard read from 6–10 ft rules most things out on its own), or when the
feature is genuinely novel to this product class.

A survey is **~30–60 minutes**, not a research project. The goal is three or four
transferable principles and a list of what to deliberately *not* copy.

---

## The method

1. **Frame the question in one sentence.** "How do shared-display products let a
   household hide schedule specifics from a visitor without hiding the schedule?"
   A vague frame ("look at calendar apps") produces a vague survey.

2. **Pick 4–8 products across the tiers** (see the catalogue). Always include at
   least one **direct competitor** (a family-calendar appliance you could buy
   instead of building this) and at least one **pattern source** (a product in a
   different category that solved the same interaction problem well —
   Google/Alexa timers, banking-app privacy screens, iPad Guided Access).

3. **Fill the comparison table** (below). One row per product. Keep cells to a
   phrase. The value is in the columns lining up, not in prose.

4. **Write the *Pattern inspirations* section** in the feature's plan doc:
   - a short "surveyed:" line naming the products,
   - a "what the category does" table (capability · who does it · relevance
     here),
   - a "what to deliberately not copy" list — this is usually the most useful
     output,
   - the source links inline.

5. **Add anything durable back here.** A new product worth knowing about → a
   catalogue entry. A principle that will outlive the feature → note it. Link the
   new *Pattern inspirations* section under "Prior surveys" so the next person
   finds it.

---

## The comparison template

| Column | What goes in it |
| --- | --- |
| **Product** | Name + one-word category (appliance / smart-display / dashboard / app / lockdown). |
| **The relevant feature** | What it actually does for the question being asked. |
| **Entry / trigger** | How a user turns it on — tap, setting, voice, automatic, per-item. |
| **Exit / undo** | How it comes back off, and whether that is gated (PIN, account, nothing). |
| **What it preserves vs. hides** | The specific split — this is where products differ most. |
| **Enforcement** | Cosmetic (UI only) or actually enforced (server, OS, MDM). |
| **Fit for a wall kiosk** | Does it survive: no keyboard, 6–10 ft read distance, always-on, shared-by-default, touch-only. |
| **Take / don't** | One line: the principle to borrow, or the thing to avoid. |

---

## Product catalogue

Grouped by tier. Each entry: what it is · why it is comparison-worthy · what to
study · caveats. Revisit the specifics before quoting them — these products ship
changes constantly and the notes carry a date where it matters.

### Tier 1 — Direct competitors: shared family-calendar appliances

These are wall-mounted or counter-top touchscreens a household could buy instead
of building Mission Control. They share the exact constraints (always-on, shared,
glanceable, touch) so their choices transfer most directly.

- **Skylight Calendar** (15"/27" touchscreen). The market leader. Syncs Google /
  Apple / Outlook, colour-codes by person, chore charts, meal planning, a
  companion app. *Study:* profile-based visibility (show/hide events per profile
  rather than per event), the "invite the display's own email address to an
  event" opt-in sync model, "dim past events". *Caveat:* no true per-event
  privacy toggle on the device as of 2026 — households work around it by not
  syncing sensitive events at all, which is a telling gap.
- **Hearth Display** (27" wall touchscreen). The closest analogue to Mission
  Control's ambient-appliance framing. **Ships a "Privacy Mode"** — a Quick
  Settings toggle that swaps the whole calendar for a custom wallpaper (a family
  photo, art). Unlimited profiles with per-person detail (allergies, emergency
  contacts). *Study:* the Quick-Settings placement (top-right, one tap), the
  framed use case ("dinner parties"). *Caveat:* it is all-or-nothing — the
  calendar simply disappears, taking the ambient utility with it, and there is no
  exit gate. Mission Control's privacy mode deliberately diverges here (redact
  specifics, keep the shape; gate the exit). See `docs/privacy-mode-plan.md`.
- **Cozi** (app + limited display casting). The incumbent shared-family-organiser.
  *Study:* the "family-wide visibility" philosophy it markets — everyone sees
  everything, on purpose — as the counter-position. Cozi has effectively **no**
  hide-from-family feature, which is either a principled stance or an unserved
  need depending on who you ask.
- **The 21.5" "HomeCal" class** (Everblog / WeMemo / a cluster of similar Android
  slabs). *Study:* recurring ideas across the cheap end — "guest profile" showing
  only photos + weather, auto-brightness "to keep the display private from a
  distance", idle photo screensavers. Individually minor, collectively a signal
  of what buyers ask for.

### Tier 2 — Smart displays with voice

Not calendar-first, but they are always-on shared screens with a microphone and a
household model, so their privacy and multi-user handling is directly relevant to
voice + presence work here.

- **Google Nest Hub / Hub Max.** *Study:* the layered model — **Guest Mode**
  ("Hey Google, turn on Guest Mode" → no personal results spoken or shown),
  per-device "personal results" toggle, Face Match gating personal content to a
  recognised face, and photos continuing to show in all cases. The separation of
  "who is here" (Face/Voice Match) from "what is shown" (personal results) maps
  onto Mission Control's presence work (`docs/camera-support-plan.md`) and a
  future auto-privacy trigger.
- **Amazon Echo Show.** *Study:* household profiles, voice-profile-scoped
  content, the Alexa shopping-list flow (voice-add → spoken confirmation → visual
  update, no dialogue) that `docs/lists-plan.md` already leans on.

### Tier 3 — DIY dashboards

- **DAKboard.** Configurable wall dashboard (calendar + photos + weather).
  *Study:* its **password-protected screens** feature and — more instructively —
  its documented limitation: "may NOT be used on devices that do not have a
  mouse, keyboard, or touch input", and the password must be re-entered after
  every restart / IP change. A direct lesson in what a credential gate costs on
  an input-poor always-on device.
- **MagicMirror², Home Assistant dashboards.** *Study:* module/card visibility
  conditioned on presence or time of day; the general pattern of "the dashboard
  composition is a function of context".

### Tier 4 — Kiosk / lockdown tooling

When the question is about read-only states, exit gates, or "stop a bystander
poking at this", these are the reference implementations.

- **iPad Guided Access / Single App Mode.** *Study:* the canonical
  understated-entry / gated-exit pattern — triple-click to enter, **passcode (or
  Face/Touch ID) to exit**, session does not survive reboot (Guided Access) vs.
  MDM-enforced and reboot-proof (Single App Mode). The two tiers are exactly the
  "cosmetic vs. enforced" axis in the comparison template.
- **Fully Kiosk Browser** (Android kiosk shell). *Study:* PIN-or-gesture to exit
  kiosk mode, a movement-triggered screensaver, "wake on motion". Also the free
  vs. paid line: the free tier shows a PIN *hint* on the exit gesture — a
  reminder that an understated exit still has to be *findable* by the legitimate
  user.
- **Android Screen Pinning, Windows Assigned Access / Shell Launcher.** OS-level
  equivalents; same entry/exit-gate shape.

### Tier 5 — General calendar apps (the data model)

- **Google Calendar / Outlook / Fantastical.** *Study:* the **visibility model** —
  `default` / `public` / `private` per event, where `private` collapses to a
  "Busy" block for viewers without full access but still leaks **start time, end
  time, and creator**; and the sharing-permission tier "see only free/busy (hide
  details)". This is the industry-standard answer to "show the shape, hide the
  content" and is worth matching vocabulary with. Note that even the standard
  leaks timing + owner — the same residual leak Mission Control's privacy mode
  accepts.

### Tier 6 — Adjacent interaction patterns

Different product class, same interaction problem. Reach for these as pattern
sources.

- **Banking / password-manager apps: privacy screens.** *Study:* tap-to-reveal
  and press-and-hold-to-reveal for a hidden balance; automatic blur on
  backgrounding / app-switcher; overlay-dim-with-pattern. The "hold to reveal for
  5 seconds" gesture is a candidate for a legitimate user glancing at one real
  title without fully exiting privacy mode.
- **Google / Alexa timers & alarms.** *Study:* pause / resume / reset vocabulary
  and the "new one replaces the current one" model — already cross-referenced in
  `docs/timer-plan.md`.
- **Grocery apps (AnyList, Bring!, OurGroceries).** Already surveyed in
  `docs/lists-plan.md` → *Pattern inspirations*.

---

## Prior surveys in this repo

Each of these is a worked example of steps 3–4. Read the closest one before
starting a new survey.

| Feature | Section | What it surveyed |
| --- | --- | --- |
| Timers | `docs/timer-plan.md` → *Amendment … pause / resume / restart* and the cross-references to Google Assistant / Alexa timers | pause/resume/reset semantics, replace-on-new, spoken confirmation flow |
| Lists | `docs/lists-plan.md` → §1 *Pattern inspirations* | grocery apps + Nest Hub / Echo Show voice-add; check-vs-delete; "clear" scoping; quick-add grid as the no-keyboard input path |
| Privacy mode | `docs/privacy-mode-plan.md` → *Pattern inspirations* | this document's Tiers 1–6, focused on redact-vs-hide and gated exit |

---

## Durable principles harvested so far

Things a survey surfaced that will outlive the feature that prompted them:

- **Show the shape, hide the content is the industry norm** for calendar privacy
  (free/busy, `private` visibility) — and it always leaves a residual leak
  (timing, owner). Match that vocabulary; be explicit about the residual.
- **All-or-nothing privacy (Hearth) is the easy build and the weak UX.** Swapping
  the calendar for a photo also removes the reason the appliance is on the wall.
- **A credential gate on an input-poor always-on device is expensive** (DAKboard,
  Guided Access). Favour a numeric PIN + on-screen pad over anything needing a
  keyboard; expect to re-enter after a restart; make the *exit affordance*
  findable even when the *entry* is understated.
- **Separate "who is here" from "what is shown"** (Nest Hub). Presence/recognition
  feeds the display policy; it does not *become* the display policy.
- **Voice-add is one utterance → spoken confirmation → visual update, no dialogue**
  (Nest Hub, Echo Show) — the bar for any voice interaction on a passing-by
  appliance.

---

## Keeping this current

- Add a catalogue entry whenever a survey turns up a product worth knowing about
  next time — even a one-liner.
- When a feature plan gets a *Pattern inspirations* section, add a row to *Prior
  surveys*.
- Product specifics rot. If you rely on a specific claim ("Hearth Privacy Mode
  has no exit gate"), re-check it and date the note.
- `AGENTS.md` → *Comparative product research* points here; keep that pointer
  alive.
