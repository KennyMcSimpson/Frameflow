#!/usr/bin/env node
// 打包版冒烟测试：直接启动 Frameflow.exe，用 --remote-debugging-port + CDP 驱动。
// 为什么不用 Playwright 的 _electron.launch：它固定注入 --inspect=0，
//   而发行版的 EnableNodeCliInspectArguments fuse 是关的，启动会超时。
// 隔离：用临时 FF_USER_DATA，并预写 settings.json 把数据目录指到临时目录。启动前后都会确认隔离生效。
// 用法：node e2e/packaged.mjs [--dir=<win-unpacked 目录>] [--port=9377] [--keep]
//   不做安装、不写真实用户目录。结束时结束自己启动的进程，并删除临时目录（--keep 时保留）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);

const DIR = path.resolve(argOf('dir') || path.join(ROOT, 'dist', 'win-unpacked'));
const EXE = path.join(DIR, 'Frameflow.exe');
const RES = path.join(DIR, 'resources');
const PORT = Number(argOf('port')) || 9377;
const KEEP = process.argv.includes('--keep');

const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? `  [${detail}]` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'frameflow-e2e-'));
  const userData = path.join(base, 'userData');
  const dataRoot = path.join(base, 'data');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ dataRoot, ui: { onboarded: true } }));
  return { base, userData, dataRoot };
}

// 启动前先静态确认打包版会读取 FF_USER_DATA，否则测试会碰到真实用户目录。
function preflightIsolation() {
  try {
    const asar = require('@electron/asar');
    const main = asar.extractFile(path.join(RES, 'app.asar'), 'electron/main.cjs').toString('utf8');
    const line = main.split(/\r?\n/).find((l) => l.includes('FF_USER_DATA')) || '';
    if (!line) return { ok: false, why: 'electron/main.cjs 不再读取 FF_USER_DATA' };
    if (/isPackaged/.test(line) && !/FF_E2E|isE2E/.test(line)) return { ok: false, why: `打包版忽略 FF_USER_DATA：${line.trim()}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `无法读取 app.asar：${e.message}` };
  }
}

async function connect(chromium, deadlineMs) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 3000 }); } catch { await sleep(400); }
  }
  throw new Error('CDP 连接失败');
}

async function findPage(browser, deadlineMs) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    for (const c of browser.contexts()) for (const p of c.pages()) if (/index\.html/.test(p.url())) return p;
    await sleep(300);
  }
  throw new Error('没有找到主窗口页面');
}

async function runSteps(page, { dataRoot }) {
  await page.waitForFunction(() => !!window.ff, null, { timeout: 30000 });
  step('preload 暴露 window.ff', true);

  const info = await page.evaluate(() => window.ff.invoke('app:info'));
  step('隔离生效（数据目录在临时目录）', path.normalize(String(info.dataRoot)) === path.normalize(dataRoot), String(info.dataRoot));
  if (path.normalize(String(info.dataRoot)) !== path.normalize(dataRoot)) throw new Error('隔离未生效，停止测试');
  step('app:info 版本', !!info.version, info.version);
  const inRes = (p) => !!p && path.normalize(p).startsWith(path.normalize(path.join(RES, 'ffmpeg')));
  step('ffmpeg 来自 resources/ffmpeg', info.ffmpeg?.ok && inRes(info.ffmpeg?.path), info.ffmpeg?.path);
  step('ffprobe 来自 resources/ffmpeg', info.ffprobe?.ok && inRes(info.ffprobe?.path), info.ffprobe?.path);

  const sample = path.join(RES, 'sample-media', 'shot01-storefront.mp4');
  const probe = await page.evaluate((p) => window.ff.invoke('media:probe', { path: p }).catch((e) => ({ error: e.message })), sample);
  step('media:probe 读样片', probe && !probe.error && probe.duration > 0, probe?.error || `时长 ${probe?.duration}s`);

  // 用 canvas 帧走一遍真实导出（编码器由应用自选，LGPL 构建下不是 x264）
  const out = path.join(dataRoot, 'smoke-out.mp4');
  const res = await page.evaluate(async ({ out }) => {
    const c = new OffscreenCanvas(320, 240);
    const g = c.getContext('2d');
    const { jobId, encoder } = await window.ff.invoke('export:begin', {
      outPath: out, width: 320, height: 240, fps: 30, quality: 'high', totalFrames: 30, audioPlan: { duration: 1, segments: [] },
    });
    for (let i = 0; i < 30; i += 1) {
      g.fillStyle = `hsl(${i * 12},70%,50%)`;
      g.fillRect(0, 0, 320, 240);
      const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      await window.ff.exportFrame({ jobId, data: await b.arrayBuffer() });
    }
    const end = await window.ff.invoke('export:end', { jobId });
    return { encoder, size: end?.size, duration: end?.duration };
  }, { out }).catch((e) => ({ error: e.message }));
  const exported = !res.error && fs.existsSync(out) && fs.statSync(out).size > 0;
  step('导出 1 秒视频', exported, res.error || `编码器 ${res.encoder}，${res.size} 字节`);

  if (exported) {
    const ffprobe = path.join(RES, 'ffmpeg', 'ffprobe.exe');
    const p = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', out], { encoding: 'utf8', windowsHide: true });
    let streams = [];
    try { streams = JSON.parse(p.stdout).streams || []; } catch {}
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    step('成片为 H.264 + AAC', v?.codec_name === 'h264' && a?.codec_name === 'aac', `${v?.codec_name} / ${a?.codec_name}`);
  }

  const audio = await page.evaluate(() => window.ff.invoke('media:builtinAudio').catch((e) => ({ error: e.message })));
  if (Array.isArray(audio)) {
    const manifestPresent = fs.existsSync(path.join(RES, 'builtin-audio', 'manifest.json'));
    const ok = (!manifestPresent || audio.length > 0) && audio.every((a) => a.path && a.title);
    step('内置音频清单', ok, `${audio.length} 条`);
  } else {
    step('内置音频清单', false, audio?.error || '返回值不是数组');
  }

  for (const rel of ['licenses/THIRD_PARTY_LICENSES.txt', 'licenses/privacy.txt', 'licenses/ffmpeg/LICENSE.txt', 'licenses/ffmpeg/SOURCE.txt']) {
    step(`${rel} 存在`, fs.existsSync(path.join(RES, rel)));
  }
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error('找不到打包产物：', EXE);
    process.exit(1);
  }
  const pre = preflightIsolation();
  if (!pre.ok) {
    console.error('中止：无法保证隔离用户数据。', pre.why);
    process.exit(1);
  }

  const { chromium } = require('playwright');
  const { base, userData, dataRoot } = tempDirs();
  const env = { ...process.env, FF_E2E: '1', FF_E2E_SHOW: '', FF_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.FF_DEV_URL;

  const t0 = Date.now();
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, cwd: base, stdio: 'ignore', windowsHide: false });
  let browser = null;
  let crashed = false;
  try {
    browser = await connect(chromium, 30000);
    const page = await findPage(browser, 20000);
    step('启动并连上窗口', true, `${Date.now() - t0} ms`);
    await runSteps(page, { dataRoot });
  } catch (e) {
    crashed = true;
    step('测试过程', false, e.message);
  } finally {
    try { if (browser) await browser.close(); } catch {}
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      try { child.kill(); } catch {}
      setTimeout(resolve, 5000);
    });
    if (!KEEP) {
      try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
    } else {
      console.log('临时目录保留在：', base);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed || crashed ? `\n${failed} 项未通过` : '\n全部通过');
  process.exit(failed || crashed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
