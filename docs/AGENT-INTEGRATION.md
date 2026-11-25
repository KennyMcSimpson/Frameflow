# Agent Integration Guide (Outside-In Editing & Live Watch)

Frameflow is designed for **Outside-In AI collaboration**: any external coding agent or AI assistant can inspect, storyboard, edit, analyze, and export `.ffproj` video projects using Frameflow's pure editing engine — while **Frameflow Desktop** hot-reloads changes in `<100ms` with full `Ctrl+Z` undo.

```text
  External Agent (Antigravity / Claude Code / Codex CLI / OpenCode / PI / Cursor / Claude Desktop)
        │
        ├── Option A (Recommended): Zero-Daemon CLI (`node bin/frameflow.mjs`) + `skills/frameflow/SKILL.md`
        │       • 0 background processes · 0 tool-table token tax · full command surface
        │
        └── Option B (Opt-In): Thin Stdio MCP (`node bin/frameflow-mcp.mjs [--readonly]`)
                • Zero npm dependencies · 6 strictly typed tools · Content-Length & ndjson framing
        │
        ▼
  Frameflow Pure Engine (`src/engine/` + `src/ai/`)
        │  loadProject → lintOps → applyOps → diffProject → needsConfirm
        │  atomic write (tmp + fsync + rename) + `.bak.ffproj` backup + `meta.lastAgentEdit`
        ▼
  `project.ffproj` on disk
        │
        ▼  (<100ms file watcher)
  Frameflow Desktop Live Watch
        • Hot-reloads timeline & Canvas2D preview automatically
        • Pushes agent batch onto the undo stack → instant `Ctrl+Z` rollback
```

---

## Prerequisites

- **Node.js `>=22`**
- A local clone of the Frameflow repository (referred to below as `<FRAMEFLOW_ROOT>`)

---

## Option 1: Zero-Daemon CLI + Agent Skill (Recommended)

For terminal-capable agents (**Antigravity**, **Claude Code**, **Codex CLI**, **OpenCode**, **PI**), use the **Zero-Daemon CLI** paired with [`skills/frameflow/SKILL.md`](../skills/frameflow/SKILL.md):

- **Zero background daemon** — no long-running process to manage or restart.
- **Zero permanent token tax** — tools are loaded on demand only when editing video projects.
- **Complete feature set** — includes video shot `breakdown`, `export-plan`, and `doctor` diagnostics in addition to inspection, storyboarding, stock search, ops execution, and SRT export.

### Host Setup

| Agent Host | How to Activate `skills/frameflow/SKILL.md` |
| :--- | :--- |
| **Antigravity** | Point your workspace or global skills loader at `<FRAMEFLOW_ROOT>/skills/frameflow/` (or copy `skills/frameflow/SKILL.md` into your skills folder). |
| **Claude Code** | Copy `<FRAMEFLOW_ROOT>/skills/frameflow` into `.claude/skills/frameflow` (project) or `~/.claude/skills/frameflow` (global). |
| **Codex CLI** | Copy `<FRAMEFLOW_ROOT>/skills/frameflow` into `.agents/skills/frameflow` or `~/.codex/skills/frameflow`. |
| **OpenCode** | Add `<FRAMEFLOW_ROOT>/skills/frameflow` to your OpenCode skills directory (`.opencode/skills/frameflow`). |
| **PI** | Register `<FRAMEFLOW_ROOT>/skills/frameflow/SKILL.md` in your PI skill discovery path. |

> **Tip:** `skills/frameflow/SKILL.md` contains zero hardcoded personal paths and resolves `<repoRoot>` dynamically relative to its own file location. If you copy `SKILL.md` outside the repository, pass the absolute path to `<FRAMEFLOW_ROOT>/bin/frameflow.mjs` in your prompt or shell alias.

---

## Option 2: Opt-In Thin MCP Server (Claude Desktop / Cursor / Windsurf)

For GUI clients that speak MCP over stdio (**Claude Desktop**, **Cursor**, **Windsurf**), Frameflow ships an ultra-thin, zero-dependency MCP server at `bin/frameflow-mcp.mjs`:

