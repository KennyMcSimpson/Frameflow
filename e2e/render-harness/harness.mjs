// 渲染调试脚手架的页面端：用真正的 compositor / previz / looks / transitions / text 渲染一组场景并存 PNG。
// 由 main.cjs 在隐藏窗口里加载（先用 esbuild 打包成 build/harness.js）。

import { renderFrame, releaseRenderCache } from '../../src/render/compositor.js';
import { drawPreviz } from '../../src/render/previz.js';
import { createMediaPool } from '../../src/render/mediaPool.js';
import { layoutVideo } from '../../src/engine/timeline.js';
import {
  createProject, createAsset, createClip, createTextClip, createPrevizSpec,
  PREVIZ_SETTINGS, LOOK_LABELS, TRANSITION_LABELS, SHOT_SIZE_LABELS,
} from '../../src/engine/model.js';

const H = window.harness;
const FONT = '"Microsoft YaHei UI","Microsoft YaHei",sans-serif';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function save(name, c) {
  await H.save(name, c.toDataURL('image/png'));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片加载失败：${src.slice(0, 60)}`));
    img.src = src;
  });
}

/** 拼一张对比图：每格下方写标签 */
function sheet(cells, cols, cw, ch, title) {
  const pad = 12;
  const lab = 30;
  const head = title ? 44 : 0;
  const rows = Math.ceil(cells.length / cols);
  const c = canvas(pad + cols * (cw + pad), head + pad + rows * (ch + lab + pad));
  const g = c.getContext('2d');
  g.fillStyle = '#16171b';
  g.fillRect(0, 0, c.width, c.height);
  if (title) {
    g.fillStyle = '#f2f2f2';
    g.font = `600 20px ${FONT}`;
    g.textBaseline = 'middle';
    g.fillText(title, pad, head / 2 + 4);
  }
  cells.forEach((cell, i) => {
    const x = pad + (i % cols) * (cw + pad);
    const y = head + pad + Math.floor(i / cols) * (ch + lab + pad);
    g.drawImage(cell.canvas, x, y, cw, ch);
    g.fillStyle = '#d8d8d8';
    g.font = `500 15px ${FONT}`;
    g.textBaseline = 'middle';
    g.fillText(cell.label, x + 2, y + ch + lab / 2);
  });
  return c;
}

function projectWith(width, height) {
  const p = createProject({ name: '渲染调试' });
  p.settings.width = width;
  p.settings.height = height;
  return p;
}

function previzAsset(id, spec, duration = 4) {
  return createAsset({ id, kind: 'previz', name: `预演 ${id}`, path: null, duration, previz: createPrevizSpec(spec) });
}

/** 用真正的 renderFrame 出一帧 */
function frame(project, t, pool, w, h, mode = 'export') {
  const c = canvas(w, h);
  const ctx = c.getContext('2d', { alpha: false });
  renderFrame(ctx, project, t, pool, { width: w, height: h, mode, frameIndex: Math.round(t * 30) });
  return c;
}

const stillPool = (images) => ({ getFrame: (asset) => images[asset.id] || null });

// ---------------- 场景 ----------------

const SETTING_SPECS = {
  cafe: { timeOfDay: 'day', subjects: [{ kind: 'person', x: 0.42, action: 'talk', color: '#c9824f' }, { kind: 'cup', x: 0.66, color: '#f1e7d6' }], light: { direction: 'left', key: 'warm', mood: 'soft' } },
  street: { timeOfDay: 'golden', subjects: [{ kind: 'person', x: 0.38, action: 'walk-right', color: '#3d5a80' }, { kind: 'car', x: 0.74, color: '#b23a48' }], camera: { shotSize: 'wide' }, light: { direction: 'right', key: 'warm', mood: 'bright' } },
  nature: { timeOfDay: 'golden', subjects: [{ kind: 'person', x: 0.5, action: 'walk-left', color: '#5f7d4e' }], camera: { shotSize: 'full' }, light: { direction: 'back', key: 'warm', mood: 'soft' } },
  studio: { timeOfDay: 'day', subjects: [{ kind: 'product', x: 0.5, action: 'rotate', color: '#d9a441', label: '新品' }], light: { direction: 'top', key: 'neutral', mood: 'dramatic' } },
  office: { timeOfDay: 'day', subjects: [{ kind: 'person', x: 0.4, action: 'talk', color: '#44546a' }, { kind: 'laptop', x: 0.68, color: '#9aa3ad' }], light: { direction: 'left', key: 'cool', mood: 'bright' } },
  home: { timeOfDay: 'golden', subjects: [{ kind: 'person', x: 0.45, action: 'idle', color: '#a26769' }, { kind: 'plant', x: 0.78, color: '#4f772d' }], light: { direction: 'right', key: 'warm', mood: 'soft' } },
  'night-city': { timeOfDay: 'night', subjects: [{ kind: 'person', x: 0.5, action: 'turn', color: '#2b2d42' }], camera: { shotSize: 'full' }, light: { direction: 'back', key: 'cool', mood: 'night' } },
  beach: { timeOfDay: 'golden', subjects: [{ kind: 'person', x: 0.4, action: 'raise', color: '#e07a5f' }], camera: { shotSize: 'wide' }, light: { direction: 'back', key: 'warm', mood: 'bright' } },
  kitchen: { timeOfDay: 'day', subjects: [{ kind: 'person', x: 0.42, action: 'pour', color: '#6d597a' }, { kind: 'cup', x: 0.64, color: '#ffffff' }], light: { direction: 'left', key: 'neutral', mood: 'soft' } },
  shop: { timeOfDay: 'day', subjects: [{ kind: 'person', x: 0.4, action: 'idle', color: '#457b9d' }, { kind: 'box', x: 0.7, color: '#e9c46a' }], light: { direction: 'front', key: 'neutral', mood: 'bright' } },
  gym: { timeOfDay: 'day', subjects: [{ kind: 'person', x: 0.5, action: 'jump', color: '#e63946' }], camera: { shotSize: 'full' }, light: { direction: 'top', key: 'cool', mood: 'dramatic' } },
  abstract: { timeOfDay: 'night', subjects: [{ kind: 'phone', x: 0.5, action: 'rotate', color: '#3a86ff' }], overlayText: '一键成片', light: { direction: 'back', key: 'cool', mood: 'dramatic' } },
};

async function scenePreviz() {
  const W = 960;
  const Hh = 540;
  const cells = [];
  for (const setting of PREVIZ_SETTINGS) {
    const spec = createPrevizSpec({ setting, ...SETTING_SPECS[setting] });
    spec.camera = { shotSize: 'medium', movement: 'static', angle: 'eye-level', ...(SETTING_SPECS[setting].camera || {}) };
    const c = canvas(W, Hh);
    drawPreviz(c.getContext('2d'), spec, 0.5, W, Hh, { label: `预演 · ${setting}` });
    await save(`previz-${setting}`, c);
    cells.push({ canvas: c, label: setting });
  }
  await save('sheet-previz', sheet(cells, 3, 480, 270, '预演 · 12 种场景'));
}

async function sceneShots() {
  const sizes = ['wide', 'medium', 'close-up', 'extreme-close-up'];
  const cells = [];
  for (const shotSize of sizes) {
    const spec = createPrevizSpec({ setting: 'cafe', ...SETTING_SPECS.cafe, camera: { shotSize, movement: 'push-in', angle: 'eye-level' } });
    const c = canvas(960, 540);
    drawPreviz(c.getContext('2d'), spec, 0.5, 960, 540, {});
    await save(`shot-${shotSize}`, c);
    cells.push({ canvas: c, label: `${SHOT_SIZE_LABELS[shotSize]}（${shotSize}）` });
  }
  // 竖屏与不同机位
  const angles = [['low', 'full'], ['high', 'medium'], ['over-shoulder', 'medium'], ['top-down', 'medium']];
  for (const [angle, shotSize] of angles) {
    const spec = createPrevizSpec({ setting: 'office', ...SETTING_SPECS.office, camera: { shotSize, movement: 'static', angle } });
    const c = canvas(960, 540);
    drawPreviz(c.getContext('2d'), spec, 0.5, 960, 540, {});
    cells.push({ canvas: c, label: `机位 ${angle} · ${shotSize}` });
  }
  await save('sheet-shots', sheet(cells, 4, 400, 225, '景别（上）与机位（下）'));
  const v = canvas(540, 960);
  drawPreviz(v.getContext('2d'), createPrevizSpec({ setting: 'street', ...SETTING_SPECS.street, camera: { shotSize: 'full', movement: 'static', angle: 'low' } }), 0.5, 540, 960, { label: '竖屏 9:16' });
  await save('shot-vertical', v);
}

async function sceneLooks(testImg) {
  const looks = ['none', 'cinematic', 'film-warm', 'film-cool', 'bw', 'noir', 'vintage', 'cool-night', 'vivid', 'soft-pastel', 'high-contrast', 'moody', 'golden-hour', 'cyberpunk'];
  const cells = [];
  for (const look of looks) {
    const p = projectWith(1280, 720);
    const a = createAsset({ id: 'img', kind: 'image', path: 'test.png', duration: 4, width: 1280, height: 720 });
    p.assets = { img: a };
    const clip = createClip(a, { id: 'c', out: 4 });
    clip.color = { ...clip.color, look, lookStrength: 1 };
    p.tracks.video = [clip];
    const c = frame(p, 1, stillPool({ img: testImg }), 1280, 720);
    if (['none', 'cinematic', 'bw', 'vintage', 'golden-hour', 'cyberpunk'].includes(look)) await save(`look-${look}`, c);
    cells.push({ canvas: c, label: `${LOOK_LABELS[look]}（${look}）` });
  }
  await save('sheet-looks', sheet(cells, 4, 400, 225, '调色 Look 对比（同一张 ffmpeg 测试图）'));

  // 同一 look 在预演画面上（更接近真实画面）
  const cells2 = [];
  for (const look of ['none', 'cinematic', 'film-warm', 'moody', 'golden-hour', 'cyberpunk']) {
    const p = projectWith(1280, 720);
    const a = previzAsset('pz', { setting: 'cafe', ...SETTING_SPECS.cafe });
    p.assets = { pz: a };
    const clip = createClip(a, { id: 'c', out: 4 });
    clip.color = { ...clip.color, look, lookStrength: 1 };
    p.tracks.video = [clip];
    cells2.push({ canvas: frame(p, 2, stillPool({}), 1280, 720), label: LOOK_LABELS[look] });
  }
  await save('sheet-looks-previz', sheet(cells2, 3, 480, 270, '调色 Look 在预演画面上'));

  // 手动参数
  const manual = [
    ['曝光 +0.5', { exposure: 0.5 }], ['曝光 -0.5', { exposure: -0.5 }], ['对比 +0.6', { contrast: 0.6 }], ['饱和 -0.7', { saturation: -0.7 }],
    ['色温 +0.6', { temperature: 0.6 }], ['色温 -0.6', { temperature: -0.6 }], ['高光 -0.8', { highlights: -0.8 }], ['阴影 +0.8', { shadows: 0.8 }],
  ];
  const cells3 = [];
  for (const [label, delta] of manual) {
    const p = projectWith(1280, 720);
    const a = createAsset({ id: 'img', kind: 'image', path: 'test.png', duration: 4 });
    p.assets = { img: a };
    const clip = createClip(a, { id: 'c', out: 4 });
    clip.color = { ...clip.color, ...delta };
    p.tracks.video = [clip];
    cells3.push({ canvas: frame(p, 1, stillPool({ img: testImg }), 1280, 720), label });
  }
  await save('sheet-color-manual', sheet(cells3, 4, 400, 225, '手动调色参数'));
}

async function sceneTransitions(testImg) {
  const types = ['crossfade', 'dip-black', 'dip-white', 'slide-left', 'slide-up', 'zoom-in', 'zoom-out', 'wipe-left', 'wipe-right', 'blur', 'whip-pan', 'flash', 'spin'];
  const cells = [];
  for (const type of types) {
    for (const p01 of [0.5]) {
      const p = projectWith(1280, 720);
      const a = createAsset({ id: 'img', kind: 'image', path: 'test.png', duration: 4 });
      const b = previzAsset('pz', { setting: 'beach', ...SETTING_SPECS.beach });
      p.assets = { img: a, pz: b };
      p.tracks.video = [
        createClip(a, { id: 'c1', out: 3 }),
        createClip(b, { id: 'c2', out: 3, transitionIn: { type, duration: 1 } }),
      ];
      const lay = layoutVideo(p);
      const t = lay[1].start + lay[1].overlap * p01;
      const c = frame(p, t, stillPool({ img: testImg }), 1280, 720);
      if (['crossfade', 'slide-left', 'zoom-in', 'whip-pan', 'wipe-left'].includes(type)) await save(`transition-${type}`, c);
      cells.push({ canvas: c, label: `${TRANSITION_LABELS[type]}（${type}）p=${p01}` });
    }
  }
  await save('sheet-transitions', sheet(cells, 4, 400, 225, '转场中间帧（测试图 → 海边预演）'));

  // 推移 / 甩镜 / 旋转的多个进度
  const cells2 = [];
  for (const type of ['slide-left', 'whip-pan', 'spin', 'zoom-in']) {
    for (const p01 of [0.2, 0.4, 0.6, 0.8]) {
      const p = projectWith(1280, 720);
      const a = createAsset({ id: 'img', kind: 'image', path: 'test.png', duration: 4 });
      const b = previzAsset('pz', { setting: 'beach', ...SETTING_SPECS.beach });
      p.assets = { img: a, pz: b };
      p.tracks.video = [createClip(a, { id: 'c1', out: 3 }), createClip(b, { id: 'c2', out: 3, transitionIn: { type, duration: 1 } })];
      const lay = layoutVideo(p);
      cells2.push({ canvas: frame(p, lay[1].start + lay[1].overlap * p01, stillPool({ img: testImg }), 1280, 720), label: `${type} p=${p01}` });
    }
  }
  await save('sheet-transitions-progress', sheet(cells2, 4, 400, 225, '转场过程'));
}

async function sceneText() {
  const presets = [
    ['title', '城市的清晨', '#ffffff', 'fade'],
    ['subtitle', '每一杯咖啡，都是今天的第一个好心情', '#ffffff', 'fade'],
    ['lower-third', '林晓 · 咖啡师', '#e0a96d', 'slide-up'],
    ['caption-box', '限时 8 折，仅此三天', '#ffffff', 'pop'],
    ['big-bold', '太好喝了！', '#ffd166', 'pop'],
    ['handwrite', '慢一点，生活更好', '#ffffff', 'fade'],
    ['neon', 'OPEN 营业中', '#ff4fd8', 'fade'],
    ['title', '打字机效果演示', '#ffffff', 'typewriter'],
  ];
  const cells = [];
  for (const [preset, text, color, animation] of presets) {
    const p = projectWith(1280, 720);
    const setting = preset === 'neon' ? 'night-city' : 'cafe';
    const a = previzAsset('pz', { setting, ...SETTING_SPECS[setting] });
    p.assets = { pz: a };
    p.tracks.video = [createClip(a, { id: 'c', out: 4 })];
    const y = preset === 'lower-third' ? 0.8 : preset === 'subtitle' ? 0.86 : 0.5;
    const x = preset === 'lower-third' ? 0.28 : 0.5;
    p.tracks.text = [createTextClip({ id: 't', start: 0, duration: 4, text, preset, color, animation, x, y })];
    const t = animation === 'typewriter' ? 1.2 : 2;
    const c = frame(p, t, stillPool({}), 1280, 720);
    await save(`text-${preset}${animation === 'typewriter' ? '-typewriter' : ''}`, c);
    cells.push({ canvas: c, label: `${preset} · ${animation}` });
  }
  // 镜头字幕三种样式
  for (const style of ['subtitle', 'title', 'lower-third']) {
    const p = projectWith(1280, 720);
    const a = previzAsset('pz', { setting: 'home', ...SETTING_SPECS.home });
    p.assets = { pz: a };
    p.tracks.video = [createClip(a, { id: 'c', out: 4, caption: { text: style === 'lower-third' ? '王阿姨 · 社区花店店主' : '这家店开了二十年，街坊都认识她', style, position: style === 'title' ? 'center' : 'bottom' } })];
    cells.push({ canvas: frame(p, 2, stillPool({}), 1280, 720), label: `镜头字幕 ${style}` });
  }
  // 竖屏文字
  const pv = projectWith(720, 1280);
  const av = previzAsset('pz', { setting: 'gym', ...SETTING_SPECS.gym });
  pv.assets = { pz: av };
  pv.tracks.video = [createClip(av, { id: 'c', out: 4, caption: { text: '坚持 30 天，你会感谢现在的自己', style: 'subtitle', position: 'bottom' } })];
  pv.tracks.text = [createTextClip({ id: 't', start: 0, duration: 4, text: '燃脂挑战', preset: 'big-bold', color: '#ffd166', animation: 'pop', x: 0.5, y: 0.3 })];
  await save('text-vertical', frame(pv, 2, stillPool({}), 720, 1280));
  await save('sheet-text', sheet(cells, 4, 400, 225, '文字预设与镜头字幕'));
}

async function sceneFx(testImg) {
  const list = [
    ['原图', {}], ['胶片颗粒 0.8', { grain: 0.8 }], ['柔光辉光 0.8', { glow: 0.8 }], ['锐化 1', { sharpen: 1 }],
    ['电影黑边 1', { letterbox: 1 }], ['色差 0.8', { chromatic: 0.8 }], ['VHS 0.9', { vhs: 0.9 }], ['模糊 0.6', { blur: 0.6 }],
  ];
  const cells = [];
  for (const [label, fx] of list) {
    for (const src of ['img', 'pz']) {
      const p = projectWith(1280, 720);
      const a = createAsset({ id: 'img', kind: 'image', path: 'test.png', duration: 4 });
      const b = previzAsset('pz', { setting: 'street', ...SETTING_SPECS.street });
      p.assets = { img: a, pz: b };
      const clip = createClip(src === 'img' ? a : b, { id: 'c', out: 4 });
      clip.fx = { ...clip.fx, ...fx };
      p.tracks.video = [clip];
      cells.push({ canvas: frame(p, 2, stillPool({ img: testImg }), 1280, 720), label: `${label}${src === 'pz' ? '（预演）' : ''}` });
    }
  }
  // 闪白在镜头开头
  const p = projectWith(1280, 720);
  const b = previzAsset('pz', { setting: 'street', ...SETTING_SPECS.street });
  p.assets = { pz: b };
  const clip = createClip(b, { id: 'c', out: 4 });
  clip.fx = { ...clip.fx, flash: 1 };
  p.tracks.video = [clip];
  cells.push({ canvas: frame(p, 0.08, stillPool({}), 1280, 720), label: '闪白 1（镜头开头 0.08s）' });
  // 运镜 + 变换 + 缺失素材 + 空项目
  const pm = projectWith(1280, 720);
  const am = createAsset({ id: 'img', kind: 'image', path: 'test.png', duration: 4 });
  pm.assets = { img: am };
  pm.tracks.video = [createClip(am, { id: 'c', out: 4, motion: { preset: 'push-in', intensity: 1 }, transform: { scale: 1.2, x: 0.1, y: 0, rotation: 4, flipH: true } })];
  cells.push({ canvas: frame(pm, 3.9, stillPool({ img: testImg }), 1280, 720), label: '推近 + 缩放旋转翻转' });
  const pmiss = projectWith(1280, 720);
  pmiss.tracks.video = [createClip(null, { id: 'c', assetId: 'gone', out: 4 })];
  cells.push({ canvas: frame(pmiss, 1, stillPool({}), 1280, 720), label: '素材缺失占位' });
  cells.push({ canvas: frame(projectWith(1280, 720), 0, stillPool({}), 1280, 720), label: '空项目' });
  await save('sheet-fx', sheet(cells, 4, 400, 225, '特效（测试图 / 预演）与边界情况'));
}

async function sceneVideo(clockPath) {
  // 真实视频精确取帧：testsrc2 左上角有时间码与帧号，导出模式必须一帧不差
  const pool = createMediaPool({ mediaUrl: (p) => `file:///${p.replace(/\\/g, '/')}` });
  const p = projectWith(1280, 720);
  p.settings.fps = 30;
  const a = createAsset({ id: 'v', kind: 'video', path: clockPath, duration: 4, width: 1280, height: 720, fps: 30, hasAudio: false });
  p.assets = { v: a };
  p.tracks.video = [createClip(a, { id: 'c', in: 0.5, out: 3.5 })];
  const lay = layoutVideo(p);
  const cells = [];
  const started = performance.now();
  for (const frameIdx of [0, 1, 15, 29, 30, 61, 89]) {
    const t = frameIdx / 30;
    await pool.seekExact(p, t, lay);
    const c = canvas(1280, 720);
    renderFrame(c.getContext('2d', { alpha: false }), p, t, pool, { width: 1280, height: 720, layout: lay, mode: 'export', frameIndex: frameIdx });
    // 放大左上角时间码区域便于核对
    const zoom = canvas(640, 180);
    zoom.getContext('2d').drawImage(c, 0, 0, 320, 90, 0, 0, 640, 180);
    cells.push({ canvas: zoom, label: `时间线第 ${frameIdx} 帧 → 应显示源第 ${frameIdx + 15} 帧` });
  }
  H.log('info', `视频精确取帧 7 帧耗时 ${Math.round(performance.now() - started)}ms`);
  pool.dispose();
  await save('sheet-video-seek', sheet(cells, 2, 640, 180, '视频逐帧精确取帧（入点 0.5s = 源第 15 帧）'));
}

async function main() {
  const cfg = await H.config();
  const want = (name) => !cfg.scenes.length || cfg.scenes.includes(name);
  const testImg = await loadImage(await H.readDataUrl(cfg.assets.test));
  await document.fonts.ready;
  const steps = [
    ['previz', () => scenePreviz()],
    ['shots', () => sceneShots()],
    ['looks', () => sceneLooks(testImg)],
    ['transitions', () => sceneTransitions(testImg)],
    ['text', () => sceneText()],
    ['fx', () => sceneFx(testImg)],
    ['video', () => sceneVideo(cfg.assets.clock)],
  ];
  let ok = true;
  for (const [name, fn] of steps) {
    if (!want(name)) continue;
    const t0 = performance.now();
    try {
      await fn();
      H.log('info', `场景 ${name} 完成（${Math.round(performance.now() - t0)}ms）`);
    } catch (err) {
      ok = false;
      H.log('error', `场景 ${name} 失败：${(err && err.stack) || err}`);
    }
    releaseRenderCache();
  }
  H.done(ok);
}

main().catch((err) => {
  H.log('error', (err && err.stack) || String(err));
  H.done(false);
});
