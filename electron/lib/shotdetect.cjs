'use strict';
// 镜头检测（规则法）：一遍解码，ffmpeg 输出 128×72 的 rgb24 原始帧，在 worker_threads 里逐帧算特征，
// 得出：硬切 / 淡入淡出 / 叠化切点、每个镜头的关键帧（避开黑场、过曝和模糊帧）、每个镜头的主色板。
//
// 算法来源与许可：
// - 自适应内容阈值（HSV 帧差 ÷ 前后窗口均值）、最短镜头、黑场阈值：按 PySceneDetect 的
//   AdaptiveDetector / ContentDetector / ThresholdDetector 思路用 JS 重写，参数取其 SWEEP_REPORT 的最优值
//   （adaptive_threshold 3.5、window_width 3、min_content_val 15、min_scene_len 0.6s）。
//   PySceneDetect —— BSD 3-Clause License, Copyright (C) 2014-2024 Brandon Castellano.
//   https://github.com/Breakthrough/PySceneDetect
// - 主色提取 MMCQ（改进中位切分）：移植自 quantize.js / color-thief，MIT License,
//   Copyright (c) 2008 Nick Rabinowitz, Copyright (c) 2015 Lokesh Dhakar. https://github.com/lokesh/color-thief
//   改动：只有一格颜色的盒子不再切分、零像素盒子丢弃、代表色取盒内真实像素均值（纯色图得到精确颜色）。
// - 关键帧打分（清晰度 / 代表性 / 稳定 / 信息量 / 曝光）参考 Katna（MIT）的思路，代码为自写。
// - 闪光过滤、叠化（线性混合模型）检测为自写。
//
// 本文件只依赖 node 内置模块：它既是普通模块，也是 worker 入口（以源码文本 eval 方式启动，打进 asar 也能用）。

const fs = require('node:fs');
const path = require('node:path');

const SCAN_W = 128;
const SCAN_H = 72;
const SIG_W = 16;
const SIG_H = 9;
const SIG_LEN = SIG_W * SIG_H;   // 16×9 灰度缩略签名
const HIST_LEN = 64;             // 亮度 32 + 色相 16 + 饱和 16
const THUMB_W = 32;
const THUMB_H = 18;
const CURVE_FPS = 2;             // 亮度/运动曲线采样率（与旧版一致，0.5 秒一格）
const MIN_SHOT = 0.5;
const MAX_SHOTS = 300;
const STATIC_SPLIT_OVER = 12;
const STATIC_CHUNK = 6;

const DETECT_DEFAULTS = {
  adaptiveThreshold: 3.5,   // 帧差 ÷ 前后窗口均值
  window: 3,                // 前后各 3 帧
  minContent: 15,           // 帧差下限（HSV 0..255 量纲）
  minSceneLen: 0.6,         // 两个切点至少相隔（秒）
  histCut: 0.3,             // 高运动画面兜底：相邻帧直方图距离
  histCutRatio: 2.0,
  flashWindow: 0.3,         // 闪光判定窗口（秒）
  fadeBlack: 12,            // 平均像素 < 12 视为黑场
  fadeWhite: 243,           // 平均像素 > 243 视为白场
  dissolveLag: 0.5,         // 叠化检测：比较 t±0.5 秒
  dissolveHist: 0.35,       // t±lag 的直方图距离下限
  dissolveResidual: 0.3,    // 线性混合模型的平均残差上限
  dissolveCorr: 0.8,        // 两端画面相关性上限（排除整体变亮变暗）
};

function r3(v) { return Math.round(Number(v) * 1000) / 1000; }
function clamp01(v) { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; }
function clamp(v, lo, hi) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; }

/** 扫描帧率：不超过 30，不低于 10（低帧率素材按 10 采样，重复帧帧差为 0，不影响切点） */
function scanRate(fps) {
  const f = Number(fps);
  return Math.round(Math.min(30, Math.max(10, f > 0 ? f : 25)) * 1000) / 1000;
}

// ───────────────────────── 逐帧特征 ─────────────────────────

/**
 * 特征收集器：喂入 rgb24 字节流（可任意切块），逐帧计算
 * content（HSV 帧差）、lum（平均像素）、sharp（拉普拉斯方差）、hist（64 格直方图）、sig（16×9 灰度签名），
 * 并按 2fps 采样亮度/帧差曲线与 32×18 色彩缩略图。
 */
