// 契约 C14：保存失败时不能悄悄关掉工程（内存里的工程是唯一副本）。
// 伪造 window.ff，让 project:save 按需失败，直接驱动真实的 store。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

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

let failSave = true;
let saveCalls = 0;
globalThis.window = {
  ff: {
    on: () => () => {},
    flushed: () => {},
    invoke: async (channel) => {
      if (channel === 'project:save') {
        saveCalls += 1;
        if (failSave) throw new Error('磁盘空间不足');
        return { ok: true };
      }
      if (channel === 'project:list') return [];
      return null;
    },
  },
};

const { default: useStore } = await import('../src/ui/store.js');
const { createProject } = await import('../src/engine/model.js');

after(async () => {
  await useStore.getState().closeProject({ force: true });
  for (const t of pendingTimers) realClearTimeout(t);
  pendingTimers.clear();
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

const open = () => {
  const project = createProject({ name: '测试' });
  useStore.setState({ project, saveState: 'dirty', toasts: [] });
  return project;
};

test('saveNow：成功返回 true，失败返回 false 且不抛错；没有打开工程也算 true', async () => {
  useStore.setState({ project: null });
  assert.equal(await useStore.getState().saveNow(), true);

  open();
  failSave = true;
  assert.equal(await useStore.getState().saveNow(), false);
  assert.equal(useStore.getState().saveState, 'error');

  failSave = false;
  assert.equal(await useStore.getState().saveNow(), true);
  assert.equal(useStore.getState().saveState, 'saved');
});

test('closeProject：保存失败时留在工程里，提示带「仍然关闭」按钮；点了才真的关闭', async () => {
  const project = open();
  failSave = true;
  const closed = await useStore.getState().closeProject();
  assert.equal(closed, false);
  assert.equal(useStore.getState().project, project, '工程必须还在内存里');

  const tip = useStore.getState().toasts.find((t) => t.key === 'close-save-failed');
  assert.ok(tip, '要有保存失败的提示');
  assert.equal(tip.kind, 'error');
  assert.equal(tip.action.label, '仍然关闭');

  // 连点两次返回首页：同一个 key 的提示只留一条
  await useStore.getState().closeProject();
  assert.equal(useStore.getState().toasts.filter((t) => t.key === 'close-save-failed').length, 1);

  assert.equal(await tip.action.run(), true);
  assert.equal(useStore.getState().project, null);
});

test('closeProject：保存成功就正常关闭；强制关闭后不再有重试去写已关闭的工程', async () => {
  open();
  failSave = false;
  assert.equal(await useStore.getState().closeProject(), true);
  assert.equal(useStore.getState().project, null);

  open();
  failSave = true;
  await useStore.getState().closeProject({ force: true });
  const n = saveCalls;
  await new Promise((r) => setTimeout(r, 2300)); // 第一次退避重试是 2 秒
  assert.equal(saveCalls, n, '关闭后不应再重试保存');
});
