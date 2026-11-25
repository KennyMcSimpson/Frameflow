#!/usr/bin/env node
// 准备内置音乐与音效（契约 C16）：产出 build/builtin-audio/*.m4a 和 manifest.json，打包时随 extraResources 进入 resources/builtin-audio。
//
// 音乐：FreePD.com 的曲目。FreePD 首页写明 "This music is all licensed CC0 1.0 Universal Public Domain Dedication"
//   （存档：https://web.archive.org/web/2021/https://freepd.com/）。该站已于 2025 年关闭，
//   所以原文件从 Internet Archive 的 Wayback Machine 取回（id_ 模式返回抓取时的原始字节）。
//   每个文件先核对 Wayback 记录的内容摘要（SHA-1，多年多次抓取一致），再核对本脚本固定的 SHA-256。
// 音效：用 FFmpeg 现场合成，属于本项目自有，按 CC0 提供给用户。
// 处理：音乐两遍 loudnorm 到 -16 LUFS、真峰值 -1.5 dBTP；音效峰值统一到 -3 dBFS；
//   全部转成 48 kHz 立体声 AAC 128 kbps 的 .m4a，并清掉原文件里的元数据和封面。
//
// 用法：node scripts/fetch-builtin-audio.mjs [--dl=<空目录>] [--keep-dl] [--sfx-only] [--print-hashes]
//   --dl           下载目录（必须是空目录，或只含本脚本下载的文件）；默认用系统临时目录，结束后删除
//   --keep-dl      保留下载目录
//   --sfx-only     不下载音乐，只合成音效
//   --print-hashes 只下载并核对 SHA-1，打印各曲 SHA-256 后退出（更换曲目时用来固定哈希）
// 需要 vendor/ffmpeg/bin 下的 ffmpeg（先运行 npm run fetch:ffmpeg）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'build', 'builtin-audio');
const BIN_DIR = path.join(ROOT, 'vendor', 'ffmpeg', 'bin');
const EXE = process.platform === 'win32' ? '.exe' : '';

