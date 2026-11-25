// 导出进度与剩余时间（纯函数，node 可测）。
//
// 进度以「ffmpeg 已经编码的帧」为准：渲染端送出的帧会先在编码队列里排队，只看送出数，
// 进度条会先冲到 98% 再卡住不动。主进程在 job:progress 的 meta 里带 encoded（已编码帧）/ outSec（已输出秒数）。
// 速度用最近几秒的滑动窗口估计（特效多的段落变慢时能及时反映），再做指数平滑，避免剩余时间来回跳。
// 画面全部编码完、只剩写文件时，剩余时间显示「即将完成」。

const WINDOW_MS = 5000;
const MIN_SPAN_MS = 800;
export const ETA_ALMOST_DONE = '即将完成';

const finite = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * @param {{ total:number, duration?:number, audioOnly?:boolean, now?:()=>number }} opts
 *   total 总帧数；duration 成片秒数（仅音频导出按秒算进度）；now 毫秒时钟（测试注入）
 */
export function createExportProgress({ total, duration = 0, audioOnly = false, now } = {}) {
  const clock = typeof now === 'function' ? now : () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const T = Math.max(1, Math.floor(Number(total) || 1));
  const D = Math.max(0, Number(duration) || 0);
  const start = clock();
  const st = { sent: 0, encoded: null, outSec: 0, ending: false, rate: 0, best: 0, samples: [{ t: start, d: 0 }] };

  /** 已完成的「帧当量」：仅音频按已输出秒数折算 */
  function done() {
    if (audioOnly) return D > 0 ? Math.min(1, st.outSec / D) * T : 0;
    const enc = st.encoded == null ? st.sent : Math.min(st.sent, st.encoded);
    return Math.max(0, Math.min(T, enc));
  }

  function sample() {
    const t = clock();
    const d = done();
    const s = st.samples;
    s.push({ t, d });
    while (s.length > 2 && t - s[1].t >= WINDOW_MS) s.shift();
    if (s.length > 128) s.splice(0, s.length - 128);
    const first = s[0];
    const span = t - first.t;
    if (span < MIN_SPAN_MS) return;
    const inst = Math.max(0, (d - first.d) / (span / 1000));
    st.rate = st.rate > 0 ? st.rate * 0.7 + inst * 0.3 : inst;
  }

  function snapshot() {
    sample();
    const d = done();
    const remaining = Math.max(0, T - d);
    const phase = audioOnly || st.ending ? 'encode' : 'render';
    let etaSec = null;
    let etaLabel;
    const finished = audioOnly ? D > 0 && st.outSec >= D - 0.05 : st.ending && d >= T;
    if (finished) {
      etaSec = 0;
      etaLabel = ETA_ALMOST_DONE;
    } else if (st.rate > 1e-3) {
      etaSec = Math.max(1, Math.round(remaining / st.rate));
    }
    let p = (d / T) * 0.98;
    if (!audioOnly && st.encoded === 0 && st.sent > 0 && !st.ending) {
      // 如 GIF 两阶段 palettegen 在收尾前编码帧始终为 0：按已送帧平滑推进到 75%，避免进度条卡在 0%
      p = (st.sent / T) * 0.75;
    }
    if (finished) p = 0.99;
    p = Math.max(st.best, Math.min(0.99, p));
    st.best = p;
    const out = { phase, frame: audioOnly ? 0 : Math.round(d), total: T, sent: st.sent, fps: Math.round(st.rate * 10) / 10, etaSec, progress: p };
    if (etaLabel) out.etaLabel = etaLabel;
    return out;
  }

  return {
    /** 已送达主进程的帧数 */
    sent(n) {
      const v = finite(n);
      if (v != null) st.sent = Math.max(st.sent, Math.min(T, Math.floor(v)));
    },
    /** 主进程 job:progress 的 meta：{ encoded, outSec } */
    encoded(meta) {
      if (!meta || typeof meta !== 'object') return;
      const e = finite(meta.encoded);
      if (e != null) st.encoded = Math.max(st.encoded == null ? 0 : st.encoded, Math.floor(e));
      const o = finite(meta.outSec);
      if (o != null) st.outSec = Math.max(st.outSec, o);
    },
    /** 画面已全部送出，进入收尾 */
    ending() { st.ending = true; },
    isEnding() { return st.ending; },
    fps() { return Math.round(st.rate * 10) / 10; },
    snapshot,
  };
}
