# Azure "advanced"-tier custom keyword tables — parked, no obtainable SDK runs them

Three exports of the **advanced**-tier "Mission Control" custom keyword from
Azure Speech Studio, at three false-accept operating points:

| File | Speech Studio tuning |
| --- | --- |
| `lowfa.table`  | low false-accept — conservative, fewest spurious wakes |
| `midfa.table`  | balanced (Speech Studio default) |
| `highfa.table` | high false-accept — highest recall, most spurious wakes |

Same model, three calibration points (6.39 MB each). The shipping
`../azure_mission_control_basic_med.table` is basic-tier, 4.97 MB.

## Status: cannot run — the KWS engine for this model format is in no obtainable binary

An advanced `.table` is an **ORT-format ONNX model, format version 6**. It needs
the ONNX-Runtime keyword engine (SDK class `CSpxSpeechDdkKwsEngineAdapter`).
Investigated exhaustively 2026-09-08 — basic table works 100 % through every one
of these, advanced detects nothing:

| SDK / setup | Result |
| --- | --- |
| pip `azure-cognitiveservices-speech` **1.51.2**, `KeywordRecognizer` | silent no-op: *"Failed to create 'CSpxSpeechDdkKwsEngineAdapter' … Are all required extension libraries loaded?"* → classic-engine fallback, loads the file, no detections |
| 1.51.2, `SpeechRecognizer.start_keyword_recognition` (cloud config) | same, `Canceled` |
| pip `azure-cognitiveservices-speech-embedded` **1.51.2** | same silent no-op — bundles `extension.onnxruntime.dll` (full ORT) + `embedded.*`, still no KWS adapter |
| pip 1.51.2 **+ `Microsoft.CognitiveServices.Speech.Extension.ONNX.Runtime` NuGet `onnxruntime.dll`** dropped next to `core.dll` | same silent no-op |
| pip **1.43.0 / 1.45.0** | `0x5 SPXERR_INVALID_ARG` in `keyword_spotter_initialize` (GitHub #2571) |
| pip **1.41.1** (release notes: "fixed … Advanced models") | KWS engine engages, then `onnxruntime … ORT format model version [6] is not supported in this build 1.15.1` |

### Where the engine went

`CSpxSpeechDdkKwsEngineAdapter` is a class name **only in `core.dll`** — not in
any distributable extension DLL (`kws`, `kws.ort` — which is just a mobile ONNX
Runtime, exports `OrtGetApiBase` — `onnxruntime`, `embedded.sr`,
`embedded.sr.runtime`, `embedded.tts`). Its implementation was compiled into
`core.dll` through ~1.42 (`core.dll` 2.29 MB) and **removed by 1.46**
(`core.dll` 2.04 MB — ~250 KB smaller). The pip and C++/NuGet `core.dll` are
byte-identical, so the C++ SDK gives nothing extra.

Timeline: ≤1.42 — engine present, bundled ORT too old / init broken for this
format; 1.43–1.45 — `SPXERR_INVALID_ARG`; ≥1.46 — engine gone. **No released SDK
ever ran this model format.**

GitHub `Azure-Samples/cognitive-services-speech-sdk` #2564 — a Microsoft
maintainer: advanced support was *"originally included in SDK releases but
withdrawn due to complaints about the binary size growth, now only … in the
'embedded speech' package."* The public `-embedded` PyPI wheel does **not**
carry it. "Embedded speech" here = the gated
<https://aka.ms/embedded-speech> program (application + separate binaries +
model license), or direct Microsoft support — nothing installable.

### The Embedded Speech keyword APIs are not a way in either (investigated 2026-09-08)

Checked whether `EmbeddedSpeechConfig` + `SetKeywordRecognitionModel(name, key)`
+ `KeywordRecognitionModel.FromConfig` could load an advanced `.table` where
`FromFile` can't. It can't:

- `keyword_recognition_model_create_from_config` **is** exported and functional
  in the 1.51.2 `-embedded` package, but it only returns a model that
  `EmbeddedSpeechConfig` **discovered by name** in a `FromPath` directory.
