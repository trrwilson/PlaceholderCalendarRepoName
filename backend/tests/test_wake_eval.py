"""The wake-word evaluation maths (``scripts/wake_eval.py``).

Pure functions — no audio, no models, no optional deps — so the statistics that
the bake-off leans on are actually checked. The detector runtimes and the real
corpus are exercised on hardware via ``scripts/benchmark_wake.py``, not here.
"""

from __future__ import annotations

import json
from pathlib import Path

from scripts.wake_eval import (
    ClipOutcome,
    DetectorRun,
    Manifest,
    ManifestEntry,
    diff_runs,
    mcnemar_exact,
    operating_point_for_fa,
    threshold_sweep,
    verify_manifest,
    wilson_ci,
)

# -- Wilson CI --------------------------------------------------------


def test_wilson_ci_matches_known_values() -> None:
    lo, hi = wilson_ci(9, 10)
    assert round(lo, 3) == 0.596
    assert round(hi, 3) == 0.982


def test_wilson_ci_never_leaves_the_unit_interval_at_the_extremes() -> None:
    assert wilson_ci(0, 5)[0] == 0.0
    assert wilson_ci(5, 5)[1] == 1.0
    assert wilson_ci(0, 0) == (0.0, 1.0)


def test_wilson_ci_tightens_as_n_grows() -> None:
    narrow = wilson_ci(90, 100)
    wide = wilson_ci(9, 10)
    assert (narrow[1] - narrow[0]) < (wide[1] - wide[0])


# -- McNemar ---------------------------------------------------------


def test_mcnemar_no_discordant_pairs_is_p1() -> None:
    a = {"x": True, "y": False, "z": True}
    result = mcnemar_exact(a, dict(a))
    assert result.p_value == 1.0
    assert result.n_discordant == 0
    assert not result.significant


def test_mcnemar_all_discordant_one_direction_is_significant() -> None:
    before = {f"c{i}": False for i in range(8)}
    after = {f"c{i}": True for i in range(8)}
    result = mcnemar_exact(before, after)
    assert result.b == 0 and result.c == 8
    assert result.p_value < 0.05
    assert result.significant


def test_mcnemar_small_symmetric_split_is_not_significant() -> None:
    first = {"a": True, "b": True, "c": False, "d": False}
    second = {"a": False, "b": True, "c": True, "d": False}
    result = mcnemar_exact(first, second)
    assert result.b == 1 and result.c == 1
    assert result.p_value == 1.0


def test_mcnemar_only_considers_shared_clips() -> None:
    first = {"a": True, "only_first": True}
    second = {"a": True, "only_second": False}
    assert mcnemar_exact(first, second).n_discordant == 0


# -- threshold sweep ----------------------------------------------


def test_threshold_sweep_is_monotone() -> None:
    pos = [0.1, 0.4, 0.6, 0.95]
    neg = [0.02, 0.03, 0.5]
    sweep = threshold_sweep(pos, neg, [0.2, 0.5, 0.9])
    recalls = [row["recall"] for row in sweep]
    fas = [row["hard_neg_fa"] for row in sweep]
    assert recalls == sorted(recalls, reverse=True)
    assert fas == sorted(fas, reverse=True)
    assert sweep[0]["recall"] == 0.75  # 0.4, 0.6, 0.95 clear 0.2


def test_operating_point_picks_lowest_threshold_clearing_the_fa_bar() -> None:
    pos = [0.3, 0.5, 0.7, 0.9]
    neg = [0.1, 0.45]
    sweep = threshold_sweep(pos, neg, [0.2, 0.4, 0.5, 0.8])
    op = operating_point_for_fa(sweep, 0.0)
    assert op["threshold"] == 0.5  # 0.2/0.4 still admit the 0.45 negative
    assert op["recall"] == 0.75  # 0.5, 0.7, 0.9 clear 0.5
    assert operating_point_for_fa(threshold_sweep(pos, [0.99], [0.2]), 0.0) is None


# -- DetectorRun aggregation + round trip -----------------------


def _run(name: str, outcomes: list[tuple[str, str, bool]]) -> DetectorRun:
    run = DetectorRun(name=name)
    for clip, label, fired in outcomes:
        run.clips.append(ClipOutcome(clip=clip, label=label, fired=fired, tag="clean"))
    return run


def test_detector_run_rates_and_json_round_trip() -> None:
    run = _run(
        "x",
        [("p1", "positive", True), ("p2", "positive", False), ("n1", "negative", False)],
    )
    assert run.recall() == (1, 2)
    assert run.false_accepts() == (0, 1)
    restored = DetectorRun.from_json(run.to_json())
    assert restored.recall() == (1, 2)
    assert restored.fire_map("positive") == {"p1": True, "p2": False}


