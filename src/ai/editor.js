// AI 精修：带全片记忆构造精修请求，解析为可执行 Op。
// 完整流程（runEditPipeline）：
//   挑选素材库候选 → 理解指令（1 次调用）→ 解析 → 预检 lint → 必要时定向修复（最多再 1 次）→ 改动对比 + 是否需要确认。
// 调用模型的函数由调用方注入（界面里是 runAI，测试里是录制好的回复），本文件不直接依赖界面。
import { LOOK_LABELS, MOTION_LABELS, TRANSITION_LABELS, TECHNIQUE_CATEGORY_LABELS, createBrief } from '../engine/model.js';
import { describeOp } from '../engine/ops.js';
import { projectSummary } from '../engine/summary.js';
import { EDIT_SCHEMA, EDIT_REPAIR_SCHEMA, normalizeAiOp, flattenOp } from './schemas.js';
import { memoryPromptBlock, looksLikeRule } from './memory.js';
import { lintOps, repairableDiagnostics, friendlyMessage } from './lint.js';
import { diffProject, summarizeDiff, needsConfirm } from './diff.js';
import { createBudget } from './budget.js';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function text(v, max = 400) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function r2(n) { return Math.round(Number(n) * 100) / 100; }
function fmt(t) {
  const s = Math.max(0, Number(t) || 0);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
}
function signed(n) { const v = r2(n); return v > 0 ? `+${v}` : String(v); }

/** 私有布局计算（与主引擎时间线布局规则一致），避免依赖其他模块的内部实现 */
export function simpleLayout(project) {
  const clips = (project && project.tracks && Array.isArray(project.tracks.video)) ? project.tracks.video : [];
  const out = [];
  let prevEnd = 0; let prevDur = 0;
  clips.forEach((clip, i) => {
    const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
    const dur = Math.max(0.05, ((Number(clip.out) || 0) - (Number(clip.in) || 0)) / speed);
    const tr = clip.transitionIn || { type: 'cut', duration: 0.5 };
    const overlap = i === 0 || tr.type === 'cut' ? 0 : Math.min(Number(tr.duration) || 0.5, dur / 2, prevDur / 2);
    const start = i === 0 ? 0 : prevEnd - overlap;
    const end = start + dur;
    out.push({ clip, index: i, start, end, duration: dur, overlap });
    prevEnd = end; prevDur = dur;
  });
  return out;
}

function colorBrief(c) {
  if (!c) return '';
  const parts = [];
  for (const k of ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows']) {
    if (Math.abs(Number(c[k]) || 0) >= 0.01) parts.push(`${{ exposure: '曝光', contrast: '对比', saturation: '饱和', temperature: '色温', tint: '色调', highlights: '高光', shadows: '阴影' }[k]}${signed(c[k])}`);
  }
  if ((Number(c.vignette) || 0) > 0.01) parts.push(`暗角${r2(c.vignette)}`);
  if (c.look && c.look !== 'none') parts.push(`风格:${LOOK_LABELS[c.look] || c.look}×${r2(c.lookStrength ?? 1)}`);
  return parts.join(' ');
}

function clipLine(item, project) {
  const c = item.clip;
  const a = project.assets && project.assets[c.assetId];
  const bits = [
    `第${item.index + 1}镜 [${c.id}] ${fmt(item.start)}–${fmt(item.end)}（${r2(item.duration)}秒）`,
    a ? `素材「${text(a.name, 30)}」(${a.kind}${a.tags && a.tags.length ? '，' + a.tags.slice(0, 4).join('/') : ''})` : '素材缺失',
  ];
  const col = colorBrief(c.color);
  if (col) bits.push(`调色:${col}`);
  if (c.motion && c.motion.preset && c.motion.preset !== 'none') bits.push(`运镜:${MOTION_LABELS[c.motion.preset] || c.motion.preset}`);
  if (c.transitionIn && c.transitionIn.type !== 'cut') bits.push(`入场:${TRANSITION_LABELS[c.transitionIn.type] || c.transitionIn.type} ${r2(c.transitionIn.duration)}秒`);
  if (c.speed && c.speed !== 1) bits.push(`${r2(c.speed)}倍速`);
  if (c.caption && c.caption.text) bits.push(`字幕「${text(c.caption.text, 30)}」`);
  if (c.locked) bits.push('[已锁定]');
  return bits.join('｜');
}

/** summary.js 不可用时的兜底摘要 */
function fallbackSummary(project, layout) {
  if (!layout.length) return '主轨还是空的（没有任何镜头）。';
  const total = layout[layout.length - 1].end;
  return [`共 ${layout.length} 镜，总时长 ${r2(total)} 秒，画幅 ${project.settings && project.settings.aspect}。`, ...layout.slice(0, 60).map((it) => clipLine(it, project))].join('\n');
}

function baselineText(b) {
  if (!b || typeof b !== 'object') return '尚未计算（素材色彩统计还没完成）';
  const warm = Number(b.warmth) || 0;
  return `平均亮度 ${r2(b.luma)}，对比 ${r2(b.contrast)}，饱和 ${r2(b.saturation)}，冷暖 ${signed(warm)}（${warm > 0.05 ? '偏暖' : warm < -0.05 ? '偏冷' : '中性'}），色调 ${signed(b.tint)}${Array.isArray(b.palette) && b.palette.length ? `，主色 ${b.palette.slice(0, 5).join(' ')}` : ''}`;
}

function rangeItems(layout, range) {
  if (!range || !(Number(range.end) > Number(range.start))) return [];
  return layout.filter((it) => it.end > range.start && it.start < range.end);
}

function opHint(op) {
  const f = flattenOp(op);
  const keep = Object.entries(f).filter(([k, v]) => v !== null && !(Array.isArray(v) && !v.length) && k !== 'targetMode');
  return keep.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(' ');
}

function tagList(a) {
  if (Array.isArray(a.tags)) return a.tags.filter((t) => typeof t === 'string');
  return typeof a.tags === 'string' ? a.tags.split(/[,，、\s]+/).filter(Boolean) : [];
}

