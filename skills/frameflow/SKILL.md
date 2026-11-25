---
name: frameflow
description: Inspect, create, storyboard, edit, break down videos, search zero-key stock media, and export captions or render plans for Frameflow (.ffproj) video projects using the zero-daemon CLI. Activate whenever the user works with a .ffproj file, asks to edit a Frameflow timeline, generate a storyboard/first cut, analyze a video's shots, find free stock footage, or export SRT subtitles.
---

# Frameflow Video Workstation Skill

Collaborate with **Frameflow Desktop** from any coding or general AI agent using an **outside-in, zero-daemon CLI workflow**. Every edit flows through Frameflow's deterministic atomic engine (`lintOps` → `applyOps` → `diffProject` → `needsConfirm`), writes atomically with a `.bak.ffproj` safety backup, and triggers **Frameflow Desktop Live Watch** (`<100ms` hot-reload with instant `Ctrl+Z` undo).

## Path Resolution (Zero Hardcoded Paths)

Resolve `<repoRoot>` dynamically from this skill file's own location:
- This file lives at `<repoRoot>/skills/frameflow/SKILL.md`.
- The CLI entrypoint is `<repoRoot>/bin/frameflow.mjs`.
- Run commands with Node.js `>=22`:
  ```bash
  node "<repoRoot>/bin/frameflow.mjs" <command> [args...] --json
  ```
- Always prefer `--json` for structured, machine-readable output.

## Core Editing Workflow (Follow Strictly in Order)

### Step 1 — Inspect (or Initialize) First
Never guess clip IDs, asset IDs, durations, track locks, or storyboard shots. Always inspect first:

```bash
# Inspect an existing .ffproj project
node "<repoRoot>/bin/frameflow.mjs" inspect "<project.ffproj>" --json

# Or focus detail on a specific timeline range in seconds (<start>..<end>; colon form 0:15 is also accepted)
node "<repoRoot>/bin/frameflow.mjs" inspect "<project.ffproj>" --focus 0..15 --json

# Or create a brand-new .ffproj project
node "<repoRoot>/bin/frameflow.mjs" init "<project.ffproj>" --name "My Video" --aspect 16:9 --json
```

### Step 2 — Discover Valid Ops Before Composing Edits
Before constructing any edit batch, query the live engine schema to confirm exact op names, parameter shapes, ranges, and enums:

```bash
node "<repoRoot>/bin/frameflow.mjs" ops-schema --json
```

**Important headless targeting rule:** Outside the GUI there is no active UI selection (`selectedClipIds` is empty). For clip-targeted ops (`setColor`, `setLook`, `setMotion`, `setTransition`, `trim`, `setDuration`, `delete`, `move`, etc.), always specify an explicit `target`:
- By 1-based clip index: `{ "mode": "index", "indices": [1, 2] }`
- By clip ID: `{ "mode": "ids", "ids": ["clp_..."] }`
- Across all clips: `{ "mode": "all" }`

### Step 3 — Dry-Run Validate, Then Apply Atomically
Always validate your ops with `--dry-run` first. Fix any `lintOps` diagnostics (`opIndex`, `code`, `message`) before writing to disk:

```bash
# 1) Validate & preview diff without touching disk
node "<repoRoot>/bin/frameflow.mjs" apply "<project.ffproj>" --ops "<ops.json>" --dry-run --json

# 2) Apply atomically (Live Watch refreshes Frameflow Desktop with instant Ctrl+Z undo)
node "<repoRoot>/bin/frameflow.mjs" apply "<project.ffproj>" \
  --ops "<ops.json>" \
  --agent "<your-agent-name>" \
  --label "<short human-readable summary>" \
  --json
```

Provide Ops JSON using exactly one source: `--ops <ops.json>`, inline `--ops-json '<json>'`, or `--stdin` (`--ops -` also works as a `stdin` alias). Always pass `--agent` and a concise `--label` so Frameflow Desktop displays who made the edit and labels the `Ctrl+Z` undo step clearly.

### Step 4 — Respect the Destructive Safety Gate
Frameflow enforces a deterministic local safety gate (`needsConfirm`) that blocks high-impact edits unless explicitly authorized:
- Deleting `>= 3` video clips in one batch
- Changing total project duration by `> 20%` AND `>= 2` seconds
- Modifying color grading or transitions across the entire timeline (`mode: "all"` / `setTransitionAll`)
- Unlocking locked clips (`unlock`)
- Clearing all captions (`clearCaptions`)
- Changing project aspect ratio (`setProject` with `aspect`)

