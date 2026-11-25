#!/usr/bin/env node
// Frameflow Ultra-Thin Opt-In Stdio MCP Server (JSON-RPC 2.0, zero npm dependencies).
//
// Design:
// - Pure Node ESM (>=22), zero external deps, zero shell execution, zero fs.unlink/rm.
// - Rejects UNC/network paths, device prefixes, NTFS ADS, and trailing dots/spaces BEFORE any fs.* call.
// - Supports BOTH Content-Length (LSP/MCP) framing AND newline-delimited JSON-RPC 2.0 (ndjson) on stdin,
//   mirroring the client's framing on stdout while logging diagnostics strictly to stderr.
// - Supports --readonly to disable mutating tools (frameflow_apply_ops, frameflow_storyboard, and export-srt outPath).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import {
  ASPECTS,
  BLEND_MODES,
  CANVAS_TYPES,
  CAPTION_STYLES,
  COLOR_KEYS,
  FIT_MODES,
  FX_KEYS,
  LIMITS,
  LOOKS,
  MASK_SHAPES,
  MOTIONS,
  OVERLAY_KINDS,
  PROJECT_VERSION,
  SPEED_CURVE_PRESETS,
  TEXT_ANIMATIONS,
  TEXT_PRESETS,
  TRANSITIONS,
  createBrief,
  createProject,
  createSettings,
  isCaptionText,
} from '../src/engine/model.js';
import { loadProject } from '../src/engine/migrations.js';
import { EXT_OPS, OP_TYPES, PASTE_KEYS, applyOps } from '../src/engine/ops.js';
import { projectSummary } from '../src/engine/summary.js';
import { layoutVideo, overlayDuration, projectDuration, trackFlags } from '../src/engine/timeline.js';
import { buildFirstCut } from '../src/engine/firstcut.js';
import { textsToSrt } from '../src/engine/captions.js';
import { EASES, KEY_PATHS } from '../src/engine/keyframes.js';
import { diffProject, needsConfirm, summarizeDiff } from '../src/ai/diff.js';
import { lintOps } from '../src/ai/lint.js';
import { extractBriefPatch, localDirectorReply, localStoryboard } from '../src/ai/localDirector.js';

const require = createRequire(import.meta.url);
const urlSafety = require('../electron/lib/urlSafety.cjs');
const webIpc = require('../electron/ipc/web.cjs');

// Ensure stdout stays strictly pure JSON-RPC 2.0 even if anything invokes console.log.
const logErr = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  process.stderr.write(`[frameflow-mcp] ${line}\n`);
};
console.log = logErr;
console.info = logErr;
console.warn = logErr;
console.error = logErr;

const SERVER_INFO = Object.freeze({ name: 'frameflow', version: '2.1.0' });
const PROTOCOL_VERSION = '2024-11-05';
const MAX_PROJECT_BYTES = 200 * 1024 * 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write(
    [
      'Frameflow Thin MCP Server (stdio JSON-RPC 2.0)',
      'Usage: node bin/frameflow-mcp.mjs [--readonly]',
      '',
      'Options:',
      '  --readonly   Disable mutating tools (frameflow_apply_ops, frameflow_storyboard, and file output in frameflow_export_srt)',
      '  --version    Print server version and exit',
      '  --help       Show this help text',
    ].join('\n') + '\n',
  );
  process.exit(0);
}
if (argv.includes('--version') || argv.includes('-v')) {
  process.stderr.write(`${SERVER_INFO.name} ${SERVER_INFO.version}\n`);
  process.exit(0);
}
const READONLY = argv.includes('--readonly') || argv.includes('--read-only');

// ---------------------------------------------------------------------------
// Path safety & atomic file I/O (zero unlink/rm in production code)
// ---------------------------------------------------------------------------
function isUncLinkTarget(target) {
  if (typeof target !== 'string' || !target) return false;
  if (/^[\\/]\?\?[\\/]unc(?:[\\/]|$)/i.test(target)) return true;
  if (/^[\\/]{2}[.?][\\/]unc(?:[\\/]|$)/i.test(target)) return true;
  if (/^[\\/]{2}\.[\\/]/i.test(target)) return true;
  const extendedDrive = /^(?:\\\\\?|\\\?\?)\\([A-Za-z]:[\\/].*)$/.exec(target);
  if (extendedDrive) {
    return urlSafety.isUncPath(extendedDrive[1]);
  }
  if (/^[\\/]\?\?[\\/]/i.test(target)) return true;
  if (/^[\\/]{2}\?[\\/]/i.test(target)) return true;
  return urlSafety.isUncPath(target);
}

function assertSafeLocalPath(rawPath, label = 'filePath') {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (rawPath.includes('\0')) {
    throw new Error(`UNSAFE_PATH: ${label} contains an invalid null byte`);
  }
  if (rawPath !== rawPath.trim()) {
    throw new Error(`UNSAFE_PATH: Leading or trailing whitespace rejected (${label})`);
  }
  if (urlSafety.isUncPath(rawPath) || /^[\\/]\?\?[\\/]/i.test(rawPath)) {
    throw new Error(`UNC / network paths are rejected for security (${label})`);
  }
  const afterDrive = /^[A-Za-z]:/.test(rawPath) ? rawPath.slice(2) : rawPath;
  if (afterDrive.includes(':')) {
    throw new Error(`UNSAFE_PATH: Invalid colon / NTFS alternate data stream rejected (${label})`);
  }
  const segments = afterDrive.split(/[\\/]+/).filter(Boolean);
  for (const seg of segments) {
    if (seg !== '.' && seg !== '..' && /[. ]$/.test(seg)) {
      throw new Error(`UNSAFE_PATH: Trailing dot or space rejected in path segment (${label})`);
    }
  }
  const resolved = path.resolve(rawPath);
  if (urlSafety.isUncPath(resolved) || /^[\\/]\?\?[\\/]/i.test(resolved)) {
    throw new Error(`Resolved path is a UNC / network path and is rejected (${label})`);
  }
  return resolved;
}

