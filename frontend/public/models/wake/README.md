# Wake-word model assets

The kiosk's local "Mission Control" detector loads these files from
`/models/wake/` at runtime. They are **not committed** (see `.gitignore` here) —
provision them per install. Full instructions, licensing and provenance:
[`docs/wake-word-model-training.md`](../../../../docs/wake-word-model-training.md).

Expected contents once provisioned:

| File | What | Source |
| --- | --- | --- |
| `melspectrogram.onnx` | Shared openWakeWord feature model | openWakeWord repo (`openwakeword/resources/models/`), Apache-2.0 |
| `embedding_model.onnx` | Shared openWakeWord speech-embedding model | openWakeWord repo, Apache-2.0 (weights from Google's `speech_embedding`, Apache-2.0) |
| `mission_control.onnx` | The trained "Mission Control" phrase model | Trained locally per `docs/wake-word-model-training.md`; output is yours |
| `azure_mission_control_basic_med.table` | Azure custom-keyword model for the `azure` wake provider (optional) | Azure Speech Studio custom keyword ("Mission Control", basic, medium). **Read by the backend, not the browser** — `MISSION_CONTROL_WAKE_WORD_AZURE_MODEL_PATH` points here by default. |

The first three `.onnx` files power the default in-browser `openwakeword` detector. The `.table`
is only needed if you switch the wake provider to `azure` (Settings, or
`MISSION_CONTROL_WAKE_WORD_PROVIDER=azure`), which also needs `pip install -e
'backend[azure-wake]'`. See `docs/wake-word-provider-bakeoff.md`.

The `onnxruntime-web` wasm runtime is **no longer copied here** — it is a project
dependency (`frontend/package.json`, MIT) that Vite code-splits and fingerprints
into the build, served same-origin (no CDN). Just `npm install`.

With the `.onnx` files absent the detector reports "unavailable" and the kiosk
falls back to push-to-talk with no error.
