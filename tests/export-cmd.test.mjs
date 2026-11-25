// export.cjs 测试：buildExportArgs 纯函数 + 真实 ffmpeg 帧管道编码 + IPC 会话流程（begin/frame/end/cancel）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const registerExport = require('../electron/ipc/export.cjs');
const { buildExportArgs, atempoChain, normalizeSegments } = registerExport._internals;
const { createJobs } = require('../electron/lib/jobs.cjs');

let ffmpeg = null;
let ffprobe = null;
try { ffmpeg = require('ffmpeg-static'); } catch {}
try { ffprobe = require('ffprobe-static').path; } catch {}
const haveBins = !!(ffmpeg && fs.existsSync(ffmpeg) && ffprobe && fs.existsSync(ffprobe));

const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

// ───────────── 纯函数 ─────────────

test('atempoChain 把倍速拆成 0.5..2 的乘积', () => {
  assert.deepEqual(atempoChain(1), []);
  assert.deepEqual(atempoChain(2), [2]);
  assert.deepEqual(atempoChain(4), [2, 2]);
  assert.deepEqual(atempoChain(0.25), [0.5, 0.5]);
  assert.deepEqual(atempoChain(3), [2, 1.5]);
  const c = atempoChain(0.3);
  assert.equal(c[0], 0.5);
  assert.ok(Math.abs(c.reduce((a, b) => a * b, 1) - 0.3) < 1e-6);
  for (const f of atempoChain(7.3)) assert.ok(f >= 0.5 && f <= 2);
  assert.deepEqual(atempoChain(0), []);
  assert.deepEqual(atempoChain(NaN), []);
});

test('buildExportArgs：0 段音频 → anullsrc 静音轨', () => {
  const args = buildExportArgs({ output: 'C:\\out\\a.part.mp4', width: 1920, height: 1080, fps: 30, quality: 'high', audioPlan: { duration: 2, segments: [] }, duration: 2 });
  assert.deepEqual(args.slice(args.indexOf('image2pipe') - 1, args.indexOf('image2pipe') + 7), ['-f', 'image2pipe', '-framerate', '30', '-c:v', 'mjpeg', '-i', '-']);
  assert.ok(args.includes('anullsrc=r=48000:cl=stereo'));
  assert.equal(args[args.indexOf('anullsrc=r=48000:cl=stereo') - 2], '2'); // -t 2 -i anullsrc
  assert.ok(!args.includes('-filter_complex'));
  const maps = args.map((a, i) => (a === '-map' ? args[i + 1] : null)).filter(Boolean);
  assert.deepEqual(maps, ['0:v', '1:a']);
  assert.equal(argAfter(args, '-crf'), '18');
  assert.equal(argAfter(args, '-c:v') , 'mjpeg');
  assert.ok(args.includes('libx264'));
  assert.equal(argAfter(args, '-pix_fmt'), 'yuv420p');
  assert.equal(argAfter(args, '-preset'), 'veryfast');
  assert.equal(argAfter(args, '-r'), '30');
  assert.equal(argAfter(args, '-b:a'), '192k');
  assert.equal(argAfter(args, '-movflags'), '+faststart');
  assert.equal(args[args.length - 1], 'C:\\out\\a.part.mp4');
  assert.equal(args[args.lastIndexOf('-t')], '-t');
  assert.equal(args[args.lastIndexOf('-t') + 1], '2');
});

