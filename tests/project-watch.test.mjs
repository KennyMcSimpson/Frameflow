// projectWatch：项目文件实时监听（原子替换、自写防回声、UNC 路径拒绝、dispose 清理）。
// 纯离线、确定性单测；全部临时目录在 try/finally / after 中清理。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProjectWatcher, computeDigest } = require('../electron/lib/projectWatch.cjs');
const registerStore = require('../electron/ipc/store.cjs');

const tmpDirs = [];
function makeTmpDir(prefix = 'ff-watch-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 2500, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(intervalMs);
  }
  return predicate();
}

function writeAtomic(filePath, text) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

test('projectWatch：外部原子写入+重命名触发一次 onChange 并带解析后的 project 与 digest', async () => {
  const dir = makeTmpDir('ff-watch-ext-');
  const file = path.join(dir, 'demo.ffproj');
  const initial = JSON.stringify({ version: 3, id: 'prj_1', name: 'Initial', tracks: { video: [], text: [], audio: [] } });
  fs.writeFileSync(file, initial, 'utf8');

  const events = [];
  const errors = [];
  const watcher = createProjectWatcher({
    debounceMs: 40,
    onChange: (ev) => events.push(ev),
    onError: (err) => errors.push(err),
  });

  try {
    const st = watcher.watch(file);
    assert.equal(st.active, true);
    assert.equal(st.filePath, path.resolve(file));
    assert.deepEqual(watcher.status(), { active: true, filePath: path.resolve(file) });

    // 给 fs.watch 一点时间完成注册
    await delay(60);

    const updatedObj = {
      version: 3,
      id: 'prj_1',
      name: 'Externally Edited',
      meta: { lastAgentEdit: { source: 'cli', at: '2026-11-25T00:00:00.000Z' } },
      tracks: { video: [], text: [], audio: [] },
    };
    const updatedText = JSON.stringify(updatedObj, null, 2);
    writeAtomic(file, updatedText);

    const fired = await waitFor(() => events.length >= 1);
    assert.equal(fired, true, '外部原子替换后应触发 onChange');
    // 等待额外窗口，确认只触发一次（无重复回声）
    await delay(180);
    assert.equal(events.length, 1);
    assert.equal(errors.length, 0);
    assert.equal(events[0].filePath, path.resolve(file));
    assert.deepEqual(events[0].project, updatedObj);
    assert.equal(events[0].digest, computeDigest(updatedText));

    // 再次写入完全相同内容：摘要一致，不应重复触发
    writeAtomic(file, updatedText);
    await delay(180);
    assert.equal(events.length, 1);
  } finally {
    watcher.dispose();
  }
});

test('projectWatch：markSelfWrite 阻止自写回声循环，但后续外部修改仍正常触发', async () => {
  const dir = makeTmpDir('ff-watch-self-');
  const file = path.join(dir, 'self.ffproj');
  fs.writeFileSync(file, JSON.stringify({ version: 3, id: 'prj_self', name: 'V0' }), 'utf8');

  const events = [];
  const watcher = createProjectWatcher({
    debounceMs: 40,
    onChange: (ev) => events.push(ev),
  });

  try {
    watcher.watch(file);
    await delay(60);

    // 模拟宿主自写：先 markSelfWrite 再写盘（原子替换）
    const selfText = JSON.stringify({ version: 3, id: 'prj_self', name: 'SelfSaved' });
    const digest = watcher.markSelfWrite(file, selfText);
    assert.equal(digest, computeDigest(selfText));
    writeAtomic(file, selfText);

    await delay(220);
    assert.equal(events.length, 0, '自写后绝不能触发 onChange（零回声）');

    // 同目录写入无关文件也不应触发
    fs.writeFileSync(path.join(dir, 'other.ffproj'), JSON.stringify({ name: 'Other' }), 'utf8');
    await delay(150);
    assert.equal(events.length, 0);

    // 外部真正修改：应当触发一次
    const extObj = { version: 3, id: 'prj_self', name: 'ExternalAfterSelf' };
    writeAtomic(file, JSON.stringify(extObj));
    const fired = await waitFor(() => events.length >= 1);
    assert.equal(fired, true, '自写之后发生的外部变更仍应正常触发 onChange');
    assert.equal(events.length, 1);
    assert.equal(events[0].project.name, 'ExternalAfterSelf');
  } finally {
    watcher.dispose();
  }
});

