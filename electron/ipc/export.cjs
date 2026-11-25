'use strict';
// 导出：渲染端逐帧送 JPEG → ffmpeg（image2pipe）编码 H.264，同时按 AudioPlan 混音。
// channel：export:begin / export:frame / export:end / export:cancel。见 SPEC §2.2 export.cjs、CONTRACTS AudioPlan。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, spawnProc, killTree } = require('../lib/proc.cjs');
const os = require('node:os');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let ff = null;
try { ff = require('../lib/ff.cjs'); } catch { ff = null; }
// 编码器选择（契约 C12，media 包提供）；模块缺失或出错时回退到旧的硬件探测 + libx264
let encoders = null;
try { encoders = require('../lib/encoders.cjs'); } catch { encoders = null; }

const CRF = { high: 18, standard: 21, small: 26 };
const IDLE_TIMEOUT_MS = 120 * 1000; // 长时间收不到帧（渲染端崩溃/窗口关闭）时中止
const MAX_DURATION = 3600;
const HW_H264 = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf'];
const SAFE_H264 = ['libx264', 'libopenh264', ...HW_H264];
// ffmpeg 输入队列（帧数）。每帧是一张 JPEG，4K 约 2–3 MB：队列过长会占用大量内存，
// 并让「画面已送完、编码还在追」的收尾阶段变长。32 帧约 1 秒缓冲，足够平滑。
const FRAME_QUEUE = 32;

// ───────────────────────── 纯函数：命令构建 ─────────────────────────

function num(n, digits = 3) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  const f = Math.pow(10, digits);
  const r = Math.round(v * f) / f;
  return String(Object.is(r, -0) ? 0 : r);
}

function even(n, fallback) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 2) return fallback;
  return v % 2 === 0 ? v : v - 1;
}

/** 把倍速拆成若干个 [0.5, 2] 区间内因子的乘积（atempo 单级限制） */
function atempoChain(speed) {
  let s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) s = 1;
  s = Math.max(1 / 64, Math.min(64, s));
  const out = [];
  while (s > 2 + 1e-9) { out.push(2); s /= 2; }
  while (s < 0.5 - 1e-9) { out.push(0.5); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) out.push(Number(s.toFixed(6)));
  return out;
}

/** 规范化音频段：丢弃无效段，夹紧数值 */
function normalizeSegments(audioPlan, duration) {
  const segs = audioPlan && Array.isArray(audioPlan.segments) ? audioPlan.segments : [];
  const out = [];
  for (const raw of segs) {
    if (!raw || typeof raw.path !== 'string' || !raw.path) continue;
    const srcIn = Math.max(0, Number(raw.srcIn) || 0);
    const srcOut = Number(raw.srcOut);
    if (!Number.isFinite(srcOut) || srcOut - srcIn < 0.01) continue;
    let speed = Number(raw.speed);
    if (!Number.isFinite(speed) || speed <= 0) speed = 1;
    const timelineStart = Math.max(0, Number(raw.timelineStart) || 0);
    if (timelineStart >= duration) continue;
    const speedParts = Array.isArray(raw.speedParts)
      ? raw.speedParts.map((p) => ({ srcIn: Number(p && p.srcIn), srcOut: Number(p && p.srcOut), speed: Number(p && p.speed) }))
        .filter((p) => Number.isFinite(p.srcIn) && Number.isFinite(p.srcOut) && p.speed > 0 && p.srcOut - p.srcIn > 1e-4)
        .map((p) => ({ srcIn: Math.max(srcIn, p.srcIn), srcOut: Math.min(srcOut, p.srcOut), speed: p.speed }))
        .filter((p) => p.srcOut - p.srcIn > 1e-4)
        .slice(0, 64)
      : [];
    const segDur = speedParts.length > 1
      ? speedParts.reduce((acc, p) => acc + (p.srcOut - p.srcIn) / p.speed, 0)
      : (srcOut - srcIn) / speed;
    let volume = Number(raw.volume);
    if (!Number.isFinite(volume)) volume = 1;
    volume = Math.max(0, Math.min(4, volume));
    if (volume <= 0) continue;
    let fadeIn = Math.max(0, Number(raw.fadeIn) || 0);
    let fadeOut = Math.max(0, Number(raw.fadeOut) || 0);
    if (fadeIn + fadeOut > segDur) {
      const k = segDur / (fadeIn + fadeOut);
      fadeIn *= k;
      fadeOut *= k;
    }
    const volumeKeys = Array.isArray(raw.volumeKeys)
      ? raw.volumeKeys.filter((k) => k && Number.isFinite(Number(k.t)) && Number.isFinite(Number(k.v))).map((k) => ({ t: Number(k.t), v: Math.max(0, Math.min(4, Number(k.v))) })).sort((a, b) => a.t - b.t)
      : [];
    out.push({ path: raw.path, timelineStart, srcIn, srcOut, speed, volume, fadeIn, fadeOut, segDur, reverse: !!raw.reverse, denoise: !!raw.denoise, volumeKeys, ...(speedParts.length > 1 ? { speedParts } : {}) });
  }
  return out;
}

/**
 * 音量关键帧 → ffmpeg volume 表达式（分段线性，t 为片段内秒数）。纯函数。
 * keys: [{t, v}]，单关键帧时为常数。逗号已按滤镜图语法转义。
 */
function volumeExpr(keys) {
  const k = (Array.isArray(keys) ? keys : []).slice().sort((a, b) => a.t - b.t);
  if (!k.length) return '1';
  if (k.length === 1) return num(k[0].v, 4);
  let expr = num(k[k.length - 1].v, 4);
  for (let i = k.length - 2; i >= 0; i -= 1) {
    const a = k[i];
    const b = k[i + 1];
    const span = Math.max(1e-3, b.t - a.t);
    const lerp = `${num(a.v, 4)}+(${num(b.v - a.v, 4)})*(t-${num(a.t)})/${num(span)}`;
    expr = `if(lt(t\\,${num(b.t)})\\,${lerp}\\,${expr})`;
  }
  return `if(lt(t\\,${num(k[0].t)})\\,${num(k[0].v, 4)}\\,${expr})`;
}

