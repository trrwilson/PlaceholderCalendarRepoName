"""Pure-Python evaluation math for the wake-word bake-off.

Kept separate from ``benchmark_wake.py`` (which needs numpy + the two detector
runtimes) so the statistics can be unit-tested in CI with nothing installed.

Everything here operates on **per-clip fire outcomes** — a detector either fired
on a clip or it did not — plus, for openWakeWord, a peak score per clip. From
those it produces:

* Wilson score confidence intervals on recall / false-accept rate,
* an exact-binomial McNemar test for *paired* comparisons (detector vs detector,
  or one detector's old model vs its new model on the same clips),
* an openWakeWord threshold sweep (recall / hard-negative FA vs threshold),
* a per-condition (manifest ``tag``) breakdown,
* a diff against a previously saved run.

See ``docs/wake-word-provider-bakeoff.md`` for how the numbers are meant to be
read and what they still do not establish.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

Z95 = 1.959963984540054  # standard normal 97.5th percentile


# -- confidence intervals -------------------------------------------------


def wilson_ci(hits: int, n: int, z: float = Z95) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion ``hits / n``.

    Better than the normal approximation at the extremes (0/N, N/N) and for
    small N — which is exactly the regime the wake corpus lives in.
    """
    if n == 0:
        return (0.0, 1.0)
    p = hits / n
    z2 = z * z
    denom = 1.0 + z2 / n
    centre = (p + z2 / (2 * n)) / denom
    half = (z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def _binom_sf_leq(k: int, n: int, p: float = 0.5) -> float:
    """P(X <= k) for X ~ Binomial(n, p), summed directly (n is tiny here)."""
    return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(0, k + 1))


@dataclass
class McNemar:
    b: int  # first fired, second did not
    c: int  # second fired, first did not
    p_value: float
    n_discordant: int

    @property
    def significant(self) -> bool:
        return self.p_value < 0.05


def mcnemar_exact(
    first: dict[str, bool], second: dict[str, bool]
) -> McNemar:
    """Two-sided exact-binomial McNemar over clips present in *both* maps.

    ``first`` / ``second`` map clip name -> fired?. Only the discordant pairs
    carry information; with none, the result is p = 1 (the two are
    indistinguishable on this corpus, which is itself the finding when the
    corpus is small).
    """
    shared = first.keys() & second.keys()
    b = sum(1 for k in shared if first[k] and not second[k])
    c = sum(1 for k in shared if second[k] and not first[k])
    nd = b + c
    if nd == 0:
        return McNemar(b, c, 1.0, 0)
    p = min(1.0, 2.0 * _binom_sf_leq(min(b, c), nd, 0.5))
    return McNemar(b, c, p, nd)


# -- one detector's run over the corpus ---------------------------------


@dataclass
class ClipOutcome:
    clip: str
    label: str  # "positive" | "negative"
    fired: bool
    fired_at: float | None = None
    peak: float | None = None  # openWakeWord only
    tag: str = ""  # manifest condition tag, "" when unknown