test('projectWatch：拒绝 UNC 路径、混用斜杠 UNC 及非绝对路径', () => {
  const watcher = createProjectWatcher({ debounceMs: 30 });
  try {
    const uncPaths = [
      '\\\\host\\share\\a.ffproj',
      '//host/share/a.ffproj',
      '\\/host\\share\\a.ffproj',
      '/\\host\\share\\a.ffproj',
    ];
    for (const bad of uncPaths) {
      assert.throws(
        () => watcher.watch(bad),
        (err) => err && err.code === 'UNSAFE_PATH',
        `应拒绝 UNC 路径：${bad}`,
      );
      assert.equal(watcher.markSelfWrite(bad, '{}'), null, `markSelfWrite 应忽略 UNC：${bad}`);
    }

    assert.throws(
      () => watcher.watch(''),
      (err) => err && err.code === 'INVALID_PATH',
    );
    assert.throws(
      () => watcher.watch('relative/demo.ffproj'),
      (err) => err && err.code === 'INVALID_PATH',
    );
    assert.deepEqual(watcher.status(), { active: false, filePath: null });
  } finally {
    watcher.dispose();
  }
});

test('projectWatch：损坏 JSON 不触发 onChange，随后恢复为有效 JSON 可正常回调', async () => {
  const dir = makeTmpDir('ff-watch-corrupt-');
  const file = path.join(dir, 'corrupt.ffproj');
  fs.writeFileSync(file, JSON.stringify({ version: 3, name: 'Good0' }), 'utf8');

  const events = [];
  const errors = [];
  const watcher = createProjectWatcher({
    debounceMs: 35,
    onChange: (ev) => events.push(ev),
    onError: (err) => errors.push(err),
  });

  try {
    watcher.watch(file);
    await delay(60);

    // 写入半截 JSON：重试后仍为 SyntaxError，应静默忽略而非崩溃或误报
    fs.writeFileSync(file, '{"version": 3, "name": ', 'utf8');
    await delay(220);
    assert.equal(events.length, 0);
    assert.equal(errors.length, 0);

    // 恢复为完整有效 JSON：应正常触发
    writeAtomic(file, JSON.stringify({ version: 3, name: 'Recovered' }));
    const fired = await waitFor(() => events.length >= 1);
    assert.equal(fired, true);
    assert.equal(events[0].project.name, 'Recovered');
  } finally {
    watcher.dispose();
  }
});

test('projectWatch：dispose 干净释放监听且不残留定时/回调，释放后不再接受 watch', async () => {
  const dir = makeTmpDir('ff-watch-dispose-');
  const file = path.join(dir, 'dispose.ffproj');
  fs.writeFileSync(file, JSON.stringify({ version: 3, name: 'BeforeDispose' }), 'utf8');

  const events = [];
  const watcher = createProjectWatcher({
    debounceMs: 40,
    onChange: (ev) => events.push(ev),
  });

  watcher.watch(file);
  assert.equal(watcher.status().active, true);
  await delay(50);

  watcher.dispose();
  assert.deepEqual(watcher.status(), { active: false, filePath: null });

  // dispose 之后修改文件不得触发 onChange
  writeAtomic(file, JSON.stringify({ version: 3, name: 'AfterDispose' }));
  await delay(200);
  assert.equal(events.length, 0);

  // dispose 之后再 watch 抛出 DISPOSED，markSelfWrite 返回 null
  assert.throws(() => watcher.watch(file), (err) => err && err.code === 'DISPOSED');
  assert.equal(watcher.markSelfWrite(file, '{}'), null);
  // 幂等重复 dispose 不抛错
  assert.doesNotThrow(() => watcher.dispose());
});

