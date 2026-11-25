// 合成器回归：贴纸大小 / 颜色 / 控制框共用尺寸、示意画面来源判断、取不到画面时的占位策略。
// 用记录调用的假画布上下文驱动 renderFrame，不需要浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFrame, STICKER_BASE, stickerSize, stickerGlyph, isPrevizSource } from '../src/render/compositor.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} 期望 ${b}，实际 ${a}`);

/** 记录调用的假 2D 上下文：未列出的方法一律记录后忽略；measureText 由测试给出字形墨迹盒 */
function fakeCtx(width, height, log, ink) {
  const props = {
    canvas: { width, height },
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none', font: '10px sans-serif',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, textAlign: 'start', textBaseline: 'alphabetic',
    shadowBlur: 0, shadowColor: 'transparent', shadowOffsetX: 0, shadowOffsetY: 0,
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low', lineCap: 'butt', lineJoin: 'miter',
  };
  const special = {
    measureText: (s) => ({ width: String(s).length * 10, ...(ink || {}) }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createConicGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({ setTransform() {} }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }),
  };
  return new Proxy(props, {
    get(t, k) {
      if (k in t) return t[k];
      if (k in special) return special[k];
      if (typeof k === 'symbol') return undefined;
      return (...args) => {
        log.push({ op: k, args, fillStyle: t.fillStyle, font: t.font, shadowBlur: t.shadowBlur, globalAlpha: t.globalAlpha });
      };
    },
    set(t, k, v) { t[k] = v; return true; },
    has() { return true; },
  });
}

// 工作画布（转场 / 调色用）同样用假上下文
const surfaceLog = [];
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; this.ctx = null; }
  getContext() { if (!this.ctx) this.ctx = fakeCtx(this.width, this.height, surfaceLog); return this.ctx; }
};

function stickerProject(glyph, overlay, assetExtra) {
  const asset = { id: 's1', kind: 'sticker', name: `贴纸 ${glyph}`, glyph, ...assetExtra };
  return {
    asset,
    project: {
      assets: { s1: asset },
      tracks: { video: [], audio: [], text: [] },
      overlays: [{ id: 'o1', kind: 'sticker', assetId: 's1', start: 0, in: 0, out: 3, track: 1, ...overlay }],
      settings: { fps: 30 },
    },
  };
}
const texts = (log) => log.filter((c) => c.op === 'fillText');

test('贴纸：基准大小常量与字形解析', () => {
  assert.equal(STICKER_BASE, 0.22);
  assert.equal(stickerGlyph({ glyph: '❤' }), '❤');
  assert.equal(stickerGlyph({ name: '贴纸 🎉' }), '🎉');
  assert.equal(stickerGlyph(null), '★');
});

test('贴纸：scale=1 时墨迹长边 = 画面短边 × 22%，颜色用 o.color，墨迹中心对准控制框中心', () => {
  const log = [];
  // 墨迹盒：左右各 30、上 90 下 10 → 宽 60 高 100
  const ctx = fakeCtx(1920, 1080, log, { actualBoundingBoxLeft: 30, actualBoundingBoxRight: 30, actualBoundingBoxAscent: 90, actualBoundingBoxDescent: 10 });
  const { project, asset } = stickerProject('▲', { transform: { scale: 1, x: 0.1, y: -0.2 }, color: '#ff3366' });
  renderFrame(ctx, project, 1, null, { width: 1920, height: 1080 });
  const k = (1080 * STICKER_BASE) / 100;
  const sc = log.find((c) => c.op === 'scale');
  assert.ok(sc, '贴纸按墨迹盒缩放');
  near(sc.args[0], k); near(sc.args[1], k);
  const tr = log.find((c) => c.op === 'translate');
  near(tr.args[0], 1920 / 2 + 0.1 * 1920); near(tr.args[1], 1080 / 2 - 0.2 * 1080);
  const [ft] = texts(log);
  assert.equal(ft.args[0], '▲');
  assert.equal(ft.fillStyle, '#ff3366', '形状贴纸用 o.color 上色');
  near(ft.args[1], 0, '水平居中');
  near(ft.args[2], 40, '基线下移，使墨迹中心落在变换中心');
  // 控制框（TransformOverlay 用 stickerSize）与画面上的墨迹一样大
  const box = stickerSize(asset, 1920, 1080);
  near(box.w, 60 * k); near(box.h, 100 * k);
  near(Math.max(box.w, box.h), 1080 * STICKER_BASE);
});