export const CC0 = { id: 'cc0', name: 'CC0 1.0 公有领域贡献', url: 'https://creativecommons.org/publicdomain/zero/1.0/' };
export const FREEPD_LICENSE_PAGE = 'https://web.archive.org/web/2021/https://freepd.com/';
const SAMPLE_RATE = 48000;
const ENCODE = ['-ar', String(SAMPLE_RATE), '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
const LOUDNORM = 'I=-16:TP=-1.5:LRA=11';
// 音效电平：峰值不超过 -3 dBFS，平均电平不超过 -18 dB（避免方波类提示音听起来比别的响很多）
const SFX_PEAK_DB = -3;
const SFX_MEAN_DB = -18;

// FreePD 曲目。file 为 freepd.com/music/ 下的原文件名，page 为所在分类页，
// ts 为 Wayback 抓取时间，sha1 为 Wayback 记录的内容摘要（base32），sha256 为本脚本固定的哈希。
export const TRACKS = [
  { id: 'music-inspiration', title: 'Inspiration', author: 'Rafael Krux', mood: '欢快', page: 'upbeat', file: 'Inspiration.mp3', ts: '20251011155222', sha1: '5R3VSPPP2ADGLUXSYRHLFMANB7LMYIL5', sha256: 'a254227da398809c79a0c753073a3a92c7341672abc92bb0166b6326e126f0b4' },
  { id: 'music-happy-ukulele', title: 'Happy Whistling Ukulele', author: 'Rafael Krux', mood: '欢快', page: 'upbeat', file: 'Happy Whistling Ukulele.mp3', ts: '20251117234159', sha1: '2YUOY3ZPM5YCSXAGIP5JSN6T5TDYB36H', sha256: 'ed4059c8fba8673d657e85175ff54eaa32cef9e43f688f164bef585e6e65cf15' },
  { id: 'music-slice-of-life', title: 'Slice of Life', author: 'Bryan Teoh', mood: '温馨', page: 'scoring', file: 'Slice of Life.mp3', ts: '20251118020701', sha1: '7HK3B6CXV73EXQ26Q4M2X7NSN7WZQTPJ', sha256: '39e0543fbeb06ced8a5f023daf7375385235238ea9063677f3ff71ab15bc04dc' },
  { id: 'music-funky-energy', title: 'Funky Energy Loop', author: 'Kevin MacLeod', mood: '欢快', page: 'scoring', file: 'Funky Energy Loop.mp3', ts: '20250723181812', sha1: 'ELZCHGYBMLHS2H33T6XLLUEYY6CY3SMP', sha256: 'b7990b4287cc345b2f42af743c96e26e126b2b03adfad661961a28640fb94c55' },
  { id: 'music-lovely-piano', title: 'Lovely Piano Song', author: 'Rafael Krux', mood: '温馨', page: 'romantic', file: 'Lovely Piano Song.mp3', ts: '20250911140711', sha1: 'VH37BKF2IFY4U6TMAMBZFMU65UB6TXZP', sha256: '4c8e8fbda8f2e6cbfa22db6689faa4eb0fd1bb7f3163ade72aff37fdd0fb9388' },
  { id: 'music-horizon-flare', title: 'Horizon Flare', author: 'Alexander Nakarada', mood: '激昂', page: 'romantic', file: 'Horizon Flare.mp3', ts: '20240211063834', sha1: 'XZS2B5I6GNQH7LTBIX3JLIZU5JSGKLYR', sha256: '3f7fbacc5cb6417034945be4067dcfc66d5386619734bf8dad29f6db399c092e' },
  { id: 'music-fireworks', title: 'Fireworks', author: 'Alexander Nakarada', mood: '动感', page: 'electronic', file: 'Fireworks.mp3', ts: '20240211063930', sha1: 'EQVOBSZQKNG4HE5PTCND3BVLI5UHAHO6', sha256: '11d41ba19aca852014844bc9108799c01126d11dcf35e17b7f66a221279bc78e' },
  { id: 'music-arpent', title: 'Arpent', author: 'Kevin MacLeod', mood: '动感', page: 'electronic', file: 'Arpent.mp3', ts: '20250911230628', sha1: 'N2NLIFLYZS5IPVSRLKONUSYZE5N3PAIR', sha256: 'ef06d8b524c196a31954dfb1f3261e7d37459e43f4afd9df31ee2965c6094a56' },
  { id: 'music-3am-west-end', title: '3 am West End', author: 'statusq', mood: '舒缓', page: 'electronic', file: '3 am West End.mp3', ts: '20250911230629', sha1: 'B3NQEXQPOSOZOZSEYGZJWGLNUJR2LIKA', sha256: '590bb9833cfb0d6610a6ac00093f9b3d062d604863d6e44bdac61d526d33cab8' },
  { id: 'music-ice-and-snow', title: 'Ice and Snow', author: 'Rafael Krux', mood: '舒缓', page: 'scoring', file: 'Ice and Snow.mp3', ts: '20250723181824', sha1: 'DVMCPA75QLIJWJ66MC76ORX6YLRPDJ4R', sha256: '61e8c88cff9d24eb03ffa8ab55adfefcaaf3f4e2dabf3dec6816d315f49aa99a' },
  { id: 'music-action-strike', title: 'Action Strike', author: 'Rafael Krux', mood: '激昂', page: 'scoring', file: 'Action Strike.mp3', ts: '20251118020711', sha1: 'HIS4KNGFPDJREX6MBHYZDCIGVSGSYV3C', sha256: '0a2305ad157fc35feceb4c61ff6686f9a8fca504d6f30d883f837449a53d758e' },
  { id: 'music-shenzhen-nightlife', title: 'Shenzhen Nightlife', author: 'Kevin MacLeod', mood: '动感', page: 'world', file: 'Shenzhen Nightlife.mp3', ts: '20251124004205', sha1: '6AGQH22HKYYKY6EMN4BB3CDHUUKTCN2T', sha256: 'd341e5b295429e71ff78c96862f5dd6bd2aa06bab81cb66e9080bb583d764f96' },
];

export const trackUrl = (t) => `https://web.archive.org/web/${t.ts}id_/https://freepd.com/music/${encodeURIComponent(t.file)}`;
export const trackPage = (t) => `https://web.archive.org/web/2021/https://freepd.com/${t.page}.php`;

// RFC 4648 base32（Wayback 的内容摘要用这种写法）
export function base32(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += A[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

// ---------- 音效配方（全部为 FFmpeg 合成，参数决定结果，可重复生成） ----------
const evalSrc = (expr, d) => `aevalsrc=exprs='${expr}':s=${SAMPLE_RATE}:d=${d}`;
const noiseSrc = (d, seed, color = 'pink') => `anoisesrc=d=${d}:c=${color}:r=${SAMPLE_RATE}:a=0.5:s=${seed}`;
const envelope = (expr) => `volume=eval=frame:volume='if(isnan(t),0,${expr})'`;
const panMove = (d, from, to) => `aeval=exprs='val(0)*(1-(${from}+(${to}-${from})*t/${d}))|val(0)*(${from}+(${to}-${from})*t/${d})':c=stereo`;

// 按时间改变滤波器频率（asendcmd），用来做扫频
export function sweepCommands(filter, d, freqAt, step = 0.03) {
  const parts = [];
  for (let t = 0; t < d; t += step) parts.push(`${t.toFixed(3)} ${filter} f ${Math.round(freqAt(t / d))}`);
  return `asendcmd=c='${parts.join(';')}'`;
}

const clickTrain = (times) => times.map(([tk, a]) => `${a}*gte(t,${tk})*(exp(-150*(t-${tk}))*(random(0)*2-1)+0.5*sin(2*PI*900*(t-${tk}))*exp(-90*(t-${tk})))`).join('+');
const square = (f, t0 = 0) => `(sin(2*PI*${f}*(t-${t0}))+sin(6*PI*${f}*(t-${t0}))/3+sin(10*PI*${f}*(t-${t0}))/5)`;
const gate = (a, b) => `between(t,${a},${b})*min(1,(t-${a})/0.006)*min(1,(${b}-t)/0.03)`;

export const SFX = [
  {
    id: 'sfx-whoosh', title: '转场·快速嗖声', mood: '转场', d: 0.9, stereo: true,
    input: noiseSrc(0.9, 11),
    af: [sweepCommands('bandpass', 0.9, (x) => 350 * 10 ** Math.sin(Math.PI * x)), 'bandpass=f=350:t=q:w=1.4',
      envelope('if(lt(t,0.55),pow(t/0.55,2),pow(max(0,(0.9-t)/0.35),1.5))'), panMove(0.9, 0.15, 0.85)],
  },
  {
    id: 'sfx-whoosh-soft', title: '转场·轻柔扫过', mood: '转场', d: 1.3, stereo: true,
    input: noiseSrc(1.3, 23),
    af: [sweepCommands('bandpass', 1.3, (x) => 250 * 7.2 ** Math.sin(Math.PI * x)), 'bandpass=f=250:t=q:w=1.0',
      envelope('pow(sin(PI*min(1,t/1.3)),2)'), panMove(1.3, 0.8, 0.2)],
  },
  {
    id: 'sfx-riser', title: '转场·上升铺垫', mood: '转场', d: 2.2,
    input: evalSrc('0.35*sin(2*PI*(220*t+300*t*t))+0.2*sin(4*PI*(220*t+300*t*t))+0.45*(random(0)*2-1)', 2.2),
    af: [sweepCommands('lowpass', 2.2, (x) => 400 * 30 ** x), 'lowpass=f=400',
      envelope('pow(min(1,t/2.1),1.6)*min(1,max(0,(2.2-t)/0.1))')],
  },
  {
    id: 'sfx-impact', title: '强调·重低音冲击', mood: '强调', d: 1.4,
    input: evalSrc('(0.8*sin(2*PI*(58*t-10*t*t))*exp(-3*t)+0.5*sin(2*PI*115*t)*exp(-14*t)+0.6*(random(0)*2-1)*exp(-28*t))*min(1,t/0.002)', 1.4),
    af: ['lowpass=f=6000', 'aecho=0.8:0.35:45|90:0.25|0.15'],
  },
  {
    id: 'sfx-click', title: '界面·点击', mood: '界面', d: 0.07,
    input: evalSrc('(0.55*sin(2*PI*2600*t)+0.45*(random(0)*2-1))*exp(-85*t)', 0.07),
    af: ['highpass=f=700'],
  },
  {
    id: 'sfx-pop', title: '界面·弹出', mood: '界面', d: 0.2,
    input: evalSrc('sin(2*PI*(380*t+2600*t*t))*exp(-18*t)*min(1,t/0.003)', 0.2),
    af: ['lowpass=f=5000'],
  },
  {
    id: 'sfx-ding', title: '提示·叮', mood: '提示', d: 1.6,
    input: evalSrc('(0.6*sin(2*PI*1318.5*t)*exp(-3*t)+0.3*sin(2*PI*2637*t)*exp(-5*t)+0.15*sin(2*PI*3955.5*t)*exp(-8*t)+0.08*sin(2*PI*5537.7*t)*exp(-11*t))*min(1,t/0.004)', 1.6),
    af: ['aecho=0.8:0.5:55|105:0.18|0.1'],
  },
  {
    id: 'sfx-success', title: '提示·完成', mood: '提示', d: 1.0,
    input: evalSrc('min(1,t/0.003)*(0.5*sin(2*PI*1046.5*t)+0.15*sin(2*PI*2093*t))*exp(-7*t)+min(1,max(0,t-0.12)/0.003)*(0.5*sin(2*PI*1568*(t-0.12))+0.15*sin(2*PI*3136*(t-0.12)))*exp(-5*max(0,t-0.12))', 1.0),
    af: ['aecho=0.8:0.45:60:0.15'],
  },
  {
    id: 'sfx-error', title: '提示·错误', mood: '提示', d: 0.5,
    input: evalSrc(`0.5*${gate(0, 0.17)}*${square(330)}+0.5*${gate(0.21, 0.44)}*${square(247, 0.21)}`, 0.5),
    af: ['lowpass=f=3500'],
  },
  {
    id: 'sfx-typing', title: '拟音·键盘打字', mood: '拟音', d: 1.6,
    input: evalSrc(clickTrain([[0, 0.9], [0.13, 0.7], [0.21, 0.85], [0.37, 0.75], [0.45, 1], [0.62, 0.7], [0.71, 0.9], [0.8, 0.8], [0.98, 0.95], [1.07, 0.7], [1.26, 0.85], [1.34, 0.75], [1.47, 0.9]]), 1.6),
    af: ['bandpass=f=2300:t=q:w=0.9', 'highpass=f=400'],
  },
  {
    id: 'sfx-shutter', title: '拟音·相机快门', mood: '拟音', d: 0.32,
    input: evalSrc('(exp(-110*t)+0.8*gte(t,0.11)*exp(-80*(t-0.11)))*(random(0)*2-1)+0.3*gte(t,0.11)*sin(2*PI*1400*(t-0.11))*exp(-60*(t-0.11))', 0.32),
    af: ['bandpass=f=2600:t=q:w=0.8'],
  },
];

// ---------- 小工具 ----------
function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1048576 });
  if (r.status !== 0) {
    const tail = String(r.stderr || r.error || '').split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
    throw new Error(`${path.basename(bin)} 失败（退出码 ${r.status}）：${tail}`);
  }
  return r;
}

