// P0/P1 安全与回归测试集（纯离线、仅在 os.tmpdir() 使用临时目录并在 after 中清理）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

import {
  createProject, createAsset, createClip, createTextClip, createAudioClip, createShot, createOverlay, normalizeProject,
} from '../src/engine/model.js';
import { applyOps } from '../src/engine/ops.js';
import { subClip, clipDuration } from '../src/engine/timeline.js';
import { valueAt } from '../src/engine/keyframes.js';
import { buildAudioPlan } from '../src/export/audioPlan.js';
import { parseSrt, textsToSrt, wrapCaption } from '../src/engine/captions.js';
import { resolveExportOptions } from '../src/export/presets.js';
import { buildFootageQueries } from '../src/engine/stockFootage.js';
import { trimVideoClip } from '../src/ui/modes/refine/timelineUtils.js';
import { textAnimV3 } from '../src/render/text.js';
import { parseEditResponse } from '../src/ai/editor.js';

const require = createRequire(import.meta.url);

// ---------- 临时目录管理 & 假 Electron 注入 ----------
const tmpDirs = [];
function makeTmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const openedPaths = [];
const openedUrls = [];
const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: () => { throw new Error('单测不应读取真实 userData'); },
    setPath: () => {},
    requestSingleInstanceLock: () => false,
    exit: () => {},
  },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  Menu: { setApplicationMenu: () => {} },
  session: {},
  screen: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('ENC:' + Buffer.from(String(s), 'utf8').toString('hex')),
    decryptString: (b) => {
      const t = Buffer.from(b).toString();
      if (!t.startsWith('ENC:')) throw new Error('bad');
      return Buffer.from(t.slice(4), 'hex').toString('utf8');
    },
  },
  shell: {
    openPath: async (p) => { openedPaths.push(p); return ''; },
    openExternal: async (u) => { openedUrls.push(u); },
    showItemInFolder: () => {},
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
  },
  Notification: class { static isSupported() { return false; } },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest);
};

const log = require('../electron/lib/log.cjs');
const logDir = makeTmpDir('ff-sec-log-');
log.init({ dir: logDir, echo: 'none' });

const urlSafety = require('../electron/lib/urlSafety.cjs');
const codex = require('../electron/lib/codex.cjs');
const ytdlp = require('../electron/lib/ytdlp.cjs');
const vgUtil = require('../electron/lib/videogen/util.cjs');
const fal = require('../electron/lib/videogen/fal.cjs');
const veo = require('../electron/lib/videogen/veo.cjs');
const kling = require('../electron/lib/videogen/kling.cjs');
const asrLib = require('../electron/lib/asr.cjs');
const { createSettings, deepMerge, DEFAULTS } = require('../electron/lib/settings.cjs');
const registerAsr = require('../electron/ipc/asr.cjs');
const registerSystem = require('../electron/ipc/system.cjs');
const registerAnalysis = require('../electron/ipc/analysis.cjs');
const registerStore = require('../electron/ipc/store.cjs');
const registerMedia = require('../electron/ipc/media.cjs');
const registerAI = require('../electron/ipc/ai.cjs');

after(() => {
  log._reset();
  Module._load = origLoad;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
});

// ───────────────────────── 1. asr:transcribe v2 对象映射 project.assets ─────────────────────────

test('asr:transcribe：正确解析 v2 对象映射格式的 project.assets（并优先使用存在的 originalPath）', async () => {
  const dir = makeTmpDir('ff-sec-asr-');
  const projDir = path.join(dir, 'proj_1');
  fs.mkdirSync(projDir, { recursive: true });
  const mediaFile = path.join(dir, 'clip.mp4');
  const origFile = path.join(dir, 'clip-orig.mp4');
  fs.writeFileSync(mediaFile, Buffer.from('mp4'));
  fs.writeFileSync(origFile, Buffer.from('orig-mp4'));

  // v2 工程格式：assets 为 { [assetId]: Asset } 对象映射（而非数组）
  fs.writeFileSync(path.join(projDir, 'project.json'), JSON.stringify({
    version: 3,
    assets: {
      ast_v2: { id: 'ast_v2', kind: 'video', path: mediaFile },
      ast_orig: { id: 'ast_orig', kind: 'video', path: mediaFile, originalPath: origFile },
    },
  }));

  const handlers = {};
  const startedJobs = [];
  const ctx = {
    paths: {
      userData: dir,
      tmp: dir,
      ffmpeg: 'ffmpeg',
      projectDir: (id) => path.join(dir, id),
    },
    settings: { get: () => ({}), getSecret: (k) => (k === 'openaiKey' ? 'sk-test' : '') },
    jobs: {
      start: (kind, _fn, meta) => {
        startedJobs.push({ kind, meta });
        return { jobId: `job_${startedJobs.length}` };
      },
    },
  };
  registerAsr({ handle: (ch, fn) => { handlers[ch] = fn; }, ctx });

  const r1 = await handlers['asr:transcribe']({ projectId: 'proj_1', assetId: 'ast_v2' });
  assert.equal(r1.jobId, 'job_1');
  assert.equal(startedJobs[0].kind, 'asr');
  assert.equal(startedJobs[0].meta.assetId, 'ast_v2');

  const r2 = await handlers['asr:transcribe']({ projectId: 'proj_1', assetId: 'ast_orig' });
  assert.equal(r2.jobId, 'job_2');

  // 缺失素材与原型键（toString / __proto__）必须拒绝
  await assert.rejects(handlers['asr:transcribe']({ projectId: 'proj_1', assetId: 'ast_missing' }), /找不到要识别的音视频文件/);
  await assert.rejects(handlers['asr:transcribe']({ projectId: 'proj_1', assetId: 'toString' }), /找不到要识别的音视频文件/);
});

// ───────────────────────── 2. urlSafety.cjs SSRF 拦截 ─────────────────────────

test('urlSafety.cjs：拦截内网/环回/云元数据/IPv6/file://，放行公网 https 与显式 allowedOrigins', () => {
  const blocked = [
    'http://127.0.0.1/admin',
    'https://127.0.0.1:8080/api',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/secret',
    'http://172.16.5.4/internal',
    'http://192.168.1.1/router',
    'http://[::1]:8080/local',
    'http://[::ffff:127.0.0.1]/mapped',
    'http://[fc00::1]/ula',
    'http://[fe80::1]/link-local',
    'http://localhost:3000/',
    'http://sub.localhost/',
    'file:///C:/Windows/win.ini',
  ];
  for (const u of blocked) {
    assert.throws(() => urlSafety.assertSafePublicUrl(u), (e) => e && e.code === 'UNSAFE_URL', `应当拦截：${u}`);
  }
  assert.throws(() => urlSafety.assertSafePublicUrl('not a url'), (e) => e && e.code === 'BAD_URL');

  const pub = urlSafety.assertSafePublicUrl('https://example.com/path/v.mp4');
  assert.equal(pub.hostname, 'example.com');

  // 显式 allowedOrigins 精确同源放行，其他端口仍拦截
  const localOk = urlSafety.assertSafePublicUrl('http://127.0.0.1:8787/v1/chat', { allowedOrigins: ['http://127.0.0.1:8787'] });
  assert.equal(localOk.origin, 'http://127.0.0.1:8787');
  assert.throws(
    () => urlSafety.assertSafePublicUrl('http://127.0.0.1:9999/v1/chat', { allowedOrigins: ['http://127.0.0.1:8787'] }),
    (e) => e && e.code === 'UNSAFE_URL',
  );
});

// ───────────────────────── 3. fal.cjs 与 veo.cjs URL/凭据保护 ─────────────────────────

test('fal.cjs：拒绝不可信 status_url / response_url，伪造 taskId 在发起请求前被拦截', async () => {
  const cfg = { key: 'FAL_SECRET' };
  const makeResp = (json) => async () => new Response(JSON.stringify(json), { status: 200 });

  await assert.rejects(
    fal.submit({ prompt: 'a' }, cfg, {
      fetch: makeResp({
        request_id: 'req1',
        status_url: 'https://evil.example.com/steal',
        response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req1',
      }),
    }),
    (e) => e && e.code === 'UNTRUSTED_URL',
  );

  await assert.rejects(
    fal.submit({ prompt: 'a' }, cfg, {
      fetch: makeResp({
        request_id: 'req2',
        status_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req2/status',
        response_url: 'http://169.254.169.254/latest/meta-data/',
      }),
    }),
    (e) => e && e.code === 'UNTRUSTED_URL',
  );

  // 伪造 taskId：poll 与 fetchResult 都必须在调用 fetch 之前拒绝
  let fetched = 0;
  const spyFetch = async () => { fetched += 1; return new Response('{}', { status: 200 }); };
  const forged = fal.encodeTask({ id: 'x', s: 'https://evil.example.com/s', r: 'https://queue.fal.run/fal-ai/a/requests/x' });
  await assert.rejects(fal.poll(forged, cfg, { fetch: spyFetch }), (e) => e && e.code === 'UNTRUSTED_URL');
  await assert.rejects(fal.fetchResult(forged, cfg, { fetch: spyFetch }), (e) => e && e.code === 'UNTRUSTED_URL');
  assert.equal(fetched, 0, '拦截不可信地址后绝不能把 Authorization 发出去');
});

test('veo.cjs：拦截任务 ID 路径穿越与注入，跨域视频下载不泄露 API Key', async () => {
  const cfg = { key: 'GEMINI_SECRET_KEY' };
  let fetched = 0;
  const spyFetch = async () => { fetched += 1; return new Response('{}', { status: 200 }); };

  for (const badId of [
    '../admin',
    'models/veo/../../secrets',
    'models/%2e%2e/secrets',
    'https://evil.example.com/op',
    '//evil.example.com/op',
    'models/op?key=1',
    'models/op#frag',
  ]) {
    await assert.rejects(veo.poll(badId, cfg, { fetch: spyFetch }), (e) => e && e.code === 'BAD_TASK', badId);
  }
  assert.equal(fetched, 0, '非法 taskId 不得发出网络请求');

  // 同源下载地址携带 x-goog-api-key
  const sameOriginUrl = 'https://generativelanguage.googleapis.com/v1beta/files/vid1:download?alt=media';
  const sameRes = await veo.fetchResult('models/veo/operations/op1', cfg, {}, { url: sameOriginUrl });
  assert.equal(sameRes.url, sameOriginUrl);
  assert.equal(sameRes.headers['x-goog-api-key'], 'GEMINI_SECRET_KEY');

  // 跨域下载地址绝不附加 x-goog-api-key
  const crossOriginUrl = 'https://evil-cdn.example.com/video.mp4';
  const crossRes = await veo.fetchResult('models/veo/operations/op1', cfg, {}, { url: crossOriginUrl });
  assert.equal(crossRes.url, crossOriginUrl);
  assert.equal(crossRes.headers, undefined, '跨域下载不得携带 x-goog-api-key');
});

