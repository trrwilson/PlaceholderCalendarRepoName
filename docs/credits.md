---
status: reference
summary: Source and licence for every bundled media asset and trained model artifact.
---

# Credits & provenance for bundled media

Bundled media assets get their source and licence noted here — lightweight, not a
review process.

## Audio

| Asset | Source | Licence | Notes |
| --- | --- | --- | --- |
| Timer expiry chime | Self-made, synthesised at runtime with the Web Audio API (`frontend/src/timers/chime.ts`) | n/a (generated, no file) | Two sine partials (a fundamental + a fifth) with a short percussive envelope, repeated every ~2 s while a timer is in the `fired` state and tightening slightly after the first minute. No external sound file is committed; if a suitable CC0 chime is bundled later, add it here and switch the player over. |

## Icons

| Asset | Source | Licence | Notes |
| --- | --- | --- | --- |
| Provider badges (`ProviderBadge` in `frontend/src/App.tsx`) | Self-made, simplified inline SVG marks for Outlook (blue tile + "O") and Google (4-colour "G") | n/a (original simplified glyphs, no file) | Small identity cue next to a person's name; drawn inline so there is no asset and it scales with type. Swap for licensed brand assets if exact-mark fidelity is ever required. |
| Holiday markers (`HolidayNote` / `holidayOn`, `frontend/src/holidays.ts`) | System emoji (Segoe UI Emoji on the kiosk), rendered inline as text | n/a (OS font glyphs, no file) | One small thematic emoji prefixes each US-holiday label in the calendar views. No asset is committed; regional-indicator flag emoji are deliberately avoided (Windows renders them as letters). |

## ML models

Model artifacts get licence **and** provenance reviewed independently of the
software that runs them (see `AGENTS.md`).

| Asset | Source | Licence | Notes |
| --- | --- | --- | --- |
| Wake-word models (`frontend/public/models/wake/*.onnx`) | Not committed — provisioned per install | openWakeWord runtime + feature models Apache-2.0; trained "Mission Control" phrase model is synthetic-TTS-derived and household-owned | Full record and training procedure in `docs/wake-word-model-training.md`. `mission_control.onnx` trained locally 2026-09-06 with openWakeWord 0.6.0 (see `docs/wake-word-model-training-notes.md`), entirely from synthetic Piper LibriTTS-R speech + public augmentation sets — no human voice recordings. |
| Azure custom-keyword model (`frontend/public/models/wake/azure_mission_control_basic_med.table`) | Not committed — exported per install from Azure Speech Studio (custom keyword, "Mission Control", basic model, medium sensitivity) | Household-owned (the keyword string is the only input; Microsoft asserts no rights over the generated `.table`) | Used only by the `azure` wake provider (`backend/app/voice/wake_azure.py`). Spotted on-device by the native Speech SDK — no Azure resource or key is used at runtime. See `docs/wake-word-provider-bakeoff.md`. |
| Local STT models (faster-whisper `Systran/faster-whisper-{tiny,base,small}.en`) | Not committed — auto-downloaded from Hugging Face per install to the HF cache / `MISSION_CONTROL_LOCAL_STT_MODELS_DIR` | Runtime (faster-whisper / CTranslate2) MIT; **weights MIT** (OpenAI Whisper, repackaged by Systran) | Used by the Local / Hybrid voice pipeline (`backend/app/voice/local/`). Full evaluation + provenance table in `docs/local-stt-evaluation.md`. |
| Local STT models (sherpa-onnx streaming zipformer) | Not committed — a model directory provisioned per install (`MISSION_CONTROL_LOCAL_STT_MODEL`) | Runtime (sherpa-onnx) Apache-2.0; weights per the specific k2-fsa release (typically Apache-2.0 — confirm the release LICENSE) | Optional streaming STT engine; not the default. See `docs/local-stt-evaluation.md`. |
| Local-camera presence motion detector (`opencv-python-headless`, `app/presence/sources/local_camera.py`) | PyPI package, installed as a core backend dependency | BSD-3-Clause (OpenCV) | **No model weights** — the detector is `cv2.createBackgroundSubtractorMOG2`, a classical (non-trained) per-pixel Gaussian-mixture algorithm shipped in OpenCV core, not a downloaded/trained model. Nothing is auto-downloaded. See `docs/camera-support-plan.md` "Phase 1 MVP: local-camera motion" for the detection approach and its FA/recall tuning. |