- Supports **both** LSP-style `Content-Length: N\r\n\r\n{...}` framing and newline-delimited JSON-RPC 2.0 (`ndjson`), replying in the same framing used by the client.
- Logs diagnostics strictly to `stderr` so `stdout` stays pure JSON-RPC 2.0.
- Supports **`--readonly`** to hide and block all mutating tools (`frameflow_apply_ops`, `frameflow_storyboard`, and file writes in `frameflow_export_srt`).

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "frameflow": {
      "command": "node",
      "args": ["<FRAMEFLOW_ROOT>/bin/frameflow-mcp.mjs"]
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "frameflow": {
      "command": "node",
      "args": ["<FRAMEFLOW_ROOT>/bin/frameflow-mcp.mjs"]
    }
  }
}
```

### Windsurf (`mcp_config.json`)

```json
{
  "mcpServers": {
    "frameflow": {
      "command": "node",
      "args": ["<FRAMEFLOW_ROOT>/bin/frameflow-mcp.mjs"]
    }
  }
}
```

### Read-Only Mode (`--readonly`)

To grant an agent read-only visibility into `.ffproj` timelines, op schemas, stock search, and in-memory SRT generation without write permission:

```json
{
  "mcpServers": {
    "frameflow-ro": {
      "command": "node",
      "args": ["<FRAMEFLOW_ROOT>/bin/frameflow-mcp.mjs", "--readonly"]
    }
  }
}
```

### Exposed MCP Tools (6 Minimal Tools)

| Tool | Parameters | Mode | Purpose |
| :--- | :--- | :--- | :--- |
| `frameflow_inspect` | `{ filePath, focus?: { start, end } }` | Read | Loads & migrates `.ffproj`; returns compact summary + clips, texts, audios, overlays, markers, assets, and storyboard. |
| `frameflow_ops_schema` | `{}` | Read | Returns all 55 supported `OP_TYPES`, enums, limits, targeting rules, and categorized JSON examples. |
| `frameflow_apply_ops` | `{ filePath, ops, dryRun?, allowDestructive?, label?, agent? }` | Write* | Runs `lintOps` → `applyOps` → `diffProject` → `needsConfirm`; writes atomically with `.bak.ffproj` backup and `meta.lastAgentEdit`. |
| `frameflow_storyboard` | `{ filePath, brief, duration?, aspect?, firstCut?, agent? }` | Write* | Builds a brief, shot-by-shot storyboard, and optional first-cut timeline (auto-creates `.ffproj` if absent; writes `.bak.ffproj` before overwriting an existing file). |
| `frameflow_stock_search` | `{ query, kind?: "video"\|"image"\|"audio", limit?: 1..30 }` | Read | Searches zero-key open-license stock sources (Wikimedia Commons, Openverse, Internet Archive, NASA). |
| `frameflow_export_srt` | `{ filePath, outPath? }` | Read / Write† | Generates SRT captions (respecting hidden text track) and optionally writes atomically to `outPath`. |

*\*Disabled and hidden from `tools/list` when `--readonly` is passed.*  
*†In `--readonly` mode, `frameflow_export_srt` remains available for in-memory SRT output, while passing `outPath` is rejected.*

---

## Complete CLI Command Reference

All commands run via `node bin/frameflow.mjs <command> [args]` and support `--json` for structured machine-readable output.

| Command | Usage & Key Flags | Description |
| :--- | :--- | :--- |
| `init` | `init <file.ffproj> [--name <str>] [--aspect 16:9\|9:16\|1:1\|4:3\|21:9] [--json]` | Create a new schema-v3 `.ffproj` file atomically. |
| `inspect` | `inspect <file.ffproj> [--focus <start>..<end>] [--json]` | Load, migrate, and summarize timeline clips, tracks, overlays, markers, assets, and storyboard (`--focus` e.g. `0..15`; `0:15` is also accepted). |
| `ops-schema` | `ops-schema [--json]` | Print all 55 supported `OP_TYPES`, enums, limits, and example Op payloads. |
| `apply` | `apply <file.ffproj> (--ops <ops.json> \| --ops-json '<json>' \| --stdin) [--dry-run] [--allow-destructive] [--agent <name>] [--label <text>] [--json]` | Lint, apply atomically, compute diff, enforce safety gate, create `.bak.ffproj`, and record `meta.lastAgentEdit` (`--ops -` works as a `--stdin` alias). |
| `storyboard` | `storyboard <file.ffproj> --brief "<prompt>" [--duration <sec>] [--aspect <ratio>] [--first-cut] [--agent <name>] [--json]` | Generate a brief + shot-by-shot storyboard and optional previz first-cut timeline; auto-creates `<file.ffproj>` if absent (and writes `<file>.bak.ffproj` before overwriting an existing file), matching MCP `frameflow_storyboard`. |
| `breakdown` | `breakdown <video-file> [--json]` | Run local FFmpeg/FFprobe shot detection, rhythm/palette analysis, and Technique Card inference. |
| `stock search` | `stock search "<query>" [--kind video\|image\|audio] [--limit <1..30>] [--json]` | Search zero-key open-license stock media (Wikimedia Commons, Openverse, Internet Archive, NASA). |
| `export-srt` | `export-srt <file.ffproj> [--out <file.srt>] [--json]` | Export SRT subtitles (respects `trackState.text.hidden`). |
| `export-plan` | `export-plan <file.ffproj> [--json]` | Compute the video/audio render plan, track segments, and encoder readiness without rendering. |
| `doctor` | `doctor [--json]` | Check Node.js version, engine health, FFmpeg/FFprobe availability, and local environment readiness. |

### End-to-End Example Workflow

```bash
# 1. Create a vertical short-form project with storyboard + previz first cut
#    (auto-creates demo.ffproj if absent; writes demo.bak.ffproj before overwriting an existing file)
node bin/frameflow.mjs storyboard demo.ffproj \
  --brief "25s warm specialty coffee shop promo for short-form vertical video" \
  --duration 25 --aspect 9:16 --first-cut --agent "claude-code" --json