function assertNoUncSymlink(resolvedPath) {
  const parsed = path.parse(resolvedPath);
  const root = parsed.root;
  const rel = resolvedPath.slice(root.length);
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  const candidates = [];
  if (root) candidates.push(root);
  let cur = root;
  for (const part of parts) {
    cur = cur ? path.join(cur, part) : part;
    candidates.push(cur);
  }

  for (const segPath of candidates) {
    let lst;
    try {
      lst = fs.lstatSync(segPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      const e = new Error(`UNSAFE_PATH: Cannot inspect path segment (${err && err.code ? err.code : 'ERR'}): ${segPath}`);
      e.code = 'UNSAFE_PATH';
      throw e;
    }
    if (lst.isSymbolicLink()) {
      let hop = segPath;
      for (let depth = 0; depth < 16; depth += 1) {
        let linkTarget;
        try {
          linkTarget = fs.readlinkSync(hop);
        } catch (err) {
          const e = new Error(`UNSAFE_PATH: Failed to read symlink target (${err && err.code ? err.code : 'ERR'}): ${hop}`);
          e.code = 'UNSAFE_PATH';
          throw e;
        }
        if (isUncLinkTarget(linkTarget)) {
          const e = new Error('Symlink/junction resolving to a UNC network path is rejected');
          e.code = 'UNC_PATH';
          throw e;
        }
        const cleanedTarget = linkTarget.replace(/^(?:\\\\\?|\\\?\?)\\(?=[A-Za-z]:[\\/])/, '');
        const nextHop = path.resolve(path.dirname(hop), cleanedTarget);
        if (isUncLinkTarget(nextHop)) {
          const e = new Error('Symlink/junction resolving to a UNC network path is rejected');
          e.code = 'UNC_PATH';
          throw e;
        }
        let nextSt;
        try {
          nextSt = fs.lstatSync(nextHop);
        } catch (err) {
          const e = new Error(`UNSAFE_PATH: Dangling or unresolvable symlink rejected (${err && err.code ? err.code : 'ERR'}): ${segPath}`);
          e.code = 'UNSAFE_PATH';
          throw e;
        }
        if (!nextSt.isSymbolicLink()) break;
        if (depth === 15) {
          const e = new Error(`UNSAFE_PATH: Symlink chain too deep (possible loop): ${segPath}`);
          e.code = 'UNSAFE_PATH';
          throw e;
        }
        hop = nextHop;
      }

      let real;
      try {
        real = fs.realpathSync.native(segPath);
      } catch (err) {
        const e = new Error(`UNSAFE_PATH: Unresolvable symlink rejected (${err && err.code ? err.code : 'ERR'}): ${segPath}`);
        e.code = 'UNSAFE_PATH';
        throw e;
      }
      if (isUncLinkTarget(real)) {
        const e = new Error('Resolved real path points to a UNC network path and is rejected');
        e.code = 'UNC_PATH';
        throw e;
      }
    }
  }
}

function backupPathFor(filePath) {
  return /\.ffproj$/i.test(filePath)
    ? filePath.replace(/\.ffproj$/i, '.bak.ffproj')
    : `${filePath}.bak.ffproj`;
}

let tmpWriteSeq = 0;

async function atomicWriteText(targetPath, content) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  assertNoUncSymlink(dir);
  // Unique per-write temp file opened with exclusive 'wx' + fsyncSync + atomic renameSync (zero unlink/rm, concurrent-safe).
  const seq = (tmpWriteSeq += 1);
  const rand = crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${seq}.${rand}.fftmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'wx');
    const buf = Buffer.from(String(content), 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset);
    }
    try {
      fs.fsyncSync(fd);
    } catch (syncErr) {
      if (!syncErr || (syncErr.code !== 'EINVAL' && syncErr.code !== 'ENOTSUP' && syncErr.code !== 'EROFS')) {
        throw syncErr;
      }
    }
    fs.closeSync(fd);
    fd = null;
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    throw err;
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      const transient = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
      if (!transient || attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
    }
  }
}

async function createBackupIfValid(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const st = fs.statSync(filePath);
  if (!st.isFile() || st.size > MAX_PROJECT_BYTES) return null;
  const rawText = fs.readFileSync(filePath, 'utf8');
  JSON.parse(rawText.replace(/^\uFEFF/, ''));
  const bakPath = backupPathFor(filePath);
  await atomicWriteText(bakPath, rawText);
  return bakPath;
}

function readAndLoadProject(rawFilePath) {
  const resolved = assertSafeLocalPath(rawFilePath, 'filePath');
  assertNoUncSymlink(resolved);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Project file not found: ${resolved}`);
  }
  const st = fs.statSync(resolved);
  if (!st.isFile()) {
    throw new Error(`Path is not a file: ${resolved}`);
  }
  if (st.size > MAX_PROJECT_BYTES) {
    throw new Error(`Project file exceeds maximum allowed size (${MAX_PROJECT_BYTES} bytes)`);
  }
  const text = fs.readFileSync(resolved, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`Invalid JSON in project file: ${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Project file root must be a JSON object');
  }
  const loaded = loadProject(raw);
  return { resolved, raw, ...loaded };
}