// ───────────────────────── 4. settings.cjs ─────────────────────────

test('settings.cjs：DEFAULTS 含 shortcuts/media/asr/consent，deepMerge 防原型污染，get() 返回隔离副本', () => {
  for (const k of ['shortcuts', 'media', 'asr', 'consent']) {
    assert.ok(Object.prototype.hasOwnProperty.call(DEFAULTS, k), `DEFAULTS 缺少 ${k}`);
    assert.equal(typeof DEFAULTS[k], 'object');
  }

  // 原型污染拦截
  const payload = JSON.parse('{"__proto__":{"ffPolluted":true},"constructor":{"prototype":{"ffPolluted2":true}},"prototype":{"ffPolluted3":true},"nested":{"__proto__":{"ffPolluted4":true},"val":42}}');
  const merged = deepMerge({ nested: { val: 1 } }, payload);
  assert.equal(({}).ffPolluted, undefined);
  assert.equal(({}).ffPolluted2, undefined);
  assert.equal(({}).ffPolluted3, undefined);
  assert.equal(({}).ffPolluted4, undefined);
  assert.equal(Object.prototype.ffPolluted, undefined);
  assert.equal(merged.nested.val, 42);

  // get() 返回深拷贝，外部修改不影响内部状态
  const dir = makeTmpDir('ff-sec-settings-');
  const s = createSettings({ dir });
  const snap1 = s.get();
  snap1.ui.scale = 99;
  snap1.web.preferredSources.push('injected');
  snap1.shortcuts.overrides.playPause = ['KeyX'];

  const snap2 = s.get();
  assert.equal(snap2.ui.scale, DEFAULTS.ui.scale);
  assert.ok(!snap2.web.preferredSources.includes('injected'));
  assert.equal(snap2.shortcuts.overrides.playPause, undefined);
});

// ───────────────────────── 5. system.cjs ─────────────────────────

test('system.cjs：shell:openPath 白名单与 UNC/尾点空格拦截，shell:openExternal 仅放行 https:', async () => {
  const dir = makeTmpDir('ff-sec-sys-');
  const okMp4 = path.join(dir, 'demo.mp4');
  const okTxt = path.join(dir, 'readme.txt');
  const badExe = path.join(dir, 'payload.exe');
  const badBat = path.join(dir, 'run.bat');
  fs.writeFileSync(okMp4, 'mp4');
  fs.writeFileSync(okTxt, 'txt');
  fs.writeFileSync(badExe, 'exe');
  fs.writeFileSync(badBat, 'bat');

  openedPaths.length = 0;
  openedUrls.length = 0;
  const handlers = {};
  const ctx = { paths: { userData: dir }, registerMediaPath: () => {}, getWindow: () => null };
  registerSystem({ handle: (ch, fn) => { handlers[ch] = fn; }, ctx });

  // 危险文件、尾随点/空格伪装、UNC 网络路径全部拒绝
  await assert.rejects(handlers['shell:openPath']({ path: badExe }), /安全/);
  await assert.rejects(handlers['shell:openPath']({ path: `${badExe}.` }), /不合法/);
  await assert.rejects(handlers['shell:openPath']({ path: `${badBat} ` }), /不合法/);
  await assert.rejects(handlers['shell:openPath']({ path: '\\\\host\\share\\a.mp4' }), /UNC/);
  await assert.rejects(handlers['shell:openPath']({ path: '//host/share/a.mp4' }), /UNC/);
  assert.equal(openedPaths.length, 0);

  // 白名单文件允许打开
  assert.equal(await handlers['shell:openPath']({ path: okMp4 }), true);
  assert.equal(await handlers['shell:openPath']({ path: okTxt }), true);
  assert.deepEqual(openedPaths, [path.resolve(okMp4), path.resolve(okTxt)]);

  // shell:openExternal 拒绝 http: / file: / javascript:，仅放行 https:
  await assert.rejects(handlers['shell:openExternal']({ url: 'http://example.com' }), /https/);
  await assert.rejects(handlers['shell:openExternal']({ url: 'file:///C:/Windows/win.ini' }), /https/);
  await assert.rejects(handlers['shell:openExternal']({ url: 'javascript:alert(1)' }), /https/);
  assert.equal(openedUrls.length, 0);

  assert.equal(await handlers['shell:openExternal']({ url: 'https://example.com/help' }), true);
  assert.deepEqual(openedUrls, ['https://example.com/help']);
});

// ───────────────────────── 6. 引擎与导出回归 ─────────────────────────

test('ops.js：updateText 允许显式传入 { shadow: null, bg: null } 清除样式', () => {
  const p = createProject({ name: 'text-clear' });
  const t = createTextClip({
    id: 'txt_1',
    start: 0,
    duration: 3,
    text: '你好',
    shadow: { color: '#000000', blur: 6, x: 2, y: 2 },
    bg: { color: '#111111', opacity: 0.7 },
  });
  p.tracks.text = [t];
  const r = applyOps(p, [{ type: 'updateText', textId: 'txt_1', text: { shadow: null, bg: null } }]);
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.project.tracks.text[0].shadow, null);
  assert.equal(r.project.tracks.text[0].bg, null);
});

test('timeline.js：subClip 分割时在切点烘焙关键帧边界，左右半段过渡连续不跳变', () => {
  const a = createAsset({ id: 'v1', kind: 'video', duration: 10 });
  const clip = createClip(a, {
    id: 'c1',
    in: 0,
    out: 4,
    keys: { opacity: [{ t: 0, v: 0, ease: 'linear' }, { t: 4, v: 1, ease: 'linear' }] },
  });
  const left = subClip(clip, 0, 2);
  const right = subClip(clip, 2, 4);

  const near = (x, y) => Math.abs(x - y) < 1e-3;
  assert.ok(near(valueAt(left.keys, 'opacity', 0, 1), 0));
  assert.ok(near(valueAt(left.keys, 'opacity', 1, 1), 0.25));
  assert.ok(near(valueAt(left.keys, 'opacity', 2, 1), 0.5), `左半切点应烘焙为 0.5，实际 ${valueAt(left.keys, 'opacity', 2, 1)}`);
  assert.ok(near(valueAt(right.keys, 'opacity', 0, 1), 0.5), `右半切点应烘焙为 0.5，实际 ${valueAt(right.keys, 'opacity', 0, 1)}`);
  assert.ok(near(valueAt(right.keys, 'opacity', 1, 1), 0.75));
  assert.ok(near(valueAt(right.keys, 'opacity', 2, 1), 1));
});

test('audioPlan.js：遵守 trackState.video/audio/overlay 静音与音频片段 clip.muted', () => {
  function baseProj() {
    const p = createProject({ name: 'mute' });
    const v = createAsset({ id: 'v1', kind: 'video', path: 'C:/v.mp4', duration: 10, hasAudio: true });
    const m = createAsset({ id: 'm1', kind: 'audio', path: 'C:/m.mp3', duration: 20, hasAudio: true });
    p.assets = { v1: v, m1: m };
    p.tracks.video = [createClip(v, { id: 'c1', in: 0, out: 4 })];
    p.tracks.audio = [
      createAudioClip(m, { id: 'a1', start: 0, in: 0, out: 4 }),
      createAudioClip(m, { id: 'a2', start: 0, in: 0, out: 4, muted: true }),
    ];
    p.overlays = [
      { id: 'o1', assetId: 'v1', kind: 'video', track: 1, start: 0, in: 0, out: 3 },
      { id: 'o2', assetId: 'v1', kind: 'video', track: 2, start: 0, in: 0, out: 3 },
    ];
    return p;
  }

  // clip.muted=true 的音频片段（a2）不出声，a1 正常出声
  const p0 = baseProj();
  const plan0 = buildAudioPlan(p0, { duration: 4 });
  assert.equal(plan0.segments.filter((s) => s.role === 'clip').length, 1);
  assert.equal(plan0.segments.filter((s) => s.role === 'music').length, 1, 'muted 音频片段应被跳过');
  assert.equal(plan0.segments.filter((s) => s.role === 'overlay').length, 2);

  // trackState.video.muted = true → 主轨不出声
  const p1 = baseProj();
  p1.trackState.video.muted = true;
  assert.equal(buildAudioPlan(p1, { duration: 4 }).segments.filter((s) => s.role === 'clip').length, 0);

  // trackState.audio.muted = true → 音频轨整轨不出声
  const p2 = baseProj();
  p2.trackState.audio.muted = true;
  assert.equal(buildAudioPlan(p2, { duration: 4 }).segments.filter((s) => s.role === 'music').length, 0);

  // trackState.overlay[1].muted = true → 仅静音画中画 1 轨，保留画中画 2 轨
  const p3 = baseProj();
  p3.trackState.overlay[1].muted = true;
  assert.equal(buildAudioPlan(p3, { duration: 4 }).segments.filter((s) => s.role === 'overlay').length, 1);
});

