// 页面端：用真实的 drawPreviz 渲染一组对比图并存 PNG，同时测单帧耗时。
import { drawPreviz } from '../../src/render/previz.js';
import { localStoryboard } from '../../src/ai/localDirector.js';
import { LOOK_PALETTES } from '../../src/ai/director.js';

const PH = window.ph;
const W = 1280;
const H = 720;
const FONT = '"Microsoft YaHei UI","Microsoft YaHei",sans-serif';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function frame(spec, p = 0.5, opts = {}, w = W, h = H) {
  const c = canvas(w, h);
  drawPreviz(c.getContext('2d'), spec, p, w, h, opts);
  return c;
}

function sheet(cells, cols, cw, ch, title) {
  const pad = 10;
  const lab = 26;
  const head = 40;
  const rows = Math.ceil(cells.length / cols);
  const c = canvas(pad + cols * (cw + pad), head + pad + rows * (ch + lab + pad));
  const g = c.getContext('2d');
  g.fillStyle = '#141518';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#eee';
  g.font = `600 18px ${FONT}`;
  g.textBaseline = 'middle';
  g.fillText(title, pad, head / 2 + 4);
  cells.forEach((cell, i) => {
    const x = pad + (i % cols) * (cw + pad);
    const y = head + pad + Math.floor(i / cols) * (ch + lab + pad);
    g.drawImage(cell.canvas, x, y, cw, ch);
    g.fillStyle = '#ccc';
    g.font = `500 14px ${FONT}`;
    g.fillText(cell.label, x + 2, y + ch + lab / 2);
  });
  return c;
}

const SUBJECT_FOR = {
  cafe: [{ kind: 'person', x: 0.42, y: 0.62, color: '#c8743a', action: 'pour', label: '咖啡师' }, { kind: 'cup', x: 0.62, y: 0.66, scale: 1, color: '#f2ece2' }],
  street: [{ kind: 'person', x: 0.5, y: 0.62, color: '#3c5a7a', action: 'walk-right' }],
  nature: [{ kind: 'person', x: 0.45, y: 0.62, color: '#8a6a4a', action: 'raise' }],
  studio: [{ kind: 'product', x: 0.5, y: 0.62, color: '#d0a060', action: 'rotate', label: '新品' }],
  office: [{ kind: 'person', x: 0.4, y: 0.62, color: '#44506a', action: 'talk' }, { kind: 'laptop', x: 0.66, y: 0.66, color: '#a9adb4' }],
  home: [{ kind: 'person', x: 0.5, y: 0.62, color: '#b0806a', action: 'turn' }, { kind: 'plant', x: 0.8, y: 0.6, color: '#5a9a63' }],
  'night-city': [{ kind: 'person', x: 0.5, y: 0.62, color: '#6a3a5a', action: 'walk-left' }],
  beach: [{ kind: 'person', x: 0.5, y: 0.62, color: '#e8d8b8', action: 'jump' }],
  kitchen: [{ kind: 'food', x: 0.5, y: 0.62, color: '#d9a56a' }, { kind: 'cup', x: 0.72, y: 0.6, color: '#f2ece2' }],
  shop: [{ kind: 'person', x: 0.38, y: 0.62, color: '#a04a4a', action: 'idle' }, { kind: 'box', x: 0.65, y: 0.64, color: '#c89a5a' }],
  gym: [{ kind: 'person', x: 0.5, y: 0.62, color: '#2a2a32', action: 'jump' }],
  abstract: [{ kind: 'phone', x: 0.5, y: 0.62, color: '#3a5ad0', action: 'rotate' }],
};
const TOD_FOR = { street: 'golden', 'night-city': 'night', beach: 'golden', nature: 'day', home: 'golden' };
const LIGHT_FOR = {
  cafe: { direction: 'left', key: 'warm', mood: 'soft' },
  street: { direction: 'back', key: 'warm', mood: 'dramatic' },
  'night-city': { direction: 'right', key: 'cool', mood: 'night' },
  studio: { direction: 'top', key: 'neutral', mood: 'dramatic' },
  gym: { direction: 'right', key: 'cool', mood: 'dramatic' },
};