function r3(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

// ---------------------------------------------------------------------------
// Ops schema catalog (grounded directly in src/engine/ops.js & model.js)
// ---------------------------------------------------------------------------
const GLOBAL_OPS = ['insertAsset', 'addText', 'updateText', 'removeText', 'addAudio', 'updateAudio', 'removeAudio', 'setProject'];
const EXT_SET = new Set(EXT_OPS);
const GLOBAL_SET = new Set(GLOBAL_OPS);
const CLIP_OPS = OP_TYPES.filter((t) => !GLOBAL_SET.has(t) && !EXT_SET.has(t));

function buildOpsSchemaPayload() {
  return {
    ok: true,
    projectVersion: PROJECT_VERSION,
    opCount: OP_TYPES.length,
    opTypes: OP_TYPES,
    categories: {
      clipOps: CLIP_OPS,
      globalOps: GLOBAL_OPS,
      extOps: EXT_OPS,
    },
    targetingNotes: [
      'Headless CLI/MCP has no UI selection (selectedClipIds is empty). Always specify explicit targets for clipOps.',
      'Valid target shapes: { mode: "index", indices: [1, 2] } (1-based), { mode: "ids", ids: ["clp_..."] }, or { mode: "all" }.',
      'extOps locate clips via id, ids, at (seconds), or fallback target.',
      'First clip (index 1) transitionIn.type only accepts: cut, dip-black, dip-white, crossfade.',
    ],
    enums: {
      aspects: Object.keys(ASPECTS),
      looks: LOOKS,
      motions: MOTIONS,
      transitions: TRANSITIONS,
      fxKeys: FX_KEYS,
      colorKeys: COLOR_KEYS,
      captionStyles: CAPTION_STYLES,
      textPresets: TEXT_PRESETS,
      textAnimations: TEXT_ANIMATIONS,
      blendModes: BLEND_MODES,
      fitModes: FIT_MODES,
      canvasTypes: CANVAS_TYPES,
      maskShapes: MASK_SHAPES,
      overlayKinds: OVERLAY_KINDS,
      speedCurvePresets: Object.keys(SPEED_CURVE_PRESETS),
      keyPaths: KEY_PATHS,
      eases: EASES,
      pasteKeys: PASTE_KEYS,
      audioRoles: ['music', 'sfx', 'voice'],
      pacing: ['slow', 'medium', 'fast'],
      targetModes: ['index', 'ids', 'all', 'range', 'selected', 'none'],
      limits: LIMITS,
    },
    examples: {
      colorAndLook: [
        { type: 'setLook', target: { mode: 'index', indices: [1] }, look: 'cinematic', lookStrength: 0.85 },
        { type: 'setColor', target: { mode: 'index', indices: [1] }, color: { exposure: 0.1, contrast: 0.15, temperature: 0.15, vignette: 0.25 }, relative: false },
        { type: 'harmonize', target: { mode: 'all' }, strength: 0.6 },
        { type: 'matchColor', target: { mode: 'index', indices: [2] }, reference: { luma: 0.5, contrast: 0.4, saturation: 0.35, warmth: 0.05 }, strength: 0.8 },
      ],
      motionTransformFx: [
        { type: 'setMotion', target: { mode: 'index', indices: [1] }, preset: 'push-in', intensity: 0.5 },
        { type: 'setTransform', target: { mode: 'index', indices: [1] }, transform: { scale: 1.08, x: 0, y: 0, rotation: 0, flipH: false } },
        { type: 'setFx', target: { mode: 'index', indices: [1] }, fx: { grain: 0.2, letterbox: 0.5 }, relative: false },
        { type: 'setClipProps', id: 'clp_example', patch: { reverse: false, opacity: 1, blend: 'normal', fit: 'cover', mirror: { h: false, v: false }, crop: { l: 0, t: 0, r: 0, b: 0 } } },
        { type: 'pasteAttributes', from: 'clp_1', toIds: ['clp_2'], keys: ['color', 'fx', 'motion'] },
      ],
      timingTransitionsAndStructure: [
        { type: 'setTransition', target: { mode: 'index', indices: [2] }, transition: { type: 'crossfade', duration: 0.5 } },
        { type: 'setTransitionAll', transition: 'crossfade', duration: 0.4 },
        { type: 'trim', target: { mode: 'index', indices: [1] }, in: 0.5, out: 4.5, relative: false },
        { type: 'setDuration', target: { mode: 'index', indices: [1] }, duration: 3.5 },
        { type: 'setSpeed', target: { mode: 'index', indices: [1] }, speed: 1.5 },
        { type: 'setSpeedCurve', id: 'clp_example', preset: 'hero' },
        { type: 'applyPacing', target: { mode: 'all' }, pacing: 'fast' },
        { type: 'split', at: 2.0, target: { mode: 'index', indices: [1] } },
        { type: 'freezeFrame', at: 1.5, duration: 2.0 },
        { type: 'duplicate', target: { mode: 'index', indices: [1] } },
        { type: 'move', target: { mode: 'index', indices: [2] }, toIndex: 1 },
        { type: 'delete', target: { mode: 'index', indices: [2] } },
        { type: 'rippleDelete', ids: ['clp_example'] },
        { type: 'roll', at: 4.0, delta: 0.5 },
        { type: 'slip', id: 'clp_example', delta: 0.5 },
        { type: 'slide', id: 'clp_example', delta: -0.5 },
        { type: 'trimLeft', at: 1.0 },
        { type: 'trimRight', at: 3.0 },
        { type: 'insertAsset', assetId: 'ast_example', atIndex: 2, duration: 4.0 },
        { type: 'replaceAsset', target: { mode: 'index', indices: [1] }, assetId: 'ast_example' },
        { type: 'lock', target: { mode: 'index', indices: [1] } },
        { type: 'unlock', target: { mode: 'index', indices: [1] } },
      ],
      textAndCaptions: [
        { type: 'setCaption', target: { mode: 'index', indices: [1] }, caption: { text: 'Opening hook', style: 'subtitle', position: 'bottom' } },
        { type: 'addText', text: { text: 'Chapter 1', preset: 'title', start: 0, duration: 3, x: 0.5, y: 0.5, size: 1, color: '#ffffff', animation: 'fade' } },
        { type: 'updateText', textId: 'txt_example', text: { text: 'Updated title', y: 0.85 } },
        { type: 'removeText', textId: 'txt_example' },
        { type: 'addCaptions', preset: 'subtitle', segments: [{ start: 0, end: 2.5, text: 'First subtitle line' }] },
        { type: 'updateCaptionStyle', patch: { color: '#ffeb3b', size: 1.0 } },
        { type: 'clearCaptions' },
      ],
      audioAndBeats: [
        { type: 'setVolume', target: { mode: 'index', indices: [1] }, volume: 0.8, mute: false, audioFadeIn: 0.3, audioFadeOut: 0.5 },
        { type: 'addAudio', audio: { assetId: 'ast_music', start: 0, volume: 0.6, fadeIn: 0.5, fadeOut: 1.0, role: 'music' } },
        { type: 'updateAudio', audioId: 'aud_example', audio: { volume: 0.4 } },
        { type: 'removeAudio', audioId: 'aud_example' },
        { type: 'autoDuck', amount: 0.25, attack: 0.2, release: 0.4 },
        { type: 'detachAudio', id: 'clp_example' },
        { type: 'snapCutsToBeats' },
      ],
      overlaysKeyframesMarkersTracksProject: [
        { type: 'addOverlay', assetId: 'ast_logo', track: 1, start: 0.5 },
        { type: 'updateOverlay', id: 'ovl_example', patch: { opacity: 0.9, transform: { scale: 0.35, x: 0.35, y: -0.35 } } },
        { type: 'removeOverlay', id: 'ovl_example' },
        { type: 'setKeyframe', target: 'clip', id: 'clp_example', path: 'transform.scale', t: 0, v: 1.0, ease: 'ease' },
        { type: 'removeKeyframe', target: 'clip', id: 'clp_example', path: 'transform.scale', t: 0 },
        { type: 'addMarker', t: 3.0, label: 'Beat Drop', color: '#c8e250' },
        { type: 'updateMarker', id: 'mrk_example', patch: { label: 'Chorus', t: 3.5 } },
        { type: 'removeMarker', id: 'mrk_example' },
        { type: 'setTrack', track: 'audio', patch: { muted: false, locked: false } },
        { type: 'setProject', settings: { aspect: '9:16', fps: 30, background: '#000000', linked: true } },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Tool definitions (6 minimal, strictly typed tools)
// ---------------------------------------------------------------------------
const ALL_TOOLS = [
  {
    name: 'frameflow_inspect',
    description: 'Load and migrate a Frameflow .ffproj project file, returning a compact text summary plus structured clips, texts, audios, overlays, markers, assets, and storyboard.',
    readonly: true,
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Local path to a .ffproj project file (UNC paths rejected).' },
        focus: {
          type: 'object',
          description: 'Optional time span in seconds to focus summary detail on.',
          properties: {
            start: { type: 'number', minimum: 0 },
            end: { type: 'number', minimum: 0 },
          },
          required: ['start', 'end'],
          additionalProperties: false,
        },
      },
      required: ['filePath'],
      additionalProperties: false,
    },
  },
  {
    name: 'frameflow_ops_schema',
    description: 'Return all 55 supported Frameflow Ops (OP_TYPES), enums, limits, targeting notes, and categorized JSON examples before calling frameflow_apply_ops.',
    readonly: true,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'frameflow_apply_ops',
    description: 'Validate (lintOps), execute (applyOps), diff (diffProject), safety-check (needsConfirm), and atomically write an edit batch to a .ffproj file with .bak.ffproj backup and meta.lastAgentEdit metadata. Always validate with dryRun: true first.',
    readonly: false,
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Local path to the target .ffproj file.' },
        ops: {
          type: 'array',
          description: 'Ordered list of Frameflow Op objects.',
          items: { type: 'object' },
          minItems: 1,
        },
        dryRun: { type: 'boolean', description: 'If true, validate and preview diff without writing to disk.', default: false },
        allowDestructive: { type: 'boolean', description: 'Allow edits flagged by the local destructive safety gate (only set true after explicit user confirmation).', default: false },
        label: { type: 'string', description: 'Short human-readable summary of this edit batch.' },
        agent: { type: 'string', description: 'Identifier of the calling agent (recorded in meta.lastAgentEdit).' },
      },
      required: ['filePath', 'ops'],
      additionalProperties: false,
    },
  },
  {
    name: 'frameflow_storyboard',
    description: 'Generate a structured creative brief, shot-by-shot storyboard, and optional first-cut timeline (with previz placeholders) into a .ffproj file (creates the project if absent).',
    readonly: false,
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Local path to target .ffproj file (created if it does not exist).' },
        brief: { type: 'string', description: 'Creative brief text (topic, mood, style, platform, key message).' },
        duration: { type: 'number', minimum: 5, maximum: 600, description: 'Target total duration in seconds (5..600).' },
        aspect: { type: 'string', enum: Object.keys(ASPECTS), description: 'Target aspect ratio.' },
        firstCut: { type: 'boolean', description: 'If true, assemble a first-cut timeline with previz placeholders.', default: false },
        agent: { type: 'string', description: 'Identifier of the calling agent.' },
      },
      required: ['filePath', 'brief'],
      additionalProperties: false,
    },
  },
  {
    name: 'frameflow_stock_search',
    description: 'Search zero-API-key open-license stock media sources (Wikimedia Commons, Openverse, Internet Archive, NASA) for video, image, or audio assets.',
    readonly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (English keywords yield the widest coverage).' },
        kind: { type: 'string', enum: ['video', 'image', 'audio'], description: 'Media type to search.', default: 'video' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Maximum results to return (1..30).', default: 8 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'frameflow_export_srt',
    description: 'Export project captions as an SRT subtitle string (respects hidden text track) and optionally write atomically to outPath (file write disabled in --readonly mode).',
    readonly: true,
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Local path to the .ffproj project file.' },
        outPath: { type: 'string', description: 'Optional local .srt output path to write atomically (disabled in --readonly mode).' },
      },
      required: ['filePath'],
      additionalProperties: false,
    },
  },
];

