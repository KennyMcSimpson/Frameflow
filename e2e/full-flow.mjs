// 端到端完整流程（清单 15）：示例项目 → 精修 → 拖素材到主轨 → 加音乐到音频轨 → 加文字 → 导出 mp4 → ffprobe 校验。
// 用法：npx vite build 后 node e2e/full-flow.mjs
// 每步截图 e2e/shots/full-*.png；任一步失败即打印步骤名并以退出码 1 结束。不修改 smoke.mjs（PLAN-v3 R2）。
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
for (const f of fs.readdirSync(SHOTS)) if (/^full-.*\.png$/i.test(f)) { try { fs.unlinkSync(path.join(SHOTS, f)); } catch {} }

const FFMPEG = require('ffmpeg-static');
const FFPROBE = require('ffprobe-static').path;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-full-ud-'));
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-full-data-'));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-full-out-'));
const fixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-full-fix-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ dataRoot, ui: { onboarded: true }, export: { folder: outDir } }));

// 测试用背景音乐：8 秒正弦波
const musicPath = path.join(fixDir, 'e2e-bgm.mp3');
execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:a', 'libmp3lame', '-b:a', '128k', musicPath]);

const log = (...a) => console.log('[full]', ...a);
const results = [];
const errors = [];
const SHOW = process.env.FF_E2E_SHOW == null ? '1' : process.env.FF_E2E_SHOW;

const app = await electron.launch({
  executablePath: require('electron'),
  args: [ROOT],
  cwd: ROOT,
  env: { ...process.env, FF_E2E: '1', FF_E2E_SHOW: SHOW, FF_USER_DATA: userData },
  timeout: 60000,
});
app.process().stdout.on('data', (d) => process.stdout.write('[main] ' + String(d)));
app.process().stderr.on('data', (d) => process.stderr.write('[main:err] ' + String(d)));

// 打桩系统文件对话框：导入时返回测试音乐，保存时落到临时目录
await app.evaluate(({ dialog }, { music, out }) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [music] });
  dialog.showSaveDialog = async (_w, o) => {
    const opts = o || _w || {};
    const base = String(opts.defaultPath || 'export.mp4').split(/[\\/]/).pop();
    return { canceled: false, filePath: out.replace(/[\\/]+$/, '') + '\\' + base };
  };
}, { music: musicPath, out: outDir });

const win = await app.firstWindow();
await win.setViewportSize({ width: 1600, height: 960 }).catch(() => {});
win.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

async function repaint() {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed()) w.webContents.invalidate();
  }).catch(() => {});
}
async function shot(name) {
  await win.waitForTimeout(300);
  await repaint();
  await win.waitForTimeout(50);
  const file = path.join(SHOTS, `full-${name}.png`);
  try {
    await win.screenshot({ path: file, timeout: 15000, animations: 'disabled' });
  } catch {
    try {
      const b64 = await app.evaluate(async ({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.webContents.invalidate();
        return (await w.webContents.capturePage()).toPNG().toString('base64');
      });
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    } catch { return null; }
  }
  log('截图', file);
  return file;
}
async function firstVisible(locators, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const l of locators) {
      const loc = l.first();
      try { if (await loc.count() && await loc.isVisible()) return loc; } catch {}
    }
    await win.waitForTimeout(200);
  }
  return null;
}
const byText = (t, exact = true) => win.getByText(t, { exact });
async function clickAny(locators, timeout) {
  const loc = await firstVisible(locators, timeout);
  if (!loc) return false;
  await loc.click();
  return true;
}
async function waitFor(fn, timeout = 8000, every = 250) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch {}
    await win.waitForTimeout(every);
  }
  return null;
}
async function closeOverlays() {
  for (let i = 0; i < 2; i++) { await win.keyboard.press('Escape').catch(() => {}); await win.waitForTimeout(120); }
}

