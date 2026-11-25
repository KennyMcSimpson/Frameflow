'use strict';
// 设置与密钥存储（safeStorage 加密）。store.cjs 通过 IPC 暴露；其他模块用 ctx.settings 读取。
// 写盘：先写临时文件并刷盘再改名替换（断电/崩溃不会留下半截文件）；每次启动后第一次写入前留一份 .bak。
// 读盘：文件损坏时改名留档（settings.corrupt-时间.json），再尝试用 .bak 恢复，都不行才回到默认设置。
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log.cjs');

const DEFAULTS = {
  dataRoot: '',
  ai: {
    provider: 'auto', // 'auto' | 'codex' | 'openai' | 'local'
    codexPath: '',
    codexModel: '',
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiModel: 'gpt-4.1-mini',
    openaiVisionModel: '',
    openaiImageModel: '',
  },
  // 免 key 的来源排在前面（Pexels 已停止发放新 key）
  web: { maxDownloadSeconds: 180, preferredSources: ['commons', 'openverse', 'archive', 'nasa', 'pexels', 'pixabay', 'bilibili', 'youtube'] },
  export: { quality: 'high', fps: 30, resolution: 'full', folder: '', hwaccel: 'auto' },
  ui: { lastProjectId: '', onboarded: false, scale: 1 },
  general: { autosave: true, openLastProject: true },
  editing: { aspect: '16:9', fps: 30, imageDuration: 3, transitionDuration: 0.5, previewQuality: 'auto' },
  shortcuts: { overrides: {} },
  media: { encoder: 'auto' },
  asr: { model: 'small', whisperDir: '' },
  consent: {},
  // AI 真人视频生成。密钥不落在这里：settings.set({videogen:{keys:{arkKey:'…'}}}) 会转存到加密的 secrets，
  // get() 返回 videogen.hasKeys 标记。overrides[providerId] = {baseUrl, model}
  videogen: { provider: 'mock', overrides: {} },
  // 显卡相关，改了要重启才生效（main.cjs 启动时读取）。
  // 界面反复崩溃、画面花屏时，崩溃对话框里的「关闭硬件加速并重启」会把 hardwareAcceleration 设为 false
  system: { highPerformanceGpu: true, hardwareAcceleration: true },
};

// 老版本的默认来源顺序：用户没改过的话启动时换成新默认
const LEGACY_SOURCES = ['commons', 'pexels', 'pixabay', 'bilibili', 'youtube'];

// AI 视频生成密钥（safeStorage 加密），soraKey 未填时 Sora 复用 openaiKey；
// jimengAk/jimengSk 是火山引擎即梦AI视觉服务的 AccessKey/SecretKey（arkKey 同时给即梦出图用）
const VIDEOGEN_SECRETS = ['arkKey', 'klingAk', 'klingSk', 'minimaxKey', 'runwayKey', 'geminiKey', 'soraKey', 'lumaKey', 'falKey', 'jimengAk', 'jimengSk'];

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SECRET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function isValidSecretName(name) {
  return typeof name === 'string' && !UNSAFE_KEYS.has(name) && SECRET_NAME_RE.test(name);
}

function sanitizeSecrets(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!isValidSecretName(k)) continue;
    out[k] = v;
  }
  return out;
}

function deepClone(v) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(v);
  } catch {}
  return JSON.parse(JSON.stringify(v));
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const baseVal = base && Object.prototype.hasOwnProperty.call(base, k) ? base[k] : undefined;
    if (v && typeof v === 'object' && !Array.isArray(v) && baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal)) {
      out[k] = deepMerge(baseVal, v);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge({}, v);
    } else if (v !== undefined) {
      out[k] = Array.isArray(v) ? deepClone(v) : v;
    }
  }
  return out;
}

