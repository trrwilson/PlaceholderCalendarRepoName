"""The bounded intent catalogue for the local interpreter.

A small, explicit set of household intents matched by weighted regex evidence —
**not** a giant static grammar, and never exact-string comparison. Dynamic
entities (people, events, lists) are resolved separately in ``entities.py``; this
module only decides *what kind of thing* was asked and pulls the free-text slot
spans out of the utterance.

Each intent declares:

* ``tier`` — 0 simple / 1 state-aware / 2 needs cloud reasoning (see ``AGENTS.md``
  and ``docs/local-voice-plan.md``);
* ``mutating`` — changes state if executed (guarded harder on low confidence);
* ``supported`` — Mission Control can actually carry it out today. A recognised
  but unsupported intent (display power, shopping lists) is a clean "can't do
  that yet", not a fallback to guessing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

Trigger = tuple[re.Pattern[str], float]


def _p(pattern: str, weight: float) -> Trigger:
    return re.compile(pattern), weight


@dataclass(frozen=True)
class Intent:
    name: str
    tier: int
    triggers: list[Trigger]
    slots: list[str] = field(default_factory=list)
    mutating: bool = False
    supported: bool = True
    #: patterns that, if present, veto this intent even when a trigger matched
    vetoes: list[re.Pattern[str]] = field(default_factory=list)


@dataclass
class IntentMatch:
    intent: Intent
    confidence: float
    matched: list[str]

    @property
    def name(self) -> str:
        return self.intent.name


# Ordered by specificity — earlier, more specific intents win ties.
INTENTS: list[Intent] = [
    # -- calendar writes: recognised, deliberately NOT supported ---------------
    Intent(
        name="calendar.move_event",
        tier=1,
        mutating=True,
        supported=False,
        slots=["event_query", "date"],
        triggers=[
            _p(
                r"\b(move|reschedule|push|shift|change|bump)\b.*\b(appointment|meeting|event|to|from)\b",
                0.8,
            ),
            _p(r"\breschedule\b", 0.7),
            _p(r"\bmove the \w+", 0.6),
        ],
    ),
    Intent(
        name="calendar.add_event",
        tier=1,
        mutating=True,
        supported=False,
        slots=["event_query", "date"],
        triggers=[
            _p(
                r"\b(add|create|schedule|put|book|set up)\b.*\b(appointment|event|meeting|on the calendar|to the calendar)\b",  # noqa: E501
                0.8,
            ),
            _p(r"\b(add|put)\b.*\bcalendar\b", 0.7),
        ],
        vetoes=[re.compile(r"\b(list|timer|alarm)\b")],
    ),
    Intent(
        name="calendar.delete_event",
        tier=1,
        mutating=True,
        supported=False,
        slots=["event_query"],
        triggers=[
            _p(r"\b(delete|remove|cancel|clear)\b.*\b(appointment|meeting|event)\b", 0.8),
            _p(
                r"\b(delete|remove)\b.*\b(practice|game|match|lesson|class|party|"
                r"dropoff|drop.?off|pickup|pick.?up|dentist|doctor|recital|concert)\b",
                0.75,
            ),
        ],
        vetoes=[re.compile(r"\b(timer|alarm|list|filter|notification)\b")],
    ),
    # -- grocery list (supported) --------------------------------------------
    Intent(
        name="list.add",
        tier=1,
        mutating=True,
        slots=["list_query", "items"],
        triggers=[
            _p(r"\badd\b.*\bto (?:the |my )?[\w ']* ?list\b", 0.85),
            _p(
                r"\badd\b.*\bto (?:the |my )?(costco|grocery|groceries|shopping|target|walmart)\b",
                0.8,
            ),
            _p(r"\b(put|add)\b.*\bon the (?:shopping|grocery|costco|groceries) list\b", 0.85),
            _p(r"\bwe(?:'re| are|'ve| have)?\s*(?:need|needing|out of|ran out of)\b", 0.6),
            _p(r"\bneed to (?:buy|get|pick up|grab)\b", 0.6),
            _p(r"\b(?:get|grab|buy|pick up) (?:some |more )\b", 0.5),
        ],
        vetoes=[re.compile(r"\b(timer|alarm|calendar|appointment)\b")],
    ),
    Intent(
        name="list.remove",
        tier=1,
        mutating=True,
        slots=["list_query", "items"],
        triggers=[
            _p(r"\b(take|get|cross)\b.*\b(off|out of)\b.*\blist\b", 0.85),
            _p(r"\b(remove|delete|drop)\b.*\bfrom (?:the |my )?[\w ']* ?list\b", 0.85),
            _p(r"\b(remove|delete|drop)\b.*\bfrom (?:the |my )?(grocery|shopping|costco)\b", 0.8),
        ],
        vetoes=[re.compile(r"\b(timer|alarm|appointment|meeting|event)\b")],
    ),
    Intent(
        name="list.check",
        tier=1,
        mutating=True,
        slots=["list_query", "items"],
        triggers=[
            _p(r"\bcheck off\b", 0.85),
            _p(r"\b(got|picked up|grabbed|bought)\b.*\b(the|some)\b", 0.6),
            _p(r"\bmark\b.*\b(as )?(bought|done|got|picked up)\b", 0.85),
            _p(r"\b(tick|check)\b.*\boff (?:the |my )?list\b", 0.8),
        ],
        vetoes=[re.compile(r"\b(timer|alarm|calendar|appointment)\b")],
    ),
    Intent(
        name="list.clear",
        tier=1,
        mutating=True,
        slots=["list_query"],
        triggers=[
            _p(r"\b(clear|empty|wipe|reset)\b.*\b[\w ']*\s?list\b", 0.9),
            _p(r"\bclear (?:the |everything off )?(?:the )?list\b", 0.9),
            _p(r"\bclear (?:the )?(ones|stuff|things) we (?:got|bought|picked up|have)\b", 0.85),
            _p(r"\bstart (?:the |a )?(?:new |fresh )?(?:grocery |shopping )?list\b", 0.7),
        ],
        vetoes=[re.compile(r"\b(timer|alarm|calendar|filter|people)\b")],
    ),
    Intent(
        name="list.show",
        tier=0,
        slots=["list_query"],
        triggers=[
            _p(r"\b(show|open|pull up|bring up|what's on)\b.*\b[\w ]*list\b", 0.75),
            _p(r"\b(show|open|pull up)\b.*\b(grocery|groceries|shopping)\b", 0.75),
            _p(r"\bwhat(?:'s| is| do we need)\b.*\b(grocery|groceries|shopping)\b", 0.7),
            _p(r"^\s*(grocery list|shopping list|the list)\s*$", 0.8),
        ],
        vetoes=[re.compile(r"\b(calendar|week|month|timer|schedule|appointment)\b")],
    ),
    # -- display power: recognised, not wired into the local pipeline yet -----
    # (The cloud path can dim via set_night_mode / app/display.py; giving the
    # local interpreter its own display planner is a follow-up.)
    Intent(
        name="display.off",
        tier=0,
        mutating=True,
        supported=False,
        triggers=[
            _p(r"\bturn (?:the )?(display|screen|monitor)\s?(off|down)\b", 0.9),
            _p(r"\b(display|screen|monitor)\b.*\b(off|sleep|dark)\b", 0.7),
            _p(r"\bgo to sleep\b", 0.6),
        ],
    ),
    Intent(
        name="display.on",
        tier=0,
        mutating=True,
        supported=False,
        triggers=[
            _p(r"\b(turn|wake)\b.*\b(display|screen|monitor)\b.*\b(on|up)\b", 0.85),
            _p(r"\bwake (?:up )?the (display|screen)\b", 0.85),
        ],
    ),
    # -- timers (fully supported) -------------------------------------------
    Intent(
        name="timer.pause",
        tier=0,
        mutating=True,
        triggers=[
            _p(r"\b(pause|hold|freeze|halt)\b.*\b(the )?(timer|countdown)\b", 0.9),
            _p(r"\b(timer|countdown)\b.*\b(pause|hold|on hold)\b", 0.85),
            _p(r"^\s*pause( it)?\s*$", 0.7),
        ],
    ),
    Intent(
        name="timer.restart",
        tier=0,
        mutating=True,
        triggers=[
            _p(r"\b(restart|reset)\b.*\b(the )?(timer|countdown)\b", 0.92),
            _p(r"\b(timer|countdown)\b.*\b(from the (start|beginning|top)|over again)\b", 0.85),
            _p(r"\bstart\b[^.]*\b(timer|countdown)\b[^.]*\b(over|again|from scratch)\b", 0.8),
            _p(r"^\s*(restart|reset)( it| the timer)?\s*$", 0.8),
        ],
    ),
    Intent(
        name="timer.resume",
        tier=0,
        mutating=True,
        triggers=[
            _p(r"\b(resume|unpause|un-pause|continue)\b.*\b(the )?(timer|countdown)\b", 0.9),
            _p(r"\b(keep|carry on with)\b.*\btimer\b.*\bgoing\b", 0.85),
            _p(r"\b(timer|countdown)\b.*\b(going again|back on)\b", 0.85),
            _p(r"^\s*(resume|unpause|un-pause)( it| the timer)?\s*$", 0.8),
        ],
        vetoes=[re.compile(r"\b(restart|reset)\b")],
    ),
    Intent(
        name="timer.start",
        tier=1,
        mutating=True,
        slots=["duration", "time", "label", "event_query"],
        triggers=[
            _p(r"\b(set|start|create|put on|give me)\b.*\b(a )?timer\b", 0.85),
            _p(r"\btimer for\b", 0.85),
            _p(r"\b(set|start)\b.*\balarm\b", 0.8),
            _p(r"\balarm for\b", 0.8),
            _p(r"\bremind me\b", 0.55),
            _p(r"\bremind me (in|at|to)\b", 0.6),
            _p(r"\b\d+\s*(minutes?|hours?)\s+before\b", 0.6),
            _p(r"\b(wake|get) me (up )?(at|in)\b", 0.7),
            _p(r"\bcountdown\b", 0.6),
        ],
        vetoes=[
            re.compile(r"\b(pause|unpause|un-pause|resume|restart|reset)\b"),
            re.compile(r"\bstart\b[^.]*\b(over|again|from (the )?(start|beginning|top|scratch))\b"),
        ],
    ),
    Intent(
        name="timer.cancel",
        tier=0,
        mutating=True,
        triggers=[
            _p(r"\b(cancel|stop|clear|kill|delete)\b.*\b(the )?timer\b", 0.9),
            _p(r"\b(dismiss|silence|turn off)\b.*\b(the )?(timer|alarm)\b", 0.9),
            _p(r"^\s*(stop|dismiss|silence|snooze off)\s*$", 0.7),
            _p(r"\bturn it off\b", 0.5),
        ],
    ),
    Intent(
        name="timer.extend",
        tier=0,
        mutating=True,
        slots=["duration"],
        triggers=[
            _p(r"\b(add|give me)\b.*\bminutes?\b", 0.7),
            _p(r"\b(snooze|another|more)\b.*\b(minutes?|time)\b", 0.75),
            _p(r"\b\d+ more minutes?\b", 0.85),
            _p(r"^\s*snooze\s*$", 0.7),
        ],
    ),
    Intent(
        name="timer.query",
        tier=0,
        triggers=[
            _p(r"\bhow (much|long)\b.*\b(timer|left|remaining)\b", 0.9),
            _p(r"\b(is|any)\b.*\btimer\b.*\b(going|running|on|still)\b", 0.8),
            _p(r"\btime (left|remaining)\b", 0.7),
        ],
    ),
    # -- calendar navigation (supported) -----------------------------------
    Intent(
        name="calendar.person_filter",
        tier=1,
        slots=["person"],
        triggers=[
            _p(r"\bshow\b.*\b(\w+)'s (calendar|schedule|stuff|events|day)\b", 0.85),
            _p(r"\b(just|only) show (?:me )?(\w+)\b", 0.7),
            _p(r"\bshow (?:me |just |only )?(\w+)'s\b", 0.75),
            _p(r"\bshow (?:me )?(\w+)\s*$", 0.55),
            _p(r"\bfilter (to|by)\b", 0.7),
            _p(r"\bshow (everyone|everybody|all of us|all calendars)\b", 0.85),
            _p(r"\bhide\b.*\b(\w+)('s)?\b.*\b(calendar|events)\b", 0.7),
        ],
        vetoes=[
            re.compile(r"\b(doing|got|have|happening)\b.*\?"),
            re.compile(
                r"\bshow (?:me )?(the )?(week|month|home|timer|today|tomorrow|agenda|calendar)\b"
            ),
        ],
    ),
    Intent(
        name="calendar.open_event",
        tier=1,
        slots=["event_query"],
        triggers=[
            _p(
                r"\b(open|pull up|bring up|show me|go to)\b.*\b(appointment|practice|game|match|meeting|party|concert|lesson|class)\b",  # noqa: E501
                0.8,
            ),
            _p(r"\bopen (?:the |travis's |sarah's |mom's |dad's )?\w+", 0.55),
            _p(r"\bwhat time is\b", 0.7),
            _p(r"\bwhen(?:'?s| is)\b.*\b(the|my|his|her)\b", 0.6),
            _p(r"\bwhere(?:'?s| is)\b.*\b(the|my|his|her)\b", 0.7),
        ],
    ),
    Intent(
        name="calendar.conflicts",
        tier=1,
        slots=["date"],
        triggers=[
            _p(r"\b(conflict|clash|double.?book|overlap)\w*\b", 0.9),
            _p(r"\banything (at the same time|overlapping)\b", 0.8),
        ],
        vetoes=[
            re.compile(r"\bwhen can (i|we|you)\b"),
            re.compile(r"\bfind (a|some) time\b"),
            re.compile(r"\b(least|most) (busy|free|open|packed)\b"),
            re.compile(r"\bbest (day|time)\b"),
        ],
    ),
    Intent(
        name="calendar.plan",
        tier=2,
        slots=["date", "person", "event_query"],
        triggers=[
            _p(r"\bwhen can (i|we|you)\b", 0.85),
            _p(r"\b(which|what) day\b.*\b(least|most) (busy|free|open|packed)\b", 0.9),
            _p(r"\bfind (a|some) time\b", 0.85),
            _p(r"\bwithout\b.*\bconflict\w*\b", 0.8),
            _p(r"\bwithout (conflicting|a conflict|clashing|overlapping)\b", 0.8),
            _p(r"\b(free|open|available)\b.*\b(slot|time|window|evening|afternoon)\b", 0.6),
            _p(r"\b(should|could) (i|we)\b.*\?", 0.5),
            _p(r"\bbest (day|time)\b", 0.7),
            _p(r"\bhow busy\b", 0.7),
        ],
    ),
    Intent(
        name="calendar.query_person",
        tier=1,
        slots=["person", "date"],
        triggers=[
            _p(
                r"\bwhat(?:'?s| is| does| has)\b.*\b(\w+)\b.*\b(doing|got|have|up to|schedule|day)\b",  # noqa: E501
                0.8,
            ),
            _p(r"\b(is|are)\b.*\b(\w+)\b.*\b(busy|free|around|available)\b", 0.8),
            _p(r"\bdoes\b.*\bhave\b.*\b(on|anything|plans)\b", 0.7),
            _p(r"\b(\w+)'s (day|schedule|plans|calendar)\b", 0.6),
            _p(r"\bwhen does\b.*\bfinish\b", 0.6),
        ],
    ),
    Intent(
        name="calendar.query_day",
        tier=1,
        slots=["date", "person"],
        triggers=[
            _p(r"\bwhat(?:'?s| is| are)\b.*\b(on|going on|happening|up|planned|scheduled)\b", 0.75),
            _p(r"\bwhat(?:'?s| is) next\b", 0.85),
            _p(r"\banything (on|planned|happening|going on|scheduled|coming up)\b", 0.8),
            _p(r"\bwhat does\b.*\blook like\b", 0.75),
            _p(r"\b(any|what) (plans|events|appointments)\b", 0.7),
            _p(r"\bwhat have (we|i) got\b", 0.75),
            _p(r"\bcatch me up\b", 0.6),
            _p(r"\bwhat's the (plan|agenda)\b", 0.8),
        ],
    ),
    Intent(
        name="calendar.show_view",
        tier=0,
        slots=["view", "date"],
        triggers=[
            _p(
                r"\b(show|go to|switch to|open|pull up|bring up|jump to|take me to)\b.*\b(home|week|weekly|month|monthly|timer|calendar|agenda|today|tomorrow)\b",  # noqa: E501
                0.8,
            ),
            _p(r"\b(week|month) view\b", 0.85),
            _p(r"\bback to (home|today)\b", 0.85),
            _p(r"^\s*(home|week|month|timer)\s*$", 0.8),
            _p(
                r"\bgo to (monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|the \d)",  # noqa: E501
                0.7,
            ),
        ],
    ),
]

_INTENTS_BY_NAME = {intent.name: intent for intent in INTENTS}


def get_intent(name: str) -> Intent | None:
    return _INTENTS_BY_NAME.get(name)


def match_intents(normalized: str) -> list[IntentMatch]:
    """Score every intent against ``normalized`` (lowercased, light punctuation).

    Returns candidates sorted best-first. Confidence is the strongest single
    trigger weight plus a small bonus for corroborating triggers, so a phrase
    that hits several patterns for one intent beats a single weak hit.
    """
    text = f" {normalized.strip()} "
    matches: list[IntentMatch] = []
    for intent in INTENTS:
        if any(veto.search(text) for veto in intent.vetoes):
            continue
        hits = [(pat.pattern, weight) for pat, weight in intent.triggers if pat.search(text)]
        if not hits:
            continue
        best = max(weight for _, weight in hits)
        bonus = min(0.12, 0.05 * (len(hits) - 1))
        matches.append(
            IntentMatch(
                intent=intent,
                confidence=round(min(0.99, best + bonus), 3),
                matched=[p for p, _ in hits],
            )
        )
    matches.sort(key=lambda m: (m.confidence, -INTENTS.index(m.intent)), reverse=True)
    return matches
