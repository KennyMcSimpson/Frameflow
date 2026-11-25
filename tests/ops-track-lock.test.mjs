// 契约 C15：轨道头锁住之后，这条轨道上的内容任何操作都不能改。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../src/engine/ops.js';
import { createProject, createAsset, createClip, createTextClip, createAudioClip } from '../src/engine/model.js';

const none = { mode: 'none', indices: [], ids: [] };
const ids = (...a) => ({ mode: 'ids', indices: [], ids: a });
const ctx0 = { selectedClipIds: [], range: null, playhead: 3 };

function proj() {
  const p = createProject({ name: '锁' });
  const v = createAsset({ id: 'v', kind: 'video', duration: 30, hasAudio: true });
  const m = createAsset({ id: 'm', kind: 'audio', duration: 60 });
  p.assets = { v, m };
  p.tracks = {
    video: [createClip(v, { id: 'c1', in: 0, out: 6 }), createClip(v, { id: 'c2', in: 10, out: 14 })],
    text: [createTextClip({ id: 't1', start: 0, duration: 3, text: '字', linkShotId: 'c1' }), { ...createTextClip({ text: '字幕', start: 4, duration: 2 }), id: 'cap1', group: 'caption' }],
    audio: [createAudioClip(m, { id: 'a1', start: 0, in: 0, out: 6 })],
  };
  return p;
}
const lock = (p, kind, patch = { locked: true }) => {
  const r = applyOps(p, [{ type: 'setTrack', track: kind, patch }]);
  assert.ok(r.ok, r.errors.join());
  return r.project;
};
const run = (p, ops, ctx = ctx0) => applyOps(p, ops, ctx);

test('主轨锁定后：所有改主轨的操作都被拒绝，且提示告诉用户去轨道头解锁', () => {
  const L = lock(proj(), 'video');
  const tries = {
    delete: [{ type: 'delete', target: ids('c1') }],
    split: [{ type: 'split', target: ids('c1'), at: 3 }],
    move: [{ type: 'move', target: ids('c2'), toIndex: 1 }],
    setSpeed: [{ type: 'setSpeed', target: ids('c1'), speed: 2 }],
    duplicate: [{ type: 'duplicate', target: ids('c1') }],
    setDuration: [{ type: 'setDuration', target: ids('c1'), duration: 2 }],
    lockClip: [{ type: 'lock', target: ids('c1') }],
    rippleDelete: [{ type: 'rippleDelete', ids: ['c1'] }],
    trimLeft: [{ type: 'trimLeft', at: 3 }],
    trimRight: [{ type: 'trimRight', at: 3 }],
    roll: [{ type: 'roll', at: 6 }],
    slip: [{ type: 'slip', ids: ['c1'], delta: 1 }],
    slide: [{ type: 'slide', ids: ['c1'], delta: 1 }],
    freezeFrame: [{ type: 'freezeFrame', at: 3, duration: 2 }],
    setClipProps: [{ type: 'setClipProps', ids: ['c1'], patch: { speed: 1.5 } }],
    setSpeedCurve: [{ type: 'setSpeedCurve', ids: ['c1'], preset: 'hero' }],
    setKeyframe: [{ type: 'setKeyframe', target: 'clip', id: 'c1', path: 'opacity', t: 1, v: 0.5 }],
    pasteAttributes: [{ type: 'pasteAttributes', from: 'c1', toIds: ['c2'], keys: ['color'] }],
    detachAudio: [{ type: 'detachAudio', ids: ['c1'], id: 'c1' }],
    setTransitionAll: [{ type: 'setTransitionAll', transitionType: 'crossfade', transitionDuration: 0.5 }],
    insertAsset: [{ type: 'insertAsset', assetId: 'v', atIndex: 1 }],
    snapCutsToBeats: [{ type: 'snapCutsToBeats' }],
  };
  for (const [name, ops] of Object.entries(tries)) {
    const r = run(L, ops);
    assert.equal(r.ok, false, `${name} 应该被拒绝`);
    assert.match(r.errors.join(), /主轨已锁定/, `${name} 的提示要说清是主轨锁定`);
  }
  // 解锁本身、项目设置、标记不受影响
  assert.ok(run(L, [{ type: 'setTrack', track: 'video', patch: { locked: false } }]).ok);
  assert.ok(run(L, [{ type: 'setProject', settings: { aspect: '9:16' } }]).ok);
  assert.ok(run(L, [{ type: 'addMarker', t: 1, label: 'x' }]).ok);
});