test('贴纸：缩放、默认白色、透明度为 0 时不画', () => {
  const ink = { actualBoundingBoxLeft: 50, actualBoundingBoxRight: 50, actualBoundingBoxAscent: 80, actualBoundingBoxDescent: 20 };
  const log = [];
  const { project } = stickerProject('●', { transform: { scale: 0.5 } });
  renderFrame(fakeCtx(1280, 720, log, ink), project, 0.5, null, { width: 1280, height: 720 });
  const sc = log.find((c) => c.op === 'scale');
  near(sc.args[0], (720 * STICKER_BASE * 0.5) / 100, 'scale 0.5 时为基准的一半');
  assert.equal(texts(log)[0].fillStyle, '#ffffff', '没设颜色时为白色');

  const log2 = [];
  const p2 = stickerProject('◆', { opacity: 0 }).project;
  renderFrame(fakeCtx(1280, 720, log2, ink), p2, 0.5, null, { width: 1280, height: 720 });
  assert.equal(texts(log2).length, 0);
});

test('贴纸：竖屏按短边计算，量不到字形时按方块处理', () => {
  // 没有测量能力（导出前 / 无画布环境）：按字号方块，长宽都等于 短边×22%
  const s = stickerSize({ kind: 'sticker', glyph: '☆' }, 1080, 1920);
  near(s.w, 1080 * STICKER_BASE); near(s.h, 1080 * STICKER_BASE);
});

test('示意画面来源：兼容旧字符串和新对象两种写法', () => {
  assert.equal(isPrevizSource({ source: 'previz' }), true);
  assert.equal(isPrevizSource({ source: { kind: 'previz' } }), true);
  assert.equal(isPrevizSource({ source: { type: 'previz', id: 'x' } }), true);
  assert.equal(isPrevizSource({ source: { kind: 'import', path: 'a.mp4' } }), false);
  assert.equal(isPrevizSource({ source: 'import' }), false);
  assert.equal(isPrevizSource({}), false);
  assert.equal(isPrevizSource(null), false);
});

function videoProject(assetExtra) {
  const asset = { id: 'v1', kind: 'video', name: '海边.mp4', path: 'C:/m/sea.mp4', width: 1920, height: 1080, duration: 10, ...assetExtra };
  return {
    assets: { v1: asset },
    tracks: { video: [{ id: 'c1', assetId: 'v1', in: 0, out: 10 }], audio: [], text: [] },
    overlays: [],
    settings: { fps: 30 },
  };
}
/** 渲染一帧并返回工作画布上出现过的文字 */
function waitTexts(project, wait, mode = 'preview') {
  surfaceLog.length = 0;
  const pool = { getFrame: () => null, waitInfo: () => wait };
  renderFrame(fakeCtx(640, 360, []), project, 1, pool, { width: 640, height: 360, mode });
  return texts(surfaceLog).map((c) => String(c.args[0]));
}

test('取不到画面：出过画面（只是 seek 慢）或刚开始加载不到 400ms，预览不闪「加载中」', () => {
  const p = videoProject();
  assert.deepEqual(waitTexts(p, { framed: true, waitMs: 5000, error: null }), [], '出过画面只是在 seek');
  assert.deepEqual(waitTexts(p, { framed: false, waitMs: 120, error: null }), [], '刚开始加载');
  assert.ok(waitTexts(p, { framed: false, waitMs: 800, error: null }).includes('素材加载中…'), '等太久才提示加载中');
  assert.ok(waitTexts(p, { framed: true, waitMs: 0, error: null }, 'export').includes('素材加载中…'), '导出照旧画占位');
});

test('取不到画面：离线和读取出错给出原因和下一步', () => {
  const offline = waitTexts(videoProject({ offline: true }), { framed: false, waitMs: 0, error: null });
  assert.ok(offline.includes('素材离线'));
  assert.ok(offline.some((s) => s.includes('重新链接')), '告诉用户下一步');
  const broken = waitTexts(videoProject(), { framed: false, waitMs: 0, error: '解码失败（文件可能已损坏）' });
  assert.ok(broken.includes('素材无法读取'));
  assert.ok(broken.some((s) => s.includes('解码失败')));
});
