# Wake-word model training — local WSL environment (working notes)

Companion to [`wake-word-model-training.md`](wake-word-model-training.md). Records the
environment that actually builds the `mission_control` model on this dev box, and
the version pins that were needed to make openWakeWord's 2024-era pipeline run on
current hardware. Setup scripts live outside the repo (session scratchpad
`wake-training/`, steps 01–06).

> **Status (2026-09-06):** environment provisioned; corpora downloaded; several
> models trained. Current `frontend/public/models/wake/mission_control.onnx` =
> "variant b" below — **accuracy 0.81 / recall 0.62 / 0.97 fp per hour**
> (`layer_size 128`, `max_negative_weight 64`, 100k synthetic positives). Ran
> `openwakeword/train.py` directly (not the Colab notebook — same steps, more control).

## Host / WSL

| | |
| --- | --- |
| WSL | `wsl --install --no-distribution` then `wsl --install -d Ubuntu-24.04 --no-launch`. No reboot was required; the VM Platform / WSL features were already serviceable. |
| Distro user | Provisioned as **root** (no interactive OOBE). Throwaway training VM — acceptable. Drive it with `wsl -d Ubuntu-24.04 -u root -- …`. |
| GPU passthrough | Works out of the box — `nvidia-smi` in WSL sees the 4090, `/dev/dxg` present. Windows NVIDIA driver 616.56. No CUDA toolkit install needed in WSL (PyTorch wheels bundle it). |
| Work dir | `/root/wakeword` — `~6 GB` (venv + Piper model + repos). |

## Python environment (`/root/wakeword/.venv`, via `uv`)

**Python 3.10** — forced by the notebook's `tensorflow-cpu==2.8.1` / `datasets==2.14.6` pins.

| Package | Pin | Why this exact pin |
| --- | --- | --- |
| `torch` / `torchaudio` | **2.4.1+cu121** | 2.6+ flips `torch.load` to `weights_only=True`, which breaks loading Piper's pickled generator module. 2.1.x cu121 has no `sm_89` cubin. 2.4.1 works: Ada runs the `sm_86` cubin (same major compute cap 8), `torch.load` still defaults to full unpickle. Real matmul on the 4090 verified. |
| `numpy` | **<2** (1.26.4) | TF 2.8.1, `datasets` 2.14.6, and piper-sample-generator all require numpy 1.x. |
| `setuptools` | **<81** (80.10.2) | `webrtcvad` (a piper-sample-generator dep) does `import pkg_resources`, removed from setuptools 81. Fresh `uv` venvs ship no setuptools at all. |
| `piper-phonemize` | 1.1.0 | last release with cp310 manylinux wheels; matches the pinned generator. |
| `openwakeword` | 0.6.0 | current; its `train.py` imports `generate_samples` from a checkout via `sys.path`. |

**Do NOT `pip install piper-sample-generator`** (PyPI 3.x / repo master). The 3.x
rewrite (Aug 2025, "torch 2, piper 1.3") dropped the `piper_train` module that
`generate_samples.py` imports. Use a checkout pinned to **`9c1019c93`**
(rhasspy/piper-sample-generator, 2024-02-27 — last commit before the rewrite):

    /root/wakeword/piper-sample-generator-oww   # git checkout 9c1019c93

