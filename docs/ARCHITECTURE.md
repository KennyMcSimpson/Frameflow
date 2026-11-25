# Frameflow Architecture

This document describes the current v2.0 architecture of Frameflow across its Electron main process, sandboxed React renderer, pure editing engine, media/export pipeline, security boundary, and Windows packaging checks.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="images/architecture-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="images/architecture-light.svg" />
    <img src="images/architecture-dark.svg" alt="Frameflow Layered Electron Security and Media Architecture" width="100%" />
  </picture>
</p>

---

## 1. High-Level Process Model

Frameflow follows a strict two-process Electron 45 architecture written in plain JavaScript (ESM in `src/`, CommonJS in `electron/`):

| Process | Entry Point | Runtime & Key Responsibilities |
| --- | --- | --- |
| **Renderer** | `src/index.html` → `src/main.jsx` | Sandboxed Chromium (`React 19`, `Vite 7`, `Zustand 5`). Owns UI state, pure editing logic (`src/engine/`), Canvas2D compositing (`src/render/`), Web Worker JPEG encoding (`src/export/`), and AI prompt/schema construction (`src/ai/`). Has **no** Node.js access; CSP `connect-src 'self' ffmedia:` blocks direct renderer XHR/fetch/WebSocket calls to external APIs, while `img-src` and `media-src` permit `https:` for stock-media thumbnail and preview rendering. |
| **Preload** | `electron/preload.cjs` | Sandboxed bridge exposing a minimal `window.ff` API via `contextBridge`: `invoke`, `on`, `flushed`, `pathForFile`, `mediaUrl`, and typed convenience wrappers for `videogen`, `asr`, and `exportFrame`. Buffers early sticky events (`app:openFile`, `app:crashRecovered`) until UI listeners attach. |
| **Main** | `electron/main.cjs` | Privileged Node.js coordinator. Enforces single-instance locking, `.ffproj` file association routing, security policies, `ffmedia://` streaming, encrypted secret storage, background job lifecycle, subprocess cleanup, and crash recovery. |

---

## 2. Renderer Subsystems (`src/`)

### 2.1 Pure Editing Engine (`src/engine/`)
All editing state transitions live in pure, side-effect-free modules with zero DOM or Electron dependencies so they execute directly under `node --test`:

- **`model.js` & `migrations.js`** — Canonical project schema (`PROJECT_VERSION = 3`), defaults, clamping limits (up to 200 clips, 600 s max duration, 4 overlay tracks, speed range `0.1×–10×`), aspect presets (`16:9`, `9:16`, `1:1`, `4:3`, `21:9`), 14 looks, 10 motions, 16 transitions, 8 FX, 7 text presets, 4 mask shapes, 7 blend modes, and 6 speed-curve presets.
- **`timeline.js`** — Magnetic main-track layout (`layoutVideo`) with transition overlaps, active clip lookup (`activeAt`), overlay/text scheduling, and duration math.
- **`ops.js` & `history.js`** — Unified atomic editing protocol (`applyOps(project, ops, ctx)`) shared by the Inspector UI, AI Editor, local NLP parser, and Technique Cards. If any operation in a batch fails validation (e.g., locked clip or track, out-of-range index), the entire batch aborts without mutating state. `history.js` manages bounded undo/redo snapshots.
- **`localnlp.js`** — Offline rule-based Chinese editing parser supporting compound commands, ordinal/range clip targeting, color/look/motion/transition/FX/speed/audio edits, color harmonization, and pacing. Any unrecognized clause halts execution (`unknown` non-empty) so callers can prompt or escalate to an LLM.
- **`firstcut.js`, `colormatch.js`, `consistency.js`, `pacing.js`, `keyframes.js`, `captions.js`, `license.js`** — One-click rough cut assembly from storyboards, cross-clip color statistics matching, whole-project color baseline harmonization, beat/pacing retiming, keyframe interpolation, SRT caption formatting, and automatic media license credit generation.
- **`techniques.js` & `builtinTechniques.js`** — Searchable library containing **70 built-in offline Technique Cards** across 11 filmmaking categories (`transition`, `lighting`, `camera`, `rhythm`, `composition`, `color`, `dialogue`, `vfx`, `product`, `narrative`, `sound`), many carrying directly applicable `ops` templates.

