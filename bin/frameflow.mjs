#!/usr/bin/env node
/**
 * Frameflow Headless & Live-Watch CLI (zero-dependency Node ESM).
 *
 * Allows external coding agents (Claude Code, Antigravity, Codex CLI,
 * Gemini CLI, OpenCode, PI) and automation scripts to inspect, storyboard,
 * edit, break down, search stock media, and plan exports for `.ffproj` files.
 *
 * Exit codes:
 *   0 - success
 *   1 - runtime / I/O / external tool error
 *   2 - usage / validation / safety-gate rejection
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  ASPECTS,
  LOOKS,
  MOTIONS,
  TRANSITIONS,
  FX_KEYS,
  COLOR_KEYS,
  CAPTION_STYLES,
  TEXT_PRESETS,
  TEXT_ANIMATIONS,
  BLEND_MODES,
  FIT_MODES,
  CANVAS_TYPES,
  MASK_SHAPES,
  OVERLAY_KINDS,
  MARKER_COLORS,
  SPEED_CURVE_PRESETS,
  PROJECT_VERSION,
  createProject,
  createBrief,
  createSettings,
  normalizeProject,
  isCaptionText,
} from '../src/engine/model.js';
import { loadProject, CURRENT_VERSION } from '../src/engine/migrations.js';
import { OP_TYPES, EXT_OPS, PASTE_KEYS, applyOps } from '../src/engine/ops.js';
import { projectSummary } from '../src/engine/summary.js';
import { layoutVideo, projectDuration, trackFlags, overlayDuration } from '../src/engine/timeline.js';
import { KEY_PATHS, EASES } from '../src/engine/keyframes.js';
import { buildFirstCut } from '../src/engine/firstcut.js';
import { textsToSrt } from '../src/engine/captions.js';
import { creditsText, findRestrictedUsage, assetLicense } from '../src/engine/license.js';
import { diffProject, summarizeDiff, needsConfirm, CONFIRM_RULES } from '../src/ai/diff.js';
import { lintOps } from '../src/ai/lint.js';
import { extractBriefPatch, localStoryboard, detectTopic } from '../src/ai/localDirector.js';
import { buildAudioPlan } from '../src/export/audioPlan.js';
import { EXPORT_PRESETS, resolveExportOptions } from '../src/export/presets.js';
import {
  AI_LABEL_DEFAULT,
  aiAssetSummary,
  projectUsesAiLoose,
  buildAigcMeta,
  aigcMetaString,
} from '../src/export/aigc.js';

const require = createRequire(import.meta.url);
const urlSafety = require('../electron/lib/urlSafety.cjs');
const pathsLib = require('../electron/lib/paths.cjs');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, '..');

const MAX_STDIN_BYTES = 16 * 1024 * 1024;
const MAX_OPS_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_BYTES = 50 * 1024 * 1024;
const RETRY_WAIT_VIEW = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  try {
    Atomics.wait(RETRY_WAIT_VIEW, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function readPackageVersion() {
  try {
    const raw = fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(stripBom(raw));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '2.0.0';
  } catch {
    return '2.0.0';
  }
}

export const CLI_VERSION = readPackageVersion();

export class CliError extends Error {
  constructor(exitCode, message, details = null) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

function stripBom(str) {
  return typeof str === 'string' && str.charCodeAt(0) === 0xfeff ? str.slice(1) : String(str ?? '');
}

function round3(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

// ───────────────────────── Path Security & Atomic I/O ─────────────────────────

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

/**
 * Fail-closed root-to-leaf segment walk checking symlinks/junctions.
 * Stops cleanly on ENOENT (not-yet-created leaf/dir); fails closed on any other lstat error,
 * dangling/unresolvable symlink, symlink loop, or UNC / \??\UNC\ / device target.
 */
function assertNoUnsafeSymlink(resolvedPath, label = 'path') {
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
      throw new CliError(2, `Unsafe ${label} rejected (cannot inspect path segment ${segPath}: ${err && err.code ? err.code : String(err)})`, {
        code: 'UNSAFE_PATH',
      });
    }
    if (lst.isSymbolicLink()) {
      // Walk symlink chain via readlinkSync first so chained UNC targets are rejected before hitting the network.
      let hop = segPath;
      for (let depth = 0; depth < 16; depth += 1) {
        let linkTarget;
        try {
          linkTarget = fs.readlinkSync(hop);
        } catch (err) {
          throw new CliError(2, `Unsafe ${label} rejected (cannot read symlink ${hop}: ${err && err.code ? err.code : String(err)})`, {
            code: 'UNSAFE_PATH',
          });
        }
        if (isUncLinkTarget(linkTarget)) {
          throw new CliError(2, `Unsafe ${label} rejected (symlink/junction points to UNC/device path): ${resolvedPath}`, {
            code: 'UNC_PATH',
          });
        }
        const cleanedTarget = linkTarget.replace(/^(?:\\\\\?|\\\?\?)\\(?=[A-Za-z]:[\\/])/, '');
        const nextHop = path.resolve(path.dirname(hop), cleanedTarget);
        if (isUncLinkTarget(nextHop)) {
          throw new CliError(2, `Unsafe ${label} rejected (symlink/junction resolves to UNC/device path): ${resolvedPath}`, {
            code: 'UNC_PATH',
          });
        }
        let nextSt;
        try {
          nextSt = fs.lstatSync(nextHop);
        } catch (err) {
          throw new CliError(2, `Unsafe ${label} rejected (dangling or unresolvable symlink at ${segPath}: ${err && err.code ? err.code : String(err)})`, {
            code: 'UNSAFE_PATH',
          });
        }
        if (!nextSt.isSymbolicLink()) break;
        if (depth === 15) {
          throw new CliError(2, `Unsafe ${label} rejected (symlink loop or chain too deep): ${segPath}`, {
            code: 'UNSAFE_PATH',
          });
        }
        hop = nextHop;
      }

      let real;
      try {
        real = fs.realpathSync.native(segPath);
      } catch (err) {
        throw new CliError(2, `Unsafe ${label} rejected (unresolvable symlink at ${segPath}: ${err && err.code ? err.code : String(err)})`, {
          code: 'UNSAFE_PATH',
        });
      }
      if (isUncLinkTarget(real)) {
        throw new CliError(2, `Unsafe ${label} rejected (symlink real path points to UNC/device path): ${resolvedPath}`, {
          code: 'UNC_PATH',
        });
      }
    }
  }
}

/**
 * Validate and resolve a local filesystem path BEFORE any fs.* call.
 * Rejects empty strings, null bytes, leading/trailing whitespace, trailing dots/spaces in segments,
 * UNC / mixed-slash UNC / \??\ paths, device prefixes, NTFS ADS, and unsafe/UNC symlinks (fail-closed).
 */
export function assertSafePath(rawPath, cwd = process.cwd(), label = 'path') {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new CliError(2, `Missing or invalid ${label}`, { code: 'INVALID_PATH' });
  }
  if (rawPath.includes('\0')) {
    throw new CliError(2, `Unsafe ${label} rejected (null byte): ${rawPath}`, { code: 'UNSAFE_PATH' });
  }
  if (rawPath !== rawPath.trim()) {
    throw new CliError(2, `Unsafe ${label} rejected (leading or trailing whitespace not allowed): ${JSON.stringify(rawPath)}`, { code: 'UNSAFE_PATH' });
  }
  if (urlSafety.isUncPath(rawPath) || /^[\\/]\?\?[\\/]/i.test(rawPath)) {
    throw new CliError(2, `Unsafe ${label} rejected (UNC/network path not allowed): ${rawPath}`, { code: 'UNC_PATH' });
  }
  const afterDrive = /^[A-Za-z]:/.test(rawPath) ? rawPath.slice(2) : rawPath;
  if (process.platform === 'win32' && afterDrive.includes(':')) {
    throw new CliError(2, `Unsafe ${label} rejected (colon / NTFS alternate data stream not allowed): ${rawPath}`, { code: 'UNSAFE_PATH' });
  }
  const segments = afterDrive.split(/[\\/]+/).filter(Boolean);
  for (const seg of segments) {
    if (seg !== '.' && seg !== '..' && /[. ]$/.test(seg)) {
      throw new CliError(2, `Unsafe ${label} rejected (trailing dot or space in path segment): ${rawPath}`, { code: 'UNSAFE_PATH' });
    }
  }
  const baseCwd = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  if (urlSafety.isUncPath(baseCwd) || /^[\\/]\?\?[\\/]/i.test(baseCwd)) {
    throw new CliError(2, `Unsafe working directory rejected (UNC path not allowed): ${baseCwd}`, { code: 'UNC_PATH' });
  }
  const resolved = path.resolve(baseCwd, rawPath);
  if (urlSafety.isUncPath(resolved) || /^[\\/]\?\?[\\/]/i.test(resolved)) {
    throw new CliError(2, `Unsafe ${label} rejected (resolved to UNC path): ${rawPath}`, { code: 'UNC_PATH' });
  }
  assertNoUnsafeSymlink(resolved, label);
  return resolved;
}

/**
 * Atomically write UTF-8 text via a unique temp file (`wx`) + fsyncSync + renameSync with transient lock retries.
 * Uses zero unlink/rm APIs.
 */
export function atomicWriteFile(filePath, content, cwd = process.cwd()) {
  const resolved = assertSafePath(filePath, cwd, 'output path');
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      throw new CliError(2, `Target path is a directory, not a file: ${resolved}`, { code: 'IS_DIRECTORY' });
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
  }
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  fs.mkdirSync(dir, { recursive: true });
  assertNoUnsafeSymlink(dir, 'output directory');
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
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
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(tmpPath, resolved);
      return resolved;
    } catch (err) {
      const transient = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
      if (!transient || attempt === 4) throw err;
      sleepSync(40 * (attempt + 1));
    }
  }
  return resolved;
}

export function backupPathFor(resolvedProjectPath) {
  return resolvedProjectPath.replace(/\.ffproj$/i, '') + '.bak.ffproj';
}