That revision's `generate_samples()` signature matches what openWakeWord 0.6.0's
`train.py` calls, and it works with the v2.0.0 `en_US-libritts_r-medium.pt`
generator model (`.pt` fetched from the v2.0.0 release; the `.pt.json` config
ships in the repo's `models/`).

`config["piper_sample_generator_path"]` → that checkout path.

## Smoke test (passing)

    cd /root/wakeword/piper-sample-generator-oww
    /root/wakeword/.venv/bin/python -c "
    from generate_samples import generate_samples
    generate_samples(text=['mission control'], output_dir='/tmp/x',
                     max_samples=8, batch_size=8, max_speakers=200)"

→ 8× 16 kHz mono WAV, ~0.8 s each, **1.6 s total** on the 4090. Sample clips:
`/root/wakeword/mc_smoke_samples/`.

## The training run (done 2026-09-06)

Driver: `wake-training/09-train.sh` + `10-retrain-export.sh` (session scratchpad).

### Corpora (`/root/wakeword/data/`, ~18 GB, cached)
| Set | What | Note |
| --- | --- | --- |
| `mit_rirs/` | 270 room impulse responses, 16 kHz | HF `davidscripka/MIT_environmental_impulse_responses`, `16khz/` folder as-is |
| `audioset_16k/` | ~1000 background clips | 2 shards of `agkphysics/AudioSet` `data/bal_train/{08,09}.parquet` decoded + resampled. **The repo moved from `.tar` to parquet** — the notebook's `wget …bal_train09.tar` 404s now. FMA skipped (its HF repo is just a loader for a 7.5 GB Zenodo zip). |
| `*_features_ACAV100M_2000_hrs_16bit.npy` | negative speech features | **17.3 GB**, not the ~2–4 GB the plan guessed. Symlinked from the HF cache, memory-mapped during training. |
| `validation_set_features.npy` | 11 h FP-rate validation | 185 MB |

Fetched with `huggingface_hub` + `pyarrow` + `soundfile` directly — **not** the
`datasets==2.14.6` pin (which fights modern `fsspec`/`huggingface_hub`). `datasets`
is never imported by openWakeWord itself, only the notebook's download cells.

### Extra deps into `.venv` (notebook cell-4 pins, minus the TF trio)
`torchinfo==1.8.0 torchmetrics==1.2.0 mutagen==1.47.0 acoustics==0.2.6`
`pronouncing==0.2.0 speechbrain==0.5.14 torch-audiomentations==0.11.0 onnx`.
speechbrain 0.5.14 imports fine on torch 2.4 (only `read_audio` + `reverberate`
are used). **Skipped** `tensorflow-cpu==2.8.1` / `tensorflow_probability` /
`onnx_tf` — those are only for the `.tflite` export; we ship `.onnx`.

### openWakeWord `train.py` gotchas hit
- `torch.onnx.export` needs the **`onnx`** package — not a declared dep; first run
  trained then crashed at export. Installed `onnx`, re-ran `--train_model` only
  (features cached).
- `--convert_to_tflite`'s argparse default is the **string** `"False"` (truthy),
  so it *always* attempts tflite and dies on missing `onnx_tf`. Harmless — the
  `.onnx` is already written by then; our driver ignores the non-zero tail.
- `auto_train` runs `steps` then `steps/10` then `steps/10` (so 50k → +5k → +5k).
  `val_steps` uses `np.int16` in sequences 2–3 — fine unless `steps/10 > 32767`.
- Feature extraction (`AudioFeatures`) requested `CUDAExecutionProvider` but only
  `onnxruntime` (CPU) is installed, so augmentation→features ran on CPU. Slow but
  fine; install `onnxruntime-gpu` (replacing `onnxruntime`) to speed a re-run.

### What moves recall — measured

`n_samples` does **not**: 40k and 100k positives both gave recall ~0.50 at
`layer_size 32 / max_negative_weight 200`. The lever is model capacity + how hard
the auto-trainer weights negatives. Train-only sweep on the cached 100k features
(each ~10 min, no regeneration):

| id | `layer_size` | `max_negative_weight` | accuracy | recall | fp/hr | onnx |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 32 | 200 | 0.75 | 0.50 | 0.0 | 205 KB |
| a | 64 | 100 | 0.79 | 0.59 | 0.62 | 415 KB |
| **b (shipped)** | **128** | **64** | **0.81** | **0.62** | **0.97** | 859 KB |
| c | 64 | 40 | 0.82 | 0.64 | 1.68 | 415 KB |

Bigger layer + lower negative weight ⇒ more recall, more false positives. `auto_train`
still doubles `max_negative_weight` twice (sequences 2–3), so the yaml value is the
*floor*. The fp/hr is measured on the 11 h adversarial validation set (dense
speech/noise/music) — real-world fp for a phrase as uncommon as "mission control"
should be well below this. All variants export the same `[1,16,96]→[1,1]` interface;
`layer_size` only changes hidden width, so any of them drops into the kiosk.

Shipped **b** (best recall without fp/hr running away). `dist_big/mc_{a,b,c}.onnx`
kept for comparison. `mc_big/mission_control.yaml` holds the 100k config.

> **Real-audio check (2026-09-07).** `backend/scripts/benchmark_wake.py` ran the
> shipped **b** model over 10 real kiosk activations + 35 real no-wake commands:
> recall **9/10**, **0** false accepts, peak-score margin 0.98 vs 0.001. Real
> in-domain recall is far above the 0.62 synthetic-holdout figure here (deliberate,
> close-mic, single speaker). The same run scored the Azure custom-keyword `.table`
> identically (9/10, same missed clip). Full write-up + caveats (n is small; no
> FA/hr):  `docs/wake-word-provider-bakeoff.md` → "Measured comparison".

### Further improvement, in order
- **On-device threshold tuning first** — with recall 0.62 there's headroom to *raise*
  `MISSION_CONTROL_WAKE_WORD_THRESHOLD` (0.5 default) toward 0.6–0.7 to cut fp once
  real-mic behaviour is seen via the `[wake]` console scores. The plan already calls
  for this.
- A proper `layer_size` × `max_negative_weight` grid (train-only, cheap) once there's
  an on-device fp/recall target.
- More background/RIR variety (regen: `--generate_clips --augment_clips --overwrite
  --train_model`, fresh `output_dir`) — only if the sweep plateaus.
- `custom_negative_phrases` for any real-world false triggers.

### GPU utilisation (the run was mostly CPU/IO bound)
100k run: generate 38 min, augment→features 11 min, train+export 10 min. GPU util
median 8% / p90 24%. Fixes applied that *did* help the non-generation phases:
`onnxruntime-gpu` (feature extraction was 100% CPU before — `AudioFeatures` asks for
`CUDAExecutionProvider` but only got it once the GPU build was installed + torch's
bundled cu12 libs were on `LD_LIBRARY_PATH`, see `ort_env.sh`); `.wslconfig`
`memory=48GB` + `cat *.npy >/dev/null` cache-warm so training's mmap reads hit RAM
not disk. Generation stays bursty (Piper computes a batch then writes N wavs +
webrtcvad-trims, serially) — not worth rewriting piper-sample-generator to pipeline.

### Install into the kiosk — done + wired

- `mission_control.onnx` + `melspectrogram.onnx` + `embedding_model.onnx` in
  `frontend/public/models/wake/` (gitignored). **Nothing else goes there** — the
  wasm runtime is bundled now (see below).
- `onnxruntime-web` is a real `frontend` dependency (`package.json`). The old
  `loadOrt()` used a `@vite-ignore` variable-specifier dynamic import that the
  browser can't resolve, so the detector always reported "onnxruntime-web not
  installed". Fixed 2026-09-06:
  - `openWakeWord.ts` `loadOrt()` → `import('onnxruntime-web/wasm')` (wasm-only
    backend, lazy chunk).
  - `vite.config.ts` → `optimizeDeps: { exclude: ['onnxruntime-web'] }` so ORT
    resolves its own `ort-wasm-simd-threaded.wasm` sibling via `import.meta.url`
    (pre-bundling rewrites that path and breaks it). Served same-origin from
    `node_modules` in dev, fingerprinted into `dist/assets/` on build — no CDN.
  - Verified in-browser: ORT + all three ONNX sessions load; `vite build` and
    `tsc -b` both pass; wake unit tests green.
- Backend: `MISSION_CONTROL_WAKE_WORD_ENABLED=true` added to `backend/.env`
  (`VOICE_ENABLED` was already true). `GET /api/voice/wake-config` now returns
  `enabled: true`.
- **To try it:** restart backend (`backend/dev.ps1`) + restart the Vite dev
  server (the `optimizeDeps` change needs a fresh start), load the kiosk, grant
  the mic prompt, say "Mission Control". The Settings → Wake word row shows the
  detector state; watch the throttled `[wake] peak score …` console line while
  speaking to calibrate `MISSION_CONTROL_WAKE_WORD_THRESHOLD` (default 0.5;
  `localStorage['wake.debug']='off'` silences the log).
- Still unvalidated: the `OWW` feature-maths constants (mel lookback / windowing)
  in `openWakeWord.ts`. If the phrase never scores near threshold, that's the
  place to look first.
