import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const asr = require('../electron/lib/asr.cjs');

const tmpDirs = [];
function makeTmpDir(prefix) {
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

test('wav 抽取命令行', async () => {
  const args = asr.buildWavArgs('in.mp4', 'out.wav', { start: 2, duration: 5 });
  assert.deepEqual(args.slice(-14), ['-i', 'in.mp4', '-t', '5', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'out.wav']);
  assert.ok(args.includes('-ss') && args.join(' ').includes('-ac 1 -ar 16000'));
  assert.equal(args[args.length - 1], 'out.wav');
  const dir = makeTmpDir('ff-asr-wav-');
  try {
    let called;
    const out = path.join(dir, 'a.wav');
    await asr.extractWav('ffmpeg', 'x.mp4', out, { run: async (b, a) => { called = [b, a]; return { code: 0 }; } });
    assert.equal(called[0], 'ffmpeg');
    await assert.rejects(asr.extractWav('ffmpeg', 'x.mp4', out, { run: async () => ({ code: 1, stderr: 'boom' }) }), /boom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('解析 whisper.cpp JSON', () => {
  const j = { transcription: [
    { timestamps: { from: '00:00:00,000', to: '00:00:02,500' }, offsets: { from: 0, to: 2500 }, text: ' 大家好，欢迎来到镜流。',
      tokens: [{ text: '[_BEG_]', offsets: { from: 0, to: 0 } }, { text: '大家', offsets: { from: 0, to: 800 } }] },
    { timestamps: { from: '00:00:02,500', to: '00:00:03,000' }, text: '[BLANK_AUDIO]' },
  ] };
  const s = asr.parseWhisperJson(JSON.stringify(j));
  assert.equal(s.length, 1);
  assert.equal(s[0].end, 2.5);
  assert.equal(s[0].words.length, 1);
});

test('解析 OpenAI verbose_json', () => {
  const s = asr.parseOpenAIVerbose({ text: 'x', segments: [{ start: 0, end: 1, text: '你好' }, { start: 1, end: 2, text: '世界' }],
    words: [{ word: '你好', start: 0, end: 0.9 }, { word: '世界', start: 1.1, end: 1.8 }] });
  assert.equal(s.length, 2);
  assert.equal(s[1].words[0].text, '世界');
  assert.equal(asr.parseOpenAIVerbose({ text: '仅文本', duration: 3 })[0].end, 3);
});

test('中文断句与去标点', () => {
  const out = asr.splitSentences([{ start: 0, end: 6, text: '今天天气很好。我们去公园散步吧！好的' }]);
  assert.equal(out.length, 3);
  assert.equal(out[0].text, '今天天气很好');
  assert.ok(out[0].end <= out[1].start + 1e-6);
  assert.equal(asr.stripPunct('Hello, world！你 好'), 'Hello world 你好');
  const long = asr.splitSentences([{ start: 0, end: 10, text: '一'.repeat(70) }]);
  assert.ok(long.length >= 3);
});

test('whisper 转写（mock 子进程）', async () => {
  const dir = makeTmpDir('ff-asr-wh-');
  try {
    let args;
    const segs = await asr.transcribeWhisper({ bin: 'whisper-cli', model: 'm.bin', wav: path.join(dir, 'a.wav'), lang: 'zh', tmpDir: dir,
      run: async (b, a, o) => { args = a; o.onStderr('progress = 50%'); const of = a[a.indexOf('-of') + 1];
        fs.writeFileSync(of + '.json', JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1000 }, text: '测试' }] })); return { code: 0 }; } });
    assert.ok(args.includes('-oj') && args.includes('-l'));
    assert.deepEqual(segs, [{ start: 0, end: 1, text: '测试' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OpenAI 转写（mock fetch）', async () => {
  const dir = makeTmpDir('ff-asr-oai-');
  try {
    const wav = path.join(dir, 'a.wav');
    fs.writeFileSync(wav, Buffer.alloc(100));
    let url;
    const segs = await asr.transcribeOpenAI({ wav, key: 'k', fetchImpl: async (u, o) => { url = u; assert.ok(o.body instanceof FormData);
      return { ok: true, json: async () => ({ segments: [{ start: 0, end: 1, text: '嗨' }] }) }; } });
    assert.match(url, /audio\/transcriptions$/);
    assert.equal(segs[0].text, '嗨');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findModel / findWhisperBin', () => {
  const ud = makeTmpDir('ff-asr-ud-');
  try {
    assert.equal(asr.findModel(ud), null);
    fs.mkdirSync(path.join(ud, 'models'));
    fs.writeFileSync(path.join(ud, 'models', 'ggml-base.bin'), Buffer.alloc(2 * 1024 * 1024));
    assert.equal(asr.findModel(ud).name, 'base');
    fs.mkdirSync(path.join(ud, 'bin', 'whisper', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(ud, 'bin', 'whisper', 'Release', asr.BIN_NAMES[0]), '');
    assert.ok(asr.findWhisperBin(ud));
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});
