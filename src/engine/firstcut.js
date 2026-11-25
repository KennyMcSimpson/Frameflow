// 一键初剪：按分镜把素材排上主轨，缺实拍素材的分镜用预演动画占位。纯函数，不修改入参。
//
// 素材匹配优先级：shot.assetId（用户/AI 指定）> shot.aiVideoAssetId（AI 生成视频）> shot.footageAssetId（自动配的实拍参考素材）> 素材库里标签/名称/描述最贴合的视频或图片 > 预演资产。
// 每个素材只用一次，全局按匹配分从高到低分配，避免先到的分镜抢走更适合后面分镜的素材。
import {
  LIMITS, LOOKS, LOOK_LABELS, MOTIONS, TRANSITIONS, createClip, createPrevizSpec, createTextClip,
} from './model.js';
import { uid, deepClone } from './ids.js';
import { clipDuration, layoutVideo } from './timeline.js';

const FOOTAGE_KINDS = new Set(['video', 'image', 'generated-image']);
// 分镜里的转场写成字符串；首镜只能 cut 或从黑/白淡入，不能和「前一镜」重叠
const FIRST_CLIP_TRANSITIONS = new Set(['cut', 'dip-black', 'dip-white', 'crossfade']);
const PACING_FACTOR = { slow: 1.1, medium: 1, fast: 0.85 };
const PACING_TRANSITION = { slow: 0.8, medium: 0.5, fast: 0.3 };
const PACING_LABEL = { slow: '舒缓', medium: '适中', fast: '紧凑' };

const STOP_WORDS = new Set([
  '镜头', '画面', '一个', '视频', '素材', '特写', '近景', '远景', '中景', '全景', '慢慢', '缓缓', '然后', '之后', '我们', '你们', '他们',
  '这个', '那个', '一些', '进行', '可以', '正在', '时候', '的人', '一下', '里的', '上的', '中的', '片段', '拍摄', '图片', '照片',
  'img', 'mov', 'mp4', 'jpg', 'png', 'the', 'and', 'with', 'video', 'clip', 'shot', 'dsc', 'vid',
]);

function round2(v) {
  return Math.round(v * 100) / 100;
}

// ---------- 关键词 ----------

/** 中文按两字切分、英文按单词切分，去掉停用词与纯数字 */
function tokenize(text) {
  const out = new Set();
  if (!text) return out;
  const s = String(text).toLowerCase().replace(/\.[a-z0-9]{2,4}$/i, '');
  for (const run of s.match(/[一-鿿]+/g) || []) {
    if (run.length === 1) continue;
    for (let i = 0; i < run.length - 1; i += 1) {
      const bi = run.slice(i, i + 2);
      if (!STOP_WORDS.has(bi)) out.add(bi);
    }
  }
  for (const word of s.match(/[a-z][a-z0-9]+/g) || []) {
    if (word.length >= 3 && !STOP_WORDS.has(word)) out.add(word);
  }
  return out;
}

function shotKeywords(shot) {
  const strong = new Set([...tokenize(shot.title), ...tokenize(shot.subject), ...tokenize(shot.location)]);
  const weak = new Set();
  const extra = [shot.action, ...(Array.isArray(shot.referenceQueries) ? shot.referenceQueries : [])].join(' ');
  for (const t of tokenize(extra)) if (!strong.has(t)) weak.add(t);
  return { strong, weak };
}

function assetFields(asset) {
  const tags = new Set();
  for (const tag of Array.isArray(asset.tags) ? asset.tags : []) {
    const str = String(tag).toLowerCase();
    tags.add(str);
    for (const t of tokenize(str)) tags.add(t);
  }
  return { tags, name: tokenize(asset.name), description: tokenize(asset.description) };
}

function matchScore(keywords, fields) {
  let score = 0;
  const weigh = (token, factor) => {
    if (fields.tags.has(token)) score += 3 * factor;
    if (fields.name.has(token)) score += 2 * factor;
    if (fields.description.has(token)) score += 1 * factor;
  };
  for (const t of keywords.strong) weigh(t, 1);
  for (const t of keywords.weak) weigh(t, 0.4);
  return score;
}

