// 字幕工具：ASR segments ↔ TextClip（group='caption'）↔ SRT。纯函数。
import { uid } from './ids.js';

const MAX_LINE = 16;

function r3(v) { return Math.round(Number(v) * 1000) / 1000; }
function len(s) { return Array.from(String(s || '')).length; }

/** 底部安全区：按画幅给出 y（0..1 中心点） */
export function captionY(aspect = '16:9') {
  const a = String(aspect);
  if (a === '9:16') return 0.78; // 竖屏避开底部 UI
  if (a === '3:4' || a === '4:5') return 0.84;
  if (a === '1:1') return 0.86;
  return 0.88;
}

/** 每行 ≤ max 字自动拆行（尽量在空格处断，均分两行） */
export function wrapCaption(text, max = MAX_LINE) {
  const t = String(text || '').trim();
  if (len(t) <= max) return t;
  const chars = Array.from(t);
  const lines = Math.ceil(chars.length / max);
  const per = Math.ceil(chars.length / lines);
  const out = [];
  let i = 0;
  while (i < chars.length) {
    let j = Math.min(chars.length, i + per);
    if (j < chars.length) {
      // 向前找空格，最多回退 4 字
      for (let k = j; k > i + per - 5 && k > i; k--) if (chars[k] === ' ') { j = k; break; }
    }
    out.push(chars.slice(i, j).join('').trim());
    i = j;
    while (chars[i] === ' ') i++;
  }
  return out.filter(Boolean).join('\n');
}

export function segmentsToTexts(segments, { preset = 'subtitle', aspect = '16:9', maxChars = MAX_LINE, style = {} } = {}) {
  const y = captionY(aspect);
  return (segments || [])
    .filter((s) => s && String(s.text || '').trim() && Number(s.end) > Number(s.start))
    .map((s) => ({
      id: uid('txt'),
      start: r3(s.start),
      duration: r3(Math.max(0.2, s.end - s.start)),
      text: wrapCaption(s.text, maxChars),
      preset,
      x: 0.5,
      y,
      size: 1,
      color: '#ffffff',
      animation: 'none',
      locked: false,
      group: 'caption',
      stroke: { color: '#000000', width: 2 },
      ...style,
    }));
}

function fmt(t) {
  const ms = Math.max(0, Math.round(Number(t) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms % 1000, 3)}`;
}

export function textsToSrt(texts) {
  return (texts || [])
    .filter((t) => t && String(t.text || '').trim())
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((t, i) => `${i + 1}\n${fmt(t.start)} --> ${fmt(t.start + t.duration)}\n${String(t.text).trim()}\n`)
    .join('\n');
}

function parseTs(s) {
  const m = /(\d+):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/.exec(s);
  if (!m) return NaN;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +m[4].padEnd(3, '0') / 1000 : 0);
}

/** 解析 SRT（也兼容 WebVTT 时间格式）→ segments */
export function parseSrt(str) {
  const blocks = String(str || '').replace(/^﻿/, '').replace(/\r/g, '').split(/\n\s*\n/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, z] = lines[idx].split('-->');
    const start = parseTs(a);
    const end = parseTs(z);
    const text = lines.slice(idx + 1).join('\n').replace(/<[^>]+>/g, '');
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) out.push({ start: r3(start), end: r3(end), text });
  }
  return out;
}

/** 合并相邻两条（或多条）：按 start 排序，合并 [i, i+count) */
export function mergeSegments(segments, index, count = 2) {
  const list = (segments || []).slice();
  if (index < 0 || index >= list.length || count < 2) return list;
  const group = list.slice(index, index + count);
  if (group.length < 2) return list;
  const sep = (a, b) => (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? ' ' : '');
  const text = group.map((g) => String(g.text).replace(/\n/g, '')).reduce((a, b) => a + sep(a, b) + b, '');
  const merged = { ...group[0], start: group[0].start, end: group[group.length - 1].end, text };
  const words = group.flatMap((g) => g.words || []);
  if (words.length) merged.words = words; else delete merged.words;
  if ('duration' in group[0]) merged.duration = r3(merged.end - merged.start);
  list.splice(index, group.length, merged);
  return list;
}

/** 在时间 at（或字符位置 charIndex）处拆分一条 */
export function splitSegment(segments, index, { at, charIndex } = {}) {
  const list = (segments || []).slice();
  const s = list[index];
  if (!s) return list;
  const chars = Array.from(String(s.text).replace(/\n/g, ''));
  if (chars.length < 2) return list;
  let t = Number(at);
  let ci = Number(charIndex);
  const dur = s.end - s.start;
  if (s.words && s.words.length > 1 && Number.isFinite(t) && !Number.isFinite(ci)) {
    const wi = Math.max(1, Math.min(s.words.length - 1, s.words.findIndex((w) => w.start >= t)));
    const left = s.words.slice(0, wi);
    const right = s.words.slice(wi);
    const a = { ...s, end: left[left.length - 1].end, text: left.map((w) => w.text).join('').trim(), words: left };
    const b = { ...s, start: right[0].start, text: right.map((w) => w.text).join('').trim(), words: right };
    list.splice(index, 1, a, b);
    return list;
  }
  if (!Number.isFinite(ci)) ci = Number.isFinite(t) ? Math.round(((t - s.start) / dur) * chars.length) : Math.ceil(chars.length / 2);
  ci = Math.max(1, Math.min(chars.length - 1, ci));
  if (!Number.isFinite(t) || t <= s.start || t >= s.end) t = s.start + (dur * ci) / chars.length;
  const a = { ...s, end: r3(t), text: chars.slice(0, ci).join('').trim() };
  const b = { ...s, start: r3(t), text: chars.slice(ci).join('').trim() };
  delete a.words; delete b.words;
  list.splice(index, 1, a, b);
  return list;
}
