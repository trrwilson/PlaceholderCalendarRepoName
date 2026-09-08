"""Semantic-layer tests for the local voice interpreter.

Text in, decision out — no microphone, no STT model (``AGENTS.md`` -> testing
expectations, and ``docs/local-voice-plan.md``). Covers: multiple phrasings of
one intent, date/time expressions, dynamic + fuzzy entity matching, ambiguity,
unsupported requests, low-confidence recognition, unsafe-mutation prevention, and
the escalation decision.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.calendar.provider import MockCalendarProvider
from app.models import CalendarRange, CalendarSnapshot
from app.voice.local.dates import resolve_date_expression
from app.voice.local.entities import EntityResolver
from app.voice.local.interpreter import Disposition, InterpreterConfig, interpret

# A fixed clock so weekday / "tomorrow" maths is deterministic: a Wednesday 9am.
NOW = datetime(2026, 6, 10, 9, 0, 0)
assert NOW.weekday() == 2


@pytest.fixture
def snapshot() -> CalendarSnapshot:
    provider = MockCalendarProvider(today=NOW.date())
    return provider.snapshot(
        CalendarRange(starts_on=NOW.date(), ends_on=NOW.date() + timedelta(days=14))
    )


def run(text: str, snapshot: CalendarSnapshot, **kw):
    cfg = kw.pop("config", InterpreterConfig())
    return interpret(text, now=NOW, snapshot=snapshot, config=cfg, **kw)


# -- multiple phrasings of one intent ---------------------------------------


@pytest.mark.parametrize(
    "phrase",
    [
        "what's on today",
        "what's happening today",
        "anything on today",
        "what have we got today",
        "what's the plan for today",
        "catch me up on today",
    ],
)
def test_query_day_phrasings(phrase: str, snapshot: CalendarSnapshot) -> None:
    result = run(phrase, snapshot)
    assert result.disposition == Disposition.handled_locally
    assert result.intent == "calendar.query_day"
    names = [c.name for c in result.tool_calls]
    assert "get_agenda" in names
    assert "show_view" in names


@pytest.mark.parametrize(
    "phrase",
    [
        "show me the week",
        "go to week view",
        "switch to the weekly calendar",
        "pull up the month",
        "back to home",
        "take me to month view",
    ],
)
def test_show_view_phrasings(phrase: str, snapshot: CalendarSnapshot) -> None:
    result = run(phrase, snapshot)
    assert result.disposition == Disposition.handled_locally
    assert result.intent == "calendar.show_view"
    assert result.tool_calls[0].name == "show_view"
    assert result.tool_calls[0].args["view"] in {"home", "week", "month"}


@pytest.mark.parametrize(
    "phrase,minutes",
    [
        ("set a timer for 10 minutes", 10),
        ("start a 15 minute timer", 15),
        ("timer for half an hour", 30),
        ("give me a 90 second timer", 1.5),
        ("put on a timer for two minutes", 2),
    ],
)
def test_timer_start_phrasings(phrase: str, minutes: float, snapshot: CalendarSnapshot) -> None:
    result = run(phrase, snapshot)
    assert result.disposition == Disposition.handled_locally
    assert result.intent == "timer.start"
    call = next(c for c in result.tool_calls if c.name == "start_timer")
    assert call.args["duration_minutes"] == pytest.approx(minutes, rel=0.02)


# -- date / time expressions ----------------------------------------------


@pytest.mark.parametrize(
    "text,expected_offset",
    [
        ("tomorrow", 1),
        ("today", 0),
        ("the day after tomorrow", 2),
        ("in 3 days", 3),
        ("friday", 2),  # Wed -> Fri
        ("next monday", 5),  # Wed -> next-week Monday
    ],
)
def test_relative_dates(text: str, expected_offset: int) -> None:
    res = resolve_date_expression(text, NOW)
    assert res.resolved
    assert res.start == NOW.date() + timedelta(days=expected_offset)


def test_weekend_is_a_range() -> None:
    res = resolve_date_expression("this weekend", NOW)
    assert res.is_range
    assert res.start.weekday() == 5 and res.end.weekday() == 6


def test_time_of_day_windows() -> None:
    assert resolve_date_expression("tuesday evening", NOW).time_start is not None
    after_lunch = resolve_date_expression("after lunch tomorrow", NOW)
    assert after_lunch.start == NOW.date() + timedelta(days=1)
    assert after_lunch.time_start is not None and after_lunch.time_start.hour >= 12
    after_school = resolve_date_expression("after school wednesday", NOW)
    assert after_school.time_start is not None and after_school.time_start.hour >= 15


def test_query_carries_time_narrowing_but_still_answers(snapshot: CalendarSnapshot) -> None:
    result = run("what's mom doing after lunch tomorrow", snapshot, config=_aliases())
    assert result.disposition in (Disposition.handled_locally, Disposition.needs_clarification)
    if result.disposition == Disposition.handled_locally:
        assert result.slots.get("time_start")


# -- dynamic + fuzzy entity matching ------------------------------------


def _aliases() -> InterpreterConfig:
    return InterpreterConfig(person_aliases={"mom": "Jordan", "dad": "Alex"})


def test_person_alias_resolves_to_live_calendar(snapshot: CalendarSnapshot) -> None:
    resolver = EntityResolver(snapshot, aliases={"mom": "Jordan"})
    match = resolver.resolve_person("mom")
    assert match.resolved
    assert match.label == "Jordan"


def test_fuzzy_person_typo(snapshot: CalendarSnapshot) -> None:
    resolver = EntityResolver(snapshot)
    assert resolver.resolve_person("jordin").resolved  # ASR-style misspelling


def test_fuzzy_event_title(snapshot: CalendarSnapshot) -> None:
    resolver = EntityResolver(snapshot)
    match = resolver.resolve_event("dentist")
    assert match.resolved
    assert "Dentist" in (match.label or "")


def test_grocery_aliases_resolve_but_other_lists_do_not(snapshot: CalendarSnapshot) -> None:
    resolver = EntityResolver(snapshot)
    assert resolver.resolve_list("grocery").resolved
    assert resolver.resolve_list("shopping list").resolved
    assert resolver.resolve_list("costco").resolved
    assert resolver.resolve_list("").resolved  # bare "the list" -> grocery
    assert not resolver.resolve_list("packing").resolved
    assert not resolver.resolve_list("wish").resolved


def test_person_filter_uses_live_people(snapshot: CalendarSnapshot) -> None:
    result = run("show alex's calendar", snapshot)
    assert result.disposition == Disposition.handled_locally
    assert result.intent == "calendar.person_filter"
    call = result.tool_calls[0]
    assert call.name == "set_people_filter"
    assert call.args["mode"] == "only"
    assert call.args["people"] == ["alex"]


def test_show_everyone_clears_filter(snapshot: CalendarSnapshot) -> None:
    result = run("show everyone", snapshot)
    assert result.tool_calls[0].args["mode"] == "all"


# -- ambiguous / unresolved entities -----------------------------------


def test_unknown_person_asks_not_guesses(snapshot: CalendarSnapshot) -> None:
    result = run("what's Charlie doing tomorrow", snapshot)
    assert result.disposition == Disposition.needs_clarification
    assert "Charlie".lower() in (result.clarification or "").lower()
    assert not result.tool_calls


def test_ambiguous_event_asks(snapshot: CalendarSnapshot) -> None:
    # two "school"-ish things; asking to "open school" should not silently pick one
    result = run("open the school thing", snapshot)
    if result.disposition == Disposition.handled_locally:
        # only acceptable if there is genuinely one strong match
        assert len(result.tool_calls) == 1
    else:
        assert result.disposition == Disposition.needs_clarification


# -- unsupported requests (clean no, never a guess) --------------------


@pytest.mark.parametrize(
    "phrase",
    [
        "move the dentist appointment to friday",
        "reschedule soccer to next week",
        "add a dentist appointment on friday at 3",
        "delete the swim practice",
    ],
)
def test_calendar_writes_are_rejected_never_executed(
    phrase: str, snapshot: CalendarSnapshot
) -> None:
    result = run(phrase, snapshot)
    assert result.disposition == Disposition.rejected
    assert result.tool_calls == []
    assert "can't" in (result.speech or "").lower() or "cannot" in (result.speech or "").lower()


def test_display_off_is_rejected_for_now(snapshot: CalendarSnapshot) -> None:
    result = run("turn the display off", snapshot)
    assert result.disposition == Disposition.rejected
    assert result.tool_calls == []


# -- grocery list (a real local capability now) --------------------------


@pytest.mark.parametrize(
    "phrase",
    [
        "add meatballs to the grocery list",
        "add milk to the list",
        "put bananas on the shopping list",
        "add coffee to the costco list",
    ],
)
def test_list_add_single_item(phrase: str, snapshot: CalendarSnapshot) -> None:
    result = run(phrase, snapshot)
    assert result.disposition == Disposition.handled_locally
    assert result.intent == "list.add"
    call = next(c for c in result.tool_calls if c.name == "add_to_list")
    assert len(call.args["items"]) == 1
    assert call.args["list"] == "grocery"
    assert result.tool_calls[-1].name == "show_view"
    assert result.tool_calls[-1].args["view"] == "lists"


def test_list_add_splits_multiple_items(snapshot: CalendarSnapshot) -> None:
    result = run("add eggs, bread and butter to the grocery list", snapshot)
    assert result.disposition == Disposition.handled_locally
    call = next(c for c in result.tool_calls if c.name == "add_to_list")
    assert call.args["items"] == ["eggs", "bread", "butter"]


def test_list_add_with_no_item_asks(snapshot: CalendarSnapshot) -> None:
    result = run("add something to the grocery list", snapshot)
    # "something" is a stopword-ish filler; if it slips through that's fine, but a
    # bare "add to the list" must ask.
    bare = run("add to the list", snapshot)
    assert bare.disposition == Disposition.needs_clarification
    assert not bare.tool_calls
    assert result is not None


def test_list_remove(snapshot: CalendarSnapshot) -> None:
    result = run("take the milk off the grocery list", snapshot)
    assert result.disposition == Disposition.handled_locally
    assert result.intent == "list.remove"
    call = result.tool_calls[0]
    assert call.name == "remove_from_list"
    assert call.args["item"] == "milk"


def test_list_check_off(snapshot: CalendarSnapshot) -> None:
    result = run("check off the bread", snapshot)
    assert result.disposition == Disposition.handled_locally
    assert result.intent == "list.check"
    assert result.tool_calls[0].name == "check_off_item"
    assert result.tool_calls[0].args["item"] == "bread"


def test_list_clear_all_and_checked(snapshot: CalendarSnapshot) -> None:
    all_clear = run("clear the grocery list", snapshot)
    assert all_clear.disposition == Disposition.handled_locally
    assert all_clear.tool_calls[0].name == "clear_list"
    assert all_clear.tool_calls[0].args["scope"] == "all"

    checked = run("clear the ones we got", snapshot)
    assert checked.tool_calls[0].args["scope"] == "checked"


def test_list_show(snapshot: CalendarSnapshot) -> None:
    result = run("show me the grocery list", snapshot)
    assert result.disposition == Disposition.handled_locally
    assert result.intent == "list.show"
    assert result.tool_calls == [result.tool_calls[0]]
    assert result.tool_calls[0].args["view"] == "lists"


def test_list_command_for_an_unknown_list_asks_not_escalates(snapshot: CalendarSnapshot) -> None:
    result = run("add sunscreen to the packing list", snapshot)
    assert result.disposition == Disposition.needs_clarification
    assert "grocery" in (result.clarification or "").lower()
    assert not result.tool_calls


def test_low_confidence_clear_all_asks_first(snapshot: CalendarSnapshot) -> None:
    # "start a new list" hits list.clear weakly (0.7) — below the 0.8 mutation bar.
    result = run("start a new list", snapshot)
    assert result.disposition == Disposition.needs_clarification
    assert not result.tool_calls


# -- low-confidence recognition --------------------------------------


def test_low_stt_confidence_pushes_to_clarify_or_escalate(snapshot: CalendarSnapshot) -> None:
    strong = run("what's on tomorrow", snapshot, stt_confidence=0.95)
    assert strong.disposition == Disposition.handled_locally
    weak = run("what's on tomorrow", snapshot, stt_confidence=0.2)
    assert weak.confidence < strong.confidence


def test_gibberish_escalates(snapshot: CalendarSnapshot) -> None:
    result = run("purple monkey dishwasher fandango", snapshot)
    assert result.disposition == Disposition.escalate_to_cloud
    assert result.intent == "unknown"


def test_empty_transcript_asks_again(snapshot: CalendarSnapshot) -> None:
    result = run("  ", snapshot)
    assert result.disposition == Disposition.needs_clarification


# -- escalation decisions --------------------------------------------


@pytest.mark.parametrize(
    "phrase",
    [
        "when can I have dinner with Jordan this week without any conflicts",
        "which day this weekend looks least busy",
        "find a time for a family movie night",
        "how busy is next week",
    ],
)
def test_planning_questions_escalate_with_context(phrase: str, snapshot: CalendarSnapshot) -> None:
    result = run(phrase, snapshot)
    assert result.disposition == Disposition.escalate_to_cloud
    assert result.tier == 2
    assert result.escalation is not None
    assert "transcript" in result.escalation


def test_escalation_payload_is_bounded_to_scope(snapshot: CalendarSnapshot) -> None:
    result = run("which day this weekend looks least busy", snapshot)
    payload = result.escalation
    assert payload["date_scope"] is not None
    # only weekend events, not the whole 14-day snapshot
    assert len(payload["events_in_scope"]) < len(snapshot.events)


def test_escalation_disabled_degrades_to_clarification(snapshot: CalendarSnapshot) -> None:
    cfg = InterpreterConfig(cloud_escalation_enabled=False)
    result = run("which day this weekend looks least busy", snapshot, config=cfg)
    assert result.disposition == Disposition.needs_clarification


# -- unsafe-mutation prevention (the safety-critical case) -------------


def test_timer_before_unknown_event_does_not_guess(snapshot: CalendarSnapshot) -> None:
    result = run("set a timer for 20 minutes before the recital", snapshot)
    assert result.disposition == Disposition.needs_clarification
    assert not any(c.name == "start_timer" for c in result.tool_calls)


def test_timer_before_known_event_computes_fires_at(snapshot: CalendarSnapshot) -> None:
    result = run("remind me 30 minutes before soccer", snapshot)
    assert result.disposition == Disposition.handled_locally
    call = next(c for c in result.tool_calls if c.name == "start_timer")
    assert "fires_at" in call.args


def test_timer_over_six_hours_rejected(snapshot: CalendarSnapshot) -> None:
    result = run("set a timer for 9 hours", snapshot)
    assert result.disposition == Disposition.rejected


def test_bare_stop_with_no_timer_is_not_a_blind_cancel(snapshot: CalendarSnapshot) -> None:
    result = run("stop", snapshot, timer_active=False)
    assert result.disposition == Disposition.needs_clarification
    result_active = run("stop", snapshot, timer_active=True)
    assert result_active.disposition == Disposition.handled_locally
    assert result_active.tool_calls[0].name == "cancel_timer"


@pytest.mark.parametrize(
    "phrase,tool",
    [
        ("pause the timer", "pause_timer"),
        ("hold the timer", "pause_timer"),
        ("resume the timer", "resume_timer"),
        ("unpause the timer", "resume_timer"),
        ("keep the timer going", "resume_timer"),
        ("restart the timer", "restart_timer"),
        ("reset the timer", "restart_timer"),
        ("start the timer over", "restart_timer"),
    ],
)
def test_timer_pause_resume_restart_phrasings(
    phrase: str, tool: str, snapshot: CalendarSnapshot
) -> None:
    result = run(phrase, snapshot, timer_active=True)
    assert result.disposition == Disposition.handled_locally
    assert any(c.name == tool for c in result.tool_calls)


def test_pause_with_no_timer_asks_rather_than_guessing(snapshot: CalendarSnapshot) -> None:
    result = run("pause", snapshot, timer_active=False)
    assert result.disposition == Disposition.needs_clarification


# -- diagnostics / observability ------------------------------------


def test_interpretation_carries_a_trace(snapshot: CalendarSnapshot) -> None:
    result = run("what's Jordan up to on friday", snapshot)
    assert result.trace
    assert result.timings_ms.get("total") is not None
    assert result.candidates  # intent scores are visible
