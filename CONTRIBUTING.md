# Contributing to Frameflow Studio

Thank you for your interest in contributing to **Frameflow Studio**! Whether you are fixing a timeline edge case, adding a test, improving export reliability, or proposing a new provider adapter, we welcome clean, well-tested pull requests.

## Development Setup (Windows x64)

1. Install **Node.js 22+** and Git on Windows 10/11 (x64).
2. Fork and clone the repository:
   ```powershell
   git clone https://github.com/KennyMcSimpson/frameflow-studio.git
   cd frameflow-studio
   npm ci
   ```
3. (Optional) Fetch the sample project footage and built-in CC0 audio library:
   ```powershell
   npm run fetch:sample-media
   npm run fetch:builtin-audio
   ```
4. Start the development environment:
   ```powershell
   npm run dev
   ```

## Architectural Ground Rules

Please review [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before making structural changes:

- **Plain JavaScript Only** — Renderer modules (`src/`) use ESM (`.js`/`.jsx`); Electron main & preload (`electron/`) use CommonJS (`.cjs`). Do not introduce TypeScript build steps.
- **Keep `src/engine/` Pure** — Never import DOM, browser, or Electron APIs into `src/engine/`. All editing mutations should go through atomic `applyOps()` in `src/engine/ops.js` with undo/redo coverage.
- **Preserve the Security Boundary** — Keep `contextIsolation: true` and `sandbox: true`, never expose `ipcRenderer` or Node primitives to the renderer, validate `isTrustedSender(event)` on every IPC channel, and keep secrets encrypted via `safeStorage` (never returned in plaintext over IPC or printed to logs).
- **Single Compositor** — Visual effects, color looks, transforms, and text rendering must stay unified in `src/render/compositor.js` so preview and export remain consistent.
- **LGPL FFmpeg Hygiene** — Never bundle GPL-licensed `ffmpeg-static` / `ffprobe-static` binaries into release packages (`app.asar` or `extraResources`). Release builds strictly use the SHA-256-pinned LGPL v3 shared FFmpeg fetched by `scripts/fetch-ffmpeg.mjs`.
- **UI Copy** — Existing in-app UI copy is in Simplified Chinese (`zh-CN`); keep user-facing error messages clear, actionable, and consistent with the surrounding UI.

## Testing Before Opening a Pull Request

Run the relevant verification suite locally and include the results in your PR description:

```powershell
# 1. Run all unit & integration tests
npm test

# 2. Verify production renderer bundle builds cleanly
npm run build:renderer

# 3. Run Playwright + Electron E2E smoke test (for UI/IPC/render changes)
npm run e2e

# 4. Run full import -> edit -> export -> FFprobe verification (for media/export changes)
npm run e2e:full
```

If you modify packaging, licenses, or Electron Fuses, also verify:

```powershell
npm run dist:portable
```

## Pull Request Checklist

- [ ] Changes are scoped to a single feature, fix, or refactor.
- [ ] Unit tests are added or updated in `tests/*.test.mjs` for any engine, IPC, or security change.
- [ ] `npm test` and `npm run build:renderer` pass locally with zero warnings/errors introduced.
- [ ] No API keys, local user paths, temporary media files, or build artifacts (`dist/`, `vendor/`) are committed.
- [ ] License or privacy impacts are reflected in `build/THIRD_PARTY_LICENSES.txt`, `docs/PRIVACY.md`, and `docs/PRIVACY.en.md` when applicable.

## Reporting Bugs & Suggesting Features

Please open a GitHub Issue with:
- Clear reproduction steps (or expected vs. actual behavior).
- Windows version, GPU model (if preview/export-related), and Node/Electron version.
- Relevant excerpts from `%APPDATA%\Frameflow\logs\main.log` (automatically redacted, though please double-check before posting).
