// stability：设置/密钥文件的读写保护——原子写、损坏后改名留档并用 .bak 恢复、每次启动留一份 .bak、显卡选项默认值。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 用假的 electron：safeStorage 可逆“加密”，app.getPath 不允许被调用（测试一律用临时目录）
let encAvailable = true;
const fakeElectron = {
  app: { getPath: () => { throw new Error('单测不应读取真实 userData'); } },
  safeStorage: {
    isEncryptionAvailable: () => encAvailable,
    encryptString: (s) => Buffer.from('ENC:' + Buffer.from(String(s), 'utf8').toString('hex')),
    decryptString: (b) => {
      const t = Buffer.from(b).toString();
      if (!t.startsWith('ENC:')) throw new Error('bad');
      return Buffer.from(t.slice(4), 'hex').toString('utf8');
    },
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest);
};

const log = require('../electron/lib/log.cjs');
const { createSettings, DEFAULTS } = require('../electron/lib/settings.cjs');

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-stab-settings-'));
  dirs.push(d);
  return d;
}
const logDir = tmp();
log.init({ dir: logDir, echo: 'none' });
after(() => {
  log._reset();
  Module._load = origLoad;
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const list = (d) => fs.readdirSync(d).sort();
function logText() {
  log.flushSync();
  try { return fs.readFileSync(path.join(logDir, 'main.log'), 'utf8'); } catch { return ''; }
}

test('默认带显卡选项；改了写盘，下次启动读回，其它默认值不丢', () => {
  const dir = tmp();
  const s = createSettings({ dir });
  assert.deepEqual(DEFAULTS.system, { highPerformanceGpu: true, hardwareAcceleration: true });
  assert.deepEqual(s.get().system, { highPerformanceGpu: true, hardwareAcceleration: true });
  s.set({ system: { hardwareAcceleration: false } });
  const again = createSettings({ dir }).get();
  assert.equal(again.system.hardwareAcceleration, false);
  assert.equal(again.system.highPerformanceGpu, true);
  assert.equal(again.export.quality, 'high');
  assert.ok(!list(dir).some((f) => f.endsWith('.tmp')), '不应留下临时文件');
});

test('设置文件损坏：原文件改名留档，用 .bak 恢复', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"ui": {"scale": 1.5');
  fs.writeFileSync(path.join(dir, 'settings.json.bak'), JSON.stringify({ ui: { scale: 1.25 } }));
  const s = createSettings({ dir });
  assert.equal(s.get().ui.scale, 1.25);
  const kept = list(dir).filter((f) => /^settings\.corrupt-.+\.json$/.test(f));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), '{"ui": {"scale": 1.5');
  // 从备份恢复的这次不再覆盖 .bak：它仍是最后一份完好的文件
  s.set({ ui: { scale: 2 } });
  assert.equal(readJson(path.join(dir, 'settings.json.bak')).ui.scale, 1.25);
  assert.equal(readJson(path.join(dir, 'settings.json')).ui.scale, 2);
  assert.match(logText(), /设置文件已损坏，原文件改名为 settings\.corrupt-/);
  assert.match(logText(), /已用备份恢复设置/);
});

test('断电留下的全 0 / 空文件 / 非对象内容：回到默认值，不会起不来', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), Buffer.alloc(128));
  fs.writeFileSync(path.join(dir, 'secrets.json'), '');
  const s = createSettings({ dir });
  assert.equal(s.get().ui.scale, DEFAULTS.ui.scale);
  assert.equal(s.hasSecret('openaiKey'), false);
  assert.ok(list(dir).some((f) => f.startsWith('settings.corrupt-')));
  assert.ok(list(dir).some((f) => f.startsWith('secrets.corrupt-')));

  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, 'settings.json'), '[1,2,3]');
  assert.equal(createSettings({ dir: dir2 }).get().editing.fps, DEFAULTS.editing.fps);
});

