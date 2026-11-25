// store Live Watch 端到端测试：验证外部工程热同步与撤销保留、在途保存竞态、v1 迁移+时间线夹紧、以及 app:openFile 监听联动。
// 100% 离线，通过伪造 window.ff 驱动真实 src/ui/store.js。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const pendingTimers = new Set();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(() => {
    pendingTimers.delete(t);
    fn(...args);
  }, ms);
  pendingTimers.add(t);
  return t;
};
globalThis.clearTimeout = (t) => {
  pendingTimers.delete(t);
  return realClearTimeout(t);
};

const eventHandlers = new Map(); // channel -> Set<fn>
const invokeCalls = [];
let customInvoke = null;

function emitIpc(channel, payload) {
  const set = eventHandlers.get(channel);
  if (!set) return [];
  return Array.from(set).map((fn) => fn(payload));
}

globalThis.window = {
  ff: {
    platform: process.platform,
    on: (channel, fn) => {
      if (!eventHandlers.has(channel)) eventHandlers.set(channel, new Set());
      eventHandlers.get(channel).add(fn);
      return () => {
        const s = eventHandlers.get(channel);
        if (s) s.delete(fn);
      };
    },
    flushed: () => {},
    invoke: async (channel, payload) => {
      invokeCalls.push({ channel, payload });
      if (typeof customInvoke === 'function') {
        const r = await customInvoke(channel, payload);
        if (r !== undefined) return r;
      }
      if (channel === 'project:list') return [];
      if (channel === 'project:watch') return { ok: true, filePath: (payload && payload.filePath) || '/mock/project.json' };
      if (channel === 'project:unwatch') return { ok: true };
      if (channel === 'project:save') return { ok: true, updatedAt: new Date().toISOString() };
      if (channel === 'settings:get') return { ui: {}, general: { autosave: true, openLastProject: false }, ai: {} };
      if (channel === 'app:info') return { agentClis: {} };
      if (channel === 'ai:status') return { provider: 'local', ready: false };
      return { ok: true };
    },
  },
};

const { default: useStore } = await import('../src/ui/store.js');
const { createProject, createClip } = await import('../src/engine/model.js');

const S = () => useStore.getState();

// 绑定 store 内部事件监听（onProjectExternalChange / app:openFile / onFlush）
await S().init();

after(async () => {
  customInvoke = null;
  await S().closeProject({ force: true });
  for (const t of pendingTimers) realClearTimeout(t);
  pendingTimers.clear();
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

function makeBaseProject(id = 'prj_lw_1') {
  const base = createProject({ name: 'LiveWatch Demo' });
  const a1 = { id: 'a1', kind: 'video', name: 'a1.mp4', path: path.join(os.tmpdir(), 'lw-a1.mp4'), duration: 20, width: 1920, height: 1080 };
  const a2 = { id: 'a2', kind: 'video', name: 'a2.mp4', path: path.join(os.tmpdir(), 'lw-a2.mp4'), duration: 20, width: 1920, height: 1080 };
  const c1 = { ...createClip(a1), id: 'c1', in: 0, out: 10 };
  const c2 = { ...createClip(a2), id: 'c2', in: 0, out: 10 };
  return {
    ...base,
    id,
    assets: { a1, a2 },
    tracks: { video: [c1, c2], text: [], audio: [] },
    chats: { director: [{ role: 'user', text: 'initial director msg' }], editor: [] },
    memory: { styleGuide: 'warm daylight', decisions: ['keep intro clean'], colorBaseline: null },
  };
}

function seedOpenProject(project, extra = {}) {
  useStore.setState({
    project,
    past: [],
    future: [],
    saveState: 'saved',
    toasts: [],
    playhead: 0,
    range: null,
    focus: null,
    selection: { clipIds: [], textId: null, audioId: null, shotId: null, kind: null, id: null },
    liveWatch: { active: true, filePath: path.join(os.tmpdir(), `${project.id}.ffproj`), lastSyncAt: null, lastAgent: null },
    ...extra,
  });
}

async function waitUntil(pred, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => realSetTimeout(r, 15));
  }
  return pred();
}

