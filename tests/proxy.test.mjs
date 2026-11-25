// 剪辑代理（lib/proxy.cjs）单元测试。运行：node --test tests/proxy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const proxy = require('../electron/lib/proxy.cjs');

test('needsEditProxy：4K / HEVC 需要，1080p H.264 不需要', () => {
  assert.equal(proxy.needsEditProxy({ kind: 'video', width: 3840, height: 2160, vcodec: 'h264' }), true);
  assert.equal(proxy.needsEditProxy({ kind: 'video', width: 1920, height: 1080, vcodec: 'hevc' }), true);
  assert.equal(proxy.needsEditProxy({ kind: 'video', width: 1920, height: 1080, vcodec: 'h264' }), false);
  assert.equal(proxy.needsEditProxy({ kind: 'video', width: 1080, height: 1920, vcodec: 'h264' }), false);
  assert.equal(proxy.needsEditProxy({ kind: 'audio' }), false);
  assert.equal(proxy.needsEditProxy(null), false);
});

test('proxyArgs：全 I 帧、540p、竖屏按宽', () => {
  const a = proxy.proxyArgs('in.mov', 'out.mp4', { width: 3840, height: 2160 });
  assert.ok(a.includes('-g') && a[a.indexOf('-g') + 1] === '1');
  assert.ok(a.some((x) => x.startsWith('scale=-2:540')));
  const b = proxy.proxyArgs('in.mov', 'out.mp4', { width: 2160, height: 3840 });
  assert.ok(b.some((x) => x.startsWith('scale=540:-2')));
  assert.equal(a[a.length - 1], 'out.mp4');
});

test('proxyPathFor：稳定且区分签名', () => {
  const p1 = proxy.proxyPathFor('C:\\cache', 'D:\\v\\a b.mov', 's1');
  assert.equal(p1, proxy.proxyPathFor('C:\\cache', 'D:\\v\\a b.mov', 's1'));
  assert.notEqual(p1, proxy.proxyPathFor('C:\\cache', 'D:\\v\\a b.mov', 's2'));
  assert.ok(p1.endsWith('.edit540.mp4'));
});

test('parseTime', () => {
  assert.equal(proxy._internals.parseTime('frame=1 time=00:00:01.50 x time=00:01:02.00'), 62);
  assert.equal(proxy._internals.parseTime('nothing'), null);
});

test('makeEditProxy：真实生成 1440p → 540p 全 I 帧', async () => {
  let ffmpeg, ffprobe;
  try { ffmpeg = require('ffmpeg-static'); ffprobe = require('ffprobe-static').path; } catch { return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-proxy-'));
  const src = path.join(dir, 'src.mp4');
  const r = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=25:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-y', src]);
  assert.equal(r.status, 0, String(r.stderr));
  const out = path.join(dir, 'p', 'out.edit540.mp4');
  let last = 0;
  await proxy.makeEditProxy({ ffmpeg, input: src, output: out, info: { width: 2560, height: 1440, duration: 1 }, onProgress: (p) => { last = p; } });
  assert.equal(last, 1);
  const pr = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height,width:frame=pict_type', '-of', 'json', out]);
  const j = JSON.parse(String(pr.stdout));
  assert.equal(j.streams[0].height, 540);
  assert.ok(j.frames.length > 0 && j.frames.every((f) => f.pict_type === 'I'));
  // 再次调用复用
  const again = await proxy.makeEditProxy({ ffmpeg, input: src, output: out, info: {} });
  assert.equal(again, out);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(proxy.makeEditProxy({ ffmpeg, input: src, output: path.join(dir, 'c.mp4'), info: {}, signal: ac.signal }));
  fs.rmSync(dir, { recursive: true, force: true });
});