/** 单段音频滤镜链：[k:a]...[ak] */
function segmentFilter(inputIndex, seg, label) {
  const parts = ['aresample=48000', 'aformat=channel_layouts=stereo'];
  if (seg.denoise) parts.push('afftdn=nf=-25');
  parts.push('asetpts=PTS-STARTPTS');
  if (seg.speedParts && seg.speedParts.length > 1) {
    // 曲线变速：按源顺序分段 atrim + atempo 后 concat；倒放时再整体 areverse
    const sp = seg.speedParts.slice().sort((a, b) => a.srcIn - b.srcIn);
    const n = sp.length;
    const pre = `${label}s`;
    const lines = [`[${inputIndex}:a]${parts.join(',')},asplit=${n}${sp.map((_, k) => `[${pre}${k}]`).join('')}`];
    sp.forEach((p, k) => {
      const tempo = atempoChain(p.speed).map((t) => `,atempo=${num(t, 6)}`).join('');
      lines.push(`[${pre}${k}]atrim=start=${num(p.srcIn - seg.srcIn, 6)}:end=${num(p.srcOut - seg.srcIn, 6)},asetpts=PTS-STARTPTS${tempo}[${pre}t${k}]`);
    });
    const post = [];
    if (seg.reverse) post.push('areverse', 'asetpts=N/SR/TB');
    pushTail(post, seg);
    lines.push(`${sp.map((_, k) => `[${pre}t${k}]`).join('')}concat=n=${n}:v=0:a=1${post.length ? `,${post.join(',')}` : ''}[${label}]`);
    return lines.join(';');
  }
  // 常速：时间戳归零 → 倒放（areverse 后按采样重建时间戳）→ 保调变速 → 按时间线段长精确截齐
  const retimed = seg.reverse || Math.abs(seg.speed - 1) > 1e-6;
  if (seg.reverse) parts.push('areverse', 'asetpts=N/SR/TB');
  // atempo 只改速度不改音调（保调变速）
  for (const t of atempoChain(seg.speed)) parts.push(`atempo=${num(t, 6)}`);
  if (retimed && seg.segDur > 0) parts.push('apad', `atrim=end=${num(seg.segDur, 6)}`, 'asetpts=N/SR/TB');
  pushTail(parts, seg);
  return `[${inputIndex}:a]${parts.join(',')}[${label}]`;
}

function pushTail(parts, seg) {
  if (Math.abs(seg.volume - 1) > 1e-6) parts.push(`volume=${num(seg.volume, 4)}`);
  if (seg.volumeKeys && seg.volumeKeys.length) parts.push(`volume=${volumeExpr(seg.volumeKeys)}:eval=frame`);
  if (seg.fadeIn >= 0.01) parts.push(`afade=t=in:st=0:d=${num(seg.fadeIn)}`);
  if (seg.fadeOut >= 0.01) parts.push(`afade=t=out:st=${num(Math.max(0, seg.segDur - seg.fadeOut))}:d=${num(seg.fadeOut)}`);
  const ms = Math.round(seg.timelineStart * 1000);
  if (ms > 0) parts.push(`adelay=${ms}|${ms}`);
}

/** 参数表里某个开关后面的值 */
function argValue(list, flag) {
  const i = Array.isArray(list) ? list.indexOf(flag) : -1;
  return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
}

/**
 * 校验 encoders.pickH264 给出的视频编码参数：只接受字符串、编码器在白名单内、不夹带输入/输出/滤镜开关。
 * 不合格返回 null（调用方回退到内置参数）。
 */
function sanitizeVideoArgs(list) {
  if (!Array.isArray(list) || !list.length || !list.every((a) => typeof a === 'string' && a.length < 200)) return null;
  if (!SAFE_H264.includes(argValue(list, '-c:v'))) return null;
  const banned = ['-i', '-f', '-y', '-map', '-vf', '-filter_complex', '-filter:v', '-progress', '-t', '-movflags', '-metadata'];
  if (list.some((a) => banned.includes(a))) return null;
  return list.slice();
}

/** 隐式标识（GB 45438-2025 附录 E）：规范成固定顺序的 JSON，字符限 0x21、0x23–0x5B、0x5D–0x7E。无效时返回 null */
const AIGC_FIELDS = ['Label', 'ContentProducer', 'ProduceID', 'ReservedCode1', 'ContentPropagator', 'PropagateID', 'ReservedCode2'];
function aigcMetadataValue(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const clean = (v) => String(v == null ? '' : v).replace(/[^\x21\x23-\x5B\x5D-\x7E]/g, '').slice(0, 64);
  const out = {};
  for (const k of AIGC_FIELDS) out[k] = clean(obj[k]);
  if (!['1', '2', '3'].includes(out.Label)) out.Label = '1';
  if (!out.ContentProducer) out.ContentProducer = 'Frameflow';
  if (!out.ProduceID) out.ProduceID = 'FF-' + crypto.randomBytes(6).toString('hex');
  // 首次写入：传播方与制作方相同
  if (!out.ContentPropagator) out.ContentPropagator = out.ContentProducer;
  if (!out.PropagateID) out.PropagateID = out.ProduceID;
  return JSON.stringify(out);
}

/**
 * 构建 ffmpeg 导出参数（纯函数）。
 * @param {{output:string, width:number, height:number, fps:number, quality?:'high'|'standard'|'small', audioPlan?:{duration:number, segments:object[]}, duration?:number, totalFrames?:number,
 *          encoder?:string, videoArgs?:string[], bitrate?:number, format?:string, aigc?:string|object, progress?:boolean}} opts
 *   videoArgs：encoders.pickH264 给出的完整视频编码参数（含 -c:v、码率/质量、-pix_fmt）；不传时用内置的 x264 / 硬件参数。
 *   aigc：隐式标识（AIGC 元数据），MP4/MOV/MP3 写入。progress：true 时让 ffmpeg 把进度写到 stdout（pipe:1）。
 * @returns {string[]}
 */
