// AI 拆片分析（CONTRACTS §D analyze.js）：看联系表 + 统计数据，标注每个镜头并沉淀技法卡。
import {
  SHOT_SIZES, SHOT_SIZE_LABELS, ANGLES, ANGLE_LABELS, SHOT_MOVEMENTS, SHOT_MOVEMENT_LABELS, TRANSITIONS, TRANSITION_LABELS,
  TECHNIQUE_CATEGORIES, TECHNIQUE_CATEGORY_LABELS, ANALYSIS_CATEGORY_LABELS,
} from '../engine/model.js';
import { uid } from '../engine/ids.js';
import { ANALYZE_SCHEMA, normalizeAiOps } from './schemas.js';

function text(v, max = 400) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function oneOf(v, list, dflt) { return typeof v === 'string' && list.includes(v) ? v : dflt; }
function strList(v, maxItems = 10, maxLen = 200) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const s of v) {
    const t = text(s, maxLen);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}
function fmt(t) {
  const s = Math.max(0, Number(t) || 0);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

function shotIndex(shot, pos) { return Number.isInteger(shot && shot.index) ? shot.index : pos; }

function statLine(st) {
  if (!st || typeof st !== 'object') return '';
  const w = Number(st.warmth) || 0;
  return `亮度${r2(st.luma)} 对比${r2(st.contrast)} 饱和${r2(st.saturation)} 冷暖${w >= 0 ? '+' : ''}${r2(w)}`;
}

function transcriptIn(transcript, start, end, max = 80) {
  if (!Array.isArray(transcript) || !transcript.length) return '';
  const parts = transcript.filter((t) => t && Number(t.end) > start && Number(t.start) < end).map((t) => text(t.text, 80));
  return parts.join(' ').slice(0, max);
}

/**
 * 片内分档（V4）：按这条视频自己的分布把数值分成 低/中/高 三档（百分位秩 <1/3 低、>2/3 高）。
 * 绝对数值对 AI 没有参照系，「在这条片子里算亮/算动」才有意义。全部相同、只有一个或无效值时为「中」。
 * @param {Array<number|null|undefined>} values
 * @returns {Array<'低'|'中'|'高'|''>} 无效值对应空串
 */
export function percentileBands(values) {
  const list = Array.isArray(values) ? values : [];
  const ok = (raw) => raw != null && raw !== '' && Number.isFinite(Number(raw));
  const valid = list.filter(ok).map(Number).sort((a, b) => a - b);
  const n = valid.length;
  return list.map((raw) => {
    if (!ok(raw)) return '';
    const v = Number(raw);
    if (n < 2) return '中';
    let less = 0; let equal = 0;
    for (const x of valid) { if (x < v) less += 1; else if (x === v) equal += 1; }
    const p = (less + equal / 2) / n;
    return p < 1 / 3 ? '低' : p > 2 / 3 ? '高' : '中';
  });
}

/** 本地算法检测到的切入方式 → 中文（作为 AI 的先验） */
export function cutInLabel(cutIn) {
  if (!cutIn || typeof cutIn !== 'object') return '';
  if (cutIn.kind === 'split') return '长镜头等分（不是切点）';
  if (cutIn.kind === 'hard') return TRANSITION_LABELS.cut;
  const label = TRANSITION_LABELS[cutIn.transition] || (cutIn.kind === 'dissolve' ? TRANSITION_LABELS.crossfade : cutIn.kind === 'fade' ? '淡入淡出' : '');
  const d = Number(cutIn.duration);
  return label && d > 0 ? `${label}约 ${r2(d)} 秒` : label;
}

/**
 * 卡点结论（F2）。显著度 = 卡点率 / 随机基线：≥2 明显踩点，≥1.4 部分踩点，其余没有刻意踩点。
 * @returns {{level:'strong'|'some'|'none', text:string}|null}
 */
export function beatSyncLabel(bs) {
  if (!bs || typeof bs !== 'object' || !(Number(bs.cuts) > 0 || Number.isFinite(Number(bs.significance)))) return null;
  const sig = Number(bs.significance) || 0;
  if (sig >= 2) return { level: 'strong', text: '明显踩点' };
  if (sig >= 1.4) return { level: 'some', text: '部分踩点' };
  return { level: 'none', text: '没有刻意踩点' };
}

function warmthWord(st) {
  const w = Number(st && st.warmth);
  if (!Number.isFinite(w)) return '';
  return w > 0.12 ? '偏暖' : w < -0.12 ? '偏冷' : '中性';
}

/** 节拍与卡点一行（没有音频数据时返回空串） */
function tempoLine(analysis) {
  const tempo = analysis.audio && analysis.audio.tempo;
  const bs = analysis.rhythm && analysis.rhythm.beatSync;
  if (!tempo || typeof tempo !== 'object') return '';
  if (!(Number(tempo.bpm) > 0)) return '音乐节拍：没有明显的节拍（可能是人声、环境声或舒缓配乐）。';
  let line = `音乐节拍：约 ${Math.round(Number(tempo.bpm))} BPM。`;
  const label = beatSyncLabel(bs);
  if (label) line += `切点落在节拍上的比例 ${Math.round((Number(bs.hitRate) || 0) * 100)}%（随便剪约 ${Math.round((Number(bs.baseline) || 0) * 100)}%），判断：${label.text}。`;
  return line;
}

const ANALYZE_SYSTEM = `你是「镜流 Frameflow」的拆片分析师，同时具备电影摄影、剪辑和短视频运营经验。你会拿到一段视频的关键帧联系表图片和统计数据，要把它「肢解」：弄清每个镜头是怎么拍、怎么剪、起什么作用，并提炼出普通人也能复用的技法。

【分析要求】
- 必须基于看到的画面和给定的数据判断，看不清就在 notes 里说明「不确定」，禁止编造没看到的内容。
- 按镜头逐个标注：shotSize 景别、angle 角度、movement 运镜（单张关键帧难以判断时结合运动档位，运动「高」可能是手持/跟随/推拉，「低」多为固定）、lighting 光线（方向、软硬、色温，如「窗光侧逆，柔和偏暖」）、composition 构图（三分法/居中/引导线/前景遮挡/框中框等）、subject 主体、transitionIn 与上一镜之间的转场（看不出就用 cut）、purpose 这个镜头在片中的作用（如「钩子」「交代环境」「展示卖点」「情绪释放」「行动号召」）、notes 值得学习的具体细节。
- 镜头列表里的亮度、运动、响度是这条视频内部的相对档位（低/中/高）；「切入」是本地算法检测到的转场，是先验，与画面明显矛盾时以画面为准。
- 每个镜头的字段（shots 内）简短具体，每项不超过 30 个字。
- summary 写 2–3 句（不超过 120 个字），说清这条视频靠什么抓人、节奏和情绪怎么推进；style 写 2–3 句，概括画面、色调、剪辑与声音的整体风格；highlights 每条不超过 40 个字。
- shots 必须覆盖下面列出的每一个镜头 index，且 index 与列表保持一致。

【整体分析】
- summary：这段视频讲了什么、靠什么吸引人。
- style：整体视听风格（色调、光线、运镜、剪辑节奏、字幕）。
- structure：按时间划分 2–6 段（如 钩子 / 痛点 / 卖点展示 / 证明 / 行动号召），start、end 单位为秒且在视频时长内。
- highlights：3–6 条最值得学习的亮点，具体到时间或镜头（如「0:03 处用甩镜把两个场景连起来」）。

【技法卡 techniques，2–6 条】
- 只总结这段视频里真实出现的手法；标题像一招一式（如「逆光拉花慢动作」「三连特写卡点」）。
- summary 两句话：是什么 + 为什么有效。steps 3–6 步，写给只有手机的小白，具体到手机怎么拿、灯放哪、几倍焦段、剪辑点在哪。
- start、end 指向视频中最能体现这个技法的片段（秒）。
- ops：若这个技法能在时间线上一键套用（调色、转场、运镜、变速、特效、节奏），给出操作，targetMode 一律用 selected，indices 与 ids 为空数组，无关字段全部为 null；常用：setLook(look,lookStrength)、setColor(exposure..vignette,relative)、setMotion(preset,intensity)、setTransition(transitionType,transitionDuration)、setFx(fx*)、setSpeed(speed)、applyPacing(pacing)、harmonize(strength)。不能套用就给空数组。applyNote 用一句话说明套用效果，否则 null。`;

/**
 * 构造拆片请求。images 为 analysis.contactSheets（最多 4 张）。
 */
export function buildAnalyzeRequest({ analysis } = {}) {
  if (!analysis) throw new Error('没有可分析的内容');
  const shots = Array.isArray(analysis.shots) ? analysis.shots : [];
  const sheets = Array.isArray(analysis.contactSheets) ? analysis.contactSheets.filter((p) => typeof p === 'string' && p).slice(0, 4) : [];
  const sheetShots = Array.isArray(analysis.contactSheetShots) ? analysis.contactSheetShots : [];
  const rhythm = analysis.rhythm || {};
  const peaks = analysis.audio && Array.isArray(analysis.audio.peaks) ? analysis.audio.peaks.slice(0, 40).map(r2) : [];

  const numbered = analysis.contactSheetsNumbered === true;
  const sheetLines = sheets.length
    ? sheets.map((_, i) => {
        const list = Array.isArray(sheetShots[i]) ? sheetShots[i] : [];
        const order = `按从左到右、从上到下的顺序，依次是镜头 index ${list.length ? list.join('、') : '（顺序见镜头列表）'}`;
        return numbered
          ? `第 ${i + 1} 张图：每格一个关键帧，左上角印着「#序号 分:秒」，#序号 = index + 1；${order}。`
          : `第 ${i + 1} 张图：每格一个关键帧，${order}。`;
      }).join('\n')
    : '本次没有关键帧图片，只能根据统计数据和台词推断：请把判断写得保守，并在 notes 注明「基于统计推断」。';

  const listed = shots.slice(0, 200);
  const lumaBands = percentileBands(listed.map((s) => (s && s.stats ? s.stats.luma : null)));
  const motionBands = percentileBands(listed.map((s) => (s ? s.motion : null)));
  const loudBands = percentileBands(listed.map((s) => (s ? s.loudness : null)));
  const hasAudio = !!(analysis.audio && Array.isArray(analysis.audio.curve) && analysis.audio.curve.length);
  const shotLines = listed.map((s, pos) => {
    const idx = shotIndex(s, pos);
    const start = Number(s.start) || 0; const end = Number(s.end) || start;
    const speech = transcriptIn(analysis.transcript, start, end);
    const parts = [`index ${idx}`, `${fmt(start)}–${fmt(end)}（${r2(s.duration ?? end - start)}秒）`];
    const look = [lumaBands[pos] && `亮度${lumaBands[pos]}`, warmthWord(s.stats)].filter(Boolean).join(' ');
    if (look) parts.push(look);
    if (motionBands[pos]) parts.push(`运动${motionBands[pos]}`);
    if (hasAudio && loudBands[pos]) parts.push(`响度${loudBands[pos]}`);
    const cut = pos > 0 ? cutInLabel(s.cutIn) : (s.cutIn && s.cutIn.kind === 'fade' ? '片头淡入' : '');
    if (cut) parts.push(`切入：${cut}`);
    if (speech) parts.push(`台词：${speech}`);
    return parts.join('｜');
  });

  const transcript = Array.isArray(analysis.transcript) && analysis.transcript.length
    ? analysis.transcript.map((t) => `[${fmt(t.start)}] ${text(t.text, 120)}`).join('\n').slice(0, 3000)
    : '（无台词或未识别）';

  const prompt = [
    '【视频信息】',
    `标题：${text(analysis.title, 120) || '未命名'}　类型：${ANALYSIS_CATEGORY_LABELS[analysis.category] || analysis.category || '其他'}`,
    `时长 ${r2(analysis.duration)} 秒，分辨率 ${analysis.width || '?'}×${analysis.height || '?'}，共 ${shots.length} 个镜头。`,
    '',
    '【节奏统计】',
    `平均镜头 ${r2(rhythm.avgShot)} 秒，中位 ${r2(rhythm.medianShot)} 秒，每分钟 ${r2(rhythm.cutsPerMinute)} 次切换。`,
    `音频响度峰值（秒）：${peaks.length ? peaks.join('、') : '无'}`,
    tempoLine(analysis),
    '',
    '【整体色彩】',
    statLine(analysis.colorProfile) || '无数据',
    analysis.colorProfile && Array.isArray(analysis.colorProfile.palette) ? `主色：${analysis.colorProfile.palette.join(' ')}` : '',
    '',
    '【联系表图片说明】',
    sheetLines,
    '',
    '【镜头列表】',
    shotLines.join('\n') || '（没有镜头数据）',
    '',
    '【台词】',
    transcript,
    '',
    '【枚举含义】',
    `shotSize：${SHOT_SIZES.map((k) => `${k}=${SHOT_SIZE_LABELS[k]}`).join('，')}`,
    `angle：${ANGLES.map((k) => `${k}=${ANGLE_LABELS[k]}`).join('，')}`,
    `movement：${SHOT_MOVEMENTS.map((k) => `${k}=${SHOT_MOVEMENT_LABELS[k]}`).join('，')}`,
    `transitionIn：${TRANSITIONS.map((k) => `${k}=${TRANSITION_LABELS[k]}`).join('，')}`,
    `category：${TECHNIQUE_CATEGORIES.map((k) => `${k}=${TECHNIQUE_CATEGORY_LABELS[k]}`).join('，')}`,
    '',
    '请严格按 JSON 结构输出分析结果。',
  ].filter((x) => x !== '').join('\n');

  return { task: 'analyze', system: ANALYZE_SYSTEM, prompt, schema: ANALYZE_SCHEMA, images: sheets, timeoutMs: 600000 };
}

function normalizeShotAi(a) {
  return {
    shotSize: oneOf(a.shotSize, SHOT_SIZES, 'medium'),
    angle: oneOf(a.angle, ANGLES, 'eye-level'),
    movement: oneOf(a.movement, SHOT_MOVEMENTS, 'static'),
    lighting: text(a.lighting, 120),
    composition: text(a.composition, 120),
    subject: text(a.subject, 120),
    transitionIn: oneOf(a.transitionIn, TRANSITIONS, 'cut'),
    purpose: text(a.purpose, 120),
    notes: text(a.notes, 240),
  };
}

/**
 * 把 AI 结果合入 analysis：填 shots[].ai 与 ai，生成技法卡（source 指向本分析）。
 * index 对不上时，若返回数量与镜头数相同则按顺序对齐，否则该镜头 ai 保持 null（不编造）。
 */
export function mergeAnalyzeResponse(analysis, data) {
  const base = analysis && typeof analysis === 'object' ? analysis : {};
  const d = data && typeof data === 'object' ? data : {};
  const shots = Array.isArray(base.shots) ? base.shots : [];
  const aiShots = (Array.isArray(d.shots) ? d.shots : []).filter((s) => s && typeof s === 'object');
  const byIndex = new Map();
  for (const a of aiShots) {
    const n = Number(a.index);
    if (Number.isInteger(n) && !byIndex.has(n)) byIndex.set(n, a);
  }
  const indicesMatch = shots.some((s, pos) => byIndex.has(shotIndex(s, pos)));
  const sameLength = aiShots.length === shots.length && shots.length > 0;
  const mergedShots = shots.map((s, pos) => {
    let a = byIndex.get(shotIndex(s, pos));
    if (!a && !indicesMatch && sameLength) a = aiShots[pos];
    return { ...s, ai: a ? normalizeShotAi(a) : (s.ai ?? null) };
  });

  const duration = Number(base.duration) > 0 ? Number(base.duration) : Infinity;
  const clampT = (v, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(0, Math.min(duration, n));
  };
  const structure = (Array.isArray(d.structure) ? d.structure : []).map((p) => {
    if (!p || typeof p !== 'object') return null;
    const start = clampT(p.start, 0);
    const end = clampT(p.end, start);
    if (!text(p.label, 40)) return null;
    return { label: text(p.label, 40), start, end: Math.max(start, end), description: text(p.description, 300) };
  }).filter(Boolean).sort((a, b) => a.start - b.start);

  const techniques = (Array.isArray(d.techniques) ? d.techniques : []).map((t) => {
    if (!t || typeof t !== 'object') return null;
    const title = text(t.title, 40);
    const summary = text(t.summary, 300);
    const steps = strList(t.steps, 8, 240);
    if (!title || (!summary && !steps.length)) return null;
    const start = clampT(t.start, 0);
    const end = t.end == null ? (Number.isFinite(duration) ? duration : start) : Math.max(start, clampT(t.end, start));
    const ops = normalizeAiOps(t.ops).map((op) => (
      op.target.mode === 'none' ? op : { ...op, target: { mode: 'selected', indices: [], ids: [] } }
    ));
    return {
      id: uid('tq'),
      category: oneOf(t.category, TECHNIQUE_CATEGORIES, 'narrative'),
      title,
      summary: summary || steps[0] || '',
      steps,
      whenToUse: text(t.whenToUse, 200),
      tags: strList(t.tags, 10, 24),
      builtin: false,
      source: { analysisId: base.id || null, title: text(base.title, 120), start, end },
      apply: ops.length ? { ops, note: text(t.applyNote, 200) } : null,
    };
  }).filter(Boolean);

  const hasOverall = text(d.summary) || text(d.style) || structure.length || strList(d.highlights).length;
  const ai = hasOverall
    ? {
        summary: text(d.summary, 800),
        style: text(d.style, 600),
        structure,
        highlights: strList(d.highlights, 8, 200),
      }
    : (base.ai ?? null);

  const prevIds = Array.isArray(base.techniqueIds) ? base.techniqueIds : [];
  return {
    analysis: { ...base, shots: mergedShots, ai, techniqueIds: [...prevIds, ...techniques.map((t) => t.id)] },
    techniques,
  };
}