function specFor(setting, over = {}) {
  return {
    setting,
    timeOfDay: TOD_FOR[setting] || 'day',
    palette: ['#2b2f3a', '#e0a96d', '#f4efe6'],
    subjects: SUBJECT_FOR[setting],
    camera: { shotSize: 'medium', movement: 'static', angle: 'eye-level' },
    light: LIGHT_FOR[setting] || { direction: 'left', key: 'warm', mood: 'soft' },
    overlayText: '',
    ...over,
  };
}

async function save(name, c) {
  await PH.save(name, c.toDataURL('image/png'));
}

// 典型镜头样张：新用户最常见的五类画面（人物近景 / 人物全景 / 空镜 / 产品特写 / 夜景）+ 竖屏，配不同调色。
const SAMPLE_SHOTS = [
  { label: '人物近景 · 咖啡馆', spec: { setting: 'cafe', timeOfDay: 'day', palette: LOOK_PALETTES['film-warm'], subjects: [{ kind: 'person', x: 0.42, y: 0.8, color: '#c8743a', action: 'talk' }], camera: { shotSize: 'close-up', movement: 'push-in', angle: 'eye-level' }, light: { direction: 'left', key: 'warm', mood: 'soft' } } },
  { label: '人物全景 · 街道', spec: { setting: 'street', timeOfDay: 'golden', palette: LOOK_PALETTES['golden-hour'], subjects: [{ kind: 'person', x: 0.36, y: 0.82, color: '#3c5a7a', action: 'walk-right' }], camera: { shotSize: 'full', movement: 'tracking', angle: 'eye-level' }, light: { direction: 'back', key: 'warm', mood: 'dramatic' } } },
  { label: '空镜 · 自然', spec: { setting: 'nature', timeOfDay: 'golden', palette: LOOK_PALETTES.cinematic, subjects: [], camera: { shotSize: 'wide', movement: 'drift', angle: 'eye-level' }, light: { direction: 'right', key: 'warm', mood: 'soft' } } },
  { label: '产品特写 · 影棚', spec: { setting: 'studio', timeOfDay: 'day', palette: LOOK_PALETTES.none, subjects: [{ kind: 'product', x: 0.5, y: 0.7, color: '#d0a060', action: 'rotate', scale: 1.2 }], camera: { shotSize: 'close-up', movement: 'orbit', angle: 'eye-level' }, light: { direction: 'top', key: 'neutral', mood: 'dramatic' } } },
  { label: '夜景 · 城市', spec: { setting: 'night-city', timeOfDay: 'night', palette: LOOK_PALETTES['cool-night'], subjects: [{ kind: 'person', x: 0.5, y: 0.8, color: '#6a3a5a', action: 'walk-left' }], camera: { shotSize: 'wide', movement: 'static', angle: 'low' }, light: { direction: 'right', key: 'cool', mood: 'night' } } },
  { label: '人物中景 · 办公室 · 两人', spec: { setting: 'office', timeOfDay: 'day', palette: LOOK_PALETTES['film-cool'], subjects: [{ kind: 'person', x: 0.34, y: 0.8, color: '#44506a', action: 'talk' }, { kind: 'person', x: 0.68, y: 0.82, color: '#a04a4a', action: 'idle' }], camera: { shotSize: 'medium', movement: 'static', angle: 'eye-level' }, light: { direction: 'left', key: 'neutral', mood: 'soft' } } },
];
const SAMPLE_TOPICS = ['咖啡店探店 短视频', '新品耳机产品宣传片', '旅行 vlog 海边'];