export function readProjectFile(rawPath, cwd = process.cwd()) {
  const resolved = assertSafePath(rawPath, cwd, 'project file');
  let rawText;
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) {
      throw new CliError(2, `Project path is not a regular file: ${resolved}`, { code: 'NOT_A_FILE' });
    }
    if (st.size > MAX_PROJECT_BYTES) {
      throw new CliError(2, `Project file exceeds maximum allowed size (${MAX_PROJECT_BYTES} bytes): ${resolved}`, {
        code: 'PROJECT_TOO_LARGE',
        path: resolved,
        size: st.size,
        maxBytes: MAX_PROJECT_BYTES,
      });
    }
    rawText = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (err && err.code === 'ENOENT') {
      throw new CliError(1, `Project file not found: ${resolved}`, { code: 'ENOENT', path: resolved });
    }
    throw new CliError(1, `Failed to read project file: ${err && err.message ? err.message : String(err)}`, { path: resolved });
  }

  let parsed;
  try {
    parsed = JSON.parse(stripBom(rawText));
  } catch (err) {
    throw new CliError(1, `Invalid JSON in project file ${resolved}: ${err && err.message ? err.message : String(err)}`, { code: 'INVALID_JSON', path: resolved });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(1, `Project file must contain a JSON object: ${resolved}`, { code: 'INVALID_PROJECT', path: resolved });
  }
  const loaded = loadProject(parsed);
  return { resolved, rawText, ...loaded };
}

export function writeProjectFile(filePath, project, cwd = process.cwd()) {
  return atomicWriteFile(filePath, JSON.stringify(project, null, 2) + '\n', cwd);
}

// ───────────────────────── Argument Parsing ─────────────────────────

const GLOBAL_BOOL_FLAGS = new Set(['json', 'help', 'version']);

const COMMAND_SPECS = {
  init: {
    bools: ['force'],
    values: ['name', 'aspect', 'fps'],
    aliases: { h: 'help', v: 'version' },
  },
  inspect: {
    bools: [],
    values: ['focus'],
    aliases: { h: 'help', v: 'version' },
  },
  'ops-schema': {
    bools: [],
    values: [],
    aliases: { h: 'help', v: 'version' },
  },
  apply: {
    bools: ['stdin', 'dry-run', 'allow-destructive'],
    values: ['ops', 'ops-json', 'label', 'agent', 'playhead'],
    aliases: { h: 'help', v: 'version' },
  },
  storyboard: {
    bools: ['first-cut'],
    values: ['brief', 'duration', 'aspect', 'name', 'agent'],
    aliases: { h: 'help', v: 'version' },
  },
  breakdown: {
    bools: [],
    values: ['out', 'max-seconds'],
    aliases: { h: 'help', v: 'version' },
  },
  stock: {
    bools: [],
    values: ['kind', 'limit', 'sources', 'query-en'],
    aliases: { h: 'help', v: 'version' },
  },
  'export-srt': {
    bools: ['include-all-text'],
    values: ['out'],
    aliases: { h: 'help', v: 'version' },
  },
  'export-plan': {
    bools: [],
    values: ['preset'],
    aliases: { h: 'help', v: 'version' },
  },
  doctor: {
    bools: [],
    values: [],
    aliases: { h: 'help', v: 'version' },
  },
  help: {
    bools: [],
    values: [],
    aliases: { h: 'help', v: 'version' },
  },
};

export function parseArgs(argv = []) {
  const tokens = Array.isArray(argv) ? argv.map(String) : [];
  let command = null;
  let cmdIdx = -1;

  // Locate first non-flag token as command (respecting `--`)
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === '--') break;
    if (tok === '-h' || tok === '--help' || tok === '-v' || tok === '--version' || tok === '--json') continue;
    if (tok.startsWith('-')) {
      // Unknown global flag before command — defer to strict parse below
      break;
    }
    command = tok;
    cmdIdx = i;
    break;
  }

  const spec = (command && COMMAND_SPECS[command]) || { bools: [], values: [], aliases: { h: 'help', v: 'version' } };
  const boolSet = new Set([...GLOBAL_BOOL_FLAGS, ...spec.bools]);
  const valueSet = new Set(spec.values);
  const allFlagTokens = new Set([
    ...Array.from(boolSet, (k) => `--${k}`),
    ...Array.from(valueSet, (k) => `--${k}`),
    ...Object.keys(spec.aliases || {}).map((k) => `-${k}`),
  ]);

  const flags = {};
  const positionals = [];
  let stopFlags = false;

  for (let i = 0; i < tokens.length; i += 1) {
    if (i === cmdIdx) continue;
    const tok = tokens[i];
    if (stopFlags) {
      positionals.push(tok);
      continue;
    }
    if (tok === '--') {
      stopFlags = true;
      continue;
    }
    if (tok.startsWith('--') && tok.length > 2) {
      const eq = tok.indexOf('=');
      const rawName = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
      const inlineVal = eq >= 0 ? tok.slice(eq + 1) : undefined;
      if (boolSet.has(rawName)) {
        if (inlineVal !== undefined) {
          if (inlineVal === 'true' || inlineVal === '1') flags[rawName] = true;
          else if (inlineVal === 'false' || inlineVal === '0') flags[rawName] = false;
          else throw new CliError(2, `Boolean flag --${rawName} does not accept value "${inlineVal}"`, { code: 'INVALID_FLAG' });
        } else {
          flags[rawName] = true;
        }
        continue;
      }
      if (valueSet.has(rawName)) {
        if (inlineVal !== undefined) {
          flags[rawName] = inlineVal;
        } else {
          if (i + 1 >= tokens.length || allFlagTokens.has(tokens[i + 1])) {
            throw new CliError(2, `Missing value for option --${rawName}`, { code: 'MISSING_FLAG_VALUE' });
          }
          flags[rawName] = tokens[++i];
        }
        continue;
      }
      throw new CliError(2, `Unknown option: --${rawName}${command ? ` (for command "${command}")` : ''}`, { code: 'UNKNOWN_OPTION' });
    }
    if (tok.startsWith('-') && tok.length > 1) {
      const short = tok.slice(1);
      const mapped = spec.aliases && spec.aliases[short];
      if (mapped && boolSet.has(mapped)) {
        flags[mapped] = true;
        continue;
      }
      throw new CliError(2, `Unknown option: ${tok}${command ? ` (for command "${command}")` : ''}`, { code: 'UNKNOWN_OPTION' });
    }
    positionals.push(tok);
  }

  return { command, flags, positionals };
}

function parseFiniteNumber(raw, label, lo = -Infinity, hi = Infinity) {
  const n = Number(raw);
  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n)) {
    throw new CliError(2, `${label} must be a valid number (got "${raw}")`, { code: 'INVALID_NUMBER' });
  }
  if (n < lo || n > hi) {
    throw new CliError(2, `${label} must be between ${lo} and ${hi} (got ${n})`, { code: 'OUT_OF_RANGE' });
  }
  return n;
}