### 2.2 Unified Canvas2D Compositor (`src/render/`)
Preview playback and final export share one rendering pipeline (`compositor.js`) to minimize WYSIWYG drift:

- **`compositor.js`** — Reuses pooled offscreen/DOM surfaces (`SurfaceSet`) per output resolution. Renders main-track clips (including dual-clip transitions), PiP/image/sticker overlays with blend modes and masks, primary grading + tone overlays (`looks.js`), procedural FX (`blur`, `grain`, `glow`, `sharpen`, `letterbox`, `chromatic`, `vhs`, `flash`), camera motion + keyframed transforms (`motion.js`), animated Canvas2D Previz (`previz.js`), and captions/titles (`text.js`).
- **`mediaPool.js`** — Manages reusable `<video>` elements and `ImageBitmap` caches with exact-frame seeking (`seeked` + `requestVideoFrameCallback`) during export.

### 2.3 Export Driver & Web Worker JPEG Pipeline (`src/export/`)
- **`exporter.js`** — Drives frame-by-frame rendering with a depth-1 pipeline (while frame `i` encodes/streams to main, frame `i+1` seeks and composites). Handles cancellation, GPU-to-CPU mid-export fallback retry, optional sidecar `.srt` generation, automatic license credits, and GB 45438-2025 AIGC visible badges + implicit container metadata (`aigc.js`).
- **`jpegEncoder.js` & `jpegEncoder.worker.js`** — Transfers rendered frames as `ImageBitmap` to an inline Vite Web Worker (`?worker&inline`, compatible with packaged `file://` origins) to encode high-quality intermediate JPEGs (`quality >= 0.95`) off the UI thread.
- **`audioPlan.js` & `presets.js`** — Computes normalized multi-track audio segment plans (volume keyframes, fades, reverse, denoise, speed ramps) and resolves platform/format presets (`MP4`, `MOV`, `GIF`, `MP3`, `WAV`).

### 2.4 AI Orchestration (`src/ai/`)
- **`schemas.js`** — Strict JSON Schemas (`additionalProperties: false`) for Director replies, Storyboards, Editing Op batches, Breakdown analysis, and asset tagging.
- **`director.js`, `editor.js`, `analyze.js`, `memory.js`, `budget.js`, `diff.js`, `lint.js`** — Build compact context prompts (including project summaries, style guides, color baselines, and range-focused neighboring shots), validate/lint AI responses, and compute human-readable operation diffs.
- **`localDirector.js` & `client.js`** — Wraps `ai:run` background jobs and cleanly falls back to offline template storyboarding when `NO_AI` is returned.

---

## 3. Main Process Subsystems (`electron/`)

### 3.1 Domain IPC Modules (`electron/ipc/`)
`electron/main.cjs` loads 9 domain modules via `createHandle()` (which enforces unique channel registration, sender validation, structured `{ ok, data | error, code }` responses, and in-flight tracking for graceful shutdown):

| Module | Responsibilities |
| --- | --- |
| `store.cjs` | Settings, encrypted secret flags, atomic project CRUD (`project.json` + `project.prev.json` + version snapshots), `.ffproj`/JSON import & export. |
| `media.cjs` | `ffprobe` inspection, cached thumbnails/filmstrips/waveforms, color stats, asset import, and automatic H.264 proxy transcoding for browser-incompatible codecs. |
| `export.cjs` | FFmpeg `image2pipe` H.264/MOV/GIF/MP3/WAV pipeline, bounded 32-frame backpressure queue, audio `filter_complex` mixing (`atempo` chains, speed curves, `afftdn`, volume keyframes), BT.601→BT.709 color conversion, and AIGC metadata embedding. |
| `ai.cjs` | Multi-provider LLM & image transport: OpenAI-compatible HTTP API, opt-in local Codex CLI (`--json` progress + `--output-schema`), Volcengine Ark Seedream image generation, and `NO_AI` local fallback. |
| `videogen.cjs` | Unified task lifecycle (submit → backoff poll → download → transcode/import) across 9 adapters in `electron/lib/videogen/`: `seedance`, `kling`, `minimax`, `runway`, `veo`, `sora`, `luma`, `fal`, and `mock`. |
| `asr.cjs` | Audio extraction + transcription via on-demand local `whisper.cpp` (with ggml model download & verification) or cloud OpenAI Whisper API. |
| `analysis.cjs` | Shot breakdown job orchestration, contact sheet generation, and local library persistence (`analyses/`, `techniques.json`, `assets.json`). |
| `web.cjs` | Parallel multi-source search and download: zero-key Wikimedia Commons, Openverse, Internet Archive, NASA; opt-in Pexels/Pixabay; consent-gated `yt-dlp` reference search/download (YouTube, Bilibili). |
| `system.cjs` | `app:info`, native file/folder dialogs, safe external URL/file opening, `media:register`, Windows taskbar progress, and notifications. |

