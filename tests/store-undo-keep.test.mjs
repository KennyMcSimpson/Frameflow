// 撤销/重做只还原「剪辑」本身：AI 对话、项目名、风格指南、素材离线标记、AI 视频任务进度
// 这些由 update() 写入、不进历史的数据不能被整份快照带回旧值（撤销后再编辑一步就永久丢失）。
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {
  ff: {
    on: () => () => {},
    flushed: () => {},
    invoke: async (channel) => (channel === 'project:list' ? [] : { ok: true }),
  },
};

const { default: useStore, carryNonHistory, touchedKeepPaths } = await import('../src/ui/store.js');
const { createProject, createClip, createTextClip } = await import('../src/engine/model.js');

const S = () => useStore.getState();

function open() {
  const base = createProject({ name: '原名' });
  const assets = {
    a1: { id: 'a1', type: 'video', name: 'a1.mp4', path: 'C:/a1.mp4', duration: 20, width: 1920, height: 1080 },
    a2: { id: 'a2', type: 'video', name: 'a2.mp4', path: 'C:/a2.mp4', duration: 20, width: 1920, height: 1080 },
  };
  const c1 = { ...createClip(assets.a1), id: 'c1', in: 0, out: 4 };
  const c2 = { ...createClip(assets.a2), id: 'c2', in: 0, out: 4 };
  const project = {
    ...base,
    assets,
    storyboard: [{ id: 's1', text: '镜头一', aiVideoTask: null }],
    tracks: { ...base.tracks, video: [c1, c2], text: [{ ...createTextClip({ text: '字', start: 4, duration: 2 }), id: 't1' }], audio: [] },
  };
  useStore.setState({ project, past: [], future: [], saveState: 'saved', toasts: [], selection: { clipIds: [], textId: null, audioId: null, shotId: null, kind: null, id: null } });
  return project;
}

const delC2 = () => S().commit((p) => ({ ...p, tracks: { ...p.tracks, video: p.tracks.video.filter((c) => c.id !== 'c2') } }), '删除镜头');

test('撤销不回滚 AI 对话、项目名、风格指南、素材标记和 AI 视频进度；再做一步也不丢', () => {
  open();
  assert.equal(delC2().ok, true);
  // 这一步之后发生的、不进历史的修改
  S().update((p) => ({ ...p, name: '新名字' }));
  S().update((p) => ({ ...p, chats: { ...p.chats, editor: [...((p.chats || {}).editor || []), { role: 'user', text: '把第二个镜头删掉' }] } }));
  S().update((p) => ({ ...p, memory: { ...p.memory, styleGuide: '冷色调', decisions: ['不要转场'] } }));
  S().update((p) => ({ ...p, assets: { ...p.assets, a1: { ...p.assets.a1, offline: true, stats: { luma: 0.4 } } } }));
  S().update((p) => ({ ...p, storyboard: p.storyboard.map((s) => ({ ...s, aiVideoTask: { id: 'task-1', progress: 60 } })) }));
  S().update((p) => ({ ...p, references: { s1: [{ url: 'x' }] } }));

  assert.equal(S().undo(), true);
  let p = S().project;
  assert.equal(p.tracks.video.length, 2, '剪辑要还原');
  assert.equal(p.name, '新名字');
  assert.equal(p.chats.editor.length, 1);
  assert.equal(p.memory.styleGuide, '冷色调');
  assert.deepEqual(p.memory.decisions, ['不要转场']);
  assert.equal(p.assets.a1.offline, true);
  assert.deepEqual(p.assets.a1.stats, { luma: 0.4 });
  assert.deepEqual(p.storyboard[0].aiVideoTask, { id: 'task-1', progress: 60 });
  assert.deepEqual(p.references, { s1: [{ url: 'x' }] });

  // 撤销后再做一步（此时 future 被清空）：数据仍在
  assert.equal(S().commit((q) => ({ ...q, tracks: { ...q.tracks, text: [] } }), '删除文字').ok, true);
  p = S().project;
  assert.equal(p.name, '新名字');
  assert.equal(p.chats.editor.length, 1);
  assert.equal(p.memory.styleGuide, '冷色调');
});

test('重做同样不回滚：撤销后产生的对话，重做之后还在', () => {
  open();
  delC2();
  S().undo();
  S().update((p) => ({ ...p, name: '撤销后改的名' }));
  S().update((p) => ({ ...p, chats: { ...p.chats, director: [{ role: 'user', text: '嗨' }] } }));
  assert.equal(S().redo(), true);
  const p = S().project;
  assert.equal(p.tracks.video.length, 1, '重做要生效');
  assert.equal(p.name, '撤销后改的名');
  assert.equal(p.chats.director.length, 1);
});

test('这一步自己改过的字段（风格指南走 commit）撤销时照常还原、重做时照常恢复', () => {
  open();
  S().update((p) => ({ ...p, memory: { ...p.memory, styleGuide: '旧风格' } }));
  S().commit((p) => ({ ...p, memory: { ...p.memory, styleGuide: '新风格' } }), '修改风格指南');
  S().update((p) => ({ ...p, name: '后来改的名' }));
  S().undo();
  assert.equal(S().project.memory.styleGuide, '旧风格');
  assert.equal(S().project.name, '后来改的名');
  S().redo();
  assert.equal(S().project.memory.styleGuide, '新风格');
  assert.equal(S().project.name, '后来改的名');
});

test('撤销「导入素材」仍然移除素材；不会把快照里没有的素材加回来', () => {
  open();
  S().commit((p) => ({ ...p, assets: { ...p.assets, a3: { id: 'a3', type: 'image', name: 'a3.png', duration: 0 } } }), '导入素材');
  S().update((p) => ({ ...p, assets: { ...p.assets, a3: { ...p.assets.a3, offline: true } } }));
  S().undo();
  assert.equal(S().project.assets.a3, undefined);
  S().redo();
  assert.ok(S().project.assets.a3);
});

test('撤销后选择里不留已经不存在的文字/音频/镜头', () => {
  open();
  S().commit((p) => ({ ...p, tracks: { ...p.tracks, text: [...p.tracks.text, { ...createTextClip({ text: '新字', start: 0, duration: 1 }), id: 't9' }] } }), '添加文字');
  S().selectText('t9');
  S().commit((p) => ({ ...p, tracks: { ...p.tracks, video: p.tracks.video.slice(0, 1) } }), '删除镜头');
  S().undo(); // 回到有 t9
  assert.equal(S().selection.textId, 't9');
  S().undo(); // 回到没有 t9
  assert.equal(S().selection.textId, null);
  assert.equal(S().selection.kind, null);
  // 提交把选中的文字删掉：选择同步清掉
  S().selectText('t1');
  S().commit((p) => ({ ...p, tracks: { ...p.tracks, text: [] } }), '清空文字');
  assert.equal(S().selection.textId, null);
});

test('carryNonHistory / touchedKeepPaths：没有差异时返回原对象', () => {
  const p = open();
  assert.equal(carryNonHistory(p, p), p);
  assert.equal(carryNonHistory(p, { ...p, tracks: { ...p.tracks, video: [] } }), p);
  assert.deepEqual(touchedKeepPaths(p, { ...p, tracks: { ...p.tracks, video: [] } }), []);
  assert.deepEqual(touchedKeepPaths(p, { ...p, name: 'x', memory: { ...p.memory, styleGuide: 'y' } }).sort(), ['memory.styleGuide', 'name']);
});