/** 素材行：id｜名称｜类型｜时长｜标签｜描述（描述 60 字以内） */
function assetRow(a) {
  const desc = (typeof a.description === 'string' ? a.description : '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${a.id}｜${text(a.name, 40)}｜${a.kind}｜${r2(a.duration)}秒｜${tagList(a).slice(0, 6).join('、')}${desc ? `｜${desc}` : ''}`;
}

// ---------------------------------------------------------------------------
// 素材库候选：按指令检索 top 30，再补最新 10 条
// 渲染端用简化 BM25 打分：名称权重 3、标签 2、描述 1；中文按单字 + 相邻两字切分，英文/数字按词。
// 指令里直接出现素材名时额外加分，保证「把第二段换成海边日落」这类说法一定能找到那条素材。
// ---------------------------------------------------------------------------
const STOP_CHARS = new Set('的了是把在和与或就也都个这那些段镜第换成加上到给让请帮我你它们吧呢吗啊一下再点用里中么得着过很更最'.split(''));
const STOP_WORDS = new Set(['素材', '镜头', '片段', '这个', '那个', '一下', '换成', '加上', '加个', '一段', '视频', '画面', '这段', '那段', '帮我', '然后', '一点', '有点', '之后', '前面', '后面', 'mp4', 'mov', 'jpg', 'png', 'wav', 'mp3']);

/** 文本切词：英文/数字整词，中文单字（去掉虚词）+ 相邻两字 */
export function tokenize(s) {
  const src = String(s || '').toLowerCase();
  const out = [];
  for (const w of src.match(/[a-z0-9]{2,}/g) || []) if (!STOP_WORDS.has(w)) out.push(w);
  for (const run of src.match(/[一-鿿]+/g) || []) {
    for (let i = 0; i < run.length; i++) {
      const ch = run[i];
      if (!STOP_CHARS.has(ch)) out.push(ch);
      if (i + 1 < run.length) {
        const bi = run.slice(i, i + 2);
        if (!STOP_WORDS.has(bi)) out.push(bi);
      }
    }
  }
  return out;
}

function baseName(name) {
  return String(name || '').replace(/\.[a-z0-9]{2,4}$/i, '').trim().toLowerCase();
}

/**
 * 按指令给素材库打分（越相关越靠前）。
 * @returns {{asset:object, score:number}[]} 只含得分 > 0 的条目
 */
export function rankLibraryAssets(library, command) {
  const list = (Array.isArray(library) ? library : []).filter((a) => a && a.id);
  const q = tokenize(command);
  const cmd = String(command || '').toLowerCase();
  if (!list.length || (!q.length && !cmd.trim())) return [];
  const FIELDS = [['name', 3], ['tags', 2], ['description', 1]];
  const docs = list.map((a) => {
    const tf = new Map();
    let len = 0;
    for (const [field, w] of FIELDS) {
      const raw = field === 'tags' ? tagList(a).join(' ') : field === 'name' ? baseName(a.name) : (typeof a.description === 'string' ? a.description : '');
      for (const tok of tokenize(raw)) { tf.set(tok, (tf.get(tok) || 0) + w); len += 1; }
    }
    return { a, tf, len };
  });
  const avg = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1;
  const df = new Map();
  for (const d of docs) for (const tok of d.tf.keys()) df.set(tok, (df.get(tok) || 0) + 1);
  const N = docs.length;
  const k1 = 1.2; const b = 0.75;
  const qset = Array.from(new Set(q));
  const scored = docs.map((d) => {
    let score = 0;
    for (const tok of qset) {
      const f = d.tf.get(tok);
      if (!f) continue;
      const n = df.get(tok) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const weight = tok.length === 1 ? 0.35 : 1; // 单字只作补充
      score += weight * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg)));
    }
    const nm = baseName(d.a.name);
    if (nm.length >= 2 && cmd.includes(nm)) score += 10; // 指令里直接说了素材名
    for (const t of tagList(d.a)) if (t.length >= 2 && cmd.includes(t.toLowerCase())) score += 1.5;
    return { asset: d.a, score };
  });
  return scored.filter((s) => s.score > 0.2).sort((x, y) => y.score - x.score);
}