**Hard rule:** If `--dry-run` or `apply` reports `needsConfirm: true` / `CONFIRM_REQUIRED`, **STOP**. Show the exact `confirmReasons` and `diffSummary` to the user and ask for explicit approval. **NEVER pass `--allow-destructive` without explicit user confirmation.**

---

## Full Command Playbook

### Storyboarding & One-Click First Cut
Generate a structured creative brief, shot-by-shot storyboard (with shooting tips, previz specs, and stock reference queries), and optionally assemble a rough-cut timeline with previz placeholders. If `<project.ffproj>` does not exist yet, `storyboard` auto-creates it (matching MCP `frameflow_storyboard`); if it already exists, Frameflow writes `<project>.bak.ffproj` before overwriting:

```bash
node "<repoRoot>/bin/frameflow.mjs" storyboard "<project.ffproj>" \
  --brief "30-second warm cinematic promo for a neighborhood specialty coffee shop" \
  --duration 30 \
  --aspect 9:16 \
  --first-cut \
  --agent "<your-agent-name>" \
  --json
```

### Video Shot Breakdown
Analyze a local video file with FFmpeg/FFprobe to extract shot cut timestamps, pacing/rhythm metrics, dominant color palettes, audio loudness peaks, and reusable Technique Cards:

```bash
node "<repoRoot>/bin/frameflow.mjs" breakdown "<video.mp4>" --json
```

### Zero-Key Open-License Stock Search
Search free, zero-API-key open-license archives (**Wikimedia Commons**, **Openverse**, **Internet Archive**, **NASA**). Prefer concise English keywords for the broadest coverage:

```bash
node "<repoRoot>/bin/frameflow.mjs" stock search "coffee pour slow motion" --kind video --limit 8 --json
node "<repoRoot>/bin/frameflow.mjs" stock search "minimalist desk workspace" --kind image --limit 8 --json
node "<repoRoot>/bin/frameflow.mjs" stock search "ambient acoustic guitar" --kind audio --limit 8 --json
```

### Export SRT Subtitles
Export project captions as `.srt` (automatically respects a hidden text track — produces empty output if `trackState.text.hidden` is `true`):

```bash
# Print SRT payload in JSON
node "<repoRoot>/bin/frameflow.mjs" export-srt "<project.ffproj>" --json

# Write atomically to an .srt file
node "<repoRoot>/bin/frameflow.mjs" export-srt "<project.ffproj>" --out "<subtitles.srt>" --json
```

### Inspect Export Plan
Generate the render/audio export plan (dimensions, FPS, clip segments, audio mix graph, encoder readiness) without invoking a full GUI render:

```bash
node "<repoRoot>/bin/frameflow.mjs" export-plan "<project.ffproj>" --json
```

### Environment & Project Diagnostics
Verify Node.js version, pure engine modules, FFmpeg/FFprobe availability, and optional `.ffproj` health:

```bash
node "<repoRoot>/bin/frameflow.mjs" doctor --json
```

---

## Guardrails & Best Practices

1. **Never hand-edit `.ffproj` JSON directly.** Raw JSON edits bypass schema normalization, version migration, `lintOps`, `.bak.ffproj` backups, and `meta.lastAgentEdit` tracking. Always edit through `apply` or `storyboard`.
2. **Batch related edits thoughtfully.** Group coherent edits (e.g., color grade + transitions + captions for a scene) into a single atomic `apply` batch so the user can undo the entire intent in one `Ctrl+Z`.
3. **Never pass UNC network paths (`\\server\share`, `//host/share`).** Frameflow rejects UNC paths, device prefixes (`\\.\`), and NTFS alternate data streams before any filesystem access.
4. **Verify after writing.** After applying edits, inspect the returned `diffSummary` and `durationAfter` (or re-run `inspect --json`) before reporting completion to the user.
5. **Opt-in MCP alternative.** For hosts without shell access (e.g., Claude Desktop), configure the companion thin stdio MCP server `<repoRoot>/bin/frameflow-mcp.mjs` (supports `--readonly`). See `<repoRoot>/docs/AGENT-INTEGRATION.md`.
