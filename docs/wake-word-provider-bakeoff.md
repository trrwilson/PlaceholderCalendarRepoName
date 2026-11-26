---
status: historical
summary: openWakeWord vs Azure .table, the Invoke gate, and the recall-eval harness.
---

# Wake-word provider bake-off

Two ways to spot "Mission Control", swappable at runtime — the activation-side
analogue of the voice-provider bake-off (`docs/voice-provider-bakeoff-plan.md`).
The choice is orthogonal to which conversational provider then handles the turn.

| | `openwakeword` (default) | `azure` |
| --- | --- | --- |
| Where it runs | Kiosk browser | Backend (`app/voice/wake_azure.py`) |
| Model | `frontend/public/models/wake/mission_control.onnx` (+ shared feature models) | `frontend/public/models/wake/azure_mission_control_basic_med.table` (Azure Speech Studio custom keyword, basic, medium) |
| Runtime | `onnxruntime-web`, lazy-loaded | native Speech SDK — `pip install -e 'backend[azure-wake]'` |
| Audio path when idle | never leaves the browser | streamed to the backend over `WS /api/voice/wake/azure` (localhost / LAN) — spotting itself is still on-device, no Azure key, no network |
| Degrades to push-to-talk when | ONNX assets or `onnxruntime-web` missing | SDK not installed, `.table` missing, or the socket is refused |

## The on-device Invoke gate (additive — not a provider)

Independent of which of the two providers is selected, the **Invoke gate** can be
layered *in front* of it. It is the recipient side of the on-device gate
prototype in the ReInvoke2026 repo (`wakeword/`): the `invoke-gate` daemon on the
Harman Kardon Invoke runs a deliberately loose first stage (`--kws shape`) and
only streams real room audio after a candidate. The selected provider
(openWakeWord **or** Azure) then re-checks that gated audio, and an activation
happens **only when the gate window *and* the selected detector both accept**
(resolution 3 in `wakeword/FIRST_STAGE_WAKEWORD_INVESTIGATION.md` — the gate is
loose by design). A gate candidate the detector does not confirm before the gate
closes is a gate false accept and produces nothing.

- **Off by default** — `MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_ENABLED`, Settings →
  "On-device audio gate", or `PUT /api/voice/wake-config {"invoke_gate_enabled": true}`
  (a process-memory override, resolved by `effective_invoke_gate_enabled`).