# 2. Inspect generated clips and IDs (optionally focus a range with --focus 0..15; 0:15 is also accepted)
node bin/frameflow.mjs inspect demo.ffproj --focus 0..15 --json

# 3. Validate an Ops batch without writing to disk (--ops <ops.json> | --ops-json '<json>' | --stdin; --ops - alias)
node bin/frameflow.mjs apply demo.ffproj --ops edits.json --dry-run --json

# 4. Commit atomically (Frameflow Desktop hot-reloads in <100ms with Ctrl+Z undo)
node bin/frameflow.mjs apply demo.ffproj --ops edits.json \
  --agent "claude-code" --label "Warm grade + crossfade on shot 2" --json

# 5. Export captions to SRT
node bin/frameflow.mjs export-srt demo.ffproj --out demo.srt --json
```

Example `edits.json`:

```json
[
  { "type": "setLook", "target": { "mode": "index", "indices": [1] }, "look": "film-warm", "lookStrength": 0.85 },
  { "type": "setTransition", "target": { "mode": "index", "indices": [2] }, "transition": { "type": "crossfade", "duration": 0.5 } },
  { "type": "addMarker", "t": 3.0, "label": "Hook End", "color": "#c8e250" }
]
```

---

## Safety & Trust Model

Frameflow treats external agents as **collaborators inside strict deterministic guardrails**:

1. **Pre-Flight Linting (`lintOps`) & Dry-Run (`--dry-run` / `dryRun: true`)**  
   Every op is trial-run on an in-memory project copy before anything touches disk. Invalid targets, locked tracks/clips, out-of-range timestamps, or missing assets fail cleanly with structured diagnostics (`opIndex`, `code`, `message`, `repairable`) and **zero partial writes**.
2. **Deterministic Destructive Confirmation Gate (`needsConfirm`)**  
   Risk evaluation is never delegated to the LLM. Local rules in `src/ai/diff.js` automatically block and return `CONFIRM_REQUIRED` unless `--allow-destructive` / `allowDestructive: true` is explicitly passed for:
   - Removing `>= 3` video clips
   - Changing total duration by `> 20%` and at least `2` seconds
   - Changing color grading or transitions across all clips
   - Unlocking locked clips (`unlock`)
   - Clearing captions (`clearCaptions`)
   - Changing project aspect ratio (`setProject` with `aspect`)
3. **Atomic Writes, `.bak.ffproj` Backups & Instant `Ctrl+Z` Undo**  
   Every save writes to a same-directory temporary file, flushes with `fsync`, and atomically replaces the target via `renameSync` (with transient Windows lock retries). Before overwriting an existing valid `.ffproj`, Frameflow writes an atomic backup to `<name>.bak.ffproj` and stamps `meta.lastAgentEdit` (`agent`, `label`, `at`, `opCount`, `summary`). When Frameflow Desktop is open, Live Watch pushes the update onto the undo stack so one `Ctrl+Z` reverses the entire agent batch.
4. **Local Path & Network Hardening**  
   - **UNC & Windows Path Guards:** `electron/lib/urlSafety.cjs` (`isUncPath`) rejects UNC network paths (`\\server\share`, `//host/share`, `\\.\` / `\\?\` device prefixes), null bytes, NTFS Alternate Data Streams (`:`), trailing dots/spaces, and symlinks/junctions targeting UNC paths **before any `fs.*` call**.
   - **Zero Shell Execution:** Neither the MCP server nor the core engine invokes a shell (`shell: false`).
   - **Zero-Key Stock Isolation:** Stock search is restricted to open-license zero-key providers (`commons`, `openverse`, `archive`, `nasa`) with SSRF protection; no personal API keys or third-party logins are exposed.
   - **100% Local-First:** Zero accounts, zero telemetry, zero cloud project storage.