/** 硬步骤：失败抛出，后续不再执行 */
async function step(name, fn) {
  const t0 = Date.now();
  log('▶', name);
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e && e.message || e).split('\n')[0] });
    await shot('fail-' + name.replace(/[^\w一-龥]+/g, '_')).catch(() => {});
    throw Object.assign(new Error(`步骤失败：${name} — ${e && e.message}`), { stepFailed: true });
  }
}

/** 左栏：一级分组（4 组新版 data-group）+ 二级子标签（data-sub）；兼容旧版平铺文字标签 */
async function openSide(group, sub, labels) {
  const g = await firstVisible([win.locator(`[data-group="${group}"]`), ...labels.group.map((t) => win.locator('.mpx-rail-btn, nav button').filter({ hasText: t }))], 4000);
  if (g) { await g.click(); await win.waitForTimeout(250); }
  if (sub) {
    const s = await firstVisible([win.locator(`[data-sub="${sub}"]`), ...labels.sub.map((t) => win.getByRole('tab', { name: t, exact: true }))], g ? 1500 : 4000);
    if (s) { await s.click(); await win.waitForTimeout(250); }
    else if (!g) throw new Error(`找不到左栏分类 ${group}/${sub}`);
  } else if (!g) throw new Error(`找不到左栏分类 ${group}`);
}

/** 在页面里合成 HTML5 拖放：card 的 dragstart 写入 DataTransfer，再在目标轨道上 dragover + drop */
async function synthDrag(cardSel, laneSel, frac = 0.85) {
  return win.evaluate(({ cardSel, laneSel, frac }) => {
    const card = [...document.querySelectorAll(cardSel)].find((el) => el.offsetParent !== null);
    const lane = document.querySelector(laneSel);
    if (!card) return { ok: false, why: '没有可拖的素材卡片 ' + cardSel };
    if (!lane) return { ok: false, why: '找不到轨道 ' + laneSel };
    const dt = new DataTransfer();
    const cr = card.getBoundingClientRect();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cr.x + 10, clientY: cr.y + 10 }));
    lane.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const lr = lane.getBoundingClientRect();
    const sc = lane.closest('.tl-scroll');
    // 只在可见区域内取点：左边让开（sticky）轨道头，右边不超出滚动容器
    const heads = document.querySelector('.tl-heads');
    const visLeft = Math.max(lr.left, heads ? heads.getBoundingClientRect().right : lr.left) + 8;
    const visRight = (sc ? Math.min(lr.right, sc.getBoundingClientRect().right) : lr.right) - 8;
    const x = visLeft + Math.max(0, (visRight - visLeft) * frac);
    const y = lr.top + lr.height / 2;
    const target = document.elementFromPoint(x, y) || lane;
    const opt = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y };
    target.dispatchEvent(new DragEvent('dragenter', opt));
    target.dispatchEvent(new DragEvent('dragover', opt));
    target.dispatchEvent(new DragEvent('drop', opt));
    card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return { ok: true, types: [...dt.types] };
  }, { cardSel, laneSel, frac });
}

const count = (sel) => win.locator(sel).count();
const CLIP = '[data-lane="video"] [data-clip-id], [data-clip-id]';
const AUDIO = '[data-lane="audio"] .tl-audio';
const TEXT = '[data-lane="text"] .tl-text';

function ffprobe(file) {
  const raw = execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(raw);
}
function findProjectJson(dir) {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 5) return;
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.json$/i.test(e.name)) {
        try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (j && j.tracks && j.settings) hits.push({ p, j, t: fs.statSync(p).mtimeMs }); } catch {}
      }
    }
  };
  walk(dir, 0);
  hits.sort((a, b) => b.t - a.t);
  return hits[0] ? hits[0].j : null;
}

let exportedFile = null;
const before = {};