### 3.2 Core Main-Process Libraries (`electron/lib/`)
- **`paths.cjs`** — Deterministic binary resolution for FFmpeg/FFprobe:
  1. `FF_FFMPEG` / `FF_FFPROBE` environment overrides (development only)
  2. `<resources>/ffmpeg/` (packaged LGPL v3 shared build)
  3. `<repo>/vendor/ffmpeg/bin/` (development LGPL build from `scripts/fetch-ffmpeg.mjs`)
  4. `ffmpeg-static` / `ffprobe-static` (development fallback only; strictly excluded from packaged ASAR)
- **`encoders.cjs`** — Real 1-frame hardware encoder probing (cached weekly in `<userData>/encoders.json`) prioritized as:
  `h264_nvenc` > `h264_qsv` > `h264_amf` > `h264_mf` (HW) > `libx264` > `libopenh264` / `h264_mf` (SW). Tracks runtime failures and temporarily demotes flaky GPU encoders after repeated failures.
- **`shotdetect.cjs` & `analyzer.cjs`** — Single-pass FFmpeg `128×72` `rgb24` stream processed inside Node `worker_threads` (loaded via eval-compatible source so it works inside `app.asar`). Implements PySceneDetect-inspired adaptive/content/threshold cut detection, linear-blend dissolve detection, flash filtering, keyframe sharpness/exposure scoring, MMCQ dominant color extraction (`quantize.js` / Color Thief), and audio loudness/beat peak detection.
- **`urlSafety.cjs`** — Outbound URL and UNC path hardening: blocks loopback, RFC 1918 private, link-local, CGNAT, and mapped/reserved IPv6 hosts (`assertSafePublicUrl`), performs async DNS resolution verification (`assertSafePublicUrlAsync`) to defeat DNS rebinding/private-domain SSRF, and enforces strict trusted-host credential scoping (`isTrustedHostForBase`).
- **`settings.cjs`** — Atomic temp-file + `fsync` + rename persistence with `.bak` recovery and `.corrupt-<timestamp>` quarantine on parse failure. API keys are encrypted via Electron `safeStorage` into `<userData>/secrets.json`.
- **`jobs.cjs`, `proc.cjs`, `log.cjs`** — Abortable job registry streaming `job:progress` / `job:done` / `job:error`, tracked subprocess spawning with tree termination on quit (`proc.killAll()`), and redacted rotating logs (`log.redact()`).

---

## 4. Security & Reliability Controls

Frameflow implements defense-in-depth aligned with the Electron security checklist:

1. **BrowserWindow Isolation** — `contextIsolation: true`, `sandbox: true` (+ `app.enableSandbox()`), `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `nodeIntegrationInSubFrames: false`, `webSecurity: true`, `allowRunningInsecureContent: false`, `webviewTag: false`, `navigateOnDragDrop: false`, `safeDialogs: true`.
2. **Hardened Production CSP** — Declared in `src/index.html`: `default-src 'self'; script-src 'self'; connect-src 'self' ffmedia:; img-src 'self' data: blob: ffmedia: https:; media-src 'self' blob: ffmedia: https:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'` (`connect-src` blocks direct renderer XHR/fetch/WebSocket calls to external APIs, while `img-src` and `media-src` permit `https:` for stock-media thumbnails and previews). Vite dev mode (`vite.config.mjs`) appends localhost HMR origins only during development.
3. **IPC Sender Verification** — `isTrustedSender()` checks `event.senderFrame` has no parent frame and matches either the packaged `dist-renderer/` `file://` root or (in development only) a validated loopback `FF_DEV_URL`.
4. **Scoped `ffmedia://` Media Protocol** — Serves local files with HTTP `Range` support (`206 Partial Content`) only if the canonicalized path is in `allowedMedia` or beneath `dataRoot`, `tmp`, or bundled `mediaRoots`; returns `403` otherwise.
5. **Navigation, Permission & Shell Restrictions** — Blocks `<webview>`, redirects, and popup windows; only `https:` URLs pass to `shell.openExternal`; default-deny permission handlers allow only `clipboard-sanitized-write` and `fullscreen` from the main frame; USB/HID/serial device permissions are denied; `shell:openPath` enforces an 18-extension allowlist (`ALLOWED_OPEN_EXT`) with fail-closed `realpath` resolution, UNC path rejection, and trailing dot/space protection.
6. **Outbound SSRF & Credential Scoping** — Outbound main-process fetches across AI, video generation, stock download, ASR, and `yt-dlp` validate targets via `assertSafePublicUrlAsync` (blocking private/loopback/link-local/CGNAT/mapped IPv6 DNS records) and restrict authorization headers via `isTrustedHostForBase`.
7. **Hardened Electron Fuses** — Configured in `package.json` and audited post-build by `scripts/check-artifacts.mjs`:
   - `runAsNode: false`
   - `enableNodeOptionsEnvironmentVariable: false`
   - `enableNodeCliInspectArguments: false`
   - `enableEmbeddedAsarIntegrityValidation: true`
   - `onlyLoadAppFromAsar: true`
8. **Crash & Shutdown Resilience** — `running.lock` heartbeat detects unclean exits; `win.on('close')` warns about active jobs and awaits renderer flush (`app:flush` → `app:flushed`) before exit; repeated renderer or GPU crashes within 5 minutes offer a one-click software-rendering fallback (`hardwareAcceleration: false`).

---

## 5. Local Data Layout

| Location | Contents |
| --- | --- |
| `%APPDATA%\Frameflow\settings.json` | User preferences (atomic write + `.bak`) |
| `%APPDATA%\Frameflow\secrets.json` | OS-encrypted API keys (`safeStorage` / Windows DPAPI) |
| `%APPDATA%\Frameflow\logs\` | Redacted runtime logs (`main.log`) |
| `%APPDATA%\Frameflow\bin\`, `models\` | On-demand `yt-dlp`, `whisper.cpp`, and ggml Whisper models |
| `%USERPROFILE%\Documents\Frameflow\` (configurable) | `projects/<id>/project.json`, `projects/<id>/cache/`, `library/analyses/`, `library/media/`, `library/techniques.json`, `cache/thumbs/`, `cache/waveforms/` |
| `<OS Temp>\frameflow\` | Ephemeral media processing scratch files |

---

## 6. Build, Packaging & Verification Pipeline

```text
npm run dist / dist:portable
  1. scripts/fetch-ffmpeg.mjs    -> Downloads pinned BtbN win64-lgpl-shared FFmpeg, verifies SHA-256,
                                    validates LGPL v3 config + required encoders/filters
  2. vite build                  -> Compiles sandboxed renderer into dist-renderer/ (no sourcemaps)
  3. scripts/gen-licenses.mjs    -> Generates build/THIRD_PARTY_LICENSES.txt and syncs license artifacts
  4. electron-builder --win      -> Packages app.asar + extraResources (ffmpeg, licenses, sample-media, builtin-audio),
                                    runs scripts/after-pack.cjs, flips 5 Electron Fuses, builds NSIS / Portable
  5. scripts/check-artifacts.mjs -> Read-only audit of fuses, LGPL FFmpeg, license files, ASAR hygiene, and size budgets
```