export function parseLoudnorm(stderr) {
  const i = String(stderr).lastIndexOf('{');
  const j = String(stderr).lastIndexOf('}');
  if (i < 0 || j < i) return null;
  try {
    const o = JSON.parse(String(stderr).slice(i, j + 1));
    const keys = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'];
    return keys.every((k) => Number.isFinite(Number(o[k]))) ? o : null;
  } catch { return null; }
}

export function parseVolume(stderr, which = 'max') {
  const m = new RegExp(`${which}_volume:\\s*(-?[\\d.]+|-inf) dB`).exec(String(stderr));
  if (!m || m[1] === '-inf') return null;
  return Number(m[1]);
}

// 音效增益：同时满足峰值和平均电平两个上限
export function sfxGain(peak, mean) {
  return Math.min(SFX_PEAK_DB - peak, mean === null ? Infinity : SFX_MEAN_DB - mean);
}

function probeDuration(ffprobe, file) {
  const r = run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return Math.round(Number(r.stdout.trim()) * 1000) / 1000;
}

function metaArgs(title, artist, comment) {
  return ['-metadata', `title=${title}`, '-metadata', `artist=${artist}`, '-metadata', `comment=${comment}`];
}

function hashFile(file, algo) {
  return crypto.createHash(algo).update(fs.readFileSync(file)).digest();
}