test('buildExportArgs：质量档与偶数尺寸', () => {
  const base = { output: 'o.mp4', fps: 24, audioPlan: { duration: 1, segments: [] }, duration: 1 };
  assert.equal(argAfter(buildExportArgs({ ...base, width: 1280, height: 720, quality: 'standard' }), '-crf'), '21');
  assert.equal(argAfter(buildExportArgs({ ...base, width: 1280, height: 720, quality: 'small' }), '-crf'), '26');
  assert.equal(argAfter(buildExportArgs({ ...base, width: 1280, height: 720, quality: '???' }), '-crf'), '18');
  const odd = buildExportArgs({ ...base, width: 1281, height: 719 });
  assert.match(argAfter(odd, '-vf'), /^scale=1280:718:flags=bicubic\S*:in_color_matrix=bt601:in_range=full:out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1$/);
  for (const [k, v] of [['-colorspace', 'bt709'], ['-color_primaries', 'bt709'], ['-color_trc', 'bt709'], ['-color_range', 'tv'], ['-pix_fmt', 'yuv420p']]) {
    assert.equal(argAfter(odd, k), v, k);
  }
  assert.throws(() => buildExportArgs({ output: 'o.mp4', fps: 30, width: 100, height: 100, audioPlan: { duration: 0, segments: [] } }), /时长/);
  assert.throws(() => buildExportArgs({ fps: 30, duration: 1 }), /导出路径/);
  // totalFrames 推导时长
  const tf = buildExportArgs({ output: 'o.mp4', fps: 30, width: 100, height: 100, totalFrames: 45 });
  assert.equal(tf[tf.lastIndexOf('-t') + 1], '1.5');
});

test('buildExportArgs：1 段音频 → 无 amix，含淡入淡出与延迟', () => {
  const seg = { path: 'C:\\m\\music.mp3', timelineStart: 1.25, srcIn: 3, srcOut: 7, speed: 1, volume: 0.8, fadeIn: 0.5, fadeOut: 1 };
  const args = buildExportArgs({ output: 'o.mp4', width: 1920, height: 1080, fps: 30, audioPlan: { duration: 10, segments: [seg] }, duration: 10 });
  const i = args.indexOf('C:\\m\\music.mp3');
  assert.deepEqual(args.slice(i - 5, i + 1), ['-ss', '3', '-t', '4', '-i', 'C:\\m\\music.mp3']);
  const fc = argAfter(args, '-filter_complex');
  assert.equal(fc,
    '[1:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=0.8,afade=t=in:st=0:d=0.5,afade=t=out:st=3:d=1,adelay=1250|1250[a0];' +
    '[a0]apad,atrim=start=0:end=10[aout]');
  assert.ok(!fc.includes('amix'));
  assert.ok(!args.includes('anullsrc=r=48000:cl=stereo'));
  const maps = args.map((a, k) => (a === '-map' ? args[k + 1] : null)).filter(Boolean);
  assert.deepEqual(maps, ['0:v', '[aout]']);
});

test('buildExportArgs：多段 → amix normalize=0，跳过无效段', () => {
  const segs = [
    { path: 'a.wav', timelineStart: 0, srcIn: 0, srcOut: 2, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 },
    { path: 'b.wav', timelineStart: 2, srcIn: 1, srcOut: 3, speed: 1, volume: 1.5, fadeIn: 0.2, fadeOut: 0.2 },
    { path: 'bad.wav', timelineStart: 0, srcIn: 2, srcOut: 2, speed: 1, volume: 1 },   // 零长度
    { path: 'late.wav', timelineStart: 99, srcIn: 0, srcOut: 2, speed: 1, volume: 1 },  // 超出时长
    { path: 'mute.wav', timelineStart: 0, srcIn: 0, srcOut: 2, speed: 1, volume: 0 },   // 静音
    { path: 'c.wav', timelineStart: 0.5, srcIn: 0, srcOut: 4, speed: 1, volume: 0.3, fadeIn: 1, fadeOut: 1 },
  ];
  const args = buildExportArgs({ output: 'o.mp4', width: 640, height: 360, fps: 25, audioPlan: { duration: 5, segments: segs }, duration: 5 });
  const inputs = args.map((a, k) => (a === '-i' ? args[k + 1] : null)).filter(Boolean);
  assert.deepEqual(inputs, ['-', 'a.wav', 'b.wav', 'c.wav']);
  const fc = argAfter(args, '-filter_complex');
  const parts = fc.split(';');
  assert.equal(parts.length, 4);
  assert.ok(parts[0].startsWith('[1:a]') && parts[0].endsWith('[a0]'));
  assert.ok(!parts[0].includes('adelay') && !parts[0].includes('afade') && !parts[0].includes('volume'));
  assert.ok(parts[1].startsWith('[2:a]') && parts[1].includes('volume=1.5') && parts[1].includes('adelay=2000|2000'));
  assert.ok(parts[2].startsWith('[3:a]') && parts[2].includes('adelay=500|500'));
  assert.equal(parts[3], '[a0][a1][a2]amix=inputs=3:normalize=0:dropout_transition=0,apad,atrim=start=0:end=5[aout]');
});