@dataclass
class DetectorRun:
    """Everything one detector (at one threshold) did over the corpus."""

    name: str
    threshold: float | None = None
    clips: list[ClipOutcome] = field(default_factory=list)

    # -- basic rates --

    def _by_label(self, label: str) -> list[ClipOutcome]:
        return [c for c in self.clips if c.label == label]

    def recall(self) -> tuple[int, int]:
        pos = self._by_label("positive")
        return sum(1 for c in pos if c.fired), len(pos)

    def false_accepts(self) -> tuple[int, int]:
        neg = self._by_label("negative")
        return sum(1 for c in neg if c.fired), len(neg)

    def latency_s(self) -> dict[str, float] | None:
        lat = sorted(c.fired_at for c in self.clips if c.label == "positive" and c.fired_at)
        if not lat:
            return None
        return {
            "median": round(lat[len(lat) // 2], 3),
            "min": round(lat[0], 3),
            "max": round(lat[-1], 3),
        }

    # -- per-condition --

    def recall_by_tag(self) -> dict[str, tuple[int, int]]:
        buckets: dict[str, list[bool]] = defaultdict(list)
        for c in self._by_label("positive"):
            buckets[c.tag or "(untagged)"].append(c.fired)
        return {tag: (sum(v), len(v)) for tag, v in sorted(buckets.items())}

    # -- paired outcome maps (for McNemar) --

    def fire_map(self, label: str) -> dict[str, bool]:
        return {c.clip: c.fired for c in self.clips if c.label == label}

    # -- serialisation --

    def to_json(self) -> dict:
        rh, rn = self.recall()
        fh, fn = self.false_accepts()
        return {
            "name": self.name,
            "threshold": self.threshold,
            "recall": {
                "hits": rh,
                "n": rn,
                "rate": round(rh / rn, 4) if rn else None,
                "ci95": [round(x, 4) for x in wilson_ci(rh, rn)],
            },
            "false_accepts": {
                "hits": fh,
                "n": fn,
                "rate": round(fh / fn, 4) if fn else None,
                "ci95": [round(x, 4) for x in wilson_ci(fh, fn)],
            },
            "latency_s": self.latency_s(),
            "recall_by_tag": {
                tag: {"hits": h, "n": n} for tag, (h, n) in self.recall_by_tag().items()
            },
            "clips": {
                c.clip: {
                    "label": c.label,
                    "fired": c.fired,
                    "fired_at": c.fired_at,
                    "peak": c.peak,
                    "tag": c.tag,
                }
                for c in self.clips
            },
        }

    @classmethod
    def from_json(cls, blob: dict) -> DetectorRun:
        run = cls(name=blob["name"], threshold=blob.get("threshold"))
        for clip, d in blob.get("clips", {}).items():
            run.clips.append(
                ClipOutcome(
                    clip=clip,
                    label=d["label"],
                    fired=d["fired"],
                    fired_at=d.get("fired_at"),
                    peak=d.get("peak"),
                    tag=d.get("tag", ""),
                )
            )
        return run


# -- openWakeWord threshold sweep -------------------------------------


def threshold_sweep(
    pos_peaks: list[float], neg_peaks: list[float], grid: list[float]
) -> list[dict]:
    """Recall and hard-negative FA rate at each threshold in ``grid``.

    A clip "fires" at threshold t if its peak score >= t. This is the whole
    point of openWakeWord being score-based: you can pick the operating point
    after the fact. Azure's ``.table`` cannot do this — it only ever reports a
    single binary decision.
    """
    out = []
    for t in sorted(grid):
        rec = sum(1 for p in pos_peaks if p >= t)
        fa = sum(1 for p in neg_peaks if p >= t)
        out.append(
            {
                "threshold": round(t, 4),
                "recall": round(rec / len(pos_peaks), 4) if pos_peaks else None,
                "recall_hits": rec,
                "hard_neg_fa": round(fa / len(neg_peaks), 4) if neg_peaks else None,
                "hard_neg_fa_hits": fa,
            }
        )
    return out


def operating_point_for_fa(sweep: list[dict], max_fa_rate: float) -> dict | None:
    """Lowest threshold in the sweep whose hard-negative FA rate <= target.

    Lowest (not highest) because among thresholds that clear the FA bar you
    want the one that keeps the most recall.
    """
    ok = [row for row in sweep if (row["hard_neg_fa"] or 0.0) <= max_fa_rate]
    return min(ok, key=lambda r: r["threshold"]) if ok else None


# -- corpus manifest --------------------------------------------------


@dataclass
class ManifestEntry:
    file: str
    label: str  # "positive" | "negative"
    phrase: str
    tag: str
    sha256: str
    seconds: float | None = None
    speaker: str | None = None
    rate: float | None = None
    snr_db: float | None = None


@dataclass
class Manifest:
    spec_seed: int | None
    engine: str
    generated_at: str
    entries: list[ManifestEntry]
    keyword: str | None = None
    phrase: str | None = None
    profile: str | None = None

    def by_label(self, label: str) -> list[ManifestEntry]:
        return [e for e in self.entries if e.label == label]

    @classmethod
    def load(cls, path: Path) -> Manifest:
        blob = json.loads(Path(path).read_text())
        return cls(
            spec_seed=blob.get("spec_seed"),
            engine=blob.get("engine", "?"),
            generated_at=blob.get("generated_at", "?"),
            entries=[ManifestEntry(**e) for e in blob["entries"]],
            keyword=blob.get("keyword"),
            phrase=blob.get("phrase"),
            profile=blob.get("profile"),
        )

    def to_json(self) -> dict:
        out = {
            "spec_seed": self.spec_seed,
            "engine": self.engine,
            "generated_at": self.generated_at,
        }
        for k in ("keyword", "phrase", "profile"):
            if getattr(self, k) is not None:
                out[k] = getattr(self, k)
        out["entries"] = [
            {k: v for k, v in vars(e).items() if v is not None} for e in self.entries
        ]
        return out


def sha256_file(path: Path, _chunk: int = 1 << 20) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(_chunk), b""):
            h.update(block)
    return h.hexdigest()


def verify_manifest(manifest: Manifest, audio_dir: Path) -> list[str]:
    """Return a list of human-readable problems: missing files or checksum drift.

    An empty list means the audio on disk is byte-identical to what the
    manifest recorded — the precondition for comparing two model versions and
    trusting that only the model changed.
    """
    problems: list[str] = []
    for e in manifest.entries:
        p = audio_dir / e.file
        if not p.exists():
            problems.append(f"missing: {e.file}")
            continue
        if e.sha256 and sha256_file(p) != e.sha256:
            problems.append(f"changed since manifest: {e.file}")
    return problems


# -- run-over-run diff ----------------------------------------------


def diff_runs(baseline: DetectorRun, current: DetectorRun) -> dict:
    """Compare the same detector across two saved runs (e.g. model v1 vs v2).

    Paired on clip name. McNemar on the positives answers "did recall really
    move?"; on the negatives, "did false accepts really move?".
    """
    rec = mcnemar_exact(baseline.fire_map("positive"), current.fire_map("positive"))
    fa = mcnemar_exact(baseline.fire_map("negative"), current.fire_map("negative"))
    b_rh, b_rn = baseline.recall()
    c_rh, c_rn = current.recall()
    b_fh, b_fn = baseline.false_accepts()
    c_fh, c_fn = current.false_accepts()
    return {
        "detector": current.name,
        "recall": {
            "before": f"{b_rh}/{b_rn}",
            "after": f"{c_rh}/{c_rn}",
            "delta_rate": round(
                (c_rh / c_rn if c_rn else 0) - (b_rh / b_rn if b_rn else 0), 4
            ),
            "newly_detected": sorted(
                k
                for k, v in current.fire_map("positive").items()
                if v and not baseline.fire_map("positive").get(k, False)
            ),
            "newly_missed": sorted(
                k
                for k, v in current.fire_map("positive").items()
                if not v and baseline.fire_map("positive").get(k, False)
            ),
            "mcnemar_p": round(rec.p_value, 4),
            "significant": rec.significant,
        },
        "false_accepts": {
            "before": f"{b_fh}/{b_fn}",
            "after": f"{c_fh}/{c_fn}",
            "delta_rate": round(
                (c_fh / c_fn if c_fn else 0) - (b_fh / b_fn if b_fn else 0), 4
            ),
            "mcnemar_p": round(fa.p_value, 4),
            "significant": fa.significant,
        },
    }


# -- text report ----------------------------------------------------


def _rate(hits: int, n: int) -> str:
    return f"{hits}/{n} = {hits / n:.0%}" if n else f"{hits}/{n} = -"


def format_run(run: DetectorRun) -> str:
    rh, rn = run.recall()
    fh, fn = run.false_accepts()
    rlo, rhi = wilson_ci(rh, rn)
    flo, fhi = wilson_ci(fh, fn)
    head = run.name + (f" (threshold {run.threshold})" if run.threshold is not None else "")
    lines = [
        head,
        f"  recall:            {_rate(rh, rn)}"
        + (f"   95% CI [{rlo:.0%}, {rhi:.0%}]" if rn else ""),
        f"  hard-neg FA:       {_rate(fh, fn)}"
        + (f"   95% CI [{flo:.0%}, {fhi:.0%}]" if fn else ""),
    ]
    lat = run.latency_s()
    if lat:
        lines.append(
            f"  fired at:          median {lat['median']:.2f}s "
            f"(min {lat['min']:.2f}, max {lat['max']:.2f})"
        )
    by_tag = run.recall_by_tag()
    if len(by_tag) > 1:
        lines.append("  recall by condition:")
        for tag, (h, n) in by_tag.items():
            lines.append(f"    {tag:28} {_rate(h, n)}")
    missed = [c.clip for c in run.clips if c.label == "positive" and not c.fired]
    fa_clips = [c.clip for c in run.clips if c.label == "negative" and c.fired]
    if missed:
        lines.append(f"  missed:            {', '.join(missed)}")
    if fa_clips:
        lines.append(f"  false accepts:     {', '.join(fa_clips)}")
    return "\n".join(lines)


def format_pair_comparison(a: DetectorRun, b: DetectorRun) -> str:
    """Head-to-head McNemar between two detectors on the same corpus."""
    pos = mcnemar_exact(a.fire_map("positive"), b.fire_map("positive"))
    neg = mcnemar_exact(a.fire_map("negative"), b.fire_map("negative"))
    lines = [f"{a.name}  vs  {b.name}   (paired, same clips)"]
    if pos.n_discordant == 0:
        lines.append("  recall: identical on every positive clip - no measurable difference")
    else:
        lines.append(
            f"  recall: {a.name} +{pos.b} / {b.name} +{pos.c} discordant, "
            f"McNemar p = {pos.p_value:.3f}"
            + ("  *significant*" if pos.significant else "  (not significant)")
        )
    if neg.n_discordant == 0:
        lines.append("  false accepts: identical on every negative clip")
    else:
        lines.append(
            f"  false accepts: {a.name} +{neg.b} / {b.name} +{neg.c} discordant, "
            f"McNemar p = {neg.p_value:.3f}"
        )
    return "\n".join(lines)
