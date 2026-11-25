// stability：子进程封装（proc.cjs）与后台任务（jobs.cjs）——
// 取消/超时会连同子进程树一起结束、等进程真正退出才报错；退出时 killAll；命令行写日志前脱敏。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const log = require('../electron/lib/log.cjs');
const proc = require('../electron/lib/proc.cjs');
const { createJobs } = require('../electron/lib/jobs.cjs');

const NODE = process.execPath;
const HANG = 'setInterval(() => {}, 1000)';

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-stab-proc-'));
  log.init({ dir, echo: 'none' });
});
after(() => {
  proc.killAll();
  log._reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

function logText() {
  log.flushSync();
  try { return fs.readFileSync(path.join(dir, 'main.log'), 'utf8'); } catch { return ''; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function waitDead(pid, ms = 5000) {
  const t0 = Date.now();
  while (alive(pid) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}

test('run 收集输出和退出码，失败时日志里带 stderr 末尾', async () => {
  const ok = await proc.run(NODE, ['-e', 'process.stdout.write("你好")']);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, '你好');
  const bad = await proc.run(NODE, ['-e', 'process.stderr.write("坏了");process.exit(3)']);
  assert.equal(bad.code, 3);
  assert.equal(bad.stderr, '坏了');
  assert.match(logText(), /\[warn\] \[proc\] node(\.exe)? -e .*退出码 3.*坏了/);
});

test('找不到程序时 reject，不会让主进程崩溃', async () => {
  await assert.rejects(proc.run(path.join(dir, 'nope.exe'), []), (e) => e.code === 'ENOENT');
  await assert.rejects(proc.run('', []), /找不到可执行文件/);
});

test('取消：连子进程树一起结束，并等进程退出后才报「已取消」', async () => {
  const ac = new AbortController();
  const script = [
    `const c = require('child_process').spawn(process.execPath, ['-e', '${HANG}'], { stdio: 'ignore' });`,
    "process.stdout.write(process.pid + ',' + c.pid + ';');",
    `${HANG};`,
  ].join(' ');
  let out = '';
  let pids = [];
  const p = proc.run(NODE, ['-e', script], {
    signal: ac.signal,
    onStdout: (c) => {
      out += c.toString();
      if (out.includes(';') && !pids.length) {
        pids = out.split(';')[0].split(',').map(Number);
        ac.abort();
      }
    },
  });
  try {
    await assert.rejects(p, (e) => e.code === 'CANCELLED' && e.message === '已取消');
    const [childPid, grandPid] = pids;
    assert.ok(childPid > 0 && grandPid > 0);
    assert.equal(alive(childPid), false, '报「已取消」时进程应已退出');
    if (process.platform === 'win32') assert.ok(await waitDead(grandPid), '子进程启动的进程也应被结束');
  } finally {
    for (const pid of pids) { try { process.kill(pid); } catch {} }
  }
  assert.match(logText(), /\[info\] \[proc\] 已取消 node/);
});

test('信号已经取消：不再启动进程，直接报「已取消」', async () => {
  const ac = new AbortController();
  ac.abort();
  const t0 = Date.now();
  await assert.rejects(proc.run(NODE, ['-e', HANG], { signal: ac.signal }), (e) => e.code === 'CANCELLED');
  assert.ok(Date.now() - t0 < 300);
  assert.equal(proc.killAll(), 0, '不应留下进程');
});

test('进度回调出错只记日志，不影响结果', async () => {
  const r = await proc.run(NODE, ['-e', 'process.stdout.write("x")'], { onStdout: () => { throw new Error('解析出错'); } });
  assert.equal(r.code, 0);
  assert.match(logText(), /\[error\] \[proc\] onStdout 回调出错 node(\.exe)? Error: 解析出错/);
});

test('超时：结束进程并报「处理超时」', async () => {
  const t0 = Date.now();
  await assert.rejects(proc.run(NODE, ['-e', HANG], { timeoutMs: 300 }), /处理超时/);
  assert.ok(Date.now() - t0 < 4500);
  assert.match(logText(), /\[warn\] \[proc\] 超时/);
});

test('killAll 结束所有还在运行的子进程（退出镜流时调用）', async (t) => {
  const info = t.mock.method(log, 'info');
  const a = proc.spawnProc(NODE, ['-e', HANG]);
  const b = proc.spawnProc(NODE, ['-e', HANG]);
  const exited = Promise.all([a, b].map((c) => new Promise((r) => c.once('exit', r))));
  assert.equal(proc.killAll(), 2);
  await exited;
  assert.equal(proc.killAll(), 0);
  assert.ok(info.mock.calls.some(({ arguments: [message] }) => message === '[proc] 退出前结束了 2 个子进程'));
});

test('退出时先取消任务再 killAll：已在结束的进程不重复处理', async () => {
  const ac = new AbortController();
  const p = proc.run(NODE, ['-e', HANG], { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 100));
  ac.abort(); // 相当于 jobs.cancelAll()
  assert.equal(proc.killAll(), 0);
  await assert.rejects(p, (e) => e.code === 'CANCELLED');
});

test('写进日志的命令行会脱敏', async () => {
  await proc.run(NODE, ['-e', 'process.exit(2)', '--', 'Authorization: Bearer abcdefghijklmnop123456', 'https://x.test/?key=zzzsecret99']);
  const text = logText();
  assert.match(text, /退出码 2/);
  assert.ok(!text.includes('abcdefghijklmnop123456'));
  assert.ok(!text.includes('zzzsecret99'));
});

test('jobs：list 只列进行中的任务，cancelAll 全部取消并通知界面', async () => {
  const sent = [];
  const jobs = createJobs((ev, data) => sent.push([ev, data]));
  let release;
  const gate = new Promise((r) => { release = r; });
  jobs.start('export', async (job) => { await gate; job.throwIfCancelled(); return 1; }, { name: 'a' });
  jobs.start('analysis', async (job) => { await gate; job.throwIfCancelled(); return 2; });
  const listed = jobs.list();
  assert.deepEqual(listed.map((j) => j.kind).sort(), ['analysis', 'export']);
  assert.ok(listed.every((j) => j.id.startsWith('job_') && typeof j.startedAt === 'number'));
  assert.equal(jobs.cancelAll(), 2);
  assert.equal(jobs.list().length, 0);
  assert.equal(jobs.cancelAll(), 0);
  release();
  await new Promise((r) => setTimeout(r, 30));
  const errs = sent.filter(([ev]) => ev === 'job:error');
  assert.equal(errs.length, 2);
  assert.ok(errs.every(([, d]) => d.cancelled === true && d.error === '已取消'));
  assert.match(logText(), /\[job\] 退出前取消了 2 个任务/);
});

test('jobs：失败写 error 日志并带耗时', async () => {
  const sent = [];
  const jobs = createJobs((ev, data) => sent.push([ev, data]));
  jobs.start('import', async () => { throw new Error('文件读不了'); });
  await new Promise((r) => setTimeout(r, 30));
  const err = sent.find(([ev]) => ev === 'job:error');
  assert.equal(err[1].error, '文件读不了');
  assert.equal(err[1].cancelled, false);
  assert.match(logText(), /\[error\] \[job import\] 失败 job_\w+ \d+\.\ds Error: 文件读不了/);
});