export function parseFocusRange(raw) {
  const s = String(raw || '').trim();
  const m = /^(\d+(?:\.\d+)?)\s*(?:\.\.|:)\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (!m) {
    throw new CliError(2, `Invalid --focus range "${raw}". Expected <start>..<end> or <start>:<end> in seconds (e.g. 0..15 or 0:15).`, { code: 'INVALID_FOCUS' });
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) {
    throw new CliError(2, `Invalid --focus range "${raw}": bounds must be non-negative numbers.`, { code: 'INVALID_FOCUS' });
  }
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

// ───────────────────────── Help & Schema Builders ─────────────────────────

export function formatHelp(topic = null) {
  const header = `Frameflow CLI v${CLI_VERSION} (project schema v${PROJECT_VERSION})`;
  const commandsHelp = {
    init: [
      'Usage: frameflow init <file.ffproj> [--name <name>] [--aspect 16:9|9:16|1:1|4:3|21:9] [--fps 30] [--force] [--json]',
      '',
      'Create a new normalized .ffproj project. Refuses to overwrite unless --force is passed.',
    ].join('\n'),
    inspect: [
      'Usage: frameflow inspect <file.ffproj> [--focus <start>..<end>|<start>:<end>] [--json]',
      '',
      'Load, normalize/migrate, and inspect a .ffproj timeline, tracks, assets, and summary.',
    ].join('\n'),
    'ops-schema': [
      'Usage: frameflow ops-schema [--json]',
      '',
      'List all supported edit operation types (OP_TYPES), enums, and categorized examples.',
    ].join('\n'),
    apply: [
      'Usage: frameflow apply <file.ffproj> (--ops <ops.json|-> | --ops-json \'<json>\' | --stdin) [--dry-run] [--allow-destructive] [--label "<msg>"] [--agent "<name>"] [--json]',
      '',
      'Validate (lintOps), atomically apply (applyOps), diff (diffProject), and safety-gate (needsConfirm) edit operations.',
      'Exits 2 without mutating if destructive confirmation is required and --allow-destructive is omitted.',
      'Creates <file>.bak.ffproj backup and stamps meta.lastAgentEdit on write.',
    ].join('\n'),
    storyboard: [
      'Usage: frameflow storyboard <file.ffproj> --brief "<prompt>" [--duration 30] [--aspect 16:9] [--name <name>] [--first-cut] [--agent "<name>"] [--json]',
      '',
      'Extract brief fields and generate a local storyboard (auto-creates .ffproj if absent, backs up existing .ffproj); with --first-cut also builds initial video/text tracks.',
    ].join('\n'),
    breakdown: [
      'Usage: frameflow breakdown <video-path> [--out <report.json>] [--max-seconds 600] [--json]',
      '',
      'Run headless shot boundary detection, pacing analysis, dominant color extraction, and beat detection.',
    ].join('\n'),
    stock: [
      'Usage: frameflow stock search "<query>" [--kind video|image|audio] [--limit 8] [--json]',
      '',
      'Search zero-key licensed stock sources (Wikimedia Commons, Openverse, Internet Archive, NASA).',
    ].join('\n'),
    'export-srt': [
      'Usage: frameflow export-srt <file.ffproj> [--out <file.srt>] [--include-all-text] [--json]',
      '',
      'Export SRT captions from visible text track (skips hidden text track; filters to captions by default unless --include-all-text is set).',
    ].join('\n'),
    'export-plan': [
      'Usage: frameflow export-plan <file.ffproj> [--preset youtube|douyin|bilibili|standard] [--json]',
      '',
      'Resolve export preset parameters, audio mix plan, AIGC compliance metadata, and license credits.',
    ].join('\n'),
    doctor: [
      'Usage: frameflow doctor [--json]',
      '',
      'Verify Node runtime, ffmpeg/ffprobe binaries & licenses, engine version, SKILL.md, and MCP server.',
    ].join('\n'),
  };

  if (topic && commandsHelp[topic]) {
    return `${header}\n\n${commandsHelp[topic]}\n`;
  }

  return [
    header,
    '',
    'Usage: frameflow <command> [arguments] [options]',
    '',
    'Commands:',
    '  init <file.ffproj>        Create a new normalized .ffproj project',
    '  inspect <file.ffproj>     Inspect timeline clips, tracks, assets, and summary',
    '  ops-schema                Print all OP_TYPES, enums, and categorized op examples',
    '  apply <file.ffproj>       Lint, gate, diff, and atomically apply edit operations',
    '  storyboard <file.ffproj>  Generate brief & storyboard (and optional --first-cut)',
    '  breakdown <video-path>    Headless shot boundaries, pacing, colors, and beat analysis',
    '  stock search "<query>"    Search zero-key licensed stock media (Commons/Openverse/Archive/NASA)',
    '  export-srt <file.ffproj>  Export SRT subtitles (respecting hidden text track)',
    '  export-plan <file.ffproj> Compute export options, audio mix plan, AIGC & license credits',
    '  doctor                    Check Node, ffmpeg/ffprobe, engine, SKILL.md, and MCP server',
    '',
    'Global Options:',
    '  --json                    Emit machine-readable JSON on stdout',
    '  -h, --help                Show help (use "<command> --help" for command details)',
    '  -v, --version             Show CLI and engine version',
    '',
    'Exit Codes:',
    '  0  Success',
    '  1  Runtime / I/O / external tool error',
    '  2  Usage / validation / safety-gate rejection',
    '',
  ].join('\n');
}

export function buildOpsSchema() {
  const categories = {
    videoClips: {
      title: 'Video Clips & Timeline Editing',
      ops: [
        'insertAsset', 'trim', 'setDuration', 'split', 'delete', 'duplicate', 'move',
        'replaceAsset', 'applyPacing', 'setClipProps', 'freezeFrame',
        'roll', 'slip', 'slide', 'rippleDelete', 'trimLeft', 'trimRight',
        'pasteAttributes', 'setProject',
      ],
      examples: [
        { type: 'insertAsset', assetId: '<assetId>', atIndex: 1, duration: 4 },
        { type: 'setDuration', target: { mode: 'index', indices: [1] }, duration: 3.5 },
        { type: 'trim', target: { mode: 'index', indices: [1] }, in: 0.5, out: 3.5, relative: false },
        { type: 'split', target: { mode: 'index', indices: [1] }, at: 1.5 },
        { type: 'move', target: { mode: 'index', indices: [2] }, toIndex: 1 },
        { type: 'duplicate', target: { mode: 'index', indices: [1] } },
        { type: 'delete', target: { mode: 'index', indices: [2] } },
        { type: 'rippleDelete', ids: ['<clipId>'] },
        { type: 'applyPacing', target: { mode: 'all' }, pacing: 'fast' },
        { type: 'setClipProps', id: '<clipId>', patch: { fit: 'cover', opacity: 0.9, reverse: false } },
        { type: 'freezeFrame', id: '<clipId>', at: 1.0, duration: 2.0 },
        { type: 'pasteAttributes', from: '<srcClipId>', toIds: ['<dstClipId>'], keys: ['color', 'fx'] },
        { type: 'setProject', settings: { aspect: '9:16', fps: 30, linked: true } },
      ],
    },
    colorAndLooks: {
      title: 'Color Grading, Looks, Motion, Transform & FX',
      ops: ['setColor', 'setLook', 'setMotion', 'setTransform', 'setFx', 'matchColor', 'harmonize'],
      examples: [
        { type: 'setColor', target: { mode: 'index', indices: [1] }, color: { exposure: 0.15, contrast: 0.1, saturation: 0.05, temperature: 0.1 }, relative: false },
        { type: 'setLook', target: { mode: 'all' }, look: 'cinematic', lookStrength: 0.8 },
        { type: 'setMotion', target: { mode: 'index', indices: [1] }, preset: 'push-in', intensity: 0.5 },
        { type: 'setTransform', target: { mode: 'index', indices: [1] }, transform: { scale: 1.1, x: 0, y: 0, rotation: 0, flipH: false } },
        { type: 'setFx', target: { mode: 'index', indices: [1] }, fx: { grain: 0.25, letterbox: 0.15 }, relative: false },
        { type: 'harmonize', target: { mode: 'all' }, strength: 0.6 },
      ],
    },
    transitions: {
      title: 'Transitions',
      ops: ['setTransition', 'setTransitionAll'],
      examples: [
        { type: 'setTransition', target: { mode: 'index', indices: [2] }, transition: { type: 'crossfade', duration: 0.5 } },
        { type: 'setTransitionAll', transition: { type: 'crossfade', duration: 0.4 } },
      ],
    },
    speedAndKeyframes: {
      title: 'Speed, Speed Curves, Keyframes & Beat Sync',
      ops: ['setSpeed', 'setSpeedCurve', 'setKeyframe', 'removeKeyframe', 'snapCutsToBeats'],
      examples: [
        { type: 'setSpeed', target: { mode: 'index', indices: [1] }, speed: 1.5 },
        { type: 'setSpeedCurve', id: '<clipId>', preset: 'montage' },
        { type: 'setKeyframe', target: 'clip', id: '<clipId>', path: 'transform.scale', t: 0.5, v: 1.2, ease: 'ease' },
        { type: 'removeKeyframe', target: 'clip', id: '<clipId>', path: 'transform.scale', t: 0.5 },
        { type: 'snapCutsToBeats', assetId: '<audioAssetId>' },
      ],
    },
    textAndCaptions: {
      title: 'Text Overlays & Captions',
      ops: ['addText', 'updateText', 'removeText', 'setCaption', 'addCaptions', 'updateCaptionStyle', 'clearCaptions'],
      examples: [
        { type: 'addText', text: { text: 'Opening Title', start: 0, duration: 3, preset: 'title', color: '#ffffff', animation: 'fade' } },
        { type: 'updateText', textId: '<textId>', text: { text: 'Updated Title', size: 1.2 } },
        { type: 'removeText', textId: '<textId>' },
        { type: 'setCaption', target: { mode: 'index', indices: [1] }, caption: { text: 'Shot subtitle', style: 'subtitle', position: 'bottom' } },
        { type: 'addCaptions', preset: 'subtitle', segments: [{ start: 0, end: 2.5, text: 'Welcome to Frameflow' }] },
        { type: 'updateCaptionStyle', patch: { color: '#ffe066', size: 0.95 } },
        { type: 'clearCaptions' },
      ],
    },
    audio: {
      title: 'Audio Tracks, Volume & Ducking',
      ops: ['addAudio', 'updateAudio', 'removeAudio', 'setVolume', 'autoDuck', 'detachAudio'],
      examples: [
        { type: 'addAudio', audio: { assetId: '<audioAssetId>', start: 0, volume: 0.8, role: 'music', fadeIn: 0.5, fadeOut: 1.0 } },
        { type: 'updateAudio', audioId: '<audioId>', audio: { volume: 0.5 } },
        { type: 'removeAudio', audioId: '<audioId>' },
        { type: 'setVolume', target: { mode: 'index', indices: [1] }, volume: 0.8, mute: false, audioFadeIn: 0.2 },
        { type: 'autoDuck', amount: 0.25, attack: 0.2, release: 0.4 },
        { type: 'detachAudio', id: '<clipId>' },
      ],
    },
    overlays: {
      title: 'Picture-in-Picture & Stickers (Overlays)',
      ops: ['addOverlay', 'updateOverlay', 'removeOverlay'],
      examples: [
        { type: 'addOverlay', assetId: '<visualAssetId>', track: 1, start: 1.0 },
        { type: 'updateOverlay', id: '<overlayId>', patch: { opacity: 0.85, blend: 'normal', transform: { scale: 0.4, x: 0.25, y: -0.2 } } },
        { type: 'removeOverlay', id: '<overlayId>' },
      ],
    },
    markers: {
      title: 'Timeline Markers',
      ops: ['addMarker', 'updateMarker', 'removeMarker'],
      examples: [
        { type: 'addMarker', t: 3.0, label: 'Beat drop', color: '#c8e250' },
        { type: 'updateMarker', id: '<markerId>', patch: { label: 'Chorus start' } },
        { type: 'removeMarker', id: '<markerId>' },
      ],
    },
    trackLocks: {
      title: 'Clip & Track Locks / Visibility / Mute',
      ops: ['lock', 'unlock', 'setTrack'],
      examples: [
        { type: 'lock', target: { mode: 'index', indices: [1] } },
        { type: 'unlock', target: { mode: 'index', indices: [1] } },
        { type: 'setTrack', track: 'text', patch: { locked: false, hidden: false } },
        { type: 'setTrack', track: 'overlay:1', patch: { muted: true } },
      ],
    },
  };

  // Ensure any future OP_TYPES added to src/engine/ops.js are always surfaced
  const covered = new Set(Object.values(categories).flatMap((c) => c.ops));
  const uncategorized = OP_TYPES.filter((op) => !covered.has(op));
  if (uncategorized.length) {
    categories.other = { title: 'Other Operations', ops: uncategorized, examples: [] };
  }

  return {
    ok: true,
    command: 'ops-schema',
    engineVersion: PROJECT_VERSION,
    count: OP_TYPES.length,
    opTypes: [...OP_TYPES],
    extOpTypes: [...EXT_OPS],
    targetModes: ['all', 'index', 'ids', 'selected', 'range'],
    confirmRules: { ...CONFIRM_RULES },
    enums: {
      aspects: Object.keys(ASPECTS),
      looks: [...LOOKS],
      motions: [...MOTIONS],
      transitions: [...TRANSITIONS],
      fxKeys: [...FX_KEYS],
      colorKeys: [...COLOR_KEYS],
      captionStyles: [...CAPTION_STYLES],
      textPresets: [...TEXT_PRESETS],
      textAnimations: [...TEXT_ANIMATIONS],
      blendModes: [...BLEND_MODES],
      fitModes: [...FIT_MODES],
      canvasTypes: [...CANVAS_TYPES],
      maskShapes: [...MASK_SHAPES],
      overlayKinds: [...OVERLAY_KINDS],
      markerColors: [...MARKER_COLORS],
      speedCurvePresets: Object.keys(SPEED_CURVE_PRESETS),
      keyPaths: [...KEY_PATHS],
      keyEases: [...EASES],
      pasteKeys: [...PASTE_KEYS],
    },
    categories,
  };
}

// ───────────────────────── Stream / Stdin Helpers ─────────────────────────

async function readStreamText(stream, maxBytes = MAX_STDIN_BYTES) {
  if (typeof stream === 'string') {
    if (Buffer.byteLength(stream, 'utf8') > maxBytes) {
      throw new CliError(2, `Stdin payload exceeds maximum limit (${maxBytes} bytes)`, { code: 'STDIN_TOO_LARGE' });
    }
    return stream;
  }
  if (Buffer.isBuffer(stream)) {
    if (stream.length > maxBytes) {
      throw new CliError(2, `Stdin payload exceeds maximum limit (${maxBytes} bytes)`, { code: 'STDIN_TOO_LARGE' });
    }
    return stream.toString('utf8');
  }
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new CliError(2, 'No readable stdin stream available', { code: 'NO_STDIN' });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    total += buf.length;
    if (total > maxBytes) {
      throw new CliError(2, `Stdin payload exceeds maximum limit (${maxBytes} bytes)`, { code: 'STDIN_TOO_LARGE' });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function parseOpsPayload(rawText, sourceLabel) {
  let parsed;
  try {
    parsed = JSON.parse(stripBom(rawText));
  } catch (err) {
    throw new CliError(2, `Invalid JSON in ${sourceLabel}: ${err && err.message ? err.message : String(err)}`, { code: 'INVALID_OPS_JSON' });
  }
  let ops;
  let embeddedCtx = null;
  if (Array.isArray(parsed)) {
    ops = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.ops)) {
    ops = parsed.ops;
    if (parsed.ctx && typeof parsed.ctx === 'object') embeddedCtx = parsed.ctx;
  } else {
    throw new CliError(2, `${sourceLabel} must be a JSON array of ops or an object with an "ops" array.`, { code: 'INVALID_OPS_SHAPE' });
  }
  return { ops, embeddedCtx };
}

// ───────────────────────── Command Implementations ─────────────────────────

async function cmdInit(positionals, flags, ctx) {
  if (positionals.length !== 1) {
    throw new CliError(2, 'Usage: frameflow init <file.ffproj> [--name <name>] [--aspect 16:9|9:16|1:1|4:3|21:9] [--fps 30] [--force] [--json]');
  }
  const resolved = assertSafePath(positionals[0], ctx.cwd, 'project file');
  const aspect = flags.aspect !== undefined ? String(flags.aspect) : '16:9';
  if (!ASPECTS[aspect]) {
    throw new CliError(2, `Unsupported --aspect "${aspect}". Valid values: ${Object.keys(ASPECTS).join(', ')}`, { code: 'INVALID_ASPECT' });
  }
  const fps = flags.fps !== undefined ? parseFiniteNumber(flags.fps, '--fps', 12, 60) : 30;
  const fallbackName = path.basename(resolved).replace(/\.ffproj$/i, '').trim() || '未命名项目';
  const name = flags.name !== undefined ? String(flags.name).trim() : fallbackName;
  if (!name) {
    throw new CliError(2, '--name cannot be empty', { code: 'INVALID_NAME' });
  }

  const existed = fs.existsSync(resolved);
  if (existed) {
    if (fs.statSync(resolved).isDirectory()) {
      throw new CliError(2, `Target path is a directory: ${resolved}`, { code: 'IS_DIRECTORY' });
    }
    if (!flags.force) {
      throw new CliError(2, `Project file already exists: ${resolved} (pass --force to overwrite)`, { code: 'FILE_EXISTS', path: resolved });
    }
  }

  const draft = createProject({ name, aspect });
  draft.settings.fps = fps;
  const project = normalizeProject(draft);
  writeProjectFile(resolved, project, ctx.cwd);

  const data = {
    ok: true,
    command: 'init',
    path: resolved,
    overwritten: existed,
    project: {
      id: project.id,
      name: project.name,
      version: project.version,
      settings: project.settings,
    },
  };
  const human = [
    `${existed ? 'Overwrote' : 'Created'} project: ${resolved}`,
    `  ID: ${project.id} | Name: ${project.name}`,
    `  Canvas: ${project.settings.aspect} (${project.settings.width}x${project.settings.height}) @ ${project.settings.fps} fps`,
  ].join('\n');
  return { exitCode: 0, data, human };
}

async function cmdInspect(positionals, flags, ctx) {
  if (positionals.length !== 1) {
    throw new CliError(2, 'Usage: frameflow inspect <file.ffproj> [--focus <start>..<end>] [--json]');
  }
  const focus = flags.focus !== undefined ? parseFocusRange(flags.focus) : null;
  const { resolved, project, migrated, repairs, notes } = readProjectFile(positionals[0], ctx.cwd);

  const layout = layoutVideo(project);
  const duration = round3(projectDuration(project, layout));
  const summary = projectSummary(project, focus ? { focus } : {});
  const texts = (project.tracks && Array.isArray(project.tracks.text)) ? project.tracks.text : [];
  const audios = (project.tracks && Array.isArray(project.tracks.audio)) ? project.tracks.audio : [];
  const overlays = Array.isArray(project.overlays) ? project.overlays : [];
  const markers = Array.isArray(project.markers) ? project.markers : [];
  const assetsMap = project.assets && typeof project.assets === 'object' ? project.assets : {};
  const storyboard = Array.isArray(project.storyboard) ? project.storyboard : [];

  const clips = layout.map((it) => ({
    id: it.clip.id,
    index: it.index + 1,
    start: round3(it.start),
    end: round3(it.end),
    duration: round3(it.duration),
    overlap: round3(it.overlap),
    assetId: it.clip.assetId,
    label: it.clip.label || '',
    speed: it.clip.speed,
    look: (it.clip.color && it.clip.color.look) || 'none',
    transitionIn: it.clip.transitionIn,
    locked: !!it.clip.locked,
    muted: !!it.clip.muted,
    still: !!it.clip.still,
  }));

  const textItems = texts.map((t) => ({
    id: t.id,
    start: round3(t.start),
    duration: round3(t.duration),
    end: round3((Number(t.start) || 0) + (Number(t.duration) || 0)),
    text: t.text,
    preset: t.preset,
    group: t.group || null,
    source: t.source || null,
    linkShotId: t.linkShotId || null,
    locked: !!t.locked,
  }));

  const audioItems = audios.map((a) => ({
    id: a.id,
    assetId: a.assetId,
    start: round3(a.start),
    in: round3(a.in),
    out: round3(a.out),
    duration: round3(Math.max(0, (Number(a.out) || 0) - (Number(a.in) || 0))),
    volume: a.volume,
    role: a.role,
    muted: !!a.muted,
    locked: !!a.locked,
  }));

  const overlayItems = overlays.map((o) => ({
    id: o.id,
    assetId: o.assetId,
    kind: o.kind,
    track: o.track,
    start: round3(o.start),
    duration: round3(overlayDuration(o)),
    opacity: o.opacity,
    blend: o.blend,
    locked: !!o.locked,
  }));

  const markerItems = markers.map((m) => ({
    id: m.id,
    t: round3(m.t),
    label: m.label || '',
    color: m.color,
  }));

  const assetItems = Object.values(assetsMap)
    .filter(Boolean)
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      name: a.name,
      path: a.path,
      duration: round3(a.duration),
      width: a.width,
      height: a.height,
      fps: a.fps,
      hasAudio: !!a.hasAudio,
      missing: !!a.missing,
      license: assetLicense(a).id,
    }));

  const data = {
    ok: true,
    command: 'inspect',
    path: resolved,
    id: project.id,
    name: project.name,
    version: project.version,
    migrated,
    settings: project.settings,
    duration,
    focus,
    counts: {
      clips: clips.length,
      texts: textItems.length,
      audios: audioItems.length,
      overlays: overlayItems.length,
      markers: markerItems.length,
      assets: assetItems.length,
      storyboard: storyboard.length,
    },
    clips,
    texts: textItems,
    audios: audioItems,
    overlays: overlayItems,
    markers: markerItems,
    assets: assetItems,
    trackState: project.trackState,
    brief: project.brief,
    meta: project.meta || null,
    summary,
    repairs,
    migrationNotes: notes,
  };

  const humanLines = [summary];
  if (project.meta && project.meta.lastAgentEdit) {
    const e = project.meta.lastAgentEdit;
    humanLines.push(`Last agent edit: ${e.at || '?'} by ${e.agent || 'cli'}${e.label ? ` (${e.label})` : ''}`);
  }
  if (repairs.length) humanLines.push(`Repairs: ${repairs.join('; ')}`);
  if (notes.length) humanLines.push(`Migration notes: ${notes.join('; ')}`);

  return { exitCode: 0, data, human: humanLines.join('\n') };
}

