// 媒体池（预览取帧）回归：seek 期间沿用旧帧、只追最新目标、1 秒看门狗、等待信息、时钟靠拢、倒退预热。
// 用最小的假 DOM（video / canvas / div）驱动 createMediaPool，不启动浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaPool, slewToClock } from '../src/render/mediaPool.js';

const FPS = 30;
/** 与 mediaPool 的 frameTarget 相同：对准源视频帧中点 */
const frameMid = (t) => (Math.floor(t * FPS + 1e-4) + 0.5) / FPS;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} 期望 ${b}，实际 ${a}`);

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.listeners = {};
    this.style = {};
    this.attrs = {};
    this.children = [];
    this.readyState = 0;
    this.seeking = false;
    this.paused = true;
    this.muted = false;
    this.volume = 1;
    this.playbackRate = 1;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.duration = NaN;
    this.error = null;
    this._t = 0;
    this.seeks = [];
    this.draws = 0;
  }
  addEventListener(type, fn, opts) { (this.listeners[type] ||= []).push({ fn, once: !!(opts && opts.once) }); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((l) => l.fn !== fn); }
  emit(type) {
    const list = (this.listeners[type] || []).slice();
    this.listeners[type] = list.filter((l) => !l.once);
    for (const l of list) l.fn();
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
  remove() {}
  load() {}
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  get currentTime() { return this._t; }
  // 浏览器里赋值 currentTime 会进入 seek：readyState 掉到 1，drawImage 画不出东西
  set currentTime(v) { this.seeks.push(v); this._t = v; this.seeking = true; this.readyState = 1; }
  getContext() { return { drawImage: () => { this.draws += 1; } }; }
  // ---- 测试辅助 ----
  loadMeta(duration = 10) { this.readyState = 1; this.duration = duration; this.emit('loadedmetadata'); }
  finishSeek(w = 1920, h = 1080) { this.seeking = false; this.readyState = 4; this.videoWidth = w; this.videoHeight = h; this.emit('seeked'); }
}

function installDom() {
  const created = [];
  const body = new FakeEl('body');
  globalThis.document = {
    body,
    documentElement: body,
    createElement(tag) { const e = new FakeEl(tag); created.push(e); return e; },
  };
  return {
    created,
    videos: () => created.filter((e) => e.tagName === 'video'),
    canvases: () => created.filter((e) => e.tagName === 'canvas'),
    videoOf: (path) => created.find((e) => e.tagName === 'video' && e.src === path),
  };
}
function removeDom() { delete globalThis.document; }

function videoAsset(id, extra) {
  return { id, kind: 'video', path: `C:/media/${id}.mp4`, fps: FPS, duration: 10, ...extra };
}
function projectOf(clips, assets) {
  return { assets, tracks: { video: clips, audio: [], text: [] }, overlays: [], settings: { fps: FPS } };
}

test('媒体池：seek 途中 getFrame 返回旧帧画布，而不是 null（倒放不再闪「素材加载中」）', (t) => {
  const dom = installDom();
  t.after(removeDom);
  const pool = createMediaPool({ mediaUrl: (p) => p });
  const asset = videoAsset('a1');
  const project = projectOf([{ id: 'c1', assetId: 'a1', in: 0, out: 10 }], { a1: asset });

  pool.sync(project, 5, undefined, { playing: false });
  const el = dom.videos()[0];
  assert.ok(el, '应创建视频元素');
  assert.equal(el.seeks.length, 0, '元数据未就绪时先记下目标，不直接 seek');
  el.loadMeta();
  assert.equal(el.seeks.length, 1);
  near(el.seeks[0], frameMid(5), '元数据就绪后 seek 到目标帧中点');
  el.finishSeek();
  assert.equal(pool.getFrame(asset, 5), el, '停稳后直接用视频元素');
  assert.equal(dom.canvases().length, 1, 'seeked 时存下一张旧帧画布');

  // 倒放一步：元素进入 seek，画不出东西
  pool.sync(project, 4.9, undefined, { direction: -1 });
  assert.equal(el.seeking, true);
  const f = pool.getFrame(asset, 4.9);
  assert.ok(f, 'seek 中不能返回 null');
  assert.equal(f.tagName, 'canvas', 'seek 中返回旧帧画布');

  // 离旧帧太远（> 0.5 秒）且不是这个元素正在追的目标：不串画面
  assert.equal(pool.getFrame(asset, 8), null);
  pool.dispose();
});

test('媒体池：连续 seek 只追最新目标（中间目标全部丢弃）', (t) => {
  const dom = installDom();
  t.after(removeDom);
  const pool = createMediaPool({ mediaUrl: (p) => p });
  const asset = videoAsset('a1');
  const project = projectOf([{ id: 'c1', assetId: 'a1', in: 0, out: 10 }], { a1: asset });
  pool.sync(project, 5, undefined, {});
  const el = dom.videos()[0];
  el.loadMeta();
  el.finishSeek();

  pool.sync(project, 4.9, undefined, { direction: -1 });
  const issued = el.seeks.length;
  for (const tt of [4.8, 4.7, 4.6, 4.5]) pool.sync(project, tt, undefined, { direction: -1 });
  assert.equal(el.seeks.length, issued, 'seek 途中不追加新的 seek');
  el.finishSeek();
  assert.equal(el.seeks.length, issued + 1, 'seeked 后只补发一次');
  near(el.seeks.at(-1), frameMid(4.5), '补发的是最后一个目标');
  el.finishSeek();
  assert.equal(el.seeks.length, issued + 1, '目标已追上，不再 seek');
  pool.dispose();
});

test('媒体池：1 秒收不到 seeked 时看门狗用最新目标重发，最多连续 3 次', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = installDom();
  t.after(removeDom);
  const pool = createMediaPool({ mediaUrl: (p) => p });
  const asset = videoAsset('a1');
  const project = projectOf([{ id: 'c1', assetId: 'a1', in: 0, out: 10 }], { a1: asset });
  pool.sync(project, 5, undefined, {});
  const el = dom.videos()[0];
  el.loadMeta();
  assert.equal(el.seeks.length, 1);

  // seeked 事件丢失：元素一直停在 seeking；期间用户又往回走了
  pool.sync(project, 4, undefined, { direction: -1 });
  assert.equal(el.seeks.length, 1);
  t.mock.timers.tick(999);
  assert.equal(el.seeks.length, 1, '不到 1 秒不重发');
  t.mock.timers.tick(1);
  assert.equal(el.seeks.length, 2, '1 秒后重发');
  near(el.seeks.at(-1), frameMid(4), '重发的是最新目标');

  // 继续丢：按当前目标再试，连续 3 次后放弃（坏文件不会无限重试）
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  assert.equal(el.seeks.length, 4);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  assert.equal(el.seeks.length, 4, '连续 3 次后不再重试');

  // 正常 seeked 会清掉看门狗与重试计数
  el.finishSeek();
  pool.sync(project, 3, undefined, { direction: -1 });
  assert.equal(el.seeks.length, 5);
  el.finishSeek();
  t.mock.timers.tick(5000);
  assert.equal(el.seeks.length, 5, 'seek 正常完成后看门狗不再动作');
  pool.dispose();
});

test('媒体池：seeked 丢了但元素已停下时，看门狗补存一帧并通知重画', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = installDom();
  t.after(removeDom);
  const pool = createMediaPool({ mediaUrl: (p) => p });
  const asset = videoAsset('a1');
  const project = projectOf([{ id: 'c1', assetId: 'a1', in: 0, out: 10 }], { a1: asset });
  let redraws = 0;
  pool.onFrameReady(() => { redraws += 1; });
  pool.sync(project, 2, undefined, {});
  const el = dom.videos()[0];
  el.loadMeta();
  // 元素其实已经到位，只是 seeked 事件没来
  el.seeking = false;
  el.readyState = 4;
  el.videoWidth = 1280;
  el.videoHeight = 720;
  t.mock.timers.tick(1000);
  assert.equal(el.seeks.length, 1, '没有新目标时不重发');
  t.mock.timers.tick(20);
  assert.ok(redraws >= 1, '通知界面重画');
  assert.equal(pool.waitInfo(asset).framed, true, '补存了这一帧');
  pool.dispose();
});

test('媒体池：waitInfo 报告素材是否出过画面、等了多久、读取错误', (t) => {
  const dom = installDom();
  t.after(removeDom);
  const pool = createMediaPool({ mediaUrl: (p) => p });
  const asset = videoAsset('a1');
  assert.deepEqual(pool.waitInfo(asset), { framed: false, waitMs: 0, error: null }, '还没开始加载');
  assert.equal(pool.getFrame(asset, 1), null, '首次取帧开始加载');
  const w1 = pool.waitInfo(asset);
  assert.equal(w1.framed, false);
  assert.ok(w1.waitMs >= 0 && w1.waitMs < 5000);
  const el = dom.videos()[0];
  el.readyState = 4;
  el.videoWidth = 640;
  el.videoHeight = 360;
  el.emit('loadeddata');
  assert.equal(pool.waitInfo(asset).framed, true, '首帧解码后 framed=true');

  const bad = videoAsset('bad');
  pool.getFrame(bad, 0);
  const badEl = dom.videoOf(bad.path);
  badEl.error = { code: 4 };
  badEl.emit('error');
  assert.equal(pool.waitInfo(bad).error, '格式不受支持或文件不存在');
  assert.equal(pool.getFrame(bad, 0), null);
  pool.dispose();
});

test('媒体池：导出用的媒体池（useProxy:false）不存旧帧', (t) => {
  const dom = installDom();
  t.after(removeDom);
  const pool = createMediaPool({ mediaUrl: (p) => p, useProxy: false });
  const asset = videoAsset('a1');
  const project = projectOf([{ id: 'c1', assetId: 'a1', in: 0, out: 10 }], { a1: asset });
  pool.sync(project, 1, undefined, {});
  const el = dom.videos()[0];
  el.loadMeta();
  el.finishSeek();
  assert.equal(dom.canvases().length, 0, '导出不分配旧帧画布');
  assert.equal(pool.waitInfo(asset).framed, true);
  pool.dispose();
});

test('媒体池：倒退时预热上一片段的出点，正放时预热下一片段的入点', (t) => {
  const dom = installDom();
  t.after(removeDom);
  const pool = createMediaPool({ mediaUrl: (p) => p });
  const a = videoAsset('a');
  const b = videoAsset('b');
  const project = projectOf([
    { id: 'c1', assetId: 'a', in: 0, out: 4 },
    { id: 'c2', assetId: 'b', in: 0, out: 4 },
  ], { a, b });

  pool.sync(project, 4.5, undefined, { direction: -1 });
  const prevEl = dom.videoOf(a.path);
  assert.ok(prevEl, '倒退进入第二段开头时预热第一段');
  prevEl.loadMeta();
  near(prevEl.seeks[0], frameMid(4 - 0.5 / FPS), '停在上一段的最后一帧');

  const pool2 = createMediaPool({ mediaUrl: (p) => p });
  const before = dom.videos().length;
  pool2.sync(project, 3, undefined, { playing: false, direction: 1 });
  const fresh = dom.videos().slice(before);
  const nextEl = fresh.find((e) => e.src === b.path);
  assert.ok(nextEl, '正放接近片尾时预热下一段');
  nextEl.loadMeta();
  near(nextEl.seeks[0], frameMid(0), '停在下一段的入点');
  pool.dispose();
  pool2.dispose();
});

test('媒体池：clockTime 只在主视频平稳播放时给出实际进度', (t) => {
  const dom = installDom();
  t.after(removeDom);
  const pool = createMediaPool({ mediaUrl: (p) => p });
  const asset = videoAsset('a1');
  const project = projectOf([{ id: 'c1', assetId: 'a1', in: 0, out: 10 }], { a1: asset });
  pool.sync(project, 5, undefined, {});
  const el = dom.videos()[0];
  el.loadMeta();
  el.finishSeek();
  assert.equal(pool.clockTime(), null, '暂停时没有时钟');
  el._t = 5;
  pool.sync(project, 5, undefined, { playing: true });
  assert.equal(el.paused, false, '播放时视频自己走');
  el._t = 5.1;
  near(pool.clockTime(), 5.1, '时钟 = 视频实际进度换算到时间线');
  el.seeking = true;
  assert.equal(pool.clockTime(), null, 'seek 中不给时钟');
  pool.dispose();
});

test('slewToClock：每帧最多修正半步，差距过小或过大都不动', () => {
  assert.equal(slewToClock(1, null, 0.016), 1);
  assert.equal(slewToClock(1, NaN, 0.016), 1);
  assert.equal(slewToClock(1, 1.003, 0.016), 1, '差 3ms 不修正');
  assert.equal(slewToClock(1, 1.8, 0.016), 1, '差 0.8 秒多半是切片段，交给漂移纠正');
  near(slewToClock(1, 1.1, 0.016), 1.008, '落后时最多追半步');
  near(slewToClock(1, 0.9, 0.016), 0.992, '超前时最多退半步（总体仍向前）');
  near(slewToClock(1, 1.004 + 0.002, 0.016), 1.006, '差距小于半步时直接对齐');
  assert.equal(slewToClock(1, 1.1, 0), 1, '没有前进就不修正');
});