function createCollector({ rate = 25, w = SCAN_W, h = SCAN_H } = {}) {
  const px = w * h;
  const frameBytes = px * 3;
  const st = {
    rate, w, h, px, frameBytes, n: 0,
    content: new Float32Array(256), lum: new Float32Array(256), sharp: new Float32Array(256),
    hist: new Uint16Array(256 * HIST_LEN), sig: new Uint8Array(256 * SIG_LEN),
    thumbs: [], curveLuma: [], curveDiff: [],
  };
  let cap = 256;
  let curH = new Uint8Array(px); let curS = new Uint8Array(px); let curV = new Uint8Array(px);
  let prevH = new Uint8Array(px); let prevS = new Uint8Array(px); let prevV = new Uint8Array(px);
  const gray = new Uint8Array(px);
  const cw = w >> 1; const ch = h >> 1;
  let prevCurve = null;
  let lastCurveK = -1;
  let pending = null;
  let pendingLen = 0;
  const bw = Math.max(1, Math.floor(w / SIG_W)); const bh = Math.max(1, Math.floor(h / SIG_H));
  const tw = Math.max(1, Math.floor(w / THUMB_W)); const th = Math.max(1, Math.floor(h / THUMB_H));

  function grow(need) {
    let c = cap;
    while (c < need) c *= 2;
    const g = (Ctor, old, per) => { const a = new Ctor(c * per); a.set(old); return a; };
    st.content = g(Float32Array, st.content, 1);
    st.lum = g(Float32Array, st.lum, 1);
    st.sharp = g(Float32Array, st.sharp, 1);
    st.hist = g(Uint16Array, st.hist, HIST_LEN);
    st.sig = g(Uint8Array, st.sig, SIG_LEN);
    cap = c;
  }

  function processFrame(buf, off) {
    const i = st.n;
    if (i + 1 > cap) grow(i + 1);
    const hist = st.hist;
    const hb = i * HIST_LEN;
    const hasPrev = i > 0;
    let sumI = 0; let sdH = 0; let sdS = 0; let sdV = 0;
    for (let p = 0, q = off; p < px; p++, q += 3) {
      const r = buf[q]; const g = buf[q + 1]; const b = buf[q + 2];
      let mx = r > g ? r : g; if (b > mx) mx = b;
      let mn = r < g ? r : g; if (b < mn) mn = b;
      const d = mx - mn;
      let hh = 0;
      let ss = 0;
      // 很暗的像素色相/饱和度只是噪声（例如淡入淡出的头几帧），按无彩色处理，避免误报切点
      if (d > 0 && mx >= 24) {
        let hd;
        if (mx === r) hd = (g - b) / d;
        else if (mx === g) hd = 2 + (b - r) / d;
        else hd = 4 + (r - g) / d;
        hd *= 30;
        if (hd < 0) hd += 180;
        hh = hd | 0;
        if (hh > 179) hh = 179;
        ss = (255 * d / mx) | 0;
      }
      if (hasPrev) {
        let dh = hh - prevH[p]; if (dh < 0) dh = -dh; if (dh > 90) dh = 180 - dh;
        const ds = ss - prevS[p];
        const dv = mx - prevV[p];
        sdH += dh; sdS += ds < 0 ? -ds : ds; sdV += dv < 0 ? -dv : dv;
      }
      curH[p] = hh; curS[p] = ss; curV[p] = mx;
      const y = (77 * r + 150 * g + 29 * b + 128) >> 8;
      gray[p] = y;
      sumI += r + g + b;
      hist[hb + (y >> 3)]++;
      if (ss >= 24) hist[hb + 32 + ((hh * 16 / 180) | 0)]++;
      hist[hb + 48 + (ss >> 4)]++;
    }
    st.content[i] = hasPrev ? (sdH + sdS + sdV) / (3 * px) : 0;
    st.lum[i] = sumI / (3 * px);
    let t = prevH; prevH = curH; curH = t;
    t = prevS; prevS = curS; curS = t;
    t = prevV; prevV = curV; curV = t;

    // 16×9 灰度签名
    const sb = i * SIG_LEN;
    for (let by = 0; by < SIG_H; by++) {
      for (let bx = 0; bx < SIG_W; bx++) {
        let s = 0;
        for (let yy = by * bh, ye = yy + bh; yy < ye; yy++) {
          const row = yy * w;
          for (let xx = bx * bw, xe = xx + bw; xx < xe; xx++) s += gray[row + xx];
        }
        st.sig[sb + by * SIG_W + bx] = (s / (bw * bh) + 0.5) | 0;
      }
    }

    // 拉普拉斯方差（清晰度）
    let ls = 0; let ls2 = 0; let cnt = 0;
    for (let yy = 1; yy < h - 1; yy++) {
      const row = yy * w;
      for (let xx = 1; xx < w - 1; xx++) {
        const p = row + xx;
        const v = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - w] - gray[p + w];
        ls += v; ls2 += v * v; cnt++;
      }
    }
    const lm = cnt ? ls / cnt : 0;
    st.sharp[i] = cnt ? Math.max(0, ls2 / cnt - lm * lm) : 0;

    // 2fps：亮度/帧差曲线（64×36 灰度，与旧版 computeCurves 同口径）+ 32×18 色彩缩略图
    const k = Math.floor((i * CURVE_FPS) / st.rate + 1e-6);
    if (k > lastCurveK) {
      lastCurveK = k;
      const cg = new Uint8Array(cw * ch);
      let sum = 0; let diff = 0;
      for (let yy = 0; yy < ch; yy++) {
        for (let xx = 0; xx < cw; xx++) {
          const p = (yy * 2) * w + xx * 2;
          const v = (gray[p] + gray[p + 1] + gray[p + w] + gray[p + w + 1] + 2) >> 2;
          const ci = yy * cw + xx;
          cg[ci] = v;
          sum += v;
          if (prevCurve) { const dd = v - prevCurve[ci]; diff += dd < 0 ? -dd : dd; }
        }
      }
      st.curveLuma.push(sum / (cw * ch) / 255);
      st.curveDiff.push(prevCurve ? diff / (cw * ch) / 255 : 0);
      prevCurve = cg;
      const thumb = new Uint8Array(THUMB_W * THUMB_H * 3);
      const area = tw * th;
      for (let ty = 0; ty < THUMB_H; ty++) {
        for (let tx = 0; tx < THUMB_W; tx++) {
          let sr = 0; let sg = 0; let sbb = 0;
          for (let yy = ty * th, ye = yy + th; yy < ye; yy++) {
            for (let xx = tx * tw, xe = xx + tw; xx < xe; xx++) {
              const q = off + (yy * w + xx) * 3;
              sr += buf[q]; sg += buf[q + 1]; sbb += buf[q + 2];
            }
          }
          const o = (ty * THUMB_W + tx) * 3;
          thumb[o] = (sr / area + 0.5) | 0; thumb[o + 1] = (sg / area + 0.5) | 0; thumb[o + 2] = (sbb / area + 0.5) | 0;
        }
      }
      st.thumbs.push({ frame: i, data: thumb });
    }
    st.n = i + 1;
  }

  function feed(chunk) {
    const len = chunk.length;
    let off = 0;
    if (pendingLen) {
      const need = frameBytes - pendingLen;
      if (len < need) { pending.set(chunk.subarray(0, len), pendingLen); pendingLen += len; return; }
      pending.set(chunk.subarray(0, need), pendingLen);
      processFrame(pending, 0);
      pendingLen = 0;
      off = need;
    }
    while (off + frameBytes <= len) { processFrame(chunk, off); off += frameBytes; }
    if (off < len) {
      if (!pending) pending = new Uint8Array(frameBytes);
      pending.set(chunk.subarray(off), 0);
      pendingLen = len - off;
    }
  }

  return { st, feed, processFrame };
}

// ───────────────────────── 帧间距离 ─────────────────────────

/** 直方图距离（0..1）：亮度 50%、色相 25%（只统计有颜色的像素）、饱和 25% */
function histDist(f, a, b) {
  const H = f.hist; const A = a * HIST_LEN; const B = b * HIST_LEN; const px = f.px;
  let iy = 0;
  for (let k = 0; k < 32; k++) iy += Math.min(H[A + k], H[B + k]);
  iy /= px;
  let ha = 0; let hb = 0;
  for (let k = 32; k < 48; k++) { ha += H[A + k]; hb += H[B + k]; }
  let ih = 1;
  if (ha > px * 0.05 && hb > px * 0.05) {
    ih = 0;
    for (let k = 32; k < 48; k++) ih += Math.min(H[A + k] / ha, H[B + k] / hb);
  }
  let is = 0;
  for (let k = 48; k < 64; k++) is += Math.min(H[A + k], H[B + k]);
  is /= px;
  return 0.5 * (1 - iy) + 0.25 * (1 - ih) + 0.25 * (1 - is);
}

/** 灰度签名平均绝对差（0..255） */
function sigDist(f, a, b) {
  const S = f.sig; const A = a * SIG_LEN; const B = b * SIG_LEN;
  let s = 0;
  for (let k = 0; k < SIG_LEN; k++) { const d = S[A + k] - S[B + k]; s += d < 0 ? -d : d; }
  return s / SIG_LEN;
}