async function download(url, dest) {
  const part = `${dest}.part`;
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Frameflow-build-script' },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
      fs.renameSync(part, dest);
      return;
    } catch (e) {
      lastErr = e;
      try { fs.rmSync(part, { force: true }); } catch {}
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw new Error(`下载失败：${url}（${lastErr && lastErr.message}）`);
}

function prepareDlDir(dlArg) {
  if (!dlArg) return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'frameflow-audio-')), temp: true };
  const dir = path.resolve(dlArg);
  fs.mkdirSync(dir, { recursive: true });
  const allowed = new Set(TRACKS.flatMap((t) => [t.file, `${t.file}.part`]));
  const extra = fs.readdirSync(dir).filter((n) => !allowed.has(n));
  if (extra.length) throw new Error(`下载目录不是空目录，含有其它文件：${extra.slice(0, 5).join(', ')}`);
  return { dir, temp: false };
}

// 下载一首并核对：先 Wayback 的 SHA-1 摘要，再固定的 SHA-256（未固定时只返回算出的值）
async function fetchTrack(t, dir) {
  const dest = path.join(dir, t.file);
  if (!(fs.existsSync(dest) && t.sha256 && hashFile(dest, 'sha256').toString('hex') === t.sha256)) {
    fs.rmSync(dest, { force: true });
    await download(trackUrl(t), dest);
  }
  const sha1 = base32(hashFile(dest, 'sha1'));
  if (sha1 !== t.sha1) throw new Error(`${t.file} 的 SHA-1 与 Wayback 记录不符：${sha1} ≠ ${t.sha1}`);
  const sha256 = hashFile(dest, 'sha256').toString('hex');
  if (t.sha256 && sha256 !== t.sha256) throw new Error(`${t.file} 的 SHA-256 不符：${sha256} ≠ ${t.sha256}`);
  return { dest, sha256 };
}