- Discovery (`CSpxEmbeddedSpeechConfig::InitSpeechRecoModels`) scans for
  Microsoft-packaged embedded **model folders**, not files. A directory
  containing the bare `.table` (or `sr.ini` / `version.txt` / `tokens.list` /
  `manifest.json` / `speech.config` markers) yields *"No model files found …
  Number of keyword recognition models: 0"* → `Cannot find an embedded keyword
  recognition model by name`. Setting `KeywordRecognition_ModelPath` straight to
  the `.table` is ignored by this path.
- The official embedded-speech sample does **not** use `FromConfig` — it uses
  `KeywordRecognitionModel.FromFile("data/keyword_computer.table")` (a *basic*
  table) + `SpeechRecognizer(EmbeddedSpeechConfig).StartKeywordRecognitionAsync`.
  Embedded keyword spotting runs inside the RNN-T ASR decoder (`CZeroShotKeyword`
  in `embedded.sr.runtime.dll`) and needs *"prongen parameters in a lang pack"*
  — i.e. a full embedded ASR model, not a standalone KWS model.
- `SetKeywordRecognitionModel(name, key)` is for **Microsoft-packaged embedded
  keyword models** (folder layout, name + decryption key, limited-access) — a
  different representation from a Speech Studio `.table`.

**Structure of the advanced `.table`** (why it doesn't map onto the embedded
layout): a single file = a ~769 KB proprietary KWS header (tier byte 6) +
a ~5.5 MB **embedded ORT-format ONNX model** (`ORTM` flatbuffer). It is a
self-contained two-stage KWS classifier for `KeywordRecognitionModel.FromFile` +
the ORT KWS engine. It has none of the embedded-ASR-model structure (`sr.ini`,
`tokens.list`, lexicon, prongen, `version.txt`), is not a folder, and there is
no straightforward transform into one — that needs Microsoft's model-packaging
pipeline.

`.table` header tier byte (offset 8, LE uint32): **6** (advanced) vs **3**
(basic). The runtime `azure` wake provider (`backend/app/voice/wake_azure.py`,
same `KeywordRecognizer` API) cannot use these either;
`benchmark_wake.py::azure_table_tier()` + `wake_azure.py` read the byte and warn.

## There is no downgrade path — Basic is a separate model, and we already have it

Speech Studio's Basic and Advanced tiers are **independent generation
processes**, both driven only by the keyword phrase text (neither takes user
training data): Basic is a ~15-min common base model *"for demo or rapid
prototyping… might not have optimal accuracy"*; Advanced adapts that base with
simulated data over ~a day *"for product integration"*
([docs](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/keyword-recognition-overview)).
Their `.table` files are structurally different (see above). You pick the tier
at creation time; **there is no re-export, conversion, or downgrade** from
Advanced to Basic.

The repo already ships a Basic model — `../azure_mission_control_basic_med.table`
— and it is the one wired into the `azure` wake provider and the benchmark. So
"get a Basic model" is not a task; it's done. **The Azure wake-word option is
capped at that Basic model.** The Advanced tier's accuracy is not obtainable by
any partial-credit route.

The only ways to actually run these three files:

1. **Microsoft's gated embedded-speech program** (<https://aka.ms/embedded-speech>)
   or a support ticket for the ORT KWS engine extension, then move
   `wake_azure.py` + `benchmark_wake.py` onto that runtime. Heavy; changes
   licensing.
2. **Wait** for a future SDK that re-bundles the engine.
   `benchmark_wake.py --azure-table azure-advanced/midfa.table` still attempts
   these files, so re-testing is one command.

If a stricter Basic operating point would help (Basic models are downloadable at
several sensitivities), create one in Speech Studio and drop it in as
`../azure_mission_control_basic_<label>.table` — the bench auto-discovers every
`azure_mission_control_*.table`. That is a *new Basic model*, not a conversion
of these.
