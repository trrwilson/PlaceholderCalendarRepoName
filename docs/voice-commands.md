---
status: reference
summary: What you can say to Mission Control today, what each does, and its limits.
---

# Voice commands

What you can say to Mission Control today, what each thing does, and where the
edges are. This is the human-friendly companion to the tool contract in
`backend/app/voice/tools.py` / `frontend/src/voice/tools.ts` and the design record
in `docs/voice-support-plan.md`.

## How to talk to it

- **Tap the "Ask" button** in the header, speak, and stop. The kiosk detects when
  you have finished talking and sends the turn — there is nothing to press to
  "send". Depending on the voice provider that is a second of silence, or the
  provider recognising the end of your sentence directly (which handles a pause
  mid-phrase, like "set a timer for… ten minutes", without cutting you off).
  Either way there is a 15-second maximum.
- Saying **"Mission Control"** to wake it hands-free is built but **dormant** — it
  needs a trained wake-word model and on-hardware tuning before it does anything.
  Until then, every command starts with a tap.
- **On-device Invoke gate** (experimental, off by default). Settings →
  "On-device audio gate" adds a first stage *in front of* the normal keyword
  detector: the Harman Kardon Invoke only sends real room audio to the kiosk
  after it hears a likely wake phrase — **idle room conversation and TV never
  leave the Invoke**. The kiosk's own "Mission Control" check (openWakeWord or
  Azure — unchanged) then runs on that audio, and both must agree before
  anything happens, so a false trigger on the device produces no visible
  activation. The Ask button always works regardless (it opens the gate for a
  manual turn), and turning the switch off makes the Invoke stream continuously
  again. See `docs/wake-word-provider-bakeoff.md`.
- It **replies out loud in one or two sentences** and, for anything about the
  schedule, **moves the display** to show you the answer. The screen is the real
  answer; the speech is the summary.
- **One question per tap.** Each turn is its own session — there is no running
  conversation, so follow-ups need to be self-contained ("what about Saturday?"
  will usually work because the date is explicit; "and then?" will not). It
  answers what you asked and stops — it will not ask "do you want me to…" or
  offer a next step back.
- **It knows roughly the next month of the calendar** without looking anything
  up, so you can be vague: "when's that dentist thing?", "what's the appointment
  in Bellevue later this month?", "which day is Sarah's dinner?" all work — it
  matches what you said against the event titles *and* their locations. Ask about
  something further out and it will look it up.
- **English only.**
- Nothing you say is saved. The on-screen transcript shows the current turn and is
  cleared at the start of the next one.

Voice is off unless the kiosk build enables it (`MISSION_CONTROL_VOICE_ENABLED`),
a provider is configured, and the request comes from the local network. When
it is off the Ask button reads "Voice off".

### Cloud vs. Local / Hybrid