function encodeMusic(ffmpeg, t, src, dst) {
  const p1 = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-i', src, '-vn', '-af', `loudnorm=${LOUDNORM}:print_format=json`, '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1048576 });
  const m = p1.status === 0 ? parseLoudnorm(p1.stderr) : null;
  const ln = m
    ? `loudnorm=${LOUDNORM}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
    : `loudnorm=${LOUDNORM}`;
  run(ffmpeg, ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', src, '-vn', '-map', '0:a:0', '-map_metadata', '-1',
    '-af', ln, ...ENCODE, ...metaArgs(t.title, t.author, 'CC0 1.0 · FreePD.com'), dst]);
}

// 音效滤镜链：源头先做极短淡入淡出防爆音，再走配方效果（回声尾巴可自然衰减），单声道源复制成满电平立体声
export function sfxChain(s) {
  const fadeOut = Math.max(0, s.d - 0.012).toFixed(3);
  const steps = [`afade=t=in:d=0.002`, `afade=t=out:st=${fadeOut}:d=0.012`, ...s.af];
  if (!s.stereo) steps.push('pan=stereo|c0=c0|c1=c0');
  return steps.join(',');
}

function synthSfx(ffmpeg, s, dst) {
  const chain = sfxChain(s);
  // 测量前先降 20 dB：合成信号可能超过满幅，volumedetect 会按 16 位整数截顶，导致峰值读数偏低
  const p1 = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', s.input, '-af', `${chain},volume=-20dB,volumedetect`, '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1048576 });
  const peak = p1.status === 0 ? parseVolume(p1.stderr, 'max') : null;
  if (peak === null) throw new Error(`${s.id} 合成失败：${String(p1.stderr).split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')}`);
  const mean = parseVolume(p1.stderr, 'mean');
  const gain = sfxGain(peak + 20, mean === null ? null : mean + 20).toFixed(2);
  run(ffmpeg, ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', s.input,
    '-af', `${chain},volume=${gain}dB`, ...ENCODE, ...metaArgs(s.title, '镜流 Frameflow', 'CC0 1.0'), dst]);
}

export function manifestItem(kind, src, duration) {
  const base = { id: src.id, kind, title: src.title, mood: src.mood, duration, file: `${src.id}.m4a`, license: { ...CC0 } };
  if (kind === 'music') return { ...base, author: src.author, sourceUrl: trackPage(src) };
  return { ...base, author: '镜流 Frameflow' };
}

