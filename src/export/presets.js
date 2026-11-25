// 导出预设（PLAN-v3 §5）：ExportDialog 与属性面板共用。纯数据 + 纯函数，node 可测。
// format：mp4（H.264 + AAC）、mov、gif（无声动图）、mp3 / wav（仅音频）。bitrate 单位 kbps，0 = 按质量（CRF）自动。

export const EXPORT_PRESETS = [
  { id: 'douyin', label: '抖音 / 快手', desc: '竖屏 1080×1920 · 30fps', icon: 'smartphone', w: 1080, h: 1920, fps: 30, bitrate: 10000, format: 'mp4', aspect: '9:16' },
  { id: 'bilibili', label: 'B 站', desc: '横屏 1080p · 60fps', icon: 'tv', w: 1920, h: 1080, fps: 60, bitrate: 12000, format: 'mp4', aspect: '16:9' },
  { id: 'shipinhao', label: '视频号 / 小红书', desc: '竖屏 1080×1920 · 30fps', icon: 'heart', w: 1080, h: 1920, fps: 30, bitrate: 8000, format: 'mp4', aspect: '9:16' },
  { id: 'youtube4k', label: 'YouTube 4K', desc: '3840×2160 · 30fps', icon: 'monitor', w: 3840, h: 2160, fps: 30, bitrate: 45000, format: 'mp4', aspect: '16:9' },
  { id: 'custom', label: '自定义', desc: '按项目分辨率', icon: 'sliders', w: 0, h: 0, fps: 0, bitrate: 0, format: 'mp4' },
  { id: 'audio-mp3', label: '仅音频 MP3', desc: '320kbps 立体声', icon: 'music', w: 0, h: 0, fps: 0, bitrate: 320, format: 'mp3', audioOnly: true },
  { id: 'gif', label: '动图 GIF', desc: '480 宽 · 15fps · 无声', icon: 'image', w: 480, h: 0, fps: 15, bitrate: 0, format: 'gif', gif: true },
];

export const FORMATS = [
  { id: 'mp4', label: 'MP4 (H.264)', ext: 'mp4' },
  { id: 'mov', label: 'MOV (H.264)', ext: 'mov' },
  { id: 'gif', label: 'GIF 动图', ext: 'gif' },
  { id: 'mp3', label: 'MP3 音频', ext: 'mp3' },
  { id: 'wav', label: 'WAV 音频', ext: 'wav' },
];

export function presetById(id) {
  return EXPORT_PRESETS.find((p) => p.id === id) || EXPORT_PRESETS.find((p) => p.id === 'custom');
}

export function extFor(format) {
  return (FORMATS.find((f) => f.id === format) || FORMATS[0]).ext;
}

const even = (v) => Math.max(16, Math.round(Number(v) / 2) * 2);

/**
 * 预设 + 项目设置 + 用户覆盖 → 最终导出参数。
 * 预设分辨率方向与项目画幅不一致时（如横屏项目选抖音），保持预设长边、按项目画幅重算短边，避免拉伸。
 * @returns {{presetId,w,h,fps,bitrate,format,audioOnly,gif,ext}}
 */
export function resolveExportOptions(presetId, settings = {}, overrides = {}) {
  const p = presetById(presetId);
  const pw = Number(settings.width) > 0 ? Number(settings.width) : 1920;
  const ph = Number(settings.height) > 0 ? Number(settings.height) : 1080;
  const pfps = Number(settings.fps) > 0 ? Number(settings.fps) : 30;
  let w = p.w || pw;
  let h = p.h || 0;
  if (!h) h = (w * ph) / pw;
  if (p.w && p.h) {
    const presetLand = p.w >= p.h;
    const projLand = pw >= ph;
    if (presetLand !== projLand || Math.abs(p.w / p.h - pw / ph) > 0.02) {
      const long = Math.max(p.w, p.h);
      if (projLand) { w = long; h = (long * ph) / pw; } else { h = long; w = (long * pw) / ph; }
    }
  }
  const o = overrides || {};
  const format = o.format || p.format;
  const audioOnly = format === 'mp3' || format === 'wav';
  const gif = format === 'gif';
  return {
    presetId: p.id,
    w: even(Number(o.w) > 0 ? o.w : w),
    h: even(Number(o.h) > 0 ? o.h : h),
    fps: Math.min(120, Math.max(1, Number(o.fps) > 0 ? Number(o.fps) : p.fps || pfps)),
    bitrate: o.bitrate != null && o.bitrate !== '' && Number.isFinite(Number(o.bitrate)) && Number(o.bitrate) >= 0 ? Number(o.bitrate) : p.bitrate,
    format,
    audioOnly,
    gif,
    ext: extFor(format),
  };
}