function sigCorr(f, a, b) {
  const S = f.sig; const A = a * SIG_LEN; const B = b * SIG_LEN;
  let ma = 0; let mb = 0;
  for (let k = 0; k < SIG_LEN; k++) { ma += S[A + k]; mb += S[B + k]; }
  ma /= SIG_LEN; mb /= SIG_LEN;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let k = 0; k < SIG_LEN; k++) {
    const x = S[A + k] - ma; const y = S[B + k] - mb;
    sab += x * y; saa += x * x; sbb += y * y;
  }
  if (saa < 1e-6 || sbb < 1e-6) return 0;
  return sab / Math.sqrt(saa * sbb);
}

/** 线性混合模型：a..b 之间每帧能否写成 A +α(B−A)，α 单调上升、残差小 → 叠化 */
function blendTest(f, a, b, opts) {
  const S = f.sig; const A = a * SIG_LEN; const B = b * SIG_LEN;
  let den = 0;
  for (let k = 0; k < SIG_LEN; k++) { const d = S[B + k] - S[A + k]; den += d * d; }
  const rms = Math.sqrt(den / SIG_LEN);
  if (rms < 12) return null;
  if (sigCorr(f, a, b) > opts.dissolveCorr) return null;
  const alphas = [];
  let resSum = 0;
  for (let t = a; t <= b; t++) {
    const T = t * SIG_LEN;
    let num = 0;
    for (let k = 0; k < SIG_LEN; k++) num += (S[T + k] - S[A + k]) * (S[B + k] - S[A + k]);
    const al = num / den;
    let res = 0;
    for (let k = 0; k < SIG_LEN; k++) { const e = S[T + k] - (S[A + k] + al * (S[B + k] - S[A + k])); res += e * e; }
    resSum += Math.sqrt(res / SIG_LEN) / rms;
    alphas.push(al);
  }
  for (let j = 1; j < alphas.length; j++) if (alphas[j] < alphas[j - 1] - 0.1) return null;
  const meanRes = resSum / alphas.length;
  if (meanRes > opts.dissolveResidual) return null;
  let mid = 0;
  for (const al of alphas) if (al > 0.15 && al < 0.85) mid++;
  if (mid < 2) return null; // 中间没有过渡帧 → 其实是硬切
  return { alphas, meanRes };
}

// ───────────────────────── 切点检测 ─────────────────────────

/**
 * 切点检测（纯函数）。
 * @returns {{ cuts:{t:number,frame:number,kind:'hard'|'fade'|'dissolve',transition:string,score:number,duration?:number}[],
 *            spans:[number,number][], leadIn:null|{kind:string,transition:string,duration:number} }}
 *   spans：渐变 / 黑场 / 闪光所占的帧区间（关键帧要避开）。
 */
