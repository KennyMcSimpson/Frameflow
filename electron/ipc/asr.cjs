'use strict';
// ASR IPC：asr:status、asr:transcribe（job 'asr'）、asr:installModel（job 'asr-install'）。见 PLAN-v3 §4。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asr = require('../lib/asr.cjs');
const { run } = require('../lib/proc.cjs');

module.exports = function register({ handle, ctx }) {
  const userData = () => (ctx.paths && ctx.paths.userData) || require('node:os').tmpdir();
  const settings = () => (ctx.settings && ctx.settings.get && ctx.settings.get()) || {};
  function openaiKey() {
    const st = ctx.settings;
    if (!st || typeof st.getSecret !== 'function') return '';
    try { return st.getSecret('openaiKey') || st.getSecret('openai') || ''; } catch { return ''; }
  }
  function tmp() { try { return ctx.paths.tmp; } catch { return require('node:os').tmpdir(); } }

  function status() {
    const s = settings();
    const prefer = (s.asr && s.asr.model) || 'small';
    const bin = asr.findWhisperBin(userData(), [s.asr && s.asr.whisperDir].filter(Boolean));
    const model = asr.findModel(userData(), prefer);
    if (bin && model) return { ready: true, engine: 'whisper', model: model.name, downloadable: false };
    if (openaiKey()) return { ready: true, engine: 'openai', model: 'whisper-1', downloadable: true };
    return { ready: false, engine: null, model: null, downloadable: true };
  }

  function resolveMedia(projectId, assetId) {
    if (!projectId || !assetId) return null;
    const file = path.join(ctx.paths.projectDir(projectId), 'project.json');
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    const a = (p.assets || []).find((x) => x.id === assetId);
    return a ? (a.originalPath && fs.existsSync(a.originalPath) ? a.originalPath : a.path) : null;
  }

  handle('asr:status', async () => status());

  handle('asr:transcribe', async ({ projectId, assetId, audioPath, lang = 'zh', start, duration, punct = false } = {}) => {
    const input = audioPath || resolveMedia(projectId, assetId);
    if (!input || !fs.existsSync(input)) throw new Error('找不到要识别的音视频文件');
    const st = status();
    if (!st.ready) { const e = new Error('未安装语音识别模型，请先在设置中安装或填写 OpenAI Key'); e.code = 'NO_ASR'; throw e; }
    return ctx.jobs.start('asr', async (job) => {
      const wav = path.join(tmp(), 'asr_' + crypto.randomBytes(5).toString('hex') + '.wav');
      try {
        job.progress('抽取音频', 0.05, '');
        await asr.extractWav(ctx.paths.ffmpeg, input, wav, { signal: job.signal, start, duration });
        job.throwIfCancelled();
        let segs;
        if (st.engine === 'whisper') {
          const s = settings();
          const bin = asr.findWhisperBin(userData(), [s.asr && s.asr.whisperDir].filter(Boolean));
          const model = asr.findModel(userData(), (s.asr && s.asr.model) || 'small');
          job.progress('本地识别中', 0.1, model.name);
          segs = await asr.transcribeWhisper({ bin, model: model.path, wav, lang, signal: job.signal, tmpDir: tmp(), onProgress: (p) => job.progress('本地识别中', 0.1 + p * 0.85, `${Math.round(p * 100)}%`) });
        } else {
          job.progress('云端识别中', 0.3, 'OpenAI');
          const ai = settings().ai || {};
          segs = await asr.transcribeOpenAI({ wav, key: openaiKey(), baseUrl: ai.openaiBaseUrl || undefined, lang, signal: job.signal });
        }
        job.throwIfCancelled();
        const off = Number(start) > 0 ? Number(start) : 0;
        if (off) segs = segs.map((x) => ({ ...x, start: x.start + off, end: x.end + off, ...(x.words ? { words: x.words.map((w) => ({ ...w, start: w.start + off, end: w.end + off })) } : {}) }));
        const segments = asr.splitSentences(segs, { maxChars: 16, punct });
        job.progress('完成', 1, `${segments.length} 条`);
        return { segments, engine: st.engine };
      } finally {
        try { fs.unlinkSync(wav); } catch { /* */ }
      }
    }, { projectId, assetId });
  });

  handle('asr:installModel', async ({ model = 'small', withBinary = true } = {}) => {
    if (!asr.MODELS[model]) throw new Error('未知模型：' + model);
    return ctx.jobs.start('asr-install', async (job) => {
      const ud = userData();
      const binDir = path.join(ud, 'bin', 'whisper');
      if (withBinary && process.platform === 'win32' && !asr.findWhisperBin(ud)) {
        const zip = path.join(tmp(), 'whisper-bin.zip');
        await asr.download(asr.WHISPER_BIN_ZIP, zip, { signal: job.signal, onProgress: (p) => job.progress('下载识别程序', p * 0.15, `${Math.round(p * 100)}%`) });
        job.progress('解压识别程序', 0.16, '');
        fs.mkdirSync(binDir, { recursive: true });
        const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${binDir.replace(/'/g, "''")}' -Force`], { signal: job.signal });
        try { fs.unlinkSync(zip); } catch { /* */ }
        if (r.code !== 0 || !asr.findWhisperBin(ud)) throw new Error('识别程序解压失败');
      }
      const info = asr.MODELS[model];
      const dest = path.join(asr.modelsDir(ud), info.file);
      if (!fs.existsSync(dest) || !(await asr.verifyModel(dest, model))) {
        await asr.download(info.url, dest, { signal: job.signal, onProgress: (p, got, total) => job.progress('下载模型', 0.18 + p * 0.77, `${(got / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`) });
        job.progress('校验模型', 0.96, '');
        if (!(await asr.verifyModel(dest, model))) { try { fs.unlinkSync(dest); } catch { /* */ } throw new Error('模型校验失败，请重试'); }
      }
      job.progress('完成', 1, '');
      return status();
    }, { model });
  });
};
