"""Relative date / time-of-day expression resolution for the local interpreter.

Deliberately small and rule-based — the household-command space uses a handful of
temporal idioms ("tomorrow", "this weekend", "after school Wednesday", "the
14th"). It is **not** a general natural-language date parser; unknown phrasings
return ``kind == "none"`` and the interpreter escalates or asks.

All dates are naive local (``AGENTS.md`` -> "Time handling"). ``now`` is the
kiosk's wall clock, threaded in from the token request.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

_WEEKDAYS = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
    # common ASR / casual spellings
    "mon": 0,
    "tues": 1,
    "tue": 1,
    "weds": 2,
    "wed": 2,
    "thurs": 3,
    "thur": 3,
    "thu": 3,
    "fri": 4,
    "sat": 5,
    "sun": 6,
}

_MONTHS = {
    m: i
    for i, m in enumerate(
        [
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december",
        ],
        start=1,
    )
}
_MONTHS.update(
    {
        "jan": 1,
        "feb": 2,
        "mar": 3,
        "apr": 4,
        "jun": 6,
        "jul": 7,
        "aug": 8,
        "sept": 9,
        "sep": 9,
        "oct": 10,
        "nov": 11,
        "dec": 12,
    }
)

_ORDINALS = {
    "first": 1,
    "second": 2,
    "third": 3,
    "fourth": 4,
    "fifth": 5,
    "sixth": 6,
    "seventh": 7,
    "eighth": 8,
    "ninth": 9,
    "tenth": 10,
    "eleventh": 11,
    "twelfth": 12,
    "thirteenth": 13,
    "fourteenth": 14,
    "fifteenth": 15,
    "sixteenth": 16,
    "seventeenth": 17,
    "eighteenth": 18,
    "nineteenth": 19,
    "twentieth": 20,
    "thirtieth": 30,
}

_NUMBER_WORDS = {
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
    "a couple": 2,
    "a few": 3,
}

# Time-of-day windows. "after <anchor>" shifts the window to start at the anchor
# end and run to end of day. Hours are inclusive-start / exclusive-end.
_TIME_WINDOWS: dict[str, tuple[time, time]] = {
    "morning": (time(6), time(12)),
    "lunchtime": (time(11, 30), time(13)),
    "lunch": (time(11, 30), time(13)),
    "midday": (time(11, 30), time(13, 30)),
    "noon": (time(11, 30), time(12, 30)),
    "afternoon": (time(12), time(17)),
    "evening": (time(17), time(23)),
    "tonight": (time(17), time(23, 59)),
    "night": (time(20), time(23, 59)),
    "dinner": (time(17, 30), time(19, 30)),
    "dinnertime": (time(17, 30), time(19, 30)),
    "breakfast": (time(6, 30), time(8, 30)),
    "school": (time(8), time(15)),  # "after school" -> from 15:00
    "work": (time(9), time(17)),
}

# "after <anchor>" — window is (anchor_end, end-of-day).
_AFTER_ANCHORS = {**_TIME_WINDOWS}


@dataclass
class DateResolution:
    """The temporal scope of an utterance.

    ``start`` / ``end`` are an inclusive date range (equal for a single day).
    ``time_start`` / ``time_end`` narrow it to part of the day when the utterance
    said so ("Tuesday evening", "after lunch"). ``kind`` records how it was
    matched; ``text`` is the surface span so the interpreter can strip it before
    matching entities.
    """

    start: date | None = None
    end: date | None = None
    time_start: time | None = None
    time_end: time | None = None
    kind: str = "none"
    text: str = ""
    confidence: float = 0.0
    matched_spans: list[str] = field(default_factory=list)

    @property
    def resolved(self) -> bool:
        return self.start is not None

    @property
    def is_range(self) -> bool:
        return self.start is not None and self.end is not None and self.end != self.start

    def iso_start(self) -> str | None:
        return self.start.isoformat() if self.start else None

    def iso_end(self) -> str | None:
        return self.end.isoformat() if self.end else None


def _next_weekday(anchor: date, weekday: int, *, allow_today: bool = False) -> date:
    delta = (weekday - anchor.weekday()) % 7
    if delta == 0 and not allow_today:
        delta = 7
    return anchor + timedelta(days=delta)


def _this_weekday(anchor: date, weekday: int) -> date:
    """The named weekday within the current Mon–Sun week (may be in the past)."""
    return anchor + timedelta(days=weekday - anchor.weekday())


def _weekend(anchor: date) -> tuple[date, date]:
    """Saturday–Sunday of the coming weekend (this weekend if it hasn't passed)."""
    saturday = _next_weekday(anchor, 5, allow_today=True)
    if anchor.weekday() == 6:  # Sunday — "this weekend" means today
        saturday = anchor - timedelta(days=1)
    return saturday, saturday + timedelta(days=1)


def _time_window(text: str) -> tuple[time | None, time | None, list[str]]:
    """Extract a time-of-day narrowing from ``text`` (already lowercased)."""
    spans: list[str] = []
    # "after lunch" / "after school" / "before dinner"
    after = re.search(r"\bafter (?:the )?(\w+)", text)
    if after and after.group(1) in _AFTER_ANCHORS:
        anchor_end = _AFTER_ANCHORS[after.group(1)][1]
        spans.append(after.group(0))
        return anchor_end, time(23, 59), spans
    before = re.search(r"\bbefore (?:the )?(\w+)", text)
    if before and before.group(1) in _AFTER_ANCHORS:
        anchor_start = _AFTER_ANCHORS[before.group(1)][0]
        spans.append(before.group(0))
        return time(0, 0), anchor_start, spans
    for word, (lo, hi) in _TIME_WINDOWS.items():
        if re.search(rf"\b{word}\b", text):
            spans.append(word)
            return lo, hi, spans
    return None, None, spans


def _explicit_day_of_month(text: str, now: date) -> date | None:
    """'the 14th', 'on the 1st', 'June 3', 'the third'."""
    m = re.search(r"\b(?:the )?(\d{1,2})(?:st|nd|rd|th)\b", text)
    day: int | None = int(m.group(1)) if m else None
    month: int | None = None
    if day is None:
        for word, value in _ORDINALS.items():
            if re.search(rf"\bthe {word}\b", text):
                day = value
                break
    mm = re.search(r"\b(" + "|".join(_MONTHS) + r")\b(?:\s+(\d{1,2}))?", text)
    if mm:
        month = _MONTHS[mm.group(1)]
        if mm.group(2):
            day = int(mm.group(2))
        if day is None:
            day = 1
    if day is None or not (1 <= day <= 31):
        return None
    year = now.year
    target_month = month or now.month
    # If the day-of-month has already passed this month and no month was named,
    # assume next month ("the 3rd" on the 20th).
    try:
        candidate = date(year, target_month, day)
    except ValueError:
        return None
    if month is None and candidate < now:
        target_month += 1
        if target_month > 12:
            target_month, year = 1, year + 1
        try:
            candidate = date(year, target_month, day)
        except ValueError:
            return None
    elif month is not None and candidate < now - timedelta(days=180):
        candidate = date(year + 1, target_month, day)
    return candidate


def resolve_date_expression(text: str, now: datetime) -> DateResolution:
    """Best-effort temporal scope of ``text``. ``kind == "none"`` when nothing matched."""
    lowered = f" {text.lower().strip()} "
    today = now.date()
    ts, te, time_spans = _time_window(lowered)

    def finish(res: DateResolution) -> DateResolution:
        res.time_start = res.time_start or ts
        res.time_end = res.time_end or te
        res.matched_spans = [s for s in [*res.matched_spans, *time_spans] if s]
        res.text = " ".join(res.matched_spans).strip()
        return res

    # --- explicit relative days -------------------------------------------------
    if re.search(r"\bday after tomorrow\b", lowered):
        d = today + timedelta(days=2)
        return finish(
            DateResolution(
                d, d, kind="relative", confidence=0.95, matched_spans=["day after tomorrow"]
            )
        )
    if re.search(r"\btomorrow\b", lowered):
        d = today + timedelta(days=1)
        return finish(
            DateResolution(d, d, kind="relative", confidence=0.97, matched_spans=["tomorrow"])
        )
    if re.search(r"\byesterday\b", lowered):
        d = today - timedelta(days=1)
        return finish(
            DateResolution(d, d, kind="relative", confidence=0.95, matched_spans=["yesterday"])
        )
    if re.search(
        r"\b(today|tonight|this morning|this afternoon|this evening|right now|now)\b", lowered
    ):
        return finish(
            DateResolution(today, today, kind="relative", confidence=0.95, matched_spans=["today"])
        )

    # --- "in N days" ----------------------------------------------------------
    m = re.search(r"\bin (\d+|" + "|".join(_NUMBER_WORDS) + r") days?\b", lowered)
    if m:
        raw = m.group(1)
        n = int(raw) if raw.isdigit() else _NUMBER_WORDS.get(raw, 1)
        d = today + timedelta(days=n)
        return finish(
            DateResolution(
                d, d, kind="relative", confidence=0.85, matched_spans=[m.group(0).strip()]
            )
        )

    # --- weekends -----------------------------------------------------------
    if re.search(r"\b(this |the |coming )?weekend\b", lowered):
        sat, sun = _weekend(today)
        if "next weekend" in lowered:
            sat, sun = sat + timedelta(days=7), sun + timedelta(days=7)
        return finish(
            DateResolution(sat, sun, kind="range", confidence=0.9, matched_spans=["weekend"])
        )

    # --- this/next week & month ------------------------------------------------
    if re.search(r"\bnext week\b", lowered):
        start = today + timedelta(days=7 - today.weekday())
        return finish(
            DateResolution(
                start,
                start + timedelta(days=6),
                kind="range",
                confidence=0.9,
                matched_spans=["next week"],
            )
        )
    if re.search(r"\b(this |the )?week\b", lowered) and not any(w in lowered for w in _WEEKDAYS):
        start = today - timedelta(days=today.weekday())
        return finish(
            DateResolution(
                start,
                start + timedelta(days=6),
                kind="range",
                confidence=0.85,
                matched_spans=["this week"],
            )
        )
    if re.search(r"\bnext month\b", lowered):
        first = (today.replace(day=1) + timedelta(days=32)).replace(day=1)
        last = (first + timedelta(days=32)).replace(day=1) - timedelta(days=1)
        return finish(
            DateResolution(first, last, kind="range", confidence=0.88, matched_spans=["next month"])
        )
    if re.search(r"\bthis month\b", lowered):
        first = today.replace(day=1)
        last = (first + timedelta(days=32)).replace(day=1) - timedelta(days=1)
        return finish(
            DateResolution(first, last, kind="range", confidence=0.85, matched_spans=["this month"])
        )

    # --- named weekday ("Friday", "next Tuesday", "this Wednesday") -----------
    for name, weekday in _WEEKDAYS.items():
        if not re.search(rf"\b{name}\b", lowered):
            continue
        span = name
        if re.search(rf"\bnext {name}\b", lowered):
            # "next <weekday>" = that weekday in the following Mon–Sun week.
            next_week_monday = today - timedelta(days=today.weekday()) + timedelta(days=7)
            d = next_week_monday + timedelta(days=weekday)
            span = f"next {name}"
        elif re.search(rf"\bthis {name}\b", lowered):
            d = _this_weekday(today, weekday)
            span = f"this {name}"
        elif re.search(rf"\blast {name}\b", lowered):
            d = _this_weekday(today, weekday) - timedelta(days=7)
            span = f"last {name}"
        else:
            d = _next_weekday(today, weekday, allow_today=True)
        return finish(DateResolution(d, d, kind="weekday", confidence=0.9, matched_spans=[span]))

    # --- month name alone ("show me June") ----------------------------------
    for name, month in _MONTHS.items():
        if len(name) < 3:
            continue
        if re.search(rf"\b{name}\b", lowered) and not re.search(r"\d", lowered):
            year = now.year if month >= now.month else now.year + 1
            first = date(year, month, 1)
            last = (first + timedelta(days=32)).replace(day=1) - timedelta(days=1)
            return finish(
                DateResolution(first, last, kind="month", confidence=0.8, matched_spans=[name])
            )

    # --- explicit day of month / "June 3" ----------------------------------
    dom = _explicit_day_of_month(lowered, today)
    if dom:
        return finish(
            DateResolution(
                dom,
                dom,
                kind="day",
                confidence=0.8,
                matched_spans=[re.sub(r"\s+", " ", lowered).strip()[:24]],
            )
        )

    # --- nothing temporal, but a time-of-day window was present -------------
    if ts or te:
        return finish(
            DateResolution(today, today, kind="relative", confidence=0.55, matched_spans=["today"])
        )

    return DateResolution(kind="none")