function addedTime(a) {
  const t = Date.parse(a && (a.addedAt || a.createdAt || a.importedAt) || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * 精修请求用的素材库候选：与指令相关的前 top 条 + 最新的 recent 条（按 id 去重），排除已在项目里的素材。
 * 指令空洞（没有任何命中）时退回「最新 fallback 条」，与旧行为一致。
 * @param {object[]} library 素材库全量列表（library:assets 不带 query 的结果）
 * @param {string} command
 * @param {{top?:number, recent?:number, fallback?:number, exclude?:object|Set|string[]}} [opts]
 */
export function pickLibraryCandidates(library, command, { top = 30, recent = 10, fallback = 40, exclude } = {}) {
  const ex = exclude instanceof Set ? exclude
    : new Set(Array.isArray(exclude) ? exclude : Object.keys(exclude && typeof exclude === 'object' ? exclude : {}));
  const list = (Array.isArray(library) ? library : []).filter((a) => a && a.id && !ex.has(a.id));
  // 保持原顺序作为新旧次序；带 addedAt 时按时间从新到旧
  const newest = list.some((a) => addedTime(a)) ? [...list].sort((x, y) => addedTime(y) - addedTime(x)) : list;
  const ranked = rankLibraryAssets(list, command).map((s) => s.asset);
  if (!ranked.length) return newest.slice(0, fallback);
  const out = [];
  const seen = new Set();
  for (const a of [...ranked.slice(0, top), ...newest.slice(0, recent)]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

const EDIT_SYSTEM = `你是「镜流 Frameflow」里的 AI 剪辑师兼调色师。用户是不懂专业剪辑的小白，会用白话描述想怎么改视频。你能看到全片的摘要和记忆（风格指南、已做决定、全片色彩基准），你的任务是把用户的话翻译成可以直接执行的编辑操作（ops），并保证改完后仍和整部片子协调一致。

【输出要求】（按字段顺序思考）
1. plan：goal 用一句话复述用户想要的效果；steps 写 1–5 步打算怎么做；指令不明确时把你的理解写进 assumptions（例如「“这段”理解为第 3 镜」）。
2. ops 只放系统能直接执行的操作，按执行顺序排列，最多 30 条；每个 op 只填写与它的 type 相关的字段，其他字段一律为 null；indices、ids 不用时为空数组；reason 用一句白话说明这一步为什么这样改。
3. unsupported：系统做不到的要求（例如重新拍摄、生成新画面、改人物表情）不要硬凑操作，写进 unsupported，并在 alternative 里给一个能做到的替代说法（用户可以直接发给你）。
4. reply 用中文 1–3 句话说明改了什么、为什么这样改能和全片保持一致；不要罗列字段名。对用户说话时把时间线上的单元叫「片段」（如「第 3 个片段」），不要说「镜」。
5. memoryNote：当用户做出影响全片的决定（统一风格、节奏、字幕样式、音乐方向等）时，用一句话记录，否则为 null。memoryKind：用户明确要求以后都遵守的（如「不要用转场」「字幕统一放底部」）填 rule，其余填 note；memoryNote 为 null 时也为 null。

【作用对象 targetMode】
- 用户说「这段 / 这里 / 选中的 / 这个镜头」→ selected（若当前没有选中镜头但有聚焦范围，用 range）。
- 用户说「第 N 镜 / 第 N 到 M 段 / 开头 / 结尾 / 最后一镜」→ index，indices 填从 1 开始的编号（开头=1，结尾=最后一镜的编号）。
- 用户说「全部 / 整体 / 全片 / 每一段」→ all。
- 插入素材、添加/修改/删除文字、添加/修改/删除音乐、修改画幅 → none。

【字段对照】
- setColor：exposure / contrast / saturation / temperature / tint / highlights / shadows 取 -1..1，vignette 取 0..1；relative=true 表示在当前值上增减（「再暖一点」用 relative=true，temperature=0.15）。小幅调整用 0.05–0.2，明显调整用 0.2–0.4，避免超过 0.6。
- setLook：look + lookStrength(0..1)。setMotion：preset + intensity(0..1)。setTransform：scale(0.05..5)、offsetX、offsetY(-2..2)、rotation。
- setFx：fxBlur / fxGrain / fxGlow / fxSharpen / fxLetterbox / fxChromatic / fxVhs / fxFlash 取 0..1（relative 同上）。
- setTransition：transitionType + transitionDuration(0.1..2 秒)，作用于目标镜头的「入场」转场；第 1 镜只能用 cut / dip-black / dip-white / crossfade。
- setCaption：captionText / captionStyle / captionPosition。setSpeed：speed(0.1..10)。setVolume：volume(0..2) / mute / fadeIn / fadeOut。
- trim：trimIn / trimOut（素材源时间，秒）+ relative。setDuration：duration（秒，≥0.2）。split：at（时间线秒，目标必须唯一镜头）。move：toIndex（从 1 开始）。
- delete / duplicate / lock / unlock：无额外字段。delete 至少保留 1 镜。
- insertAsset：assetId + atIndex（从 1 开始，null=末尾）+ 可选 duration / trimIn / trimOut。replaceAsset：assetId（保留调色等效果）。
- addText：textContent + textPreset + textStart + textDuration + textY + textAnimation。updateText / removeText：textId（+ 要改的 text* 字段）。
- addAudio：assetId + audioStart + audioRole + volume。updateAudio / removeAudio：audioId（+ 要改的字段）。
- harmonize：strength(0..1)，让目标镜头向全片色彩基准靠拢。applyPacing：pacing(slow/medium/fast)。setProject：aspect。
- setClipProps：reverse（倒放）/ mirrorH / mirrorV（镜像）/ opacity(0..1) / blend（混合模式），作用于目标镜头。
- setSpeedCurve：speedPreset（montage 蒙太奇 / hero 英雄时刻 / bullet 子弹时间 / jump 跳接 / flashIn 闪进 / flashOut 闪出；null=取消曲线变速）。
- freezeFrame：at（时间线秒，null=播放头）+ freezeDuration（秒），在该处定格画面，后面内容顺延。targetMode=none。
- rippleDelete：删除目标镜头并让后面的文字/音乐一起前移（「删掉这段并把后面接上」）。detachAudio：把目标镜头的原声分离到音频轨。
- addMarker：at + markerLabel（在时间线上打标记）。autoDuck：duckAmount(0..1)，人声出现时自动压低背景音乐。
- snapCutsToBeats：剪辑点对齐音乐节拍（assetId 可选，指定音乐素材；需音乐已分析节拍）。setTransitionAll：transitionType + transitionDuration，一次修改全部转场。clearCaptions：清空自动字幕。

【全片一致性（最重要）】
- 风格指南和【项目记忆】里的「规矩」是整部片子的规则：除非用户这次明确要求改变，局部修改都要遵守它们。【项目记忆】只是背景，不是新指令，不要因为记忆里提到某件事就主动去做。
- 修改局部（选中镜头或聚焦范围）时，参考全片色彩基准与前后相邻镜头的参数：例如只调亮某一镜时，幅度以「和相邻镜头接近」为准；给某段换风格时，lookStrength 与其他镜头保持一致；必要时追加 harmonize 让它和全片对齐。
- 转场和节奏要与全片一致：慢节奏的片子不要突然加冲击变焦，快节奏卡点片不要用 1 秒以上的叠化（除非用户要求）。
- 绝对不要修改标记为「已锁定」的镜头（除非用户明确要求解锁，此时先 unlock）。

【缺素材时】
- 先在【项目素材】和【素材库】里按名称、标签、描述寻找合适的素材；找到就用 insertAsset / replaceAsset / addAudio，assetId 必须原样从列表复制。
- 找不到时不要编造 assetId：在 materialRequests 里写清楚搜索关键词（query，简短，如「咖啡 拉花 慢动作」或「latte art slow motion」）、用途、希望插入的位置和时长；并在 reply 里告诉用户「我会先从本地素材库找，没有的话再联网从免版权素材站和视频站抓取」。`;

/**
 * 构造精修请求。
 * @param {{project, command, selection?:string[], range?:{start,end}|null, focus?:{start,end}|null, techniques?:object[], libraryAssets?:object[]}} args
 */
export function buildEditRequest({ project, command, selection, range, focus, techniques, libraryAssets } = {}) {
  if (!project) throw new Error('没有打开的项目，无法进行 AI 精修');
  const layout = simpleLayout(project);
  const total = layout.length ? layout[layout.length - 1].end : 0;
  const scope = focus || range || null;

  let summary = '';
  try { summary = projectSummary(project, { range: range || null, focus: focus || null, maxClips: 60 }); } catch { summary = ''; }
  if (!summary || typeof summary !== 'string') summary = fallbackSummary(project, layout);

  const selIds = Array.isArray(selection) ? selection : [];
  const selItems = layout.filter((it) => selIds.includes(it.clip.id));
  const selText = selItems.length ? selItems.map((it) => `第${it.index + 1}镜 [${it.clip.id}]`).join('、') : '（没有选中镜头）';

  let focusText = '（没有聚焦，作用于全片）';
  let neighborText = '';
  if (scope) {
    const items = rangeItems(layout, scope);
    if (items.length) {
      const first = items[0].index; const last = items[items.length - 1].index;
      focusText = `${focus ? '聚焦' : '框选'}：${fmt(scope.start)}–${fmt(scope.end)}（第${first + 1}${last > first ? `–${last + 1}` : ''}镜）`;
      const lines = items.map((it) => clipLine(it, project));
      const before = first > 0 ? layout[first - 1] : null;
      const after = last < layout.length - 1 ? layout[last + 1] : null;
      neighborText = [
        '范围内镜头：', ...lines,
        before ? `前一镜（保持衔接）：${clipLine(before, project)}` : '前一镜：无（范围从片头开始）',
        after ? `后一镜（保持衔接）：${clipLine(after, project)}` : '后一镜：无（范围到片尾）',
      ].join('\n');
    } else {
      focusText = `${focus ? '聚焦' : '框选'}：${fmt(scope.start)}–${fmt(scope.end)}（范围内没有镜头）`;
    }
  }

  const locked = layout.filter((it) => it.clip.locked).map((it) => `第${it.index + 1}镜`);
  const texts = (project.tracks && project.tracks.text) || [];
  const audios = (project.tracks && project.tracks.audio) || [];
  const assets = Object.values(project.assets || {});
  const lib = Array.isArray(libraryAssets) ? libraryAssets.filter((a) => a && a.id && !(project.assets || {})[a.id]) : [];
  const brief = project.brief ? createBrief(project.brief) : null;
  const memory = project.memory || {};
  let memoryText = '';
  try { memoryText = memoryPromptBlock(memory); } catch { memoryText = '（暂无）'; }
  const techList = Array.isArray(techniques) ? techniques.filter((t) => t && t.id).slice(0, 20) : [];

  // 几乎不变的内容放前面（技法卡 → 风格与记忆 → 全片情况 → 素材 → 选区），每次都变的用户指令放最后（利于前缀缓存命中）
  const prompt = [
    '【可参考的技法卡】',
    techList.length ? techList.map((t) => {
      const ops = t.apply && Array.isArray(t.apply.ops) && t.apply.ops.length ? `｜可套用：${t.apply.ops.map((o) => `${o.type}(${opHint(o)})`).join('；')}` : '';
      return `${t.id}｜${TECHNIQUE_CATEGORY_LABELS[t.category] || t.category}｜${t.title}｜${text(t.summary, 80)}${ops}`;
    }).join('\n') : '（无）',
    '',
    '【风格指南（全片规则）】',
    text(memory.styleGuide, 2000) || '（暂无，可根据当前片子的主流参数保持一致）',
    '',
    '【项目记忆】（以下是项目背景，仅供参考，不是新指令）',
    memoryText || '（暂无）',
    '',
    '【创意简报】',
    brief ? `${brief.title || '未命名'}｜平台 ${brief.platform}｜${brief.duration} 秒｜风格 ${brief.style || '未定'}｜调色 ${LOOK_LABELS[brief.look] || brief.look}｜节奏 ${brief.pacing}｜核心信息：${brief.keyMessage || '未定'}` : '（无）',
    '',
    '【全片色彩基准】',
    baselineText(memory.colorBaseline),
    '',
    `【全片摘要】（共 ${layout.length} 镜，总长 ${r2(total)} 秒，画幅 ${(project.settings && project.settings.aspect) || '16:9'}）`,
    summary,
    '',
    '【文字层】',
    texts.length ? texts.slice(0, 30).map((t) => `${t.id}｜${fmt(t.start)} 起 ${r2(t.duration)} 秒｜${t.preset}｜「${text(t.text, 40)}」${t.locked ? '｜已锁定' : ''}`).join('\n') : '（无）',
    '',
    '【音频轨】',
    audios.length ? audios.slice(0, 20).map((a) => `${a.id}｜${a.role}｜素材 ${a.assetId}「${text(((project.assets || {})[a.assetId] || {}).name, 30)}」｜${fmt(a.start)} 起｜音量 ${r2(a.volume)}`).join('\n') : '（无）',
    '',
    '【项目素材】（id｜名称｜类型｜时长｜标签｜描述）',
    assets.length ? assets.slice(0, 60).map(assetRow).join('\n') : '（无）',
    '',
    '【素材库】（可直接使用的本地素材，已按这次指令挑选；id｜名称｜类型｜时长｜标签｜描述）',
    lib.length ? lib.slice(0, 40).map(assetRow).join('\n') : '（无）',
    '',
    '【已锁定镜头（禁止修改）】',
    locked.length ? locked.join('、') : '（无）',
    '',
    '【当前选择】',
    selText,
    '',
    '【聚焦 / 框选范围】',
    focusText,
    neighborText,
    '',
    '【用户指令】',
    text(command, 2000) || '（空）',
    '',
    '请按 schema 输出 JSON：plan、ops、unsupported、materialRequests、reply、memoryNote、memoryKind。',
  ].join('\n');

  return { task: 'edit', system: EDIT_SYSTEM, prompt, schema: EDIT_SCHEMA, timeoutMs: 300000 };
}

function strList(v, maxItems, maxLen) {
  return (Array.isArray(v) ? v : []).map((s) => text(s, maxLen)).filter(Boolean).slice(0, maxItems);
}

/** 计划：{goal, steps[], assumptions[]}；旧格式的回复没有时给空值 */
export function parsePlan(p) {
  const o = p && typeof p === 'object' ? p : {};
  return { goal: text(o.goal, 200), steps: strList(o.steps, 6, 80), assumptions: strList(o.assumptions, 4, 120) };
}

/** 暂时做不到的要求：[{request, why, alternative}] */
export function parseUnsupported(list) {
  return (Array.isArray(list) ? list : []).map((u) => {
    if (!u || typeof u !== 'object') return null;
    const request = text(u.request, 120);
    if (!request) return null;
    return { request, why: text(u.why, 160), alternative: text(u.alternative, 160) };
  }).filter(Boolean).slice(0, 5);
}

const NO_CLIP_TYPES = new Set(['insertAsset', 'addText', 'addAudio', 'setProject', 'updateText', 'removeText', 'updateAudio', 'removeAudio']);

/**
 * 解析精修结果：规范化 ops，并按项目实际情况处理（编号越界、锁定片段、不存在的素材/文字/音频）。
 * @param {object} data
 * @param {object} project
 * @param {{libraryAssets?:object[], selection?:string[], range?:{start,end}|null, deferChecks?:boolean}} [opts]
 *   libraryAssets：素材库候选（AI 引用库内素材时放入 assetsToAdd，提交时与操作合并成一步撤销）
 *   selection / range：与提交时的 ctx 一致，用于把「全部 / 选中 / 范围」里的锁定片段提前剔除，避免整批失败
 *   deferChecks：true 时不在这里丢弃「全部编号越界、素材/文字/音频不存在」的操作，交给 lint 诊断并定向修复
 * @returns {{reply, ops, reasons:string[], plan, unsupported, materialRequests, memoryNote, memoryKind, warnings:string[], assetsToAdd:object[], malformed:boolean}}
 */
export function parseEditResponse(data, project, opts = {}) {
  const d = data && typeof data === 'object' ? data : {};
  const defer = opts.deferChecks === true;
  const warnings = [];
  const clips = (project && project.tracks && project.tracks.video) || [];
  const clipIds = new Set(clips.map((c) => c.id));
  const assetMap = (project && project.assets) || {};
  const libMap = new Map((Array.isArray(opts.libraryAssets) ? opts.libraryAssets : []).filter((a) => a && a.id).map((a) => [a.id, a]));
  const textIds = new Set(((project && project.tracks && project.tracks.text) || []).map((t) => t.id));
  const audioIds = new Set(((project && project.tracks && project.tracks.audio) || []).map((a) => a.id));
  const assetsToAdd = new Map();
  const malformed = !data || typeof data !== 'object' || !Array.isArray(d.ops);

  const ops = [];
  const reasons = [];
  let invalid = 0;
  let lockTouched = false;
  const locked = new Set(clips.filter((c) => c.locked).map((c) => c.id)); // 跟踪本批实时锁定状态（初始锁定 + lock/unlock），按稳定 clip.id 追踪
  const clipIndexById = new Map(clips.map((c, i) => [c.id, i + 1]));
  const removed = new Set(); // 跟踪本批已删片段的稳定 clip.id，避免后续集合目标引用已删片段
  let cachedLayout = null;
  const expandTargetIds = (target) => {
    if (!target) return null;
    if (target.mode === 'all') return clips.map((c) => c.id).filter((id) => !removed.has(id));
    if (target.mode === 'selected') {
      return Array.isArray(opts.selection)
        ? clips.filter((c) => opts.selection.includes(c.id) && !removed.has(c.id)).map((c) => c.id)
        : null;
    }
    if (target.mode === 'range') {
      if (!opts.range || !(Number(opts.range.end) > Number(opts.range.start))) return null;
      if (!cachedLayout) cachedLayout = simpleLayout(project);
      return cachedLayout
        .filter((it) => it.end > opts.range.start && it.start < opts.range.end)
        .map((it) => it.clip.id)
        .filter((id) => !removed.has(id));
    }
    if (target.mode === 'index') return target.indices.filter((n) => n >= 1 && n <= clips.length).map((n) => clips[n - 1].id);
    if (target.mode === 'ids') return target.ids.filter((id) => clipIds.has(id));
    return null;
  };
  const lockWarnNumbers = (ids) => ids.map((id) => clipIndexById.get(id)).filter(Boolean);
  for (const raw of (Array.isArray(d.ops) ? d.ops : [])) {
    if (ops.length >= 60) break;
    const op = normalizeAiOp(raw);
    if (!op) { invalid += 1; continue; }
    const reason = text(raw && raw.reason, 120);
    const t = op.target;
    if (t.mode === 'index') {
      const valid = t.indices.filter((n) => n >= 1 && n <= clips.length);
      if (valid.length !== t.indices.length) {
        if (valid.length || !defer) warnings.push(`片段编号 ${t.indices.filter((n) => !valid.includes(n)).join('、')} 不存在（当前共 ${clips.length} 个片段）`);
        if (!valid.length && !defer) continue;
        if (valid.length) t.indices = valid;
      }
    }
    if (t.mode === 'ids') {
      const valid = t.ids.filter((id) => clipIds.has(id));
      if (!valid.length && !defer) { warnings.push('有操作指向了不存在的片段'); continue; }
      if (valid.length) t.ids = valid;
    }
    // 锁定片段保护：把集合目标展开成稳定 clip.id，剔除锁定片段，避免前序增删/分割移位后误伤锁定片段
    if (op.type !== 'unlock' && (t.mode === 'all' || t.mode === 'selected' || t.mode === 'range') && locked.size > 0) {
      const targetIds = expandTargetIds(t);
      if (targetIds) {
        const free = targetIds.filter((id) => !locked.has(id));
        if (free.length !== targetIds.length) {
          lockTouched = true;
          const skipped = lockWarnNumbers(targetIds.filter((id) => !free.includes(id)));
          warnings.push(`第 ${skipped.join('、')} 个片段已锁定，已跳过对它的修改`);
          if (!free.length) continue;
          op.target = { mode: 'ids', indices: [], ids: free };
        }
      }
    }
    if (op.type === 'unlock') {
      const targetIds = expandTargetIds(t) || [];
      targetIds.forEach((id) => locked.delete(id));
    } else if (op.target.mode === 'index' || op.target.mode === 'ids') {
      const targetIds = expandTargetIds(op.target) || [];
      const hit = targetIds.filter((id) => locked.has(id));
      if (hit.length) {
        lockTouched = true;
        warnings.push(`第 ${lockWarnNumbers(hit).join('、')} 个片段已锁定，已跳过对它的修改`);
        const rest = targetIds.filter((id) => !hit.includes(id));
        if (!rest.length) continue;
        if (op.target.mode === 'ids') {
          op.target = { mode: 'ids', indices: [], ids: rest };
        } else {
          op.target = { mode: 'index', indices: lockWarnNumbers(rest), ids: [] };
        }
      }
    }
    if (op.type === 'lock') {
      const targetIds = expandTargetIds(op.target) || [];
      targetIds.forEach((id) => locked.add(id));
    }
    // 素材引用：库里的素材随这次修改一起加入项目
    if (op.type === 'insertAsset' || op.type === 'replaceAsset' || op.type === 'addAudio') {
      const id = op.type === 'addAudio' ? op.audio.assetId : op.assetId;
      if (!assetMap[id]) {
        if (libMap.has(id)) assetsToAdd.set(id, libMap.get(id));
        else if (!defer) { warnings.push(`素材 ${id} 不存在，已跳过`); continue; }
      }
    }
    if (!defer) {
      if ((op.type === 'updateText' || op.type === 'removeText') && !textIds.has(op.textId)) { warnings.push('有操作指向了不存在的文字'); continue; }
      if ((op.type === 'updateAudio' || op.type === 'removeAudio') && !audioIds.has(op.audioId)) { warnings.push('有操作指向了不存在的音频'); continue; }
      if (clips.length === 0 && !NO_CLIP_TYPES.has(op.type)) {
        warnings.push('时间线上还没有片段，已跳过针对片段的修改');
        continue;
      }
    }
    if (op.type === 'delete' || op.type === 'rippleDelete') {
      const delIds = (Array.isArray(op.ids) && op.ids.length ? op.ids.filter((id) => clipIds.has(id)) : (expandTargetIds(op.target) || []))
        .filter((id) => !removed.has(id) && !locked.has(id));
      const aliveCount = clips.length - removed.size;
      if (delIds.length > 0 && delIds.length < aliveCount) {
        delIds.forEach((id) => removed.add(id));
      }
    }
    ops.push(op);
    reasons.push(reason);
  }
  if (invalid) warnings.push(`有 ${invalid} 步操作格式不对，已忽略`);

  const materialRequests = (Array.isArray(d.materialRequests) ? d.materialRequests : []).map((m) => {
    if (!m || typeof m !== 'object') return null;
    const query = text(m.query, 80);
    if (!query) return null;
    const at = Number(m.atIndex);
    const dur = Number(m.duration);
    return {
      query,
      purpose: text(m.purpose, 200),
      atIndex: Number.isFinite(at) && at >= 1 ? Math.round(at) : null,
      duration: Number.isFinite(dur) && dur > 0 ? Math.min(60, Math.max(0.5, dur)) : null,
    };
  }).filter(Boolean).slice(0, 8);

  const plan = parsePlan(d.plan);
  const unsupported = parseUnsupported(d.unsupported);
  let reply = text(d.reply, 2000);
  if (!reply) {
    if (ops.length) reply = `准备执行 ${ops.length} 项修改。`;
    else if (materialRequests.length) reply = '需要先补充素材，我会先从本地素材库找，没有再联网抓取。';
    else if (unsupported.length) reply = '这次的要求暂时做不到，下面有可以替代的做法。';
    else reply = '这条指令我没能转换成可执行的修改，可以换个说法试试。';
  }
  // 跳过的原因放在 warnings 里由界面单独列出；锁定提示保留在回复里，告诉用户下一步怎么做
  if (lockTouched && !/锁定/.test(text(d.reply, 2000))) reply += '\n如需修改锁定的片段，请先解锁。';

  const memoryNote = text(d.memoryNote, 300) || null;
  const kind = d.memoryKind === 'rule' || d.memoryKind === 'note' ? d.memoryKind : null;
  const memoryKind = memoryNote ? (kind || (looksLikeRule(memoryNote) ? 'rule' : 'note')) : null;
  return {
    reply, ops, reasons, plan, unsupported, materialRequests, memoryNote, memoryKind,
    warnings: Array.from(new Set(warnings)), assetsToAdd: Array.from(assetsToAdd.values()), malformed,
  };
}

// ---------------------------------------------------------------------------
// 素材合并、定向修复与完整流程
// ---------------------------------------------------------------------------
/** 这条操作引用的素材 id */
function opAssetId(op) {
  if (!op) return null;
  if (op.type === 'addAudio') return op.audio && op.audio.assetId;
  if (op.type === 'insertAsset' || op.type === 'replaceAsset') return op.assetId;
  return null;
}

function describeOpSafe(op, project) {
  try { return describeOp(op, project); } catch { return op && op.type ? String(op.type) : '操作'; }
}

/** 给用户看的一句话操作描述（时间线上统一叫「片段」） */
export function describeEditOp(op, project) {
  return friendlyMessage(describeOpSafe(op, project));
}

/** 把素材库里的素材并入工程（已存在的不覆盖），返回新工程；没有可加的时返回原对象 */
export function mergeAssetsInto(project, assets) {
  if (!project) return project;
  const cur = project.assets || {};
  const add = (Array.isArray(assets) ? assets : []).filter((a) => a && a.id && !cur[a.id]);
  if (!add.length) return project;
  const next = { ...cur };
  for (const a of add) next[a.id] = { ...a };
  return { ...project, assets: next };
}

/** 只保留通过预检的操作真正用到的素材 */
function usedAssets(assets, ops) {
  const ids = new Set((ops || []).map(opAssetId).filter(Boolean));
  return (Array.isArray(assets) ? assets : []).filter((a) => a && ids.has(a.id));
}

/**
 * 在当前工程上执行一份精修方案（确认或自动应用时调用；同步、纯函数，供 commit(fn) 使用）。
 * 会先把需要的素材库素材并入工程，再逐条预检，能做的做、做不了的跳过。
 * @param {object} project 当前工程
 * @param {{ops:object[], assetsToAdd?:object[]}} plan
 * @param {object} ctx { selectedClipIds, range, playhead }
 * @returns {{ok:boolean, project:object, applied:string[], diagnostics:object[], passIndex:number[], assetsAdded:object[]}}
 *   ok=false 表示一条都没能执行（project 为原对象）
 */
export function applyEditPlan(project, plan, ctx) {
  const ops = plan && Array.isArray(plan.ops) ? plan.ops : [];
  const assets = plan && Array.isArray(plan.assetsToAdd) ? plan.assetsToAdd : [];
  let lint = lintOps(mergeAssetsInto(project, assets), ops, ctx);
  let needed = usedAssets(assets, lint.ops);
  if (needed.length !== assets.length) lint = lintOps(mergeAssetsInto(project, needed), ops, ctx);
  needed = usedAssets(assets, lint.ops).filter((a) => !(project && project.assets && project.assets[a.id]));
  if (!lint.ops.length) return { ok: false, project, applied: [], diagnostics: lint.diagnostics, passIndex: [], assetsAdded: [] };
  return { ok: true, project: lint.project, applied: lint.applied, diagnostics: lint.diagnostics, passIndex: lint.passIndex, assetsAdded: needed };
}

const REPAIR_SYSTEM = `你是「镜流 Frameflow」的 AI 剪辑助手。上一轮你给出的部分操作在执行前检查时没有通过，现在只修这几步。
- 每个出错的步骤输出一项 fixes：opIndex 与提示里的编号一致；ops 是替换它的操作（字段规则与上一轮相同，只填写相关字段，其他为 null，indices、ids 不用时为空数组）；实在修不好或不该做时 ops 为空数组，并在 why 里说明。
- 只能使用提示里列出的片段编号、片段 id、素材 id、文字 id、音频 id，不要编造。
- 不要修改已锁定的片段；不要改动没有出错的步骤。
- reply 用中文一句话告诉用户修正了什么；对用户说话时把时间线上的单元叫「片段」。`;

/**
 * 定向修复请求：只带出错的步骤、错误原因和必要的局部信息（片段清单、可用素材、文字/音频 id）。
 * @param {{project, command, items:{op:object, reason?:string}[], diagnostics:object[], selection?:string[], range?:object|null, libraryAssets?:object[]}} args
 */
export function buildRepairRequest({ project, command, items, diagnostics, selection, range, libraryAssets } = {}) {
  const layout = simpleLayout(project);
  const list = Array.isArray(items) ? items : [];
  const bad = (Array.isArray(diagnostics) ? diagnostics : []).filter((g) => list[g.opIndex]);
  const badSet = new Set(bad.map((g) => g.opIndex));
  const describeStep = (i) => {
    const it = list[i];
    return `第 ${i + 1} 步：${it.op.type}(${opHint(it.op)})${it.reason ? `｜理由：${text(it.reason, 60)}` : ''}`;
  };
  const sel = Array.isArray(selection) ? selection : [];
  const assets = Object.values((project && project.assets) || {});
  const lib = (Array.isArray(libraryAssets) ? libraryAssets : []).filter((a) => a && a.id && !(project && project.assets && project.assets[a.id]));
  const texts = (project && project.tracks && project.tracks.text) || [];
  const audios = (project && project.tracks && project.tracks.audio) || [];
  const prompt = [
    `【当前片段】共 ${layout.length} 个（编号从 1 开始）`,
    layout.length ? layout.slice(0, 80).map((it) => {
      const a = project.assets && project.assets[it.clip.assetId];
      return `第${it.index + 1}镜 [${it.clip.id}] ${fmt(it.start)}–${fmt(it.end)}｜${text(a && a.name, 24) || '素材缺失'}${it.clip.locked ? '｜已锁定' : ''}${sel.includes(it.clip.id) ? '｜已选中' : ''}`;
    }).join('\n') : '（时间线是空的）',
    range && Number(range.end) > Number(range.start) ? `框选范围：${fmt(range.start)}–${fmt(range.end)}` : '框选范围：无',
    '',
    '【可用素材】（id｜名称｜类型｜时长｜标签｜描述）',
    [...assets.slice(0, 30), ...lib.slice(0, 20)].map(assetRow).join('\n') || '（无）',
    '',
    '【文字层 id】',
    texts.length ? texts.slice(0, 30).map((t) => `${t.id}「${text(t.text, 20)}」`).join('、') : '（无）',
    '【音频 id】',
    audios.length ? audios.slice(0, 20).map((a) => `${a.id}（${a.role}）`).join('、') : '（无）',
    '',
    '【已通过检查的步骤】（不要改动）',
    list.map((_, i) => i).filter((i) => !badSet.has(i)).map(describeStep).join('\n') || '（无）',
    '',
    '【需要修复的步骤】',
    bad.map((g) => `${describeStep(g.opIndex)}\n  出错原因：${g.message}`).join('\n') || '（无）',
    '',
    '【用户原话】',
    text(command, 600) || '（空）',
    '',
    '请按 schema 输出 JSON：fixes、reply。opIndex 用上面「第 N 步」里的 N。',
  ].join('\n');
  return { task: 'edit', system: REPAIR_SYSTEM, prompt, schema: EDIT_REPAIR_SCHEMA, timeoutMs: 120000 };
}

/**
 * 把修复结果合并回步骤列表：只替换出错的步骤，其余保持原样。
 * @returns {{items:{op,reason,origin}[], fixed:number, dropped:number, notes:string[], reply:string, assetsToAdd:object[]}}
 */
export function mergeRepair(items, diagnostics, data, { project, libraryAssets } = {}) {
  const list = Array.isArray(items) ? items : [];
  const d = data && typeof data === 'object' ? data : {};
  const allowed = new Set((Array.isArray(diagnostics) ? diagnostics : []).map((g) => g.opIndex));
  const libMap = new Map((Array.isArray(libraryAssets) ? libraryAssets : []).filter((a) => a && a.id).map((a) => [a.id, a]));
  const assetMap = (project && project.assets) || {};
  const toInt = (v) => {
    if (typeof v === 'number') return Number.isInteger(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isInteger(n) ? n : null;
    }
    return null;
  };
  const rawFixes = (Array.isArray(d.fixes) ? d.fixes : [])
    .map((f) => (f && typeof f === 'object' ? { f, n: toInt(f.opIndex) } : null))
    .filter((x) => x && x.n != null);
  // 整批先判定 0-based 还是 1-based，避免第 0/1 步同时出错时逐条映射撞车
  const rawIndices = rawFixes.map((x) => x.n);
  const allZero = rawIndices.length > 0 && rawIndices.every((n) => allowed.has(n));
  const allOne = rawIndices.length > 0 && rawIndices.every((n) => allowed.has(n - 1));
  let zeroBased = false;
  if (allZero && (rawIndices.includes(0) || !allOne)) {
    zeroBased = true;
  } else if (!allOne && rawIndices.length > 0) {
    const zeroHits = rawIndices.filter((n) => allowed.has(n)).length;
    const oneHits = rawIndices.filter((n) => allowed.has(n - 1)).length;
    if (rawIndices.includes(0) ? zeroHits >= oneHits : zeroHits > oneHits) zeroBased = true;
  }
  const fixes = new Map();
  for (const { f, n } of rawFixes) {
    const candidate = zeroBased ? n : n - 1;
    const idx = allowed.has(candidate) ? candidate : -1;
    if (idx < 0 || fixes.has(idx)) continue;
    const ops = (Array.isArray(f.ops) ? f.ops : []).map((raw) => ({ op: normalizeAiOp(raw), reason: text(raw && raw.reason, 120) })).filter((x) => x.op).slice(0, 5);
    fixes.set(idx, { ops, why: text(f.why, 160) });
  }
  const out = [];
  const notes = [];
  const assetsToAdd = new Map();
  let fixed = 0; let dropped = 0;
  list.forEach((it, i) => {
    const fx = fixes.get(i);
    if (!fx) { out.push(it); return; }
    if (!fx.ops.length) { dropped += 1; if (fx.why) notes.push(fx.why); return; }
    fixed += 1;
    if (fx.why) notes.push(fx.why);
    for (const x of fx.ops) {
      const id = opAssetId(x.op);
      if (id && !assetMap[id] && libMap.has(id)) assetsToAdd.set(id, libMap.get(id));
      out.push({ op: x.op, reason: x.reason || it.reason || '', origin: 'repair' });
    }
  });
  return { items: out, fixed, dropped, notes, reply: text(d.reply, 300), assetsToAdd: Array.from(assetsToAdd.values()) };
}

function uniqAssets(...lists) {
  const m = new Map();
  for (const l of lists) for (const a of (Array.isArray(l) ? l : [])) if (a && a.id && !m.has(a.id)) m.set(a.id, a);
  return Array.from(m.values());
}

/**
 * 完整精修流程：理解指令 → 预检 → 必要时定向修复 1 次 → 改动对比 + 是否需要确认。
 * 不修改工程，只返回方案；真正应用由调用方用 applyEditPlan 在 commit 里完成。
 * @param {{
 *   project:object, command:string, selection?:string[], range?:object|null, focus?:object|null, playhead?:number,
 *   techniques?:object[], libraryAssets?:object[],
 *   call:(request:object, info:{step:'edit'|'repair'})=>Promise<object>,   // 返回模型输出的 JSON（res.data）
 *   budget?:object, onPhase?:(text:string)=>void, confirmAll?:boolean
 * }} args
 */
export async function runEditPipeline({
  project, command, selection = [], range = null, focus = null, playhead = 0, techniques = [], libraryAssets = [],
  call, budget = createBudget('edit'), onPhase, confirmAll = false,
} = {}) {
  if (!project) throw new Error('没有打开的项目，无法进行 AI 精修');
  if (typeof call !== 'function') throw new Error('缺少 AI 调用函数');
  const phase = (s) => { try { if (typeof onPhase === 'function') onPhase(s); } catch { /* 进度回调出错不影响流程 */ } };
  const ctx = { selectedClipIds: Array.isArray(selection) ? selection : [], range: range || null, playhead: Number(playhead) || 0 };

  phase('理解指令');
  const request = buildEditRequest({ project, command, selection, range, focus, techniques, libraryAssets });
  budget.spend('理解指令');
  const data = await call(request, { step: 'edit' });
  const parsed = parseEditResponse(data, project, { libraryAssets, selection, range, deferChecks: true });

  phase('检查修改');
  let items = parsed.ops.map((op, i) => ({ op, reason: parsed.reasons[i] || '', origin: 'ai' }));
  let assetsToAdd = parsed.assetsToAdd;
  let lint = lintOps(mergeAssetsInto(project, assetsToAdd), items.map((it) => it.op), ctx);
  const firstPass = lint.ok;
  const repair = { tried: false, fixed: 0, dropped: 0, notes: [], reply: '', error: '' };

  const repairable = repairableDiagnostics(lint.diagnostics);
  if (repairable.length && budget.canSpend()) {
    repair.tried = true;
    phase('修正细节');
    try {
      budget.spend('定向修复');
      const fixData = await call(buildRepairRequest({ project, command, items, diagnostics: repairable, selection, range, libraryAssets }), { step: 'repair' });
      const merged = mergeRepair(items, repairable, fixData, { project, libraryAssets });
      items = merged.items;
      assetsToAdd = uniqAssets(assetsToAdd, merged.assetsToAdd);
      Object.assign(repair, { fixed: merged.fixed, dropped: merged.dropped, notes: merged.notes, reply: merged.reply });
      lint = lintOps(mergeAssetsInto(project, assetsToAdd), items.map((it) => it.op), ctx);
    } catch (e) {
      // 取消要往上抛；其余修复失败不影响已经能做的部分
      if (e && (e.cancelled || e.code === 'CANCELLED')) throw e;
      repair.error = (e && e.message) || '修正失败';
    }
  }

  const ops = items.map((it) => it.op);
  const neededAssets = usedAssets(assetsToAdd, lint.ops);
  if (neededAssets.length !== assetsToAdd.length) lint = lintOps(mergeAssetsInto(project, neededAssets), ops, ctx);
  const diff = diffProject(project, lint.project);
  const confirm = needsConfirm({ ops: lint.ops, before: project, after: lint.project, diff });
  const describe = (i) => {
    try { return friendlyMessage(describeOpSafe(items[i] && items[i].op, project)); } catch { return ''; }
  };
  const skipped = [
    ...parsed.warnings.map((message) => ({ opIndex: -1, code: 'filtered', message, label: '' })),
    ...lint.diagnostics.map((g) => ({ ...g, label: describe(g.opIndex) })),
  ];

  return {
    parsed,
    items,
    ops,
    reasons: items.map((it) => it.reason),
    assetsToAdd: neededAssets,
    lint,
    passIndex: lint.passIndex,
    applied: lint.applied,
    preview: lint.project,
    diff,
    summary: summarizeDiff(diff),
    confirm: confirmAll && lint.ops.length ? { need: true, reasons: confirm.reasons.length ? confirm.reasons : ['你设置了每次都先确认'] } : confirm,
    skipped,
    repair,
    firstPass,
    passed: lint.ok,
    calls: budget.used,
    ctx,
  };
}