function buildExportArgs(opts = {}) {
  const output = opts.output || opts.outPath;
  if (!output) throw new Error('缺少导出路径');
  const fps = Math.max(1, Math.min(120, Number(opts.fps) || 30));
  const width = even(opts.width, 1920);
  const height = even(opts.height, 1080);
  const crf = CRF[opts.quality] || CRF.high;
  const format = ['mp4', 'mov', 'gif', 'mp3', 'wav'].includes(opts.format) ? opts.format
    : opts.audioOnly ? 'mp3' : opts.gif ? 'gif' : 'mp4';
  const audioOnly = format === 'mp3' || format === 'wav';
  const gif = format === 'gif';
  const videoArgs = sanitizeVideoArgs(opts.videoArgs);
  const encoder = videoArgs ? argValue(videoArgs, '-c:v')
    : ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'].includes(opts.encoder) ? opts.encoder : 'libx264';
  const bitrate = Math.max(0, Math.round(Number(opts.bitrate) || 0));
  const aigc = aigcMetadataValue(opts.aigc);
  let duration = Number(opts.duration);
  if (!(duration > 0) && Number(opts.totalFrames) > 0) duration = Number(opts.totalFrames) / fps;
  if (!(duration > 0)) duration = Number(opts.audioPlan && opts.audioPlan.duration);
  if (!(duration > 0)) throw new Error('导出时长无效');
  duration = Math.min(MAX_DURATION, duration);
  const D = num(duration);

  const args = ['-hide_banner', '-y', '-loglevel', 'error'];
  // 进度走 stdout（frame= / out_time_us= / progress=end），-nostats 让 stderr 只留真正的错误信息
  if (opts.progress) args.push('-nostats', '-progress', 'pipe:1');
  if (audioOnly) {
    args.push('-nostdin');
  } else {
    args.push('-thread_queue_size', String(FRAME_QUEUE), '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-');
  }
  // 注：视频导出不能加 -nostdin（视频帧走 stdin）

  if (gif) {
    // GIF：两遍调色板（palettegen + paletteuse），无声
    args.push(
      '-filter_complex', `[0:v]fps=${fps},scale=${width}:${height}:flags=lanczos,split[g0][g1];[g0]palettegen=stats_mode=diff[pal];[g1][pal]paletteuse=dither=bayer:bayer_scale=4[gout]`,
      '-map', '[gout]', '-loop', '0', '-t', D, '-f', 'gif', output,
    );
    return args;
  }

  const base = audioOnly ? 0 : 1;
  const segs = normalizeSegments(opts.audioPlan, duration);
  let audioMap;
  if (!segs.length) {
    args.push('-f', 'lavfi', '-t', D, '-i', 'anullsrc=r=48000:cl=stereo');
    audioMap = `${base}:a`;
  } else {
    segs.forEach((s) => {
      args.push('-ss', num(s.srcIn), '-t', num(s.srcOut - s.srcIn), '-i', s.path);
    });
    const chains = segs.map((s, i) => segmentFilter(i + base, s, `a${i}`));
    let mix;
    if (segs.length === 1) {
      mix = `[a0]apad,atrim=start=0:end=${D}[aout]`;
    } else {
      const labels = segs.map((_, i) => `[a${i}]`).join('');
      mix = `${labels}amix=inputs=${segs.length}:normalize=0:dropout_transition=0,apad,atrim=start=0:end=${D}[aout]`;
    }
    args.push('-filter_complex', [...chains, mix].join(';'));
    audioMap = '[aout]';
  }

  if (audioOnly) {
    args.push('-map', audioMap);
    if (format === 'wav') args.push('-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-t', D, '-f', 'wav', output);
    else {
      args.push('-c:a', 'libmp3lame', '-b:a', `${Math.min(320, Math.max(64, bitrate || 320))}k`, '-ar', '48000', '-ac', '2');
      if (aigc) args.push('-metadata', `AIGC=${aigc}`); // ID3v2 TXXX:AIGC
      args.push('-t', D, '-f', 'mp3', output);
    }
    return args;
  }

  // 中间帧格式跟随编码器要求（QSV 要 nv12，其余 yuv420p）
  const pixFmt = (videoArgs && /^[a-z0-9_]+$/.test(String(argValue(videoArgs, '-pix_fmt') || '')) && argValue(videoArgs, '-pix_fmt'))
    || (encoder === 'h264_qsv' ? 'nv12' : 'yuv420p');
  args.push(
    '-map', '0:v',
    // 中间帧是 JPEG（BT.601 全范围 YCbCr）；显式转换到 BT.709 限制范围并写入标记，
    // 否则播放器按 HD 默认值（709）解读 601 数据，肤色/饱和色会偏移。
    '-vf', `scale=${width}:${height}:flags=bicubic+accurate_rnd+full_chroma_int`
      + ':in_color_matrix=bt601:in_range=full:out_color_matrix=bt709:out_range=tv,'
      + `format=${pixFmt},setsar=1`,
  );
  if (videoArgs) {
    // 编码器模块给的参数（契约 C12：已含 -c:v、质量/码率与 -pix_fmt，这里不再追加自己的 -crf/-preset）
    args.push(...videoArgs);
    // 平台预设带码率时：在质量模式上加码率上限（封顶 CRF），画质稳定、体积不超标
    if (bitrate > 0 && !videoArgs.includes('-b:v') && !videoArgs.includes('-maxrate') && (encoder === 'libx264' || encoder === 'h264_nvenc')) {
      args.push('-maxrate', `${Math.round(bitrate * 1.5)}k`, '-bufsize', `${bitrate * 2}k`);
    }
  } else {
    args.push('-c:v', encoder);
    if (encoder === 'libx264') {
      args.push('-pix_fmt', 'yuv420p', '-preset', 'veryfast');
      if (bitrate > 0) args.push('-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.5)}k`, '-bufsize', `${bitrate * 2}k`);
      else args.push('-crf', String(crf));
    } else {
      // 硬件编码：统一用目标码率（各家 CQ 参数不一致）
      const br = bitrate > 0 ? bitrate : Math.round((width * height * fps) / 1e6 * 110);
      if (encoder === 'h264_nvenc') args.push('-preset', 'p5', '-rc', 'vbr');
      if (encoder === 'h264_amf') args.push('-quality', 'balanced', '-rc', 'vbr_peak');
      args.push('-b:v', `${br}k`, '-maxrate', `${Math.round(br * 1.5)}k`, '-bufsize', `${br * 2}k`);
    }
  }
  args.push(
    '-r', String(fps),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-map', audioMap,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
  );
  // 隐式标识：MP4/MOV 写进 moov/udta/meta 的 AIGC 键（use_metadata_tags 才会保留自定义键名）
  if (aigc) args.push('-metadata', `AIGC=${aigc}`, '-movflags', '+faststart+use_metadata_tags');
  else args.push('-movflags', '+faststart');
  args.push(
    '-t', D,
    '-f', format === 'mov' ? 'mov' : 'mp4',
    output,
  );
  return args;
}

// ───────────────────────── 纯函数：进度、体积估算、错误说明 ─────────────────────────

/**
 * 解析 ffmpeg -progress 输出。返回 feed(chunk)：每收到一个完整进度块调用一次 onBlock。
 * 块：{ frame, outSec, speed, totalSize, end }（取不到的字段为 null）。
 */
function createProgressParser(onBlock) {
  let buf = '';
  let cur = {};
  return function feed(chunk) {
    buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      cur[key] = line.slice(eq + 1).trim();
      if (key === 'progress') {
        const block = cur;
        cur = {};
        const frame = parseInt(block.frame, 10);
        // out_time_ms 实际也是微秒（ffmpeg 的历史命名），两者取其一
        const us = Number(block.out_time_us != null ? block.out_time_us : block.out_time_ms);
        const speed = parseFloat(block.speed);
        const size = Number(block.total_size);
        try {
          onBlock({
            frame: Number.isFinite(frame) && frame >= 0 ? frame : null,
            outSec: Number.isFinite(us) && us >= 0 ? us / 1e6 : null,
            speed: Number.isFinite(speed) && speed > 0 ? speed : null,
            totalSize: Number.isFinite(size) && size >= 0 ? size : null,
            end: block.progress === 'end',
          });
        } catch { /* 回调出错不影响解析 */ }
      }
    }
    if (buf.length > 64 * 1024) buf = buf.slice(-4096);
  };
}