// Windows 上杀毒软件、搜索索引偶尔短暂占着文件，改名会报这些错，稍等重试即可
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 读 JSON 对象：{ value } 成功；{ missing:true } 文件不存在；{ corrupt:true } 内容损坏；{ error } 读不了 */
function readJsonFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { missing: true } : { error: e };
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('内容不是对象');
    return { value };
  } catch (e) {
    return { corrupt: true, error: e };
  }
}

/** 读文件；损坏时改名留档并尝试用 .bak 恢复。healthy=true 表示磁盘上的文件完好（可以拿来做备份） */
function loadJsonWithRecovery(file, label) {
  const r = readJsonFile(file);
  if (r.value) return { value: r.value, healthy: true };
  if (r.missing) return { value: null, healthy: false };
  if (!r.corrupt) {
    log.warn(`[settings] 读取${label}失败，本次先用默认值`, r.error && (r.error.code || r.error.message));
    return { value: null, healthy: false };
  }
  const ext = path.extname(file);
  const kept = `${file.slice(0, file.length - ext.length)}.corrupt-${stamp()}${ext}`;
  try { fs.renameSync(file, kept); } catch {}
  log.warn(`[settings] ${label}文件已损坏，原文件改名为 ${path.basename(kept)}`, r.error && r.error.message);
  const b = readJsonFile(file + '.bak');
  if (b.value) {
    log.warn(`[settings] 已用备份恢复${label}`);
    return { value: b.value, healthy: false };
  }
  return { value: null, healthy: false };
}