function resolveBinaries() {
  const vendorFfmpeg = path.join(BIN_DIR, `ffmpeg${EXE}`);
  const vendorFfprobe = path.join(BIN_DIR, `ffprobe${EXE}`);
  if (fs.existsSync(vendorFfmpeg) && fs.existsSync(vendorFfprobe)) {
    return { ffmpeg: vendorFfmpeg, ffprobe: vendorFfprobe };
  }
  const req = createRequire(import.meta.url);
  let ffmpeg = fs.existsSync(vendorFfmpeg) ? vendorFfmpeg : null;
  let ffprobe = fs.existsSync(vendorFfprobe) ? vendorFfprobe : null;
  if (!ffmpeg) {
    try {
      const p = req('ffmpeg-static');
      if (p && fs.existsSync(p)) ffmpeg = p;
    } catch {}
  }
  if (!ffprobe) {
    try {
      const p = req('ffprobe-static')?.path;
      if (p && fs.existsSync(p)) ffprobe = p;
    } catch {}
  }
  if (!ffmpeg || !ffprobe) {
    throw new Error('缺少 ffmpeg / ffprobe：未找到 vendor/ffmpeg/bin 下的二进制，且无法回退到 ffmpeg-static / ffprobe-static（请先运行 npm run fetch:ffmpeg 或 npm install）');
  }
  return { ffmpeg, ffprobe };
}

async function main() {
  const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
  const flag = (n) => process.argv.includes(`--${n}`);
  const { ffmpeg, ffprobe } = resolveBinaries();

  const items = [];
  const sfxOnly = flag('sfx-only');
  let dl = null;
  try {
    if (sfxOnly) {
      // 只重做音效时保留已有的音乐条目
      try {
        const old = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'manifest.json'), 'utf8'));
        for (const it of old.items || []) {
          if (it.kind === 'music' && fs.existsSync(path.join(OUT_DIR, it.file))) items.push(it);
        }
      } catch {}
    } else {
      dl = prepareDlDir(argOf('dl'));
      console.log('下载目录：', dl.dir);
      const fetched = [];
      for (const t of TRACKS) {
        const r = await fetchTrack(t, dl.dir);
        console.log(`已核对 ${t.file}  sha256=${r.sha256}`);
        fetched.push({ t, ...r });
      }
      if (flag('print-hashes')) {
        for (const f of fetched) console.log(`${f.t.id}\t${f.sha256}`);
        return;
      }
      const unpinned = TRACKS.filter((t) => !t.sha256).map((t) => t.id);
      if (unpinned.length) throw new Error(`以下曲目还没有固定 SHA-256：${unpinned.join(', ')}（先用 --print-hashes 取值写进 TRACKS）`);
      fs.mkdirSync(OUT_DIR, { recursive: true });
      for (const f of fetched) {
        const dst = path.join(OUT_DIR, `${f.t.id}.m4a`);
        encodeMusic(ffmpeg, f.t, f.dest, dst);
        items.push(manifestItem('music', f.t, probeDuration(ffprobe, dst)));
        console.log(`音乐  ${f.t.title}  →  ${path.basename(dst)}`);
      }
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const s of SFX) {
      const dst = path.join(OUT_DIR, `${s.id}.m4a`);
      synthSfx(ffmpeg, s, dst);
      items.push(manifestItem('sfx', s, probeDuration(ffprobe, dst)));
      console.log(`音效  ${s.title}  →  ${path.basename(dst)}`);
    }

    // 清掉清单之外的旧文件，再写清单（先写临时文件再改名）
    const keep = new Set(items.map((it) => it.file));
    for (const n of fs.readdirSync(OUT_DIR)) {
      if (/\.m4a$/i.test(n) && !keep.has(n)) fs.rmSync(path.join(OUT_DIR, n), { force: true });
    }
    const manifest = { version: 1, items };
    const tmp = path.join(OUT_DIR, 'manifest.json.tmp');
    fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, path.join(OUT_DIR, 'manifest.json'));
    const bytes = items.reduce((n, it) => n + fs.statSync(path.join(OUT_DIR, it.file)).size, 0);
    console.log(`完成：${items.filter((i) => i.kind === 'music').length} 首音乐，${items.filter((i) => i.kind === 'sfx').length} 个音效，共 ${(bytes / 1048576).toFixed(1)} MB`);
  } finally {
    if (dl && dl.temp && !flag('keep-dl')) fs.rmSync(dl.dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