test('文字轨锁定后：文字与字幕操作都被拒绝；主轨操作正常', () => {
  const L = lock(proj(), 'text');
  const bad = [
    [{ type: 'addText', target: none, text: { text: '新字' } }],
    [{ type: 'updateText', target: none, textId: 't1', text: { text: '改' } }],
    [{ type: 'removeText', target: none, textId: 't1' }],
    [{ type: 'addCaptions', segments: [{ start: 0, end: 1, text: '啊' }] }],
    [{ type: 'updateCaptionStyle', patch: { size: 1.2 } }],
    [{ type: 'clearCaptions' }],
  ];
  for (const ops of bad) {
    const r = run(L, ops);
    assert.equal(r.ok, false, JSON.stringify(ops));
    assert.match(r.errors.join(), /文字轨已锁定/);
  }
  assert.ok(run(L, [{ type: 'setSpeed', target: ids('c1'), speed: 2 }]).ok);
});

test('音频轨锁定后：音频操作与音量的关键帧被拒绝', () => {
  const L = lock(proj(), 'audio');
  const bad = [
    [{ type: 'addAudio', audio: { assetId: 'm', start: 0, out: 5 } }],
    [{ type: 'updateAudio', target: none, audioId: 'a1', audio: { volume: 0.5 } }],
    [{ type: 'removeAudio', target: none, audioId: 'a1' }],
    [{ type: 'autoDuck', amount: 0.3 }],
    [{ type: 'detachAudio', ids: ['c1'], id: 'c1' }],
    [{ type: 'setKeyframe', target: 'audio', id: 'a1', path: 'volume', t: 1, v: 0.5 }],
  ];
  for (const ops of bad) {
    const r = run(L, ops);
    assert.equal(r.ok, false, JSON.stringify(ops));
    assert.match(r.errors.join(), /音频轨已锁定/);
  }
  assert.ok(run(L, [{ type: 'setKeyframe', target: 'clip', id: 'c1', path: 'opacity', t: 1, v: 0.5 }]).ok);
});

test('画中画轨锁定后：增删改都被拒绝，也不能把画中画挪进锁着的轨', () => {
  const p = proj();
  const added = run(p, [{ type: 'addOverlay', assetId: 'v', start: 0, track: 2 }]);
  assert.ok(added.ok, added.errors.join());
  const ov = added.project.overlays[0];
  const L = lock(added.project, 'overlay:2');
  assert.equal(run(L, [{ type: 'updateOverlay', id: ov.id, patch: { opacity: 0.5 } }]).ok, false);
  assert.equal(run(L, [{ type: 'removeOverlay', id: ov.id }]).ok, false);
  assert.equal(run(L, [{ type: 'setKeyframe', target: 'overlay', id: ov.id, path: 'opacity', t: 0.5, v: 0.5 }]).ok, false);

  // 1 轨没锁，但把画中画从 1 轨挪到 2 轨要被拒绝
  const p2 = proj();
  const a2 = run(p2, [{ type: 'addOverlay', assetId: 'v', start: 0, track: 1 }]);
  const L2 = lock(a2.project, 'overlay:2');
  const o2 = L2.overlays[0];
  const mv = run(L2, [{ type: 'updateOverlay', id: o2.id, patch: { track: 2 } }]);
  assert.equal(mv.ok, false);
  assert.match(mv.errors.join(), /画中画 2 轨已锁定/);
  assert.ok(run(L2, [{ type: 'updateOverlay', id: o2.id, patch: { opacity: 0.5 } }]).ok);
});

test('一次操作里有一条被锁拒绝：整批都不生效（原子）', () => {
  const L = lock(proj(), 'text');
  const r = run(L, [{ type: 'setSpeed', target: ids('c1'), speed: 2 }, { type: 'addText', target: none, text: { text: 'x' } }]);
  assert.equal(r.ok, false);
  assert.equal(r.project, L);
});
