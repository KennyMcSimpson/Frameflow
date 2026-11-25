// stability：日志模块（契约 C7）——写盘、轮转、脱敏、队列上限、console 接管。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const log = require('../electron/lib/log.cjs');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-stab-log-'));
  log._reset();
  log.init({ dir, echo: 'none' });
});
afterEach(() => {
  log._reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (name = 'main.log') => fs.readFileSync(path.join(dir, name), 'utf8');

test('写进 userData/logs/main.log，每行带时间和级别', () => {
  log.info('你好', { a: 1 });
  log.warn('注意');
  log.scope('export').error('失败了');
  log.flushSync();
  const text = read();
  assert.match(text, /^\d{4}-\d\d-\d\dT[\d:.]+Z \[info\] 你好 \{ a: 1 \}$/m);
  assert.match(text, /\[warn\] 注意/);
  assert.match(text, /\[error\] \[export\] 失败了/);
  assert.equal(log.logFile(), path.join(dir, 'main.log'));
  assert.equal(log.logDir(), dir);
});

test('超过 2MB 轮转：main.log → main.1.log …，最多保留 5 份', () => {
  fs.writeFileSync(path.join(dir, 'main.log'), 'x'.repeat(log.MAX_BYTES - 10));
  for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(dir, `main.${i}.log`), `old${i}`);
  log.info('新的一行，触发轮转');
  log.flushSync();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
  assert.equal(log.MAX_FILES, 5);
  assert.deepEqual(files, ['main.1.log', 'main.2.log', 'main.3.log', 'main.4.log', 'main.log']);
  assert.match(read(), /触发轮转/);
  assert.equal(fs.statSync(path.join(dir, 'main.1.log')).size, log.MAX_BYTES - 10);
  assert.equal(read('main.2.log'), 'old1');
  assert.equal(read('main.4.log'), 'old3'); // 最老的 old4 被删掉
});

test('脱敏：密钥、令牌、用户目录、大段 base64 都不落盘', () => {
  const home = os.homedir();
  const secrets = ['bearer-secret-abcdefghij', 'abcdefghijklmnopqrstuv', 'json-secret-123', 'ark-secret-456', 'inspect-secret-789', 'query-secret-000', 'A'.repeat(100)];
  log.info('Authorization: Bearer bearer-secret-abcdefghij');
  log.info('key is sk-proj-abcdefghijklmnopqrstuv');
  log.info('{"apiKey":"json-secret-123","arkKey":"ark-secret-456"}');
  log.info({ openaiKey: 'inspect-secret-789', name: '普通字段' });
  log.info('GET https://example.com/api?key=query-secret-000&q=1');
  log.info(`打开 ${home}\\Videos\\私人.mp4`);
  log.info('data:image/png;base64,' + 'A'.repeat(200));
  log.flushSync();
  const text = read();
  for (const s of secrets) assert.ok(!text.includes(s), `泄露了 ${s.slice(0, 20)}`);
  assert.ok(!text.toLowerCase().includes(home.toLowerCase()), '用户目录没有脱敏');
  assert.match(text, /~[\\/]Videos[\\/]私人\.mp4/);
  assert.match(text, /普通字段/);
});

test('单条超长内容截断', () => {
  log.info('z'.repeat(40 * 1024));
  log.flushSync();
  const text = read();
  assert.ok(text.length < 20 * 1024);
  assert.match(text, /已截断，原长 40960 字符/);
});

test('目录还没就绪时只排队，队列有上限：丢最老的并记一条提示', () => {
  log._reset(); // 没有目录
  const big = 'y'.repeat(10 * 1024);
  for (let i = 0; i < 150; i++) log.info(`第${i}条`, big);
  log.init({ dir, echo: 'none' });
  log.flushSync();
  const text = read();
  assert.ok(Buffer.byteLength(text) < 1.1 * 1024 * 1024, '队列应限制在约 1MB');
  assert.match(text, /丢弃了 \d+ 条日志/);
  assert.match(text, /第149条/); // 最新的保留
  assert.ok(!text.includes('第0条 '), '最老的应被丢弃');
});

test('接管 console：控制台照常输出，同时写一份到日志', () => {
  log.takeOverConsole();
  log.takeOverConsole(); // 重复调用无副作用
  console.warn('来自 console.warn 的提醒');
  log.flushSync();
  const text = read();
  assert.match(text, /\[warn\] 来自 console\.warn 的提醒/);
  assert.equal(text.split('来自 console.warn').length - 1, 1, '不应重复写入');
});
