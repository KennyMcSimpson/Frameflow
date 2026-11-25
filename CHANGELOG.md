# Changelog

All notable changes to **Frameflow** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v2.0.1 Stabilization & Open-Source Release Prep

### Added
- **Repository & Bilingual Documentation Presence:** Flagship English `README.md` and Simplified Chinese `README.zh-CN.md`, `docs/ARCHITECTURE.md`, `docs/PRIVACY.en.md`, standard MIT `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, and theme-adaptive light/dark vector diagrams (`hero-{dark,light}.svg`, `workflow-{dark,light}.svg`, `architecture-{dark,light}.svg`).
- **Continuous Integration & Full E2E Coverage:** Automated CI checks alongside 56 Node unit/integration test suites (694 passing offline tests + 1 opt-in gated live network test), renderer builds, smoke E2E, and full import-to-FFprobe export verification.

### Changed & Stabilized
- **Export Pipeline Reliability:** Stabilized Web Worker JPEG frame encoding (`jpegEncoder.worker.js`), bounded 32-frame backpressure into FFmpeg `image2pipe`, explicit BT.601 full-range → BT.709 limited-range color tagging, hardware encoder trial probing (`h264_nvenc`, `h264_qsv`, `h264_amf`, `h264_mf`), and automatic mid-export CPU fallback.
- **Electron Security & Crash Hardening:** Enforced `contextIsolation` + `sandbox` + `app.enableSandbox()`, strict production CSP (`connect-src 'self' ffmedia:` with `https:` limited to `img-src`/`media-src` previews), `isTrustedSender` IPC validation, allowlisted `ffmedia://` streaming, 18-extension `ALLOWED_OPEN_EXT` allowlist with fail-closed `realpath`/UNC/trailing dot-or-space checks in `shell:openPath`, async DNS SSRF protection and trusted-host auth guards (`urlSafety.cjs`), `running.lock` heartbeat crash detection, graceful close-flush handling, and automated post-pack verification of all 5 Electron Fuses.
- **LGPL v3 FFmpeg Packaging:** Replaced static GPL binaries in packaged releases with SHA-256-verified BtbN `win64-lgpl-shared` FFmpeg builds (`resources/ffmpeg/`), guarded by `scripts/after-pack.cjs` and `scripts/check-artifacts.mjs`.

## [2.0.0] — 2026-11

### Added
- **Create Workspace (`创作`):** Conversational AI Director, Creative Brief editor, structured Shot Storyboard, animated Canvas2D Previz with camera/lighting HUD, AI image generation (Volcengine Ark Seedream / OpenAI-compatible), AI video generation across 8 cloud providers (`seedance`, `runway`, `luma`, `kling`, `minimax`, `veo`, `sora`, `fal`) plus local `mock` mode, and One-Click First Cut timeline assembly.
- **Refine Workspace (`精修`):** Multi-track NLE timeline (main video track, 4 PiP/overlay tracks, multi-row text & captions, multi-clip audio with waveforms & beat markers), unified Canvas2D compositor with 14 color looks, 10 camera motions, 16 transitions, 8 FX, masks, blend modes, keyframes, speed curves, range-focused AI natural-language editing, and offline Chinese NLP fallback.
- **Breakdown Library (`拆片库`):** Single-pass `worker_threads` video analyzer with adaptive cut/dissolve detection, MMCQ dominant color extraction, loudness/motion/beat curves, optional AI vision shot tagging, and 70 built-in offline Technique Cards.
- **Speech-to-Captions (ASR):** Local on-demand `whisper.cpp` (ggml models) and cloud OpenAI Whisper API transcription with sentence segmentation and SRT export.
- **Zero-Key Stock & Sample Library:** Built-in Wikimedia Commons, Openverse, Internet Archive, and NASA search (plus opt-in Pexels/Pixabay and consent-gated `yt-dlp`), bundled Mixkit "Morning Coffee" sample project, and 23 CC0 music/SFX tracks.
- **AIGC Compliance & Licensing:** Optional GB 45438-2025 visible AI corner badge, implicit `AIGC` metadata tagging for MP4/MOV/MP3, and automatic media license attribution export.
