// AI 预演画面的冒烟测试：用记录调用的假 2D 画布把所有场景 × 景别 × 主体画一遍。
// 检查：不抛错、不产生 NaN/Infinity 坐标、渐变色标合法、同输入同输出（确定性）、不用 Math.random。
import test from 'node:test';
import assert from 'node:assert/strict';

import { drawPreviz, drawPrevizHud, previzCamera } from '../src/render/previz.js';
import { paletteLook } from '../src/render/previz/post.js';
import { PREVIZ_SETTINGS, SHOT_SIZES, PREVIZ_ACTIONS } from '../src/engine/model.js';

const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*(,\s*-?[\d.e-]+\s*)?\)|transparent)$/i;

const PROPS = {
  fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
  globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none', font: '10px sans-serif',
  textAlign: 'start', textBaseline: 'alphabetic', direction: 'ltr', letterSpacing: '0px',
  shadowBlur: 0, shadowColor: 'rgba(0,0,0,0)', shadowOffsetX: 0, shadowOffsetY: 0,
  imageSmoothingEnabled: true, imageSmoothingQuality: 'low', lineDashOffset: 0,
};

const fmt = (a) => (typeof a === 'number' ? a.toFixed(4) : typeof a === 'string' ? a : typeof a);

/** 假 2D 上下文：方法一律接受并（可选）记录；检查数值参数有限、颜色可解析 */
function fakeCtx(w, h, sink) {
  const state = { ...PROPS, canvas: { width: w, height: h } };
  const problems = sink.problems;
  const note = (name, args) => {
    for (const a of args) {
      if (typeof a === 'number' && !Number.isFinite(a)) problems.push(`${name}(${args.map(fmt).join(',')})`);
    }
    if (sink.log) sink.log.push(`${name}(${args.map(fmt).join(',')})`);
  };
  const gradient = (name, args) => {
    note(name, args);
    return {
      addColorStop(o, c) {
        if (!(o >= 0 && o <= 1)) problems.push(`${name}.addColorStop offset ${o}`);
        if (typeof c !== 'string' || !COLOR_RE.test(c.trim())) problems.push(`${name}.addColorStop color ${c}`);
        if (sink.log) sink.log.push(`stop(${fmt(o)},${c})`);
      },
    };
  };
  const special = {
    createLinearGradient: (...a) => gradient('createLinearGradient', a),
    createRadialGradient: (...a) => gradient('createRadialGradient', a),
    createConicGradient: (...a) => gradient('createConicGradient', a),
    createPattern: () => ({ setTransform() {} }),
    measureText: (t) => ({ width: String(t).length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createImageData: (iw, ih) => ({ width: iw, height: ih, data: new Uint8ClampedArray(Math.max(0, iw * ih * 4)) }),
    getImageData: (x, y, iw, ih) => ({ width: iw, height: ih, data: new Uint8ClampedArray(Math.max(0, iw * ih * 4)) }),
    getLineDash: () => [],
    isPointInPath: () => false,
  };
  return new Proxy(state, {
    get(t, k) {
      if (typeof k === 'symbol') return undefined;
      if (k in special) {
        return (...a) => {
          if (k !== 'createLinearGradient' && k !== 'createRadialGradient' && k !== 'createConicGradient') note(k, a.filter((x) => typeof x !== 'object'));
          return special[k](...a);
        };
      }
      if (k in t) return t[k];
      return (...a) => note(k, a.filter((x) => typeof x !== 'object'));
    },
    set(t, k, v) {
      if ((k === 'fillStyle' || k === 'strokeStyle' || k === 'shadowColor') && typeof v === 'string' && !COLOR_RE.test(v.trim())) problems.push(`${k}=${v}`);
      if (typeof v === 'number' && !Number.isFinite(v)) problems.push(`${k}=${v}`);
      t[k] = v;
      if (sink.log) sink.log.push(`${k}=${fmt(v)}`);
      return true;
    },
    has(t, k) {
      return k in t || k in special;
    },
  });
}

// 预演内部的缓冲画布（景深、辉光、颗粒）也用假画布
const SINK = { problems: [], log: null };
globalThis.OffscreenCanvas = class {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.ctx = fakeCtx(w, h, SINK);
  }
  getContext() {
    return this.ctx;
  }
};

function render(spec, p, w, h, opts) {
  const ctx = fakeCtx(w, h, SINK);
  drawPreviz(ctx, spec, p, w, h, opts);
}

const SUBJECTS = {
  person: (action) => [{ kind: 'person', x: 0.45, y: 0.8, color: '#c8743a', action, label: '主角' }],
  duo: () => [{ kind: 'person', x: 0.34, y: 0.8, color: '#44506a', action: 'talk' }, { kind: 'person', x: 0.68, y: 0.82, color: '#a04a4a', action: 'idle' }],
  product: () => [{ kind: 'product', x: 0.5, y: 0.7, color: '#d0a060', action: 'rotate', label: '新品' }],
  cup: () => [{ kind: 'cup', x: 0.5, y: 0.66, color: '#f2ece2', action: 'pour' }, { kind: 'text', text: '早安' }],
  car: () => [{ kind: 'car', x: 0.5, y: 0.7, color: '#a03030' }],
  empty: () => [],
};

test('previz：所有场景 × 景别 × 主体都能画，坐标与颜色合法', () => {
  SINK.problems.length = 0;
  let n = 0;
  for (const setting of PREVIZ_SETTINGS) {
    for (const shotSize of SHOT_SIZES) {
      for (const [name, mk] of Object.entries(SUBJECTS)) {
        const spec = {
          setting,
          timeOfDay: setting === 'night-city' ? 'night' : 'golden',
          palette: ['#12343b', '#e08a4b', '#f2d0a4'],
          subjects: mk(name === 'person' ? PREVIZ_ACTIONS[n % PREVIZ_ACTIONS.length] : 'idle'),
          camera: { shotSize, movement: ['static', 'push-in', 'orbit', 'tracking', 'drift'][n % 5], angle: ['eye-level', 'low', 'high'][n % 3] },
          light: { direction: ['left', 'right', 'back', 'top'][n % 4], key: 'warm', mood: ['soft', 'dramatic', 'night', 'bright'][n % 4] },
          overlayText: n % 7 === 0 ? '标题文字' : '',
        };
        render(spec, (n % 10) / 9, 320, 180, { label: n % 2 ? '第1镜' : '', watermark: true });
        n += 1;
      }
    }
  }
  assert.ok(n > 500);
  assert.deepEqual(SINK.problems.slice(0, 8), [], `出现非法参数：${SINK.problems.slice(0, 8).join(' | ')}`);
});

test('previz：顶拍、竖屏、动作全集、空 spec 不抛错', () => {
  SINK.problems.length = 0;
  for (const action of PREVIZ_ACTIONS) {
    render({ setting: 'home', subjects: SUBJECTS.person(action), camera: { shotSize: 'full', movement: 'static', angle: 'top-down' } }, 0.5, 180, 320, {});
    render({ setting: 'nature', subjects: SUBJECTS.person(action), camera: { shotSize: 'wide', movement: 'handheld', angle: 'dutch' } }, 0.3, 180, 320, { hud: false });
  }
  render(null, 0.5, 320, 180, {});
  render({}, 2, 320, 180, {});
  render({ setting: 'nature' }, -1, 1, 1, {});
  render({ setting: 'studio' }, 0.5, 0, 0, {});
  assert.deepEqual(SINK.problems.slice(0, 8), []);
});

test('previz：同输入同输出（调用序列完全一致），且不用 Math.random', () => {
  const spec = { setting: 'nature', timeOfDay: 'golden', palette: ['#3b2a20', '#e0a96d', '#f6e3c4'], subjects: SUBJECTS.person('walk-right'), camera: { shotSize: 'full', movement: 'tracking', angle: 'eye-level' }, light: { direction: 'right', key: 'warm', mood: 'soft' } };
  const real = Math.random;
  let calls = 0;
  Math.random = () => {
    calls += 1;
    return real();
  };
  try {
    render(spec, 0.4, 640, 360, {}); // 预热：缓冲画布和噪声纹理只在第一次创建
    const run = () => {
      SINK.log = [];
      render(spec, 0.4, 640, 360, {});
      const out = SINK.log;
      SINK.log = null;
      return out;
    };
    const a = run();
    const b = run();
    assert.ok(a.length > 200, '应当真的画了东西');
    assert.deepEqual(a, b);
    for (const setting of PREVIZ_SETTINGS) render({ ...spec, setting }, 0.7, 320, 180, {});
    assert.equal(calls, 0, '预演不能用 Math.random（会让同一镜头每次不一样）');
  } finally {
    Math.random = real;
    SINK.log = null;
  }
});

test('previz：对外函数签名不变；标注层可单独画、可关掉角标和景别标签', () => {
  assert.equal(drawPreviz.length, 5);
  assert.equal(drawPrevizHud.length, 5);
  assert.equal(previzCamera.length, 4);
  const spec = { setting: 'cafe', subjects: SUBJECTS.person('idle'), camera: { shotSize: 'medium', movement: 'static', angle: 'eye-level' } };
  const count = (opts) => {
    SINK.log = [];
    drawPrevizHud(fakeCtx(640, 360, SINK), spec, 0.5, 640, 360, opts);
    const n = SINK.log.filter((s) => s.startsWith('fillText(')).length;
    SINK.log = null;
    return n;
  };
  const full = count({ watermark: true, label: '第1镜' });
  const lean = count({ watermark: true, label: '第1镜', corners: false, shotInfo: false });
  assert.ok(full > lean, '关掉景别标签后文字应更少');
  assert.ok(lean >= 2, '水印和镜头标题仍然要画');
});

// AI 返回的分镜、旧版本存下的项目，字段类型都可能不对。预演是「没有素材时的兜底画面」，
// 它自己不能再出错：任何输入都要画得出来（画不出想要的就画默认的），不能让预览或导出中断。
test('previz：分镜数据再乱也不抛错、不出非法坐标（字段类型不对、缺字段、取值不认识）', () => {
  SINK.problems.length = 0;
  const JUNK = [
    'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'nope', '', ' ', 0, 5, -1, 0.5, NaN, Infinity, -Infinity,
    null, undefined, true, false, [], {}, [1, 2], { a: 1 }, '0.4', '#fff', '#12', 'rgb(1,2,3)', '很长的字'.repeat(120), () => 1,
  ];
  const base = () => ({
    setting: 'cafe', timeOfDay: 'golden', palette: ['#12343b', '#e08a4b', '#f2d0a4'],
    subjects: [{ kind: 'person', x: 0.4, y: 0.8, scale: 1, color: '#c8743a', action: 'talk', label: '主角' }, { kind: 'cup', x: 0.7, y: 0.7, color: '#f2ece2', action: 'pour' }],
    camera: { shotSize: 'medium', movement: 'push-in', angle: 'eye-level' },
    light: { direction: 'left', key: 'warm', mood: 'soft' },
    overlayText: '标题',
  });
  const failures = [];
  let n = 0;
  const attempt = (name, spec, p = 0.5, w = 320, h = 180, opts = { label: '第1镜', watermark: true }) => {
    n += 1;
    const before = SINK.problems.length;
    try {
      render(spec, p, w, h, opts);
      drawPrevizHud(fakeCtx(w, h, SINK), spec, p, w, h, opts);
      previzCamera(spec, p, w, h, opts);
    } catch (err) {
      failures.push(`${name} 抛错：${err && err.message}`);
      return;
    }
    if (SINK.problems.length > before) failures.push(`${name} 非法参数：${SINK.problems[before]}`);
  };
  const show = (v) => (typeof v === 'string' ? JSON.stringify(v.slice(0, 16)) : typeof v === 'function' ? 'fn' : Array.isArray(v) ? `[${v.length}]` : String(v && typeof v === 'object' ? '{}' : v));

  for (const j of JUNK) {
    attempt(`spec=${show(j)}`, j);
    for (const k of ['setting', 'timeOfDay', 'palette', 'subjects', 'camera', 'light', 'overlayText']) attempt(`${k}=${show(j)}`, { ...base(), [k]: j });
    for (const k of ['shotSize', 'movement', 'angle']) attempt(`camera.${k}=${show(j)}`, { ...base(), camera: { ...base().camera, [k]: j } });
    for (const k of ['direction', 'key', 'mood']) attempt(`light.${k}=${show(j)}`, { ...base(), light: { ...base().light, [k]: j } });
    attempt(`palette[*]=${show(j)}`, { ...base(), palette: [j, j, j] });
    attempt(`subjects=[${show(j)}]`, { ...base(), subjects: [j, j] });
    for (const kind of ['person', 'product', 'car', 'text']) {
      for (const k of ['kind', 'x', 'y', 'scale', 'color', 'action', 'label', 'text']) {
        const subject = { kind, x: 0.5, y: 0.7, scale: 1, color: '#c8743a', action: 'idle', label: '名字', text: '文字', [k]: j };
        attempt(`subject(${kind}).${k}=${show(j)}`, { ...base(), subjects: [subject] });
      }
    }
    attempt(`progress=${show(j)}`, base(), j);
    attempt(`w=${show(j)}`, base(), 0.5, j, 180);
    attempt(`h=${show(j)}`, base(), 0.5, 320, j);
    for (const k of ['label', 'watermark', 'shotSize', 'movement', 'hud', 'labels', 'corners', 'shotInfo']) attempt(`opts.${k}=${show(j)}`, base(), 0.5, 320, 180, { label: '第1镜', [k]: j });
  }
  attempt('opts=null', base(), 0.5, 320, 180, null);
  attempt('很多主体', { ...base(), subjects: Array.from({ length: 40 }, (_, i) => ({ kind: i % 2 ? 'person' : 'box', x: i / 40, y: 0.7 })) });
  attempt('非整数画幅', base(), 0.37, 333.5, 187.25);
  attempt('极窄画幅', base(), 0.5, 2, 900);
  attempt('极宽画幅', base(), 0.5, 2400, 3);

  assert.ok(n > 1500, '应当真的试了很多种坏数据');
  assert.equal(failures.length, 0, `共 ${failures.length} 种坏数据出问题：\n${failures.slice(0, 60).join('\n')}`);
});

test('paletteLook：黑白类配色去色；彩色配色给出不同的暗部 / 亮部色；结果稳定', () => {
  const bw = paletteLook({ base: '#111111', accent: '#808080', paper: '#eeeeee', night: 0 });
  assert.equal(bw.gray, true);
  assert.ok(bw.desat > 0.5);
  const warm = paletteLook({ base: '#3b2a20', accent: '#e0a96d', paper: '#f6e3c4', night: 0 });
  const cool = paletteLook({ base: '#1f2c38', accent: '#7fa6c4', paper: '#e4edf3', night: 0 });
  assert.equal(warm.gray, false);
  assert.equal(warm.desat, 0);
  assert.notEqual(warm.shadow, cool.shadow);
  assert.notEqual(warm.high, cool.high);
  for (const c of [warm.shadow, warm.high, warm.mid, cool.shadow, cool.high]) assert.match(c, /^#[0-9a-f]{6}$/);
  assert.deepEqual(paletteLook({ base: '#3b2a20', accent: '#e0a96d', paper: '#f6e3c4', night: 0 }), warm);
});