test('每次启动后第一次保存前留一份 .bak，同一次运行里不再覆盖', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ui: { scale: 2 } }));
  const s = createSettings({ dir });
  s.set({ ui: { scale: 3 } });
  s.set({ ui: { scale: 4 } });
  assert.equal(readJson(path.join(dir, 'settings.json.bak')).ui.scale, 2);
  assert.equal(readJson(path.join(dir, 'settings.json')).ui.scale, 4);
  const next = createSettings({ dir }); // 下一次启动
  next.set({ ui: { scale: 5 } });
  assert.equal(readJson(path.join(dir, 'settings.json.bak')).ui.scale, 4);
});

test('密钥：加密保存、不进 settings.json；名字不合法会拒绝；方法单独取出也能用', () => {
  const dir = tmp();
  encAvailable = true;
  const s = createSettings({ dir });
  s.setSecret('openaiKey', 'sk-test-123');
  s.set({ videogen: { keys: { arkKey: 'ark-secret' } }, klingAk: 'kling-secret' });
  assert.equal(s.getSecret('openaiKey'), 'sk-test-123');
  assert.equal(s.getSecret('arkKey'), 'ark-secret');
  assert.equal(s.get().videogen.hasKeys.arkKey, true);
  assert.equal(s.get().videogen.hasKeys.klingAk, true);
  const onDisk = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8') + fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
  for (const v of ['sk-test-123', 'ark-secret', 'kling-secret']) assert.ok(!onDisk.includes(v), `明文出现在磁盘上：${v}`);
  assert.equal(s.hasSecret('__proto__'), false);
  assert.equal(s.hasSecret('constructor'), false);
  assert.equal(s.getSecret('toString'), '');
  assert.throws(() => s.setSecret('__proto__', 'x'), /不合法/);
  s.setSecret('openaiKey', '');
  assert.equal(createSettings({ dir }).hasSecret('openaiKey'), false);
  const { set, get } = s;
  set({ ui: { scale: 1.5 } });
  assert.equal(get().ui.scale, 1.5);
});

test('素材来源默认免 key 的在前；老版本没改过的默认顺序自动换新，改过的保留', () => {
  assert.deepEqual(DEFAULTS.web.preferredSources, ['commons', 'openverse', 'archive', 'nasa', 'pexels', 'pixabay', 'bilibili', 'youtube']);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ web: { preferredSources: ['commons', 'pexels', 'pixabay', 'bilibili', 'youtube'] } }));
  assert.deepEqual(createSettings({ dir }).get().web.preferredSources, DEFAULTS.web.preferredSources);
  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, 'settings.json'), JSON.stringify({ web: { preferredSources: ['pexels', 'commons'] } }));
  assert.deepEqual(createSettings({ dir: dir2 }).get().web.preferredSources, ['pexels', 'commons']);
});

test('即梦 AccessKey/SecretKey 走加密密钥存储', () => {
  const dir = tmp();
  const s = createSettings({ dir });
  s.set({ videogen: { keys: { jimengAk: 'AKLT-test', jimengSk: 'sk-jimeng-test' } } });
  assert.equal(s.get().videogen.hasKeys.jimengAk, true);
  assert.equal(s.get().videogen.hasKeys.jimengSk, true);
  assert.equal(s.getSecret('jimengSk'), 'sk-jimeng-test');
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('AKLT-test'));
  log.info({ jimengAk: 'AKLT-in-log', jimengSk: 'SK-in-log' });
  const text = logText();
  assert.ok(!text.includes('AKLT-in-log') && !text.includes('SK-in-log'), '日志里不能出现即梦密钥');
});

test('写不进去时给出中文原因，不留临时文件', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'settings.json')); // 同名文件夹占位：读写都会失败
  const s = createSettings({ dir });
  assert.equal(s.get().ui.scale, DEFAULTS.ui.scale);
  assert.throws(() => s.set({ ui: { scale: 2 } }), /^Error: 设置没能保存：/);
  assert.ok(!list(dir).some((f) => f.endsWith('.tmp')));
  assert.match(logText(), /\[error\] \[settings\] 保存设置失败/);
});