test('captions.js：兼容 WebVTT MM:SS.mmm、清理字幕内空行、wrapCaption(s, 0) 不死循环', () => {
  const vtt = 'WEBVTT\n\n00:01.500 --> 00:03.250\n第一句\n\n01:02.000 --> 01:05.500\n第二句\n';
  assert.deepEqual(parseSrt(vtt), [
    { start: 1.5, end: 3.25, text: '第一句' },
    { start: 62, end: 65.5, text: '第二句' },
  ]);

  // 字幕正文含空行时，textsToSrt 应折叠空行避免破坏 SRT 块分隔
  const srt = textsToSrt([{ start: 0, duration: 2, text: '上行\n\n  \n下行' }]);
  const back = parseSrt(srt);
  assert.equal(back.length, 1);
  assert.equal(back[0].text, '上行\n下行');

  // max <= 0 或 NaN 安全返回原文
  assert.equal(wrapCaption('你好世界', 0), '你好世界');
  assert.equal(wrapCaption('你好世界', -5), '你好世界');
  assert.equal(wrapCaption('你好世界', NaN), '你好世界');
});

test('presets.js：overrides.bitrate 为 null 时不覆盖清零预设码率', () => {
  const keep = resolveExportOptions('douyin', { width: 1080, height: 1920, fps: 30 }, { bitrate: null });
  assert.equal(keep.bitrate, 10000);
  const zero = resolveExportOptions('douyin', { width: 1080, height: 1920, fps: 30 }, { bitrate: 0 });
  assert.equal(zero.bitrate, 0);
});

test('stockFootage.js：shotSize 为 close-up 时命中特写提示词', () => {
  const qs = buildFootageQueries(createShot({ title: '杯子', subject: '咖啡杯', shotSize: 'close-up' }));
  assert.ok(qs.some((q) => q.includes('close up')), `期望包含 close up，实际：${JSON.stringify(qs)}`);
});

// ───────────────────────── 7. 红队专项回归：后端与安全 ─────────────────────────

async function startLocalServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

test('system.cjs：shell:showItem 拒绝非目录父路径回退执行，shell:openPath 失败关闭并拦截混合斜杠 UNC，media:register 拒绝 UNC', async () => {
  const userDir = makeTmpDir('ff-sec-sys2-ud-');
  const mediaDir = makeTmpDir('ff-sec-sys2-media-');
  const existingExePath = path.join(mediaDir, 'payload.exe');
  const okMp4 = path.join(mediaDir, 'clip.mp4');
  fs.writeFileSync(existingExePath, 'MZ');
  fs.writeFileSync(okMp4, 'mp4');

  openedPaths.length = 0;
  const registered = [];
  const handlers = {};
  const ctx = {
    paths: { userData: userDir },
    registerMediaPath: (p) => registered.push(p),
    getWindow: () => null,
  };
  registerSystem({ handle: (ch, fn) => { handlers[ch] = fn; }, ctx });

  // 1) shell:showItem 传入 existingExePath/nonexistent 时不得回退对文件调用 shell.openPath
  await assert.rejects(handlers['shell:showItem']({ path: path.join(existingExePath, 'nonexistent') }));
  assert.equal(openedPaths.length, 0, 'shell:showItem 不得对非目录父路径调用 shell.openPath');

  // 2) shell:openPath 对不存在目标、不可解析 realpath 的目标以及 UNC/混合斜杠 UNC 一律失败关闭
  await assert.rejects(handlers['shell:openPath']({ path: path.join(mediaDir, 'nonexistent.mp4') }));
  for (const unc of [
    '\\\\host\\share\\a.mp4',
    '//host/share/a.mp4',
    '\\/host/share/a.mp4',
    '/\\host\\share\\a.mp4',
  ]) {
    await assert.rejects(handlers['shell:openPath']({ path: unc }), `shell:openPath 应拦截 UNC：${unc}`);
  }

  const cjsFs = require('node:fs');
  const origRealpathSync = cjsFs.realpathSync;
  const origRealpathAsync = cjsFs.promises.realpath;
  const targetAbs = path.resolve(okMp4);
  const failUnresolvable = (p) => {
    if (path.resolve(String(p)) === targetAbs) {
      const e = new Error('ELOOP: too many symbolic links encountered');
      e.code = 'ELOOP';
      throw e;
    }
  };
  const wrappedSync = function (p, ...rest) {
    failUnresolvable(p);
    return origRealpathSync.call(this, p, ...rest);
  };
  wrappedSync.native = origRealpathSync.native;
  cjsFs.realpathSync = wrappedSync;
  cjsFs.promises.realpath = async function (p, ...rest) {
    failUnresolvable(p);
    return origRealpathAsync.call(this, p, ...rest);
  };
  try {
    await assert.rejects(handlers['shell:openPath']({ path: okMp4 }), 'realpath 失败时 shell:openPath 必须失败关闭');
  } finally {
    cjsFs.realpathSync = origRealpathSync;
    cjsFs.promises.realpath = origRealpathAsync;
  }
  assert.equal(openedPaths.length, 0, '被拦截的 shell:openPath 绝不能调用底层 openPath');

  // 3) media:register 拒绝 UNC 与混合斜杠 UNC，同时放行合法本地媒体
  for (const unc of ['\\\\host\\share\\a.mp4', '\\/host/share/a.mp4', '/\\host\\share\\a.mp4']) {
    try { await handlers['media:register']({ paths: [unc] }); } catch {}
  }
  assert.deepEqual(registered, [], 'media:register 不得注册 UNC 或混合斜杠 UNC');

  await handlers['media:register']({ paths: [okMp4] });
  assert.equal(registered.length, 1, '合法本地媒体文件应正常注册');
});

test('codex.cjs：quoteForCmd 拒绝 % 环境变量展开，isValidCodexPath 拦截混合斜杠 UNC', () => {
  const { quoteForCmd, isValidCodexPath } = codex._internals;
  assert.throws(() => quoteForCmd('%USERNAME%'));
  assert.throws(() => quoteForCmd('foo%PATH%bar'));
  assert.equal(quoteForCmd('plain-arg'), 'plain-arg');

  assert.equal(isValidCodexPath('\\/evil.com/share/codex.exe'), false);
  assert.equal(isValidCodexPath('/\\evil.com/share/codex.exe'), false);
  assert.equal(isValidCodexPath('\\\\evil.com\\share\\codex.exe'), false);
  assert.equal(isValidCodexPath('//evil.com/share/codex.exe'), false);
  assert.equal(isValidCodexPath(process.platform === 'win32' ? 'C:\\Tools\\codex.exe' : '/usr/local/bin/codex'), true);
});

test('urlSafety.cjs & fal.cjs：拦截 CGNAT/NAT64/多播/广播/尾点 localhost、协议降级与非官方 fal.run 租户', async () => {
  const blocked = [
    'http://100.100.100.200/latest/meta-data/',
    'http://100.64.0.1/x',
    'http://[::ffff:0:127.0.0.1]/x',
    'http://[64:ff9b::127.0.0.1]/x',
    'http://224.0.0.1/x',
    'http://255.255.255.255/x',
    'http://localhost./img.png',
  ];
  for (const u of blocked) {
    assert.throws(() => urlSafety.assertSafePublicUrl(u), (e) => e && e.code === 'UNSAFE_URL', `应当拦截：${u}`);
  }

  assert.equal(urlSafety.isTrustedHostForBase('https://example.com/a', 'http://example.com'), false);
  assert.equal(urlSafety.isTrustedHostForBase('https://example.com/a', 'https://example.com'), true);

  const makeResp = (json) => async () => new Response(JSON.stringify(json), { status: 200 });
  let fetched = 0;
  const spyFetch = async () => { fetched += 1; return new Response('{}', { status: 200 }); };

  // 自定义代理 baseUrl 时必须拒绝 attacker-app.fal.run
  const proxyCfg = { key: 'FAL_SECRET', baseUrl: 'https://proxy.example.com' };
  await assert.rejects(
    fal.submit({ prompt: 'a' }, proxyCfg, {
      fetch: makeResp({
        request_id: 'req_proxy',
        status_url: 'https://attacker-app.fal.run/steal',
        response_url: 'https://proxy.example.com/fal-ai/kling-video/requests/req_proxy',
      }),
    }),
    (e) => e && e.code === 'UNTRUSTED_URL',
  );
  const forgedProxy = fal.encodeTask({
    id: 'p1',
    s: 'https://attacker-app.fal.run/steal',
    r: 'https://proxy.example.com/fal-ai/kling-video/requests/p1',
  });
  await assert.rejects(fal.poll(forgedProxy, proxyCfg, { fetch: spyFetch }), (e) => e && e.code === 'UNTRUSTED_URL');
  await assert.rejects(fal.fetchResult(forgedProxy, proxyCfg, { fetch: spyFetch }), (e) => e && e.code === 'UNTRUSTED_URL');

  // 默认配置下也必须拒绝非官方 *.fal.run 租户应用
  const defaultCfg = { key: 'FAL_SECRET' };
  await assert.rejects(
    fal.submit({ prompt: 'a' }, defaultCfg, {
      fetch: makeResp({
        request_id: 'req_tenant',
        status_url: 'https://attacker-app.fal.run/steal',
        response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req_tenant',
      }),
    }),
    (e) => e && e.code === 'UNTRUSTED_URL',
  );
  const forgedTenant = fal.encodeTask({
    id: 't1',
    s: 'https://user-tenant.fal.run/status',
    r: 'https://queue.fal.run/fal-ai/kling-video/requests/t1',
  });
  await assert.rejects(fal.poll(forgedTenant, defaultCfg, { fetch: spyFetch }), (e) => e && e.code === 'UNTRUSTED_URL');
  assert.equal(fetched, 0, '拒绝不可信 fal.run 租户前绝不能发出请求');

  // 正向对照：官方 queue.fal.run 与自定义代理同源地址仍被接受
  const okDefault = await fal.submit({ prompt: 'a' }, defaultCfg, {
    fetch: makeResp({
      request_id: 'req_ok',
      status_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req_ok/status',
      response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req_ok',
    }),
  });
  assert.match(okDefault.taskId, /^fal1\./);
  const okProxy = await fal.submit({ prompt: 'a' }, proxyCfg, {
    fetch: makeResp({
      request_id: 'req_proxy_ok',
      status_url: 'https://proxy.example.com/fal-ai/kling-video/requests/req_proxy_ok/status',
      response_url: 'https://proxy.example.com/fal-ai/kling-video/requests/req_proxy_ok',
    }),
  });
  assert.match(okProxy.taskId, /^fal1\./);
});

