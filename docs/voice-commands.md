# Voice commands

What you can say to Mission Control today, what each thing does, and where the
edges are. This is the human-friendly companion to the tool contract in
`backend/app/voice/tools.py` / `frontend/src/voice/tools.ts` and the design record
in `docs/voice-support-plan.md`.

## How to talk to it

- **Tap the "Ask" button** in the header, speak, and stop. The kiosk detects when
  you have finished talking (about a second of silence, or 15 seconds maximum) and
  sends the turn. There is nothing to press to "send".
- Saying **"Mission Control"** to wake it hands-free is built but **dormant** — it
  needs a trained wake-word model and on-hardware tuning before it does anything.
  Until then, every command starts with a tap.
- It **replies out loud in one or two sentences** and, for anything about the
  schedule, **moves the display** to show you the answer. The screen is the real
  answer; the speech is the summary.
- **One question per tap.** Each turn is its own session — there is no running
  conversation, so follow-ups need to be self-contained ("what about Saturday?"
  will usually work because the date is explicit; "and then?" will not).
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

## What voice cannot do

- **No calendar changes.** It cannot add, move, edit, or delete an event. Ask it
  to and it will say it can't yet. (The kitchen timer is the single exception.)
- **No account or settings changes** — sign-in, calendar colours, week start,
  people filters, wake word, etc. are all touch-only.
- **No general questions.** It is wired to the household calendars and the timer,
  not the open web, weather, or maths.
- **No shopping lists.** "Add milk to the Costco list" is understood but Mission
  Control has no lists yet. On the cloud providers it just says it can't; on
  Local / Hybrid it is flagged for cloud escalation (which is itself still a stub
  — see `docs/local-voice-plan.md`).
- **No follow-up memory.** Each tap is a fresh turn.
- **Latency.** A cold turn is a few seconds from "stop talking" to spoken answer.

## Where this is defined

| Piece | File |
| --- | --- |
| Tool declarations (locked into every session token) | `backend/app/voice/tools.py` |
| System instruction / spoken behaviour | `backend/app/voice/prompt.py` |
| Frontend tool dispatch | `frontend/src/voice/tools.ts` |
| Display actions the tools can call | `frontend/src/App.tsx` (`voiceActions`) |
| Turn state machine, end-of-speech, error handling | `frontend/src/voice/useVoiceSession.ts` |
| Locked-tool-set test | `backend/tests/test_voice.py` |
| Design record & live-tuning history | `docs/voice-support-plan.md` |
| Cloud provider bake-off | `docs/voice-provider-bakeoff-plan.md` |
| Local / Hybrid pipeline (STT + intents) | `docs/local-voice-plan.md`, `backend/app/voice/local/` |
| Local intent / entity tests | `backend/tests/test_voice_local_intent.py` |
| Wake word (dormant) | `docs/wake-word-plan.md` |
| Timer behaviour | `docs/timer-plan.md` |