function detectCuts(f, options = {}) {
  const o = { ...DETECT_DEFAULTS, ...options };
  const n = f.n; const R = f.rate; const C = f.content; const Y = f.lum;
  const spans = [];
  let leadIn = null;
  if (n < 2) return { cuts: [], spans, leadIn };

  // 1) 自适应硬切 + 高运动兜底
  let hard = [];
  for (let t = 1; t < n; t++) {
    const c = C[t];
    if (c < o.minContent) continue;
    let s = 0; let m = 0;
    for (let k = t - o.window; k <= t + o.window; k++) {
      if (k === t || k < 1 || k >= n) continue;
      s += C[k]; m++;
    }
    const avg = m ? s / m : 0;
    const ratio = avg > 1e-5 ? c / avg : 255;
    let hd = -1;
    let ok = ratio >= o.adaptiveThreshold;
    if (!ok && ratio >= o.histCutRatio) { hd = histDist(f, t - 1, t); ok = hd >= o.histCut; }
    if (ok) hard.push({ frame: t, kind: 'hard', transition: 'cut', ratio, score: 0.5 + 0.5 * clamp01((ratio - o.adaptiveThreshold) / (3 * o.adaptiveThreshold)) });
  }

  // 2) 闪光过滤：跳变后 0.3 秒内画面回到跳变前 → 闪光，不是切点
  const nMax = Math.max(2, Math.round(o.flashWindow * R));
  const dropped = new Set();
  for (const c of hard) {
    if (dropped.has(c.frame)) continue;
    const t = c.frame;
    const jump = sigDist(f, t - 1, t);
    for (let N = 1; N <= nMax && t + N < n; N++) {
      const d = sigDist(f, t - 1, t + N);
      if (d < 0.4 * jump && d < 18) {
        dropped.add(t);
        for (const x of hard) if (x.frame > t && x.frame <= t + N) dropped.add(x.frame);
        spans.push([t, t + N - 1]);
        break;
      }
    }
  }
  hard = hard.filter((c) => !dropped.has(c.frame));

  // 3) 黑场 / 白场：淡入淡出
  const fades = [];
  const runs = (test) => {
    const out = [];
    let i = 0;
    while (i < n) {
      if (!test(Y[i])) { i++; continue; }
      let j = i;
      while (j + 1 < n && test(Y[j + 1])) j++;
      out.push([i, j]);
      i = j + 1;
    }
    return out;
  };
  const maxRamp = Math.round(3 * R);
  for (const white of [false, true]) {
    const test = white ? (v) => v > o.fadeWhite : (v) => v < o.fadeBlack;
    const toward = white ? (outer, inner) => outer < inner - 0.2 : (outer, inner) => outer > inner + 0.2;
    for (const [i, j] of runs(test)) {
      // 向两侧走完渐变段：亮度单调变化、且相邻帧画面结构没有突变（突变说明是硬切）
      let a = i;
      while (a - 1 >= 0 && i - a < maxRamp && toward(Y[a - 1], Y[a]) && sigDist(f, a - 1, a) < 25) a--;
      let b = j;
      while (b + 1 < n && b - j < maxRamp && toward(Y[b + 1], Y[b]) && sigDist(f, b, b + 1) < 25) b++;
      const transition = white ? 'dip-white' : 'dip-black';
      if (i === 0) {
        hard = hard.filter((c) => c.frame > b + 1);
        spans.push([0, b]);
        if (b - j >= 3 && j < n - 1) leadIn = { kind: 'fade', transition, duration: r3((b + 1) / R) };
        continue;
      }
      if (j === n - 1) { hard = hard.filter((c) => c.frame < a); spans.push([a, n - 1]); continue; }
      const len = j - i + 1;
      if (len < 2) continue; // 单帧黑场交给硬切检测
      const pre = Math.max(0, a - 1); const post = Math.min(n - 1, b + 1);
      if (len / R < 0.25 && sigDist(f, pre, post) < 18) {
        // 短促黑/白闪，前后是同一画面 → 闪光
        hard = hard.filter((c) => c.frame < a || c.frame > b + 1);
        spans.push([a, b]);
        continue;
      }
      // 有渐变或停留 ≥2 帧的黑/白场都算「淡入淡出 / 黑场过渡」，切点放在黑场正中
      hard = hard.filter((c) => c.frame < a || c.frame > b + 1);
      spans.push([a, b]);
      fades.push({
        frame: Math.round((i + j + 1) / 2),
        kind: 'fade',
        transition,
        score: 0.9,
        duration: r3((b - a + 1) / R),
      });
    }
  }

  // 4) 叠化：t±lag 直方图差异大、窗口内无硬切，且中间帧符合线性混合
  const dissolves = [];
  const lag = Math.max(2, Math.round(o.dissolveLag * R));
  if (n > 2 * lag + 2) {
    const blocked = new Uint8Array(n);
    const block = (x0, x1) => { for (let x = Math.max(0, x0); x <= Math.min(n - 1, x1); x++) blocked[x] = 1; };
    for (const c of hard) block(c.frame - lag, c.frame + lag);
    for (const c of fades) block(c.frame - lag, c.frame + lag);
    for (const [a, b] of spans) block(a - lag, b + lag);
    const d = new Float32Array(n);
    for (let t = lag; t < n - lag; t++) d[t] = histDist(f, t - lag, t + lag);
    for (let t = lag; t < n - lag; t++) {
      if (blocked[t] || d[t] < o.dissolveHist) continue;
      let isMax = true;
      for (let m = 1; m <= lag && isMax; m++) {
        if ((t - m >= 0 && d[t - m] > d[t]) || (t + m < n && d[t + m] >= d[t])) isMax = false;
      }
      if (!isMax) continue;
      const a = t - lag; const b = t + lag;
      const bt = blendTest(f, a, b, o);
      if (!bt) continue;
      const al = bt.alphas;
      let s0 = 0; while (s0 < al.length - 1 && al[s0] < 0.1) s0++;
      let s1 = al.length - 1; while (s1 > 0 && al[s1] > 0.9) s1--;
      let cross = 0; while (cross < al.length - 1 && al[cross] < 0.5) cross++;
      const endBlack = Y[a] < 20 || Y[b] < 20; const endWhite = Y[a] > 235 || Y[b] > 235;
      const kind = endBlack || endWhite ? 'fade' : 'dissolve';
      dissolves.push({
        frame: a + cross,
        kind,
        transition: kind === 'dissolve' ? 'crossfade' : (endWhite ? 'dip-white' : 'dip-black'),
        score: 0.6 + 0.3 * clamp01(1 - bt.meanRes / o.dissolveResidual),
        duration: r3(Math.max(1, s1 - s0 + 1) / R),
      });
      spans.push([a + Math.min(s0, s1), a + Math.max(s0, s1)]);
      t += lag;
    }
  }

  // 5) 合并：间隔小于最短镜头的切点只留一个（硬切优先，其次置信度高的）
  const all = [...hard, ...fades, ...dissolves].sort((x, y) => x.frame - y.frame);
  const minGap = Math.max(1, Math.round(o.minSceneLen * R));
  const prio = (c) => c.score + (c.kind === 'hard' ? 0.3 : 0);
  const kept = [];
  for (const c of all) {
    const last = kept[kept.length - 1];
    if (last && c.frame - last.frame < minGap) {
      if (prio(c) > prio(last)) kept[kept.length - 1] = c;
      continue;
    }
    kept.push(c);
  }
  const cuts = kept.map((c) => {
    const out = { t: r3(c.frame / R), frame: c.frame, kind: c.kind, transition: c.transition, score: r3(c.score) };
    if (c.duration) out.duration = c.duration;
    return out;
  });
  return { cuts, spans, leadIn };
}

// ───────────────────────── 镜头边界 ─────────────────────────

/**
 * 由切点生成镜头边界（纯函数）。
 * - 合并短于 minShot 的镜头；超过 maxShots 时反复合并最短镜头；
 * - 没有切点：长于 splitOver 秒按 chunk 秒等分（便于学习），否则整段一镜。
 * @returns {{start:number,end:number}[]}
 */
function buildShotBounds(cutTimes, duration, { minShot = MIN_SHOT, maxShots = MAX_SHOTS, splitOver = STATIC_SPLIT_OVER, chunk = STATIC_CHUNK } = {}) {
  const D = Number(duration);
  if (!(D > 0)) return [];
  const cuts = [...new Set((cutTimes || [])
    .map(Number)
    .filter((t) => Number.isFinite(t) && t > 0.05 && t < D - 0.05)
    .map(r3))].sort((a, b) => a - b);
  let bounds;
  if (!cuts.length) {
    if (D > splitOver) {
      const n = Math.max(2, Math.round(D / chunk));
      bounds = Array.from({ length: n + 1 }, (_, i) => r3((D * i) / n));
    } else {
      bounds = [0, r3(D)];
    }
  } else {
    bounds = [0];
    for (const c of cuts) if (c - bounds[bounds.length - 1] >= minShot) bounds.push(c);
    if (D - bounds[bounds.length - 1] >= minShot || bounds.length === 1) bounds.push(r3(D));
    else bounds[bounds.length - 1] = r3(D); // 尾部过短 → 并入前一镜
  }
  // 镜头数上限：反复把最短的镜头并入较短的相邻镜头
  while (bounds.length - 1 > maxShots) {
    let k = 0;
    let best = Infinity;
    for (let i = 0; i < bounds.length - 1; i++) {
      const d = bounds[i + 1] - bounds[i];
      if (d < best) { best = d; k = i; }
    }
    const segs = bounds.length - 1;
    let removeAt;
    if (k === 0) removeAt = 1;
    else if (k === segs - 1) removeAt = segs - 1;
    else {
      const left = bounds[k] - bounds[k - 1];
      const right = bounds[k + 2] - bounds[k + 1];
      removeAt = left <= right ? k : k + 1;
    }
    bounds.splice(removeAt, 1);
  }
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++) out.push({ start: bounds[i], end: bounds[i + 1] });
  return out;
}

// ───────────────────────── 关键帧 ─────────────────────────