function visibleTools() {
  return ALL_TOOLS
    .filter((t) => !READONLY || t.readonly)
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------
async function handleInspect(args = {}) {
  const { resolved, project, migrated, repairs, notes } = readAndLoadProject(args.filePath);
  const focus = args.focus && typeof args.focus === 'object'
    ? { start: Number(args.focus.start), end: Number(args.focus.end) }
    : undefined;
  const layout = layoutVideo(project);
  const duration = r3(projectDuration(project, layout));
  const summary = projectSummary(project, focus ? { focus } : {});

  const clips = layout.map(({ clip, index, start, end, duration: dur }) => ({
    index: index + 1,
    id: clip.id,
    assetId: clip.assetId,
    start: r3(start),
    end: r3(end),
    duration: r3(dur),
    in: r3(clip.in),
    out: r3(clip.out),
    speed: clip.speed,
    label: clip.label || '',
    look: clip.color ? clip.color.look : 'none',
    motion: clip.motion ? clip.motion.preset : 'none',
    transitionIn: clip.transitionIn || { type: 'cut', duration: 0.5 },
    caption: clip.caption && clip.caption.text ? clip.caption.text : '',
    volume: clip.volume,
    muted: !!(clip.muted || clip.mute),
    locked: !!clip.locked,
    still: !!clip.still,
    reverse: !!clip.reverse,
    shotId: clip.shotId || null,
  }));

  const texts = (project.tracks.text || []).map((t) => ({
    id: t.id,
    start: r3(t.start),
    duration: r3(t.duration),
    text: t.text,
    preset: t.preset,
    x: t.x,
    y: t.y,
    size: t.size,
    color: t.color,
    animation: t.animation,
    group: t.group || null,
    source: t.source || null,
    linkShotId: t.linkShotId || null,
    locked: !!t.locked,
  }));

  const audios = (project.tracks.audio || []).map((a) => ({
    id: a.id,
    assetId: a.assetId,
    start: r3(a.start),
    in: r3(a.in),
    out: r3(a.out),
    duration: r3(Math.max(0, (Number(a.out) || 0) - (Number(a.in) || 0))),
    volume: a.volume,
    fadeIn: a.fadeIn,
    fadeOut: a.fadeOut,
    role: a.role,
    muted: !!a.muted,
    locked: !!a.locked,
  }));

  const overlays = (project.overlays || []).map((o) => ({
    id: o.id,
    assetId: o.assetId,
    kind: o.kind,
    track: o.track,
    start: r3(o.start),
    in: r3(o.in),
    out: r3(o.out),
    duration: r3(overlayDuration(o)),
    speed: o.speed,
    opacity: o.opacity,
    blend: o.blend,
    locked: !!o.locked,
  }));

  const markers = (project.markers || []).map((m) => ({
    id: m.id,
    t: r3(m.t),
    label: m.label || '',
    color: m.color,
  }));

  const assets = Object.values(project.assets || {})
    .filter(Boolean)
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      name: a.name,
      path: a.path || null,
      duration: r3(a.duration),
      width: a.width,
      height: a.height,
      fps: a.fps,
      hasAudio: !!a.hasAudio,
      missing: !!a.missing,
      offline: !!a.offline,
      tags: Array.isArray(a.tags) ? a.tags : [],
      description: a.description || '',
    }));

  const storyboard = (project.storyboard || []).map((s) => ({
    index: s.index,
    id: s.id,
    title: s.title,
    duration: s.duration,
    shotSize: s.shotSize,
    angle: s.angle,
    movement: s.movement,
    look: s.look,
    transitionIn: s.transitionIn,
    caption: s.caption || '',
    status: s.status || 'planned',
    assetId: s.assetId || null,
  }));

  return {
    ok: true,
    filePath: resolved,
    id: project.id,
    name: project.name,
    version: project.version,
    migrated,
    repairs,
    migrationNotes: notes,
    updatedAt: project.updatedAt || null,
    meta: project.meta || null,
    settings: project.settings,
    duration,
    summary,
    trackState: project.trackState,
    clips,
    texts,
    audios,
    overlays,
    markers,
    assets,
    brief: project.brief || null,
    storyboard,
  };
}