test('buildExportArgs：变速段 → atempo 链，淡出起点按变速后时长', () => {
  const seg = { path: 's.wav', timelineStart: 0, srcIn: 0, srcOut: 6, speed: 3, volume: 1, fadeIn: 0, fadeOut: 0.5 };
  const args = buildExportArgs({ output: 'o.mp4', width: 640, height: 360, fps: 30, audioPlan: { duration: 2, segments: [seg] }, duration: 2 });
  const fc = argAfter(args, '-filter_complex');
  assert.ok(fc.includes('atempo=2,atempo=1.5'), fc);
  assert.ok(fc.includes('afade=t=out:st=1.5:d=0.5'), fc); // 段时长 6/3=2 秒
  const slow = buildExportArgs({ output: 'o.mp4', width: 640, height: 360, fps: 30, audioPlan: { duration: 8, segments: [{ ...seg, speed: 0.25, srcOut: 2 }] }, duration: 8 });
  assert.ok(argAfter(slow, '-filter_complex').includes('atempo=0.5,atempo=0.5'));
  // 淡入淡出超过段长 → 等比缩小
  const n = normalizeSegments({ segments: [{ path: 'x', srcIn: 0, srcOut: 1, speed: 1, volume: 1, fadeIn: 1, fadeOut: 1 }] }, 10);
  assert.ok(Math.abs(n[0].fadeIn + n[0].fadeOut - 1) < 1e-9);
});

// ───────────── 真实 ffmpeg ─────────────

function runBin(bin, args) {
  const r = spawnSync(bin, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(bin)} 失败：${String(r.stderr).slice(-500)}`);
  return r;
}

function probe(file) {
  const r = runBin(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', file]);
  return JSON.parse(String(r.stdout));
}

let fixture = null;
function getFixture() {
  if (fixture) return fixture;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-export-test-'));
  runBin(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-frames:v', '30', '-q:v', '3', path.join(dir, 'f_%03d.jpg')]);
  const frames = fs.readdirSync(dir).filter((n) => /^f_\d+\.jpg$/.test(n)).sort().map((n) => fs.readFileSync(path.join(dir, n)));
  const sine = path.join(dir, 'sine.wav');
  runBin(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'pcm_s16le', sine]);
  fixture = { dir, frames, sine };
  return fixture;
}

function encode(args, frames) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}：${err.slice(-800)}`))));
    child.stdin.on('error', () => {});
    (async () => {
      for (const f of frames) {
        if (!child.stdin.write(f)) await new Promise((r) => child.stdin.once('drain', r));
      }
      child.stdin.end();
    })();
  });
}

function checkOutput(file, expectDur = 1) {
  assert.ok(fs.existsSync(file), '输出文件应存在');
  const info = probe(file);
  const dur = parseFloat(info.format.duration);
  assert.ok(Math.abs(dur - expectDur) < 0.15, `时长应约 ${expectDur} 秒，实际 ${dur}`);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  assert.ok(v && v.codec_name === 'h264', '应有 H.264 视频轨');
  assert.ok(a && a.codec_name === 'aac', '应有 AAC 音轨');
  return { info, v, a };
}