async function runSample(prefix) {
  const cells = SAMPLE_SHOTS.map((s) => ({ canvas: frame(s.spec, 0.45, { label: '' }, 960, 540), label: s.label }));
  await save(`${prefix}-typical`, sheet(cells, 2, 960, 540, '典型镜头'));
  // 真实链路：本地规则生成的分镜（没有 AI、没有素材时新用户看到的就是它）
  const sbCells = [];
  for (const title of SAMPLE_TOPICS) {
    const board = localStoryboard({ title, duration: 30 });
    const shots = (board && board.shots) || [];
    for (const shot of shots.slice(0, 4)) sbCells.push({ canvas: frame(shot.previz, 0.45, {}, 640, 360), label: `${title.slice(0, 6)} · ${shot.title}`.slice(0, 26) });
  }
  await save(`${prefix}-board`, sheet(sbCells, 4, 480, 270, '本地规则分镜'));
  // 竖屏 + 单张大图（看细节）
  const tall = SAMPLE_SHOTS.slice(0, 4).map((s) => ({ canvas: frame(s.spec, 0.45, {}, 540, 960), label: s.label }));
  await save(`${prefix}-vertical`, sheet(tall, 4, 360, 640, '竖屏'));
  await save(`${prefix}-closeup-1080`, frame(SAMPLE_SHOTS[0].spec, 0.45, {}, 1920, 1080));
  await save(`${prefix}-product-1080`, frame(SAMPLE_SHOTS[3].spec, 0.45, {}, 1920, 1080));
  // 复查用的混合样张：人物在自然里、产品中景（圆台）、夜景中景、讲话手势 + 本地分镜的头几个镜头
  const mixCells = [
    { canvas: frame({ setting: 'nature', timeOfDay: 'golden', palette: LOOK_PALETTES['film-warm'], subjects: [{ kind: 'person', x: 0.42, y: 0.8, color: '#8a6a4a', action: 'idle' }], camera: { shotSize: 'full', movement: 'static', angle: 'eye-level' }, light: { direction: 'left', key: 'warm', mood: 'soft' } }, 0.45, { label: '' }, 640, 360), label: '自然 · 人物全景' },
    { canvas: frame({ ...SAMPLE_SHOTS[3].spec, camera: { shotSize: 'medium', movement: 'static', angle: 'eye-level' } }, 0.45, { label: '' }, 640, 360), label: '产品 · 中景' },
    { canvas: frame({ ...SAMPLE_SHOTS[4].spec, camera: { shotSize: 'full', movement: 'static', angle: 'eye-level' } }, 0.45, { label: '' }, 640, 360), label: '夜景 · 全景' },
    { canvas: frame(SAMPLE_SHOTS[5].spec, 0.3, { label: '' }, 640, 360), label: '办公室 · 讲话' },
  ];
  for (const [ti, n] of [[0, 1], [1, 2], [2, 2]]) {
    const board = localStoryboard({ title: SAMPLE_TOPICS[ti], duration: 30 });
    for (const shot of ((board && board.shots) || []).slice(0, n)) mixCells.push({ canvas: frame(shot.previz, 0.45, {}, 640, 360), label: `${SAMPLE_TOPICS[ti].slice(0, 6)} · ${shot.title}`.slice(0, 22) });
  }
  await save(`${prefix}-mix`, sheet(mixCells, 3, 640, 360, '复查'));
  const a = frame(SAMPLE_SHOTS[1].spec, 0.37).toDataURL();
  const b = frame(SAMPLE_SHOTS[1].spec, 0.37).toDataURL();
  PH.log('info', `deterministic: ${a === b}`);
  // 1080p 单帧耗时（目标 <50ms）
  const c = canvas(1920, 1080);
  const g = c.getContext('2d');
  const res = [];
  for (const s of SAMPLE_SHOTS) {
    drawPreviz(g, s.spec, 0, 1920, 1080);
    g.getImageData(0, 0, 1, 1);
    const t0 = performance.now();
    for (let i = 0; i < 12; i += 1) { drawPreviz(g, s.spec, i / 12, 1920, 1080); g.getImageData(0, 0, 1, 1); }
    res.push(`${s.label.split(' · ')[0]}=${((performance.now() - t0) / 12).toFixed(1)}ms`);
  }
  PH.log('info', `perf 1920x1080: ${res.join(' ')}`);
  PH.done(true);
}