async function handleOpsSchema() {
  return buildOpsSchemaPayload();
}

async function handleApplyOps(args = {}) {
  if (READONLY) {
    return {
      isError: true,
      payload: {
        ok: false,
        code: 'READONLY_MODE',
        error: 'Server is running in --readonly mode; frameflow_apply_ops is disabled.',
      },
    };
  }
  if (!Array.isArray(args.ops) || args.ops.length === 0) {
    return {
      isError: true,
      payload: { ok: false, code: 'INVALID_OPS', error: 'ops must be a non-empty array of Op objects.' },
    };
  }
  const dryRun = Boolean(args.dryRun);
  const allowDestructive = Boolean(args.allowDestructive);
  const { resolved, project: before } = readAndLoadProject(args.filePath);

  const ctx = { selectedClipIds: [], range: null, playhead: 0 };
  const lint = lintOps(before, args.ops, ctx);
  if (!lint.ok) {
    return {
      isError: true,
      payload: {
        ok: false,
        code: 'LINT_FAILED',
        dryRun,
        diagnostics: lint.diagnostics,
        validOpsCount: lint.ops.length,
        totalOpsCount: args.ops.length,
        error: `Validation failed on ${lint.diagnostics.length} of ${args.ops.length} op(s). No changes were written.`,
      },
    };
  }

  const applied = applyOps(before, args.ops, ctx);
  if (!applied.ok) {
    return {
      isError: true,
      payload: {
        ok: false,
        code: 'APPLY_FAILED',
        dryRun,
        errors: applied.errors,
        error: applied.errors.join('; ') || 'applyOps failed. No changes were written.',
      },
    };
  }

  const after = applied.project;
  const diff = diffProject(before, after);
  const diffSummary = summarizeDiff(diff);
  const confirm = needsConfirm({ ops: args.ops, before, after, diff });

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      filePath: resolved,
      applied: applied.applied,
      diffSummary,
      diff,
      needsConfirm: confirm.need,
      confirmReasons: confirm.reasons,
    };
  }

  if (confirm.need && !allowDestructive) {
    return {
      isError: true,
      payload: {
        ok: false,
        code: 'CONFIRM_REQUIRED',
        dryRun: false,
        filePath: resolved,
        needsConfirm: true,
        confirmReasons: confirm.reasons,
        diffSummary,
        diff,
        error: 'Blocked by Frameflow destructive safety gate. Present confirmReasons to the user and re-run with allowDestructive: true only after explicit user confirmation.',
      },
    };
  }

  const now = new Date().toISOString();
  const prevMeta = after.meta && typeof after.meta === 'object' ? after.meta : {};
  const lastAgentEdit = {
    agent: String(args.agent || 'mcp-agent').slice(0, 80),
    label: String(args.label || diffSummary[0] || `Apply ${args.ops.length} op(s)`).slice(0, 200),
    at: now,
    opCount: args.ops.length,
    summary: diffSummary,
    source: 'mcp',
  };
  const finalProject = {
    ...after,
    updatedAt: now,
    meta: { ...prevMeta, lastAgentEdit },
  };

  const backupPath = await createBackupIfValid(resolved);
  await atomicWriteText(resolved, JSON.stringify(finalProject, null, 2));

  return {
    ok: true,
    dryRun: false,
    filePath: resolved,
    backupPath,
    applied: applied.applied,
    diffSummary,
    diff,
    needsConfirm: confirm.need,
    confirmReasons: confirm.reasons,
    lastAgentEdit,
  };
}