test('真实编码：30 帧 JPEG + 单段 sine 音频 → 约 1 秒 mp4', { skip: !haveBins && '缺少 ffmpeg-static/ffprobe-static', timeout: 60000 }, async () => {
  const { dir, frames, sine } = getFixture();
  assert.equal(frames.length, 30);
  const out = path.join(dir, 'one.mp4');
  const args = buildExportArgs({ output: out, width: 320, height: 240, fps: 30, quality: 'standard', totalFrames: 30,
    audioPlan: { duration: 1, segments: [{ path: sine, timelineStart: 0.2, srcIn: 0.5, srcOut: 1.5, speed: 1, volume: 0.8, fadeIn: 0.1, fadeOut: 0.2 }] } });
  await encode(args, frames);
  const { v } = checkOutput(out, 1);
  assert.equal(v.width, 320);
  assert.equal(v.height, 240);
});

test('真实编码：多段 + 变速 + 0 段静音', { skip: !haveBins && '缺少 ffmpeg-static/ffprobe-static', timeout: 60000 }, async () => {
  const { dir, frames, sine } = getFixture();
  const multi = path.join(dir, 'multi.mp4');
  await encode(buildExportArgs({ output: multi, width: 640, height: 480, fps: 30, quality: 'small', totalFrames: 30,
    audioPlan: { duration: 1, segments: [
      { path: sine, timelineStart: 0, srcIn: 0, srcOut: 1.2, speed: 3, volume: 1, fadeIn: 0.05, fadeOut: 0.1 },
      { path: sine, timelineStart: 0.4, srcIn: 1, srcOut: 1.3, speed: 0.5, volume: 0.5, fadeIn: 0, fadeOut: 0 },
      { path: sine, timelineStart: 0.9, srcIn: 0, srcOut: 2, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 },
    ] } }), frames);
  const { v } = checkOutput(multi, 1);
  assert.equal(v.width, 640); // 帧被缩放到导出尺寸
  const silent = path.join(dir, 'silent.mp4');
  await encode(buildExportArgs({ output: silent, width: 320, height: 240, fps: 30, totalFrames: 30, audioPlan: { duration: 1, segments: [] } }), frames);
  checkOutput(silent, 1);
});

// ───────────── IPC 会话流程 ─────────────

function makeCtx() {
  const events = [];
  const handlers = {};
  const jobs = createJobs((ev, data) => events.push({ ev, data }));
  const registered = [];
  const ctx = { paths: { ffmpeg, ffprobe }, jobs, registerMediaPath: (p) => registered.push(p), send() {} };
  registerExport({ handle: (ch, fn) => { handlers[ch] = fn; }, ctx });
  const waitJob = (jobId, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const hit = () => events.find((x) => (x.ev === 'job:done' || x.ev === 'job:error') && x.data.jobId === jobId);
    const existing = hit();
    if (existing) { resolve(existing); return; }
    const deadline = Date.now() + timeoutMs;
    const iv = setInterval(() => {
      const e = hit();
      if (e) { clearInterval(iv); resolve(e); return; }
      if (Date.now() > deadline) { clearInterval(iv); reject(new Error(`waitJob(${jobId}) 超时（${timeoutMs}ms）`)); }
    }, 20);
    if (iv.unref) iv.unref();
  });
  return { handlers, events, waitJob, registered };
}

