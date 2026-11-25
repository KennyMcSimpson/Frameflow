'use strict';
// ASR IPC：asr:status、asr:transcribe（job 'asr'）、asr:installModel（job 'asr-install'）。见 PLAN-v3 §4。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asr = require('../lib/asr.cjs');
const { run } = require('../lib/proc.cjs');
const { isUncPath } = require('../lib/urlSafety.cjs');

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
    try {
      const file = path.join(ctx.paths.projectDir(projectId), 'project.json');
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const p = JSON.parse(raw);
      const assets = p && p.assets;
      let a = null;
      if (Array.isArray(assets)) {
        a = assets.find((x) => x && x.id === assetId) || null;
      } else if (assets && typeof assets === 'object' && Object.prototype.hasOwnProperty.call(assets, assetId)) {
        a = assets[assetId];
      }
      if (!a || typeof a !== 'object') return null;
      if (a.originalPath && !isUncPath(a.originalPath) && fs.existsSync(a.originalPath)) return a.originalPath;
      if (a.path && !isUncPath(a.path)) return a.path;
      return null;
    } catch {
      return null;
    }
  }

  handle('asr:status', async () => status());

  handle('asr:transcribe', async ({ projectId, assetId, audioPath, lang = 'zh', start, duration, punct = false } = {}) => {
    if (audioPath && isUncPath(audioPath)) throw new Error('出于安全考虑，不允许识别网络路径（UNC）文件');
    const input = audioPath || resolveMedia(projectId, assetId);
    if (!input || isUncPath(input) || !fs.existsSync(input)) throw new Error('找不到要识别的音视频文件');
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
      const s = settings();
      const extraDirs = [s.asr && s.asr.whisperDir].filter(Boolean);
      const binDir = path.join(ud, 'bin', 'whisper');
      if (withBinary && !asr.findWhisperBin(ud, extraDirs)) {
        if (process.platform !== 'win32') {
          throw new Error('自动下载本地 Whisper 识别程序目前仅支持 Windows，请手动安装 whisper-cli 或在设置中填写 OpenAI Key');
        }
        const zip = path.join(tmp(), `whisper-bin-${crypto.randomBytes(4).toString('hex')}.zip`);
        try {
          await asr.download(asr.WHISPER_BIN_ZIP, zip, {
            signal: job.signal,
            maxBytes: 100 * 1024 * 1024,
            onProgress: (p) => job.progress('下载识别程序', p * 0.15, `${Math.round(p * 100)}%`),
          });
          const expectedSha256 = String(asr.WHISPER_BIN_SHA256 || '').trim().toLowerCase();
          if (expectedSha256) {
            if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
              throw new Error('识别程序校验配置无效');
            }
            job.progress('校验识别程序', 0.155, '');
            const actualSha256 = await asr.sha256File(zip);
            if (actualSha256 !== expectedSha256) {
              const err = new Error('识别程序安装包校验不一致，已删除，请重试');
              err.code = 'CHECKSUM_MISMATCH';
              throw err;
            }
          }
          job.progress('解压识别程序', 0.16, '');
          fs.mkdirSync(binDir, { recursive: true });
          const psFull = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
          const psBin = fs.existsSync(psFull) ? psFull : 'powershell.exe';
          // 使用 .NET ZipFile 逐条校验路径不越界（防 Zip Slip）后再解压
          const psScript = [
            'Add-Type -AssemblyName System.IO.Compression.FileSystem',
            '$zipPath = $env:FF_ASR_ZIP',
            '$destDir = [System.IO.Path]::GetFullPath($env:FF_ASR_DEST)',
            'if (-not $destDir.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $destDir += [System.IO.Path]::DirectorySeparatorChar }',
            '$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)',
            'try {',
            '  foreach ($entry in $archive.Entries) {',
            '    $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($destDir, $entry.FullName))',
            '    if (-not $full.StartsWith($destDir, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Zip entry escapes target directory: $($entry.FullName)" }',
            '    if ($entry.FullName.EndsWith("/") -or $entry.FullName.EndsWith("\\")) {',
            '      [System.IO.Directory]::CreateDirectory($full) | Out-Null',
            '    } else {',
            '      $parent = [System.IO.Path]::GetDirectoryName($full)',
            '      if ($parent) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }',
            '      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $full, $true)',
            '    }',
            '  }',
            '} finally { $archive.Dispose() }',
          ].join('; ');
          const r = await run(psBin, ['-NoProfile', '-NonInteractive', '-Command', psScript], {
            signal: job.signal,
            env: { FF_ASR_ZIP: zip, FF_ASR_DEST: binDir },
          });
          const foundBin = asr.findWhisperBin(ud);
          const resolvedBinDir = path.resolve(binDir) + path.sep;
          const insideBinDir = foundBin && path.resolve(foundBin).toLowerCase().startsWith(resolvedBinDir.toLowerCase());
          if (r.code !== 0 || !insideBinDir) throw new Error('识别程序解压失败');
        } finally {
          try { fs.unlinkSync(zip); } catch { /* */ }
        }
      }
      const info = asr.MODELS[model];
      const dest = path.join(asr.modelsDir(ud), info.file);
      if (!fs.existsSync(dest) || !(await asr.verifyModel(dest, model))) {
        await asr.download(info.url, dest, { signal: job.signal, maxBytes: 1024 * 1024 * 1024, onProgress: (p, got, total) => job.progress('下载模型', 0.18 + p * 0.77, `${(got / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`) });
        job.progress('校验模型', 0.96, '');
        if (!(await asr.verifyModel(dest, model))) { try { fs.unlinkSync(dest); } catch { /* */ } throw new Error('模型校验失败，请重试'); }
      }
      job.progress('完成', 1, '');
      return status();
    }, { model });
  });
};