async function cmdOpsSchema(positionals) {
  if (positionals.length > 0) {
    throw new CliError(2, 'Usage: frameflow ops-schema [--json]');
  }
  const schema = buildOpsSchema();
  const lines = [
    `Frameflow Edit Operations Schema (engine v${schema.engineVersion}, ${schema.count} op types)`,
    `Target modes: ${schema.targetModes.join(', ')}`,
    '',
  ];
  for (const cat of Object.values(schema.categories)) {
    lines.push(`[${cat.title}]`);
    lines.push(`  Ops (${cat.ops.length}): ${cat.ops.join(', ')}`);
    for (const ex of cat.examples.slice(0, 3)) {
      lines.push(`  Ex: ${JSON.stringify(ex)}`);
    }
    lines.push('');
  }
  lines.push('Tip: run "frameflow ops-schema --json" for full examples and valid enum lists.');
  return { exitCode: 0, data: schema, human: lines.join('\n') };
}

async function cmdApply(positionals, flags, ctx) {
  if (positionals.length !== 1) {
    throw new CliError(2, 'Usage: frameflow apply <file.ffproj> (--ops <ops.json> | --ops-json \'<json>\' | --stdin) [--dry-run] [--allow-destructive] [--label "<msg>"] [--agent "<name>"] [--json]');
  }

  const sources = [
    flags.ops !== undefined ? '--ops' : null,
    flags['ops-json'] !== undefined ? '--ops-json' : null,
    flags.stdin ? '--stdin' : null,
  ].filter(Boolean);
  if (sources.length !== 1) {
    throw new CliError(2, 'Specify exactly one operations source: --ops <ops.json|->, --ops-json \'<json>\', or --stdin', { code: 'OPS_SOURCE_REQUIRED' });
  }

  const useStdin = Boolean(flags.stdin) || flags.ops === '-';
  const opsPath = flags.ops !== undefined && flags.ops !== '-' ? assertSafePath(flags.ops, ctx.cwd, 'ops file') : null;
  const { resolved, rawText, project: before, repairs } = readProjectFile(positionals[0], ctx.cwd);

  let rawOpsText;
  let sourceLabel;
  if (opsPath !== null) {
    sourceLabel = opsPath;
    try {
      const st = fs.statSync(opsPath);
      if (!st.isFile()) {
        throw new CliError(2, `Ops path is not a regular file: ${opsPath}`, { code: 'NOT_A_FILE' });
      }
      if (st.size > MAX_OPS_BYTES) {
        throw new CliError(2, `Ops file exceeds maximum allowed size (${MAX_OPS_BYTES} bytes): ${opsPath}`, {
          code: 'OPS_TOO_LARGE',
          path: opsPath,
          size: st.size,
          maxBytes: MAX_OPS_BYTES,
        });
      }
      rawOpsText = fs.readFileSync(opsPath, 'utf8');
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError(1, `Failed to read ops file ${opsPath}: ${err && err.message ? err.message : String(err)}`, { code: 'OPS_READ_ERROR' });
    }
  } else if (flags['ops-json'] !== undefined) {
    rawOpsText = String(flags['ops-json']);
    if (Buffer.byteLength(rawOpsText, 'utf8') > MAX_OPS_BYTES) {
      throw new CliError(2, `--ops-json payload exceeds maximum allowed size (${MAX_OPS_BYTES} bytes)`, {
        code: 'OPS_TOO_LARGE',
        maxBytes: MAX_OPS_BYTES,
      });
    }
    sourceLabel = '--ops-json';
  } else if (useStdin) {
    sourceLabel = flags.ops === '-' ? '--ops -' : '--stdin';
    rawOpsText = typeof ctx.readStdin === 'function'
      ? await ctx.readStdin()
      : await readStreamText(ctx.stdin, MAX_OPS_BYTES);
    if (Buffer.byteLength(String(rawOpsText ?? ''), 'utf8') > MAX_OPS_BYTES) {
      throw new CliError(2, `Stdin payload exceeds maximum limit (${MAX_OPS_BYTES} bytes)`, { code: 'STDIN_TOO_LARGE' });
    }
  }

  const { ops, embeddedCtx } = parseOpsPayload(rawOpsText, sourceLabel);
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new CliError(2, `Operations array in ${sourceLabel} must not be empty.`, {
      code: 'EMPTY_OPS',
      command: 'apply',
      path: resolved,
      dryRun: !!flags['dry-run'],
    });
  }
  const opCtx = {
    selectedClipIds: Array.isArray(embeddedCtx && embeddedCtx.selectedClipIds) ? embeddedCtx.selectedClipIds : [],
    range: embeddedCtx && embeddedCtx.range && typeof embeddedCtx.range === 'object' ? embeddedCtx.range : null,
    playhead: flags.playhead !== undefined
      ? parseFiniteNumber(flags.playhead, '--playhead', 0, 86400)
      : (embeddedCtx && Number.isFinite(Number(embeddedCtx.playhead)) ? Number(embeddedCtx.playhead) : 0),
  };

  const lint = lintOps(before, ops, opCtx);
  const appliedRes = applyOps(before, ops, opCtx);

  if (!lint.ok || !appliedRes.ok) {
    const errors = appliedRes.errors && appliedRes.errors.length
      ? appliedRes.errors
      : lint.diagnostics.map((d) => d.message);
    throw new CliError(2, `Operations failed validation (${errors.length} error${errors.length === 1 ? '' : 's'}): ${errors.join('; ')}`, {
      code: 'OPS_VALIDATION_FAILED',
      command: 'apply',
      path: resolved,
      dryRun: !!flags['dry-run'],
      diagnostics: lint.diagnostics,
      errors,
    });
  }

  const next = appliedRes.project;
  const diff = diffProject(before, next);
  const diffSummary = summarizeDiff(diff);
  const confirm = needsConfirm({ ops, before, after: next, diff });
  const dryRun = !!flags['dry-run'];
  const allowDestructive = !!flags['allow-destructive'];

  if (confirm.need && !allowDestructive) {
    const reasonsText = confirm.reasons.join('; ');
    throw new CliError(2, `Confirmation required (destructive or wide edit blocked): ${reasonsText}. Re-run with --allow-destructive to proceed.`, {
      code: 'CONFIRM_REQUIRED',
      command: 'apply',
      path: resolved,
      dryRun,
      needsConfirm: true,
      confirmReasons: confirm.reasons,
      reasons: confirm.reasons,
      diff,
      diffSummary,
      applied: appliedRes.applied,
      hint: 'Re-run with --allow-destructive to apply these changes.',
    });
  }

  const now = new Date().toISOString();
  const agent = typeof flags.agent === 'string' && flags.agent.trim() ? flags.agent.trim() : 'cli';
  const summaryText = diffSummary.join('；');
  const label = typeof flags.label === 'string' && flags.label.trim() ? flags.label.trim() : summaryText;

  let backupPath = null;
  let stamped = next;
  if (!dryRun) {
    backupPath = backupPathFor(resolved);
    assertSafePath(backupPath, ctx.cwd, 'backup path');
    atomicWriteFile(backupPath, rawText, ctx.cwd);
    stamped = {
      ...next,
      updatedAt: now,
      meta: {
        ...(next.meta && typeof next.meta === 'object' ? next.meta : {}),
        lastAgentEdit: {
          at: now,
          agent,
          label,
          summary: summaryText,
        },
      },
    };
    writeProjectFile(resolved, stamped, ctx.cwd);
  }

  const data = {
    ok: true,
    command: 'apply',
    path: resolved,
    dryRun,
    written: !dryRun,
    backupPath,
    opCount: ops.length,
    applied: appliedRes.applied,
    diff,
    diffSummary,
    summary: summaryText,
    needsConfirm: confirm.need,
    confirmReasons: confirm.reasons,
    lastAgentEdit: dryRun ? null : stamped.meta.lastAgentEdit,
    repairs,
  };

  const humanLines = [
    dryRun ? `[DRY-RUN] Validated ${ops.length} op(s) on ${resolved} (no file modified)` : `Applied ${ops.length} op(s) to ${resolved}`,
    ...diffSummary.map((line) => `  - ${line}`),
  ];
  if (backupPath) humanLines.push(`  Backup: ${backupPath}`);
  if (confirm.need) humanLines.push(`  Destructive gate bypassed via --allow-destructive (${confirm.reasons.join('; ')})`);

  return { exitCode: 0, data, human: humanLines.join('\n') };
}