try {
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(2500);

  await step('01 打开示例项目', async () => {
    await shot('01-start');
    const ok = await clickAny([win.locator('[data-sample]'), byText('咖啡店', false), win.locator('.sp-sample, .start-sample')], 15000);
    if (!ok) throw new Error('找不到示例项目入口');
    await win.waitForTimeout(3000);
    await shot('01-sample');
  });

  await step('02 进入精修', async () => {
    if (!(await clickAny([win.locator('[data-mode="refine"]'), win.getByRole('tab', { name: '精修' }), byText('精修')], 15000))) throw new Error('找不到「精修」入口');
    const ok = await waitFor(async () => (await count('[data-lane="video"]')) > 0, 15000);
    if (!ok) throw new Error('精修时间线没有出现');
    await win.waitForTimeout(1500);
    await closeOverlays();
    await shot('02-refine');
  });

  await step('03 拖素材到主轨', async () => {
    await openSide('material', 'media', { group: ['素材', '媒体'], sub: ['本地', '媒体'] });
    const has = await waitFor(async () => (await count('.mp-card[draggable="true"]')) > 0, 10000);
    if (!has) throw new Error('素材面板里没有可拖的素材（示例项目应自带素材）');
    before.clips = await count('[data-clip-id]');
    // 只拖非音频卡（音频卡有 .mp-audio-thumb）
    const r = await synthDrag('.mp-card[draggable="true"]:not(:has(.mp-audio-thumb))', '[data-lane="video"]', 0.95);
    if (!r.ok) throw new Error(r.why);
    const n = await waitFor(async () => { const c = await count('[data-clip-id]'); return c > before.clips ? c : 0; }, 6000);
    await shot('03-drag-media');
    if (!n) throw new Error(`主轨片段数没有增加（${before.clips}），dataTransfer=${JSON.stringify(r.types)}`);
    return `${before.clips} → ${n}`;
  });

  await step('04 加音乐到音频轨', async () => {
    await openSide('audio', null, { group: ['音频'] });
    before.audio = await count(AUDIO);
    const pane = win.locator('.mpx-audio-local, .mp-pane:not(.hidden)').first();
    const btn = await firstVisible([pane.getByRole('button', { name: '导入本地素材' }), pane.getByRole('button', { name: '导入', exact: true }), win.getByRole('button', { name: '导入本地素材' })], 5000);
    if (!btn) throw new Error('音频面板找不到「导入」按钮');
    await btn.click();
    const card = await waitFor(async () => (await win.locator('.mp-card[draggable="true"]:has(.mp-audio-thumb)').count()) > 0, 20000);
    if (!card) throw new Error('导入音乐后音频列表没有出现卡片');
    const r = await synthDrag('.mp-card[draggable="true"]:has(.mp-audio-thumb)', '[data-lane="audio"]', 0.05);
    if (!r.ok) throw new Error(r.why);
    let n = await waitFor(async () => { const c = await count(AUDIO); return c > before.audio ? c : 0; }, 5000);
    if (!n) {
      // 兜底：卡片上的「作为背景音乐」按钮
      const c = win.locator('.mp-card:has(.mp-audio-thumb)').first();
      await c.hover().catch(() => {});
      await c.locator('.mp-round.primary').evaluate((b) => b.click()).catch(() => {});
      n = await waitFor(async () => { const k = await count(AUDIO); return k > before.audio ? k : 0; }, 5000);
      if (n) log('拖放未生效，已用「作为背景音乐」按钮兜底');
    }
    await shot('04-audio');
    if (!n) throw new Error(`音频轨片段数没有增加（${before.audio}）`);
    return `${before.audio} → ${n}`;
  });

  await step('05 添加字幕到文字轨', async () => {
    // 播放头放到开头，保证文字落在可见区域
    await win.keyboard.press('Home').catch(() => {});
    await openSide('text', 'text', { group: ['文字'], sub: ['文字'] });
    before.text = await count(TEXT);
    const tile = await firstVisible([win.locator('.mp-pane:not(.hidden) .mpx-tile'), win.locator('.mpx-tile')], 5000);
    if (!tile) throw new Error('文字面板没有模板');
    await tile.click();
    let n = await waitFor(async () => { const c = await count(TEXT); return c > before.text ? c : 0; }, 5000);
    if (!n) {
      await clickAny([win.locator('[aria-label="在播放头添加文字"]'), win.locator('[title="在播放头添加文字"]')], 2000);
      n = await waitFor(async () => { const c = await count(TEXT); return c > before.text ? c : 0; }, 4000);
    }
    await shot('05-text');
    if (!n) throw new Error(`文字轨片段数没有增加（${before.text}）`);
    return `${before.text} → ${n}`;
  });

  await step('05b 2×/4× 快进播放有声（保调）', async () => {
    await closeOverlays();
    await win.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
    // 播放头放进音乐片段内部（音乐片段起点 + 少许），保证倍速期间一直有音乐
    {
      const ab = await win.locator(AUDIO).first().boundingBox().catch(() => null);
      const rb = await win.locator('.tl-ruler').first().boundingBox().catch(() => null);
      if (!ab || !rb) throw new Error('找不到音乐片段或时间尺');
      await win.mouse.click(ab.x + 12, rb.y + rb.height / 2);
      await win.waitForTimeout(400);
    }
    const probe = () => win.evaluate(() => [...document.querySelectorAll('audio, video')]
      .filter((el) => !el.paused)
      .map((el) => ({ tag: el.tagName, rate: Math.round(el.playbackRate * 100) / 100, muted: el.muted, vol: Math.round(el.volume * 100) / 100, pitch: el.preservesPitch !== false })));
    const read = async () => { const r = await win.evaluate(() => document.querySelector('.pv-time, .mono')?.textContent || ''); return r; };
    const res = {};
    for (const [k, rate] of [['L', 1], ['L', 2], ['L', 4]]) {
      await win.keyboard.press('Key' + k);
      await win.waitForTimeout(900);
      const els = await probe();
      res[rate] = els;
    }
    await win.keyboard.press('KeyK');
    await win.waitForTimeout(300);
    await win.keyboard.press('KeyJ');
    await win.waitForTimeout(600);
    const revToast = await win.locator('.toast').filter({ hasText: '倒放' }).count();
    await shot('05b-shuttle-reverse');
    await win.keyboard.press('KeyK');
    log('倍速播放媒体状态', JSON.stringify(res), '倒放提示', revToast);
    for (const rate of [2, 4]) {
      const audible = (res[rate] || []).filter((e) => e.tag === 'AUDIO' && !e.muted && e.vol > 0);
      if (!audible.length) throw new Error(`${rate}× 时没有正在出声的音频元素：${JSON.stringify(res[rate])}`);
      if (!audible.every((e) => Math.abs(e.rate - rate) < 0.01 && e.pitch)) throw new Error(`${rate}× 时音频 playbackRate/保调不对：${JSON.stringify(audible)}`);
    }
    if (!revToast) throw new Error('倒放时没有给出「预览静音」提示');
    return `2×/4× 音频元素 playbackRate 正确且保调；倒放有提示`;
  });

  await step('06 导出 mp4', async () => {
    await closeOverlays();
    if (!(await clickAny([win.locator('[data-tour="export"]'), win.getByRole('button', { name: '导出', exact: true })], 5000))) throw new Error('找不到导出按钮');
    await win.waitForTimeout(800);
    await shot('06-export-dialog');
    const go = await firstVisible([win.getByRole('button', { name: '开始导出' }), win.getByRole('button', { name: '仍然导出' })], 5000);
    if (!go) throw new Error('导出对话框没有「开始导出」');
    // 主线程没有空闲时间时，导出仍应能在 Worker 中编码 JPEG。
    await win.evaluate(() => {
      const convertToBlob = OffscreenCanvas.prototype.convertToBlob;
      OffscreenCanvas.prototype.convertToBlob = function (options) {
        if (options?.type === 'image/jpeg') throw new Error('导出 JPEG 应在 Worker 编码');
        return convertToBlob.call(this, options);
      };
    });
    await go.click();
    let lastShot = 0;
    const done = await waitFor(async () => {
      if (Date.now() - lastShot > 20000) { lastShot = Date.now(); await shot('06-exporting'); }
      if (await win.getByRole('button', { name: '再导出一份' }).count()) return 'done';
      const err = await win.locator('.modal :text("失败")').count().catch(() => 0);
      if (err && !(await win.getByRole('button', { name: '取消导出' }).count())) return 'error';
      return null;
    }, 8 * 60 * 1000, 1000);
    await shot('06-export-done');
    if (done !== 'done') throw new Error(done === 'error' ? '导出报错（见截图 full-06-export-done.png）' : '导出超时');
    const mp4s = fs.readdirSync(outDir).filter((f) => /\.mp4$/i.test(f)).map((f) => path.join(outDir, f));
    if (!mp4s.length) throw new Error('临时目录里没有导出的 mp4：' + outDir);
    exportedFile = mp4s.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    await closeOverlays();
    return exportedFile;
  });

  await step('07 ffprobe 校验', async () => {
    const info = ffprobe(exportedFile);
    const v = (info.streams || []).find((s) => s.codec_type === 'video');
    const a = (info.streams || []).find((s) => s.codec_type === 'audio');
    const dur = Number(info.format && info.format.duration);
    if (!v) throw new Error('没有视频流');
    if (!a) throw new Error('没有音频流');
    if (!(dur > 0)) throw new Error('时长不大于 0');
    // 期望分辨率：按项目设置 + 导出预设（与 ExportDialog 同一套 resolveExportOptions）
    const proj = findProjectJson(dataRoot);
    let expect = null;
    if (proj) {
      try {
        const { resolveExportOptions } = await import(pathToFileURL(path.join(ROOT, 'src/export/presets.js')).href);
        const o = resolveExportOptions(proj.exportPreset || 'custom', proj.settings || {});
        expect = { w: o.w, h: o.h };
      } catch {}
      if (!expect && proj.settings) expect = { w: proj.settings.width, h: proj.settings.height };
    }
    if (expect && (v.width !== expect.w || v.height !== expect.h)) {
      const ra = v.width / v.height, rb = expect.w / expect.h;
      throw new Error(`分辨率 ${v.width}x${v.height} 不符合预设 ${expect.w}x${expect.h}${Math.abs(ra - rb) < 0.02 ? '（比例一致）' : ''}`);
    }
    if (!expect && (v.width % 2 || v.height % 2 || v.width < 320)) throw new Error(`分辨率异常 ${v.width}x${v.height}`);
    let durNote = '';
    if (proj) {
      const { projectDuration } = await import(pathToFileURL(path.join(ROOT, 'src/engine/timeline.js')).href);
      const want = projectDuration(proj);
      const aDur = Number(a.duration) || dur;
      if (Math.abs(dur - want) > 0.2) throw new Error(`导出时长 ${dur.toFixed(2)}s 与工程时长 ${want.toFixed(2)}s 不符`);
      if (Math.abs(aDur - want) > 0.2) throw new Error(`音频流时长 ${aDur.toFixed(2)}s 与工程时长 ${want.toFixed(2)}s 不符`);
      durNote = `，工程 ${want.toFixed(2)}s，音频流 ${aDur.toFixed(2)}s`;
    }
    return `${v.codec_name} ${v.width}x${v.height}${expect ? '（符合预设）' : ''} + ${a.codec_name}，${dur.toFixed(2)}s${durNote}`;
  });
} catch (e) {
  if (!e.stepFailed) { errors.push('[full] ' + e.message); await shot('99-failure').catch(() => {}); }
} finally {
  await app.close().catch(() => {});
  console.log('\n[full] 步骤：');
  for (const r of results) console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.name} (${r.ms}ms)${r.detail ? ' · ' + r.detail : ''}${r.error ? ' — ' + r.error : ''}`);
  const failed = results.find((r) => !r.ok);
  if (errors.length) { console.log('\n[full] 错误：'); for (const x of errors) console.log('  - ' + x); }
  if (failed || errors.length || results.length < 7) {
    console.log(`\n[full] 失败${failed ? '于步骤：' + failed.name : ''}`);
    process.exitCode = 1;
  } else log('全部通过');
  for (const d of [userData, dataRoot, outDir, fixDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}