test('ytdlp.cjs：downloadUrlToFile 拦截 302 重定向到环回 /secret 且绝不落盘', async () => {
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sec-ytdlp-dl-'));
  let redirHits = 0;
  let secretHit = false;
  const secretSrv = await startLocalServer((req, res) => {
    if (req.url === '/secret') secretHit = true;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('LOOPBACK_SECRET_PAYLOAD');
  });
  const redirSrv = await startLocalServer((req, res) => {
    redirHits += 1;
    res.writeHead(302, { Location: `http://127.0.0.1:${secretSrv.port}/secret` });
    res.end();
  });

  try {
    const dest1 = path.join(dlDir, 'out1.bin');
    await assert.rejects(
      ytdlp.downloadUrlToFile(`${redirSrv.origin}/start`, dest1, {
        allowedOrigins: [redirSrv.origin],
      }),
      (e) => e && e.code === 'UNSAFE_URL',
    );
    assert.equal(redirHits, 1, '应先访问本地 302 测试服务器以验证重定向拦截');
    assert.equal(secretHit, false, '重定向目标 127.0.0.1:<port>/secret 不得被访问');
    assert.equal(fs.existsSync(dest1), false, '被拦截的重定向不得写出目标文件');
    assert.equal(fs.existsSync(`${dest1}.part`), false, '被拦截的重定向不得残留 .part 文件');

    const dest2 = path.join(dlDir, 'out2.bin');
    await assert.rejects(ytdlp.downloadUrlToFile(`${redirSrv.origin}/start`, dest2), (e) => e && e.code === 'UNSAFE_URL');
    assert.equal(secretHit, false, '未授权环回重定向不得访问 /secret');
    assert.equal(fs.existsSync(dest2), false, '未授权环回下载不得写出目标文件');
  } finally {
    await redirSrv.close();
    await secretSrv.close();
    fs.rmSync(dlDir, { recursive: true, force: true });
  }
});