test('projectWatch：runRead(fileA) 在途时切换到 watch(fileB) 仍能正常投递 fileB 的外部变更事件（RT1 P1-4）', async () => {
  const dir = makeTmpDir('ff-watch-switch-');
  const fileA = path.join(dir, 'a.ffproj');
  const fileB = path.join(dir, 'b.ffproj');
  fs.writeFileSync(fileA, JSON.stringify({ version: 3, id: 'prj_a', name: 'A0', tracks: { video: [], text: [], audio: [] } }), 'utf8');
  fs.writeFileSync(fileB, JSON.stringify({ version: 3, id: 'prj_b', name: 'B0', tracks: { video: [], text: [], audio: [] } }), 'utf8');

  const events = [];
  const errors = [];
  const watcher = createProjectWatcher({
    debounceMs: 30,
    onChange: (ev) => events.push(ev),
    onError: (err) => errors.push(err),
  });

  const origReadFile = fs.promises.readFile;
  const resolvedA = path.resolve(fileA);
  let markReadAStarted;
  const readAStarted = new Promise((resolve) => { markReadAStarted = resolve; });
  let releaseReadA;
  const holdReadA = new Promise((resolve) => { releaseReadA = resolve; });
  let interceptedA = false;

  fs.promises.readFile = async function (p, ...rest) {
    if (!interceptedA && path.resolve(String(p)) === resolvedA) {
      interceptedA = true;
      markReadAStarted();
      await holdReadA;
    }
    return origReadFile.call(this, p, ...rest);
  };

  try {
    watcher.watch(fileA);
    await delay(50);

    // 触发 fileA 读取，使其停留在 in-flight 状态
    writeAtomic(fileA, JSON.stringify({ version: 3, id: 'prj_a', name: 'A1', tracks: { video: [], text: [], audio: [] } }));
    const started = await Promise.race([
      readAStarted.then(() => true),
      delay(2500).then(() => false),
    ]);
    assert.equal(started, true, 'runRead(fileA) 应已进入在途读取阶段');

    // 在 runRead(fileA) 尚未结束时立刻切到 fileB
    const stB = watcher.watch(fileB);
    assert.equal(stB.active, true);
    assert.equal(stB.filePath, path.resolve(fileB));
    await delay(50);

    // 修改 fileB，并随后释放卡住的 fileA 读取
    writeAtomic(fileB, JSON.stringify({ version: 3, id: 'prj_b', name: 'B1', tracks: { video: [], text: [], audio: [] } }));
    releaseReadA();

    const gotB = await waitFor(() => events.some((ev) => ev.filePath === path.resolve(fileB) && ev.project.name === 'B1'));
    assert.equal(gotB, true, '切换到 fileB 后必须收到 fileB 的外部变更事件');
    await delay(120);
    assert.equal(events.some((ev) => ev.filePath === path.resolve(fileA)), false, '已切换的 fileA 旧读取绝不能延迟投递事件');

    // 再做一次 fileB 修改，确认旧 runRead(fileA) 的 finally 没有卡死或破坏 reading 状态
    writeAtomic(fileB, JSON.stringify({ version: 3, id: 'prj_b', name: 'B2', tracks: { video: [], text: [], audio: [] } }));
    const gotB2 = await waitFor(() => events.some((ev) => ev.filePath === path.resolve(fileB) && ev.project.name === 'B2'));
    assert.equal(gotB2, true, '后续 fileB 变更也应持续正常投递');
    assert.equal(errors.length, 0);
  } finally {
    releaseReadA();
    fs.promises.readFile = origReadFile;
    watcher.dispose();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function setupStoreIpc(root) {
  const userData = path.join(root, 'userData');
  const dataRoot = path.join(root, 'data');
  const projects = path.join(dataRoot, 'projects');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });

  const secrets = Object.create(null);
  let state = { dataRoot, ai: {}, ui: {}, general: {} };
  const sent = [];
  const registeredMedia = [];

  const ctx = {
    paths: {
      userData,
      dataRoot,
      projects,
      projectDir: (id) => {
        const d = path.join(projects, id);
        fs.mkdirSync(d, { recursive: true });
        return d;
      },
      projectCache: (id) => path.join(projects, id, 'cache'),
    },
    settings: {
      DEFAULTS: { dataRoot: '', ai: {}, ui: {}, general: {}, web: {}, editing: {}, export: {}, videogen: {} },
      VIDEOGEN_SECRETS: ['arkKey'],
      get: () => state,
      set: (patch) => { state = { ...state, ...patch }; return state; },
      hasSecret: (k) => Boolean(secrets[k]),
      getSecret: (k) => secrets[k] || '',
      setSecret: (k, v) => {
        if (v) secrets[k] = v;
        else delete secrets[k];
      },
    },
    send: (ch, payload) => { sent.push({ ch, payload }); },
    registerMediaPath: (p) => { registeredMedia.push(p); },
  };

  const handlers = {};
  const reg = registerStore({ handle: (ch, fn) => { handlers[ch] = fn; }, ctx });
  return { root, userData, dataRoot, projects, secrets, sent, registeredMedia, handlers, reg };
}

test('store.cjs project:watch：拒绝指向 userData（含 secrets.json）的目录联接/符号链接（RT1 P0-1）', async () => {
  const root = makeTmpDir('ff-store-junc-');
  const s = setupStoreIpc(root);
  const linksToClean = [];
  try {
    const proj = await s.handlers['project:create']({ name: 'WatchSec' });
    const secretFile = path.join(s.userData, 'secrets.json');
    fs.writeFileSync(secretFile, JSON.stringify({ anthropicKey: 'enc:secret' }), 'utf8');
    // 即使 userData 内存在结构像项目的 project.json，也必须被安全边界无条件拦截
    fs.writeFileSync(
      path.join(s.userData, 'project.json'),
      JSON.stringify({ version: 3, id: proj.id, name: 'FakeInUserData', tracks: { video: [], text: [], audio: [] } }),
      'utf8',
    );

    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    const nestedLink = path.join(s.projects, proj.id, 'escape-ud');
    fs.symlinkSync(s.userData, nestedLink, linkType);
    linksToClean.push(nestedLink);

    await assert.rejects(
      s.handlers['project:watch']({ id: proj.id, filePath: path.join(nestedLink, 'secrets.json') }),
      (err) => err && err.code === 'UNSAFE_PATH',
      '通过 projects/<id>/ 内目录联接访问 userData/secrets.json 必须被拒绝',
    );
    await assert.rejects(
      s.handlers['project:watch']({ id: proj.id, filePath: path.join(nestedLink, 'project.json') }),
      (err) => err && err.code === 'UNSAFE_PATH',
      '通过 projects/<id>/ 内目录联接访问 userData/project.json 同样必须被拒绝',
    );

    // 将整个 projects/<id2> 目录替换成指向 userData 的联接，无 filePath 的 project:watch({ id }) 也必须拒绝
    const linkProjDir = path.join(s.projects, 'prj_linked_ud');
    fs.symlinkSync(s.userData, linkProjDir, linkType);
    linksToClean.push(linkProjDir);

    await assert.rejects(
      s.handlers['project:watch']({ id: 'prj_linked_ud' }),
      (err) => err && err.code === 'UNSAFE_PATH',
      '指向 userData 的项目目录联接必须被 project:watch({ id }) 拒绝',
    );
    assert.deepEqual(await s.handlers['project:watchStatus'](), { active: false, filePath: null });
  } finally {
    s.reg.dispose();
    for (const lp of linksToClean) {
      try { fs.unlinkSync(lp); } catch {}
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('store.cjs project:watch：拒绝未授权外部 .json 与非项目 package.json（RT1 P0-2）', async () => {
  const root = makeTmpDir('ff-store-unauth-');
  const s = setupStoreIpc(root);
  try {
    const proj = await s.handlers['project:create']({ name: 'AuthCheck' });
    const extDir = path.join(root, 'external');
    fs.mkdirSync(extDir, { recursive: true });

    const unauthProj = path.join(extDir, 'unauth.json');
    fs.writeFileSync(unauthProj, JSON.stringify({
      version: 3,
      id: 'prj_ext_unauth',
      name: 'Unauth',
      tracks: { video: [], text: [], audio: [] },
    }), 'utf8');

    await assert.rejects(
      s.handlers['project:watch']({ id: proj.id, filePath: unauthProj }),
      (err) => err && err.code === 'UNAUTHORIZED_WATCH_PATH',
      '未通过打开/导入/导出授权的外部 .json 必须以 UNAUTHORIZED_WATCH_PATH 拒绝',
    );

    const pkgPath = path.join(extDir, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'not-frameflow', version: '1.0.0', scripts: {} }), 'utf8');

    // 未授权时以 UNAUTHORIZED_WATCH_PATH 拒绝
    await assert.rejects(
      s.handlers['project:watch']({ id: proj.id, filePath: pkgPath }),
      (err) => err && err.code === 'UNAUTHORIZED_WATCH_PATH',
    );

    // 即使路径已授权（例如外部文件事后被覆盖为非项目 JSON），也必须以 INVALID_PROJECT_FILE 拒绝
    assert.equal(s.reg.authorizeExternalWatchPath(pkgPath), true);
    await assert.rejects(
      s.handlers['project:watch']({ id: proj.id, filePath: pkgPath }),
      (err) => err && err.code === 'INVALID_PROJECT_FILE',
      '非镜流项目结构（package.json）必须以 INVALID_PROJECT_FILE 拒绝监听',
    );
    assert.deepEqual(await s.handlers['project:watchStatus'](), { active: false, filePath: null });
  } finally {
    s.reg.dispose();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('store.cjs：经 project:importJson 授权的外部 .ffproj 变更自动镜像到内部 project.json，且 settings:set 支持 anthropicKey 存取与清除（RT1 P2-6 & P3-3）', async () => {
  const root = makeTmpDir('ff-store-mirror-');
  const s = setupStoreIpc(root);
  try {
    const extDir = path.join(root, 'ext-agent');
    fs.mkdirSync(extDir, { recursive: true });
    const extFile = path.join(extDir, 'agent-demo.ffproj');
    fs.writeFileSync(extFile, JSON.stringify({
      version: 3,
      id: 'prj_orig_ext',
      name: 'Initial External',
      tracks: { video: [], text: [], audio: [] },
      assets: {},
    }, null, 2), 'utf8');

    const imported = await s.handlers['project:importJson']({ path: extFile });
    assert.ok(imported && imported.id);
    assert.equal(imported.name, 'Initial External');

    const watchRes = await s.handlers['project:watch']({ id: imported.id, filePath: extFile });
    assert.equal(watchRes.ok, true);
    await delay(60);

    // 外部 Agent 原子改写 .ffproj
    const agentUpdated = {
      version: 3,
      id: imported.id,
      name: 'Agent Mirrored Update',
      meta: { lastAgentEdit: { agent: 'claude-code', label: 'Polish intro', at: '2026-11-25T10:00:00.000Z' } },
      tracks: { video: [], text: [], audio: [] },
      assets: {},
    };
    writeAtomic(extFile, JSON.stringify(agentUpdated, null, 2));

    const gotEvent = await waitFor(
      () => s.sent.some((m) => m.ch === 'project:externalChange' && m.payload && m.payload.project && m.payload.project.name === 'Agent Mirrored Update'),
      { timeoutMs: 3500 },
    );
    assert.equal(gotEvent, true, '外部修改已授权 .ffproj 后应触发 project:externalChange 推送');

    const ev = s.sent.find((m) => m.ch === 'project:externalChange');
    assert.equal(ev.payload.id, imported.id);
    assert.equal(ev.payload.meta.agent, 'claude-code');

    // 验证内部 projects/<id>/project.json 已被镜像更新，防止未再编辑直接关窗丢改动
    const internalFile = path.join(s.projects, imported.id, 'project.json');
    const mirrored = JSON.parse(fs.readFileSync(internalFile, 'utf8'));
    assert.equal(mirrored.id, imported.id);
    assert.equal(mirrored.name, 'Agent Mirrored Update');
    assert.equal(mirrored.meta.lastAgentEdit.agent, 'claude-code');

    // 验证 settings:set 支持保存与清除 anthropicKey，并暴露 hasAnthropicKey 而绝不回传明文
    const saved = await s.handlers['settings:set']({ anthropicKey: '  sk-ant-test-999  ' });
    assert.equal(saved.hasAnthropicKey, true);
    assert.equal('anthropicKey' in saved, false);
    assert.equal(s.secrets.anthropicKey, 'sk-ant-test-999');

    const cleared = await s.handlers['settings:set']({ anthropicKey: '' });
    assert.equal(cleared.hasAnthropicKey, false);
    assert.equal('anthropicKey' in cleared, false);
    assert.equal(s.secrets.anthropicKey, undefined);
  } finally {
    s.reg.dispose();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('projectWatch & store.cjs：拒绝 NTFS ADS、尾点/尾空格与悬空符号链接，且祖先检查根到叶失败关闭（RT1 R2 P2-2）', async () => {
  const root = makeTmpDir('ff-watch-ads-');
  const s = setupStoreIpc(root);
  const watcher = createProjectWatcher({ debounceMs: 40, onChange: () => {} });
  try {
    const extDir = path.join(root, 'ext');
    fs.mkdirSync(extDir, { recursive: true });
    const baseFile = path.join(extDir, 'ok.ffproj');
    fs.writeFileSync(baseFile, JSON.stringify({
      version: 3,
      id: 'prj_ok',
      name: 'OK',
      tracks: { video: [], text: [], audio: [] },
    }), 'utf8');

    const badPaths = [
      `${baseFile}:stream.ffproj`,
      `${baseFile}.`,
      `${baseFile} `,
      path.join(extDir, 'bad. ', 'demo.ffproj'),
    ];
    for (const bad of badPaths) {
      assert.throws(
        () => watcher.watch(bad),
        (err) => err && err.code === 'UNSAFE_PATH',
        `projectWatch 应拒绝危险路径: ${bad}`,
      );
      await assert.rejects(
        s.handlers['project:importJson']({ path: bad }),
        (err) => err && (err.code === 'UNSAFE_PATH' || /不安全|符号链接/.test(err.message)),
        `project:importJson 应拒绝危险路径: ${bad}`,
      );
      await assert.rejects(
        s.handlers['project:watch']({ filePath: bad }),
        (err) => err && (err.code === 'UNSAFE_PATH' || err.code === 'INVALID_PATH'),
        `project:watch 应拒绝危险路径: ${bad}`,
      );
      assert.equal(s.reg.authorizeExternalWatchPath(bad), false);
    }

    // 悬空符号链接 / 目录联接必须 fail-closed
    const missingTarget = path.join(root, 'deleted-target');
    fs.mkdirSync(missingTarget, { recursive: true });
    const danglingLink = path.join(root, 'dangling-dir');
    fs.symlinkSync(missingTarget, danglingLink, process.platform === 'win32' ? 'junction' : 'dir');
    fs.rmSync(missingTarget, { recursive: true, force: true });

    const viaDangling = path.join(danglingLink, 'demo.ffproj');
    assert.throws(
      () => watcher.watch(viaDangling),
      (err) => err && err.code === 'UNSAFE_PATH',
      'projectWatch 遇到悬空符号链接/目录联接必须 fail-closed 抛出 UNSAFE_PATH',
    );
  } finally {
    watcher.dispose();
    s.reg.dispose();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