test('Live Watch：外部深拷贝 JSON 变更 + 用户 update() 新增聊天与记忆决策 + undo() 完整保留新聊天与记忆（RT2 P1-1）', () => {
  const initial = makeBaseProject('prj_lw_undo');
  seedOpenProject(initial);

  // 模拟外部进程改盘后传回的深拷贝工程：仅改第一镜 look，chats 与 memory 内容等价但引用全新
  const extClone = JSON.parse(JSON.stringify(initial));
  extClone.tracks.video[0].color.look = 'cinematic';
  extClone.meta = { lastAgentEdit: { agent: 'claude-code', label: 'Apply cinematic look' } };

  emitIpc('project:externalChange', {
    id: initial.id,
    filePath: S().liveWatch.filePath,
    project: extClone,
    meta: extClone.meta.lastAgentEdit,
  });

  assert.equal(S().project.tracks.video[0].color.look, 'cinematic');
  assert.equal(S().past.length, 1);
  assert.equal(S().past[0].touched.includes('chats'), false, '等价深拷贝 chats 不应被误标为 touched');
  assert.equal(S().past[0].touched.includes('memory.decisions'), false, '等价深拷贝 memory.decisions 不应被误标为 touched');
  assert.equal(S().liveWatch.lastAgent, 'claude-code');

  // 同步后用户通过 update() 新增一条对话和一条记忆决策
  S().update((p) => ({
    ...p,
    chats: {
      ...p.chats,
      director: [...p.chats.director, { role: 'user', text: 'user message after external sync' }],
    },
    memory: {
      ...p.memory,
      decisions: [...p.memory.decisions, 'preserve natural skin tones'],
    },
  }));

  // 撤销外部 Agent 的调色修改：剪辑回退，新增的对话与记忆决策必须保留
  assert.equal(S().undo(), true);
  assert.equal(S().project.tracks.video[0].color.look, 'none', '外部剪辑改动应被撤销');
  assert.deepEqual(
    S().project.chats.director.map((m) => m.text),
    ['initial director msg', 'user message after external sync'],
    'undo 后用户新加的聊天消息绝不能丢失',
  );
  assert.deepEqual(
    S().project.memory.decisions,
    ['keep intro clean', 'preserve natural skin tones'],
    'undo 后用户新加的记忆决策绝不能丢失',
  );
});

test('Live Watch：在途 saveNow() 与 project:externalChange 竞态完成时不把 saveState 翻回 dirty（RT2 P1-1）', async () => {
  const initial = makeBaseProject('prj_lw_race');
  seedOpenProject(initial, { saveState: 'dirty' });

  let resolveSave;
  let saveStarted;
  const saveStartedP = new Promise((r) => { saveStarted = r; });

  customInvoke = (channel) => {
    if (channel === 'project:save') {
      saveStarted();
      return new Promise((resolve) => { resolveSave = resolve; });
    }
    return undefined;
  };

  try {
    const savePromise = S().saveNow();
    await saveStartedP;
    assert.equal(S().saveState, 'saving', 'saveNow 应处于在途保存状态');

    // 在 saveNow 尚未 resolve 时到达外部热同步
    const extClone = JSON.parse(JSON.stringify(initial));
    extClone.tracks.video[0].color.look = 'film-warm';
    emitIpc('project:externalChange', {
      id: initial.id,
      filePath: S().liveWatch.filePath,
      project: extClone,
      meta: { agent: 'codex', label: 'Warm color pass' },
    });
    assert.equal(S().saveState, 'saved');
    assert.equal(S().project.tracks.video[0].color.look, 'film-warm');

    // 在途 saveNow 稍后完成：不能把 saveState 错置回 dirty
    resolveSave({ ok: true, updatedAt: new Date().toISOString() });
    const ok = await savePromise;
    assert.equal(ok, true);
    assert.equal(S().saveState, 'saved', '在途 saveNow 完成后 saveState 必须保持 saved 而非翻回 dirty');
    assert.equal(S().project.tracks.video[0].color.look, 'film-warm');

    // 反向场景：若在途 saveNow 随后抛错，同样不能覆盖为 error 状态
    S().commit((p) => ({ ...p, tracks: { ...p.tracks, video: p.tracks.video.map((c, i) => (i === 1 ? { ...c, label: 'local' } : c)) } }), '本地改名');
    let rejectSave;
    let save2Started;
    const save2StartedP = new Promise((r) => { save2Started = r; });
    customInvoke = (channel) => {
      if (channel === 'project:save') {
        save2Started();
        return new Promise((_resolve, reject) => { rejectSave = reject; });
      }
      return undefined;
    };
    const save2Promise = S().saveNow();
    await save2StartedP;

    const extClone2 = JSON.parse(JSON.stringify(initial));
    extClone2.tracks.video[0].color.look = 'noir';
    emitIpc('project:externalChange', {
      id: initial.id,
      filePath: S().liveWatch.filePath,
      project: extClone2,
      meta: { agent: 'codex', label: 'Noir look' },
    });
    rejectSave(new Error('transient disk error'));
    const ok2 = await save2Promise;
    assert.equal(ok2, false);
    assert.equal(S().saveState, 'saved', '已被外部热同步替代的旧 saveNow 失败后不应把状态置为 error');
  } finally {
    customInvoke = null;
  }
});

