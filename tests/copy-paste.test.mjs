// 复制粘贴：粘贴出来的镜头要保留调色/特效/变速/定格，粘贴文字不能带 source 这类不该带的字段。
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {
  ff: { on: () => () => {}, flushed: () => {}, invoke: async (channel) => (channel === 'project:list' ? [] : { ok: true }) },
};

const { default: useStore } = await import('../src/ui/store.js');
const { copySelection, pasteAtPlayhead } = await import('../src/ui/modes/refine/timelineActions.js');
const { createProject, createAsset, createClip, createTextClip } = await import('../src/engine/model.js');
const { applyOps } = await import('../src/engine/ops.js');
const { buildFirstCut } = await import('../src/engine/firstcut.js');

const S = () => useStore.getState();
const ids = (...a) => ({ mode: 'ids', indices: [], ids: a });

function open() {
  const p = createProject({ name: '复制' });
  const v = createAsset({ id: 'v', kind: 'video', duration: 30 });
  p.assets = { v };
  p.tracks = {
    video: [{ ...createClip(v, { id: 'c1', in: 0, out: 6 }), color: { ...createClip(v).color, exposure: 0.5 }, speed: 2, fx: { ...createClip(v).fx, blur: 0.4 } }, createClip(v, { id: 'c2', in: 10, out: 14 })],
    text: [createTextClip({ id: 't1', start: 0, duration: 3, text: '文字', preset: 'title', size: 1.4 })],
    audio: [],
  };
  useStore.setState({ project: p, past: [], future: [], toasts: [], saveState: 'saved', playhead: 0, selection: { clipIds: [], textId: null, audioId: null, shotId: null, kind: null, id: null } });
  return p;
}

test('复制粘贴镜头：调色、特效、变速一起带过来，位置在播放头，选中新镜头，可撤销', () => {
  open();
  S().select(['c1']);
  assert.equal(copySelection(), true);
  assert.equal(pasteAtPlayhead(), true);
  const p = S().project;
  assert.equal(p.tracks.video.length, 3);
  const added = p.tracks.video.find((c) => c.id !== 'c1' && c.id !== 'c2');
  assert.notEqual(added.id, 'c1');
  assert.equal(added.assetId, 'v');
  assert.equal(added.speed, 2);
  assert.equal(added.color.exposure, 0.5);
  assert.equal(added.fx.blur, 0.4);
  assert.deepEqual(S().selection.clipIds, [added.id]);
  S().undo();
  assert.equal(S().project.tracks.video.length, 2);
});

test('复制粘贴定格镜头：不再报「出点必须晚于入点」，定格时长保留', () => {
  open();
  const fz = applyOps(S().project, [{ type: 'freezeFrame', at: 2, duration: 2 }], { playhead: 2 });
  assert.ok(fz.ok, fz.errors.join());
  useStore.setState({ project: fz.project, past: [], future: [] });
  const still = fz.project.tracks.video.find((c) => c.still);
  assert.ok(still);
  S().select([still.id]);
  assert.equal(copySelection(), true);
  assert.equal(pasteAtPlayhead(), true);
  const added = S().project.tracks.video.filter((c) => c.still && c.id !== still.id);
  assert.equal(added.length, 1);
  assert.equal(added[0].duration, 2);
  assert.equal(added[0].in, added[0].out);
});

test('复制粘贴初剪的镜头文案字幕：只带内容和样式，不带 source / linkShotId', () => {
  const p = createProject({ name: '复制字幕' });
  p.assets = { v: createAsset({ id: 'v', kind: 'video', duration: 30 }) };
  p.storyboard = [{ id: 's1', title: '开场', caption: '第一句文案', duration: 3, assetId: 'v' }];
  const fc = buildFirstCut(p);
  useStore.setState({ project: fc.project, past: [], future: [], toasts: [], playhead: 1, saveState: 'saved', selection: { clipIds: [], textId: null, audioId: null, shotId: null, kind: null, id: null } });
  const cap = fc.project.tracks.text.find((t) => t.source === 'shot-caption');
  assert.ok(cap, '初剪应该生成了镜头文案字幕');
  S().selectText(cap.id);
  assert.equal(copySelection(), true);
  S().setPlayhead(5);
  assert.equal(pasteAtPlayhead(), true);
  const pasted = S().project.tracks.text.find((t) => t.start === 5);
  assert.ok(pasted, '粘贴出来的文字应该从播放头开始');
  assert.equal(pasted.text, cap.text);
  assert.equal(pasted.source, undefined);
  assert.equal(pasted.linkShotId, undefined);
  assert.equal(pasted.group, null);
  assert.equal(S().selection.textId, pasted.id);
});

test('素材不在当前工程时粘贴：只贴能用的，并提示', () => {
  open();
  S().select(['c1']);
  copySelection();
  // 换成另一个工程（没有素材 v）
  const other = createProject({ name: '别的' });
  useStore.setState({ project: other, past: [], future: [], toasts: [] });
  assert.equal(pasteAtPlayhead(), false);
  assert.ok(S().toasts.some((t) => /不在这个项目里/.test(t.text || t.message || '')));
  assert.equal(S().project.tracks.video.length, 0);
});