async function handleStoryboard(args = {}) {
  if (READONLY) {
    return {
      isError: true,
      payload: {
        ok: false,
        code: 'READONLY_MODE',
        error: 'Server is running in --readonly mode; frameflow_storyboard is disabled.',
      },
    };
  }
  const briefText = typeof args.brief === 'string' ? args.brief.trim() : '';
  if (!briefText) {
    return {
      isError: true,
      payload: { ok: false, code: 'INVALID_BRIEF', error: 'brief must be a non-empty string.' },
    };
  }

  const resolved = assertSafeLocalPath(args.filePath, 'filePath');
  assertNoUncSymlink(resolved);

  let existed = false;
  let project;
  if (fs.existsSync(resolved)) {
    existed = true;
    project = readAndLoadProject(resolved).project;
  } else {
    const initialAspect = args.aspect && ASPECTS[args.aspect] ? args.aspect : '16:9';
    const baseName = path.basename(resolved, path.extname(resolved)) || 'Untitled Project';
    project = createProject({ name: baseName, aspect: initialAspect });
  }

  const extracted = extractBriefPatch(briefText);
  const director = localDirectorReply({ brief: project.brief, messages: [], userText: `${briefText} 直接出分镜` });
  const explicitDuration = Number.isFinite(Number(args.duration))
    ? Math.max(5, Math.min(600, Math.round(Number(args.duration))))
    : null;
  const explicitAspect = args.aspect && ASPECTS[args.aspect] ? args.aspect : null;

  const mergedBrief = createBrief({
    ...(project.brief || {}),
    ...(director.briefPatch || {}),
    ...extracted,
    ...(explicitDuration != null ? { duration: explicitDuration } : {}),
    ...(explicitAspect ? { aspect: explicitAspect } : {}),
  });
  if (!mergedBrief.title) mergedBrief.title = briefText.slice(0, 60);
  if (!mergedBrief.goal) mergedBrief.goal = briefText.slice(0, 400);

  const sb = localStoryboard(mergedBrief);
  const targetAspect = explicitAspect || (ASPECTS[mergedBrief.aspect] ? mergedBrief.aspect : project.settings.aspect);
  const nextSettings = {
    ...project.settings,
    ...createSettings(targetAspect),
    fps: project.settings.fps || 30,
    background: project.settings.background || '#000000',
  };

  let nextProject = {
    ...project,
    name: !existed && mergedBrief.title ? mergedBrief.title : project.name,
    settings: nextSettings,
    brief: mergedBrief,
    storyboard: sb.shots,
    memory: {
      styleGuide: '',
      decisions: [],
      colorBaseline: null,
      ...(project.memory || {}),
      styleGuide: sb.styleGuide || (project.memory && project.memory.styleGuide) || '',
    },
  };

  let firstCutReport = [];
  if (args.firstCut) {
    const fc = buildFirstCut(nextProject, { usePreviz: true });
    nextProject = fc.project;
    firstCutReport = fc.report || [];
  }

  const now = new Date().toISOString();
  const prevMeta = nextProject.meta && typeof nextProject.meta === 'object' ? nextProject.meta : {};
  const lastAgentEdit = {
    agent: String(args.agent || 'mcp-agent').slice(0, 80),
    label: args.firstCut ? `Storyboard (${sb.shots.length} shots) + First Cut` : `Storyboard (${sb.shots.length} shots)`,
    at: now,
    opCount: sb.shots.length,
    source: 'mcp',
  };
  nextProject = {
    ...nextProject,
    updatedAt: now,
    meta: { ...prevMeta, lastAgentEdit },
  };

  const backupPath = existed ? await createBackupIfValid(resolved) : null;
  await atomicWriteText(resolved, JSON.stringify(nextProject, null, 2));

  return {
    ok: true,
    created: !existed,
    filePath: resolved,
    backupPath,
    brief: mergedBrief,
    shotCount: sb.shots.length,
    shots: sb.shots.map((s) => ({
      index: s.index,
      id: s.id,
      title: s.title,
      duration: s.duration,
      shotSize: s.shotSize,
      angle: s.angle,
      movement: s.movement,
      look: s.look,
      transitionIn: s.transitionIn,
      caption: s.caption || '',
      referenceQueries: s.referenceQueries || [],
    })),
    styleGuide: sb.styleGuide,
    firstCut: Boolean(args.firstCut),
    firstCutReport,
    duration: r3(projectDuration(nextProject)),
    clipCount: (nextProject.tracks && nextProject.tracks.video ? nextProject.tracks.video.length : 0),
    lastAgentEdit,
  };
}