async function cmdStoryboard(positionals, flags, ctx) {
  if (positionals.length !== 1) {
    throw new CliError(2, 'Usage: frameflow storyboard <file.ffproj> --brief "<prompt>" [--duration 30] [--aspect 16:9] [--name <name>] [--first-cut] [--agent "<name>"] [--json]');
  }
  const briefPrompt = typeof flags.brief === 'string' ? flags.brief.trim() : '';
  if (!briefPrompt) {
    throw new CliError(2, 'Missing required --brief "<prompt>" option', { code: 'MISSING_BRIEF' });
  }
  const explicitDuration = flags.duration !== undefined
    ? parseFiniteNumber(flags.duration, '--duration', 5, 600)
    : null;
  const explicitAspect = flags.aspect !== undefined ? String(flags.aspect) : null;
  if (explicitAspect && !ASPECTS[explicitAspect]) {
    throw new CliError(2, `Unsupported --aspect "${explicitAspect}". Valid values: ${Object.keys(ASPECTS).join(', ')}`, { code: 'INVALID_ASPECT' });
  }
  const explicitName = flags.name !== undefined ? String(flags.name).trim() : null;
  if (flags.name !== undefined && !explicitName) {
    throw new CliError(2, '--name cannot be empty', { code: 'INVALID_NAME' });
  }

  const resolved = assertSafePath(positionals[0], ctx.cwd, 'project file');
  const extracted = extractBriefPatch(briefPrompt);

  let existed = false;
  let rawText = null;
  let before;
  let repairs = [];
  if (fs.existsSync(resolved)) {
    existed = true;
    const loaded = readProjectFile(resolved, ctx.cwd);
    rawText = loaded.rawText;
    before = loaded.project;
    repairs = loaded.repairs;
  } else {
    const initialAspect = explicitAspect || (extracted.aspect && ASPECTS[extracted.aspect] ? extracted.aspect : '16:9');
    const fallbackName = path.basename(resolved).replace(/\.ffproj$/i, '').trim() || 'Untitled Project';
    const draft = createProject({ name: explicitName || fallbackName, aspect: initialAspect });
    before = normalizeProject(draft);
  }

  const targetAspect = explicitAspect || extracted.aspect || (before.settings && before.settings.aspect) || '16:9';
  const targetDuration = explicitDuration != null
    ? explicitDuration
    : (extracted.duration || (before.brief && before.brief.duration) || 30);

  const brief = createBrief({
    ...(before.brief || {}),
    ...extracted,
    title: explicitName || (before.brief && before.brief.title) || briefPrompt.slice(0, 40),
    goal: briefPrompt.slice(0, 300),
    duration: targetDuration,
    aspect: targetAspect,
  });

  const topic = detectTopic(`${brief.title} ${brief.goal} ${brief.style} ${brief.keyMessage}`) || 'generic';
  const sb = localStoryboard(brief);

  let nextSettings = before.settings;
  if (explicitAspect && (!before.settings || before.settings.aspect !== explicitAspect)) {
    const dim = createSettings(explicitAspect);
    nextSettings = {
      ...before.settings,
      aspect: dim.aspect,
      width: dim.width,
      height: dim.height,
    };
  }

  let next = {
    ...before,
    name: explicitName || before.name,
    settings: nextSettings,
    brief,
    storyboard: sb.shots,
    memory: {
      styleGuide: '',
      decisions: [],
      colorBaseline: null,
      ...(before.memory || {}),
      styleGuide: (before.memory && before.memory.styleGuide) || sb.styleGuide || '',
    },
  };

  let firstCutReport = [];
  if (flags['first-cut']) {
    const fc = buildFirstCut(next);
    next = fc.project;
    firstCutReport = fc.report || [];
  }

  const now = new Date().toISOString();
  const agent = typeof flags.agent === 'string' && flags.agent.trim() ? flags.agent.trim() : 'cli';
  const label = flags['first-cut'] ? 'Storyboard + first cut' : 'Storyboard';
  const summaryText = flags['first-cut']
    ? `生成 ${sb.shots.length} 个分镜并完成初剪（${(next.tracks && next.tracks.video ? next.tracks.video.length : 0)} 镜）`
    : `生成 ${sb.shots.length} 个分镜（${topic}）`;

  next = {
    ...next,
    updatedAt: now,
    meta: {
      ...(next.meta && typeof next.meta === 'object' ? next.meta : {}),
      lastAgentEdit: {
        at: now,
        agent,
        label,
        summary: summaryText,
      },
    },
  };

  let backupPath = null;
  if (existed && rawText !== null) {
    backupPath = backupPathFor(resolved);
    assertSafePath(backupPath, ctx.cwd, 'backup path');
    atomicWriteFile(backupPath, rawText, ctx.cwd);
  }
  writeProjectFile(resolved, next, ctx.cwd);

  const layout = layoutVideo(next);
  const totalDuration = round3(projectDuration(next, layout));
  const data = {
    ok: true,
    command: 'storyboard',
    path: resolved,
    created: !existed,
    backupPath,
    topic,
    brief,
    shotCount: sb.shots.length,
    shots: sb.shots.map((s) => ({
      id: s.id,
      index: s.index,
      title: s.title,
      duration: s.duration,
      shotSize: s.shotSize,
      angle: s.angle,
      movement: s.movement,
      caption: s.caption,
      transitionIn: s.transitionIn,
      look: s.look,
      status: s.status,
    })),
    styleGuide: sb.styleGuide,
    reply: sb.reply,
    firstCut: {
      ran: !!flags['first-cut'],
      clipCount: layout.length,
      textCount: (next.tracks && Array.isArray(next.tracks.text)) ? next.tracks.text.length : 0,
      duration: totalDuration,
      report: firstCutReport,
    },
    repairs,
  };

  const humanLines = [
    `${existed ? 'Updated' : 'Created'} storyboard in ${resolved} (${sb.shots.length} shots, topic: ${topic}, target: ${brief.duration}s ${brief.aspect})`,
    ...sb.shots.map((s) => `  #${s.index} [${s.duration}s] ${s.title} (${s.shotSize}/${s.movement})${s.caption ? ` "${s.caption}"` : ''}`),
  ];
  if (backupPath) humanLines.push(`  Backup: ${backupPath}`);
  if (flags['first-cut']) {
    humanLines.push(`First cut: ${data.firstCut.clipCount} clips, ${data.firstCut.textCount} text items, total ${totalDuration}s`);
  }

  return { exitCode: 0, data, human: humanLines.join('\n') };
}