test('Live Watch：外部 v1 工程触发 loadProject + migrateShotCaptions，并在总时长缩短时夹紧 playhead/range/focus（RT2 P1-1）', () => {
  const initial = makeBaseProject('prj_lw_v1'); // 总时长 20s
  seedOpenProject(initial, {
    playhead: 18,
    range: { start: 2, end: 19 },
    focus: { start: 12, end: 18 },
  });

  // 外部写入一个 v1 旧版工程：总时长缩短到 6s，且镜头内携带旧式 caption.text（无文字轨）
  const v1External = {
    version: 1,
    id: initial.id,
    name: 'Legacy V1 Shrink',
    settings: { aspect: '16:9', width: 1920, height: 1080, fps: 30, background: '#000000' },
    assets: {
      a1: { id: 'a1', kind: 'video', name: 'a1.mp4', path: path.join(os.tmpdir(), 'lw-a1.mp4'), duration: 20, width: 1920, height: 1080 },
    },
    tracks: {
      video: [
        {
          id: 'c1',
          assetId: 'a1',
          in: 0,
          out: 6,
          speed: 1,
          caption: { text: 'Legacy v1 shot caption', style: 'subtitle', position: 'bottom' },
        },
      ],
      text: [],
      audio: [],
    },
  };

  emitIpc('project:externalChange', {
    id: initial.id,
    filePath: S().liveWatch.filePath,
    project: v1External,
    meta: { agent: 'legacy-script', label: 'Shrink timeline' },
  });

  const p = S().project;
  assert.equal(p.version, 3, '外部 v1 工程应经 loadProject 迁移升级到 v3');
  assert.equal(p.timeline && p.timeline.captionsMigrated, true);
  assert.ok(
    p.tracks.text.some((t) => t && t.text === 'Legacy v1 shot caption' && t.source === 'shot-caption'),
    '外部 v1 工程的镜头文案应经 migrateShotCaptions 迁移到文字轨',
  );
  assert.equal(S().playhead, 6, 'playhead 应从 18 夹紧到缩短后的总时长 6');
  assert.deepEqual(S().range, { start: 2, end: 6 }, '跨界 range [2, 19] 应夹紧到 [2, 6]');
  assert.equal(S().focus, null, '完全越界的 focus [12, 18] 应被清空为 null');
});

test('Live Watch：app:openFile → project:importJson → openProject 使用 { id, filePath } 调用 project:watch（RT2 P1-4）', async () => {
  await S().closeProject({ force: true });
  invokeCalls.length = 0;

  const extFilePath = path.join(os.tmpdir(), 'ff-open-file-test', 'external-agent.ffproj');
  const importedProj = makeBaseProject('prj_imported_open');
  importedProj.name = 'Imported From DoubleClick';

  let listData = [];
  customInvoke = (channel, payload) => {
    if (channel === 'project:importJson') {
      listData = [{ id: importedProj.id, name: importedProj.name }];
      return importedProj;
    }
    if (channel === 'project:list') return listData;
    if (channel === 'project:load') {
      assert.equal(payload.id, importedProj.id);
      return importedProj;
    }
    if (channel === 'project:watch') {
      return { ok: true, filePath: payload.filePath || '/internal/project.json' };
    }
    return undefined;
  };

  try {
    const promises = emitIpc('app:openFile', { path: extFilePath });
    await Promise.all(promises);

    const watchCalled = await waitUntil(() => invokeCalls.some((c) => c.channel === 'project:watch'));
    assert.equal(watchCalled, true, 'app:openFile 流程必须触发 project:watch');

    const importCall = invokeCalls.find((c) => c.channel === 'project:importJson');
    assert.deepEqual(importCall.payload, { path: extFilePath });

    const loadCall = invokeCalls.find((c) => c.channel === 'project:load');
    assert.deepEqual(loadCall.payload, { id: importedProj.id });

    const watchCall = invokeCalls.find((c) => c.channel === 'project:watch');
    assert.deepEqual(
      watchCall.payload,
      { id: importedProj.id, filePath: extFilePath },
      'openProject 必须把外部文件路径 { id, filePath } 一并传给 project:watch',
    );

    const watchStateReady = await waitUntil(() => S().liveWatch.active === true && S().liveWatch.filePath === extFilePath);
    assert.equal(watchStateReady, true);
    assert.equal(S().project.id, importedProj.id);
  } finally {
    customInvoke = null;
  }
});