test('videogen/util.cjs：requestJson 遇到跨域 302 重定向时不把 x-goog-api-key 发送到第二个源', async () => {
  let redirHits = 0;
  let seenHeaders = null;
  const targetSrv = await startLocalServer((req, res) => {
    seenHeaders = { ...req.headers };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const redirSrv = await startLocalServer((req, res) => {
    redirHits += 1;
    res.writeHead(302, { Location: `${targetSrv.origin}/target` });
    res.end();
  });

  try {
    let err = null;
    let res = null;
    try {
      res = await vgUtil.requestJson(globalThis.fetch, `${redirSrv.origin}/api`, {
        headers: {
          'x-goog-api-key': 'GEMINI_REDIRECT_SECRET_123',
          Authorization: 'Bearer REDIRECT_TOKEN_456',
        },
      });
    } catch (e) {
      err = e;
    }

    assert.equal(redirHits, 1, '应先命中第一个本地 302 测试服务器');
    if (seenHeaders) {
      assert.equal(seenHeaders['x-goog-api-key'], undefined, '跨域 302 不得携带 x-goog-api-key');
      assert.equal(seenHeaders.authorization, undefined, '跨域 302 不得携带 Authorization');
      assert.equal(err, null);
      assert.deepEqual(res, { ok: true });
    } else {
      assert.ok(err, '未跟随跨域重定向时应明确报错拒绝');
    }

    // 公网跨域 302 重定向：跟随目标时也必须剥离 x-goog-api-key / Authorization，保留普通请求头
    const calls = [];
    const pubFetch = async (url, init = {}) => {
      calls.push({ url, headers: { ...(init.headers || {}) }, redirect: init.redirect });
      if (calls.length === 1) {
        return new Response('', { status: 302, headers: { location: 'https://cdn.example.com/final.json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const pubRes = await vgUtil.requestJson(pubFetch, 'https://generativelanguage.googleapis.com/v1/op', {
      headers: {
        'x-goog-api-key': 'GEMINI_REDIRECT_SECRET_123',
        Authorization: 'Bearer REDIRECT_TOKEN_456',
        Accept: 'application/json',
      },
    });
    assert.deepEqual(pubRes, { ok: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].redirect, 'manual');
    assert.equal(calls[1].url, 'https://cdn.example.com/final.json');
    assert.equal(calls[1].headers['x-goog-api-key'], undefined, '公网跨域 302 必须剥离 x-goog-api-key');
    assert.equal(calls[1].headers.Authorization, undefined, '公网跨域 302 必须剥离 Authorization');
    assert.equal(calls[1].headers.Accept, 'application/json');
  } finally {
    await redirSrv.close();
    await targetSrv.close();
  }
});

test('kling.cjs：poll 拒绝非法 kind（路径穿越与查询串注入），返回 BAD_TASK', async () => {
  const cfg = { ak: 'AK_TEST', sk: 'SK_TEST' };
  let fetched = 0;
  const spyFetch = async () => { fetched += 1; return new Response('{}', { status: 200 }); };

  for (const badId of ['../../admin:123', 'foo?bar:123']) {
    await assert.rejects(
      kling.poll(badId, cfg, { fetch: spyFetch }),
      (e) => e && e.code === 'BAD_TASK',
      `应以 BAD_TASK 拒绝：${badId}`,
    );
  }
  assert.equal(fetched, 0, '非法 taskId 不得发出网络请求');
});

test('log.cjs：formatArgs 隐藏带引号请求头密钥，redact 隐藏 URL 内嵌凭据', () => {
  const formatted = log.formatArgs([{
    headers: { 'x-goog-api-key': 'GEMINI_SECRET_999', 'x-api-key': 'API_SECRET_888' },
  }]);
  assert.ok(!formatted.includes('GEMINI_SECRET_999'), `未脱敏 x-goog-api-key：${formatted}`);
  assert.ok(!formatted.includes('API_SECRET_888'), `未脱敏 x-api-key：${formatted}`);

  const redactedUrl = log.redact('https://admin:SuperSecret99@api.example.com/v1');
  assert.ok(!redactedUrl.includes('SuperSecret99'), `未脱敏 URL 密码：${redactedUrl}`);
  assert.ok(redactedUrl.includes('api.example.com/v1'), `应保留主机和路径：${redactedUrl}`);
});

test('settings.cjs：setSecret 拒绝原型污染键名 constructor / prototype / __proto__', () => {
  const dir = makeTmpDir('ff-sec-secret-key-');
  const s = createSettings({ dir });
  assert.throws(() => s.setSecret('constructor', 'boom'));
  assert.throws(() => s.setSecret('prototype', 'boom'));
  assert.throws(() => s.setSecret('__proto__', 'boom'));
  assert.equal(s.hasSecret('constructor'), false);
});

// ───────────────────────── 8. 红队专项回归：引擎 / 渲染 / 导出 / AI / Store ─────────────────────────

test('水平镜像：混合选中与旧版 flipH 状态执行 setClipProps({ mirror: { h: true } }) 后两字段均保持 true', () => {
  const v = createAsset({ id: 'v1', kind: 'video', duration: 10 });
  const pMix = createProject({ name: 'mirror-mix' });
  pMix.assets = { v1: v };
  pMix.tracks.video = [
    createClip(v, { id: 'c1', mirror: { h: false, v: false }, transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false } }),
    createClip(v, { id: 'c2', mirror: { h: true, v: false }, transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: true } }),
  ];

  const rMix = applyOps(pMix, [{ type: 'setClipProps', ids: ['c1', 'c2'], patch: { mirror: { h: true } } }]);
  assert.equal(rMix.ok, true, rMix.errors.join('；'));
  for (const clip of rMix.project.tracks.video) {
    assert.equal(clip.mirror.h, true, `${clip.id}.mirror.h 应为 true`);
    assert.equal(clip.transform.flipH, true, `${clip.id}.transform.flipH 应为 true`);
  }
  const nMix = normalizeProject(rMix.project);
  for (const clip of nMix.tracks.video) {
    assert.equal(clip.mirror.h, true);
    assert.equal(clip.transform.flipH, true);
  }

  // 旧版不一致数据：{ mirror: { h: false }, transform: { flipH: true } }
  const pLegacy = createProject({ name: 'mirror-legacy' });
  pLegacy.assets = { v1: v };
  pLegacy.tracks.video = [
    createClip(v, { id: 'c_old', mirror: { h: false, v: false }, transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: true } }),
  ];
  const rLegacy = applyOps(pLegacy, [{ type: 'setClipProps', id: 'c_old', patch: { mirror: { h: true } } }]);
  assert.equal(rLegacy.ok, true, rLegacy.errors.join('；'));
  assert.equal(rLegacy.project.tracks.video[0].mirror.h, true);
  assert.equal(rLegacy.project.tracks.video[0].transform.flipH, true);
  const nLegacy = normalizeProject(rLegacy.project);
  assert.equal(nLegacy.tracks.video[0].mirror.h, true);
  assert.equal(nLegacy.tracks.video[0].transform.flipH, true);
});

test('ops.js：setClipProps 支持 denoise，锁定画中画轨拒绝删除/移入，setTransform 宽范围缩放与位移经 normalizeProject 保留', () => {
  const v = createAsset({ id: 'v1', kind: 'video', duration: 10 });
  const p = createProject({ name: 'ops-redteam' });
  p.assets = { v1: v };
  p.tracks.video = [createClip(v, { id: 'c1', in: 0, out: 4 })];

  // 1) setClipProps({ denoise: true })
  const rDenoise = applyOps(p, [{ type: 'setClipProps', id: 'c1', patch: { denoise: true } }]);
  assert.equal(rDenoise.ok, true, rDenoise.errors.join('；'));
  assert.equal(rDenoise.project.tracks.video[0].denoise, true);

  // 2) removeOverlay 在锁定的画中画轨道上失败
  const pOvLock = createProject({ name: 'ov-lock' });
  pOvLock.assets = { v1: v };
  pOvLock.tracks.video = [createClip(v, { id: 'c1', in: 0, out: 4 })];
  pOvLock.overlays = [createOverlay(v, { id: 'ov1', track: 1, start: 0, in: 0, out: 3 })];
  pOvLock.trackState.overlay[1].locked = true;
  const rRem = applyOps(pOvLock, [{ type: 'removeOverlay', id: 'ov1' }]);
  assert.equal(rRem.ok, false, '锁定画中画轨道上的 removeOverlay 必须失败');
  assert.equal(rRem.project.overlays.length, 1);

  // 3) updateOverlay 移入锁定画中画轨道失败
  const pOvMove = createProject({ name: 'ov-move-lock' });
  pOvMove.assets = { v1: v };
  pOvMove.tracks.video = [createClip(v, { id: 'c1', in: 0, out: 4 })];
  pOvMove.overlays = [createOverlay(v, { id: 'ov1', track: 1, start: 0, in: 0, out: 3 })];
  pOvMove.trackState.overlay[2].locked = true;
  const rMove = applyOps(pOvMove, [{ type: 'updateOverlay', id: 'ov1', patch: { track: 2 } }]);
  assert.equal(rMove.ok, false, 'updateOverlay 移入锁定轨道必须失败');
  assert.equal(rMove.project.overlays[0].track, 1);

  // 4) setTransform 宽范围值（scale: 0.2, x: 1.5 与 scale: 3.5）经 applyOps -> normalizeProject 不丢失
  const rTf1 = applyOps(p, [{ type: 'setTransform', target: { mode: 'ids', indices: [], ids: ['c1'] }, transform: { scale: 0.2, x: 1.5 } }]);
  assert.equal(rTf1.ok, true, rTf1.errors.join('；'));
  const norm1 = normalizeProject(rTf1.project);
  assert.equal(norm1.tracks.video[0].transform.scale, 0.2);
  assert.equal(norm1.tracks.video[0].transform.x, 1.5);

  const rTf2 = applyOps(p, [{ type: 'setTransform', target: { mode: 'ids', indices: [], ids: ['c1'] }, transform: { scale: 3.5 } }]);
  assert.equal(rTf2.ok, true, rTf2.errors.join('；'));
  const norm2 = normalizeProject(rTf2.project);
  assert.equal(norm2.tracks.video[0].transform.scale, 3.5);
});

test('timelineUtils.js：still: true 定格视频片段拖边走 still/setDuration，clipDuration 返回 2 而非 0.2', () => {
  const v = createAsset({ id: 'v1', kind: 'video', duration: 10 });
  const freezeClip = createClip(v, { id: 'c_freeze', still: true, in: 3, out: 3, duration: 3, speed: 1 });

  // 默认定格片段时长为 2 秒而非 0.2 秒
  assert.equal(clipDuration({ still: true, in: 3, out: 3, speed: 1 }), 2);

  // 右边缘缩短 1 秒：3 -> 2 秒，返回 still: true 以便走 setDuration 而非 trim
  const trimmed = trimVideoClip(freezeClip, v, 'right', -1);
  assert.equal(trimmed.still, true, '定格视频片段拖边必须返回 still: true');
  assert.equal(trimmed.duration, 2, `期望时长 2 秒，实际 ${trimmed.duration}`);

  // 左边缘缩短 1 秒同样返回 still: true 与 duration: 2
  const trimmedLeft = trimVideoClip(freezeClip, v, 'left', 1);
  assert.equal(trimmedLeft.still, true);
  assert.equal(trimmedLeft.duration, 2);

  // 通过 setDuration 实际提交后 clipDuration 返回 2
  const p = createProject({ name: 'freeze-trim' });
  p.assets = { v1: v };
  p.tracks.video = [freezeClip];
  const r = applyOps(p, [{ type: 'setDuration', target: { mode: 'ids', indices: [], ids: ['c_freeze'] }, duration: trimmed.duration }]);
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(clipDuration(r.project.tracks.video[0]), 2);
});

test('audioPlan.js：画中画音频遵循 audioFadeIn / audioFadeOut 并在超限时按半时长约束夹紧', () => {
  const v = createAsset({ id: 'v1', kind: 'video', path: 'C:/v.mp4', duration: 10, hasAudio: true });

  // 足够长（6 秒）的画中画：1.5 / 2.0 均不超过半时长 3.0，原样输出
  const pLong = createProject({ name: 'ov-fade-long' });
  pLong.assets = { v1: v };
  pLong.tracks.video = [createClip(v, { id: 'c1', in: 0, out: 6, mute: true, muted: true })];
  pLong.overlays = [
    createOverlay(v, { id: 'o1', track: 1, start: 0, in: 0, out: 6, audioFadeIn: 1.5, audioFadeOut: 2.0 }),
  ];
  const planLong = buildAudioPlan(pLong, { duration: 6 });
  const segLong = planLong.segments.find((s) => s.role === 'overlay');
  assert.ok(segLong, '应生成画中画音频段');
  assert.equal(segLong.fadeIn, 1.5);
  assert.equal(segLong.fadeOut, 2);

  // 较短（2 秒）的画中画：超过半时长（1 秒）时被夹紧
  const pShort = createProject({ name: 'ov-fade-short' });
  pShort.assets = { v1: v };
  pShort.tracks.video = [createClip(v, { id: 'c1', in: 0, out: 4, mute: true, muted: true })];
  pShort.overlays = [
    createOverlay(v, { id: 'o_eq', track: 1, start: 0, in: 0, out: 2, audioFadeIn: 1.5, audioFadeOut: 1.5 }),
    createOverlay(v, { id: 'o_asym', track: 2, start: 0, in: 0, out: 2, audioFadeIn: 1.5, audioFadeOut: 2.0 }),
  ];
  const planShort = buildAudioPlan(pShort, { duration: 4 });
  const ovSegs = planShort.segments.filter((s) => s.role === 'overlay');
  assert.equal(ovSegs.length, 2);
  assert.equal(ovSegs[0].fadeIn, 1);
  assert.equal(ovSegs[0].fadeOut, 1);
  assert.ok(ovSegs[1].fadeIn <= 1 + 1e-6 && ovSegs[1].fadeOut <= 1 + 1e-6, `期望按半时长夹紧，实际 fadeIn=${ovSegs[1].fadeIn}, fadeOut=${ovSegs[1].fadeOut}`);
});

test('text.js：textAnimV3 所有非 none 动画均生效，blur 输出正模糊量，bounce 与 fade 不同', () => {
  const isIdentity = (st) => (
    Math.abs((st.alpha ?? 1) - 1) < 1e-4
    && Math.abs((st.scale ?? 1) - 1) < 1e-4
    && Math.abs(st.dx || 0) < 1e-4
    && Math.abs(st.dy || 0) < 1e-4
    && Math.abs(st.rot || 0) < 1e-4
    && Math.abs(st.blur || 0) < 1e-4
    && (st.reveal ?? 1) >= 1 - 1e-4
  );

  // none 保持恒等
  assert.equal(isIdentity(textAnimV3({ duration: 4, animIn: { type: 'none', dur: 0.6 }, animOut: { type: 'none', dur: 0.6 }, animLoop: { type: 'none', dur: 1.2 } }, 0.05, 0.2)), true);

  // 循环动画：breathe / wave / blink 及已有类型均应产生非恒等状态
  const loopSamples = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.05];
  for (const type of ['breathe', 'wave', 'blink', 'shake', 'swing', 'pulse', 'float']) {
    const anyMoved = loopSamples.some((t) => !isIdentity(textAnimV3({ duration: 4, animLoop: { type, dur: 1.2 } }, t / 4, t)));
    assert.ok(anyMoved, `循环动画 ${type} 不得退化为恒等状态`);
  }

  // 入场动画：全部非 none 类型均产生非恒等变换/模糊
  const inSamples = [0.1, 0.2, 0.3, 0.45];
  for (const type of ['fade', 'pop', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'zoom', 'typewriter', 'blur', 'bounce']) {
    const anyMoved = inSamples.some((t) => !isIdentity(textAnimV3({ duration: 4, animIn: { type, dur: 0.6 } }, t / 4, t)));
    assert.ok(anyMoved, `入场动画 ${type} 不得退化为恒等状态`);
  }

  // 出场动画：含 blur 在内均生效
  const outSamples = [3.55, 3.7, 3.85];
  for (const type of ['fade', 'pop', 'slide-down', 'slide-right', 'zoom', 'blur']) {
    const anyMoved = outSamples.some((t) => !isIdentity(textAnimV3({ duration: 4, animOut: { type, dur: 0.6 } }, t / 4, t)));
    assert.ok(anyMoved, `出场动画 ${type} 不得退化为恒等状态`);
  }

  // blur 入场与出场必须返回 blur > 0
  const blurIn = textAnimV3({ duration: 4, animIn: { type: 'blur', dur: 0.6 } }, 0.15 / 4, 0.15);
  assert.ok(Number(blurIn.blur) > 0, `blur 入场应返回 blur > 0，实际：${JSON.stringify(blurIn)}`);
  const blurOut = textAnimV3({ duration: 4, animOut: { type: 'blur', dur: 0.6 } }, 3.85 / 4, 3.85);
  assert.ok(Number(blurOut.blur) > 0, `blur 出场应返回 blur > 0，实际：${JSON.stringify(blurOut)}`);

  // bounce 必须明显区别于普通 fade
  const bounceDistinct = inSamples.some((t) => {
    const b = textAnimV3({ duration: 4, animIn: { type: 'bounce', dur: 0.6 } }, t / 4, t);
    const f = textAnimV3({ duration: 4, animIn: { type: 'fade', dur: 0.6 } }, t / 4, t);
    return Math.abs(b.scale - f.scale) > 1e-4
      || Math.abs(b.dy - f.dy) > 1e-4
      || Math.abs(b.dx - f.dx) > 1e-4
      || Math.abs(b.rot - f.rot) > 1e-4
      || Math.abs(b.alpha - f.alpha) > 1e-4;
  });
  assert.ok(bounceDistinct, 'bounce 入场动画必须与 fade 有实质差异');
});

test('ai/editor.js：parseEditResponse 剔除锁定第 1 镜后输出稳定 ids 目标，前置 insertAsset 后 applyOps 仍成功且保护第 1 镜', () => {
  const p = createProject({ name: 'ai-lock-ids' });
  const v1 = createAsset({ id: 'v1', kind: 'video', name: '素材1.mp4', duration: 10 });
  const v2 = createAsset({ id: 'v2', kind: 'video', name: '片头.mp4', duration: 6 });
  p.assets = { v1, v2 };
  p.tracks.video = [
    createClip(v1, { id: 'c1', in: 0, out: 4, locked: true }),
    createClip(v1, { id: 'c2', in: 4, out: 8, locked: false }),
  ];

  const parsed = parseEditResponse({
    reply: '在开头插入片段并整体提亮',
    ops: [
      { type: 'insertAsset', targetMode: 'none', indices: [], ids: [], assetId: 'v2', atIndex: 1, reason: '开头插入素材' },
      { type: 'setColor', targetMode: 'all', indices: [], ids: [], exposure: 0.2, relative: false, reason: '整体提亮' },
    ],
  }, p);

  assert.equal(parsed.ops.length, 2);
  assert.equal(parsed.ops[1].target.mode, 'ids', `应输出稳定 ids 目标，实际：${JSON.stringify(parsed.ops[1].target)}`);
  assert.deepEqual(parsed.ops[1].target.ids, ['c2']);

  const res = applyOps(p, parsed.ops);
  assert.equal(res.ok, true, res.errors.join('；'));
  assert.equal(res.project.tracks.video.length, 3);
  const c1After = res.project.tracks.video.find((c) => c.id === 'c1');
  const c2After = res.project.tracks.video.find((c) => c.id === 'c2');
  assert.equal(c1After.locked, true);
  assert.equal(c1After.color.exposure, 0, '锁定的第 1 镜不得被修改');
  assert.equal(c2After.color.exposure, 0.2, '未锁定的 c2 应成功应用调色');
});

test('store.js：openProject(B) 后执行 persistUi() 不得将 lastProjectId 覆盖回旧值 A', async () => {
  const projB = createProject({ name: '项目 B' });
  projB.id = 'prj_B';

  const settingsSetCalls = [];
  let backendSettings = {
    ui: { lastProjectId: 'prj_A', onboarded: false, scale: 1 },
    general: { autosave: false, openLastProject: true },
  };
  const prevWindow = globalThis.window;
  globalThis.window = {
    ff: {
      on: () => () => {},
      flushed: () => {},
      invoke: async (channel, payload) => {
        if (channel === 'project:load' && payload && payload.id === 'prj_B') return projB;
        if (channel === 'settings:set') {
          settingsSetCalls.push(payload);
          backendSettings = deepMerge(backendSettings, payload);
          return backendSettings;
        }
        if (channel === 'settings:get') return backendSettings;
        if (channel === 'project:list') return [];
        if (channel === 'project:save') return { ok: true };
        return null;
      },
    },
  };

  try {
    const { default: useStore } = await import('../src/ui/store.js');
    useStore.setState({
      settings: deepMerge({}, backendSettings),
      project: null,
    });
    await useStore.getState().openProject('prj_B');
    assert.equal(backendSettings.ui.lastProjectId, 'prj_B', 'openProject(B) 应写入 lastProjectId=prj_B');

    useStore.getState().persistUi(0);
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(backendSettings.ui.lastProjectId, 'prj_B', 'persistUi() 不得将 lastProjectId 覆盖回旧值 prj_A');
    const lastCall = settingsSetCalls[settingsSetCalls.length - 1];
    assert.notEqual(
      lastCall && lastCall.ui && lastCall.ui.lastProjectId,
      'prj_A',
      'persistUi() 不得向 settings:set 发送陈旧的 lastProjectId=prj_A',
    );
    await useStore.getState().closeProject({ force: true });
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

// ───────────────────────── 9. 红队二轮专项回归（RT2） ─────────────────────────

function loadMainPure() {
  const envKeys = ['FF_E2E', 'FF_DEV_URL', 'FF_USER_DATA', 'FF_E2E_SHOW'];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  const mainPath = require.resolve('../electron/main.cjs');
  delete require.cache[mainPath];
  try {
    return require(mainPath);
  } finally {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 构造原始 PKZIP（STORE 模式）字节流，保留恶意路径条目不做归一化，用于 Zip-Slip 回归测试 */
function buildSyntheticZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ''), 'utf8');
    const crc = crc32(dataBuf);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, dataBuf);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);

    offset += local.length + nameBuf.length + dataBuf.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

// 9.1 library:addAssets 提权与 ffmedia:// 联动回归
test('RT2-1：library:addAssets 拦截 userData/Cookies、Cookies.srt 与 UNC 路径，零复制且 ffmedia:// 保持拒绝', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sec-rt2-ud-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sec-rt2-dr-'));
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sec-rt2-ext-'));
  try {
    const mainMod = loadMainPure();
    const cookiesFile = path.join(userData, 'Cookies');
    const cookiesSrt = path.join(userData, 'Cookies.srt');
    const uncMp4 = '\\\\host\\share\\a.mp4';
    fs.writeFileSync(cookiesFile, 'SQLite format 3\0sensitive-cookie');
    fs.writeFileSync(cookiesSrt, '1\n00:00:00,000 --> 00:00:01,000\nsensitive-srt\n');

    const libraryDir = path.join(dataRoot, 'library');
    const libraryMediaDir = path.join(libraryDir, 'media');
    const analysesDir = path.join(libraryDir, 'analyses');
    const tmpDir = path.join(dataRoot, 'tmp');
    fs.mkdirSync(libraryMediaDir, { recursive: true });
    fs.mkdirSync(analysesDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    const paths = {
      userData,
      dataRoot,
      dataRootRaw: dataRoot,
      tryDataRoot: () => dataRoot,
      library: libraryDir,
      libraryMedia: libraryMediaDir,
      analyses: analysesDir,
      tmp: tmpDir,
      tmpRaw: tmpDir,
    };

    const handlers = {};
    const ctx = {
      paths,
      jobs: { start: () => ({ jobId: 'noop' }) },
      isSafeMediaPath: (p) => mainMod.isSafeMediaPath(p, paths),
      registerMediaPath: (p) => mainMod.registerMediaPath(p, paths),
      isAllowedMedia: (p) => mainMod.isAllowed(p, paths),
    };
    registerAnalysis({ handle: (ch, fn) => { handlers[ch] = fn; }, ctx });

    const badAssets = [
      { id: 'ast_cookie_raw', kind: 'video', name: 'Cookies', path: cookiesFile },
      { id: 'ast_cookie_srt', kind: 'video', name: 'CookiesSrt', path: cookiesSrt },
      { id: 'ast_unc_mp4', kind: 'video', name: 'UncClip', path: uncMp4 },
    ];

    for (const bad of badAssets) {
      let saved = null;
      let err = null;
      try {
        saved = await handlers['library:addAssets']({ assets: [bad] });
      } catch (e) {
        err = e;
      }
      assert.ok(err || (Array.isArray(saved) && saved.length === 0), `library:addAssets 应拒绝或跳过非法素材：${bad.path}`);
    }

    {
      let saved = null;
      let err = null;
      try {
        saved = await handlers['library:addAssets']({ assets: badAssets });
      } catch (e) {
        err = e;
      }
      assert.ok(err || (Array.isArray(saved) && saved.length === 0), '批量传入 3 个非法素材时应全部拒绝或跳过');
    }

    assert.deepEqual(fs.readdirSync(libraryMediaDir), [], '非法素材绝不能被复制到 library/media');
    assert.deepEqual(await registerAnalysis.libraryStore.listAssets(paths), [], '非法素材绝不能写入 assets.json');
    assert.equal(mainMod.isAllowed(cookiesFile, paths), false, 'userData/Cookies 必须保持 ffmedia:// 拒绝');
    assert.equal(mainMod.isAllowed(cookiesSrt, paths), false, 'userData/Cookies.srt 必须保持 ffmedia:// 拒绝');
    assert.equal(mainMod.isAllowed(uncMp4, paths), false, 'UNC 路径必须保持 ffmedia:// 拒绝');

    // 正向对照：合法外部媒体可正常入库并被 ffmedia:// 放行，且 3 个非法目标仍为 false
    const validMp4 = path.join(extDir, 'valid.mp4');
    fs.writeFileSync(validMp4, Buffer.from('ftypmp42'));
    assert.equal(mainMod.registerMediaPath(validMp4, paths), true);
    const okSaved = await handlers['library:addAssets']({
      assets: [{ id: 'ast_valid', kind: 'video', name: 'ValidClip', path: validMp4 }],
    });
    assert.equal(okSaved.length, 1);
    assert.equal(fs.readdirSync(libraryMediaDir).length, 1);
    assert.equal(mainMod.isAllowed(okSaved[0].path, paths), true, '合法入库素材应被 ffmedia:// 放行');
    assert.equal(mainMod.isAllowed(cookiesFile, paths), false);
    assert.equal(mainMod.isAllowed(cookiesSrt, paths), false);
    assert.equal(mainMod.isAllowed(uncMp4, paths), false);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
  }
});

// 9.2 assertSafePublicUrlAsync 单元测试 + 6to4 / Teredo 同步拦截
test('RT2-2a：urlSafety.assertSafePublicUrlAsync 覆盖私网/混合/IPv4映射IPv6/空结果/DNS异常/公网，同步拦截 6to4 与 Teredo', async () => {
  // 1) 单私网 IP
  await assert.rejects(
    urlSafety.assertSafePublicUrlAsync('https://single-priv.example/a', {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    }),
    (e) => e && e.code === 'UNSAFE_URL',
  );

  // 2) 公网 + 私网混合解析（含阿里云元数据 100.100.100.200）
  await assert.rejects(
    urlSafety.assertSafePublicUrlAsync('https://mixed-dns.example/a', {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '100.100.100.200', family: 4 },
      ],
    }),
    (e) => e && e.code === 'UNSAFE_URL',
  );

  // 3) IPv4-mapped IPv6
  await assert.rejects(
    urlSafety.assertSafePublicUrlAsync('https://mapped-v6.example/a', {
      lookup: async () => [{ address: '::ffff:127.0.0.1', family: 6 }],
    }),
    (e) => e && e.code === 'UNSAFE_URL',
  );

  // 4) 空 DNS 数组
  await assert.rejects(
    urlSafety.assertSafePublicUrlAsync('https://empty-dns.example/a', {
      lookup: async () => [],
    }),
    (e) => e && e.code === 'UNSAFE_URL',
  );

  // 5) DNS 解析错误
  await assert.rejects(
    urlSafety.assertSafePublicUrlAsync('https://err-dns.example/a', {
      lookup: async () => {
        const err = new Error('getaddrinfo ENOTFOUND err-dns.example');
        err.code = 'ENOTFOUND';
        throw err;
      },
    }),
    (e) => e && (e.code === 'ENOTFOUND' || e.code === 'DNS_FAILED' || e.code === 'UNSAFE_URL'),
  );

  // 6) 纯公网 IP → 放行
  const okUrl = await urlSafety.assertSafePublicUrlAsync('https://public-ok.example/video.mp4', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(okUrl.hostname, 'public-ok.example');

  // 7) 同步 assertSafePublicUrl 拦截 6to4 (2002::/16) 与 Teredo (2001:0000::/32)
  for (const u of ['http://[2002:7f00:1::]/', 'http://[2001::1]/']) {
    assert.throws(
      () => urlSafety.assertSafePublicUrl(u),
      (e) => e && e.code === 'UNSAFE_URL',
      `同步校验应拦截 6to4/Teredo 地址：${u}`,
    );
  }
});

// 9.2b 四大下载器 DNS SSRF 接线回归
test('RT2-2b：ytdlp / videogen / asr / ai.downloadImage 在调用 fetch 前拦截解析到 127.0.0.1 的域名（0 次 fetch）', async () => {
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sec-rt2-dns-'));
  const cjsDns = require('node:dns');
  const origDnsLookup = cjsDns.promises.lookup;
  const origGlobalFetch = globalThis.fetch;

  let fetchCalls = 0;
  let lookupCalls = 0;
  const mockLookup = async (host) => {
    lookupCalls += 1;
    if (String(host).toLowerCase() === 'evil-rebind.example') {
      return [{ address: '127.0.0.1', family: 4 }];
    }
    const err = new Error(`unexpected lookup: ${host}`);
    err.code = 'ENOTFOUND';
    throw err;
  };
  const failFetch = async (url) => {
    fetchCalls += 1;
    throw new Error(`DNS 拦截失效，不应发起 fetch：${url}`);
  };

  cjsDns.promises.lookup = mockLookup;
  globalThis.fetch = failFetch;
  try {
    // 1) ytdlp.downloadUrlToFile
    fetchCalls = 0;
    lookupCalls = 0;
    const ytDest = path.join(dlDir, 'yt.bin');
    await assert.rejects(
      ytdlp.downloadUrlToFile('https://evil-rebind.example/file.bin', ytDest, {
        fetchImpl: failFetch,
        lookup: mockLookup,
      }),
      (e) => e && e.code === 'UNSAFE_URL',
    );
    assert.equal(fetchCalls, 0, 'ytdlp.downloadUrlToFile 应在 fetch 前拦截私网 DNS');
    assert.ok(lookupCalls >= 1, 'ytdlp.downloadUrlToFile 必须执行异步 DNS 校验');
    assert.equal(fs.existsSync(ytDest), false);

    // 2) videogen/util.downloadTo
    fetchCalls = 0;
    lookupCalls = 0;
    const vgDest = path.join(dlDir, 'vg.mp4');
    await assert.rejects(
      vgUtil.downloadTo(failFetch, 'https://evil-rebind.example/video.mp4', vgDest, {
        lookup: mockLookup,
      }),
      (e) => e && e.code === 'UNSAFE_URL',
    );
    assert.equal(fetchCalls, 0, 'videogen/util.downloadTo 应在 fetch 前拦截私网 DNS');
    assert.ok(lookupCalls >= 1, 'videogen/util.downloadTo 必须执行异步 DNS 校验');
    assert.equal(fs.existsSync(vgDest), false);

    // 3) asr.download
    fetchCalls = 0;
    lookupCalls = 0;
    const asrDest = path.join(dlDir, 'asr.bin');
    await assert.rejects(
      asrLib.download('https://evil-rebind.example/model.bin', asrDest, {
        fetchImpl: failFetch,
        lookup: mockLookup,
      }),
      (e) => e && e.code === 'UNSAFE_URL',
    );
    assert.equal(fetchCalls, 0, 'asr.download 应在 fetch 前拦截私网 DNS');
    assert.ok(lookupCalls >= 1, 'asr.download 必须执行异步 DNS 校验');
    assert.equal(fs.existsSync(asrDest), false);

    // 4) ai.cjs _internals.downloadImage
    assert.equal(typeof registerAI._internals.downloadImage, 'function', 'ai.cjs 应在 _internals 导出 downloadImage');
    fetchCalls = 0;
    lookupCalls = 0;
    await assert.rejects(
      registerAI._internals.downloadImage('https://evil-rebind.example/img.png', undefined, {
        fetchFn: failFetch,
        fetchImpl: failFetch,
        fetch: failFetch,
        lookup: mockLookup,
      }),
      (e) => e && e.code === 'UNSAFE_URL',
    );
    assert.equal(fetchCalls, 0, 'ai.cjs downloadImage 应在 fetch 前拦截私网 DNS');
    assert.ok(lookupCalls >= 1, 'ai.cjs downloadImage 必须执行异步 DNS 校验');
  } finally {
    cjsDns.promises.lookup = origDnsLookup;
    globalThis.fetch = origGlobalFetch;
    fs.rmSync(dlDir, { recursive: true, force: true });
  }
});

// 9.3 settings:set({ dataRoot }) UNC 与 userData 隔离回归
test('RT2-3：settings:set({ dataRoot }) 在任何 mkdir 前拦截 UNC、混合斜杠 UNC 以及 userData / userData 子目录', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sec-rt2-st-ud-'));
  const validDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sec-rt2-st-dr-'));
  const cjsFs = require('node:fs');
  const origMkdirAsync = cjsFs.promises.mkdir;
  const origMkdirSync = cjsFs.mkdirSync;
  const mkdirCalls = [];

  try {
    const settings = createSettings({ dir: userData });
    const paths = {
      userData,
      dataRoot: validDataRoot,
      dataRootRaw: validDataRoot,
      tryDataRoot: () => validDataRoot,
      projects: path.join(validDataRoot, 'projects'),
      projectDir: (id) => path.join(validDataRoot, 'projects', id),
      projectCache: (id) => path.join(validDataRoot, 'projects', id, 'cache'),
    };
    const handlers = {};
    registerStore({ handle: (ch, fn) => { handlers[ch] = fn; }, ctx: { paths, settings, registerMediaPath: () => {} } });

    cjsFs.promises.mkdir = async function (target, ...rest) {
      mkdirCalls.push(String(target));
      return origMkdirAsync.call(this, target, ...rest);
    };
    cjsFs.mkdirSync = function (target, ...rest) {
      mkdirCalls.push(String(target));
      return origMkdirSync.call(this, target, ...rest);
    };

    const networkSubDir = path.join(userData, 'Network');
    await assert.rejects(handlers['settings:set']({ dataRoot: '\\\\attacker.invalid\\share' }), /UNC|网络路径/i);
    await assert.rejects(handlers['settings:set']({ dataRoot: '\\/attacker.invalid/share' }), /UNC|网络路径/i);
    assert.deepEqual(mkdirCalls, [], 'UNC dataRoot 必须在调用任何 mkdir 之前被拒绝');

    await assert.rejects(handlers['settings:set']({ dataRoot: userData }));
    await assert.rejects(handlers['settings:set']({ dataRoot: networkSubDir }));
    assert.deepEqual(mkdirCalls, [], 'userData 及其子目录作为 dataRoot 必须在调用任何 mkdir 之前被拒绝');
    assert.equal(fs.existsSync(networkSubDir), false, '不得在 userData 内创建 Network 目录');
    assert.equal(settings.get().dataRoot, '', '被拒绝的 dataRoot 不得写入配置');

    // 恢复 mkdir 并验证合法外部目录可正常设置
    cjsFs.promises.mkdir = origMkdirAsync;
    cjsFs.mkdirSync = origMkdirSync;
    const saved = await handlers['settings:set']({ dataRoot: validDataRoot });
    assert.equal(saved.dataRoot, path.resolve(validDataRoot));
    assert.equal(settings.get().dataRoot, path.resolve(validDataRoot));
  } finally {
    cjsFs.promises.mkdir = origMkdirAsync;
    cjsFs.mkdirSync = origMkdirSync;
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(validDataRoot, { recursive: true, force: true });
  }
});