async function handleStockSearch(args = {}) {
  const query = typeof args.query === 'string' ? args.query.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  if (!query) {
    return {
      isError: true,
      payload: { ok: false, code: 'INVALID_QUERY', error: 'query must be a non-empty string.' },
    };
  }
  const kind = ['video', 'image', 'audio'].includes(args.kind) ? args.kind : 'video';
  const limit = Math.max(1, Math.min(30, Math.round(Number(args.limit) || 8)));
  const internals = webIpc && webIpc._internals;
  if (!internals || typeof internals.search !== 'function') {
    throw new Error('Stock search engine is unavailable.');
  }
  const freeSources = Array.isArray(internals.FREE_SOURCES)
    ? internals.FREE_SOURCES
    : ['commons', 'openverse', 'archive', 'nasa'];
  const ctx = { settings: { get: () => ({}), getSecret: () => '' } };
  const { results = [], errors = [] } = await internals.search(ctx, {
    query,
    kind,
    limit,
    sources: freeSources,
  });
  const sliced = results.slice(0, limit);
  return {
    ok: true,
    query,
    kind,
    limit,
    sources: freeSources,
    count: sliced.length,
    totalFound: results.length,
    results: sliced,
    errors,
  };
}

async function handleExportSrt(args = {}) {
  const { resolved, project } = readAndLoadProject(args.filePath);
  let outResolved = null;
  if (args.outPath !== undefined && args.outPath !== null && String(args.outPath).trim() !== '') {
    if (READONLY) {
      return {
        isError: true,
        payload: {
          ok: false,
          code: 'READONLY_MODE',
          error: 'Server is running in --readonly mode; writing outPath is disabled. Omit outPath to return SRT in memory.',
        },
      };
    }
    outResolved = assertSafeLocalPath(args.outPath, 'outPath');
    assertNoUncSymlink(outResolved);
  }

  const textHidden = trackFlags(project, 'text').hidden;
  const allTexts = (project.tracks && Array.isArray(project.tracks.text)) ? project.tracks.text : [];
  const captionList = textHidden
    ? []
    : allTexts.filter((t) => isCaptionText(t) && String(t.text || '').trim());
  const srt = textsToSrt(captionList);

  if (outResolved) {
    await atomicWriteText(outResolved, srt);
  }

  return {
    ok: true,
    filePath: resolved,
    outPath: outResolved,
    textTrackHidden: textHidden,
    cueCount: captionList.length,
    nonCaptionTextCount: textHidden ? 0 : allTexts.filter((t) => !isCaptionText(t) && String(t && t.text || '').trim()).length,
    srt,
  };
}