/** 原子写：临时文件写完并刷盘后再改名替换；改名一直失败就退回直接覆盖写 */
function writeFileAtomic(file, text, opts = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mode = opts && opts.mode;
  const tmp = file + '.tmp';
  const fd = mode !== undefined ? fs.openSync(tmp, 'w', mode) : fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    try { fs.fsyncSync(fd); } catch {}
    if (mode !== undefined) { try { fs.fchmodSync(fd, mode); } catch {} }
  } finally {
    fs.closeSync(fd);
  }
  let lastErr = null;
  for (let i = 0; i < 6; i++) {
    try {
      fs.renameSync(tmp, file);
      if (mode !== undefined) { try { fs.chmodSync(file, mode); } catch {} }
      return;
    } catch (e) {
      lastErr = e;
      if (!RETRY_CODES.has(e && e.code)) break;
      if (i < 5) sleepSync(20 * (i + 1));
    }
  }
  try {
    fs.writeFileSync(file, text, mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) { try { fs.chmodSync(file, mode); } catch {} }
    log.warn('[settings] 改名替换失败，已直接覆盖写入', path.basename(file), lastErr && lastErr.code);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function saveError(what, e) {
  const reason = e && e.code === 'ENOSPC' ? '磁盘空间不足' : e && (e.code === 'EPERM' || e.code === 'EACCES') ? '没有写入权限或文件被占用' : (e && e.message) || String(e);
  const err = new Error(`${what}没能保存：${reason}`);
  err.code = (e && e.code) || 'SAVE_FAILED';
  return err;
}

/** @param {{dir?:string}} [opts] dir 只给单测用，默认是 userData */
function createSettings(opts = {}) {
  const dir = opts.dir || app.getPath('userData');
  const file = path.join(dir, 'settings.json');
  const secretsFile = path.join(dir, 'secrets.json');
  const loaded = loadJsonWithRecovery(file, '设置');
  let data = loaded.value ? deepMerge(DEFAULTS, loaded.value) : deepClone(DEFAULTS);
  // 老版本的默认来源顺序原样存着（用户没改过）：换成新的默认顺序，免 key 的来源在前
  const ps = data.web && data.web.preferredSources;
  if (Array.isArray(ps) && ps.join(',') === LEGACY_SOURCES.join(',')) data = deepMerge(data, { web: { preferredSources: [...DEFAULTS.web.preferredSources] } });
  const loadedSecrets = loadJsonWithRecovery(secretsFile, '密钥');
  let secrets = sanitizeSecrets(loadedSecrets.value);

  // 本次启动后第一次覆盖前，把完好的旧文件复制成 .bak
  let settingsBackedUp = !loaded.healthy;
  let secretsBackedUp = !loadedSecrets.healthy;
  function backupOnce(target) {
    try { fs.copyFileSync(target, target + '.bak'); } catch (e) {
      if (e && e.code !== 'ENOENT') log.warn('[settings] 备份失败', path.basename(target), e.code || e.message);
    }
  }

  function persist() {
    try {
      if (!settingsBackedUp) { settingsBackedUp = true; backupOnce(file); }
      writeFileAtomic(file, JSON.stringify(data, null, 2));
    } catch (e) {
      log.error('[settings] 保存设置失败', e);
      throw saveError('设置', e);
    }
  }
  function persistSecrets() {
    try {
      if (!secretsBackedUp) {
        secretsBackedUp = true;
        backupOnce(secretsFile);
        try { fs.chmodSync(secretsFile + '.bak', 0o600); } catch {}
      }
      writeFileAtomic(secretsFile, JSON.stringify(sanitizeSecrets(secrets)), { mode: 0o600 });
    } catch (e) {
      log.error('[settings] 保存密钥失败', e && e.code);
      throw saveError('密钥', e);
    }
  }

  const own = (name) => typeof name === 'string' && !UNSAFE_KEYS.has(name) && Object.prototype.hasOwnProperty.call(secrets, name);

  const api = {
    get() {
      const hasKeys = {};
      for (const k of VIDEOGEN_SECRETS) hasKeys[k] = !!secrets[k];
      const snap = deepClone(data);
      snap.videogen = { ...(snap.videogen || {}), hasKeys };
      return snap;
    },
    set(patch) {
      patch = patch && typeof patch === 'object' ? { ...patch } : {};
      // 顶层兼容写法：videogenProvider / arkKey 等
      if (typeof patch.videogenProvider === 'string') { patch.videogen = { ...(patch.videogen || {}), provider: patch.videogenProvider }; delete patch.videogenProvider; }
      const keys = {};
      for (const k of VIDEOGEN_SECRETS) if (k in patch) { keys[k] = patch[k]; delete patch[k]; }
      if (patch.videogen && typeof patch.videogen === 'object') {
        const vg = { ...patch.videogen };
        if (vg.keys && typeof vg.keys === 'object') Object.assign(keys, vg.keys);
        delete vg.keys; delete vg.hasKeys;
        patch.videogen = vg;
      }
      for (const [k, v] of Object.entries(keys)) {
        if (!VIDEOGEN_SECRETS.includes(k) || v === null || v === undefined) continue;
        api.setSecret(k, String(v).trim());
      }
      data = deepMerge(data, patch);
      persist();
      return api.get();
    },
    getSecret(name) {
      const v = own(name) ? secrets[name] : null;
      if (!v) return '';
      try {
        if (v.enc && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(v.data, 'base64'));
        return v.enc ? '' : Buffer.from(v.data, 'base64').toString('utf8');
      } catch { return ''; }
    },
    setSecret(name, value) {
      if (!isValidSecretName(name)) throw new Error('密钥名称不合法');
      if (!value) { delete secrets[name]; persistSecrets(); return; }
      if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
        secrets[name] = { enc: true, data: safeStorage.encryptString(String(value)).toString('base64') };
      } else {
        log.warn('[settings] safeStorage 加密不可用，密钥将降级以 base64 存入 secrets.json（已尝试设置 0600 权限）', name);
        secrets[name] = { enc: false, data: Buffer.from(String(value)).toString('base64') };
      }
      persistSecrets();
    },
    hasSecret(name) { return own(name) && !!secrets[name]; },
    DEFAULTS,
    VIDEOGEN_SECRETS,
  };
  return api;
}

module.exports = { createSettings, deepMerge, DEFAULTS, VIDEOGEN_SECRETS };