// ---------- 镜头参数 ----------

function shotDuration(shot, pacing) {
  const base = Number(shot.duration) > 0 ? Number(shot.duration) : 4;
  return round2(Math.max(LIMITS.minClip, base * (PACING_FACTOR[pacing] || 1)));
}

function motionFor(movement) {
  if (movement === 'handheld') return { preset: 'shake', intensity: 0.2 };
  if (movement === 'orbit' || movement === 'tracking') return { preset: 'drift', intensity: 0.5 };
  if (MOTIONS.includes(movement) && movement !== 'none') return { preset: movement, intensity: 0.5 };
  return { preset: 'none', intensity: 0.5 };
}

function transitionFor(shot, isFirst, pacing) {
  const raw = shot.transitionIn;
  let type = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw.type : 'cut';
  if (!TRANSITIONS.includes(type)) type = 'cut';
  if (isFirst && !FIRST_CLIP_TRANSITIONS.has(type)) type = 'cut';
  let duration = PACING_TRANSITION[pacing] || 0.5;
  if (raw && typeof raw === 'object' && Number(raw.duration) > 0) duration = Number(raw.duration);
  if (type === 'flash' || type === 'whip-pan') duration = Math.min(duration, 0.3);
  duration = Math.min(LIMITS.maxTransition, Math.max(LIMITS.minTransition, duration));
  return { type, duration: round2(duration) };
}

function lookFor(shot, brief) {
  if (LOOKS.includes(shot.look) && shot.look !== 'none') return shot.look;
  if (brief && LOOKS.includes(brief.look)) return brief.look;
  return 'none';
}

// ---------- 预演资产 ----------

/** 为分镜创建预演资产（kind:'previz'），渲染器按 previz 规格画示意动画 */
export function makePrevizAsset(shot, project) {
  const s = shot || {};
  const settings = (project && project.settings) || {};
  const title = s.title || `第${s.index || ''}镜`;
  const keywords = [s.subject, s.location].filter(Boolean);
  return {
    id: uid('ast'),
    kind: 'previz',
    name: `预演：${title}`,
    path: null,
    duration: Number(s.duration) > 0 ? Number(s.duration) : 4,
    width: Number(settings.width) || 1920,
    height: Number(settings.height) || 1080,
    fps: Number(settings.fps) || 30,
    hasAudio: false,
    size: 0,
    thumb: null,
    source: { type: 'previz' },
    tags: ['预演', ...keywords.map((k) => String(k).slice(0, 20))],
    description: [s.subject, s.action].filter(Boolean).join('；').slice(0, 200),
    previz: s.previz && typeof s.previz === 'object' ? deepClone(s.previz) : createPrevizSpec(),
    shotId: s.id || null,
  };
}

function findPreviz(assets, shot) {
  return Object.values(assets).find((a) => a && a.kind === 'previz' && shot.id && a.shotId === shot.id) || null;
}

// ---------- 匹配 ----------

