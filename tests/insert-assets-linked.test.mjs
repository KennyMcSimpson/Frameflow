// 素材箱拖入 / 点击加入时间线必须走引擎：后面镜头的字幕、跟随镜头的音频要一起顺移，
// 轨道锁和上限也要生效（以前是手工拼数组，绕过了联动）。
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {
  ff: { on: () => () => {}, flushed: () => {}, invoke: async (channel) => (channel === 'project:list' ? [] : { ok: true }) },
};

const { default: useStore } = await import('../src/ui/store.js');
const { insertAssets } = await import('../src/ui/assetActions.js');
const { createProject, createAsset, createClip, createTextClip, createAudioClip } = await import('../src/engine/model.js');
const { layoutVideo } = await import('../src/engine/timeline.js');
const { applyOps } = await import('../src/engine/ops.js');

const S = () => useStore.getState();
const span = (p, id) => { const it = layoutVideo(p).find((x) => x.clip.id === id); return [it.start, it.end]; };

function open() {
  const p = createProject({ name: 'T' });
  const v = createAsset({ id: 'v', kind: 'video', duration: 30, hasAudio: true });
  p.assets = { v };
  p.tracks = {
    video: [createClip(v, { id: 'c1', in: 0, out: 6 }), createClip(v, { id: 'c2', in: 10, out: 14 })],
    text: [createTextClip({ id: 't2', start: 6, duration: 4, text: '镜2字幕', linkShotId: 'c2' })],
    audio: [{ ...createAudioClip(v, { start: 6, in: 10, out: 14 }), id: 'au2', linkClipId: 'c2' }],
  };
  useStore.setState({ project: p, past: [], future: [], toasts: [], saveState: 'saved' });
  return p;
}

test('插到两个镜头之间：后一镜的字幕和关联音频跟着顺移，新镜头被选中，一步可撤销', () => {
  open();
  const w = createAsset({ id: 'w', kind: 'video', duration: 30 });
  assert.equal(insertAssets([w], 2, '插入'), true);
  const p = S().project;
  assert.deepEqual(p.tracks.video.map((c) => c.assetId), ['v', 'w', 'v']);
  const added = p.tracks.video[1];
  const len = added.out - added.in;
  assert.ok(len > 0);
  assert.deepEqual(span(p, 'c2'), [6 + len, 10 + len]);
  assert.equal(p.tracks.text[0].start, 6 + len, '字幕跟着镜头走');
  assert.equal(p.tracks.audio[0].start, 6 + len, '关联音频跟着镜头走');
  assert.ok(p.assets.w, '素材进了素材箱');
  assert.deepEqual(S().selection.clipIds, [added.id]);
  assert.equal(S().past.length, 1);
  S().undo();
  assert.equal(S().project.tracks.text[0].start, 6);
  assert.equal(S().project.tracks.video.length, 2);
});

test('多个素材按顺序插入；音频素材进音频轨；不给位置时放末尾', () => {
  open();
  const a = createAsset({ id: 'a', kind: 'image', duration: 0 });
  const b = createAsset({ id: 'b', kind: 'video', duration: 3 });
  const m = createAsset({ id: 'm', kind: 'audio', duration: 2000 });
  assert.equal(insertAssets([a, m, b], 1), true);
  let p = S().project;
  assert.deepEqual(p.tracks.video.map((c) => c.assetId), ['a', 'b', 'v', 'v']);
  const music = p.tracks.audio.find((x) => x.assetId === 'm');
  assert.ok(music && music.out - music.in <= 600, '长音乐自动裁到项目上限内');

  open();
  assert.equal(insertAssets([b]), true);
  p = S().project;
  assert.equal(p.tracks.video[2].assetId, 'b');
  assert.equal(p.tracks.text[0].start, 6, '放末尾不影响前面的字幕');
});

test('主轨锁定时不能插入：提示原因，工程不变', () => {
  const p0 = open();
  const lk = applyOps(p0, [{ type: 'setTrack', track: 'video', patch: { locked: true } }], {});
  assert.equal(lk.ok, true);
  useStore.setState({ project: lk.project, past: [], future: [], toasts: [] });
  const w = createAsset({ id: 'w', kind: 'video', duration: 30 });
  assert.equal(insertAssets([w], 1), false);
  assert.equal(S().project, lk.project);
  assert.ok(S().toasts.some((t) => /锁定/.test(t.text || t.message || '')), '要告诉用户为什么没加上');
});