- Needs `MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_HOST` (the Invoke's LAN IP); until
  that is set the toggle is hidden (`invoke_gate_configured: false`).
- On ⇒ the kiosk opens `WS /api/voice/wake/invoke` (the backend bridges it to the
  daemon's control socket), tells the daemon to gate its egress
  (`gate_enabled:true`), and `GatedWakeDetector` wraps the selected detector.
  Idle room audio never leaves the Invoke.
- Off ⇒ the selected detector runs on the continuous mic feed exactly as before.
- Degrades to push-to-talk when the host is unset or the control socket is refused.
- Run the device side with `wakeword/harness/invoke_gate.sh up|down|status`. See
  `wakeword/MC_INTEGRATION.md` and `wakeword/RUN_END_TO_END.md`.

## Why the split

The JavaScript Speech SDK cannot load a `.table` — `KeywordRecognitionModel.fromFile`
/ `fromStream` are unimplemented stubs and there is no `KeywordRecognizer` in the
JS package. Only the native SDK (`azure-cognitiveservices-speech`,
`KeywordRecognizer` + `KeywordRecognitionModel`) does offline `.table` spotting.
So `azure` runs on the backend and the kiosk streams it mic audio, reusing the
relay shape of the Azure voice contestants.

## Selection

- Default: `MISSION_CONTROL_WAKE_WORD_PROVIDER` (`openwakeword` | `azure`).
- Runtime: Settings → "Keyword provider", or `PUT /api/voice/wake-config`
  `{"provider": "azure"}` — a process-memory override (reverts on restart),
  resolved by `app/voice/wake.py::effective_wake_provider` exactly like the voice
  provider override. `GET /api/voice/wake-config` returns the active provider and
  the selectable list (`configured: false` for `azure` until the SDK + `.table`
  are in place).
- The Invoke gate (above) is a **separate** toggle, `invoke_gate_enabled`, that
  applies on top of whichever provider is selected.

## Wire protocol — `WS /api/voice/wake/azure`

LAN-gated (`_is_local_client`); closes `4404` unless wake + voice are on and the
`azure` provider is actually available. JSON text frames:

- kiosk → backend: `{"type":"audio","pcm":"<base64 PCM16 16 kHz mono>"}`,
  `{"type":"suspend"}` (a turn is running — stop feeding the recogniser),
  `{"type":"resume"}`.
- backend → kiosk: `{"type":"wake","score":1.0}` on a detection,
  `{"type":"error","message":...}`, `{"type":"closing"}`.

The frontend still owns the post-fire cooldown and the pre-roll buffer
(`WakePreroll`), identical to `openwakeword`, so `useWakeWord` / `useVoiceSession`
drive both detectors the same way.

## Wire protocol — `WS /api/voice/wake/invoke`

Same LAN gate. The backend bridge (`app/voice/wake_invoke.py`) opens a TCP
connection to the daemon's control socket and relays it verbatim:

- device → kiosk: `hello` / `wake` / `state` / `preroll` / `vad` / `closing` /
  `heartbeat` / `error` frames (see `wakeword/PROTOCOL.md`), forwarded as text.
- kiosk → device: `{"cmd": ...}` — allow-list `ptt_start` / `ptt_stop` / `hold` /
  `done` / `set` / `gate_enabled` / `keepalive`.

The daemon's **audio** socket (`:5004`) is not touched by the backend — that PCM
reaches the kiosk over VB-CABLE and the kiosk reads it from the microphone as
today (`useAudioInput` `auto` already prefers a VB-CABLE input).
`GatedWakeDetector` (`frontend/src/voice/wake/gatedDetector.ts`) wraps the
selected base detector (openWakeWord / Azure): `state:open` / `preroll` →
`base.resume({resetCooldown:false})`; base `onWake` while verifying → forward;
`state:off` before that → drop. `endActivation()` sends `{cmd:"done"}` at turn
end; the Ask button sends `ptt_start` / `ptt_stop`; a `hold` lease keeps the gate
open through the reply for barge-in.

## Evaluating

Both surface the same diagnostics in Settings (state, last score, last
wake→listening latency). Compare on: false accepts per hour of ambient household
noise, miss rate at a normal speaking distance/volume, and wake→listening
latency. `azure` adds a network hop (localhost) and the SDK's own buffering;
`openwakeword` adds ONNX inference on the UI thread. Neither sends audio off the
machine while idle.

## Do we have enough data to say which detector is "better"? (2026-09-08)

**No — not yet, for a semi-rigorous claim.** There is a working smoke test, but
the corpus behind it is small, single-condition, partly in a form only one
detector can read, and not frozen for version-over-version comparison. The
tooling to close that gap is now in the repo (below); the data collection is the
remaining work and some of it needs the kiosk mic.

`benchmark_wake` also reports an `invoke_gate` row: the selected detector's
re-check (openWakeWord here) over each clip trimmed to
`[speech_onset − --gate-preroll-ms, end]`, with the model reset at that OFF→OPEN
edge — an approximation of the gate handoff (no device, no `mock_invoke_gate`
in the loop), so read it as "does the detector still fire on the gated
window?", not a device number.

### What the smoke test showed (2026-09-07)

`python -m scripts.benchmark_wake` ran both back ends over the real audio on
disk: **10 positives** (`backend/voice-captures/` — real kiosk activations) and
**35 hard negatives** (`backend/voice-samples/` — real spoken commands, no wake
phrase). Both dirs are git-ignored, provisioned per install.

| | openWakeWord (`mission_control.onnx`) | Azure (`…basic_med.table`) |
| --- | --- | --- |
| Recall | **9/10** (thresholds 0.3 and 0.5 identical) | **9/10** |
| Hard-negative false accepts | **0/35** | **0/35** |
| Peak-score margin | positives **0.983** vs negatives **0.001** | n/a (`.table` has no score) |
| Fire position | ~1.2 s into the clip — openWakeWord's minimum warm-up (mel + 16-embedding context), *not* post-phrase lag | offset not exposed offline |

Both miss the **same** clip (`…153620-502…`): full-scale clipped, STT heard
"you should control positive" — an atypical bad utterance, not a detector
weakness.

> **The 9/10 no longer reproduces (2026-09-08):** `backend/voice-captures/` has
> since been overwritten by live debug capture (`*-wake-azure_voice_live.wav`),
> a different and noisier set. `azure_mission_control_basic_med.table` scores
> **4/10** on the current contents — a corpus change, not a model regression.
> This is exactly why item 3 below ("freeze `voice-captures/`") matters.

### Why that is not enough

- **Identical on every clip → nothing to test.** A paired McNemar has zero
  discordant pairs (p = 1). There is no evidence either detector is better.
- **The corpus can't detect anything but a huge gap.** Wilson 95 % CI on 9/10 is
  **[59.6 %, 98.2 %]**. It cannot separate a truly-85 % detector from a
  truly-95 % one. Detecting a ~10 pp difference at 80 % power (paired) needs on
  the order of **150–250 positives** per arm.
- **No shared set both models can score.** openWakeWord's synthetic training
  holdout (recall ~0.62, `wake-word-model-training-notes.md`) is precomputed
  mel/embedding feature vectors — Azure's `KeywordRecognizer` needs raw PCM and
  cannot read them. That 0.62 is also openWakeWord-internal and re-rolled every
  training run, so it is not a v1-vs-v2 metric either.
- **No false-accepts-per-hour.** 35 command phrases (~90 s) is a hard-negative
  set, not hours of ambient household audio. Both scoring 0 is reassuring, not a
  rate.
- **Single speaker, room, mic.** Distance / accent / background-TV robustness is
  untested.
- **Asymmetric tunability.** openWakeWord exposes a score (sweepable → ROC);
  Azure `.table` fires binary, "basic/medium" tier only. A fair comparison pins
  openWakeWord to a matched FA operating point, not an arbitrary threshold.
- **The shipping browser port is unvalidated.** `benchmark_wake.py` uses the
  reference Python `openwakeword`, not `frontend/src/voice/wake/openWakeWord.ts`.
- **No frozen eval set.** `voice-captures/` is rewritten by live debug capture,
  so even the small benchmark is a moving target between model versions.

**Can we currently tell if a retrained model improved things?** No — no frozen
eval set, the real corpus is at ceiling (9/10) on close-mic positives so it
can't *show* a gain, and the one sensitive number (synthetic 0.62) is
openWakeWord-only and regenerated each run.

## The evaluation harness

Two scripts + committed specs, built 2026-09-08 to close the gaps above. The
evaluation maths (`scripts/wake_eval.py`) is pure-Python and unit-tested
(`tests/test_wake_eval.py`); the detector runtimes and TTS are benchmark-only
(`pip install openwakeword`, the `azure-wake` extra) and validated on hardware.
Everything is **keyword-parameterised** — see "Adding a keyword" below.

### `scripts/gen_wake_corpus.py` — synthetic corpus

Reads `backend/tests/data/wake_corpus/<keyword>.json` (committed: phrase, seed,
positive carriers, confusable negatives) + the shared `_voices.json` (size
profiles + the voice roster), and writes 16 kHz mono WAVs + a `manifest.json`
(per-clip label, condition tag, speaker, sha256). Raw WAV, so **every** detector
scores it — openWakeWord's own training holdout is feature vectors, which Azure's
`.table` cannot read.

- **`--profile`** `smoke` (~150 clips, proves the pipeline) / `coarse` (~2000,
  ranks the detectors) / `full` (tighter CIs). Overridable per field
  (`--voices`, `--positives-limit`, `--rates-pct`, …).
- **TTS `--engine`:**
  - `azure-tts` — **recommended.** ~24 standard Neural voices (mixed accent /
    gender / a child voice), SSML rate control. Reuses the shared Azure key +
    region (`Settings.azure_speech_key` / `azure_speech_region`, defaulting to
    the Foundry resource). Prints a character count + **cost estimate** and
    waits for confirmation; `--max-chars` hard-caps; base clips are cached so
    re-runs don't re-synthesise. A coarse run is ~40–60k characters ≈ **$0.60 on
    S0, and ~10× inside the F0 free tier** (500k chars/month). Skip HD/Dragon
    voices — they bill 2×.
  - `piper` — free, offline; the training env's multi-speaker `en_US-libritts_r`
    (904 speakers, `--piper-model`, ids sampled evenly). Good cross-check for
    the same-vendor confound (Azure-TTS positives scored by an Azure spotter).
  - `sapi` (Windows, 2–3 voices) / `espeak` — smoke only.
- **Augmentation:** `--noise-dir` mixes background at each profile SNR;
  `--rir-dir` convolves a room impulse response. The training env has MIT RIRs +
  AudioSet noise.

TTS output is **not** bit-reproducible across engines/hosts, so the manifest
records actual checksums; a v1-vs-v2 comparison reuses the same generated corpus
and `benchmark_wake.py` refuses to trust it if the checksums drift.

### `scripts/benchmark_wake.py` — scored comparison

```
python -m scripts.gen_wake_corpus --keyword mission_control --engine azure-tts \
    --profile coarse --noise-dir <n> --rir-dir <r>
python -m scripts.benchmark_wake --manifest ./wake-corpus/mission_control/manifest.json \
    --json run-b.json
# after retraining, same corpus:
python -m scripts.benchmark_wake --manifest .../manifest.json --json run-c.json --baseline run-b.json
```

`--models-dir <dir>` points at the `.onnx` / `.table` assets — needed when
running from a git worktree (whose `frontend/public/models/wake/` is empty);
defaults to the checked-out frontend models dir otherwise.

Columns: openWakeWord at each `--oww-threshold`, **and every**
`azure_<keyword>_*.table` in the models dir as its own column
(`azure_mission_control_basic_med.table`; advanced tables live in the
excluded `azure-advanced/` subdir — see above). Per column: recall + hard-negative FA
with **Wilson 95 % CIs**, latency, **recall by condition tag** (clean / snrNN);
an **openWakeWord threshold sweep** (recall vs hard-neg FA) + the lowest
threshold meeting `--target-fa`; a **head-to-head exact-binomial McNemar** of
openWakeWord vs each Azure table; and with `--baseline`, a paired McNemar of
this run vs a previous one — the "did retraining move what we care about,
significantly?" test. `--positives/--negatives` dir mode (the original small
real-audio check) still works.

A "better" verdict needs: significantly higher recall (non-overlapping CIs or
significant McNemar) at a **matched hard-negative FA point**, latency within
tolerance, the same direction on both the Azure-TTS and piper corpora — and
ideally on a real-mic corpus.

### First end-to-end run (2026-09-08) — openWakeWord vs Azure basic, `smoke`

Not a verdict — the harness working end-to-end, on the only corpus buildable on
the dev box (SAPI TTS, **2 voices**, clean, 12 positives / 20 hard negatives —
the 15 confusables + 5 commands). SAPI is out-of-distribution for openWakeWord
(trained on ~900 Piper LibriTTS speakers).

| threshold | openWakeWord recall | oww hard-neg FA | Azure basic recall | Azure basic FA |
| --- | --- | --- | --- | --- |
| oww 0.3 | 10/12 (83 %) | 2/20 (10 %) | 12/12 (100 %) | 6/20 (30 %) |
| oww 0.5 | 9/12 (75 %) | 1/20 (5 %) | " | " |

McNemar: recall Azure +2 discordant (p = 0.5, n.s.); FA Azure +4 discordant
(p = 0.125, n.s.). Nothing is significant at n = 12/20.

Directional read: **Azure basic runs at a much looser fixed operating point** —
100 % recall but fires on 30 % of the confusables ("permission control",
"commission control", "mission accomplished", …), with no knob to tighten it.
openWakeWord sits lower on recall but its score is tunable — and this is exactly
where the advanced Azure tiers (`lowfa`) are supposed to help, which is the
comparison we can't run. Re-run on the piper/Azure-TTS `coarse` corpus with
noise + reverb before reading anything into it.

### Adding a keyword

1. Copy `backend/tests/data/wake_corpus/mission_control.json` to
   `<new_slug>.json`, set `phrase` / `slug` / `positives` (bare phrase first,
   then carriers) / `negatives_confusable`.
2. Train / export the models under `frontend/public/models/wake/`:
   `<new_slug>.onnx` (openWakeWord) and `azure_<new_slug>_<tier>.table`.
3. `gen_wake_corpus.py --keyword <new_slug> …` then
   `benchmark_wake.py --keyword <new_slug> --manifest …` (the keyword is also
   read from the manifest, so `--keyword` is usually unnecessary on the bench).

### Available models (2026-09-08)

`frontend/public/models/wake/` (git-ignored, per-install):

| File | Detector column |
| --- | --- |
| `mission_control.onnx` | openWakeWord (variant "b", recall 0.62 synthetic-holdout) |
| `azure_mission_control_basic_med.table` | Azure — basic tier, medium sensitivity. The **only** working Azure model. |
| `azure-advanced/{lowfa,midfa,highfa}.table` | Advanced-tier exports at three FA operating points — **parked, do not use** (below). |

`benchmark_wake.py` scores every `azure_mission_control_*.table` in the models
dir as its own column; the `azure-advanced/` subdir is excluded on purpose.

#### The advanced-tier tables don't run on any obtainable Speech SDK binary

Investigated exhaustively 2026-09-08 (pip standard + `-embedded`, 6 SDK
versions, the C++/NuGet runtime, the standalone extension NuGets, binary
inspection). An advanced `.table` is an **ORT-format ONNX model, format
version 6**; it needs an ONNX-Runtime keyword engine the SDK's trace calls
`CSpxSpeechDdkKwsEngineAdapter`. Tested on clean synthetic speech, all three
tables — the basic table detects 100 % through every path:

| SDK / setup | Result |
| --- | --- |
| pip `azure-cognitiveservices-speech` **1.51.2**, `KeywordRecognizer` | silent no-op — `Failed to create 'CSpxSpeechDdkKwsEngineAdapter'`, falls back to the classic engine, loads the file, detects nothing |
| 1.51.2, `SpeechRecognizer.start_keyword_recognition` (cloud config) | same — `Canceled`, no keyword event |
| pip `azure-cognitiveservices-speech-embedded` **1.51.2** | same silent no-op (adds `onnxruntime.dll` + `embedded.*`, still no KWS adapter) |
| pip 1.51.2 **+ `Microsoft.CognitiveServices.Speech.Extension.ONNX.Runtime` NuGet** `onnxruntime.dll` dropped in | same silent no-op |
| pip **1.43.0 / 1.45.0** | `0x5 SPXERR_INVALID_ARG` in `keyword_spotter_initialize` (= GitHub #2571) |
| pip **1.41.1** ("fixed advanced models" release) | KWS engine engages, then `onnxruntime … ORT format model version [6] is not supported in this build 1.15.1` — bundled ORT predates the format |

**The KWS engine adapter for advanced models is in no obtainable binary.** It
was compiled into `core.dll` through ~1.42 (`core.dll` 2.29 MB) and **removed by
1.46** (`core.dll` 2.04 MB, ~250 KB smaller; the pip and NuGet `core.dll` are
byte-identical, so the C++ SDK offers nothing extra). `CSpxSpeechDdkKwsEngineAdapter`
appears as a class name only in `core.dll` — **not** in any distributable
extension DLL (`kws`, `kws.ort` (which is just a mobile ONNX Runtime, exports
`OrtGetApiBase`), `onnxruntime`, `embedded.sr`, `embedded.sr.runtime`,
`embedded.tts`). Timeline: ≤1.42 engine present but ORT too old / init broken;
1.43–1.45 `SPXERR_INVALID_ARG`; ≥1.46 engine gone. No version ever ran *this*
model format.

GitHub `Azure-Samples/cognitive-services-speech-sdk` #2564 — a maintainer:
advanced support was *"originally included in SDK releases but withdrawn due to
complaints about the binary size growth, now only … in the 'embedded speech'
package"*. The public `-embedded` PyPI wheel does **not** carry it, so "embedded
speech" here means Microsoft's gated <https://aka.ms/embedded-speech> program
deliverables or direct support — not anything installable.

The **Embedded Speech keyword APIs** (`EmbeddedSpeechConfig` +
`SetKeywordRecognitionModel` + `KeywordRecognitionModel.FromConfig`) are not a
way in either: they load Microsoft-*packaged* embedded keyword models discovered
**by name** from a `FromPath` model *folder*, and `EmbeddedSpeechConfig` doesn't
recognise a bare `.table` as a model. The advanced `.table` is a single file —
a ~769 KB KWS header + a ~5.5 MB embedded ORT ONNX model — with none of the
embedded-model folder structure and no straightforward transform into it. Full
detail: `frontend/public/models/wake/azure-advanced/README.md`.

`.table` header tier byte (offset 8) = **6** (advanced) vs **3** (basic).
**The runtime `azure` wake provider (`app/voice/wake_azure.py`, same
`KeywordRecognizer` API) cannot use them either.** `benchmark_wake.py` and
`wake_azure.py` read the tier byte and warn.

There is **no downgrade path**. Basic and Advanced are independent Speech Studio
generation processes (both from the phrase text alone — neither takes user
training data); you pick the tier at creation, and there is no re-export or
conversion between them. The repo already has the Basic model
(`azure_mission_control_basic_med.table`) and it is the one in use — so the
usable Azure ceiling for this project **is that Basic model**. Running the
Advanced files needs Microsoft's gated embedded-speech program or a future SDK.
Full evidence: `frontend/public/models/wake/azure-advanced/README.md`.

> If "advanced is considerably better" is the deciding factor for the wake-word
> choice: the Azure path is **capped at the Basic model already in the repo** —
> Microsoft withdrew the Advanced engine from the SDK, there is no installable
> way back, and Basic is a separate, lower-accuracy generation with no upgrade
> path. That is itself an argument for openWakeWord, the detector we can retrain
> and improve without a vendor gate.

## What's still needed (in priority order)

1. **Run `gen_wake_corpus --engine azure-tts --profile coarse` with
   `--noise-dir` / `--rir-dir`** (the training env has the corpora), then the
   same with `--engine piper` as the cross-check. This is the coarse
   detector-ranking corpus. Needs the Azure key + network (generation only).
2. **An ambient FA/hr corpus** — a few hours of household-like audio (TV,
   podcasts, conversation) run through every detector. The training env's 11 h
   validation set is cached *features* only; Azure needs the raw audio.
3. **Fresh real close-mic positives** across household voices / distances /
   rooms into `backend/voice-captures/`, and **freeze `voice-captures/`** to a
   stable dir so model versions compare on identical inputs while live debug
   capture keeps writing. Needs the kiosk mic — see isolation note.
4. **Run the shipping browser port** (`openWakeWord.ts`) over the same WAVs via
   a headless harness, or document the reference-vs-port delta explicitly.
5. **Advanced Azure** is not attainable — no installable SDK runs the Advanced
   tables and there is no downgrade to Basic (see above). The Azure column is
   the existing Basic model, permanently. If a stricter operating point helps,
   generate a new Basic model at a different sensitivity in Speech Studio and
   drop it in as `azure_mission_control_basic_<label>.table` (auto-discovered).

### Isolation note

Audio work is in progress on the host. The generator (non-`azure-tts` engines),
the manifest verifier, `wake_eval`, and `benchmark_wake.py`'s file-based scoring
need **no microphone and no network** — Azure `.table` spotting is fully
offline. `--engine azure-tts` needs network + the key for synthesis only. So
items 1, 2, 4, 5 proceed in isolation once the model binaries and (item 1) the
WSL corpora are staged. Item 3 touches live capture / the kiosk mic and must
wait for or coordinate with the parallel work.