function percentile(arr, q) {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

function entropyY(f, i) {
  const H = f.hist; const b = i * HIST_LEN; const px = f.px;
  let e = 0;
  for (let k = 0; k < 32; k++) { const p = H[b + k] / px; if (p > 0) e -= p * Math.log(p); }
  return e / Math.log(32);
}

/**
 * 每个镜头挑关键帧（纯函数）。打分 = 0.35 清晰 + 0.25 代表性 + 0.15 稳定 + 0.15 信息量 + 0.10 曝光；
 * 黑场 / 过曝 / 模糊（拉普拉斯方差低于全片中位数的 15%，且不低于 8）的帧不入选，除非整镜都是这样。
 * 长于 4 秒的镜头最多 3 张（MMR 选差异大的），第一张是得分最高的。
 * @returns {{frames:number[], score:number}[]}
 */
function pickKeyframes(f, shots, spans = [], opts = {}) {
  const n = f.n; const R = f.rate;
  const out = [];
  if (!n) return shots.map(() => ({ frames: [], score: 0 }));
  const sharpAll = f.sharp.subarray(0, n);
  const lapMed = percentile(sharpAll, 0.5);
  const lapRef = Math.max(1, percentile(sharpAll, 0.9));
  const blurThr = Math.max(8, 0.15 * lapMed);
  const logRef = Math.log1p(lapRef);
  const excl = new Uint8Array(n);
  for (const [a, b] of spans) for (let x = Math.max(0, a); x <= Math.min(n - 1, b); x++) excl[x] = 1;
  const multiOver = opts.multiOver == null ? 4 : opts.multiOver;
  const meanSig = new Float32Array(SIG_LEN);

  for (const sh of shots) {
    const f0 = Math.min(n - 1, Math.max(0, Math.ceil(sh.start * R - 1e-6)));
    const f1 = Math.min(n - 1, Math.max(f0, Math.ceil(sh.end * R - 1e-6) - 1));
    const dur = sh.end - sh.start;
    const margin = dur >= 1 ? 0.15 * dur : 0.1;
    let c0 = Math.max(f0, Math.ceil((sh.start + margin) * R));
    let c1 = Math.min(f1, Math.floor((sh.end - margin) * R) - 1);
    if (c1 < c0) { c0 = f0; c1 = f1; }
    const step = Math.max(1, Math.ceil((c1 - c0 + 1) / 300));
    const idx = [];
    for (let i = c0; i <= c1; i += step) idx.push(i);
    meanSig.fill(0);
    for (const i of idx) { const b = i * SIG_LEN; for (let k = 0; k < SIG_LEN; k++) meanSig[k] += f.sig[b + k]; }
    for (let k = 0; k < SIG_LEN; k++) meanSig[k] /= idx.length;
    const cand = idx.map((i) => {
      const b = i * SIG_LEN;
      let dm = 0;
      for (let k = 0; k < SIG_LEN; k++) dm += Math.abs(f.sig[b + k] - meanSig[k]);
      dm /= SIG_LEN;
      const y = f.lum[i] / 255;
      const lap = f.sharp[i];
      const sharpN = clamp01(Math.log1p(lap) / logRef);
      const repr = 1 - Math.min(1, dm / 40);
      const motion = ((f.content[i] || 0) + (i + 1 < n ? f.content[i + 1] : 0)) / 2;
      const still = 1 - Math.min(1, motion / 30);
      const ent = entropyY(f, i);
      const expo = y >= 0.1 && y <= 0.9 ? 1 : Math.max(0, 1 - Math.min(Math.abs(y - 0.1), Math.abs(y - 0.9)) / 0.1);
      const score = 0.35 * sharpN + 0.25 * repr + 0.15 * still + 0.15 * ent + 0.10 * expo;
      const bad = excl[i] || y < 0.06 || y > 0.94 || lap < blurThr;
      return { i, score, bad, excl: !!excl[i] };
    });
    let pool = cand.filter((c) => !c.bad);
    if (!pool.length) pool = cand.filter((c) => !c.excl);
    if (!pool.length) pool = cand;
    if (!pool.length) { out.push({ frames: [Math.round((f0 + f1) / 2)], score: 0 }); continue; }
    let best = pool[0];
    for (const c of pool) if (c.score > best.score) best = c;
    const picks = [best];
    if (dur > multiOver && pool.length > 2) {
      const sep = Math.max(1, Math.round(0.2 * dur * R));
      for (let round = 0; round < 2; round++) {
        let pick = null; let pv = -Infinity;
        for (const c of pool) {
          if (picks.some((p) => Math.abs(p.i - c.i) < sep)) continue;
          let md = Infinity;
          for (const p of picks) md = Math.min(md, sigDist(f, p.i, c.i));
          if (md < 4) continue; // 和已选的几乎一样 → 不要重复
          const v = 0.6 * c.score + 0.4 * Math.min(1, md / 40);
          if (v > pv) { pv = v; pick = c; }
        }
        if (!pick) break;
        picks.push(pick);
      }
    }
    const rest = picks.slice(1).sort((a, b) => a.i - b.i);
    out.push({ frames: [best.i, ...rest.map((p) => p.i)], score: r3(best.score) });
  }
  return out;
}

// ───────────────────────── 主色（MMCQ） ─────────────────────────

const SIGBITS = 5;
const RSHIFT = 8 - SIGBITS;
const HIST_SIZE = 1 << (3 * SIGBITS);
const MAX_ITER = 1000;
const FRACT_BY_POP = 0.75;
function cidx(r, g, b) { return (r << (2 * SIGBITS)) + (g << SIGBITS) + b; }

function vboxCount(v, histo) {
  if (v.count != null) return v.count;
  let c = 0;
  for (let r = v.r1; r <= v.r2; r++) for (let g = v.g1; g <= v.g2; g++) for (let b = v.b1; b <= v.b2; b++) c += histo[cidx(r, g, b)];
  v.count = c;
  return c;
}
function vboxVolume(v) { return (v.r2 - v.r1 + 1) * (v.g2 - v.g1 + 1) * (v.b2 - v.b1 + 1); }

function medianCut(histo, v) {
  const total = vboxCount(v, histo);
  if (!total) return null;
  const rw = v.r2 - v.r1 + 1; const gw = v.g2 - v.g1 + 1; const bw = v.b2 - v.b1 + 1;
  const maxw = Math.max(rw, gw, bw);
  if (maxw === 1) return null; // 只有一格颜色，不能再切
  const axis = maxw === rw ? 'r' : maxw === gw ? 'g' : 'b';
  const lo = v[axis + '1']; const hi = v[axis + '2'];
  const partial = new Array(hi + 1).fill(0);
  let acc = 0;
  for (let i = lo; i <= hi; i++) {
    let s = 0;
    if (axis === 'r') { for (let g = v.g1; g <= v.g2; g++) for (let b = v.b1; b <= v.b2; b++) s += histo[cidx(i, g, b)]; }
    else if (axis === 'g') { for (let r = v.r1; r <= v.r2; r++) for (let b = v.b1; b <= v.b2; b++) s += histo[cidx(r, i, b)]; }
    else { for (let r = v.r1; r <= v.r2; r++) for (let g = v.g1; g <= v.g2; g++) s += histo[cidx(r, g, i)]; }
    acc += s;
    partial[i] = acc;
  }
  // 找中位切面（与 quantize.js 一致：偏向较长一侧切，避免切出空盒）
  let cut = lo;
  for (let i = lo; i <= hi; i++) { if (partial[i] > total / 2) { cut = i; break; } }
  const left = cut - lo; const right = hi - cut;
  let d2 = left <= right ? Math.min(hi - 1, Math.floor(cut + right / 2)) : Math.max(lo, Math.floor(cut - 1 - left / 2));
  d2 = Math.max(lo, Math.min(hi - 1, d2));
  while (d2 < hi - 1 && !partial[d2]) d2++;     // 左盒不能空
  while (d2 > lo && partial[d2] >= total) d2--; // 右盒不能空（全部像素都在同一切面时，只能先收缩盒子）
  const v1 = { ...v, count: null }; const v2 = { ...v, count: null };
  v1[axis + '2'] = d2;
  v2[axis + '1'] = d2 + 1;
  return [v1, v2];
}

/**
 * MMCQ 主色量化。pixels 为 rgb24 字节；返回按像素数从多到少的 [{ rgb:[r,g,b], count }]。
 */
function quantize(pixels, maxColors = 8) {
  const n = Math.floor(pixels.length / 3);
  if (!n) return [];
  const histo = new Uint32Array(HIST_SIZE);
  let r1 = 31; let r2 = 0; let g1 = 31; let g2 = 0; let b1 = 31; let b2 = 0;
  for (let i = 0; i < n; i++) {
    const r = pixels[i * 3] >> RSHIFT; const g = pixels[i * 3 + 1] >> RSHIFT; const b = pixels[i * 3 + 2] >> RSHIFT;
    histo[cidx(r, g, b)]++;
    if (r < r1) r1 = r; if (r > r2) r2 = r;
    if (g < g1) g1 = g; if (g > g2) g2 = g;
    if (b < b1) b1 = b; if (b > b2) b2 = b;
  }
  const boxes = [{ r1, r2, g1, g2, b1, b2, count: null }];
  const iterate = (target, key) => {
    let iter = 0;
    const done = new Set();
    while (boxes.length < target && iter++ < MAX_ITER) {
      let k = -1; let kv = -1;
      for (let i = 0; i < boxes.length; i++) {
        if (done.has(boxes[i])) continue;
        const val = key(boxes[i]);
        if (val > kv) { kv = val; k = i; }
      }
      if (k < 0 || kv <= 0) break;
      const res = medianCut(histo, boxes[k]);
      if (!res) { done.add(boxes[k]); continue; }
      const [v1, v2] = res;
      boxes.splice(k, 1);
      if (vboxCount(v1, histo)) boxes.push(v1);
      if (vboxCount(v2, histo)) boxes.push(v2);
    }
  };
  iterate(Math.max(1, Math.floor(FRACT_BY_POP * maxColors)), (v) => vboxCount(v, histo));
  iterate(maxColors, (v) => vboxCount(v, histo) * vboxVolume(v));
  // 代表色 = 盒内真实像素均值
  const owner = new Int16Array(HIST_SIZE).fill(-1);
  boxes.forEach((v, id) => {
    for (let r = v.r1; r <= v.r2; r++) for (let g = v.g1; g <= v.g2; g++) for (let b = v.b1; b <= v.b2; b++) owner[cidx(r, g, b)] = id;
  });
  const acc = boxes.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < n; i++) {
    const r = pixels[i * 3]; const g = pixels[i * 3 + 1]; const b = pixels[i * 3 + 2];
    const id = owner[cidx(r >> RSHIFT, g >> RSHIFT, b >> RSHIFT)];
    if (id < 0) continue;
    const a = acc[id];
    a[0] += r; a[1] += g; a[2] += b; a[3] += 1;
  }
  return acc.filter((a) => a[3] > 0)
    .map((a) => ({ rgb: [a[0] / a[3], a[1] / a[3], a[2] / a[3]], count: a[3] }))
    .sort((x, y) => y.count - x.count);
}

function toHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
}
function rgbDist(a, b) { return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2); }

/** rgb24 像素 → ColorStats（SPEC §3.6）：亮度、对比、饱和、冷暖、色偏、5 个主色（MMCQ，彼此相差明显） */
function statsFromRgb(buf) {
  const n = Math.floor(buf.length / 3);
  if (!n) return null;
  let sl = 0; let sl2 = 0; let ss = 0; let sr = 0; let sg = 0; let sb = 0;
  for (let i = 0; i < n; i++) {
    const r = buf[i * 3]; const g = buf[i * 3 + 1]; const b = buf[i * 3 + 2];
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sl += l; sl2 += l * l;
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
    ss += mx ? (mx - mn) / mx : 0;
    sr += r; sg += g; sb += b;
  }
  const luma = sl / n;
  const sd = Math.sqrt(Math.max(0, sl2 / n - luma * luma));
  const mr = sr / n; const mg = sg / n; const mb = sb / n;
  const ranked = quantize(buf, 8);
  const palette = [];
  const paletteEx = [];
  for (const c of ranked) {
    if (palette.every((p) => rgbDist(p, c.rgb) > 36)) {
      palette.push(c.rgb);
      paletteEx.push({ hex: toHex(c.rgb[0], c.rgb[1], c.rgb[2]), ratio: r3(c.count / n) });
    }
    if (palette.length >= 5) break;
  }
  while (palette.length < 5) palette.push(palette.length ? palette[palette.length - 1] : [mr, mg, mb]);
  return {
    luma: r3(clamp01(luma)),
    contrast: r3(clamp01(sd * 2)),
    saturation: r3(clamp01(ss / n)),
    warmth: r3(clamp((mr - mb) / 255, -1, 1)),
    tint: r3(clamp((mg - (mr + mb) / 2) / 255, -1, 1)),
    palette: palette.map((c) => toHex(c[0], c[1], c[2])),
    paletteEx,
  };
}