const TOOL_HANDLERS = {
  frameflow_inspect: handleInspect,
  frameflow_ops_schema: handleOpsSchema,
  frameflow_apply_ops: handleApplyOps,
  frameflow_storyboard: handleStoryboard,
  frameflow_stock_search: handleStockSearch,
  frameflow_export_srt: handleExportSrt,
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 dispatcher
// ---------------------------------------------------------------------------
function writeFrame(message, framing) {
  const body = JSON.stringify(message);
  if (framing === 'content-length') {
    const bytes = Buffer.byteLength(body, 'utf8');
    process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${body}`);
  } else {
    process.stdout.write(`${body}\n`);
  }
}

function sendResult(id, result, framing) {
  writeFrame({ jsonrpc: '2.0', id, result }, framing);
}

function sendError(id, code, message, framing, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  writeFrame({ jsonrpc: '2.0', id, error: err }, framing);
}

async function handleMessage(msg, framing) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    sendError(null, -32600, 'Invalid Request', framing);
    return;
  }
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  const id = hasId ? msg.id : undefined;
  const method = msg.method;

  if (msg.jsonrpc !== '2.0' || typeof method !== 'string') {
    if (hasId) sendError(id, -32600, 'Invalid JSON-RPC 2.0 request', framing);
    return;
  }

  // Notifications have no id and must NOT receive a response.
  if (!hasId) {
    if (method === 'notifications/initialized' || method === 'initialized' || method === 'notifications/cancelled') {
      return;
    }
    return;
  }

  try {
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
        }, framing);
        return;

      case 'ping':
        sendResult(id, {}, framing);
        return;

      case 'tools/list':
        sendResult(id, { tools: visibleTools() }, framing);
        return;

      case 'tools/call': {
        const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
        const name = params.name;
        const toolArgs = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name)) {
          sendError(id, -32602, `Unknown tool: ${String(name)}`, framing);
          return;
        }
        try {
          const out = await TOOL_HANDLERS[name](toolArgs);
          if (out && typeof out === 'object' && out.isError === true && out.payload) {
            sendResult(id, {
              content: [{ type: 'text', text: JSON.stringify(out.payload, null, 2) }],
              isError: true,
            }, framing);
          } else {
            sendResult(id, {
              content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
              isError: false,
            }, framing);
          }
        } catch (err) {
          sendResult(id, {
            content: [{
              type: 'text',
              text: JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }, null, 2),
            }],
            isError: true,
          }, framing);
        }
        return;
      }

      default:
        sendError(id, -32601, `Method not found: ${method}`, framing);
        return;
    }
  } catch (err) {
    logErr('Unhandled error for method', method, err && err.stack ? err.stack : String(err));
    sendError(id, -32603, err && err.message ? err.message : 'Internal error', framing);
  }
}

// ---------------------------------------------------------------------------
// Dual-mode stdio transport: Content-Length (LSP/MCP) + newline-delimited JSON
// ---------------------------------------------------------------------------
let buffer = Buffer.alloc(0);
let stdinEnded = false;
let oversizedAbort = false;
let shuttingDown = false;
let queue = Promise.resolve();

function finishGracefully(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  queue.finally(() => {
    process.exitCode = code;
    if (process.stdout.writableEnded || process.stdout.destroyed) {
      try { process.stdin.unref(); } catch {}
      return;
    }
    process.stdout.write('', () => {
      try { process.stdin.unref(); } catch {}
    });
  });
}

function enqueueRaw(jsonText, framing) {
  queue = queue.then(async () => {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      sendError(null, -32700, `Parse error: ${err.message}`, framing);
      return;
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        await handleMessage(item, framing);
      }
      return;
    }
    await handleMessage(parsed, framing);
  }).catch((err) => {
    logErr('Queue error:', err && err.stack ? err.stack : String(err));
  });
}

function skipLeadingLineBreaks(buf) {
  let i = 0;
  while (i < buf.length && (buf[i] === 0x0d || buf[i] === 0x0a)) i += 1;
  return i > 0 ? buf.subarray(i) : buf;
}

function looksLikeHeaderBlock(buf) {
  // Check whether buffer starts with an ASCII header such as "Content-Length:" or "Content-Type:".
  const probeLen = Math.min(buf.length, 64);
  const head = buf.subarray(0, probeLen).toString('ascii');
  if (/^content-length\s*:/i.test(head) || /^content-type\s*:/i.test(head)) return true;
  // Partial prefix while streaming first chunk (e.g. "Content-")
  if (buf.length < 15 && 'content-length:'.startsWith(head.toLowerCase())) return true;
  if (buf.length < 13 && 'content-type:'.startsWith(head.toLowerCase())) return true;
  return false;
}

function findHeaderTerminator(buf) {
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { headerEnd: crlf, bodyStart: crlf + 4 };
  }
  if (lf !== -1) {
    return { headerEnd: lf, bodyStart: lf + 2 };
  }
  return null;
}

function drainBuffer(flushEof = false) {
  while (buffer.length > 0 && !oversizedAbort) {
    buffer = skipLeadingLineBreaks(buffer);
    if (buffer.length === 0) break;

    if (looksLikeHeaderBlock(buffer)) {
      const term = findHeaderTerminator(buffer);
      if (!term) {
        if (buffer.length > MAX_HEADER_BYTES) {
          logErr('Header exceeded maximum size; discarding buffer');
          sendError(null, -32700, 'Header too large', 'content-length');
          buffer = Buffer.alloc(0);
        }
        break;
      }
      if (term.headerEnd > MAX_HEADER_BYTES) {
        logErr('Header exceeded maximum size; discarding buffer');
        sendError(null, -32700, 'Header too large', 'content-length');
        buffer = buffer.subarray(term.bodyStart);
        continue;
      }
      const headerText = buffer.subarray(0, term.headerEnd).toString('ascii');
      let contentLength = null;
      for (const line of headerText.split(/\r?\n/)) {
        const m = /^content-length\s*:\s*(\d+)\s*$/i.exec(line.trim());
        if (m) {
          contentLength = Number.parseInt(m[1], 10);
          break;
        }
      }
      if (!Number.isInteger(contentLength) || contentLength < 0 || contentLength > MAX_FRAME_BYTES) {
        sendError(null, -32700, 'Invalid Content-Length header', 'content-length');
        buffer = buffer.subarray(term.bodyStart);
        continue;
      }
      const totalNeeded = term.bodyStart + contentLength;
      if (buffer.length < totalNeeded) break;
      const bodyText = buffer.subarray(term.bodyStart, totalNeeded).toString('utf8');
      buffer = buffer.subarray(totalNeeded);
      enqueueRaw(bodyText, 'content-length');
      continue;
    }

    // Newline-delimited JSON-RPC 2.0 (ndjson)
    const nl = buffer.indexOf(0x0a);
    if (nl === -1) {
      if (buffer.length > MAX_MESSAGE_BYTES) {
        logErr(`NDJSON stream exceeded maximum message size (${MAX_MESSAGE_BYTES} bytes); rejecting and closing`);
        sendError(null, -32700, `Message too large (exceeds ${MAX_MESSAGE_BYTES} bytes)`, 'ndjson');
        buffer = Buffer.alloc(0);
        oversizedAbort = true;
        try { process.stdin.pause(); } catch {}
        try { process.stdin.destroy(); } catch {}
        finishGracefully(1);
        break;
      }
      if (flushEof) {
        const rest = buffer.toString('utf8').trim();
        buffer = Buffer.alloc(0);
        if (rest) enqueueRaw(rest, 'ndjson');
      }
      break;
    }
    if (nl > MAX_MESSAGE_BYTES) {
      logErr(`NDJSON line exceeded maximum message size (${MAX_MESSAGE_BYTES} bytes); rejecting`);
      sendError(null, -32700, `Message too large (exceeds ${MAX_MESSAGE_BYTES} bytes)`, 'ndjson');
      buffer = buffer.subarray(nl + 1);
      continue;
    }
    const lineText = buffer.subarray(0, nl).toString('utf8').trim();
    buffer = buffer.subarray(nl + 1);
    if (lineText) enqueueRaw(lineText, 'ndjson');
  }
}

process.stdin.on('data', (chunk) => {
  if (oversizedAbort) return;
  const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  buffer = buffer.length === 0 ? part : Buffer.concat([buffer, part]);
  drainBuffer(false);
});

process.stdin.on('end', () => {
  stdinEnded = true;
  if (!oversizedAbort) drainBuffer(true);
  finishGracefully(oversizedAbort ? 1 : 0);
});

process.stdin.on('error', (err) => {
  logErr('stdin error:', err && err.message ? err.message : String(err));
  if (!stdinEnded) {
    finishGracefully(1);
  }
});

process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') {
    process.exitCode = 0;
    try { process.stdin.pause(); process.stdin.unref(); } catch {}
    return;
  }
  logErr('stdout error:', err && err.message ? err.message : String(err));
});

process.stdin.resume();