async function cmdBreakdown(positionals, flags, ctx) {
  if (positionals.length !== 1) {
    throw new CliError(2, 'Usage: frameflow breakdown <video-path> [--out <report.json>] [--max-seconds 600] [--json]');
  }
  const videoPath = assertSafePath(positionals[0], ctx.cwd, 'video file');
  const outPath = flags.out !== undefined ? assertSafePath(flags.out, ctx.cwd, 'report output path') : null;
  const maxSeconds = flags['max-seconds'] !== undefined
    ? parseFiniteNumber(flags['max-seconds'], '--max-seconds', 1, 7200)
    : 600;

  try {
    const st = fs.statSync(videoPath);
    if (!st.isFile()) {
      throw new CliError(2, `Video path is not a regular file: ${videoPath}`, { code: 'NOT_A_FILE' });
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(1, `Video file not found: ${videoPath}`, { code: 'ENOENT', path: videoPath });
  }

  const locate = ctx.locateBinary || pathsLib.locateBinary;
  const ffmpegHit = locate('ffmpeg', { projectRoot: PROJECT_ROOT });
  const ffprobeHit = locate('ffprobe', { projectRoot: PROJECT_ROOT });
  if (!ffmpegHit || !ffmpegHit.path) {
    throw new CliError(1, 'ffmpeg binary not found. Run "node scripts/fetch-ffmpeg.mjs" or set FF_FFMPEG.', { code: 'FFMPEG_MISSING' });
  }
  const binPaths = { ffmpeg: ffmpegHit.path, ffprobe: ffprobeHit ? ffprobeHit.path : null };

  const shotdetect = ctx.shotdetect || require('../electron/lib/shotdetect.cjs');
  const analyzer = ctx.analyzer || require('../electron/lib/analyzer.cjs');

  const warnings = [];
  const info = await analyzer._internals.probeVideo(binPaths, videoPath);
  if (!info || !info.hasVideo) {
    throw new CliError(1, `File contains no video stream: ${videoPath}`, { code: 'NO_VIDEO_STREAM' });
  }

  const scanSeconds = Math.max(0.1, info.duration > 0 ? Math.min(info.duration, maxSeconds) : maxSeconds);
  if (info.duration > maxSeconds) {
    warnings.push(`Video duration (${round3(info.duration)}s) exceeds --max-seconds (${maxSeconds}s); analyzed first ${maxSeconds}s.`);
  }

  const rate = shotdetect.scanRate(info.fps);
  const scan = await shotdetect.scanVideo(binPaths, videoPath, {
    seconds: scanSeconds,
    rate,
    durationHint: info.duration > 0 ? Math.min(info.duration, maxSeconds) : 0,
  });
  if (scan.exitCode !== 0) {
    warnings.push(`ffmpeg exited with code ${scan.exitCode} during scan; partial output may have occurred.`);
  }
  const duration = round3(scan.duration);
  if (!Array.isArray(scan.shots) || !scan.shots.length || !(duration > 0)) {
    throw new CliError(1, 'Could not determine shot boundaries or duration from video.', { code: 'BREAKDOWN_EMPTY' });
  }

  const curveDiff = (scan.curves && Array.isArray(scan.curves.diff)) ? scan.curves.diff : [];
  const shots = scan.shots.map((b, i) => ({
    index: i + 1,
    start: round3(b.start),
    end: round3(b.end),
    duration: round3(b.end - b.start),
    cutIn: b.cutIn || null,
    keyframes: Array.isArray(b.keyframes) ? b.keyframes : [],
    keyframeScore: Number.isFinite(b.keyframeScore) ? round3(b.keyframeScore) : null,
    motion: analyzer._internals.shotMotion(curveDiff, b.start, b.end),
    dominantColors: b.stats && Array.isArray(b.stats.palette) ? b.stats.palette : [],
    stats: b.stats || null,
  }));

  const rhythm = analyzer._internals.computeRhythm(shots, duration);
  const colorProfile = analyzer._internals.mergeColorProfile(shots.map((s) => ({ stats: s.stats, weight: s.duration })));

  let tempo = null;
  let beatSync = null;
  if (info.hasAudio) {
    try {
      tempo = await analyzer.detectTempo(videoPath, { paths: binPaths, maxSeconds: scanSeconds });
      const realCuts = shots
        .filter((s, i) => i > 0 && !(s.cutIn && s.cutIn.kind === 'split'))
        .map((s) => s.start);
      beatSync = tempo && tempo.bpm ? analyzer.computeBeatSync(realCuts, tempo.beats, tempo.bpm, info.fps) : null;
    } catch (err) {
      warnings.push(`Audio beat detection skipped: ${err && err.message ? err.message : String(err)}`);
    }
  }

  const report = {
    ok: true,
    command: 'breakdown',
    file: videoPath,
    outPath,
    media: {
      duration,
      width: info.width,
      height: info.height,
      fps: round3(info.fps || 0),
      hasAudio: !!info.hasAudio,
    },
    ffmpeg: { source: ffmpegHit.source, license: ffmpegHit.license },
    shotCount: shots.length,
    shots,
    cuts: scan.cuts || [],
    pacing: {
      avgShot: rhythm.avgShot,
      medianShot: rhythm.medianShot,
      cutsPerMinute: rhythm.cutsPerMinute,
      durations: rhythm.durations,
    },
    colorProfile,
    dominantColors: Array.isArray(colorProfile.palette) ? colorProfile.palette : [],
    beats: {
      bpm: tempo ? tempo.bpm : null,
      confidence: tempo ? tempo.confidence : 0,
      count: tempo && Array.isArray(tempo.beats) ? tempo.beats.length : 0,
      times: tempo && Array.isArray(tempo.beats) ? tempo.beats : [],
      beatSync,
    },
    warnings,
    analyzedAt: new Date().toISOString(),
  };

  if (outPath) {
    atomicWriteFile(outPath, JSON.stringify(report, null, 2) + '\n', ctx.cwd);
  }

  const humanLines = [
    `Breakdown: ${videoPath}`,
    `  Media: ${info.width}x${info.height} @ ${report.media.fps} fps, ${duration}s, audio=${info.hasAudio ? 'yes' : 'no'}`,
    `  Pacing: ${shots.length} shots | avg ${rhythm.avgShot}s | median ${rhythm.medianShot}s | ${rhythm.cutsPerMinute} cuts/min`,
    `  Dominant colors: ${report.dominantColors.join(', ') || 'n/a'} (luma=${colorProfile.luma}, sat=${colorProfile.saturation}, warmth=${colorProfile.warmth})`,
    `  Beats: ${report.beats.bpm ? `${report.beats.bpm} BPM (conf=${report.beats.confidence}, ${report.beats.count} beats)` : 'none detected'}`,
    ...shots.slice(0, 20).map((s) => `  #${s.index} [${s.start}s–${s.end}s, ${s.duration}s] cut=${(s.cutIn && s.cutIn.transition) || 'start'} motion=${s.motion}`),
  ];
  if (shots.length > 20) humanLines.push(`  ...and ${shots.length - 20} more shots`);
  if (outPath) humanLines.push(`  Saved report: ${outPath}`);
  if (warnings.length) humanLines.push(`  Warnings: ${warnings.join('; ')}`);

  return { exitCode: 0, data: report, human: humanLines.join('\n') };
}

async function cmdStock(positionals, flags, ctx) {
  if (positionals.length < 2 || positionals[0] !== 'search') {
    throw new CliError(2, 'Usage: frameflow stock search "<query>" [--kind video|image|audio] [--limit 8] [--json]');
  }
  const query = positionals.slice(1).join(' ').trim();
  if (!query) {
    throw new CliError(2, 'Missing search query. Usage: frameflow stock search "<query>" [--kind video|image|audio] [--limit 8] [--json]');
  }
  const kind = flags.kind !== undefined ? String(flags.kind).toLowerCase() : 'video';
  if (!['video', 'image', 'audio'].includes(kind)) {
    throw new CliError(2, `Unsupported --kind "${kind}". Valid values: video, image, audio`, { code: 'INVALID_KIND' });
  }
  const limit = flags.limit !== undefined
    ? Math.round(parseFiniteNumber(flags.limit, '--limit', 1, 30))
    : 8;

  const webMod = ctx.webMod || require('../electron/ipc/web.cjs');
  const internals = webMod._internals;
  const freeSources = Array.isArray(internals.FREE_SOURCES) ? internals.FREE_SOURCES : ['commons', 'openverse', 'archive', 'nasa'];

  let requestedSources = freeSources;
  if (flags.sources !== undefined) {
    const parsed = String(flags.sources).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = parsed.filter((s) => !freeSources.includes(s));
    if (!parsed.length || bad.length) {
      throw new CliError(2, `Unsupported --sources "${flags.sources}". Allowed zero-key sources: ${freeSources.join(', ')}`, { code: 'INVALID_SOURCES' });
    }
    requestedSources = parsed;
  }

  const searchFn = ctx.webSearch || internals.search;
  const payload = {
    query,
    kind,
    limit,
    sources: requestedSources,
    ...(flags['query-en'] ? { queryEn: String(flags['query-en']) } : {}),
  };
  const raw = await searchFn({ settings: null, paths: {} }, payload);
  const rawResults = Array.isArray(raw && raw.results) ? raw.results : [];
  const errors = Array.isArray(raw && raw.errors) ? raw.errors : [];

  if (!rawResults.length && errors.length) {
    throw new CliError(1, `Stock search failed across sources: ${errors.map((e) => `${e.source}: ${e.error}`).join('; ')}`, {
      code: 'STOCK_SEARCH_FAILED',
      command: 'stock search',
      query,
      kind,
      errors,
    });
  }

  const results = rawResults.slice(0, limit).map((r) => ({
    id: r.id,
    source: r.source,
    kind: r.kind || kind,
    title: r.title || '',
    license: r.license || '',
    licenseId: r.licenseId || 'unknown',
    licenseUrl: r.licenseUrl || null,
    author: r.author || null,
    duration: r.duration ?? null,
    width: r.width ?? null,
    height: r.height ?? null,
    url: r.url || null,
    downloadUrl: r.downloadUrl || null,
    thumb: r.thumb || null,
  }));

  const data = {
    ok: true,
    command: 'stock search',
    query,
    kind,
    limit,
    sources: requestedSources,
    count: results.length,
    results,
    errors,
  };

  const humanLines = [
    `Stock search ("${query}", kind=${kind}): ${results.length} result(s)`,
    ...results.map((r, idx) => `  ${idx + 1}. [${r.source}] ${r.title} | license=${r.license || r.licenseId}${r.duration != null ? ` | ${r.duration}s` : ''}\n     ${r.downloadUrl || r.url || ''}`),
  ];
  if (errors.length) {
    humanLines.push(`  Partial source warnings: ${errors.map((e) => `${e.source}: ${e.error}`).join('; ')}`);
  }
  return { exitCode: 0, data, human: humanLines.join('\n') };
}

async function cmdExportSrt(positionals, flags, ctx) {
  if (positionals.length !== 1) {
    throw new CliError(2, 'Usage: frameflow export-srt <file.ffproj> [--out <file.srt>] [--include-all-text] [--json]');
  }
  const outPath = flags.out !== undefined ? assertSafePath(flags.out, ctx.cwd, 'SRT output path') : null;
  const { resolved, project, repairs } = readProjectFile(positionals[0], ctx.cwd);

  const includeAllText = Boolean(flags['include-all-text']);
  const textHidden = trackFlags(project, 'text').hidden;
  const rawTexts = (project.tracks && Array.isArray(project.tracks.text)) ? project.tracks.text : [];
  const activeTexts = textHidden
    ? []
    : rawTexts.filter((t) => t && (includeAllText || isCaptionText(t)) && String(t.text || '').trim());
  const nonCaptionTextCount = textHidden
    ? 0
    : rawTexts.filter((t) => t && !isCaptionText(t) && String(t.text || '').trim()).length;
  const srt = textsToSrt(activeTexts);

  if (outPath) {
    atomicWriteFile(outPath, srt, ctx.cwd);
  }

  const data = {
    ok: true,
    command: 'export-srt',
    path: resolved,
    outPath,
    includeAllText,
    textTrackHidden: textHidden,
    cueCount: activeTexts.length,
    nonCaptionTextCount,
    bytes: Buffer.byteLength(srt, 'utf8'),
    srt,
    repairs,
  };

  let human;
  if (outPath) {
    human = textHidden
      ? `Text track is hidden; wrote empty SRT (0 cues) to ${outPath}`
      : `Exported ${activeTexts.length} SRT cue(s) to ${outPath}`;
  } else {
    human = srt;
  }

  return { exitCode: 0, data, human, rawOutput: !outPath };
}

const PRESET_ALIASES = {
  youtube: 'youtube4k',
  youtube4k: 'youtube4k',
  douyin: 'douyin',
  bilibili: 'bilibili',
  shipinhao: 'shipinhao',
  standard: 'custom',
  custom: 'custom',
  'audio-mp3': 'audio-mp3',
  gif: 'gif',
};

async function cmdExportPlan(positionals, flags, ctx) {
  if (positionals.length !== 1) {
    throw new CliError(2, 'Usage: frameflow export-plan <file.ffproj> [--preset youtube|douyin|bilibili|standard] [--json]');
  }
  const { resolved, project, repairs } = readProjectFile(positionals[0], ctx.cwd);
  const requestedPreset = flags.preset !== undefined
    ? String(flags.preset).trim().toLowerCase()
    : (project.exportPreset || 'standard');

  const resolvedPresetId = PRESET_ALIASES[requestedPreset];
  if (!resolvedPresetId) {
    throw new CliError(2, `Unsupported --preset "${requestedPreset}". Valid values: ${Object.keys(PRESET_ALIASES).join(', ')}`, { code: 'INVALID_PRESET' });
  }

  const exportOptions = resolveExportOptions(resolvedPresetId, project.settings || {});
  const layout = layoutVideo(project);
  const duration = round3(projectDuration(project, layout));
  const audioPlan = buildAudioPlan(project, { duration });

  const aiSummary = aiAssetSummary(project);
  const usesAi = projectUsesAiLoose(project);
  const aigcMeta = usesAi ? buildAigcMeta() : null;
  const aigc = {
    standard: 'GB 45438-2025',
    required: usesAi,
    aiAssets: aiSummary,
    defaultLabel: usesAi ? { ...AI_LABEL_DEFAULT } : null,
    metadata: aigcMeta,
    metadataJson: aigcMeta ? aigcMetaString(aigcMeta) : null,
  };

  const credits = creditsText(project);
  const restricted = findRestrictedUsage(project, { commercial: true });
  const license = {
    attributionRequired: Boolean(credits),
    creditsText: credits,
    restrictedUsage: restricted,
    hasCommercialBlockers: restricted.some((r) => r.level === 'block'),
  };

  const data = {
    ok: true,
    command: 'export-plan',
    path: resolved,
    requestedPreset,
    preset: exportOptions,
    availablePresets: EXPORT_PRESETS.map((p) => p.id),
    duration,
    clipCount: layout.length,
    audioPlan,
    aigc,
    license,
    repairs,
  };

  const humanLines = [
    `Export Plan: ${resolved}`,
    `  Preset: ${requestedPreset} -> ${exportOptions.presetId} (${exportOptions.format.toUpperCase()}, ${exportOptions.w}x${exportOptions.h} @ ${exportOptions.fps} fps, bitrate=${exportOptions.bitrate || 'CRF auto'} kbps)`,
    `  Timeline: ${layout.length} clips, ${duration}s total`,
    `  Audio Plan: ${audioPlan.segments.length} segment(s) over ${round3(audioPlan.duration)}s`,
    `  AIGC Compliance (${aigc.standard}): ${usesAi ? `REQUIRED (${aiSummary.count} AI asset(s): ${aiSummary.names.join(', ')})` : 'not triggered (no AI assets on timeline)'}`,
    `  License Attribution: ${license.attributionRequired ? 'required' : 'none required'}${license.hasCommercialBlockers ? ` | WARNING: ${restricted.length} restricted asset(s)` : ''}`,
  ];
  if (credits) humanLines.push(credits);

  return { exitCode: 0, data, human: humanLines.join('\n') };
}

async function cmdDoctor(positionals, _flags, ctx) {
  if (positionals.length > 0) {
    throw new CliError(2, 'Usage: frameflow doctor [--json]');
  }
  const locate = ctx.locateBinary || pathsLib.locateBinary;
  const nodeVersion = process.versions.node;
  const nodeMajor = Number(String(nodeVersion).split('.')[0]) || 0;

  const ffmpegHit = locate('ffmpeg', { projectRoot: PROJECT_ROOT });
  const ffprobeHit = locate('ffprobe', { projectRoot: PROJECT_ROOT });

  const skillPath = path.join(PROJECT_ROOT, 'skills', 'frameflow', 'SKILL.md');
  const mcpPath = path.join(PROJECT_ROOT, 'bin', 'frameflow-mcp.mjs');
  const isNonEmptyFile = (p) => {
    try {
      const st = fs.statSync(p);
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  };

  const checks = {
    node: {
      ok: nodeMajor >= 22,
      version: nodeVersion,
      required: '>=22',
    },
    ffmpeg: {
      ok: !!(ffmpegHit && ffmpegHit.path),
      path: ffmpegHit ? ffmpegHit.path : null,
      source: ffmpegHit ? ffmpegHit.source : 'none',
      license: ffmpegHit ? ffmpegHit.license : 'unknown',
    },
    ffprobe: {
      ok: !!(ffprobeHit && ffprobeHit.path),
      path: ffprobeHit ? ffprobeHit.path : null,
      source: ffprobeHit ? ffprobeHit.source : 'none',
      license: ffprobeHit ? ffprobeHit.license : 'unknown',
    },
    engine: {
      ok: true,
      cliVersion: CLI_VERSION,
      projectVersion: PROJECT_VERSION,
      currentMigrationVersion: CURRENT_VERSION,
      opCount: OP_TYPES.length,
    },
    skill: {
      ok: isNonEmptyFile(skillPath),
      path: skillPath,
    },
    mcpServer: {
      ok: isNonEmptyFile(mcpPath),
      path: mcpPath,
    },
  };

  const healthy = checks.node.ok && checks.ffmpeg.ok && checks.ffprobe.ok && checks.engine.ok;
  const allReady = healthy && checks.skill.ok && checks.mcpServer.ok;

  const data = {
    ok: true,
    command: 'doctor',
    healthy,
    allReady,
    projectRoot: PROJECT_ROOT,
    checks,
  };

  const statusTag = (ok) => (ok ? '[OK]' : '[MISSING]');
  const human = [
    `Frameflow Doctor (CLI v${CLI_VERSION}, engine schema v${PROJECT_VERSION})`,
    `  ${statusTag(checks.node.ok)} Node.js: v${checks.node.version} (required ${checks.node.required})`,
    `  ${statusTag(checks.ffmpeg.ok)} ffmpeg: source=${checks.ffmpeg.source}, license=${checks.ffmpeg.license}${checks.ffmpeg.path ? ` (${checks.ffmpeg.path})` : ''}`,
    `  ${statusTag(checks.ffprobe.ok)} ffprobe: source=${checks.ffprobe.source}, license=${checks.ffprobe.license}${checks.ffprobe.path ? ` (${checks.ffprobe.path})` : ''}`,
    `  ${statusTag(checks.engine.ok)} Engine: project v${checks.engine.projectVersion}, ${checks.engine.opCount} op types`,
    `  ${statusTag(checks.skill.ok)} Skill file: ${checks.skill.path}`,
    `  ${statusTag(checks.mcpServer.ok)} MCP server: ${checks.mcpServer.path}`,
  ].join('\n');

  return { exitCode: 0, data, human };
}

// ───────────────────────── Runner & Entrypoint ─────────────────────────

function makeWriter(target, buffer) {
  return (text) => {
    const str = String(text);
    buffer.push(str);
    if (typeof target === 'function') target(str);
    else if (target && typeof target.write === 'function') target.write(str);
  };
}

/**
 * Pure, testable CLI runner.
 * @param {string[]} argv CLI arguments (excluding node and script path)
 * @param {object} [io] Optional I/O & dependency overrides ({ stdout, stderr, stdin, readStdin, cwd, locateBinary, webSearch, webMod, shotdetect, analyzer })
 * @returns {Promise<{ exitCode: number, data: object|null, stdout: string, stderr: string }>}
 */
export async function runCli(argv = [], io = {}) {
  const outBuf = [];
  const errBuf = [];
  const writeOut = makeWriter(io.stdout, outBuf);
  const writeErr = makeWriter(io.stderr, errBuf);
  const ctx = {
    cwd: io.cwd || process.cwd(),
    stdin: io.stdin !== undefined ? io.stdin : process.stdin,
    readStdin: io.readStdin,
    locateBinary: io.locateBinary,
    webSearch: io.webSearch,
    webMod: io.webMod,
    shotdetect: io.shotdetect,
    analyzer: io.analyzer,
  };

  const wantJson = Array.isArray(argv) && argv.includes('--json');

  try {
    const { command, flags, positionals } = parseArgs(argv);
    const jsonMode = !!flags.json;

    if (flags.version && !command) {
      const data = { ok: true, name: 'frameflow', version: CLI_VERSION, engineVersion: PROJECT_VERSION };
      if (jsonMode) writeOut(JSON.stringify(data, null, 2) + '\n');
      else writeOut(`frameflow v${CLI_VERSION} (engine schema v${PROJECT_VERSION})\n`);
      return { exitCode: 0, data, stdout: outBuf.join(''), stderr: errBuf.join('') };
    }

    if (flags.help || command === 'help') {
      const topic = command === 'help' ? positionals[0] : command;
      const helpText = formatHelp(topic);
      const data = { ok: true, command: 'help', topic: topic || null, help: helpText };
      if (jsonMode) writeOut(JSON.stringify(data, null, 2) + '\n');
      else writeOut(helpText);
      return { exitCode: 0, data, stdout: outBuf.join(''), stderr: errBuf.join('') };
    }

    if (!command) {
      const helpText = formatHelp();
      const data = { ok: false, code: 2, error: 'Missing command. Run "frameflow --help" for usage.' };
      if (jsonMode) writeOut(JSON.stringify(data, null, 2) + '\n');
      writeErr(helpText);
      return { exitCode: 2, data, stdout: outBuf.join(''), stderr: errBuf.join('') };
    }

    let result;
    switch (command) {
      case 'init': result = await cmdInit(positionals, flags, ctx); break;
      case 'inspect': result = await cmdInspect(positionals, flags, ctx); break;
      case 'ops-schema': result = await cmdOpsSchema(positionals, flags, ctx); break;
      case 'apply': result = await cmdApply(positionals, flags, ctx); break;
      case 'storyboard': result = await cmdStoryboard(positionals, flags, ctx); break;
      case 'breakdown': result = await cmdBreakdown(positionals, flags, ctx); break;
      case 'stock': result = await cmdStock(positionals, flags, ctx); break;
      case 'export-srt': result = await cmdExportSrt(positionals, flags, ctx); break;
      case 'export-plan': result = await cmdExportPlan(positionals, flags, ctx); break;
      case 'doctor': result = await cmdDoctor(positionals, flags, ctx); break;
      default:
        throw new CliError(2, `Unknown command "${command}". Run "frameflow --help" to list commands.`, { code: 'UNKNOWN_COMMAND' });
    }

    if (jsonMode) {
      writeOut(JSON.stringify(result.data, null, 2) + '\n');
    } else if (result.rawOutput) {
      writeOut(result.human);
    } else if (result.human) {
      writeOut(result.human.endsWith('\n') ? result.human : `${result.human}\n`);
    }
    return { exitCode: result.exitCode, data: result.data, stdout: outBuf.join(''), stderr: errBuf.join('') };
  } catch (err) {
    const exitCode = err instanceof CliError ? err.exitCode : 1;
    const message = err && err.message ? err.message : String(err);
    const details = err instanceof CliError && err.details && typeof err.details === 'object' ? err.details : {};
    const payload = { ok: false, code: exitCode, error: message, ...details };
    if (wantJson) {
      writeOut(JSON.stringify(payload, null, 2) + '\n');
    }
    writeErr(`Error: ${message}\n`);
    return { exitCode, data: payload, stdout: outBuf.join(''), stderr: errBuf.join('') };
  }
}

export async function main(argv = process.argv.slice(2)) {
  const res = await runCli(argv, {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    cwd: process.cwd(),
  });
  return res.exitCode;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const selfPath = fs.realpathSync.native(__filename);
    const argvPath = fs.realpathSync.native(path.resolve(process.argv[1]));
    return process.platform === 'win32'
      ? selfPath.toLowerCase() === argvPath.toLowerCase()
      : selfPath === argvPath;
  } catch {
    try {
      const selfPath = path.resolve(__filename);
      const argvPath = path.resolve(process.argv[1]);
      return process.platform === 'win32'
        ? selfPath.toLowerCase() === argvPath.toLowerCase()
        : selfPath === argvPath;
    } catch {
      return false;
    }
  }
}

if (isMainModule()) {
  main().then((code) => {
    process.exitCode = code;
  });
}