/** 每个镜头的色彩统计：取镜头中间 70%（避开渐变）的 2fps 缩略图，最多 12 张拼在一起算 */
function shotColorStats(f, shots, spans = []) {
  const R = f.rate;
  const thumbs = f.thumbs || [];
  const inSpan = (fr) => spans.some(([a, b]) => fr >= a && fr <= b);
  return shots.map((sh) => {
    if (!thumbs.length) return null;
    const dur = sh.end - sh.start;
    const lo = sh.start + 0.15 * dur; const hi = sh.end - 0.15 * dur;
    let sel = thumbs.filter((t) => { const tt = t.frame / R; return tt >= lo && tt <= hi && !inSpan(t.frame); });
    if (!sel.length) sel = thumbs.filter((t) => { const tt = t.frame / R; return tt >= sh.start && tt < sh.end; });
    if (!sel.length) {
      const mid = (sh.start + sh.end) / 2;
      let best = thumbs[0];
      for (const t of thumbs) if (Math.abs(t.frame / R - mid) < Math.abs(best.frame / R - mid)) best = t;
      sel = [best];
    }
    if (sel.length > 12) {
      const pick = [];
      for (let i = 0; i < 12; i++) pick.push(sel[Math.round((i * (sel.length - 1)) / 11)]);
      sel = pick;
    }
    const per = sel[0].data.length;
    const buf = new Uint8Array(per * sel.length);
    sel.forEach((t, i) => buf.set(t.data, i * per));
    return statsFromRgb(buf);
  });
}

// ───────────────────────── 汇总：特征 → 镜头 ─────────────────────────

/**
 * 扫描结束后的全部计算（worker 与主线程共用）。
 * @returns {{ n, rate, duration, cuts, shots:{start,end,cutIn,keyframes:{frame,t}[],keyframeScore,stats}[], curves:{luma,diff} }}
 */
function finishScan(f, { durationHint = 0, detect = {}, bounds: boundOpts = {} } = {}) {
  const duration = durationHint > 0 ? durationHint : f.n / f.rate;
  const det = detectCuts(f, detect);
  const bounds = buildShotBounds(det.cuts.map((c) => c.t), duration, boundOpts);
  const staticSplit = !det.cuts.length && bounds.length > 1;
  const shots = bounds.map((b, i) => {
    let cutIn = null;
    if (i === 0) cutIn = det.leadIn ? { ...det.leadIn } : null;
    else if (staticSplit) cutIn = { kind: 'split', transition: null };
    else {
      const c = det.cuts.find((x) => Math.abs(x.t - b.start) < 0.002);
      if (c) {
        cutIn = { kind: c.kind, transition: c.transition, score: c.score };
        if (c.duration) cutIn.duration = c.duration;
      }
    }
    return { start: b.start, end: b.end, cutIn };
  });
  const kf = pickKeyframes(f, shots, det.spans);
  const stats = shotColorStats(f, shots, det.spans);
  return {
    n: f.n,
    rate: f.rate,
    duration: r3(duration),
    cuts: det.cuts,
    shots: shots.map((s, i) => ({
      ...s,
      keyframes: kf[i].frames.map((fr) => ({ frame: fr, t: r3(fr / f.rate) })),
      keyframeScore: kf[i].score,
      stats: stats[i],
    })),
    curves: { luma: f.curveLuma.slice(), diff: f.curveDiff.slice() },
  };
}

// ───────────────────────── 解码 + worker 调度（主线程） ─────────────────────────

function cancelledError() { const e = new Error('已取消'); e.code = 'CANCELLED'; return e; }
function lastLine(stderr) {
  const lines = String(stderr || '').split(/\r?\n|\r/).map((l) => l.trim()).filter((l) => l && !/^frame=|^size=|^video:/.test(l));
  return (lines[lines.length - 1] || '').slice(0, 200);
}

function scanArgs(file, seconds, rate) {
  return [
    '-hide_banner', '-nostdin', '-v', 'error',
    '-t', String(seconds), '-i', file,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `fps=${rate},scale=${SCAN_W}:${SCAN_H}:flags=area,format=rgb24`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ];
}

function startWorker(cfg) {
  try {
    const { Worker } = require('node:worker_threads');
    const src = fs.readFileSync(__filename, 'utf8');
    return new Worker(src, { eval: true, workerData: { ffShotdetect: true, cfg } });
  } catch {
    return null;
  }
}

/** 等 worker 报到；3 秒内没报到或出错就放弃，改在主线程里算 */
function waitReady(worker) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; clearTimeout(timer); worker.off('message', onMsg); worker.off('error', onErr); resolve(ok); };
    const onMsg = (m) => { if (m && m.type === 'ready') done(true); };
    const onErr = () => done(false);
    const timer = setTimeout(() => done(false), 3000);
    worker.on('message', onMsg);
    worker.on('error', onErr);
  });
}

/**
 * 一遍解码扫描整段视频，返回切点、镜头（含关键帧帧号与色彩统计）、2fps 曲线。
 * @param {{ffmpeg:string}} paths
 * @param {string} file
 * @param {{ seconds:number, rate?:number, durationHint?:number, signal?:AbortSignal, onFrac?:(f:number)=>void,
 *           noWorker?:boolean, stallMs?:number, detect?:object, bounds?:object }} opts
 */