Settings → "Voice provider" picks who handles a turn. The cloud contestants
(Gemini Live, the Azure ones) run the whole conversation in the cloud. The
**Local / Hybrid** option (experimental) recognises your speech and works out
what you meant *on the kiosk itself*, and only reaches the cloud for questions
that need real reasoning ("when could we all have dinner this week without a
clash?"). Everything on this page works either way; the local path is faster and
works offline for the ordinary commands, and it will tell you out loud when it is
handing something to the cloud. See `docs/local-voice-plan.md`.

---

## Checking the schedule

### "What's on today / tonight?"

**Say:** "What's happening today?" · "Anything on tonight?" · "What's next?" ·
"What's on right now?"

**Does:** Reads today's events, tells you how many there are and the notable ones
with times, and switches the display to **Home** (today + next up).

**Limits:** "Tonight" and "right now" are still just *today* — it does not filter
to the evening, it reads the whole day. It cannot tell you how busy you *feel*,
only what is on the calendars.

### "What's on <another day>?"

**Say:** "What's on Friday?" · "What does Saturday look like?" · "What's on the
14th?" · "What's happening next Monday?"

**Does:** Works out the date from today, reads that day's events, summarises them
out loud, and switches the display to **Week** focused on that day (Home only ever
shows today, so another day always lands in Week view).

**Limits:** Relative dates ("this weekend", "next week") are interpreted as a
single date by the assistant — expect it to land on one day, not paint a range.
The clock and calendar come from a snapshot taken when the session token was
minted, so a session left open a long time can answer with a slightly stale "now"
(the token is refreshed at each event boundary and at midnight to keep "what's
next" honest).

### "Is anything double-booked?"

**Say:** "Any clashes on Thursday?" · "Is anything double-booked tomorrow?" ·
"Do we have conflicts on the 12th?"

**Does:** Checks that one day for events that overlap in time across all the
household calendars and reads back any clashing pairs (with whose calendar each is
on).

**Limits:** One day at a time. Timed events only — all-day events are never
counted as a conflict. It flags overlaps; it does not judge whether an overlap
actually matters (travel time, one person at both, etc.).

### "What's on this week / month?"

**Say:** "Show me this week." · "What's on next week?" · "Show me June."

**Does:** Reads the events across that range and switches the display to **Week**
or **Month**.

**Limits:** The spoken summary is short — for a whole month it will name only a
few highlights and expects you to read the screen.

---

## Moving the display

These change what is on the wall screen. The assistant also does this on its own
when you ask about the schedule, but you can drive it directly.

### "Show me <view>"

**Say:** "Show the week." · "Go to month view." · "Back to home." · "Show the
timer."

**Does:** Switches between the **Home**, **Week**, **Month**, and **Timer** views.
Optionally jumps to a date at the same time ("show the week of the 20th").

### "Go to <date>"

**Say:** "Go to Friday." · "Show me next week." · "Jump to the 1st."

**Does:** Moves the currently visible view to that date **without** changing which
view is showing.

### "Show <person>'s calendar"

**Say:** "Show Alex's calendar." · "Just show Jordan." · "Show everyone." ·
"Show Mom and Dad."

**Does:** Changes the **People** filter to show only the named household
member(s), or everyone. Names are matched loosely against the household
calendars. This changes what is on screen, not any calendar.

**Limits:** It can only match people who have a calendar linked. "Show everyone"
(or "clear the filter") brings them all back.

### "Open <event>"

**Say:** "Open Travis's dentist appointment." · "Show me the school concert." ·
"Pull up soccer practice."

**Does:** Finds the event that best matches the words you used — by title, or by
whose calendar it is on — selects it and opens its detail sheet.

**Limits:** It can only match events **currently loaded in the active view**. Home
holds today through the next two weeks; Week and Month hold what is on screen. Ask
for an event outside that window and it will say it can't find one in view — move
to the right week first, then ask.

---

## Kitchen timer

Mission Control has **one** kitchen timer/alarm. Voice can set, extend, pause,
resume, restart, and cancel it — this is the only thing voice is allowed to
change. Starting a new timer replaces whatever was running, and the assistant will
tell you it did.

### "Set a timer for <duration>"

**Say:** "Set a timer for 10 minutes." · "Give me a 90-second timer." · "Timer for
half an hour for the laundry."

**Does:** Starts the timer, switches to the **Timer** view, and confirms in one
sentence. An optional label ("for the laundry", "pasta") shows on the alarm
screen.

### "Set an alarm for <time>"

**Say:** "Set an alarm for 3pm." · "Wake me at 6:45." · "Alarm for quarter past
four."

**Does:** Starts the timer aimed at that clock time today.

### "Set a timer for 30 minutes before <event>"

**Say:** "Remind me 20 minutes before the game." · "Timer for half an hour before
Sarah's flight."

**Does:** Looks the event up on the calendar, subtracts the offset, and sets the
timer for that moment.

**Limits:** It needs to find the event first — the same "must be in the loaded
view" limit as *Open an event* applies.

### "Give me five more minutes" / "Snooze"

**Say:** "Add ten minutes." · "Five more minutes." · "Snooze it." (while it's
ringing)

**Does:** Adds time to the running, paused, or ringing timer.

### "Pause the timer" / "Resume"

**Say:** "Pause the timer." · "Hold the timer." · "Resume." · "Unpause it." ·
"Keep the timer going."

**Does:** Freezes the countdown where it is, then continues it from the same point
when you resume. Time passing while it is paused does not count against it.

### "Restart the timer"

**Say:** "Restart the timer." · "Reset the timer." · "Start it over."

**Does:** Sets the timer back to the full time you originally gave it and starts
counting again. Works whether it is running, paused, or going off.

### "Stop" / "Cancel the timer"

**Say:** "Stop." · "Turn it off." · "Cancel the timer." · "Dismiss it."

**Does:** Cancels a running timer, or silences a ringing one.

### "How long is left?"

**Say:** "How much time is on the timer?" · "Is the timer still going?"

**Does:** Says whether a timer is running, paused, or ringing, and roughly how much
time remains.

### Timer limits

- **One timer.** No "second timer for the potatoes" — the second request replaces
  the first.
- **Six hours maximum.** Anything longer is refused and the assistant says so.
- **Lives in memory.** A backend restart clears the timer.
- **No spoken alarm.** When the timer fires you get the chime and the Timer view —
  the assistant does not start talking on its own. Say "stop" to dismiss it.

---

## Grocery list

Mission Control keeps **one** household grocery list. Voice can add to it, take
things off, check items off as you buy them, clear it, and read it back — it
cannot touch the calendar. Any list command also switches the display to the
**Lists** view so you can see the change.

### "Add <item> to the grocery list"

**Say:** "Add meatballs to the grocery list." · "Add milk." · "Put eggs, bread
and butter on the list." · "We're out of coffee." · "We need paper towels."

**Does:** Adds the item(s) — a spoken list of things ("eggs, bread and butter")
becomes separate entries. Adding something already on the list is fine: it says
it was already there, and if you'd checked it off it goes back on.

### "Take <item> off the list"

**Say:** "Take the milk off the grocery list." · "Remove the bread." · "Drop
the onions."

**Does:** Deletes that one item. If nothing on the list matches, it says so
rather than guessing.

### "Check off the <item>" / "I got the <item>"

**Say:** "Check off the milk." · "I got the eggs." · "Mark the bread as bought."

**Does:** Marks the item bought — it stays on the list, struck through, in the
"Got it" strip, until the list is cleared. "Put milk back on the list" un-checks
it.

### "Clear the grocery list"

**Say:** "Clear the grocery list." (everything) · "Clear the ones we got." /
"Clear what we bought." (only the checked-off items)

**Does:** Empties the list (or just the checked items). The screen shows a
**"Cleared N · Undo"** for a few seconds — tap Undo to put everything back.

### "What's on the grocery list?"

**Say:** "Show me the grocery list." · "What's on the shopping list?"

**Does:** Opens the Lists view. The screen is the answer.

### Grocery-list limits

- **One list.** "Add sunscreen to the packing list" is understood as naming a
  different list — it says it only has the grocery list, and does nothing.
- **Adding new items is voice-first.** The Lists view has a quick-add grid of
  recent items for touch, but there is no on-screen keyboard — a brand-new item
  is added by voice.
- **The list is saved.** It survives a kiosk reboot and a backend restart (unlike
  the timer).

---

## Privacy mode

Privacy mode redacts the *what* of the schedule and the grocery list — titles,
locations, categories — while keeping the *when*, *how many*, and *whose*, and
locks the display so a visitor cannot change anything. It is a social / glance
barrier for a houseguest, not real security. See `docs/privacy-mode-plan.md`.

### "Privacy mode" / "Hide the calendar"

**Say:** "Mission Control, privacy mode." · "Someone's coming over, hide the
calendar." · "Turn on privacy mode."

**Does:** Turns privacy mode on. The screen keeps its layout but every event and
list item shows `•••` instead of its name; **Add**, **People**, and **Settings**
disappear. The assistant confirms and reminds you it takes the on-screen PIN to
turn back off.

**Limits:** You **cannot turn privacy mode off by voice** — speaking a PIN aloud
in front of the visitor would defeat it. Ask and the assistant brings up the
keypad on screen; you enter the four-digit PIN there. (Requires a PIN to be
configured on the backend; with none, this does nothing.)

### While privacy mode is on

Voice still works, but **every command except "turn off privacy mode" is politely
declined** — including schedule questions, so nothing sensitive is read aloud.
"Turn off privacy mode" / "unlock the display" brings up the PIN keypad.

---

## What voice cannot do

- **No calendar changes.** It cannot add, move, edit, or delete an event. Ask it
  to and it will say it can't yet. (The kitchen timer and the grocery list are
  the two exceptions; it can also turn *on* privacy mode.)
- **No account or settings changes** — sign-in, calendar colours, week start,
  people filters, wake word, etc. are all touch-only.
- **No general questions.** It is wired to the household calendars, the timer, and
  the grocery list — not the open web, weather, or maths.
- **One list only.** A grocery list, not multiple named lists, and no aisle
  grouping or meal planning (`docs/lists-plan.md`).
- **No follow-up memory.** Each tap is a fresh turn.
- **Latency.** A cold turn is a few seconds from "stop talking" to spoken answer.

## Where this is defined

| Piece | File |
| --- | --- |
| Tool declarations (locked into every session token) | `backend/app/voice/tools.py` |
| System instruction / spoken behaviour | `backend/app/voice/prompt.py` |
| Frontend tool dispatch | `frontend/src/voice/tools.ts` |
| Display actions the tools can call | `frontend/src/App.tsx` (`voiceActions`) |
| Turn state machine, end-of-speech backstop, error handling | `frontend/src/voice/useVoiceSession.ts` |
| End-of-speech ownership per provider (`endpointing`) | `backend/app/voice/providers/`, `docs/voice-provider-bakeoff-plan.md` |
| Locked-tool-set test | `backend/tests/test_voice.py` |
| Design record & live-tuning history | `docs/voice-support-plan.md` |
| Cloud provider bake-off | `docs/voice-provider-bakeoff-plan.md` |
| Local / Hybrid pipeline (STT + intents) | `docs/local-voice-plan.md`, `backend/app/voice/local/` |
| Local intent / entity tests | `backend/tests/test_voice_local_intent.py` |
| Wake word (dormant) | `docs/wake-word-plan.md` |
| Timer behaviour | `docs/timer-plan.md` |
| Grocery list behaviour | `docs/lists-plan.md` |
| Privacy mode | `docs/privacy-mode-plan.md`, `backend/app/privacy.py`, `frontend/src/privacy/` |
