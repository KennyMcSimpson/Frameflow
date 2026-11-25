// 导出对话框用的纯函数（不依赖 React / store，便于单测）。

/** 平台预设（一行四个）与「其他格式」的分组 */
export const PLATFORM_PRESET_IDS = ['douyin', 'bilibili', 'shipinhao', 'youtube4k'];

/** 1080p30「高」档实测：33 秒约 25.1 MB ≈ 6.1 Mbps（含 192k 音频），据此推算视频部分 */
const BASE_VIDEO_KBPS = 5900;
const AUDIO_KBPS = 192;
const QUALITY_FACTOR = { high: 1, standard: 0.7, small: 0.4 }; // 对应 CRF 18 / 21 / 26

/**
 * 预计导出文件大小（字节）。只是粗估，界面上一律写「约」。
 * - 指定了视频码率（平台预设或手填）：时长 ×（视频码率 + 192k）/ 8
 * - 码率自动：按 1080p30 高画质 ≈ 5.9 Mbps 视频，按像素量^0.75、帧率^0.6、画质系数缩放
 * - MP3：按码率（64–320k）；WAV：48kHz 16bit 立体声；GIF：每像素每帧约 0.12 字节
 * @returns {number} 字节数，时长无效时为 0
 */
export function estimateExportBytes({ duration, w, h, fps, quality = 'high', bitrate = 0, format = 'mp4', audioOnly = false, gif = false } = {}) {
  const d = Number(duration);
  if (!(d > 0)) return 0;
  const fmt = String(format || 'mp4');
  if (fmt === 'wav') return Math.round(d * 48000 * 2 * 2 + 44);
  if (fmt === 'mp3' || audioOnly) {
    const k = Math.min(320, Math.max(64, Number(bitrate) > 0 ? Number(bitrate) : 320));
    return Math.round((d * k * 1000) / 8);
  }
  const W = Math.max(2, Number(w) || 1920);
  const H = Math.max(2, Number(h) || 1080);
  const F = Math.max(1, Number(fps) || 30);
  if (fmt === 'gif' || gif) return Math.round(W * H * F * d * 0.12);
  let videoKbps;
  if (Number(bitrate) > 0) videoKbps = Number(bitrate);
  else {
    const scale = Math.pow((W * H) / (1920 * 1080), 0.75) * Math.pow(F / 30, 0.6);
    videoKbps = BASE_VIDEO_KBPS * scale * (QUALITY_FACTOR[quality] || 1);
  }
  return Math.round((d * (videoKbps + AUDIO_KBPS) * 1000) / 8);
}

/** 字节 → 「约 25 MB」这类好读的写法；0 或无效返回 '' */
export function fmtApproxSize(bytes) {
  const b = Number(bytes);
  if (!(b > 0)) return '';
  const KB = 1024; const MB = KB * 1024; const GB = MB * 1024;
  if (b < MB) return `约 ${Math.max(1, Math.round(b / KB))} KB`;
  if (b < 10 * MB) return `约 ${(b / MB).toFixed(1)} MB`;
  if (b < GB) return `约 ${Math.round(b / MB)} MB`;
  return `约 ${(b / GB).toFixed(1)} GB`;
}

/** 把完整路径拆成文件夹和文件名（同时认 \ 和 /） */
export function splitOutPath(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (i < 0) return { dir: '', file: s };
  return { dir: s.slice(0, i) || s.slice(0, 1), file: s.slice(i + 1) };
}

/** 导出中的「预计剩余」：封装阶段不再说「计算中」，而是「即将完成」 */
export function fmtEta(sec, phase) {
  if (phase === 'encode') return '即将完成';
  if (!Number.isFinite(sec) || sec < 0) return '计算中…';
  if (sec < 1) return '不到 1 秒';
  const s = Math.ceil(sec);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 用时：和 fmtEta 同样的写法，但不会出现「即将完成 / 计算中」 */
export function fmtElapsed(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  return fmtEta(sec);
}

/**
 * 许可检查结果（license.findRestrictedUsage 的返回）整理成 { block, warn }，按素材去重。
 * 同一素材出现多条时保留级别更高的那条。
 */
export function groupRestricted(list) {
  const byId = new Map();
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it !== 'object') continue;
    const id = String(it.assetId || it.title || '');
    if (!id) continue;
    const level = it.level === 'block' ? 'block' : 'warn';
    const prev = byId.get(id);
    if (!prev || (prev.level === 'warn' && level === 'block')) {
      byId.set(id, { assetId: it.assetId || '', title: String(it.title || '未命名素材'), reason: String(it.reason || ''), level });
    }
  }
  const all = [...byId.values()];
  return { block: all.filter((x) => x.level === 'block'), warn: all.filter((x) => x.level === 'warn') };
}

/** 「a、b、c 等 5 个」这样的短列表 */
export function shortList(names, max = 3) {
  const arr = (Array.isArray(names) ? names : []).filter(Boolean).map(String);
  if (!arr.length) return '';
  const head = arr.slice(0, max).map((n) => `「${n}」`).join('、');
  return arr.length > max ? `${head} 等 ${arr.length} 个` : head;
}

/** 素材离线、时间线空隙、示意画面等预检结果是否会阻止直接导出（danger 级别） */
export function hasBlockingIssue(issues) {
  return (Array.isArray(issues) ? issues : []).some((i) => i && i.level === 'danger');
}