async function run() {
  const { prefix, mode } = await PH.config();
  if (mode === 'sample') {
    await runSample(prefix);
    return;
  }
  const settings = Object.keys(SUBJECT_FOR);
  const cw = 480;
  const ch = 270;

  // 1. 每个场景（中景）
  await save(`${prefix}-settings`, sheet(settings.map((s) => ({ canvas: frame(specFor(s, { camera: { shotSize: 'wide', movement: 'static', angle: 'eye-level' } }), 0.4, { label: '' }), label: s })), 3, cw, ch, '场景 · 远景'));
  // 2. 景别
  const sizes = ['wide', 'full', 'medium', 'close-up'];
  const sizeCells = [];
  for (const st of ['cafe', 'street', 'studio']) for (const sz of sizes) sizeCells.push({ canvas: frame(specFor(st), 0.4, { shotSize: sz }), label: `${st} · ${sz}` });
  await save(`${prefix}-shots`, sheet(sizeCells, 4, 400, 225, '景别'));
  // 3. 人物动作
  const actions = ['idle', 'walk-right', 'turn', 'raise', 'pour', 'talk', 'jump', 'walk-left'];
  const actCells = actions.map((a, i) => ({
    canvas: frame(specFor(i % 2 ? 'home' : 'studio', { subjects: [{ kind: 'person', x: 0.5, y: 0.62, color: ['#c8743a', '#3c5a7a', '#8a4a5a', '#44506a'][i % 4], action: a }], light: { direction: 'left', key: 'warm', mood: 'soft' } }), 0.35, { shotSize: 'full' }),
    label: a,
  }));
  await save(`${prefix}-actions`, sheet(actCells, 4, 400, 225, '人物动作 · 全景'));
  // 4. 物体特写
  const kinds = ['cup', 'product', 'phone', 'food', 'laptop', 'plant', 'box', 'car'];
  const objCells = kinds.map((k) => ({
    canvas: frame(specFor(k === 'car' ? 'street' : k === 'food' ? 'kitchen' : k === 'cup' ? 'cafe' : 'studio', { subjects: [{ kind: k, x: 0.5, y: 0.62, color: k === 'car' ? '#a03030' : '#d0a060', action: 'idle' }] }), 0.4, { shotSize: 'close-up' }),
    label: k,
  }));
  await save(`${prefix}-objects`, sheet(objCells, 4, 400, 225, '物体 · 近景'));
  // 5. 单张大图
  await save(`${prefix}-hero-cafe`, frame(specFor('cafe'), 0.5, { label: '第1镜 · 清晨咖啡馆' }));
  await save(`${prefix}-hero-street`, frame(specFor('street', { camera: { shotSize: 'full', movement: 'tracking', angle: 'eye-level' } }), 0.5));
  await save(`${prefix}-hero-cup`, frame(specFor('cafe', { subjects: [{ kind: 'cup', x: 0.5, y: 0.62, color: '#f2ece2' }] }), 0.5, { shotSize: 'close-up' }));

  // 确定性
  const a = frame(specFor('cafe'), 0.37).toDataURL();
  const b = frame(specFor('cafe'), 0.37).toDataURL();
  PH.log('info', `deterministic: ${a === b}`);

  // 性能：每个场景 20 帧（不同 progress）
  const c = canvas(W, H);
  const g = c.getContext('2d');
  const res = [];
  for (const s of settings) {
    const spec = specFor(s, { camera: { shotSize: 'medium', movement: 'push-in', angle: 'eye-level' } });
    drawPreviz(g, spec, 0, W, H);
    g.getImageData(0, 0, 1, 1);
    const t0 = performance.now();
    for (let i = 0; i < 20; i += 1) drawPreviz(g, spec, i / 20, W, H);
    g.getImageData(0, 0, 1, 1);
    res.push(`${s}=${((performance.now() - t0) / 20).toFixed(1)}ms`);
  }
  PH.log('info', `perf 1280x720: ${res.join(' ')}`);
  PH.done(true);
}

run().catch((e) => {
  PH.log('error', e && e.stack ? e.stack : String(e));
  PH.done(false);
});