test('IPC：export:begin/frame/end 完整流程（覆盖已存在文件）', { skip: !haveBins && '缺少 ffmpeg-static/ffprobe-static', timeout: 60000 }, async () => {
  const { dir, frames, sine } = getFixture();
  const { handlers, events, waitJob, registered } = makeCtx();
  for (const ch of ['export:begin', 'export:frame', 'export:end', 'export:cancel']) assert.equal(typeof handlers[ch], 'function');
  const outPath = path.join(dir, 'ipc out.mp4');
  fs.writeFileSync(outPath, 'old'); // 已存在 → 应被覆盖
  const { jobId } = await handlers['export:begin']({ outPath, width: 320, height: 240, fps: 30, quality: 'high', totalFrames: 30,
    audioPlan: { duration: 1, segments: [{ path: sine, timelineStart: 0, srcIn: 0, srcOut: 1, speed: 1, volume: 1, fadeIn: 0.1, fadeOut: 0.1 },
      { path: path.join(dir, '不存在.mp3'), timelineStart: 0, srcIn: 0, srcOut: 1, speed: 1, volume: 1 }] } });
  assert.match(jobId, /^job_/);
  for (const f of frames) {
    const ab = f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength); // 模拟渲染端 ArrayBuffer
    assert.equal(await handlers['export:frame']({ jobId, data: ab }), true);
  }
  await assert.rejects(handlers['export:frame']({ jobId, data: new Uint8Array([1, 2, 3, 4]) }), /JPEG/);
  const res = await handlers['export:end']({ jobId });
  assert.equal(res.path, path.resolve(outPath));
  assert.ok(res.size > 1000);
  assert.ok(Math.abs(res.duration - 1) < 0.15, `duration=${res.duration}`);
  assert.equal(
    fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(outPath) + '.') && f.includes('.part.')).length,
    0,
    'part 文件应已改名',
  );
  checkOutput(outPath, 1);
  assert.deepEqual(registered, [path.resolve(outPath)]);
  const fin = await waitJob(jobId);
  assert.equal(fin.ev, 'job:done');
  assert.equal(fin.data.result.path, path.resolve(outPath));
  const prog = events.filter((e) => e.ev === 'job:progress' && e.data.stage === '渲染与编码');
  assert.ok(prog.some((e) => e.data.message === '第 30/30 帧'));
  await assert.rejects(handlers['export:end']({ jobId }), /不存在或已结束/);
});

test('IPC：export:cancel 杀进程、删 part、任务标记取消', { skip: !haveBins && '缺少 ffmpeg-static/ffprobe-static', timeout: 60000 }, async () => {
  const { dir, frames } = getFixture();
  const { handlers, waitJob } = makeCtx();
  const outPath = path.join(dir, 'cancel.mp4');
  const { jobId } = await handlers['export:begin']({ outPath, width: 320, height: 240, fps: 30, quality: 'small', totalFrames: 300, audioPlan: { duration: 10, segments: [] } });
  for (const f of frames.slice(0, 10)) await handlers['export:frame']({ jobId, data: f });
  assert.equal(await handlers['export:cancel']({ jobId }), true);
  const fin = await waitJob(jobId);
  assert.equal(fin.ev, 'job:error');
  assert.equal(fin.data.cancelled, true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(outPath) + '.') && f.includes('.part.')).length,
    0,
    'part 文件应被删除',
  );
  assert.ok(!fs.existsSync(outPath));
  await assert.rejects(handlers['export:frame']({ jobId, data: frames[0] }), /不存在或已结束/);
});

test('IPC：参数校验与零帧结束', { skip: !haveBins && '缺少 ffmpeg-static/ffprobe-static', timeout: 30000 }, async () => {
  const { dir } = getFixture();
  const { handlers, waitJob } = makeCtx();
  await assert.rejects(handlers['export:begin']({ outPath: '', width: 320, height: 240, fps: 30, totalFrames: 30 }), /保存位置/);
  await assert.rejects(handlers['export:begin']({ outPath: path.join(dir, 'x.mp4'), width: 320, height: 240, fps: 30, totalFrames: 0 }), /没有可导出/);
  await assert.rejects(handlers['export:begin']({ outPath: path.join(dir, 'x.mp4'), width: 320, height: 240, fps: 0, totalFrames: 10 }), /帧率/);
  const { jobId } = await handlers['export:begin']({ outPath: path.join(dir, 'zero.mp4'), width: 320, height: 240, fps: 30, totalFrames: 30, audioPlan: { duration: 1, segments: [] } });
  await assert.rejects(handlers['export:end']({ jobId }), /没有收到任何画面帧/);
  const fin = await waitJob(jobId);
  assert.equal(fin.ev, 'job:error');
  assert.ok(!fs.existsSync(path.join(dir, 'zero.mp4')));
});

after(() => {
  if (fixture) {
    try { fs.rmSync(fixture.dir, { recursive: true, force: true }); } catch {}
    fixture = null;
  }
});

