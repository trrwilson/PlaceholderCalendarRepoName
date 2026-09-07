"""Dynamic-entity resolution against live Mission Control state.

The intent layer produces free-text slot spans ("Mom", "the dentist appointment",
"cost co"); this module resolves them against the *current* calendar snapshot —
household people/calendars and the events in scope — with fuzzy matching and an
explicit score, so imperfect recognition ("cost co" -> "Costco") still lands when
one candidate is clearly best, and genuine ambiguity is reported rather than
guessed.

No static list of names is baked in. The snapshot is passed in per turn.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from difflib import SequenceMatcher

from app.models import CalendarEvent, CalendarSnapshot

# Casual references the household uses for a person. Configurable via
# ``MISSION_CONTROL_LOCAL_PERSON_ALIASES`` ("mom=Sarah,dad=Travis"); these are
# only *hints* — an alias still has to fuzzy-match a real calendar.
DEFAULT_ALIASES: dict[str, str] = {}

_STOPWORDS = {
    "the",
    "a",
    "an",
    "my",
    "our",
    "his",
    "her",
    "their",
    "calendar",
    "schedule",
    "appointment",
    "appointments",
    "event",
    "events",
    "meeting",
    "list",
    "stuff",
    "things",
    "day",
    "plans",
    "on",
    "for",
    "to",
    "of",
    "is",
    "are",
    "doing",
    "got",
    "have",
    "has",
}


def _norm(text: str) -> str:
    return re.sub(r"[^\w\s]", " ", text.lower()).strip()


def _tokens(text: str) -> list[str]:
    return [t for t in _norm(text).split() if t and t not in _STOPWORDS]


def _ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def _fuzzy_score(query: str, candidate: str) -> float:
    """0..1 similarity tuned for short household names / titles.

    Blends a whole-string ratio with the best per-token ratio so "cost co"
    scores well against "costco" and "dentist" scores well against "Dentist
    appointment".
    """
    q, c = _norm(query), _norm(candidate)
    if not q or not c:
        return 0.0
    if q == c:
        return 1.0
    if q in c or c in q:
        return 0.9
    whole = _ratio(q, c)
    q_compact = q.replace(" ", "")
    c_compact = c.replace(" ", "")
    compact = _ratio(q_compact, c_compact)
    q_tokens, c_tokens = _tokens(query) or [q], _tokens(candidate) or [c]
    token_hits = []
    for qt in q_tokens:
        best = max((_ratio(qt, ct) for ct in c_tokens), default=0.0)
        token_hits.append(best)
    token_score = sum(token_hits) / len(token_hits) if token_hits else 0.0
    overlap = len(set(q_tokens) & set(c_tokens)) / max(len(q_tokens), 1)
    return round(max(whole, compact, 0.5 * token_score + 0.5 * overlap), 3)


@dataclass
class EntityMatch:
    """One resolved (or unresolved) entity reference."""

    kind: str  # "person" | "event" | "list"
    query: str  # the surface text from the utterance
    value: str | None = None  # resolved id (calendar id / event id)
    label: str | None = None  # human label of the resolved entity
    score: float = 0.0
    alternatives: list[tuple[str, float]] = field(default_factory=list)  # (label, score)

    @property
    def resolved(self) -> bool:
        return self.value is not None and self.score >= 0.55

    @property
    def ambiguous(self) -> bool:
        """Best and runner-up are close enough that picking one would be a guess."""
        if not self.alternatives:
            return False
        return self.resolved and (self.score - self.alternatives[0][1]) < 0.12


class EntityResolver:
    """Resolves people / events / lists against one calendar snapshot."""

    def __init__(
        self,
        snapshot: CalendarSnapshot,
        *,
        aliases: dict[str, str] | None = None,
        now: datetime | None = None,
    ) -> None:
        self.snapshot = snapshot
        self.aliases = {k.lower(): v for k, v in (aliases or DEFAULT_ALIASES).items()}
        self.now = now or datetime.now()

    # -- people / calendars ------------------------------------------------
    def resolve_person(self, text: str) -> EntityMatch:
        query = text.strip()
        match = EntityMatch(kind="person", query=query)
        if not query:
            return match

        alias_target = self.aliases.get(_norm(query))
        effective = alias_target or query

        scored: list[tuple[str, str, float]] = []  # (calendar_id, label, score)
        for calendar in self.snapshot.calendars:
            names = {calendar.display_name, calendar.name}
            # first name only, for "Sarah" vs "Sarah Shapro"
            names |= {n.split()[0] for n in names if n and " " in n}
            best = max(_fuzzy_score(effective, n) for n in names if n)
            if alias_target:
                best = min(1.0, best + 0.15)  # the household calls them this
            scored.append((calendar.id, calendar.display_name or calendar.name, best))

        scored.sort(key=lambda s: s[2], reverse=True)
        if not scored:
            return match
        cal_id, label, score = scored[0]
        match.score = round(score, 3)
        match.alternatives = [(lbl, round(sc, 3)) for _, lbl, sc in scored[1:3] if sc > 0.3]
        if score >= 0.55:
            match.value = cal_id
            match.label = label
        return match

    def resolve_people(self, text: str) -> list[EntityMatch]:
        """Split on 'and' / commas for 'show Mom and Dad'."""
        parts = re.split(r"\s*(?:,|\band\b|\bplus\b)\s*", text.strip())
        return [self.resolve_person(p) for p in parts if p.strip()]

    # -- events ----------------------------------------------------------
    def resolve_event(
        self,
        text: str,
        *,
        start: date | None = None,
        end: date | None = None,
        person_calendar_id: str | None = None,
    ) -> EntityMatch:
        query = text.strip()
        match = EntityMatch(kind="event", query=query)
        if not query:
            return match

        events = self._events_in_scope(start, end)
        scored: list[tuple[CalendarEvent, float]] = []
        for event in events:
            if person_calendar_id and event.calendar_id != person_calendar_id:
                continue
            title_score = _fuzzy_score(query, event.title)
            cat_score = max(
                (_fuzzy_score(query, cat.name) for cat in event.categories), default=0.0
            )
            score = max(title_score, 0.7 * cat_score)
            if score > 0.2:
                scored.append((event, score))

        scored.sort(key=lambda s: s[1], reverse=True)
        if not scored:
            return match
        event, score = scored[0]
        match.score = round(score, 3)
        match.alternatives = [(e.title, round(sc, 3)) for e, sc in scored[1:3]]
        if score >= 0.55:
            match.value = event.id
            match.label = event.title
        return match

    def _events_in_scope(self, start: date | None, end: date | None) -> list[CalendarEvent]:
        events = list(self.snapshot.events)
        if start is None:
            return events
        end = end or start
        return [e for e in events if e.starts_at.date() <= end and e.ends_at.date() >= start]

    def event_by_id(self, event_id: str) -> CalendarEvent | None:
        return next((e for e in self.snapshot.events if e.id == event_id), None)

    # -- lists (no Mission Control list feature yet) ----------------------
    def resolve_list(self, text: str) -> EntityMatch:
        # There is no list store. Always unresolved — the interpreter turns this
        # into a clean "lists aren't supported yet" / escalation, never a guess.
        return EntityMatch(kind="list", query=text.strip())