// 9.4 analysis:update / media:probe / asr:transcribe / project:exportJson 触发 fs 前拦截 UNC
test('RT2-4：analysis:update / media:probe / asr:transcribe / project:exportJson 在触发任何 fs/SMB 访问前拒绝 UNC 路径', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sec-rt2-unc-'));
  const cjsFs = require('node:fs');
  const uncPaths = [
    '\\\\attacker.invalid\\share\\a.mp4',
    '\\/attacker.invalid/share/a.mp4',
  ];

  const origSync = {
    existsSync: cjsFs.existsSync,
    statSync: cjsFs.statSync,
    lstatSync: cjsFs.lstatSync,
    realpathSync: cjsFs.realpathSync,
    openSync: cjsFs.openSync,
    readFileSync: cjsFs.readFileSync,
    mkdirSync: cjsFs.mkdirSync,
  };
  const origAsync = {
    stat: cjsFs.promises.stat,
    lstat: cjsFs.promises.lstat,
    realpath: cjsFs.promises.realpath,
    mkdir: cjsFs.promises.mkdir,
    open: cjsFs.promises.open,
    access: cjsFs.promises.access,
    writeFile: cjsFs.promises.writeFile,
  };

  try {
    const analysesDir = path.join(workDir, 'library', 'analyses');
    const projectsDir = path.join(workDir, 'projects');
    fs.mkdirSync(analysesDir, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });

    const localClip = path.join(workDir, 'local.mp4');
    fs.writeFileSync(localClip, 'mp4');
    fs.writeFileSync(
      path.join(analysesDir, 'ana_unc.json'),
      JSON.stringify({
        id: 'ana_unc',
        title: 'UNC 测试',
        assetPath: localClip,
        source: { type: 'file', path: localClip },
        shots: [],
        techniqueIds: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    const paths = {
      userData: path.join(workDir, 'ud'),
      dataRoot: workDir,
      dataRootRaw: workDir,
      tryDataRoot: () => workDir,
      library: path.join(workDir, 'library'),
      libraryMedia: path.join(workDir, 'library', 'media'),
      analyses: analysesDir,
      projects: projectsDir,
      cache: path.join(workDir, 'cache'),
      tmp: path.join(workDir, 'tmp'),
      tmpRaw: path.join(workDir, 'tmp'),
      ffmpeg: null,
      ffprobe: null,
      projectDir: (id) => path.join(projectsDir, id),
      projectCache: (id) => path.join(projectsDir, id, 'cache'),
    };
    fs.mkdirSync(paths.userData, { recursive: true });
    fs.mkdirSync(paths.tmp, { recursive: true });

    const settings = createSettings({ dir: paths.userData });
    const handlers = {};
    const handle = (ch, fn) => { handlers[ch] = fn; };
    const ctx = {
      paths,
      settings: {
        ...settings,
        get: () => settings.get(),
        getSecret: (k) => (k === 'openaiKey' ? 'sk-test' : ''),
      },
      jobs: { start: () => { throw new Error('拦截 UNC 时不得启动后台任务'); } },
      registerMediaPath: () => {},
      isAllowedMedia: () => false,
    };
    registerAnalysis({ handle, ctx });
    registerMedia({ handle, ctx });
    registerAsr({ handle, ctx });
    registerStore({ handle, ctx: { paths, settings, registerMediaPath: () => {} } });

    const uncFsHits = [];
    const checkArg = (op, p) => {
      const s = String(p || '');
      if (/attacker\.invalid/i.test(s)) {
        uncFsHits.push(`${op}:${s}`);
        throw new Error(`TEST_BLOCKED_SMB_FS_CALL:${op}`);
      }
    };

    for (const [k, fn] of Object.entries(origSync)) {
      const wrapped = function (p, ...rest) {
        checkArg(k, p);
        return fn.call(this, p, ...rest);
      };
      if (k === 'realpathSync' && fn.native) wrapped.native = fn.native;
      cjsFs[k] = wrapped;
    }
    for (const [k, fn] of Object.entries(origAsync)) {
      cjsFs.promises[k] = async function (p, ...rest) {
        checkArg(`promises.${k}`, p);
        return fn.call(this, p, ...rest);
      };
    }

    for (const unc of uncPaths) {
      await assert.rejects(
        handlers['analysis:update']({ analysis: { id: 'ana_unc', assetPath: unc } }),
        (e) => e && (e.code === 'FORBIDDEN_PATH' || /UNC|网络路径/i.test(e.message || '')),
        `analysis:update 应在触达 fs 前拒绝 UNC：${unc}`,
      );
      await assert.rejects(
        handlers['analysis:start']({ path: unc }),
        /UNC|网络路径/i,
        `analysis:start 应以 UNC 错误拒绝：${unc}`,
      );
      await assert.rejects(
        handlers['media:probe']({ path: unc }),
        /UNC|网络路径/i,
        `media:probe 应以 UNC 错误拒绝：${unc}`,
      );
      await assert.rejects(
        handlers['asr:transcribe']({ audioPath: unc }),
        /UNC|网络路径/i,
        `asr:transcribe 应以 UNC 错误拒绝：${unc}`,
      );
      await assert.rejects(
        handlers['project:exportJson']({ project: { version: 2, name: 'unc-test' }, path: unc }),
        /UNC|网络路径/i,
        `project:exportJson 应以 UNC 错误拒绝：${unc}`,
      );
    }

    assert.deepEqual(uncFsHits, [], `4 个 IPC 均必须在任何 fs/SMB 调用前拒绝 UNC，实际命中：${JSON.stringify(uncFsHits)}`);
  } finally {
    Object.assign(cjsFs, origSync);
    Object.assign(cjsFs.promises, origAsync);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// 9.5a log.cjs 边界脱敏回归
test('RT2-5a：log.cjs 完整隐藏 socks5 代理密码、含 @ 密码、JSON 转义引号密钥与混合引号对象密钥', () => {
  const rSocks = log.redact('socks5://alice:ProxyPass99@proxy.example.com:1080');
  assert.ok(!rSocks.includes('ProxyPass99'), `未脱敏 socks5 密码：${rSocks}`);
  assert.ok(rSocks.includes('proxy.example.com:1080'), `应保留代理主机与端口：${rSocks}`);

  const rAtPass = log.redact('https://alice:p@ssword@api.example.com/v1');
  assert.ok(!rAtPass.includes('p@ssword'), `未脱敏含 @ 的 URL 密码：${rAtPass}`);
  assert.ok(!rAtPass.includes('ssword'), `含 @ 的 URL 密码不应泄露后半段 ssword：${rAtPass}`);
  assert.ok(rAtPass.includes('api.example.com/v1'), `应保留目标主机和路径：${rAtPass}`);

  const rJsonEsc = log.redact('{"apiKey":"abc\\"def_LEAKME"}');
  assert.ok(!rJsonEsc.includes('LEAKME'), `未脱敏含转义引号的 JSON apiKey：${rJsonEsc}`);

  const rInspect = log.formatArgs([{ apiKey: "a'b\"c`d_LEAKME" }]);
  assert.ok(!rInspect.includes('LEAKME'), `未脱敏含混合引号的对象 apiKey：${rInspect}`);
});

// 9.5b asr.cjs Zip-Slip PowerShell 解压校验回归（仅 win32）
test('RT2-5b：asr.cjs Zip-Slip PowerShell 校验拒绝穿越/兄弟前缀/绝对路径条目且零逃逸落盘', { skip: process.platform !== 'win32' }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sec-rt2-zip-'));
  const origDownload = asrLib.download;
  const origSha256File = asrLib.sha256File;
  const origVerifyModel = asrLib.verifyModel;

  try {
    const runInstallWithZip = async (entries) => {
      const caseRoot = fs.mkdtempSync(path.join(workDir, 'case-'));
      const ud = path.join(caseRoot, 'ud');
      const tmpDir = path.join(caseRoot, 'tmp');
      fs.mkdirSync(path.join(ud, 'models'), { recursive: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(ud, 'models', asrLib.MODELS.base.file), 'stub-model');

      const zipBuf = buildSyntheticZip(entries);
      asrLib.download = async (_url, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, zipBuf);
        return { path: dest, size: zipBuf.length };
      };
      if (asrLib.WHISPER_BIN_SHA256) {
        asrLib.sha256File = async () => String(asrLib.WHISPER_BIN_SHA256).trim().toLowerCase();
      }
      asrLib.verifyModel = async () => true;

      const handlers = {};
      let jobPromise = null;
      const ctx = {
        paths: { userData: ud, tmp: tmpDir, ffmpeg: 'ffmpeg', projectDir: (id) => path.join(caseRoot, id) },
        settings: { get: () => ({}), getSecret: () => '' },
        jobs: {
          start: (_kind, fn) => {
            const ac = new AbortController();
            const job = {
              signal: ac.signal,
              progress: () => {},
              throwIfCancelled: () => { if (ac.signal.aborted) throw new Error('已取消'); },
            };
            jobPromise = fn(job);
            jobPromise.catch(() => {});
            return { jobId: 'zip_job' };
          },
        },
      };
      registerAsr({ handle: (ch, fn) => { handlers[ch] = fn; }, ctx });
      await handlers['asr:installModel']({ model: 'base', withBinary: true });
      return { ud, promise: jobPromise };
    };

    // 正向对照：合法合成 zip 可被 .NET ZipFile 正常解压并找到 whisper-cli.exe
    const okRun = await runInstallWithZip([{ name: 'whisper-cli.exe', data: 'OK_BIN' }]);
    await okRun.promise;
    const extractedOk = path.join(okRun.ud, 'bin', 'whisper', 'whisper-cli.exe');
    assert.equal(fs.existsSync(extractedOk), true, '正向对照：合法 zip 应成功解压出 whisper-cli.exe');
    assert.equal(fs.readFileSync(extractedOk, 'utf8'), 'OK_BIN');

    // 恶意条目：逐一携带同名 whisper-cli.exe，确保仅当 Zip-Slip 校验生效时才会拒绝
    const writableAbsTarget = path.join(workDir, 'abs_escaped_probe.txt');
    const maliciousCases = [
      { entry: '../escape.txt', checkPath: (ud) => path.join(ud, 'bin', 'escape.txt') },
      { entry: '..\\escape2.txt', checkPath: (ud) => path.join(ud, 'bin', 'escape2.txt') },
      { entry: '../target_evil/x.txt', checkPath: (ud) => path.join(ud, 'bin', 'target_evil', 'x.txt') },
      { entry: '../whisper_evil/x.txt', checkPath: (ud) => path.join(ud, 'bin', 'whisper_evil', 'x.txt') },
      { entry: '/abs.txt', checkPath: () => null },
      { entry: 'C:\\abs.txt', checkPath: () => null },
      { entry: writableAbsTarget, checkPath: () => writableAbsTarget },
    ];

    for (const tc of maliciousCases) {
      const badRun = await runInstallWithZip([
        { name: tc.entry, data: 'PWNED' },
        { name: 'whisper-cli.exe', data: 'OK_BIN' },
      ]);
      await assert.rejects(badRun.promise, /解压失败|escape|Zip/i, `Zip-Slip 条目应被拒绝：${tc.entry}`);
      const escaped = tc.checkPath(badRun.ud);
      if (escaped) {
        assert.equal(fs.existsSync(escaped), false, `绝不能逃逸写出文件：${escaped}`);
      }
      const binDir = path.join(badRun.ud, 'bin', 'whisper');
      assert.deepEqual(
        fs.existsSync(binDir) ? fs.readdirSync(binDir) : [],
        [],
        `恶意条目 ${tc.entry} 被拒绝后目标目录不应残留已解压文件`,
      );
    }
  } finally {
    asrLib.download = origDownload;
    asrLib.sha256File = origSha256File;
    asrLib.verifyModel = origVerifyModel;
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