/** 偏保守的「最少需要多少字节」：只在明显放不下时拦截，避免误拦（码率偏低估计） */
const MIN_BPP = { high: 0.05, standard: 0.035, small: 0.022 };
function estimateOutputBytes({ format = 'mp4', width = 1920, height = 1080, fps = 30, duration = 0, quality = 'high', bitrate = 0 } = {}) {
  const d = Math.max(0, Number(duration) || 0);
  const br = Math.max(0, Number(bitrate) || 0);
  if (format === 'wav') return Math.round(d * 48000 * 4);
  if (format === 'mp3') return Math.round(d * Math.min(320, Math.max(64, br || 320)) * 125);
  const px = Math.max(1, Number(width) || 1) * Math.max(1, Number(height) || 1) * Math.max(1, Number(fps) || 30);
  if (format === 'gif') return Math.round(px * d * 0.05);
  const videoKbps = br > 0 ? br * 0.5 : (px * (MIN_BPP[quality] || MIN_BPP.high)) / 1000;
  return Math.round(((videoKbps + 192) * 1000) / 8 * d);
}

const DISK_MARGIN = 64 * 1024 * 1024;
function defaultFreeSpaceProbe(dir) {
  if (typeof fs.statfsSync !== 'function') return null;
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}
let freeSpaceProbe = defaultFreeSpaceProbe;

function fmtBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(v / 1024 ** 2))} MB`;
}

/** 导出前检查磁盘空间：明显不够时抛出 code = 'DISK_FULL'；查不到可用空间时放行 */
function checkDiskSpace(dir, need) {
  let free = null;
  try { free = freeSpaceProbe(dir); } catch { free = null; }
  if (!Number.isFinite(free) || free < 0) return { free: null, need };
  if (free < need + DISK_MARGIN) {
    const e = new Error(`保存位置所在的磁盘空间不足：这次导出预计至少需要 ${fmtBytes(need + DISK_MARGIN)}，目前只剩 ${fmtBytes(free)}。请清理磁盘，或换一个保存位置后再导出`);
    e.code = 'DISK_FULL';
    throw e;
  }
  return { free, need };
}

/** stderr 里去掉进度统计行（frame= … time= …），只留给人看的错误 */
function cleanStderr(text) {
  return String(text || '')
    .split(/\r?\n|\r/)
    .filter((l) => l.trim() && !/^\s*(frame|size)=\s*\S+.*\b(time|bitrate)=/.test(l))
    .join('\n');
}

/**
 * 把 ffmpeg 失败翻译成用户能处理的说明。
 * 磁盘满 → DISK_FULL；输出位置没有写入权限 → NO_PERMISSION；用了硬件编码器的其它失败 → HW_ENCODER_FAILED
 * （渲染端收到后会自动改用 CPU 重新导出）。识别不出返回 null。
 */
function friendlyFfmpegError(stderr, { hw = false, outName = '' } = {}) {
  const s = cleanStderr(stderr);
  const withCode = (msg, code) => { const e = new Error(msg); e.code = code; return e; };
  if (/No space left on device|ENOSPC|There is not enough space on the disk|磁盘空间不足/i.test(s)) {
    return withCode('磁盘空间不足，导出没有完成。请清理保存位置所在的磁盘，或换一个保存位置后重新导出', 'DISK_FULL');
  }
  const denied = s.split('\n').find((l) => /Permission denied|Access is denied|Operation not permitted/i.test(l));
  if (denied && (!outName || denied.includes(outName) || !/[\\/]/.test(denied))) {
    return withCode('没有权限写入保存位置。请换一个文件夹（例如「视频」或「桌面」）后重新导出', 'NO_PERMISSION');
  }
  if (hw && !/Invalid data found|Error opening input|No such file or directory|Error while decoding/i.test(s)) {
    const tail = stderrTail(s, 300);
    return withCode(`硬件编码器出错${tail ? '：' + tail : ''}`, 'HW_ENCODER_FAILED');
  }
  return null;
}

/** 字幕文本 → SRT（captions.textsToSrt 缺失时的内联实现；texts: [{start,duration|end,text}]） */
function srtTime(sec) {
  const ms = Math.max(0, Math.round(Number(sec) * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}
function textsToSrt(texts) {
  const list = (Array.isArray(texts) ? texts : [])
    .filter((t) => t && String(t.text || '').trim())
    .map((t) => ({ start: Number(t.start) || 0, end: Number.isFinite(Number(t.end)) ? Number(t.end) : (Number(t.start) || 0) + (Number(t.duration) || 2), text: String(t.text).trim() }))
    .sort((a, b) => a.start - b.start);
  return list.map((t, i) => `${i + 1}\n${srtTime(t.start)} --> ${srtTime(Math.max(t.end, t.start + 0.1))}\n${t.text}\n`).join('\n');
}

// ───────────────────────── 进程与会话 ─────────────────────────

function rmQuiet(p) {
  try { fs.rmSync(p, { force: true }); } catch {}
}

function cancelledError() {
  const e = new Error('已取消');
  e.code = 'CANCELLED';
  return e;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 等待 promise，最多 ms 毫秒（超时返回 onTimeout），结束后清理计时器，不拖住进程退出 */
function raceTimeout(promise, ms, onTimeout) {
  let timer;
  const t = new Promise((r) => { timer = setTimeout(() => r(onTimeout), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data && data.type === 'Buffer' && Array.isArray(data.data)) return Buffer.from(data.data);
  return null;
}

function stderrTail(text, n = 800) {
  const s = cleanStderr(text).trim();
  return s.length > n ? '…' + s.slice(-n) : s;
}

/** 编码器显示名（结果里给界面用；与设置页同一套叫法） */
function encoderLabel(encoder) {
  try {
    if (encoders && typeof encoders.labelOf === 'function') {
      const l = encoders.labelOf(encoder, false);
      if (typeof l === 'string' && l && l !== encoder) return l;
    }
  } catch { /* 用下面的 */ }
  const map = { h264_nvenc: 'NVIDIA 显卡加速', h264_qsv: 'Intel 核显加速', h264_amf: 'AMD 显卡加速', h264_mf: 'Windows 系统编码', libx264: 'CPU 编码（高画质）', libopenh264: 'CPU 编码（兼容模式）' };
  return map[encoder] || encoder || '';
}

/**
 * 选视频编码器（契约 C12）：交给 encoders.pickH264（只选通过试编码的编码器，显卡优先）。
 * 设置里选了「只用 CPU」（media.encoder = 'cpu'）或本次导出关闭了硬件加速（hwaccel = 'off'）时只用 CPU。
 * encoders 模块不可用时退回 ff.pickVideoEncoder，再不行用 libx264。
 * 返回 { encoder, videoArgs|null, hw, label }；videoArgs 为 null 时 buildExportArgs 用内置参数。
 */
async function chooseVideoEncoder({ ffmpeg, paths, quality, hwaccel, bitrate, settings, width, height, fps }) {
  const pref = settings && settings.media && settings.media.encoder;
  const preferHw = hwaccel !== 'off' && pref !== 'cpu';
  if (encoders && typeof encoders.pickH264 === 'function') {
    let picked = null;
    try {
      picked = await raceTimeout(Promise.resolve(encoders.pickH264({
        ffmpegPath: ffmpeg,
        quality: ['high', 'standard', 'small'].includes(quality) ? quality : 'high',
        preferHw,
        purpose: 'export',
        width: Number(width) || undefined,
        height: Number(height) || undefined,
        fps: Number(fps) || undefined,
        ...(bitrate > 0 ? { bitrateKbps: bitrate } : {}),
      })), 20000, null);
    } catch { picked = null; }
    const videoArgs = picked ? sanitizeVideoArgs(picked.args) : null;
    if (videoArgs) {
      const encoder = argValue(videoArgs, '-c:v');
      const hw = typeof picked.hw === 'boolean' ? picked.hw : HW_H264.includes(encoder) && encoder !== 'h264_mf';
      return { encoder, videoArgs, hw, label: (typeof picked.label === 'string' && picked.label) || encoderLabel(encoder) };
    }
  }
  if (preferHw && ff && typeof ff.pickVideoEncoder === 'function') {
    try {
      const enc = await ff.pickVideoEncoder(paths, hwaccel || 'auto');
      if (HW_H264.includes(enc)) return { encoder: enc, videoArgs: null, hw: true, label: encoderLabel(enc) };
    } catch { /* 用 CPU */ }
  }
  return { encoder: 'libx264', videoArgs: null, hw: false, label: encoderLabel('libx264') };
}

/** 显卡编码失败、改用 CPU 重新导出成功后，告诉编码器模块（累计 2 次后本次运行不再选它） */
function noteEncoderFailed(ffmpeg, encoder) {
  if (!encoder || !HW_H264.includes(encoder)) return;
  try { if (encoders && typeof encoders.markFailed === 'function') encoders.markFailed(ffmpeg, encoder); } catch { /* 忽略 */ }
}

function creditsPathFor(finalPath) {
  return finalPath.replace(/\.[^.\\/]+$/, '') + '.credits.txt';
}

async function renameWithRetry(from, to, isAborted) {
  let lastErr;
  for (let i = 0; i < 8; i++) {
    if (typeof isAborted === 'function' && isAborted()) throw cancelledError();
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if ((e.code === 'EEXIST' || e.code === 'EPERM') && fs.existsSync(from) && fs.existsSync(to)) {
        try {
          if (typeof isAborted === 'function' && isAborted()) throw cancelledError();
          fs.rmSync(to, { force: true });
          fs.renameSync(from, to);
          return;
        } catch (e2) {
          if (e2 && e2.code === 'CANCELLED') throw e2;
          lastErr = e2;
        }
      }
      if (i < 7) await sleep(250);
    }
  }
  const code = lastErr && lastErr.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    throw new Error(`无法覆盖目标文件（可能正被播放器占用）：${to}。请关闭正在使用该文件的程序后重新导出`);
  }
  throw new Error(`保存导出文件失败：${(lastErr && lastErr.message) || lastErr}`);
}

const liveSessions = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const s of liveSessions) {
      try { s.child.kill('SIGKILL'); } catch {}
      rmQuiet(s.partPath);
    }
  });
}

module.exports = function register({ handle, ctx }) {
  const sessions = new Map(); // jobId -> session
  // 刚失败的任务：之后到达的 export:frame / export:end 拿到真实原因（含错误码），而不是「任务不存在」
  const recentErrors = new Map();
  installExitHook();

  function getSession(jobId) {
    const s = sessions.get(jobId);
    if (!s) {
      const err = recentErrors.get(jobId);
      if (err) throw err;
      throw new Error('导出任务不存在或已结束');
    }
    return s;
  }

  function finalize(session) {
    sessions.delete(session.jobId);
    liveSessions.delete(session);
    if (session.idleTimer) clearTimeout(session.idleTimer);
  }

  function fail(session, err) {
    if (session.settled) return;
    session.settled = true;
    session.error = err;
    finalize(session);
    if (session.jobId && err && err.code !== 'CANCELLED') {
      recentErrors.set(session.jobId, err);
      while (recentErrors.size > 20) recentErrors.delete(recentErrors.keys().next().value);
    }
    killTree(session.child);
    session.exited.then(() => rmQuiet(session.partPath));
    session.reject(err);
  }

  /** 编码器异常退出的错误：能识别的给出处理办法，否则带上 ffmpeg 的最后几行 */
  function exitError(session, code, prefix) {
    const known = friendlyFfmpegError(session.stderr, { hw: session.hw, outName: path.basename(session.partPath) });
    if (known) return known;
    const tailText = stderrTail(session.stderr);
    return new Error(`${prefix}（退出码 ${code}）${tailText ? '：' + tailText : ''}`);
  }

  /**
   * 推送任务进度（节流 150ms；force 立即推）。meta 里带实时计数，渲染端据此算真实进度和剩余时间：
   *   meta.frames 已收到的帧，meta.encoded 已编码的帧（ffmpeg 报告前为 null），meta.outSec 已输出的秒数。
   */
  function pushProgress(session, force = false) {
    if (!session.job || session.settled) return;
    const now = Date.now();
    if (!force && now - session.lastProgressAt < 150) return;
    session.lastProgressAt = now;
    const total = session.totalFrames;
    const frames = Math.min(session.frames, total);
    const meta = session.meta;
    meta.frames = frames;
    meta.encoded = session.encoded == null ? null : Math.min(session.encoded, total);
    meta.outSec = session.outSec;
    meta.ending = session.ending;
    if (session.audioOnly) {
      const p = session.duration > 0 ? Math.min(1, session.outSec / session.duration) : 0;
      session.job.progress('混音', p * 0.99, session.ending && p >= 0.999 ? '正在写入文件…' : '正在混合音频…');
      return;
    }
    if (!session.ending) {
      const doneish = meta.encoded == null ? frames : Math.min(frames, meta.encoded);
      session.job.progress('渲染与编码', doneish / total, `第 ${frames}/${total} 帧`);
      return;
    }
    const enc = meta.encoded == null ? 0 : meta.encoded;
    if (enc >= total) session.job.progress('收尾封装', 0.99, '正在写入文件…');
    else session.job.progress('收尾封装', Math.min(0.99, enc / total), `正在编码剩余画面（${enc}/${total}）`);
  }

  function armIdle(session) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      fail(session, new Error(session.audioOnly
        ? '导出中断：长时间没有收到结束指令，已自动停止'
        : '导出中断：长时间没有收到画面帧，已自动停止'));
    }, IDLE_TIMEOUT_MS);
    if (session.idleTimer.unref) session.idleTimer.unref();
  }

  async function probeDuration(file) {
    const ffprobe = ctx.paths && ctx.paths.ffprobe;
    if (!ffprobe || !fs.existsSync(ffprobe)) return null;
    try {
      const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeoutMs: 20000 });
      const d = parseFloat(String(r.stdout).trim());
      return Number.isFinite(d) ? d : null;
    } catch {
      return null;
    }
  }

  handle('export:begin', async (payload) => {
    const { outPath, width, height, fps, quality, audioPlan, totalFrames, bitrate, hwaccel, srt, srtText, preset, credits, aigc, failedEncoder } = payload || {};
    const format = ['mp4', 'mov', 'gif', 'mp3', 'wav'].includes(payload && payload.format) ? payload.format
      : payload && payload.audioOnly ? 'mp3' : payload && payload.gif ? 'gif' : 'mp4';
    const audioOnly = format === 'mp3' || format === 'wav';
    if (typeof outPath !== 'string' || !outPath.trim()) throw new Error('请选择导出保存位置');
    if (!path.isAbsolute(outPath)) throw new Error('导出路径必须是完整路径');
    const total = Math.floor(Number(totalFrames));
    if (!(total > 0)) throw new Error('项目为空，没有可导出的画面');
    const f = Number(fps);
    if (!(f > 0 && f <= 120)) throw new Error('帧率无效（应为 1–120）');
    if (!(Number(width) >= 16 && Number(height) >= 16)) throw new Error('导出分辨率无效');
    if (total / f > MAX_DURATION) throw new Error('导出时长超出上限（最长 1 小时）');
    const ffmpeg = ctx.paths && ctx.paths.ffmpeg;
    if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('找不到 ffmpeg，无法导出：请重新安装镜流');

    const finalPath = path.resolve(outPath);
    try { fs.mkdirSync(path.dirname(finalPath), { recursive: true }); } catch (e) {
      throw new Error(`无法创建导出目录：${e.message}`);
    }
    // 先写到同目录的唯一临时文件，成功后再改名：中途失败、硬件回退或并发导出不会互相删掉临时文件
    const partPath = `${finalPath}.${crypto.randomBytes(4).toString('hex')}.part.${format}`;
    rmQuiet(partPath);
    const duration = total / f;
    const br = Math.max(0, Math.round(Number(bitrate) || 0));
    checkDiskSpace(path.dirname(finalPath), estimateOutputBytes({ format, width: Number(width), height: Number(height), fps: f, duration, quality, bitrate: br }));

    // 丢弃不存在的音频文件（不让一段缺失的音乐毁掉整个导出）
    const plan = audioPlan && typeof audioPlan === 'object' ? audioPlan : { duration, segments: [] };
    const missing = [];
    const segments = (Array.isArray(plan.segments) ? plan.segments : []).filter((s) => {
      const ok = s && typeof s.path === 'string' && fs.existsSync(s.path);
      if (!ok && s && s.path) missing.push(path.basename(s.path));
      return ok;
    });
    let pick = { encoder: 'libx264', videoArgs: null, hw: false, label: encoderLabel('libx264') };
    if (!audioOnly && format !== 'gif') {
      let settings = null;
      try { settings = ctx.settings && typeof ctx.settings.get === 'function' ? ctx.settings.get() : null; } catch { settings = null; }
      pick = await chooseVideoEncoder({ ffmpeg, paths: ctx.paths, quality, hwaccel, bitrate: br, settings, width, height, fps: f });
    }
    const encoder = pick.encoder;
    const aigcValue = format === 'mp4' || format === 'mov' || format === 'mp3' ? aigcMetadataValue(aigc) : null;
    const args = buildExportArgs({ output: partPath, width, height, fps: f, quality, bitrate: br, format, encoder, videoArgs: pick.videoArgs, aigc: aigcValue, progress: true, audioPlan: { duration, segments }, duration });

    let child;
    try {
      child = spawnProc(ffmpeg, args);
    } catch (e) {
      throw new Error(`无法启动 ffmpeg：${e.message}`);
    }

    const creditsText = typeof credits === 'string' && credits.trim() ? credits.slice(0, 200 * 1024) : null;
    const session = {
      jobId: null,
      child,
      partPath,
      finalPath,
      fps: f,
      totalFrames: total,
      duration,
      frames: 0,
      encoded: null,
      outSec: 0,
      stderr: '',
      settled: false,
      ending: false,
      error: null,
      writeChain: Promise.resolve(),
      lastProgressAt: 0,
      idleTimer: null,
      missing,
      audioOnly,
      format,
      encoder,
      hw: !!pick.hw,
      encoderLabel: audioOnly ? '' : format === 'gif' ? 'GIF' : pick.label,
      aigc: !!aigcValue,
      creditsText,
      failedEncoder: typeof failedEncoder === 'string' && failedEncoder !== encoder ? failedEncoder : null,
      preset: preset || null,
      srtText: srt && typeof srtText === 'string' && srtText.trim() ? srtText : null,
      meta: { outPath: finalPath, total, frames: 0, encoded: null, outSec: 0, ending: false, encoder, hw: !!pick.hw },
    };
    session.done = new Promise((resolve, reject) => { session.resolve = resolve; session.reject = reject; });
    session.done.catch(() => {});
    session.exited = new Promise((resolve) => {
      child.on('close', (code, signal) => { session.exitCode = code; session.exitSignal = signal; resolve(code); });
    });
    child.on('error', (e) => {
      fail(session, new Error(`ffmpeg 运行失败：${e.message}`));
    });
    child.stderr.on('data', (c) => {
      session.stderr += c.toString('utf8');
      if (session.stderr.length > 64 * 1024) session.stderr = session.stderr.slice(-32 * 1024);
    });
    // 进度（-progress pipe:1）：必须一直读走，否则管道写满会卡住 ffmpeg
    const feed = createProgressParser((p) => {
      if (p.frame != null) session.encoded = p.frame;
      if (p.outSec != null) session.outSec = p.outSec;
      pushProgress(session, p.end);
    });
    child.stdout.on('data', feed);
    child.stdin.on('error', (e) => { session.stdinError = e; });
    if (audioOnly) { try { child.stdin.end(); } catch {} }
    session.exited.then((code) => {
      // 仅音频导出不需要渲染端送帧，短音频经常在 export:end 到达前就已正常编码完成（退出码 0）
      if (session.audioOnly && code === 0) return;
      // 在 end 之前进程就退出 → 失败
      if (!session.ending && !session.settled) {
        fail(session, exitError(session, code, '导出失败：编码器意外退出'));
      }
    });

    const { jobId } = ctx.jobs.start('export', async (job) => {
      const onAbort = () => {
        if (session.settled) return;
        fail(session, cancelledError());
      };
      if (job.signal.aborted) onAbort(); else job.signal.addEventListener('abort', onAbort, { once: true });
      return session.done;
    }, session.meta);
    session.jobId = jobId;
    session.job = ctx.jobs.get ? ctx.jobs.get(jobId) : null;
    sessions.set(jobId, session);
    liveSessions.add(session);
    // 仅音频会话同样挂空闲超时，避免渲染端崩溃或断连后孤儿会话长期残留 .part 文件
    armIdle(session);
    if (session.job) {
      const hw = pick.hw ? `（${pick.label || '硬件加速'}）` : '';
      const note = missing.length ? `已跳过缺失的音频：${missing.slice(0, 3).join('、')}${missing.length > 3 ? ' 等' : ''}` : audioOnly ? '仅导出音频' : `共 ${total} 帧${hw}`;
      session.job.progress(audioOnly ? '混音' : '渲染与编码', 0, note);
      session.lastProgressAt = Date.now();
    }
    return { jobId, encoder, format, hw: session.hw, encoderLabel: session.encoderLabel, aigc: session.aigc };
  });

  /** 导出当前帧为 PNG：渲染端传 PNG 数据（data）+ 时刻 t，保存到 outPath（缺省为系统图片目录） */
  async function saveSnapshot(payload) {
    const buf = toBuffer(payload.data);
    if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('截图数据不是 PNG 格式');
    let out = typeof payload.outPath === 'string' && path.isAbsolute(payload.outPath) ? payload.outPath : null;
    if (!out) {
      let picturesDir = path.join(os.homedir(), 'Pictures');
      if (process.versions && process.versions.electron) {
        try {
          const electron = require('electron');
          if (electron && electron.app && typeof electron.app.getPath === 'function') {
            const p = electron.app.getPath('pictures');
            if (p) picturesDir = p;
          }
        } catch {}
      }
      const dir = path.join(picturesDir, '镜流截图');
      fs.mkdirSync(dir, { recursive: true });
      const t = Math.max(0, Number(payload.t) || 0);
      const safeId = String(payload.projectId || 'project').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'project';
      out = path.join(dir, `frame-${safeId}-${t.toFixed(2).replace('.', '_')}s-${Date.now()}.png`);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    if (typeof ctx.registerMediaPath === 'function') ctx.registerMediaPath(out);
    return out;
  }

  handle('export:frame', async (payload) => {
    if (payload && !payload.jobId && payload.t !== undefined) return saveSnapshot(payload);
    const { jobId, data } = payload || {};
    const session = getSession(jobId);
    if (session.error) throw session.error;
    if (session.ending) throw new Error('导出已结束，不能再写入画面');
    const buf = toBuffer(data);
    if (!buf || buf.length < 4) throw new Error('收到的画面帧数据无效');
    if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('画面帧不是 JPEG 格式');

    const write = async () => {
      if (session.error) throw session.error;
      const stdin = session.child.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable) {
        // 编码器刚退出、退出事件还没到：稍等一下拿到真实原因（例如显卡编码失败 → 渲染端改用 CPU 重试）
        if (!session.error) await raceTimeout(session.exited, 3000, null);
        throw session.error || new Error(`导出失败：编码器已停止${stderrTail(session.stderr) ? '：' + stderrTail(session.stderr) : ''}`);
      }
      const ok = stdin.write(buf);
      if (!ok) {
        await new Promise((resolve) => {
          const done = () => {
            stdin.off('drain', done);
            stdin.off('close', done);
            stdin.off('error', done);
            resolve();
          };
          stdin.once('drain', done);
          stdin.once('close', done);
          stdin.once('error', done);
          session.exited.then(done);
        });
      }
      if (session.error) throw session.error;
      session.frames += 1;
      armIdle(session);
      pushProgress(session, session.frames >= session.totalFrames);
      return true;
    };
    const p = session.writeChain.then(write);
    session.writeChain = p.catch(() => {});
    return p;
  });

  handle('export:end', async (payload) => {
    const { jobId } = payload || {};
    const session = getSession(jobId);
    if (session.error) throw session.error;
    if (session.ending) throw new Error('导出正在收尾，请稍候');
    await session.writeChain;
    if (session.settled) throw session.error || cancelledError();
    if (session.error) throw session.error;
    session.ending = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);

    if (session.frames === 0 && !session.audioOnly) {
      const err = new Error('没有收到任何画面帧，导出已中止');
      fail(session, err);
      throw err;
    }
    pushProgress(session, true);
    try { session.child.stdin.end(); } catch {}

    // 收尾最多等 10 分钟（大文件 + faststart 需要重写文件）
    const code = await raceTimeout(session.exited, 10 * 60 * 1000, 'timeout');
    if (session.settled) throw session.error || cancelledError();
    try {
      if (code === 'timeout') throw new Error('导出收尾超时，请重试');
      if (code !== 0) throw exitError(session, code, '导出失败：编码器出错');
      if (!fs.existsSync(session.partPath)) throw new Error('导出失败：没有生成输出文件');
      await renameWithRetry(session.partPath, session.finalPath, () => session.settled);
    } catch (err) {
      if (session.settled) throw session.error || err;
      fail(session, err);
      throw err;
    }
    if (session.settled) {
      rmQuiet(session.finalPath);
      throw session.error || cancelledError();
    }
    const size = fs.statSync(session.finalPath).size;
    const probed = await probeDuration(session.finalPath);
    if (session.settled) {
      rmQuiet(session.finalPath);
      throw session.error || cancelledError();
    }
    const duration = probed != null ? probed : (session.audioOnly ? session.duration : (session.fps ? session.frames / session.fps : 0));
    const result = {
      path: session.finalPath,
      size,
      duration,
      encoder: session.encoder,
      format: session.format,
      hw: session.hw,
      encoderLabel: session.encoderLabel,
      aigc: session.aigc,
    };
    if (session.missing.length) result.missing = session.missing.slice(0, 20);
    if (session.srtText) {
      const srtPath = session.finalPath.replace(/\.[^.\\/]+$/, '') + '.srt';
      try {
        fs.writeFileSync(srtPath, '\uFEFF' + session.srtText, 'utf8');
        result.srtPath = srtPath;
      } catch (e) {
        result.srtError = `字幕文件写入失败：${e.message}`;
      }
    }
    // 署名文件（契约 C3）：和视频同名的 .credits.txt，带 BOM + Windows 换行，记事本直接打开不乱码
    if (session.creditsText) {
      const creditsPath = creditsPathFor(session.finalPath);
      try {
        const body = session.creditsText.replace(/\r\n?/g, '\n').replace(/\n+$/, '').replace(/\n/g, '\r\n') + '\r\n';
        fs.writeFileSync(creditsPath, '\uFEFF' + body, 'utf8');
        result.creditsPath = creditsPath;
      } catch (e) {
        result.creditsError = `署名文件写入失败：${e.message}`;
      }
    }
    if (session.settled) {
      rmQuiet(session.finalPath);
      throw session.error || cancelledError();
    }
    if (typeof ctx.registerMediaPath === 'function') ctx.registerMediaPath(session.finalPath);
    if (session.failedEncoder) noteEncoderFailed(ctx.paths && ctx.paths.ffmpeg, session.failedEncoder);
    session.settled = true;
    finalize(session);
    if (session.job) session.job.progress('完成', 1, '导出完成');
    session.resolve(result);
    return result;
  });

  handle('export:cancel', async (payload) => {
    const { jobId } = payload || {};
    const session = sessions.get(jobId);
    if (!session) {
      try { ctx.jobs.cancel(jobId); } catch {}
      return false;
    }
    fail(session, cancelledError());
    try { ctx.jobs.cancel(jobId); } catch {}
    await raceTimeout(session.exited, 5000, null);
    rmQuiet(session.partPath);
    return true;
  });
};

module.exports._internals = {
  buildExportArgs,
  atempoChain,
  normalizeSegments,
  segmentFilter,
  volumeExpr,
  textsToSrt,
  srtTime,
  toBuffer,
  CRF,
  FRAME_QUEUE,
  sanitizeVideoArgs,
  aigcMetadataValue,
  createProgressParser,
  estimateOutputBytes,
  checkDiskSpace,
  /** 测试用：替换「剩余磁盘空间」的探测函数，传 null 恢复默认 */
  setFreeSpaceProbe(fn) { freeSpaceProbe = typeof fn === 'function' ? fn : defaultFreeSpaceProbe; },
  cleanStderr,
  friendlyFfmpegError,
  chooseVideoEncoder,
  encoderLabel,
  creditsPathFor,
};