async function scanVideo(paths, file, opts = {}) {
  const { seconds, signal, onFrac } = opts;
  const rate = opts.rate || 25;
  const stallMs = opts.stallMs || 120000;
  if (signal && signal.aborted) throw cancelledError();
  const cfg = { rate, w: SCAN_W, h: SCAN_H };
  const finishOpts = { durationHint: opts.durationHint || 0, detect: opts.detect || {}, bounds: opts.bounds || {} };

  let worker = null;
  if (!opts.noWorker && !process.env.FF_SHOTDETECT_NO_WORKER) {
    worker = startWorker(cfg);
    if (worker && !(await waitReady(worker))) { try { await worker.terminate(); } catch {} worker = null; }
  }
  if (signal && signal.aborted) { if (worker) worker.terminate().catch(() => {}); throw cancelledError(); }
  const inline = worker ? null : createCollector(cfg);
  const frameBytes = SCAN_W * SCAN_H * 3;
  const expected = Math.max(1, seconds * rate);

  return new Promise((resolve, reject) => {
    const { spawn } = require('node:child_process');
    let child;
    try {
      child = spawn(paths.ffmpeg, scanArgs(file, seconds, rate), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (worker) worker.terminate().catch(() => {});
      reject(new Error('无法运行 ffmpeg：' + e.message));
      return;
    }
    let bytes = 0; let inflight = 0; let paused = false; let stderr = '';
    let lastActivity = Date.now();
    let finished = false;
    const cleanup = () => {
      clearInterval(watchdog);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const fail = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      try { child.kill(); } catch {}
      if (worker) worker.terminate().catch(() => {});
      reject(err);
    };
    const succeed = (res) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (worker) worker.terminate().catch(() => {});
      resolve(res);
    };
    const onAbort = () => fail(cancelledError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > stallMs) fail(new Error('视频解码超时，文件可能过大或已损坏'));
    }, Math.min(5000, Math.max(200, stallMs / 4)));
    watchdog.unref?.();

    let exitCode = null;
    if (worker) {
      worker.on('message', (m) => {
        if (!m || finished) return;
        if (m.type === 'ack') {
          lastActivity = Date.now();
          inflight = Math.max(0, inflight - 1);
          if (paused && inflight < 8) { paused = false; child.stdout.resume(); }
          if (onFrac) { try { onFrac(Math.min(1, m.frames / expected)); } catch {} }
        } else if (m.type === 'result') {
          succeed({ ...m.res, exitCode, stderr, usedWorker: true });
        } else if (m.type === 'error') {
          fail(new Error('画面分析出错：' + m.message));
        }
      });
      worker.on('error', (e) => fail(new Error('画面分析线程出错：' + (e && e.message))));
      worker.on('exit', () => { if (!finished) fail(new Error('画面分析线程意外退出，请重试')); });
    }

    child.stdout.on('data', (chunk) => {
      if (finished) return;
      bytes += chunk.length;
      lastActivity = Date.now();
      if (worker) {
        const u8 = new Uint8Array(chunk.length);
        u8.set(chunk);
        inflight++;
        worker.postMessage({ type: 'chunk', buf: u8 }, [u8.buffer]);
        if (inflight > 24 && !paused) { paused = true; child.stdout.pause(); }
      } else {
        try { inline.feed(chunk); } catch (e) { fail(new Error('画面分析出错：' + e.message)); return; }
        if (onFrac) { try { onFrac(Math.min(1, inline.st.n / expected)); } catch {} }
      }
    });
    child.stderr.on('data', (d) => { if (stderr.length < 20000) stderr += d.toString(); });
    child.on('error', (e) => fail(new Error('无法运行 ffmpeg：' + e.message)));
    child.on('close', (code) => {
      if (finished) return;
      exitCode = code;
      if (signal && signal.aborted) { fail(cancelledError()); return; }
      if (bytes < frameBytes) {
        const tail = lastLine(stderr);
        fail(new Error('视频解码失败，没有读到任何画面' + (tail ? `（${tail}）` : '')));
        return;
      }
      if (worker) {
        lastActivity = Date.now();
        worker.postMessage({ type: 'end', opts: finishOpts });
      } else {
        try { succeed({ ...finishScan(inline.st, finishOpts), exitCode, stderr, usedWorker: false }); } catch (e) { fail(new Error('画面分析出错：' + e.message)); }
      }
    });
  });
}

// ───────────────────────── 按帧号批量导出关键帧（一遍解码） ─────────────────────────

function runFf(bin, args, { signal, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(cancelledError()); return; }
    const { spawn } = require('node:child_process');
    let p;
    try { p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { reject(e); return; }
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const onAbort = () => { try { p.kill(); } catch {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; try { p.kill(); } catch {} }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    p.stderr.on('data', (d) => { if (stderr.length < 20000) stderr += d.toString(); });
    p.on('error', (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    });
    p.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal && signal.aborted) reject(cancelledError());
      else if (timedOut) {
        const err = new Error('导出关键帧超时');
        err.code = 'TIMEOUT';
        reject(err);
      } else resolve({ code, stderr });
    });
  });
}

/**
 * 用扫描时同样的 fps 采样，把指定帧号一次性导出成 JPEG（总共只多解码一遍）。
 * @param {{frame:number,out:string}[]} items
 * @returns {Promise<Set<string>>} 成功写出的 out 路径
 */
async function extractFramesBatch(paths, file, items, { rate, seconds, signal, width = 320, tmpDir, onFrac } = {}) {
  const ok = new Set();
  if (!items.length) return ok;
  const frames = [...new Set(items.map((x) => Math.max(0, Math.round(x.frame))))].sort((a, b) => a - b);
  const expr = frames.map((fr) => `eq(n,${fr})`).join('+');
  if (expr.length > 24000) return ok; // 命令行太长 → 让调用方逐帧抽
  const last = frames[frames.length - 1];
  // 解码到最后一张需要的帧就停
  const secs = Math.max(0.1, Math.min(Number(seconds) > 0 ? Number(seconds) : Infinity, (last + 3) / rate));
  const dir = tmpDir || path.join(path.dirname(items[0].out), '_kf_tmp');
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  // 进度：按已写出的图片数换算成解码位置
  const timer = onFrac ? setInterval(() => {
    try {
      const k = fs.readdirSync(dir).length;
      if (k > 0) onFrac(Math.min(1, (frames[Math.min(k, frames.length) - 1] + 1) / (last + 1)));
    } catch {}
  }, 400) : null;
  try {
    const vf = `fps=${rate},select='${expr}',scale=${width}:-2:flags=bicubic,setpts=N/(FRAME_RATE*TB)`;
    const r = await runFf(paths.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-t', String(secs), '-i', file,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', vf, '-q:v', '3', '-start_number', '0', '-y', path.join(dir, 'f_%05d.jpg')],
    { signal, timeoutMs: 120000 + secs * 4000 });
    if (signal && signal.aborted) throw cancelledError();
    if (r.code !== 0 && !fs.existsSync(path.join(dir, 'f_00000.jpg'))) return ok;
    const byFrame = new Map(frames.map((fr, k) => [fr, path.join(dir, `f_${String(k).padStart(5, '0')}.jpg`)]));
    for (const it of items) {
      const src = byFrame.get(Math.max(0, Math.round(it.frame)));
      try {
        if (src && fs.statSync(src).size > 0) { await fs.promises.copyFile(src, it.out); ok.add(it.out); }
      } catch {}
    }
  } finally {
    if (timer) clearInterval(timer);
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
  }
  return ok;
}

// ───────────────────────── worker 入口 ─────────────────────────

function runWorker() {
  const { parentPort, workerData } = require('node:worker_threads');
  const col = createCollector(workerData.cfg || {});
  parentPort.on('message', (m) => {
    if (!m) return;
    if (m.type === 'chunk') {
      try {
        col.feed(m.buf);
        parentPort.postMessage({ type: 'ack', frames: col.st.n });
      } catch (e) {
        parentPort.postMessage({ type: 'error', message: e && e.message });
      }
    } else if (m.type === 'end') {
      try {
        parentPort.postMessage({ type: 'result', res: finishScan(col.st, m.opts || {}) });
      } catch (e) {
        parentPort.postMessage({ type: 'error', message: e && e.message });
      }
    }
  });
  parentPort.postMessage({ type: 'ready' });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCAN_W, SCAN_H, DETECT_DEFAULTS,
    scanRate, scanVideo, extractFramesBatch,
    createCollector, detectCuts, buildShotBounds, pickKeyframes, shotColorStats, finishScan,
    quantize, statsFromRgb, histDist, sigDist,
  };
}

{
  let wt = null;
  try { wt = require('node:worker_threads'); } catch {}
  if (wt && !wt.isMainThread && wt.workerData && wt.workerData.ffShotdetect) runWorker();
}