def test_recall_by_tag_groups_positives() -> None:
    run = DetectorRun(name="x")
    run.clips = [
        ClipOutcome("a", "positive", True, tag="clean"),
        ClipOutcome("b", "positive", False, tag="snr6"),
        ClipOutcome("c", "positive", True, tag="snr6"),
    ]
    assert run.recall_by_tag() == {"clean": (1, 1), "snr6": (1, 2)}


# -- run-over-run diff -------------------------------------------


def test_diff_runs_flags_a_real_recall_improvement() -> None:
    base = _run("oww", [(f"p{i}", "positive", i < 3) for i in range(10)])
    better = _run("oww", [(f"p{i}", "positive", True) for i in range(10)])
    d = diff_runs(base, better)
    assert d["recall"]["before"] == "3/10"
    assert d["recall"]["after"] == "10/10"
    assert d["recall"]["newly_detected"] == ["p3", "p4", "p5", "p6", "p7", "p8", "p9"]
    assert d["recall"]["significant"] is True


def test_diff_runs_is_quiet_on_noise_sized_changes() -> None:
    base = _run("oww", [(f"p{i}", "positive", i != 0) for i in range(10)])
    same = _run("oww", [(f"p{i}", "positive", i != 1) for i in range(10)])
    d = diff_runs(base, same)
    assert d["recall"]["significant"] is False


# -- manifest verification -------------------------------------


def test_verify_manifest_reports_missing_and_drifted(tmp_path) -> None:
    good = tmp_path / "good.wav"
    good.write_bytes(b"RIFFdata")
    drifted = tmp_path / "drift.wav"
    drifted.write_bytes(b"original")
    from scripts.wake_eval import sha256_file

    manifest = Manifest(
        spec_seed=1,
        engine="test",
        generated_at="now",
        entries=[
            ManifestEntry("good.wav", "positive", "Mission Control", "clean", sha256_file(good)),
            ManifestEntry("drift.wav", "negative", "x", "clean", sha256_file(drifted)),
            ManifestEntry("gone.wav", "positive", "x", "clean", "0" * 64),
        ],
    )
    drifted.write_bytes(b"changed!")
    problems = verify_manifest(manifest, tmp_path)
    assert any("missing: gone.wav" in p for p in problems)
    assert any("changed since manifest: drift.wav" in p for p in problems)
    assert not any("good.wav" in p for p in problems)


def test_manifest_json_round_trip(tmp_path) -> None:
    manifest = Manifest(
        spec_seed=42,
        engine="azure-tts",
        generated_at="2026-09-08T00:00:00+00:00",
        entries=[
            ManifestEntry(
                "pos_000.wav",
                "positive",
                "Mission Control",
                "snr6",
                "a" * 64,
                seconds=1.1,
                speaker="en-US-AriaNeural",
                rate=0.0,
                snr_db=6.0,
            ),
        ],
        keyword="mission_control",
        phrase="Mission Control",
        profile="coarse",
    )
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest.to_json()))
    back = Manifest.load(path)
    assert back.spec_seed == 42
    assert back.keyword == "mission_control"
    assert back.phrase == "Mission Control"
    assert back.profile == "coarse"
    assert back.entries[0].snr_db == 6.0
    assert back.entries[0].speaker == "en-US-AriaNeural"


# -- keyword specs are well-formed --------------------------------


def test_wake_corpus_specs_are_valid() -> None:
    """Every tests/data/wake_corpus/<slug>.json + the shared _voices.json parse
    and have the shape gen_wake_corpus.py expects."""
    spec_dir = Path(__file__).resolve().parents[1] / "tests" / "data" / "wake_corpus"
    shared = json.loads((spec_dir / "_voices.json").read_text())
    assert set(shared["profiles"]) == {"smoke", "coarse", "full"}
    required = {"voices", "positives_limit", "negatives_limit", "rates_pct", "snr_db"}
    for prof in shared["profiles"].values():
        assert required <= prof.keys()
    assert len(shared["azure_voices"]) >= shared["profiles"]["full"]["voices"]

    slugs = [p.stem for p in spec_dir.glob("*.json") if not p.stem.startswith("_")]
    assert "mission_control" in slugs
    for slug in slugs:
        spec = json.loads((spec_dir / f"{slug}.json").read_text())
        assert spec["slug"] == slug
        assert spec["phrase"] and spec["positives"] and spec["negatives_confusable"]
        assert spec["positives"][0].lower() == spec["phrase"].lower()  # bare phrase first
