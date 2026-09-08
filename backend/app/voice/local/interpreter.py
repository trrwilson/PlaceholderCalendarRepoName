"""The local interpreter: transcript -> intent -> entities -> confidence -> plan.

``interpret()`` is pure and text-only — give it a string, a clock, and the
current calendar snapshot and it returns an :class:`Interpretation` describing
what it would do and, crucially, *whether it should*:

* ``handled_locally``     — high confidence, all entities resolved; the ``tool_calls``
                            are ready to run through the existing tool dispatcher.
* ``needs_clarification`` — recognised but an entity is missing/ambiguous, or a
                            mutation is not confident enough to be safe.
* ``escalate_to_cloud``   — genuine language reasoning is needed (Tier 2), or the
                            request is unknown; ``escalation`` carries only the
                            structured context a cloud text model would need.
* ``rejected``            — recognised but Mission Control cannot do it (calendar
                            writes, display power, shopping lists) — a clean "no",
                            never a guess.

Every stage is timed and recorded (``timings_ms`` / ``trace``) for the debug
surface described in ``docs/local-voice-plan.md``.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field

from app.models import CalendarSnapshot
from app.voice.local.dates import DateResolution, resolve_date_expression
from app.voice.local.entities import EntityMatch, EntityResolver
from app.voice.local.intents import IntentMatch, match_intents

# -- config knobs (defaults; overridden from Settings by the caller) -----------

DEFAULT_INTENT_THRESHOLD = 0.55
DEFAULT_MUTATION_THRESHOLD = 0.8
DEFAULT_ENTITY_THRESHOLD = 0.55


class Disposition(StrEnum):
    handled_locally = "handled_locally"
    needs_clarification = "needs_clarification"
    escalate_to_cloud = "escalate_to_cloud"
    rejected = "rejected"


class ToolCall(BaseModel):
    name: str
    args: dict[str, Any] = Field(default_factory=dict)


class ResolvedEntity(BaseModel):
    kind: str
    query: str
    value: str | None = None
    label: str | None = None
    score: float = 0.0
    resolved: bool = False
    ambiguous: bool = False
    alternatives: list[str] = Field(default_factory=list)

    @classmethod
    def of(cls, match: EntityMatch) -> ResolvedEntity:
        return cls(
            kind=match.kind,
            query=match.query,
            value=match.value,
            label=match.label,
            score=match.score,
            resolved=match.resolved,
            ambiguous=match.ambiguous,
            alternatives=[label for label, _ in match.alternatives],
        )


class Interpretation(BaseModel):
    transcript: str
    normalized: str
    disposition: Disposition
    tier: int
    intent: str
    confidence: float
    reason: str
    slots: dict[str, Any] = Field(default_factory=dict)
    date: dict[str, Any] | None = None
    entities: list[ResolvedEntity] = Field(default_factory=list)
    tool_calls: list[ToolCall] = Field(default_factory=list)
    speech: str | None = None
    clarification: str | None = None
    escalation: dict[str, Any] | None = None
    candidates: list[dict[str, Any]] = Field(default_factory=list)
    timings_ms: dict[str, float] = Field(default_factory=dict)
    trace: list[str] = Field(default_factory=list)


class LocalInterpretRequest(BaseModel):
    """``POST /api/voice/local/interpret`` body — the text-bypass / test entry."""

    text: str
    client_time: str | None = None
    timezone: str | None = None
    timer_active: bool = False
    stt_confidence: float | None = None


class InterpreterConfig(BaseModel):
    intent_threshold: float = DEFAULT_INTENT_THRESHOLD
    mutation_threshold: float = DEFAULT_MUTATION_THRESHOLD
    entity_threshold: float = DEFAULT_ENTITY_THRESHOLD
    cloud_escalation_enabled: bool = True
    person_aliases: dict[str, str] = Field(default_factory=dict)
    after_school_hour: int = 15


# -- normalisation ----------------------------------------------------------

# Only true disfluencies — words like "just", "so", "like" can carry meaning
# ("just show Alex", "so what's tomorrow") so they are left in.
_FILLER = re.compile(r"\b(um+|uh+|erm+|uhh+|hmm+|please|kinda)\b")
_NUMBER_WORDS = {
    "zero": 0,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "fifteen": 15,
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "forty-five": 45,
    "forty five": 45,
    "sixty": 60,
    "ninety": 90,
}


def normalize(text: str) -> str:
    lowered = text.lower().strip()
    lowered = lowered.replace("’", "'").replace("`", "'")
    lowered = _FILLER.sub(" ", lowered)
    lowered = re.sub(r"[^\w\s:'?/-]", " ", lowered)
    lowered = re.sub(r"\s+", " ", lowered).strip()
    return lowered


# -- slot extraction ------------------------------------------------------

_VIEW_WORDS = {
    "home": "home",
    "today": "home",
    "agenda": "home",
    "week": "week",
    "weekly": "week",
    "this week": "week",
    "month": "month",
    "monthly": "month",
    "timer": "timer",
    "alarm": "timer",
    "countdown": "timer",
}


def _extract_view(text: str) -> str | None:
    for word, view in _VIEW_WORDS.items():
        if re.search(rf"\b{re.escape(word)}\b", text):
            return view
    return None


_PERSON_PATTERNS = [
    re.compile(r"\bshow (?:me )?(\w+)'s\b"),
    re.compile(
        r"\bwhat(?:'s| is| does| has)?\s+(\w+?)\s+(?:doing|got|have|up to|schedule|day|been)\b"
    ),
    re.compile(r"\bis (\w+) (?:busy|free|around|available)\b"),
    re.compile(r"\bare (\w+) (?:busy|free|around|available)\b"),
    re.compile(r"\bdoes (\w+) have\b"),
    re.compile(r"\b(\w+)'s (?:calendar|schedule|plans|day|stuff|events)\b"),
    re.compile(r"\b(?:just|only) show (?:me )?(\w+)\b"),
    re.compile(r"\bfilter (?:to|by) (\w+)\b"),
    re.compile(r"\bhide (\w+)'s\b"),
]

_PRONOUNS = {
    "i",
    "we",
    "you",
    "it",
    "everyone",
    "everybody",
    "anyone",
    "anybody",
    "there",
    "that",
    "this",
}


def _extract_person_span(text: str) -> str | None:
    for pat in _PERSON_PATTERNS:
        m = pat.search(text)
        if m:
            candidate = m.group(1).strip()
            if candidate and candidate not in _PRONOUNS:
                return candidate
    m = re.search(r"\b(mom|mum|mommy|dad|daddy|grandma|grandpa|nana)\b", text)
    return m.group(1) if m else None


def _extract_people_span(text: str) -> str | None:
    m = re.search(
        r"\bshow (?:me |just |only )?(.+?)'s (?:calendar|schedule|stuff|events|day)\b", text
    )
    if m:
        return m.group(1)
    m = re.search(
        r"\b(?:just|only) show (?:me )?(.+?)(?:'s)?(?:\s+(?:calendar|stuff|events))?\s*$", text
    )
    if m:
        return m.group(1)
    m = re.search(r"\bfilter (?:to|by) (.+?)\s*$", text)
    return m.group(1) if m else None


_EVENT_PATTERNS = [
    re.compile(
        r"\b(?:open|pull up|bring up|show me|go to)\s+(?:the\s+)?(.+?)(?:\s+(?:appointment|practice|game|match|meeting|party|concert|lesson|class))?\s*$"  # noqa: E501
    ),
    re.compile(
        r"\bmove (?:the\s+)?(.+?)\s+(?:appointment|meeting|event)?\s*(?:to|from|back|forward|earlier|later)\b"  # noqa: E501
    ),
    re.compile(
        r"\b(?:reschedule|cancel|delete|remove)\s+(?:the\s+)?(.+?)(?:\s+(?:appointment|meeting|event))?\s*$"
    ),
    re.compile(r"\bwhen(?:'s| is)\s+(?:the\s+|my\s+|his\s+|her\s+)?(.+?)\??\s*$"),
    re.compile(r"\bwhere(?:'s| is)\s+(?:the\s+|my\s+|his\s+|her\s+)?(.+?)\??\s*$"),
    re.compile(r"\bwhat time is\s+(?:the\s+|my\s+)?(.+?)\??\s*$"),
    re.compile(r"\b(?:minutes?|hours?)\s+before\s+(?:the\s+)?(.+?)\??\s*$"),
]


def _extract_event_span(text: str, strip_spans: list[str]) -> str | None:
    cleaned = text
    for span in strip_spans:
        if span:
            cleaned = cleaned.replace(span, " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    for pat in _EVENT_PATTERNS:
        m = pat.search(cleaned)
        if m:
            span = m.group(1).strip(" '?.")
            span = re.sub(r"^(travis|sarah|mom|dad|mum)'?s?\b", "", span).strip()
            if span and span not in _PRONOUNS and len(span) > 1:
                return span
    return None


def _extract_list_span(text: str) -> tuple[str | None, str | None]:
    """(list name, items) for 'add milk and eggs to the Costco list'."""
    m = re.search(r"\badd (.+?) to (?:the |my )?(.+?)(?: list)?\s*$", text)
    if m:
        return m.group(2).strip(), m.group(1).strip()
    m = re.search(r"\b(?:put|add) (.+?) on the (.+?) list\b", text)
    if m:
        return m.group(2).strip(), m.group(1).strip()
    m = re.search(r"\b(?:show|open|pull up) (?:the )?(.+?) list\b", text)
    if m:
        return m.group(1).strip(), None
    return None, None


_LIST_ITEM_STOPWORDS = {
    "the",
    "a",
    "an",
    "some",
    "my",
    "our",
    "to",
    "of",
    "list",
    "it",
    "that",
    "something",
    "anything",
    "stuff",
    "things",
    "them",
    "these",
    "those",
    "",
}
_LIST_ALIAS_WORDS = {"grocery", "groceries", "shopping", "costco", "target", "walmart", "store"}


def _named_list(text: str) -> str | None:
    """A list the utterance explicitly names ('the packing list'), or None when
    it just says 'the list' / a grocery alias / nothing."""
    m = re.search(r"\b([a-z']+)\s+list\b", text)
    if m and m.group(1) not in _LIST_ALIAS_WORDS | {"the", "my", "our", "a", "to", "on", "this"}:
        return m.group(1)
    return None


def _split_items(raw: str | None) -> list[str]:
    if not raw:
        return []
    parts = re.split(r"\s*(?:,|\band\b|\bplus\b|&)\s*", raw.strip())
    out: list[str] = []
    for part in parts:
        cleaned = re.sub(r"^(?:the|a|an|some|my|our)\s+", "", part.strip()).strip(" .")
        if cleaned and cleaned.lower() not in _LIST_ITEM_STOPWORDS:
            out.append(cleaned)
    return out


# The verb + the run of item words, before any "to/on the … list" destination.
_LIST_ITEM_VERB = re.compile(
    r"\b(?:add|put|remove|delete|drop|take|get|grab|cross|check off|mark|"
    r"got|picked up|grabbed|bought|need|needing|out of|ran out of)\s+"
    r"(?:to |the |some |a |an |off |up |more )*(.+)$"
)
_LIST_DESTINATION = re.compile(
    r"\s+(?:to|on|onto|off|out of|from)\s+(?:the |my |our )?[\w' ]*?\blist\b.*$"
    r"|\s+(?:to|on|from)\s+(?:the |my )?(?:grocery|groceries|shopping|costco|target|walmart)\b.*$"
    r"|\s+(?:as )?(?:bought|done|off|picked up)\s*$"
)


def _extract_list_items(raw: str) -> list[str]:
    """Item names from an add / remove / check utterance. Runs on the *raw*
    transcript (``normalize`` strips the commas that separate items)."""
    text = raw.lower().strip().strip(".?!")
    body = _LIST_DESTINATION.sub("", text)
    m = _LIST_ITEM_VERB.search(body)
    if not m:
        return []
    return _split_items(m.group(1))


def _word_number(token: str) -> int | None:
    token = token.strip()
    if token.isdigit():
        return int(token)
    return _NUMBER_WORDS.get(token)


def extract_duration_seconds(text: str) -> int | None:
    """'10 minutes', 'half an hour', '90 seconds', 'an hour and a half', '1:30'."""
    t = text.lower()
    if re.search(r"\bhalf an hour\b|\bhalf hour\b", t):
        base = 1800
        if re.search(r"\band a half\b", t):
            base += 1800
        return base
    if re.search(r"\bquarter (of )?an hour\b", t):
        return 900

    total = 0.0
    found = False
    for value, unit in re.findall(
        r"(\d+(?:\.\d+)?|" + "|".join(_NUMBER_WORDS) + r")\s*(?:more\s+|another\s+)?"
        r"(hours?|hrs?|minutes?|mins?|seconds?|secs?)",
        t,
    ):
        num = float(value) if re.match(r"^\d", value) else _NUMBER_WORDS.get(value.strip())
        if num is None:
            continue
        found = True
        if unit.startswith(("hour", "hr")):
            total += num * 3600
        elif unit.startswith(("min",)):
            total += num * 60
        else:
            total += num
    if re.search(r"\ban hour and a half\b", t):
        return 5400
    if not found:
        m = re.search(r"\ban? (hour|minute|second)\b", t)
        if m:
            return {"hour": 3600, "minute": 60, "second": 1}[m.group(1)]
        m = re.search(r"\b(\d{1,2}):(\d{2})\b", t)
        if m and "timer" in t or (m and "for" in t):
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60
        return None
    return int(round(total))


def extract_clock_time(text: str, now: datetime) -> datetime | None:
    """'3pm', '6:45', 'quarter past four', 'half past 2', 'noon', 'three pm'."""
    t = text.lower()
    # word-number hours -> digits so "three pm" parses like "3 pm"
    for word, value in sorted(_NUMBER_WORDS.items(), key=lambda kv: -len(kv[0])):
        if value and value <= 12:
            t = re.sub(rf"\b{word}\b", str(value), t)
    if re.search(r"\bnoon\b", t):
        return now.replace(hour=12, minute=0, second=0, microsecond=0)
    if re.search(r"\bmidnight\b", t):
        base = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return base + timedelta(days=1)

    m = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'clock)?\b", t)
    quarter = re.search(r"\b(quarter|half|ten|twenty|five)\s+(past|to|after)\s+(\d{1,2}|\w+)\b", t)
    hour: int | None = None
    minute = 0
    meridiem: str | None = None
    if quarter:
        amount = {"quarter": 15, "half": 30, "ten": 10, "twenty": 20, "five": 5}[quarter.group(1)]
        anchor = _word_number(quarter.group(3))
        if anchor is None:
            return None
        if quarter.group(2) in ("past", "after"):
            hour, minute = anchor, amount
        else:
            hour, minute = (anchor - 1) % 24, 60 - amount
    elif m and (m.group(3) or "timer" not in t):
        hour = int(m.group(1))
        minute = int(m.group(2)) if m.group(2) else 0
        meridiem = m.group(3)
    if hour is None:
        return None

    if meridiem and meridiem.startswith("p") and hour < 12:
        hour += 12
    elif meridiem and meridiem.startswith("a") and hour == 12:
        hour = 0
    elif not meridiem and hour <= 12:
        # No am/pm: pick the next occurrence, biased to daytime.
        candidate = now.replace(hour=hour % 24, minute=minute, second=0, microsecond=0)
        if candidate <= now and hour < 12:
            candidate = candidate.replace(hour=hour + 12)
        if candidate <= now:
            candidate += timedelta(days=1)
        return candidate

    candidate = now.replace(hour=hour % 24, minute=minute, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate


def _extract_label(text: str) -> str | None:
    m = re.search(
        r"\b(?:for|called|labell?ed|named)\s+(?:the\s+|my\s+)?([\w ]+?)(?:\s+(?:timer|alarm))?\s*$",
        text,
    )
    if m:
        label = m.group(1).strip()
        if label and label not in {"me", "us", "it", "that"} and not re.match(r"^\d", label):
            return label
    return None


# -- the interpreter -----------------------------------------------------


def interpret(
    transcript: str,
    *,
    now: datetime,
    snapshot: CalendarSnapshot,
    config: InterpreterConfig | None = None,
    timer_active: bool = False,
    stt_confidence: float | None = None,
) -> Interpretation:
    cfg = config or InterpreterConfig()
    t0 = time.perf_counter()
    timings: dict[str, float] = {}
    trace: list[str] = []

    normalized = normalize(transcript)
    trace.append(f"normalized: {normalized!r}")

    if not normalized or len(normalized) < 2:
        return Interpretation(
            transcript=transcript,
            normalized=normalized,
            disposition=Disposition.needs_clarification,
            tier=0,
            intent="unknown",
            confidence=0.0,
            reason="empty or unintelligible transcript",
            clarification="Sorry, I didn't catch that.",
            timings_ms={"total": round((time.perf_counter() - t0) * 1000, 2)},
            trace=trace,
        )

    # 1. temporal scope
    mark = time.perf_counter()
    date_res = resolve_date_expression(normalized, now)
    timings["dates"] = round((time.perf_counter() - mark) * 1000, 2)
    trace.append(
        f"date: kind={date_res.kind} start={date_res.iso_start()} end={date_res.iso_end()}"
    )

    # 2. intent
    mark = time.perf_counter()
    matches = match_intents(normalized)
    timings["intent"] = round((time.perf_counter() - mark) * 1000, 2)
    candidates = [
        {"intent": m.name, "confidence": m.confidence, "matched": m.matched[:3]}
        for m in matches[:5]
    ]
    trace.append("intents: " + ", ".join(f"{m.name}={m.confidence}" for m in matches[:4]))

    stt_penalty = 1.0
    if stt_confidence is not None and stt_confidence < 0.6:
        stt_penalty = 0.75 + 0.25 * max(0.0, stt_confidence / 0.6)
        trace.append(f"stt confidence {stt_confidence:.2f} -> penalty {stt_penalty:.2f}")

    resolver = EntityResolver(snapshot, aliases=cfg.person_aliases, now=now)

    if not matches or matches[0].confidence * stt_penalty < cfg.intent_threshold:
        best = matches[0].confidence if matches else 0.0
        return _finish(
            _unknown(transcript, normalized, date_res, cfg, best * stt_penalty, snapshot, now),
            timings,
            trace,
            candidates,
            t0,
        )

    top = matches[0]
    mark = time.perf_counter()
    result = _plan(
        top, transcript, normalized, date_res, resolver, cfg, now, timer_active, stt_penalty
    )
    timings["planning"] = round((time.perf_counter() - mark) * 1000, 2)
    return _finish(result, timings, trace, candidates, t0)


def _finish(
    interp: Interpretation,
    timings: dict[str, float],
    trace: list[str],
    candidates: list[dict[str, Any]],
    t0: float,
) -> Interpretation:
    timings["total"] = round((time.perf_counter() - t0) * 1000, 2)
    interp.timings_ms = {**interp.timings_ms, **timings}
    interp.trace = [*trace, *interp.trace]
    if not interp.candidates:
        interp.candidates = candidates
    return interp


def _date_dict(d: DateResolution) -> dict[str, Any]:
    return {
        "kind": d.kind,
        "start": d.iso_start(),
        "end": d.iso_end(),
        "time_start": d.time_start.isoformat() if d.time_start else None,
        "time_end": d.time_end.isoformat() if d.time_end else None,
        "text": d.text,
        "confidence": d.confidence,
    }


def _unknown(
    transcript: str,
    normalized: str,
    date_res: DateResolution,
    cfg: InterpreterConfig,
    confidence: float,
    snapshot: CalendarSnapshot,
    now: datetime,
) -> Interpretation:
    disposition = (
        Disposition.escalate_to_cloud
        if cfg.cloud_escalation_enabled
        else Disposition.needs_clarification
    )
    escalation = None
    if disposition == Disposition.escalate_to_cloud:
        escalation = _escalation_payload(transcript, "unrecognised-intent", date_res, snapshot, now)
    return Interpretation(
        transcript=transcript,
        normalized=normalized,
        disposition=disposition,
        tier=3 if disposition == Disposition.escalate_to_cloud else 0,
        intent="unknown",
        confidence=round(confidence, 3),
        reason="no local intent matched with enough confidence",
        date=_date_dict(date_res) if date_res.resolved else None,
        clarification=None if escalation else "I'm not sure how to help with that.",
        escalation=escalation,
    )


def _escalation_payload(
    transcript: str,
    why: str,
    date_res: DateResolution,
    snapshot: CalendarSnapshot,
    now: datetime,
    *,
    person: EntityMatch | None = None,
) -> dict[str, Any]:
    """Only the structured context a cloud text model would need — never the raw
    calendar dump. Bounded to the resolved date scope."""
    events: list[dict[str, Any]] = []
    if date_res.resolved:
        start, end = date_res.start, date_res.end or date_res.start
        names = {c.id: (c.display_name or c.name) for c in snapshot.calendars}
        for e in snapshot.events:
            if e.starts_at.date() <= end and e.ends_at.date() >= start:
                events.append(
                    {
                        "title": e.title,
                        "who": names.get(e.calendar_id, e.calendar_id),
                        "start": e.starts_at.isoformat(timespec="minutes"),
                        "end": e.ends_at.isoformat(timespec="minutes"),
                        "all_day": e.all_day,
                        "location": e.location,
                    }
                )
    return {
        "why": why,
        "transcript": transcript,
        "now": now.isoformat(timespec="minutes"),
        "people": [c.display_name or c.name for c in snapshot.calendars],
        "date_scope": {"start": date_res.iso_start(), "end": date_res.iso_end()}
        if date_res.resolved
        else None,
        "person": person.label if person and person.resolved else None,
        "events_in_scope": events[:40],
    }


def _speak_view(view: str) -> str:
    return {
        "home": "Here's today.",
        "week": "Here's the week.",
        "month": "Here's the month.",
        "timer": "Here's the timer.",
    }.get(view, "Done.")


def _plan(
    match: IntentMatch,
    transcript: str,
    normalized: str,
    date_res: DateResolution,
    resolver: EntityResolver,
    cfg: InterpreterConfig,
    now: datetime,
    timer_active: bool,
    stt_penalty: float,
) -> Interpretation:
    intent = match.intent
    snapshot = resolver.snapshot
    base = Interpretation(
        transcript=transcript,
        normalized=normalized,
        disposition=Disposition.handled_locally,
        tier=intent.tier,
        intent=intent.name,
        confidence=round(match.confidence * stt_penalty, 3),
        reason="",
        date=_date_dict(date_res) if date_res.resolved else None,
    )
    conf = match.confidence * stt_penalty

    # --- recognised but not a Mission Control capability --------------------
    if not intent.supported:
        if intent.name in ("calendar.move_event", "calendar.add_event", "calendar.delete_event"):
            base.disposition = Disposition.rejected
            base.reason = "voice cannot change the calendar (read-only, per AGENTS.md)"
            base.speech = "I can't change the calendar yet — I can only read it to you."
            return base
        if intent.name.startswith("display."):
            base.disposition = Disposition.rejected
            base.reason = "no DisplayController capability yet (see docs/camera-support-plan.md)"
            base.speech = "I can't control the display yet."
            return base
        base.disposition = Disposition.rejected
        base.reason = "recognised but unsupported"
        base.speech = "I can't do that yet."
        return base

    # --- Tier 2: needs real language reasoning -> cloud --------------------
    if intent.name == "calendar.plan":
        person = None
        span = _extract_person_span(normalized)
        if span:
            person = resolver.resolve_person(span)
            base.entities.append(ResolvedEntity.of(person))
        base.disposition = (
            Disposition.escalate_to_cloud
            if cfg.cloud_escalation_enabled
            else Disposition.needs_clarification
        )
        base.tier = 2
        base.reason = "planning / comparison question — local STT, cloud reasoning"
        base.clarification = (
            None
            if cfg.cloud_escalation_enabled
            else "That one needs the full assistant, which is offline."
        )
        base.escalation = _escalation_payload(
            transcript, "needs-reasoning", date_res, snapshot, now, person=person
        )
        return base

    # --- grocery list -------------------------------------------------
    if intent.name.startswith("list."):
        return _plan_list(base, intent.name, transcript, normalized, resolver, cfg, conf)

    # --- timers ---------------------------------------------------------
    if intent.name == "timer.start":
        return _plan_timer_start(base, normalized, date_res, resolver, cfg, now, conf)
    if intent.name == "timer.cancel":
        if not timer_active and conf < 0.75:
            base.disposition = Disposition.needs_clarification
            base.reason = "‘turn it off’ is ambiguous with no timer running"
            base.clarification = "There's no timer running — did you mean something else?"
            return base
        base.tool_calls = [ToolCall(name="cancel_timer")]
        base.speech = "Timer stopped." if timer_active else "There's no timer, but okay."
        base.reason = "timer control (fully local capability)"
        return base
    if intent.name == "timer.extend":
        seconds = extract_duration_seconds(normalized)
        if seconds is None:
            base.disposition = Disposition.needs_clarification
            base.reason = "no amount of time given for the extension"
            base.clarification = "How many more minutes?"
            return base
        base.slots = {"add_seconds": seconds}
        base.tool_calls = [
            ToolCall(name="extend_timer", args={"add_minutes": round(seconds / 60, 2)})
        ]
        base.speech = f"Added {_humanize_seconds(seconds)}."
        base.reason = "timer control (fully local capability)"
        return base
    if intent.name == "timer.pause":
        if not timer_active and conf < 0.85:
            base.disposition = Disposition.needs_clarification
            base.reason = "‘pause’ with no timer running is ambiguous"
            base.clarification = "There's no timer running to pause."
            return base
        base.tool_calls = [ToolCall(name="pause_timer")]
        base.speech = "Timer paused." if timer_active else "There's no timer running."
        base.reason = "timer control (fully local capability)"
        return base
    if intent.name == "timer.resume":
        base.tool_calls = [ToolCall(name="resume_timer")]
        base.speech = "Timer resumed."
        base.reason = "timer control (fully local capability)"
        return base
    if intent.name == "timer.restart":
        base.tool_calls = [
            ToolCall(name="restart_timer"),
            ToolCall(name="show_view", args={"view": "timer"}),
        ]
        base.speech = "Timer restarted."
        base.reason = "timer control (fully local capability)"
        return base
    if intent.name == "timer.query":
        base.tool_calls = [ToolCall(name="get_timer")]
        base.reason = "timer control (fully local capability)"
        return base

    # --- calendar navigation & queries --------------------------------
    if intent.name == "calendar.show_view":
        return _plan_show_view(base, normalized, date_res, conf, cfg)
    if intent.name == "calendar.person_filter":
        return _plan_person_filter(base, normalized, resolver, cfg, conf)
    if intent.name == "calendar.open_event":
        return _plan_open_event(base, normalized, date_res, resolver, cfg, conf)
    if intent.name == "calendar.conflicts":
        target = date_res if date_res.resolved else resolve_date_expression("today", now)
        base.slots = {"date": target.iso_start()}
        base.tool_calls = [
            ToolCall(name="check_conflicts", args={"date": target.iso_start()}),
            ToolCall(name="show_view", args={"view": "week", "date": target.iso_start()}),
        ]
        base.speech = "Checking for clashes."
        base.reason = "single-day conflict check (local)"
        return base
    if intent.name in ("calendar.query_day", "calendar.query_person"):
        return _plan_query(base, intent.name, normalized, date_res, resolver, cfg, now, conf)

    base.disposition = (
        Disposition.escalate_to_cloud
        if cfg.cloud_escalation_enabled
        else Disposition.needs_clarification
    )
    base.reason = "matched an intent with no local plan"
    return base


def _plan_show_view(
    base: Interpretation,
    normalized: str,
    date_res: DateResolution,
    conf: float,
    cfg: InterpreterConfig,
) -> Interpretation:
    said_today = bool(re.search(r"\b(today|tonight|home|now)\b", normalized))
    view = _extract_view(normalized)
    date_iso = date_res.iso_start() if date_res.resolved else None
    if view is None and date_res.resolved:
        # "show me tomorrow" / "go to Friday" — Home only shows today, so a
        # specific day lands in Week (mirrors prompt.py).
        if said_today:
            view = "home"
        elif (
            date_res.is_range
            and date_res.end
            and date_res.start
            and (date_res.end - date_res.start).days > 8
        ):
            view = "month"
        else:
            view = "week"
    if view is None:
        base.disposition = Disposition.needs_clarification
        base.reason = "no view or date to show"
        base.clarification = "Which view — home, week, or month?"
        return base
    base.slots = {"view": view, "date": date_iso}
    args: dict[str, Any] = {"view": view}
    if date_iso and view not in ("timer", "home"):
        args["date"] = date_iso
    base.tool_calls = [ToolCall(name="show_view", args=args)]
    base.speech = (
        f"Here's {date_res.text}."
        if (date_res.resolved and date_res.text and not said_today)
        else _speak_view(view)
    )
    base.reason = "view navigation (local, Tier 0)"
    base.tier = 0
    return base


def _plan_person_filter(
    base: Interpretation,
    normalized: str,
    resolver: EntityResolver,
    cfg: InterpreterConfig,
    conf: float,
) -> Interpretation:
    if re.search(
        r"\b(everyone|everybody|all of us|all calendars|clear the filter|show all)\b", normalized
    ):
        base.slots = {"mode": "all", "people": []}
        base.tool_calls = [ToolCall(name="set_people_filter", args={"mode": "all", "people": []})]
        base.speech = "Showing everyone."
        base.reason = "people filter reset (local)"
        return base
    span = _extract_people_span(normalized) or _extract_person_span(normalized)
    if not span:
        base.disposition = Disposition.needs_clarification
        base.reason = "no person named for the filter"
        base.clarification = "Whose calendar should I show?"
        return base
    people = resolver.resolve_people(span)
    base.entities = [ResolvedEntity.of(p) for p in people]
    resolved = [p for p in people if p.resolved]
    if not resolved:
        base.disposition = Disposition.needs_clarification
        base.reason = f"could not match ‘{span}’ to a household calendar"
        base.clarification = f"I don't have a calendar for {span}."
        return base
    if any(p.ambiguous for p in resolved):
        amb = next(p for p in resolved if p.ambiguous)
        base.disposition = Disposition.needs_clarification
        base.reason = "person reference is ambiguous"
        base.clarification = f"Did you mean {amb.label} or {amb.alternatives[0]}?"
        return base
    labels = [p.label for p in resolved]
    base.slots = {"mode": "only", "people": [p.value for p in resolved]}
    base.tool_calls = [
        ToolCall(
            name="set_people_filter", args={"mode": "only", "people": [p.value for p in resolved]}
        )
    ]
    base.speech = f"Showing {_join(labels)}."
    base.reason = "people filter (local, state-aware)"
    base.tier = 1
    return base


def _plan_list(
    base: Interpretation,
    intent_name: str,
    transcript: str,
    normalized: str,
    resolver: EntityResolver,
    cfg: InterpreterConfig,
    conf: float,
) -> Interpretation:
    named = _named_list(normalized)
    wants_items = intent_name in ("list.add", "list.remove", "list.check")
    items = _extract_list_items(transcript) if wants_items else []
    list_match = resolver.resolve_list(named or "")
    base.entities = [ResolvedEntity.of(list_match)]
    if not list_match.resolved:
        base.disposition = Disposition.needs_clarification
        base.reason = f"'{named}' is not a list Mission Control keeps"
        base.clarification = "I've only got the grocery list."
        return base
    list_id = list_match.value or "grocery"
    show = ToolCall(name="show_view", args={"view": "lists"})
    base.tier = 1 if intent_name != "list.show" else 0
    base.reason = "grocery list (local capability)"

    if intent_name == "list.show":
        base.tool_calls = [show]
        base.speech = "Here's the grocery list."
        return base

    if intent_name == "list.clear":
        checked_only = bool(
            re.search(r"\b(ones|stuff|things) we (got|bought|picked up|have)\b", normalized)
            or re.search(r"\bchecked(?: off)?\b", normalized)
        )
        if not checked_only and conf < cfg.mutation_threshold:
            base.disposition = Disposition.needs_clarification
            base.reason = "clearing the whole list is a big change; confidence is low"
            base.clarification = "Clear the whole grocery list?"
            return base
        scope = "checked" if checked_only else "all"
        base.slots = {"list": list_id, "scope": scope}
        base.tool_calls = [
            ToolCall(name="clear_list", args={"scope": scope, "list": list_id}),
            show,
        ]
        base.speech = (
            "Cleared the ones we've got."
            if checked_only
            else "Cleared the grocery list — you can undo that on screen."
        )
        return base

    if not items:
        base.disposition = Disposition.needs_clarification
        base.reason = "no item named"
        base.clarification = (
            "What should I add to the list?" if intent_name == "list.add" else "Which item?"
        )
        return base

    if intent_name == "list.add":
        base.slots = {"list": list_id, "items": items}
        base.tool_calls = [
            ToolCall(name="add_to_list", args={"items": items, "list": list_id}),
            show,
        ]
        base.speech = f"Adding {_join(items)} to the grocery list."
        return base

    # list.remove / list.check — one item, and removal is destructive.
    item = items[0]
    if intent_name == "list.remove":
        if conf < cfg.mutation_threshold:
            base.disposition = Disposition.needs_clarification
            base.reason = "removing an item on low confidence is unsafe"
            base.clarification = f"Take {item} off the grocery list?"
            return base
        base.slots = {"list": list_id, "item": item}
        base.tool_calls = [
            ToolCall(name="remove_from_list", args={"item": item, "list": list_id}),
            show,
        ]
        base.speech = f"Taking {item} off the list."
        return base

    base.slots = {"list": list_id, "item": item}
    base.tool_calls = [
        ToolCall(name="check_off_item", args={"item": item, "list": list_id}),
        show,
    ]
    base.speech = f"Checked off {item}."
    return base


def _plan_open_event(
    base: Interpretation,
    normalized: str,
    date_res: DateResolution,
    resolver: EntityResolver,
    cfg: InterpreterConfig,
    conf: float,
) -> Interpretation:
    person_span = _extract_person_span(normalized)
    person_cal = None
    if person_span:
        pm = resolver.resolve_person(person_span)
        if pm.resolved:
            person_cal = pm.value
            base.entities.append(ResolvedEntity.of(pm))
    span = _extract_event_span(normalized, date_res.matched_spans)
    if not span:
        base.disposition = Disposition.needs_clarification
        base.reason = "no event description to match"
        base.clarification = "Which event?"
        return base
    start = date_res.start if date_res.resolved else None
    end = date_res.end if date_res.resolved else None
    ev = resolver.resolve_event(span, start=start, end=end, person_calendar_id=person_cal)
    base.entities.append(ResolvedEntity.of(ev))
    base.slots = {"event_query": span}
    if not ev.resolved:
        base.disposition = Disposition.needs_clarification
        base.reason = f"no event matches ‘{span}’ in the current view"
        base.clarification = f"I can't find ‘{span}’ — try moving to the right week first."
        return base
    if ev.ambiguous:
        base.disposition = Disposition.needs_clarification
        base.reason = "more than one event matches equally well"
        base.clarification = f"Did you mean {ev.label} or {ev.alternatives[0]}?"
        return base
    base.tool_calls = [ToolCall(name="highlight_event", args={"query": ev.label or span})]
    base.speech = f"Here's {ev.label}."
    base.reason = "open one event (local, state-aware)"
    base.tier = 1
    return base


def _plan_query(
    base: Interpretation,
    intent_name: str,
    normalized: str,
    date_res: DateResolution,
    resolver: EntityResolver,
    cfg: InterpreterConfig,
    now: datetime,
    conf: float,
) -> Interpretation:
    # date defaults to today when the utterance didn't say
    scope = date_res if date_res.resolved else resolve_date_expression("today", now)
    person_match: EntityMatch | None = None
    if intent_name == "calendar.query_person":
        span = _extract_person_span(normalized)
        if not span:
            base.disposition = Disposition.needs_clarification
            base.reason = "person query with no identifiable person"
            base.clarification = "Whose schedule?"
            return base
        person_match = resolver.resolve_person(span)
        base.entities.append(ResolvedEntity.of(person_match))
        base.slots["person"] = span
        if not person_match.resolved:
            base.disposition = Disposition.needs_clarification
            base.reason = f"‘{span}’ does not match a household calendar"
            base.clarification = f"I don't have a calendar for {span}."
            return base
        if person_match.ambiguous:
            base.disposition = Disposition.needs_clarification
            base.reason = "ambiguous person"
            base.clarification = (
                f"Did you mean {person_match.label} or {person_match.alternatives[0]}?"
            )
            return base

    base.slots["date"] = scope.iso_start()
    if scope.time_start:
        base.slots["time_start"] = scope.time_start.isoformat()
        base.slots["time_end"] = scope.time_end.isoformat() if scope.time_end else None

    # A time-of-day narrowing ("after lunch", "Tuesday evening") is a filter the
    # local tools can't apply — the data tools are whole-day. Answer with the day
    # and let the display carry it; note the narrowing in the trace.
    view = "home" if _is_relative_today(scope, now) else "week"
    if scope.is_range:
        view = "week" if (scope.end - scope.start).days <= 8 else "month"

    if scope.is_range:
        base.tool_calls.append(
            ToolCall(name="get_events", args={"start": scope.iso_start(), "end": scope.iso_end()})
        )
    else:
        base.tool_calls.append(ToolCall(name="get_agenda", args={"date": scope.iso_start()}))
    view_args: dict[str, Any] = {"view": view}
    if view != "home":
        view_args["date"] = scope.iso_start()
    base.tool_calls.append(ToolCall(name="show_view", args=view_args))

    who = f"{person_match.label}'s" if person_match else "the"
    when = scope.text or ("today" if _is_relative_today(scope, now) else scope.iso_start())
    base.speech = f"Pulling up {who} schedule for {when}."
    base.reason = "calendar read (local, state-aware); spoken summary is the kiosk's job"
    base.tier = 1
    if scope.time_start:
        base.reason += "; time-of-day narrowing left to the display"
    return base


def _plan_timer_start(
    base: Interpretation,
    normalized: str,
    date_res: DateResolution,
    resolver: EntityResolver,
    cfg: InterpreterConfig,
    now: datetime,
    conf: float,
) -> Interpretation:
    label = _extract_label(normalized)
    base.reason = "timer control (fully local capability)"

    # "30 minutes before the game" — needs the event first.
    before = re.search(r"\b(\d+|\w+)\s*(minutes?|hours?)\s+before\b", normalized)
    if before:
        span = _extract_event_span(normalized, date_res.matched_spans)
        if span:
            ev_match = resolver.resolve_event(
                span,
                start=date_res.start if date_res.resolved else None,
                end=date_res.end if date_res.resolved else None,
            )
            base.entities.append(ResolvedEntity.of(ev_match))
            base.slots["event_query"] = span
            if not ev_match.resolved:
                base.disposition = Disposition.needs_clarification
                base.reason = f"can't find the event ‘{span}’ to time against"
                base.clarification = f"I can't find ‘{span}’ on the calendar."
                return base
            event = resolver.event_by_id(ev_match.value or "")
            offset = extract_duration_seconds(before.group(0)) or 0
            if event and offset:
                fires_at = event.starts_at - timedelta(seconds=offset)
                if fires_at <= now:
                    base.disposition = Disposition.rejected
                    base.reason = "that timer would already be in the past"
                    base.speech = "That time has already passed."
                    return base
                base.slots["fires_at"] = fires_at.isoformat(timespec="seconds")
                base.tool_calls = [
                    ToolCall(
                        name="start_timer",
                        args={"fires_at": fires_at.isoformat(timespec="seconds"), "label": label},
                    ),
                    ToolCall(name="show_view", args={"view": "timer"}),
                ]
                base.speech = f"Timer set for {_humanize_seconds(offset)} before {ev_match.label}."
                base.tier = 1
                return base

    # absolute clock time ("set an alarm for 3pm")
    if re.search(r"\balarm\b|\bwake me\b|\bat \d", normalized) and not re.search(
        r"\bfor \d+\s*(min|sec|hour)", normalized
    ):
        when = extract_clock_time(normalized, now)
        if when:
            base.slots["fires_at"] = when.isoformat(timespec="seconds")
            base.tool_calls = [
                ToolCall(
                    name="start_timer",
                    args={"fires_at": when.isoformat(timespec="seconds"), "label": label},
                ),
                ToolCall(name="show_view", args={"view": "timer"}),
            ]
            base.speech = f"Alarm set for {_fmt_time(when)}."
            return base

    # plain duration
    seconds = extract_duration_seconds(normalized)
    if seconds is None:
        when = extract_clock_time(normalized, now)
        if when:
            base.slots["fires_at"] = when.isoformat(timespec="seconds")
            base.tool_calls = [
                ToolCall(
                    name="start_timer",
                    args={"fires_at": when.isoformat(timespec="seconds"), "label": label},
                ),
                ToolCall(name="show_view", args={"view": "timer"}),
            ]
            base.speech = f"Alarm set for {_fmt_time(when)}."
            return base
        base.disposition = Disposition.needs_clarification
        base.reason = "timer requested with no duration or time"
        base.clarification = "How long should the timer be?"
        return base
    if seconds > 21_600:
        base.disposition = Disposition.rejected
        base.reason = "timer longer than the six-hour ceiling"
        base.speech = "Timers can be at most six hours."
        return base
    base.slots["duration_seconds"] = seconds
    base.tool_calls = [
        ToolCall(
            name="start_timer",
            args={"duration_minutes": round(seconds / 60, 4), "label": label},
        ),
        ToolCall(name="show_view", args={"view": "timer"}),
    ]
    base.speech = f"{_humanize_seconds(seconds)} timer" + (f" for {label}." if label else ".")
    base.tier = 0
    return base


# -- small helpers ------------------------------------------------------


def _is_relative_today(d: DateResolution, now: datetime) -> bool:
    return d.resolved and d.start == now.date() and (d.end or d.start) == now.date()


def _humanize_seconds(seconds: int) -> str:
    if seconds % 3600 == 0 and seconds >= 3600:
        h = seconds // 3600
        return f"{h}-hour" if h == 1 else f"{h}-hour"
    if seconds >= 3600:
        h, rem = divmod(seconds, 3600)
        m = rem // 60
        return f"{h} hour {m} minute" if m else f"{h} hour"
    if seconds % 60 == 0:
        return f"{seconds // 60}-minute"
    if seconds < 60:
        return f"{seconds}-second"
    return f"{seconds // 60} minute {seconds % 60} second"


def _fmt_time(when: datetime) -> str:
    hour = when.hour % 12 or 12
    suffix = "am" if when.hour < 12 else "pm"
    return f"{hour}:{when.minute:02d} {suffix}" if when.minute else f"{hour} {suffix}"


def _join(items: list[str | None]) -> str:
    clean = [i for i in items if i]
    if len(clean) <= 1:
        return clean[0] if clean else ""
    if len(clean) == 2:
        return f"{clean[0]} and {clean[1]}"
    return ", ".join(clean[:-1]) + f", and {clean[-1]}"


_join_words = _join