function matchAssets(shots, assets, report) {
  const chosen = new Map(); // shot.id -> asset
  const used = new Set();
  for (const shot of shots) {
    if (!shot.assetId) continue;
    const asset = assets[shot.assetId];
    if (asset && asset.kind !== 'audio' && !used.has(asset.id)) {
      chosen.set(shot.id, asset);
      used.add(asset.id);
    } else if (!asset) {
      report.push(`第${shot.index}镜：指定的素材已不在素材库中，改为自动匹配`);
    } else if (asset.kind === 'audio') {
      report.push(`第${shot.index}镜：指定的是音频素材，不能放到画面轨，改为自动匹配`);
    }
  }

  // 实拍/AI 视频素材：专属于对应分镜，不参与其他分镜的自动匹配。
  // 画面来源优先级：用户指定 assetId > AI 视频 aiVideoAssetId > 实拍 footageAssetId > 自动匹配 > previz
  const reserved = new Set();
  for (const key of ['aiVideoAssetId', 'footageAssetId']) {
    for (const shot of shots) {
      const asset = shot[key] ? assets[shot[key]] : null;
      if (!asset || asset.kind === 'audio' || asset.kind === 'previz') continue;
      reserved.add(asset.id);
      if (!chosen.has(shot.id) && !used.has(asset.id)) {
        chosen.set(shot.id, asset);
        used.add(asset.id);
      }
    }
  }

  const pool = Object.values(assets).filter((a) => a && FOOTAGE_KINDS.has(a.kind) && !used.has(a.id) && !reserved.has(a.id) && !a.stockForShot);
  const fields = new Map(pool.map((a) => [a.id, assetFields(a)]));
  const pairs = [];
  for (const shot of shots) {
    if (chosen.has(shot.id)) continue;
    const keywords = shotKeywords(shot);
    for (const asset of pool) {
      const score = matchScore(keywords, fields.get(asset.id));
      if (score <= 0) continue;
      const fitBonus = asset.kind === 'video' && Number(asset.duration) >= (Number(shot.duration) || 4) ? 0.1 : 0;
      pairs.push({ shot, asset, score: score + fitBonus });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.shot.index - b.shot.index);
  for (const { shot, asset } of pairs) {
    if (chosen.has(shot.id) || used.has(asset.id)) continue;
    chosen.set(shot.id, asset);
    used.add(asset.id);
  }
  return { chosen, used, pool };
}

// ---------- 镜头文案 → 文字轨 ----------

function shotCaptionOf(clip, storyboard) {
  const own = clip && clip.caption && String(clip.caption.text || '').trim();
  if (own) return own;
  const shot = clip && clip.shotId ? storyboard.find((s) => s && s.id === clip.shotId) : null;
  return shot ? String(shot.caption || '').trim() : '';
}

/** 为每个有文案的主轨镜头生成一条与其时间对齐的 TextClip（source:'shot-caption', linkShotId=镜头 id） */
export function shotCaptionTexts(project) {
  const storyboard = Array.isArray(project && project.storyboard) ? project.storyboard : [];
  const aspect = project && project.settings && project.settings.aspect;
  const vertical = aspect === '9:16';
  const out = [];
  for (const it of layoutVideo(project)) {
    const text = shotCaptionOf(it.clip, storyboard).slice(0, 300);
    if (!text) continue;
    out.push(createTextClip({
      start: round2(it.start), duration: round2(Math.max(0.1, it.end - it.start)), text,
      preset: 'subtitle', y: vertical ? 0.72 : 0.86, size: vertical ? 0.9 : 0.8, animation: 'none',
      stroke: { color: '#000000', width: 3 }, source: 'shot-caption', linkShotId: it.clip.id,
    }));
  }
  return out;
}

/** 旧工程迁移：文字轨为空且镜头有文案时生成一次；已迁移（timeline.captionsMigrated）则原样返回 */
export function migrateShotCaptions(project) {
  if (!project || !project.tracks || (project.timeline && project.timeline.captionsMigrated)) return project;
  const text = Array.isArray(project.tracks.text) ? project.tracks.text : [];
  if (text.length) return project;
  const made = shotCaptionTexts(project);
  if (!made.length) return project;
  return { ...project, tracks: { ...project.tracks, text: made }, timeline: { ...(project.timeline || {}), captionsMigrated: true } };
}

// ---------- 主函数 ----------

function styleGuideFromBrief(brief) {
  if (!brief) return '';
  const parts = [];
  if (brief.style) parts.push(brief.style);
  if (brief.mood) parts.push(`情绪${brief.mood}`);
  if (brief.look && brief.look !== 'none') parts.push(`统一使用「${LOOK_LABELS[brief.look] || brief.look}」调色`);
  if (PACING_LABEL[brief.pacing]) parts.push(`${PACING_LABEL[brief.pacing]}节奏`);
  if (Array.isArray(brief.avoid) && brief.avoid.length) parts.push(`避免${brief.avoid.slice(0, 3).join('、')}`);
  return parts.length ? `${parts.join('，')}。` : '';
}

function placeFootage(clip, asset, length, shot, report) {
  if (asset.kind !== 'video') return { ...clip, in: 0, out: length };
  const total = Number(asset.duration);
  if (!(total > 0)) return { ...clip, in: 0, out: length };
  if (total <= length) {
    if (total < length - 0.05) report.push(`第${shot.index}镜：素材只有 ${round2(total)} 秒，短于计划的 ${length} 秒，已用完整素材`);
    return { ...clip, in: 0, out: round2(Math.max(LIMITS.minClip, total)) };
  }
  // 拍摄的开头和结尾常有晃动或等待，从素材中段截取
  const start = round2((total - length) / 2);
  return { ...clip, in: start, out: round2(start + length) };
}

/**
 * 根据分镜生成初剪。替换主轨，保留文字轨与音频轨。
 * @param {object} project
 * @param {{usePreviz?: boolean}} [options] usePreviz=false 时不用预演，缺素材的分镜改用剩余素材或跳过
 * @returns {{project: object, report: string[]}}
 */
export function buildFirstCut(project, { usePreviz = true } = {}) {
  if (!project || typeof project !== 'object') return { project, report: ['没有可用的项目'] };
  const storyboard = Array.isArray(project.storyboard) ? project.storyboard : [];
  if (!storyboard.length) {
    return { project, report: ['还没有分镜，无法初剪。先在创作模式里和 AI 导演聊聊想法，生成分镜后再试。'] };
  }

  const report = [];
  const brief = project.brief || null;
  const pacing = brief && PACING_FACTOR[brief.pacing] ? brief.pacing : 'medium';
  const shots = storyboard
    .map((s, i) => ({ ...s, index: Number.isFinite(Number(s.index)) ? Number(s.index) : i + 1, id: s.id || `shot_${i + 1}` }))
    .sort((a, b) => a.index - b.index);
  const assets = { ...(project.assets || {}) };
  const { chosen, used, pool } = matchAssets(shots, assets, report);

  const leftovers = usePreviz ? [] : pool.filter((a) => !used.has(a.id));
  const clips = [];
  const shotUpdates = new Map();
  let total = 0;

  for (const shot of shots) {
    const n = shot.index;
    if (clips.length >= LIMITS.maxClips) {
      report.push(`第${n}镜起未加入：主轨最多 ${LIMITS.maxClips} 段`);
      break;
    }
    const length = shotDuration(shot, pacing);
    if (total + length > LIMITS.maxDuration) {
      report.push(`第${n}镜起未加入：成片不能超过 ${LIMITS.maxDuration} 秒`);
      break;
    }

    let asset = chosen.get(shot.id) || null;
    let source = asset ? (shot.assetId === asset.id ? 'assigned' : shot.aiVideoAssetId === asset.id ? 'aivideo' : shot.footageAssetId === asset.id ? 'footage' : 'matched') : null;
    if (!asset && !usePreviz && leftovers.length) {
      asset = leftovers.shift();
      used.add(asset.id);
      source = 'fallback';
    }
    if (!asset && usePreviz) {
      const existing = findPreviz(assets, shot);
      if (existing) {
        asset = { ...existing, previz: shot.previz ? deepClone(shot.previz) : existing.previz, duration: length > 0 ? Math.max(length, Number(shot.duration) || 0) : existing.duration };
      } else {
        asset = makePrevizAsset(shot, project);
        asset.duration = Math.max(asset.duration, length);
      }
      assets[asset.id] = asset;
      source = 'previz';
    }
    if (!asset) {
      report.push(`第${n}镜：没有可用素材，已跳过（可导入素材或开启预演后重新初剪）`);
      continue;
    }

    const look = lookFor(shot, brief);
    let clip = createClip(asset, {
      label: String(shot.title || '').slice(0, 60),
      notes: String(shot.action || '').slice(0, 500),
      shotId: storyboard.some((s) => s.id === shot.id) ? shot.id : null,
      caption: { text: String(shot.caption || '').slice(0, 300), style: 'subtitle', position: 'bottom' },
      motion: motionFor(shot.movement),
      transitionIn: transitionFor(shot, clips.length === 0, pacing),
    });
    clip.color = { ...clip.color, look, lookStrength: look === 'none' ? 1 : 0.8 };
    clip = placeFootage(clip, asset, length, shot, report);
    clips.push(clip);
    total += clipDuration(clip);

    const title = shot.title ? `「${shot.title}」` : '';
    if (source === 'previz') report.push(`第${n}镜${title}：使用预演动画（缺实拍素材）`);
    else if (source === 'aivideo') report.push(`第${n}镜${title}：使用 AI 生成视频「${asset.name}」`);
    else if (source === 'footage') report.push(`第${n}镜${title}：使用实拍参考素材「${asset.name}」`);
    else if (source === 'assigned') report.push(`第${n}镜${title}：使用指定素材「${asset.name}」`);
    else if (source === 'matched') report.push(`第${n}镜${title}：匹配到素材「${asset.name}」`);
    else report.push(`第${n}镜${title}：没有贴合的素材，暂用「${asset.name}」占位`);

    const status = source === 'previz'
      ? (shot.status === 'planned' || !shot.status ? 'has-previz' : shot.status)
      : 'has-footage';
    shotUpdates.set(shot.id, { status, assetId: source === 'previz' || source === 'footage' || source === 'aivideo' ? (shot.assetId && assets[shot.assetId] ? shot.assetId : null) : asset.id });
  }

  const unused = Object.values(assets).filter((a) => a && FOOTAGE_KINDS.has(a.kind) && !used.has(a.id));
  if (unused.length) {
    const names = unused.slice(0, 5).map((a) => `「${a.name}」`).join('、');
    report.push(`有 ${unused.length} 个素材没有用上：${names}${unused.length > 5 ? ' 等' : ''}`);
  }
  if (brief && brief.aspect && project.settings && brief.aspect !== project.settings.aspect) {
    report.push(`提示：简报要求画幅 ${brief.aspect}，当前项目是 ${project.settings.aspect}，如需更改请在设置里调整画幅`);
  }

  const storyboardOut = storyboard.map((s) => {
    const update = shotUpdates.get(s.id);
    return update ? { ...s, ...update } : s;
  });
  const memory = { styleGuide: '', decisions: [], colorBaseline: null, ...(project.memory || {}) };
  if (!String(memory.styleGuide || '').trim()) {
    const guide = styleGuideFromBrief(brief);
    if (guide) memory.styleGuide = guide;
  }

  const tracks = project.tracks || {};
  const keptTexts = (Array.isArray(tracks.text) ? tracks.text : []).filter((t) => !(t && t.source === 'shot-caption'));
  const draftNext = { ...project, assets, storyboard: storyboardOut, tracks: { video: clips, text: [], audio: [] } };
  const next = {
    ...project,
    assets,
    storyboard: storyboardOut,
    memory,
    // 文案字幕已在这里生成：标记为已迁移，用户之后删掉的字幕不会在重开工程时复活
    timeline: { ...(project.timeline || {}), captionsMigrated: true },
    tracks: {
      video: clips,
      text: [...keptTexts, ...shotCaptionTexts(draftNext)],
      audio: Array.isArray(tracks.audio) ? tracks.audio : [],
    },
  };

  if (!clips.length) {
    report.push('初剪没有生成任何镜头');
    return { project, report };
  }
  // 转场重叠会让成片略短于各镜相加，这里报的是不计重叠的约数
  report.push(`初剪完成：共 ${clips.length} 镜，约 ${round2(total)} 秒`);
  return { project: next, report };
}
