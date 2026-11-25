// 项目摘要（CONTRACTS §B）：给 AI 的紧凑文本上下文。纯函数。
//
// 每镜一行，带编号、时间、素材、调色要点、运镜、转场、字幕、锁定等；
// 聚焦（focus/range）时只详写聚焦镜头及前后各 2 镜，其余压缩成一行，控制 token 数。
import {
  ASPECTS, COLOR_LABELS, FX_LABELS, LOOK_LABELS, MOTION_LABELS, TRANSITION_LABELS,
} from './model.js';
import { itemsInRange, layoutVideo, projectDuration } from './timeline.js';
import { projectBaseline } from './consistency.js';

const KIND_LABELS = { video: '视频', image: '图片', audio: '音频', previz: '预演', 'generated-image': 'AI 图' };
const PACING_LABELS = { slow: '舒缓', medium: '适中', fast: '紧凑' };
const NEIGHBOURS = 2;

function fmtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
}

function fmtNum(v) {
  const r = Math.round(v * 100) / 100;
  return r > 0 ? `+${r}` : String(r);
}

function clip1(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function colorSummary(color) {
  if (!color) return '';
  const parts = [];
  for (const key of ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows']) {
    const v = Number(color[key]);
    if (Number.isFinite(v) && Math.abs(v) >= 0.01) parts.push(`${COLOR_LABELS[key]}${fmtNum(v)}`);
  }
  if (Number(color.vignette) >= 0.01) parts.push(`${COLOR_LABELS.vignette}${Math.round(color.vignette * 100) / 100}`);
  return parts.join(' ');
}

function fxSummary(fx) {
  if (!fx) return '';
  return Object.keys(FX_LABELS)
    .filter((k) => Number(fx[k]) >= 0.01)
    .map((k) => `${FX_LABELS[k]}${Math.round(fx[k] * 100) / 100}`)
    .join(' ');
}

function transformSummary(tr) {
  if (!tr) return '';
  const parts = [];
  if (Number(tr.scale) && Math.abs(tr.scale - 1) >= 0.01) parts.push(`缩放${Math.round(tr.scale * 100) / 100}`);
  if (Math.abs(Number(tr.x) || 0) >= 0.01 || Math.abs(Number(tr.y) || 0) >= 0.01) parts.push(`位移(${Math.round(tr.x * 100) / 100},${Math.round(tr.y * 100) / 100})`);
  if (Math.abs(Number(tr.rotation) || 0) >= 0.5) parts.push(`旋转${Math.round(tr.rotation)}°`);
  if (tr.flipH) parts.push('水平翻转');
  return parts.join(' ');
}

function clipLine(project, item, focused) {
  const { clip, index, start, end, duration } = item;
  const asset = (project.assets || {})[clip.assetId];
  const parts = [`第${index + 1}镜 [${fmtTime(start)}–${fmtTime(end)}, ${duration.toFixed(1)}s] id=${clip.id}`];
  if (asset) {
    let src = `素材「${clip1(asset.name, 30)}」(${KIND_LABELS[asset.kind] || asset.kind},${asset.id})`;
    if (asset.kind === 'video' && Number.isFinite(Number(asset.duration))) src += ` 取${Number(clip.in).toFixed(1)}–${Number(clip.out).toFixed(1)}s/共${Number(asset.duration).toFixed(1)}s`;
    if (asset.description) src += ` 内容：${clip1(asset.description, 40)}`;
    else if (Array.isArray(asset.tags) && asset.tags.length) src += ` 标签：${asset.tags.slice(0, 5).join('、')}`;
    parts.push(src);
  } else {
    parts.push('素材缺失');
  }
  if (clip.label) parts.push(`标注「${clip1(clip.label, 20)}」`);
  const color = clip.color || {};
  if (color.look && color.look !== 'none') parts.push(`风格${LOOK_LABELS[color.look] || color.look}(${Math.round((Number(color.lookStrength) || 0) * 100) / 100})`);
  const grade = colorSummary(color);
  if (grade) parts.push(`调色 ${grade}`);
  if (asset && asset.stats && Number.isFinite(Number(asset.stats.luma))) {
    parts.push(`素材亮度${Math.round(asset.stats.luma * 100) / 100} 暖度${fmtNum(Number(asset.stats.warmth) || 0)}`);
  }
  const motion = clip.motion || {};
  if (motion.preset && motion.preset !== 'none') parts.push(`运镜${MOTION_LABELS[motion.preset] || motion.preset}(${motion.intensity})`);
  const tr = clip.transitionIn || {};
  if (tr.type && tr.type !== 'cut') parts.push(`入场${TRANSITION_LABELS[tr.type] || tr.type}${tr.duration}s`);
  if (Number(clip.speed) && Number(clip.speed) !== 1) parts.push(`${clip.speed}倍速`);
  const fx = fxSummary(clip.fx);
  if (fx) parts.push(`特效 ${fx}`);
  const transform = transformSummary(clip.transform);
  if (transform) parts.push(transform);
  if (clip.mute) parts.push('静音');
  else if (Number.isFinite(Number(clip.volume)) && Number(clip.volume) !== 1) parts.push(`音量${Math.round(clip.volume * 100)}%`);
  if (clip.caption && clip.caption.text) parts.push(`字幕「${clip1(clip.caption.text, 40)}」`);
  if (clip.locked) parts.push('已锁定');
  if (focused) parts.push('★聚焦');
  return parts.join(' | ');
}

function compressedLine(project, items) {
  const first = items[0];
  const last = items[items.length - 1];
  const looks = new Map();
  let locked = 0;
  for (const it of items) {
    const look = (it.clip.color && it.clip.color.look) || 'none';
    looks.set(look, (looks.get(look) || 0) + 1);
    if (it.clip.locked) locked += 1;
  }
  const lookText = [...looks].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${LOOK_LABELS[k] || k}×${n}`).join('、');
  const names = items.slice(0, 3).map((it) => {
    const a = (project.assets || {})[it.clip.assetId];
    return a ? clip1(a.name, 12) : '缺失';
  }).join('、');
  const span = first === last ? `第${first.index + 1}镜` : `第${first.index + 1}–${last.index + 1}镜`;
  return `${span} [${fmtTime(first.start)}–${fmtTime(last.end)}]（略写 ${items.length} 镜：${names}${items.length > 3 ? ' 等' : ''}；风格 ${lookText}${locked ? `；${locked} 镜锁定` : ''}）`;
}

function briefLines(brief) {
  if (!brief) return [];
  const lines = [];
  const head = [brief.title && `「${brief.title}」`, brief.platform, brief.duration && `${brief.duration}s`, brief.aspect].filter(Boolean).join(' · ');
  if (head) lines.push(`简报：${head}`);
  if (brief.goal) lines.push(`  目标：${clip1(brief.goal, 80)}`);
  const style = [
    brief.style && `风格 ${clip1(brief.style, 40)}`,
    brief.mood && `情绪 ${brief.mood}`,
    brief.look && brief.look !== 'none' && `调色 ${LOOK_LABELS[brief.look] || brief.look}`,
    PACING_LABELS[brief.pacing] && `节奏 ${PACING_LABELS[brief.pacing]}`,
  ].filter(Boolean).join('；');
  if (style) lines.push(`  ${style}`);
  if (brief.keyMessage) lines.push(`  核心信息：${clip1(brief.keyMessage, 60)}`);
  if (Array.isArray(brief.mustHave) && brief.mustHave.length) lines.push(`  必须有：${brief.mustHave.slice(0, 8).join('、')}`);
  if (Array.isArray(brief.avoid) && brief.avoid.length) lines.push(`  避免：${brief.avoid.slice(0, 8).join('、')}`);
  return lines;
}

function normRange(r) {
  if (!r || !Number.isFinite(Number(r.start)) || !Number.isFinite(Number(r.end))) return null;
  const a = Number(r.start);
  const b = Number(r.end);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/**
 * @param {object} project
 * @param {{range?:{start:number,end:number}, focus?:{start:number,end:number}, maxClips?:number}} [options]
 * @returns {string}
 */
export function projectSummary(project, { range, focus, maxClips = 60 } = {}) {
  if (!project || typeof project !== 'object') return '（没有打开的项目）';
  const settings = project.settings || {};
  const layout = layoutVideo(project);
  const total = projectDuration(project, layout);
  const lines = [];
  const overlays = Array.isArray(project.overlays) ? project.overlays : [];
  const markers = Array.isArray(project.markers) ? project.markers : [];
  const extraCounts = [
    overlays.length ? `画中画 ${overlays.length} 个` : '',
    markers.length ? `标记 ${markers.length} 个` : '',
  ].filter(Boolean);
  const aspectLabel = ASPECTS[settings.aspect] ? ASPECTS[settings.aspect].label : settings.aspect || '未知画幅';
  lines.push(`项目「${project.name || '未命名项目'}」：${aspectLabel} ${settings.width || '?'}×${settings.height || '?'} ${settings.fps || 30}fps，总时长 ${total.toFixed(1)}s，主轨 ${layout.length} 镜${extraCounts.length ? `，${extraCounts.join('，')}` : ''}`);
  lines.push(...briefLines(project.brief));

  const memory = project.memory || {};
  if (memory.styleGuide) lines.push(`风格指南：${clip1(memory.styleGuide, 300)}`);
  const baseline = memory.colorBaseline || projectBaseline(project);
  if (baseline) {
    lines.push(`色彩基准${memory.colorBaseline ? '（已确认）' : '（自动）'}：亮度${baseline.luma} 对比${baseline.contrast} 饱和${baseline.saturation} 暖度${baseline.warmth}${Array.isArray(baseline.palette) && baseline.palette.length ? ` 主色${baseline.palette.slice(0, 3).join(' ')}` : ''}`);
  }
  const decisions = Array.isArray(memory.decisions) ? memory.decisions.slice(-5) : [];
  if (decisions.length) lines.push(`已定决策：${decisions.map((d) => clip1(d && d.text, 50)).filter(Boolean).join('；')}`);

  // ---- 主轨 ----
  const span = normRange(focus) || normRange(range);
  lines.push('主轨：');
  if (!layout.length) {
    lines.push('  （空，还没有镜头）');
  } else {
    const focusSet = new Set(span ? itemsInRange(layout, span.start, span.end).map((it) => it.index) : []);
    const detailed = new Set();
    if (span) {
      lines.push(`  聚焦范围 ${fmtTime(span.start)}–${fmtTime(span.end)}，聚焦镜头：${focusSet.size ? [...focusSet].map((i) => `第${i + 1}镜`).join('、') : '无（范围内没有镜头）'}`);
      for (const i of focusSet) for (let d = -NEIGHBOURS; d <= NEIGHBOURS; d += 1) if (layout[i + d]) detailed.add(i + d);
      if (!focusSet.size) for (let i = 0; i < Math.min(layout.length, NEIGHBOURS * 2 + 1); i += 1) detailed.add(i);
    } else {
      const max = Number.isInteger(maxClips) && maxClips > 0 ? maxClips : 60;
      if (layout.length <= max) layout.forEach((_, i) => detailed.add(i));
      else {
        const head = Math.ceil(max / 2);
        const tail = max - head;
        for (let i = 0; i < head; i += 1) detailed.add(i);
        for (let i = layout.length - tail; i < layout.length; i += 1) detailed.add(i);
      }
    }
    let run = [];
    const flush = () => {
      if (run.length) lines.push(`  ${compressedLine(project, run)}`);
      run = [];
    };
    for (const item of layout) {
      if (detailed.has(item.index)) {
        flush();
        lines.push(`  ${clipLine(project, item, focusSet.has(item.index))}`);
      } else {
        run.push(item);
      }
    }
    flush();
  }

  // ---- 文字轨 / 音频轨 ----
  const texts = (project.tracks && project.tracks.text) || [];
  if (texts.length) {
    lines.push(`文字轨（${texts.length}）：`);
    for (const t of texts.slice(0, 20)) {
      lines.push(`  ${t.id} [${fmtTime(t.start)}–${fmtTime((Number(t.start) || 0) + (Number(t.duration) || 0))}] ${t.preset}「${clip1(t.text, 30)}」${t.locked ? ' 已锁定' : ''}`);
    }
    if (texts.length > 20) lines.push(`  …另有 ${texts.length - 20} 条文字`);
  }
  const audios = (project.tracks && project.tracks.audio) || [];
  if (audios.length) {
    lines.push(`音频轨（${audios.length}）：`);
    for (const a of audios.slice(0, 10)) {
      const asset = (project.assets || {})[a.assetId];
      const len = (Number(a.out) || 0) - (Number(a.in) || 0);
      lines.push(`  ${a.id} ${a.role === 'voice' ? '人声' : a.role === 'sfx' ? '音效' : '音乐'}「${asset ? clip1(asset.name, 24) : '素材缺失'}」[${fmtTime(a.start)}–${fmtTime((Number(a.start) || 0) + len)}] 音量${Math.round((Number(a.volume) || 0) * 100)}%${a.locked ? ' 已锁定' : ''}`);
    }
    if (audios.length > 10) lines.push(`  …另有 ${audios.length - 10} 条音频`);
  }

  // ---- 素材库 ----
  const assets = Object.values(project.assets || {}).filter(Boolean);
  if (assets.length) {
    const usedIds = new Set([
      ...layout.map((it) => it.clip.assetId),
      ...layout.map((it) => (it.clip.canvas && it.clip.canvas.type === 'image' ? it.clip.canvas.value : null)),
      ...audios.map((a) => a.assetId),
      ...overlays.map((o) => o && o.assetId),
    ].filter(Boolean));
    const unused = assets.filter((a) => !usedIds.has(a.id));
    const counts = {};
    for (const a of assets) counts[a.kind] = (counts[a.kind] || 0) + 1;
    lines.push(`素材库：${Object.entries(counts).map(([k, n]) => `${KIND_LABELS[k] || k}${n}`).join('、')}，未使用 ${unused.length} 个`);
    for (const a of unused.slice(0, 15)) {
      const extra = a.description ? ` ${clip1(a.description, 30)}` : Array.isArray(a.tags) && a.tags.length ? ` 标签：${a.tags.slice(0, 4).join('、')}` : '';
      lines.push(`  未用 ${a.id} ${KIND_LABELS[a.kind] || a.kind}「${clip1(a.name, 24)}」${Number.isFinite(Number(a.duration)) ? ` ${Number(a.duration).toFixed(1)}s` : ''}${extra}`);
    }
    if (unused.length > 15) lines.push(`  …另有 ${unused.length - 15} 个未用素材`);
  }

  const storyboard = Array.isArray(project.storyboard) ? project.storyboard : [];
  if (storyboard.length) {
    const byStatus = {};
    for (const s of storyboard) byStatus[s.status || 'planned'] = (byStatus[s.status || 'planned'] || 0) + 1;
    const labels = { planned: '待拍', 'has-reference': '有参考', 'has-previz': '有预演', 'has-footage': '有素材' };
    lines.push(`分镜：${storyboard.length} 个（${Object.entries(byStatus).map(([k, n]) => `${labels[k] || k}${n}`).join('、')}）`);
  }
  return lines.join('\n');
}