// ---------------- v3：预设命令行 / 音量表达式 / 倒放 / 降噪 / GIF / 仅音频 / 硬件编码 ----------------
const X = registerExport._internals;

test('v3 volumeExpr: 分段线性且逗号已转义', () => {
  assert.equal(X.volumeExpr([]), '1');
  assert.equal(X.volumeExpr([{ t: 1, v: 0.5 }]), '0.5');
  const e = X.volumeExpr([{ t: 0, v: 1 }, { t: 2, v: 0.2 }]);
  assert.equal(e, 'if(lt(t\\,0)\\,1\\,if(lt(t\\,2)\\,1+(-0.8)*(t-0)/2\\,0.2))');
  assert.ok(!/[^\\],/.test(e), '所有逗号必须转义');
});

test('v3 segmentFilter: afftdn / areverse / atempo 保调 / volume eval=frame', () => {
  const [seg] = normalizeSegments({ segments: [{ path: 'a.wav', timelineStart: 1, srcIn: 0, srcOut: 4, speed: 2, volume: 1, reverse: true, denoise: true, volumeKeys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] }] }, 10);
  const f = X.segmentFilter(1, seg, 'a0');
  assert.match(f, /afftdn/);
  assert.ok(f.indexOf('areverse') < f.indexOf('atempo=2'));
  assert.match(f, /volume=if\(.*:eval=frame/);
  assert.match(f, /adelay=1000\|1000/);
});

test('v3 buildExportArgs: 码率 / mov / 硬件编码器 / gif / mp3 / wav', () => {
  const base = { output: 'C:/o.mp4', width: 1080, height: 1920, fps: 30, duration: 2 };
  const br = buildExportArgs({ ...base, bitrate: 10000 });
  assert.ok(br.includes('-b:v') && br.includes('10000k') && !br.includes('-crf'));
  const mov = buildExportArgs({ ...base, format: 'mov' });
  const movFmtIdx = mov.lastIndexOf('-f');
  assert.ok(movFmtIdx >= 0 && mov[movFmtIdx + 1] === 'mov', `缺少输出 -f mov：${mov.join(' ')}`);
  const nv = buildExportArgs({ ...base, encoder: 'h264_nvenc' });
  assert.ok(nv.includes('h264_nvenc') && nv.includes('-b:v') && !nv.includes('-crf'));
  const bogus = buildExportArgs({ ...base, encoder: 'evil' });
  assert.ok(bogus.includes('libx264'));
  const gif = buildExportArgs({ ...base, output: 'C:/o.gif', format: 'gif', width: 480, height: 270, fps: 15 });
  assert.ok(gif.join(' ').includes('palettegen') && gif.includes('gif') && !gif.includes('aac'));
  const mp3 = buildExportArgs({ output: 'C:/o.mp3', format: 'mp3', duration: 2, audioPlan: { segments: [] } });
  assert.ok(!mp3.includes('image2pipe') && mp3.includes('libmp3lame') && mp3.includes('0:a'));
  const wav = buildExportArgs({ output: 'C:/o.wav', audioOnly: true, format: 'wav', duration: 2 });
  assert.ok(wav.includes('pcm_s16le'));
});

test('v3 textsToSrt (主进程内联)', () => {
  const s = X.textsToSrt([{ start: 0.5, end: 1.25, text: 'Hi' }]);
  assert.equal(s, '1\n00:00:00,500 --> 00:00:01,250\nHi\n');
});

test('v3 真实 ffmpeg：音量表达式 + 倒放 + 降噪 + 仅音频 MP3 可编码', { skip: !ffmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exv3-'));
  try {
    const src = path.join(dir, 'tone.wav');
    spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', src]);
    const out = path.join(dir, 'o.mp3');
    const args = buildExportArgs({ output: out, format: 'mp3', duration: 2, audioPlan: { segments: [{ path: src, timelineStart: 0.2, srcIn: 0, srcOut: 3, speed: 1.5, volume: 1, reverse: true, denoise: true, volumeKeys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] }] } });
    const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.statSync(out).size > 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
