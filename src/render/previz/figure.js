// 预演人物：半写实、有体积的剪影。
//
// 人物在「人物空间」里建模：身高 = 1，原点在两脚中点，y 向上为负（与 Canvas 一致）。
// 先在离屏缓冲里画出各部件（锥形肢体 + 贝塞尔躯干 / 头发），每个部件按主光方向做圆柱明暗；
// 然后在像素空间里统一做：整体明暗面、脚部环境光遮蔽、边缘光（rim light，用错位遮罩求轮廓），
// 再连同投影一起贴回主画布。这样人物有体积、有轮廓光，而且不必每个形状单独走滤镜。

import {
  TAU, mix, lighten, darken, rgba, lin, rad, scratch,
} from './util.js';

// ---------------- 比例（约 7.5 头身）----------------

const HEAD_CY = -0.916;
const HEAD_RX = 0.047;
const HEAD_RY = 0.061;
const NECK_Y = -0.842;
const SH_Y = -0.81;
const SH_W = 0.104;
const HIP_Y = -0.5;
const HIP_W = 0.07;
const UPPER_ARM = 0.178;
const FOREARM = 0.158;
const THIGH = 0.245;
const SHIN = 0.232;

export const PERSON_SKIN = ['#d9a888', '#c99474', '#e8bf9f', '#b07a5a', '#8f5e44'];
export const PERSON_HAIR = ['#17120f', '#2e2019', '#4a3426', '#1a1b20', '#6b4a32'];
const IRIS = ['#4a3022', '#3a2618', '#5a3c26', '#2e2a26'];

/** 皮肤的暗部色：偏暖的红棕（不能用灰蓝，否则脸上像淤青） */
function skinShadeOf(skin) {
  return mix(darken(skin, 0.42), '#6e2c26', 0.3);
}

// ---------------- 几何 ----------------

function bone(x0, y0, a1, l1, a2, l2) {
  const x1 = x0 + Math.sin(a1) * l1;
  const y1 = y0 + Math.cos(a1) * l1;
  const x2 = x1 + Math.sin(a1 + a2) * l2;
  const y2 = y1 + Math.cos(a1 + a2) * l2;
  return [x0, y0, x1, y1, x2, y2];
}

/**
 * 锥形肢体轮廓：沿两段骨骼采样，按半径曲线向两侧偏移，两端圆头。
 * radii: [根, 中段鼓起, 关节, 下段鼓起, 末端]
 */
function limbPath(g, pts, radii) {
  const [x0, y0, x1, y1, x2, y2] = pts;
  const samples = [];
  const N = 5;
  const seg = (ax, ay, bx, by, r0, rm, r1, from) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-6;
    const nx = -dy / len;
    const ny = dx / len;
    for (let i = from; i <= N; i += 1) {
      const t = i / N;
      // 二次插值的半径：根 → 鼓起 → 末端
      const r = t < 0.45 ? r0 + (rm - r0) * Math.sin((t / 0.45) * Math.PI / 2) : rm + (r1 - rm) * ((t - 0.45) / 0.55) ** 1.4;
      samples.push([ax + dx * t, ay + dy * t, nx, ny, r]);
    }
  };
  seg(x0, y0, x1, y1, radii[0], radii[1], radii[2], 0);
  seg(x1, y1, x2, y2, radii[2], radii[3], radii[4], 1);
  // 关节处法线取平均，避免折角
  const left = samples.map(([x, y, nx, ny, r]) => [x + nx * r, y + ny * r]);
  const right = samples.map(([x, y, nx, ny, r]) => [x - nx * r, y - ny * r]);
  g.beginPath();
  smoothThrough(g, left, true);
  const end = samples[samples.length - 1];
  const ea = Math.atan2(end[3], end[2]);
  g.arc(end[0], end[1], end[4], ea, ea - Math.PI, true);
  smoothThrough(g, right.reverse(), false);
  const st = samples[0];
  const sa = Math.atan2(-st[3], -st[2]);
  g.arc(st[0], st[1], st[4], sa, sa - Math.PI, true);
  g.closePath();
}

function smoothThrough(g, pts, move) {
  if (move) g.moveTo(pts[0][0], pts[0][1]);
  else g.lineTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i += 1) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const l = pts[pts.length - 1];
  g.lineTo(l[0], l[1]);
}

/** 圆柱明暗：沿垂直于骨骼的方向，从受光边到背光边 */
function cylFill(g, base, L, ax, ay, bx, by, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1e-6;
  let nx = -dy / len;
  let ny = dx / len;
  // 让 n 指向光源
  const lx = L.dirX;
  const ly = L.dirY;
  if (nx * lx + ny * ly < 0) {
    nx = -nx;
    ny = -ny;
  }
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  return lin(g, mx + nx * r, my + ny * r, mx - nx * r, my - ny * r, [
    [0, L.hi(base)], [0.28, L.lit(base)], [0.62, base], [1, L.lo(base)],
  ]);
}

// ---------------- 部件 ----------------

function drawLimb(g, pts, radii, base, L) {
  limbPath(g, pts, radii);
  g.fillStyle = cylFill(g, base, L, pts[0], pts[1], pts[4], pts[5], radii[1] * 1.15);
  g.fill();
}

function drawHand(g, wx, wy, ang, base, L, len = 0.06, open = 0, detail = false) {
  g.save();
  g.translate(wx, wy);
  g.rotate(-ang);
  // 手：掌心略收、指尖圆润的放松手形，拇指贴在一侧（局部坐标 y 指向指尖）
  const pw = 0.0152;
  g.beginPath();
  g.moveTo(-pw * 0.82, -0.004);
  g.bezierCurveTo(-pw * 1.08, len * 0.3, -pw * 1.02 - open * 0.006, len * 0.64, -pw * 0.66 - open * 0.006, len * 0.88);
  g.quadraticCurveTo(-pw * 0.12, len * 1.05, pw * 0.4, len * 0.95);
  g.bezierCurveTo(pw * 0.82 + open * 0.006, len * 0.84, pw * 1.02 + open * 0.004, len * 0.56, pw * 0.96, len * 0.34);
  g.quadraticCurveTo(pw * 1.0, 0.004, pw * 0.82, -0.004);
  g.closePath();
  g.fillStyle = lin(g, -pw * 1.2, 0, pw * 1.2, 0, L.dirX < 0 ? [[0, L.lit(base)], [0.6, base], [1, L.lo(base)]] : [[0, L.lo(base)], [0.4, base], [1, L.lit(base)]]);
  g.fill();
  if (detail) {
    // 指缝：三道很淡的短线
    g.strokeStyle = rgba(darken(base, 0.4), 0.22);
    g.lineWidth = 0.0012;
    g.lineCap = 'round';
    for (const x of [-0.45, 0, 0.42]) {
      g.beginPath();
      g.moveTo(pw * x, len * 0.62);
      g.lineTo(pw * x * 1.08, len * 0.9);
      g.stroke();
    }
  }
  // 拇指
  g.beginPath();
  g.moveTo(pw * 0.7, len * 0.1);
  g.bezierCurveTo(pw * 1.5 + open * 0.008, len * 0.22, pw * 1.75 + open * 0.01, len * 0.46, pw * 1.32, len * 0.56);
  g.quadraticCurveTo(pw * 1.0, len * 0.6, pw * 0.8, len * 0.46);
  g.closePath();
  g.fillStyle = darken(base, 0.06);
  g.fill();
  g.restore();
}

function drawShoe(g, ax, ay, dir, side, base, L) {
  // dir: -1..1 鞋尖朝向（侧面时长，正面时短）
  const len = 0.03 + Math.abs(dir) * 0.034;
  const s = dir >= 0 ? 1 : -1;
  g.beginPath();
  g.moveTo(ax - s * 0.022, ay - 0.012);
  g.quadraticCurveTo(ax - s * 0.028, ay + 0.02, ax - s * 0.012, ay + 0.024);
  g.lineTo(ax + s * len * 0.8, ay + 0.024);
  g.quadraticCurveTo(ax + s * (len + 0.018), ay + 0.022, ax + s * len * 0.82, ay + 0.002);
  g.quadraticCurveTo(ax + s * len * 0.4, ay - 0.008, ax + s * 0.01, ay - 0.016);
  g.closePath();
  g.fillStyle = lin(g, 0, ay - 0.016, 0, ay + 0.024, [[0, L.lit(base)], [0.6, base], [1, darken(base, 0.4)]]);
  g.fill();
  // 鞋底
  g.fillStyle = rgba(lighten(base, 0.5), 0.55);
  g.fillRect(ax - s * 0.016 - (s < 0 ? len + 0.004 : 0), ay + 0.019, len + 0.02, 0.005);
  void side;
}

function torsoPath(g, T) {
  const { sw, ww, hw, cx, chest, back, f } = T;
  // 胸口向朝向侧鼓出，背部稍收
  const L = -1;
  const R = 1;
  const off = (side, k) => (side === f ? chest * k : -back * k);
  g.beginPath();
  g.moveTo(cx - 0.03, NECK_Y + 0.02);
  g.bezierCurveTo(cx - 0.06, SH_Y - 0.004, cx - sw + 0.02, SH_Y - 0.006, cx - sw - 0.006, SH_Y + 0.03);
  g.bezierCurveTo(cx - sw - 0.012 + off(L, 1), SH_Y + 0.1, cx - ww + off(L, 0.8), -0.67, cx - ww + off(L, 0.3), -0.62);
  g.bezierCurveTo(cx - ww - 0.004, -0.57, cx - hw - 0.012, -0.52, cx - hw - 0.014, HIP_Y + 0.045);
  g.quadraticCurveTo(cx, HIP_Y + 0.062, cx + hw + 0.014, HIP_Y + 0.045);
  g.bezierCurveTo(cx + hw + 0.012, -0.52, cx + ww + 0.004, -0.57, cx + ww + off(R, 0.3), -0.62);
  g.bezierCurveTo(cx + ww + off(R, 0.8), -0.67, cx + sw + 0.012 + off(R, 1), SH_Y + 0.1, cx + sw + 0.006, SH_Y + 0.03);
  g.bezierCurveTo(cx + sw - 0.02, SH_Y - 0.006, cx + 0.06, SH_Y - 0.004, cx + 0.03, NECK_Y + 0.02);
  g.closePath();
}

function pelvisPath(g, T) {
  const { hw, cx } = T;
  g.beginPath();
  g.moveTo(cx - hw - 0.006, HIP_Y - 0.04);
  g.lineTo(cx + hw + 0.006, HIP_Y - 0.04);
  g.quadraticCurveTo(cx + hw + 0.016, HIP_Y + 0.04, cx + hw * 0.9, HIP_Y + 0.1);
  g.lineTo(cx - hw * 0.9, HIP_Y + 0.1);
  g.quadraticCurveTo(cx - hw - 0.016, HIP_Y + 0.04, cx - hw - 0.006, HIP_Y - 0.04);
  g.closePath();
}

function headPath(g, v) {
  // 蛋形头 + 下颌；侧面时下巴和鼻子向朝向侧突出
  const fx = v * 0.022;
  const rx = HEAD_RX * (1 - Math.abs(v) * 0.06);
  g.beginPath();
  g.moveTo(-rx + fx * 0.2 - Math.abs(v) * 0.006 * Math.sign(v), -0.004);
  g.bezierCurveTo(-rx - 0.002, -HEAD_RY * 0.95, rx + 0.002, -HEAD_RY * 0.95, rx + fx * 0.2 + Math.abs(v) * 0.004 * Math.sign(v), -0.004);
  g.bezierCurveTo(rx + fx * 0.3, HEAD_RY * 0.45, fx + rx * 0.45, HEAD_RY * 0.98, fx * 1.2, HEAD_RY);
  g.bezierCurveTo(fx - rx * 0.45, HEAD_RY * 0.98, -rx + fx * 0.3, HEAD_RY * 0.45, -rx + fx * 0.2 - Math.abs(v) * 0.006 * Math.sign(v), -0.004);
  g.closePath();
}

/** 后脑发量（画在头之前）：所有发型都有；长发垂到肩后，盘发在头顶偏后挽髻 */
function drawHairBack(g, look, v, L) {
  const hair = look.hair;
  const bx = -v * 0.014;
  const fill = () => {
    g.fillStyle = lin(g, L.dirX * 0.05, -0.07, -L.dirX * 0.03, 0.16, [[0, lighten(mix(hair, L.key, 0.2), 0.08)], [0.35, hair], [1, darken(hair, 0.35)]]);
    g.fill();
  };
  if (look.hairStyle === 1) {
    // 长发：从鬓角垂到肩，发梢柔和
    g.beginPath();
    g.moveTo(bx - 0.05, -0.03);
    g.bezierCurveTo(bx - 0.066, 0.02, bx - 0.071, 0.09, bx - 0.062, 0.146);
    g.quadraticCurveTo(bx - 0.036, 0.162, bx - 0.012, 0.15);
    g.quadraticCurveTo(bx, 0.156, bx + 0.012, 0.15);
    g.quadraticCurveTo(bx + 0.036, 0.162, bx + 0.062, 0.146);
    g.bezierCurveTo(bx + 0.071, 0.09, bx + 0.066, 0.02, bx + 0.05, -0.03);
    g.closePath();
    fill();
  }
  // 后脑：比头顶大一圈的发量
  g.beginPath();
  g.ellipse(bx * 0.6, -0.014, HEAD_RX * 1.12, 0.057, 0, 0, TAU);
  fill();
  if (look.hairStyle === 2) {
    // 发髻
    const s = v >= 0 ? 1 : -1;
    const kx = bx - s * Math.abs(v) * 0.02;
    g.beginPath();
    g.ellipse(kx, -0.074, 0.027, 0.022, 0, 0, TAU);
    g.fillStyle = rad(g, kx + L.dirX * 0.009, -0.082, 0, 0.032, [[0, lighten(mix(hair, L.key, 0.2), 0.14)], [0.6, hair], [1, darken(hair, 0.3)]]);
    g.fill();
  }
}

/** 前额头发（画在脸之后）：发际线 + 刘海，一条宽而柔的光泽带（不画条纹） */
function drawHairFront(g, look, v, L, detail) {
  const hair = look.hair;
  const s = v >= 0 ? 1 : -1;
  const av = Math.abs(v);
  const fx = v * 0.024;
  const back = -s * av * 0.012; // 侧面时发量偏向后脑
  const rx = HEAD_RX * 1.12;
  const top = -0.071;
  const part = fx - 0.014 * (look.part || 1); // 分线位置
  g.beginPath();
  // 外轮廓：左鬓角 → 头顶 → 右鬓角
  g.moveTo(-rx + back, 0.004);
  g.bezierCurveTo(-rx - 0.002 + back, -0.04, -rx * 0.62 + back, top, back + fx * 0.25, top);
  g.bezierCurveTo(rx * 0.62 + back, top, rx + 0.002 + back, -0.04, rx + back, 0.004);
  if (look.hairStyle === 1) {
    // 长发：八字刘海，两侧发片沿脸颊垂下，露出脸的中间
    g.lineTo(rx + back + 0.004, 0.07);
    g.quadraticCurveTo(rx * 0.86 + back, 0.084, rx * 0.76 + back + fx * 0.3, 0.062);
    g.bezierCurveTo(rx * 0.8 + fx * 0.4, 0.012, rx * 0.5 + fx, -0.03, part + 0.004, -0.046);
    g.bezierCurveTo(-rx * 0.5 + fx, -0.03, -rx * 0.8 + fx * 0.4, 0.012, -rx * 0.76 + back + fx * 0.3, 0.062);
    g.quadraticCurveTo(-rx * 0.86 + back, 0.084, -rx + back - 0.004, 0.07);
  } else if (look.hairStyle === 2) {
    // 盘发：发际线干净，向后梳
    g.bezierCurveTo(rx * 0.92 + back, -0.02, rx * 0.5 + fx, -0.036, fx, -0.038);
    g.bezierCurveTo(-rx * 0.5 + fx, -0.036, -rx * 0.92 + back, -0.02, -rx + back, 0.004);
  } else {
    // 短发：侧分，刘海从分线斜扫向另一侧
    g.bezierCurveTo(rx * 0.96 + back, -0.018, rx * 0.66 + fx, -0.026, rx * 0.3 + fx, -0.03);
    g.bezierCurveTo(rx * 0.05 + fx, -0.033, part + 0.01, -0.044, part, -0.047);
    g.bezierCurveTo(part - 0.012, -0.04, -rx * 0.7 + back, -0.034, -rx + back, 0.004);
  }
  g.closePath();
  g.fillStyle = lin(g, L.dirX * rx, top, -L.dirX * rx * 0.5, 0.06, [[0, lighten(mix(hair, L.key, 0.22), 0.1)], [0.4, hair], [1, darken(hair, 0.3)]]);
  g.fill();
  // 光泽带：沿头顶弧形
  g.save();
  g.clip();
  const hx = L.dirX * 0.012 + back + fx * 0.2;
  const sheen = lighten(mix(hair, L.key, 0.45), 0.32);
  g.lineCap = 'round';
  g.strokeStyle = rgba(sheen, 0.15);
  g.lineWidth = 0.014;
  g.beginPath();
  g.ellipse(hx, -0.018, rx * 0.84, 0.042, 0, Math.PI * 1.12, Math.PI * 1.7);
  g.stroke();
  g.strokeStyle = rgba(sheen, 0.2);
  g.lineWidth = 0.005;
  g.beginPath();
  g.ellipse(hx, -0.019, rx * 0.84, 0.043, 0, Math.PI * 1.2, Math.PI * 1.6);
  g.stroke();
  if (detail) {
    // 少量很淡的发丝走向，避免塑料感
    g.strokeStyle = rgba(darken(hair, 0.4), 0.2);
    g.lineWidth = 0.0015;
    for (let i = 0; i < 5; i += 1) {
      const ox = part + (i - 2) * 0.012;
      g.beginPath();
      g.moveTo(part, -0.05);
      g.quadraticCurveTo(ox + (ox - part) * 0.6, -0.052, ox + (ox - part) * 1.6, -0.02);
      g.stroke();
    }
  }
  g.restore();
}

/**
 * 五官：偏插画的半写实画法——杏仁眼（眼白、虹膜、高光、上睫毛线）、内粗外细的眉、
 * 只用阴影表现的鼻子、带唇峰的嘴。fine=false（脸很小）时眼睛简化成深色杏仁形，避免糊成一团。
 */
function drawFace(g, look, v, mouth, L, fine) {
  const av = Math.abs(v);
  const s = v >= 0 ? 1 : -1;
  const fx = v * 0.026;
  const eyeY = -0.001;
  const gap = 0.0195 * (1 - av * 0.55);
  const shade = look.skinShade;
  const lx = L.dirX || 0;
  // ---- 面部明暗（裁在头型内）----
  g.save();
  headPath(g, v);
  g.clip();
  g.fillStyle = lx
    ? lin(g, lx * 0.05, 0, -lx * 0.05, 0, [[0, rgba('#fff3e6', 0.12)], [0.45, 'rgba(0,0,0,0)'], [1, rgba(shade, 0.36)]])
    : rad(g, fx, 0, 0.02, 0.07, [[0, 'rgba(0,0,0,0)'], [1, rgba(shade, 0.3)]]);
  g.fillRect(-0.08, -0.08, 0.16, 0.16);
  // 刘海在额头上的投影、下颌下缘
  g.fillStyle = lin(g, 0, -0.047, 0, -0.022, [[0, rgba(shade, 0.36)], [1, rgba(shade, 0)]]);
  g.fillRect(-0.08, -0.06, 0.16, 0.04);
  g.fillStyle = lin(g, 0, 0.044, 0, 0.062, [[0, rgba(shade, 0)], [1, rgba(shade, 0.24)]]);
  g.fillRect(-0.08, 0.044, 0.16, 0.02);
  // 腮红
  for (const k of [-1, 1]) {
    if (av > 0.62 && k === -s) continue;
    const cx = fx + k * (gap + 0.007);
    g.fillStyle = rad(g, cx, 0.019, 0, 0.017, [[0, rgba('#ea8a74', 0.16)], [1, rgba('#ea8a74', 0)]]);
    g.fillRect(cx - 0.02, 0, 0.04, 0.04);
  }
  g.restore();

  // ---- 眼睛 + 眉 ----
  const lash = darken(look.hair, 0.35);
  const white = mix(look.skin, '#fbf6f2', 0.78);
  const iris = look.iris || IRIS[((look.seed || 0) >>> 0) % IRIS.length];
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const k of [-1, 1]) {
    if (av > 0.62 && k === -s) continue;
    const ex = fx + k * gap;
    const nar = 1 - (k === -s ? av * 0.5 : 0);
    const ew = 0.0094 * nar;
    const up = 0.0056;
    const dn = 0.0031;
    const ix = ex - k * ew; // 内眼角
    const ox = ex + k * ew; // 外眼角（略高）
    const upper = (move) => {
      if (move) g.moveTo(ix, eyeY + 0.0006);
      g.bezierCurveTo(ex - k * ew * 0.45, eyeY - up * 1.25, ex + k * ew * 0.55, eyeY - up * 1.1, ox, eyeY - 0.0009);
    };
    const eyeShape = () => {
      g.beginPath();
      upper(true);
      g.bezierCurveTo(ex + k * ew * 0.45, eyeY + dn * 1.2, ex - k * ew * 0.5, eyeY + dn * 1.15, ix, eyeY + 0.0006);
      g.closePath();
    };
    const gx = ex + v * 0.0028;
    const gy = eyeY + 0.0003;
    const ir = 0.0049 * (0.75 + 0.25 * nar);
    if (fine) {
      eyeShape();
      g.fillStyle = white;
      g.fill();
      g.save();
      eyeShape();
      g.clip();
      g.fillStyle = rad(g, gx, gy, 0, ir, [[0, lighten(iris, 0.18)], [0.62, iris], [1, darken(iris, 0.5)]]);
      g.beginPath();
      g.arc(gx, gy, ir, 0, TAU);
      g.fill();
      g.fillStyle = '#120c09';
      g.beginPath();
      g.arc(gx, gy, ir * 0.45, 0, TAU);
      g.fill();
      // 上眼睑投在眼球上的阴影
      g.fillStyle = lin(g, 0, eyeY - up, 0, eyeY + 0.001, [[0, 'rgba(40,20,14,0.45)'], [1, 'rgba(40,20,14,0)']]);
      g.fillRect(ex - 0.012, eyeY - 0.008, 0.024, 0.009);
      g.restore();
      // 上睫毛线（外眼角略上挑）
      g.strokeStyle = lash;
      g.lineWidth = 0.0021;
      g.beginPath();
      upper(true);
      g.lineTo(ox + k * 0.0019, eyeY - 0.0024);
      g.stroke();
      // 下眼睑、双眼皮褶（都很淡）
      g.strokeStyle = rgba(shade, 0.3);
      g.lineWidth = 0.0009;
      g.beginPath();
      g.moveTo(ox, eyeY - 0.0006);
      g.bezierCurveTo(ex + k * ew * 0.45, eyeY + dn * 1.2, ex - k * ew * 0.5, eyeY + dn * 1.15, ix + k * 0.0012, eyeY + 0.0012);
      g.stroke();
      g.strokeStyle = rgba(shade, 0.26);
      g.lineWidth = 0.001;
      g.beginPath();
      g.moveTo(ex - k * ew * 0.55, eyeY - up * 1.5);
      g.quadraticCurveTo(ex + k * ew * 0.2, eyeY - up * 1.95, ox - k * 0.0005, eyeY - up * 1.15);
      g.stroke();
    } else {
      eyeShape();
      g.fillStyle = mix(iris, '#140c08', 0.55);
      g.fill();
    }
    // 高光
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.arc(gx + (lx || 0.4) * 0.0017, gy - 0.0017, ir * (fine ? 0.24 : 0.3), 0, TAU);
    g.fill();
    // 眉：内粗外细、带一点弧度的实心形
    const by = eyeY - 0.0128;
    const bi = ex - k * 0.0098 * nar;
    const bp = ex + k * 0.0036 * nar;
    const bo = ex + k * 0.0128 * nar;
    g.beginPath();
    g.moveTo(bi, by + 0.0012);
    g.quadraticCurveTo(bi + k * 0.004 * nar, by - 0.0024, bp, by - 0.0032);
    g.quadraticCurveTo(bp + k * 0.005 * nar, by - 0.0033, bo, by + 0.0006);
    g.quadraticCurveTo(bp + k * 0.004 * nar, by - 0.0016, bp, by - 0.0009);
    g.quadraticCurveTo(bi + k * 0.004 * nar, by + 0.0004, bi, by + 0.0034);
    g.closePath();
    g.fillStyle = rgba(mix(look.hair, look.skin, 0.12), 0.9);
    g.fill();
  }

  // ---- 鼻：鼻底阴影 + 鼻翼 + 鼻尖高光，不画轮廓线 ----
  const nx = fx + s * av * 0.007;
  const ny = eyeY + 0.026;
  g.fillStyle = rad(g, nx, ny + 0.0006, 0, 0.0075, [[0, rgba(shade, 0.34)], [1, rgba(shade, 0)]]);
  g.beginPath();
  g.ellipse(nx, ny + 0.0006, 0.0075, 0.0034, 0, 0, TAU);
  g.fill();
  if (lx) {
    g.strokeStyle = rgba(shade, 0.15);
    g.lineWidth = 0.0028;
    g.beginPath();
    g.moveTo(nx - lx * 0.0032, eyeY + 0.005);
    g.quadraticCurveTo(nx - lx * 0.0046, eyeY + 0.016, nx - lx * 0.0052, ny - 0.002);
    g.stroke();
  }
  if (fine) {
    g.fillStyle = rgba(darken(shade, 0.2), 0.3);
    for (const k of [-1, 1]) {
      if (av > 0.62 && k === -s) continue;
      g.beginPath();
      g.ellipse(nx + k * 0.0035 * (1 - av * 0.4), ny, 0.0014, 0.0009, 0, 0, TAU);
      g.fill();
    }
  }
  g.fillStyle = rgba('#fff6ee', 0.18);
  g.beginPath();
  g.arc(nx + (lx || 0.3) * 0.0016, ny - 0.0042, 0.0026, 0, TAU);
  g.fill();

  // ---- 嘴：带唇峰的上唇 + 饱满的下唇；说话时露出一点牙齿 ----
  const my = 0.0372;
  const mw = 0.0104 * (1 - av * 0.45);
  const lip = mix(look.skin, '#c76459', 0.36);
  const lipTop = mix(lip, darken(look.skin, 0.35), 0.35);
  const open = mouth > 0.1 ? 0.0024 + mouth * 0.005 : 0;
  const cl = fx - mw * 1.04;
  const cr = fx + mw * 1.04;
  if (open > 0) {
    g.beginPath();
    g.moveTo(cl, my);
    g.quadraticCurveTo(fx, my - 0.0028, cr, my);
    g.quadraticCurveTo(fx, my + open * 2, cl, my);
    g.closePath();
    g.fillStyle = '#4e211e';
    g.fill();
    g.save();
    g.clip();
    g.fillStyle = 'rgba(244,236,228,0.92)';
    g.fillRect(cl, my - 0.004, cr - cl, 0.0036 + open * 0.2);
    g.fillStyle = rgba('#b0544c', 0.7);
    g.beginPath();
    g.ellipse(fx, my + open * 1.5, mw * 0.6, open * 0.6, 0, 0, TAU);
    g.fill();
    g.restore();
  }
  // 上唇
  g.beginPath();
  g.moveTo(cl, my - 0.0004);
  g.quadraticCurveTo(fx - mw * 0.62, my - 0.0036, fx - mw * 0.28, my - 0.0043);
  g.quadraticCurveTo(fx - mw * 0.1, my - 0.0044, fx, my - 0.0032);
  g.quadraticCurveTo(fx + mw * 0.1, my - 0.0044, fx + mw * 0.28, my - 0.0043);
  g.quadraticCurveTo(fx + mw * 0.62, my - 0.0036, cr, my - 0.0004);
  g.quadraticCurveTo(fx, my + (open > 0 ? -0.0028 : 0.0012), cl, my - 0.0004);
  g.closePath();
  g.fillStyle = lipTop;
  g.fill();
  // 下唇
  g.beginPath();
  g.moveTo(fx - mw * 0.96, my);
  g.quadraticCurveTo(fx, my + 2 * open + (open > 0 ? 0 : 0.0012), fx + mw * 0.96, my);
  g.quadraticCurveTo(fx, my + 2 * open + 0.0125, fx - mw * 0.96, my);
  g.closePath();
  g.fillStyle = lip;
  g.fill();
  if (open <= 0) {
    // 唇线：嘴角微微上扬
    g.strokeStyle = rgba(mix(darken(look.skin, 0.55), '#5a2420', 0.5), 0.7);
    g.lineWidth = 0.0011;
    g.beginPath();
    g.moveTo(cl, my - 0.0006);
    g.quadraticCurveTo(fx, my + 0.0014, cr, my - 0.0006);
    g.stroke();
  }
  if (fine) {
    // 下唇高光 + 唇下阴影
    g.fillStyle = rgba('#ffffff', 0.13);
    g.beginPath();
    g.ellipse(fx + lx * 0.002, my + open + 0.0034, mw * 0.36, 0.0011, 0, 0, TAU);
    g.fill();
  }
  g.fillStyle = rgba(shade, 0.18);
  g.beginPath();
  g.ellipse(fx, my + open + 0.0094, 0.0062, 0.0016, 0, 0, TAU);
  g.fill();
}

function drawKettle(g, x, y, f, pour, look, L) {
  g.save();
  g.translate(x, y);
  g.rotate(f * (0.05 + pour * 0.7));
  const metal = look.metal;
  // 手冲壶：圆柱壶身 + 鹅颈壶嘴 + 把手
  const bw = 0.05;
  const bh = 0.062;
  const bx = f * 0.012;
  g.beginPath();
  g.moveTo(bx - bw, 0.0);
  g.quadraticCurveTo(bx - bw - 0.004, bh, bx - bw * 0.8, bh + 0.006);
  g.lineTo(bx + bw * 0.8, bh + 0.006);
  g.quadraticCurveTo(bx + bw + 0.004, bh, bx + bw, 0.0);
  g.quadraticCurveTo(bx, -0.012, bx - bw, 0.0);
  g.closePath();
  g.fillStyle = lin(g, bx - bw, 0, bx + bw, 0, [[0, darken(metal, 0.45)], [0.22, lighten(metal, 0.5)], [0.36, metal], [0.8, darken(metal, 0.35)], [1, darken(metal, 0.15)]]);
  g.fill();
  // 盖
  g.beginPath();
  g.ellipse(bx, -0.002, bw * 0.7, 0.008, 0, 0, TAU);
  g.fillStyle = lighten(metal, 0.2);
  g.fill();
  g.beginPath();
  g.arc(bx, -0.012, 0.006, 0, TAU);
  g.fillStyle = '#1c1c1e';
  g.fill();
  // 壶嘴
  g.strokeStyle = lin(g, 0, 0, 0, 0.06, [[0, lighten(metal, 0.3)], [1, darken(metal, 0.3)]]);
  g.lineWidth = 0.007;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(bx + f * bw * 0.8, bh * 0.8);
  g.bezierCurveTo(bx + f * (bw + 0.04), bh * 0.85, bx + f * (bw + 0.05), bh * 0.2, bx + f * (bw + 0.078), -0.012);
  g.stroke();
  // 把手
  g.strokeStyle = '#222326';
  g.lineWidth = 0.008;
  g.beginPath();
  g.moveTo(bx - f * bw, 0.008);
  g.quadraticCurveTo(bx - f * (bw + 0.03), bh * 0.4, bx - f * bw, bh * 0.85);
  g.stroke();
  g.restore();
  if (pour > 0.42) {
    // 细水流：从壶嘴尖（壶局部坐标旋转后）落下
    const a = f * (0.05 + pour * 0.7);
    const lx = bx + f * (bw + 0.078);
    const ly = -0.012;
    const tx = x + lx * Math.cos(a) - ly * Math.sin(a);
    const ty = y + lx * Math.sin(a) + ly * Math.cos(a);
    g.strokeStyle = rgba(look.water, 0.8);
    g.lineWidth = 0.0035;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(tx, ty);
    g.quadraticCurveTo(tx + f * 0.008, ty + 0.04, tx + f * 0.01, ty + 0.16);
    g.stroke();
  }
  void L;
}

/** 衣褶：在躯干内画几道柔和的暗线和亮线 */
function torsoFolds(g, T, look, L) {
  const { cx, sw, f, av } = T;
  g.lineCap = 'round';
  const dark = rgba(look.shadowTint, 0.16);
  const hi = rgba(lighten(look.cloth, 0.4), 0.1);
  // 腋下的拉扯褶（短、柔）+ 腰部堆褶
  for (const k of [-1, 1]) {
    g.strokeStyle = dark;
    g.lineWidth = 0.006;
    g.beginPath();
    g.moveTo(cx + k * (sw - 0.008), SH_Y + 0.07);
    g.quadraticCurveTo(cx + k * (sw * 0.7), -0.7, cx + k * (sw * 0.45), -0.665);
    g.stroke();
    g.strokeStyle = hi;
    g.lineWidth = 0.004;
    g.beginPath();
    g.moveTo(cx + k * (sw - 0.02), SH_Y + 0.08);
    g.quadraticCurveTo(cx + k * (sw * 0.62), -0.705, cx + k * (sw * 0.4), -0.675);
    g.stroke();
    g.strokeStyle = dark;
    g.beginPath();
    g.moveTo(cx + k * 0.06, -0.575);
    g.quadraticCurveTo(cx + k * 0.035, -0.565, cx + k * 0.015, -0.57);
    g.stroke();
  }
  // 女装：圆领上衣（露出锁骨一带）；男装：门襟 + 内搭 V 领 + 翻领
  if (T.fem && av < 0.8) {
    const zx = cx + f * av * 0.03;
    g.beginPath();
    g.moveTo(zx - 0.035, NECK_Y + 0.014);
    g.quadraticCurveTo(zx, NECK_Y + 0.07, zx + 0.035, NECK_Y + 0.014);
    g.closePath();
    g.fillStyle = lin(g, 0, NECK_Y, 0, NECK_Y + 0.055, [[0, mix(look.skin, look.skinShade, 0.45)], [1, look.skin]]);
    g.fill();
    g.strokeStyle = rgba(lighten(look.cloth, 0.3), 0.32);
    g.lineWidth = 0.003;
    g.beginPath();
    g.moveTo(zx - 0.035, NECK_Y + 0.015);
    g.quadraticCurveTo(zx, NECK_Y + 0.071, zx + 0.035, NECK_Y + 0.015);
    g.stroke();
  } else if (!T.fem && av < 0.75) {
    const zx = cx + f * av * 0.035;
    g.strokeStyle = rgba(look.shadowTint, 0.3);
    g.lineWidth = 0.004;
    g.beginPath();
    g.moveTo(zx, NECK_Y + 0.05);
    g.lineTo(zx - 0.002, HIP_Y + 0.05);
    g.stroke();
    // 内搭 V 领
    g.beginPath();
    g.moveTo(zx - 0.032, NECK_Y + 0.022);
    g.lineTo(zx, NECK_Y + 0.085);
    g.lineTo(zx + 0.032, NECK_Y + 0.022);
    g.closePath();
    g.fillStyle = lin(g, 0, NECK_Y, 0, NECK_Y + 0.09, [[0, look.shirt], [1, darken(look.shirt, 0.25)]]);
    g.fill();
    // 翻领
    for (const k of [-1, 1]) {
      g.beginPath();
      g.moveTo(zx + k * 0.034, NECK_Y + 0.018);
      g.lineTo(zx + k * 0.05, NECK_Y + 0.05);
      g.lineTo(zx + k * 0.004, NECK_Y + 0.1);
      g.closePath();
      g.fillStyle = k === (L.dirX || 1) ? L.lit(look.cloth) : darken(look.cloth, 0.2);
      g.fill();
    }
  }
  // 下摆阴影
  g.fillStyle = lin(g, 0, -0.56, 0, HIP_Y + 0.06, [[0, rgba(look.shadowTint, 0)], [1, rgba(look.shadowTint, 0.3)]]);
  g.fillRect(cx - 0.2, -0.56, 0.4, 0.13);
}

// ---------------- 组装 ----------------

function buildLight(e, look) {
  const dirX = e.keyX || 0;
  const dirY = e.back ? 0.3 : -0.55; // 主光略高
  const key = e.key;
  return {
    key,
    dirX: dirX || (e.back ? 0 : 0.35),
    dirY,
    hi: (c) => lighten(mix(c, key, 0.26), 0.09),
    lit: (c) => lighten(mix(c, key, 0.14), 0.04),
    lo: (c) => mix(darken(c, 0.45), look.shadowTint, 0.3),
  };
}

function paintFigure(g, pose, look, L, detail, fine) {
  const f = pose.facing;
  const v = pose.view;
  const av = Math.abs(v);
  const nearSide = v >= 0 ? 1 : -1;
  const k = 1 - 0.46 * av;
  // 体型：长发 / 盘发按女性体型（肩窄、腰收、胯宽），短发按男性体型
  const fem = look.hairStyle === 1 || look.hairStyle === 2;
  const T = {
    sw: (fem ? 0.093 : SH_W) * k + 0.01 * av, ww: (fem ? 0.063 : 0.074) * (1 - 0.25 * av), hw: (fem ? 0.079 : HIP_W) * (1 - 0.22 * av), cx: 0, f: nearSide, av,
    chest: 0.016 * av, back: 0.008 * av, fem,
  };
  const hipFar = -nearSide * T.hw * 0.52;
  const hipNear = nearSide * T.hw * 0.52;
  const legFar = bone(hipFar, HIP_Y + 0.03, f * pose.legFar[0], THIGH, -f * pose.legFar[1], SHIN);
  const legNear = bone(hipNear, HIP_Y + 0.03, f * pose.legNear[0], THIGH, -f * pose.legNear[1], SHIN);
  // 肩关节收进躯干轮廓里，手臂根部和肩线连成一体（不再像单独接上去的圆球）
  const shX = T.sw - 0.024;
  const armSign = (side) => (av > 0.5 ? f : side);
  const armFar = bone(-nearSide * shX, SH_Y + 0.034, armSign(-nearSide) * pose.armFar[0], UPPER_ARM, armSign(-nearSide) * pose.armFar[1], FOREARM);
  const armNear = bone(nearSide * shX, SH_Y + 0.034, armSign(nearSide) * pose.armNear[0], UPPER_ARM, armSign(nearSide) * pose.armNear[1], FOREARM);
  const legR = fem ? [0.049, 0.052, 0.034, 0.035, 0.024] : [0.05, 0.054, 0.037, 0.038, 0.026];
  const armR = fem ? [0.029, 0.027, 0.022, 0.022, 0.018] : [0.032, 0.031, 0.025, 0.025, 0.02];
  const farShade = (c) => darken(c, 0.2);
  const footDir = av > 0.35 ? f * av : nearSide * 0.25;

  g.save();
  g.translate(0, -pose.lift - pose.bob);
  g.scale(1, pose.squash);

  // 后侧肢体（更暗）
  drawLimb(g, legFar, legR, farShade(look.pants), L);
  drawShoe(g, legFar[4], legFar[5], footDir, -1, farShade(look.shoe), L);
  const farArmDrawnBehind = true;
  if (farArmDrawnBehind) {
    drawLimb(g, armFar, armR, farShade(look.cloth), L);
    drawHand(g, armFar[4], armFar[5], Math.atan2(armFar[4] - armFar[2], armFar[5] - armFar[3]), farShade(look.skin), L, 0.06, 0, false);
  }
  // 头发后片
  g.save();
  g.translate(pose.head * 0.04 + v * 0.006, HEAD_CY);
  g.rotate(pose.head * f);
  drawHairBack(g, look, v, L);
  g.restore();

  // 骨盆 + 近侧腿
  pelvisPath(g, T);
  g.fillStyle = lin(g, -T.hw, 0, T.hw, 0, L.dirX < 0 ? [[0, L.lit(look.pants)], [1, L.lo(look.pants)]] : [[0, L.lo(look.pants)], [1, L.lit(look.pants)]]);
  g.fill();
  drawLimb(g, legNear, legR, look.pants, L);
  drawShoe(g, legNear[4], legNear[5], footDir, 1, look.shoe, L);
  // 膝盖褶
  if (detail) {
    g.strokeStyle = rgba(look.shadowTint, 0.25);
    g.lineWidth = 0.005;
    g.beginPath();
    g.moveTo(legNear[2] - 0.022, legNear[3] - 0.01);
    g.quadraticCurveTo(legNear[2], legNear[3] + 0.006, legNear[2] + 0.02, legNear[3] - 0.012);
    g.stroke();
  }

  // 躯干（绕髋部前倾）
  g.save();
  g.translate(0, HIP_Y);
  g.rotate(f * pose.lean);
  g.translate(0, -HIP_Y);
  // 脖子
  const nw = fem ? 0.016 : 0.019;
  g.beginPath();
  g.moveTo(-nw + v * 0.006, NECK_Y - 0.04);
  g.lineTo(nw + v * 0.006, NECK_Y - 0.04);
  g.lineTo(nw + 0.004 + v * 0.004, NECK_Y + 0.03);
  g.lineTo(-nw - 0.004 + v * 0.004, NECK_Y + 0.03);
  g.closePath();
  g.fillStyle = lin(g, 0, NECK_Y - 0.04, 0, NECK_Y + 0.02, [[0, mix(look.skin, look.skinShade, 0.75)], [0.5, mix(look.skin, look.skinShade, 0.35)], [1, mix(look.skin, look.skinShade, 0.15)]]);
  g.fill();
  // 下巴投在脖子上的阴影（裁在脖子里）
  g.save();
  g.clip();
  g.fillStyle = rad(g, v * 0.008, HEAD_CY + 0.056, 0, 0.03, [[0, rgba(look.skinShade, 0.55)], [0.6, rgba(look.skinShade, 0.3)], [1, rgba(look.skinShade, 0)]]);
  g.fillRect(-0.05, HEAD_CY + 0.03, 0.1, 0.06);
  g.restore();
  torsoPath(g, T);
  g.fillStyle = lin(g, -T.sw, SH_Y, T.sw, HIP_Y, L.dirX < 0
    ? [[0, L.hi(look.cloth)], [0.25, L.lit(look.cloth)], [0.6, look.cloth], [1, L.lo(look.cloth)]]
    : [[0, L.lo(look.cloth)], [0.4, look.cloth], [0.75, L.lit(look.cloth)], [1, L.hi(look.cloth)]]);
  g.fill();
  if (detail) {
    g.save();
    torsoPath(g, T);
    g.clip();
    torsoFolds(g, T, look, L);
    g.restore();
  }
  // 头
  g.save();
  g.translate(pose.head * 0.04 + v * 0.006, HEAD_CY);
  g.rotate(pose.head * f);
  // 正面时两侧的耳朵（画在头后面，只露出外缘）
  if (av <= 0.3 && look.hairStyle !== 1) {
    for (const sd of [-1, 1]) {
      g.beginPath();
      g.ellipse(sd * HEAD_RX * 0.97, 0.009, 0.0075, 0.0125, sd * 0.15, 0, TAU);
      g.fillStyle = mix(look.skin, look.skinShade, sd === (L.dirX || 1) ? 0.15 : 0.45);
      g.fill();
    }
  }
  headPath(g, v);
  g.fillStyle = rad(g, L.dirX * 0.018, -0.016, 0.004, 0.074, [[0, lighten(mix(look.skin, L.key, 0.1), 0.05)], [0.6, look.skin], [1, mix(look.skin, look.skinShade, 0.55)]]);
  g.fill();
  // 耳朵（侧面）：在后脑一侧，越侧越靠近头的中线；长发盖住耳朵
  if (av > 0.3 && look.hairStyle !== 1) {
    const ex = -Math.sign(v) * HEAD_RX * (1.02 - 0.78 * av);
    g.beginPath();
    g.ellipse(ex, 0.008, 0.0075, 0.0125, 0, 0, TAU);
    g.fillStyle = mix(look.skin, look.skinShade, 0.3);
    g.fill();
  }
  if (detail) drawFace(g, look, v, pose.mouth, L, fine);
  drawHairFront(g, look, v, L, detail);
  g.restore();
  g.restore();

  // 近侧手臂
  drawLimb(g, armNear, armR, look.cloth, L);
  const handAng = Math.atan2(armNear[4] - armNear[2], armNear[5] - armNear[3]);
  drawHand(g, armNear[4], armNear[5], handAng, look.skin, L, 0.06, pose.holdKettle ? 0.4 : 0, detail);
  if (pose.holdKettle) drawKettle(g, armNear[4] + Math.sin(handAng) * 0.05, armNear[5] + Math.cos(handAng) * 0.05, f, pose.pour, look, L);
  g.restore();
}

/**
 * 在当前变换（人物空间：脚底原点、身高 1）下画一个有体积和轮廓光的人物，并在地面投下影子。
 * @returns {boolean} 是否画了
 */
export function drawLitFigure(g, pose, look, e, opts = {}) {
  const activePose = pose || (opts && opts.pose);
  const canvas = g.canvas;
  if (!activePose || !canvas || typeof g.getTransform !== 'function') return false;
  const W = canvas.width;
  const Hc = canvas.height;
  const T = g.getTransform();
  const L = buildLight(e, look);
  // 人物空间包围盒 → 像素
  const bx0 = -0.62;
  const bx1 = 0.62;
  const by0 = -1.28;
  const by1 = 0.06;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]]) {
    const px = T.a * x + T.c * y + T.e;
    const py = T.b * x + T.d * y + T.f;
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  const pad = 4;
  const x0 = Math.max(-pad, Math.floor(minX));
  const y0 = Math.max(-pad, Math.floor(minY));
  const x1 = Math.min(W + pad, Math.ceil(maxX));
  const y1 = Math.min(Hc + pad, Math.ceil(maxY));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 2 || bh < 2) return false;
  const heightPx = Math.hypot(T.c, T.d);
  const detail = heightPx * 0.13 > 26;
  // 脸足够大（约 60px 以上）时才画眼白、虹膜等细节，否则简化
  const fine = heightPx * 0.13 > 60;
  const lk = look.skinShade ? look : { ...look, skinShade: skinShadeOf(look.skin) };

  const F = scratch('fig', bw, bh);
  const fg = F.ctx;
  fg.setTransform(T.a, T.b, T.c, T.d, T.e - x0, T.f - y0);
  paintFigure(fg, activePose, lk, L, detail, fine);

  // ---- 像素空间整体光影 ----
  fg.save();
  fg.globalCompositeOperation = 'source-atop';
  // 背光侧整体压暗（形体的大明暗面）；暗面偏暖一些，皮肤不发青
  fg.setTransform(T.a, T.b, T.c, T.d, T.e - x0, T.f - y0);
  if (L.dirX) {
    const side = mix(look.shadowTint, '#3a2420', 0.35);
    fg.fillStyle = lin(fg, L.dirX * 0.16, 0, -L.dirX * 0.16, 0, [[0, 'rgba(0,0,0,0)'], [0.55, rgba(side, 0.06)], [1, rgba(side, 0.26)]]);
    fg.fillRect(-1, -1.5, 2, 1.7);
  }
  // 脚部环境光遮蔽 + 上身更亮
  fg.fillStyle = lin(fg, 0, -1, 0, 0.02, [[0, rgba('#ffffff', 0.03)], [0.55, 'rgba(0,0,0,0)'], [0.86, rgba(look.shadowTint, 0.16)], [1, rgba(look.shadowTint, 0.42)]]);
  fg.fillRect(-1, -1.5, 2, 1.7);
  // 逆光：主体整体沉成剪影
  if (look.silhouette > 0) {
    fg.fillStyle = rgba(darken(look.shadowTint, 0.35), look.silhouette);
    fg.fillRect(-1, -1.5, 2, 1.7);
  }
  // 环境色
  fg.fillStyle = rgba(look.ambient, 0.1);
  fg.fillRect(-1, -1.5, 2, 1.7);
  fg.restore();

  // ---- 边缘光：遮罩减去朝暗侧错位的自身 ----
  const rimPx = Math.min(look.silhouette > 0 ? 5 : 3.2, Math.max(1.2, heightPx * (look.silhouette > 0 ? 0.006 : 0.0042)));
  const sides = look.silhouette > 0 ? [-1, 1] : L.dirX ? [L.dirX] : [];
  if (sides.length) {
    const R = scratch('figrim', bw, bh);
    const rg = R.ctx;
    for (const sd of sides) {
      rg.setTransform(1, 0, 0, 1, 0, 0);
      rg.globalCompositeOperation = 'source-over';
      rg.clearRect(0, 0, bw, bh);
      rg.drawImage(F.canvas, 0, 0);
      rg.globalCompositeOperation = 'source-in';
      rg.fillStyle = lighten(L.key, 0.35);
      rg.fillRect(0, 0, bw, bh);
      rg.globalCompositeOperation = 'destination-out';
      rg.drawImage(F.canvas, -sd * rimPx, rimPx * 0.6);
      fg.save();
      fg.setTransform(1, 0, 0, 1, 0, 0);
      fg.globalCompositeOperation = 'source-atop';
      fg.globalAlpha = look.silhouette > 0 ? 0.95 : 0.6;
      fg.drawImage(R.canvas, 0, 0);
      fg.restore();
    }
  }

  // ---- 投影 + 贴回 ----
  const footX = T.e;
  const footY = T.f;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (opts.castShadow !== false) {
    const S = scratch('figsh', bw, bh);
    S.ctx.drawImage(F.canvas, 0, 0);
    S.ctx.globalCompositeOperation = 'source-in';
    S.ctx.fillStyle = look.castColor;
    S.ctx.fillRect(0, 0, bw, bh);
    S.ctx.globalCompositeOperation = 'source-over';
    let skew = 0;
    let squash = 0.2;
    if (e.back) { squash = -0.34; skew = 0; } else if (e.keyX) { skew = e.keyX * 1.25; squash = 0.16; } else { squash = 0.24; skew = 0.25; }
    g.translate(footX, footY);
    g.transform(1, 0, skew, squash, 0, 0);
    g.globalAlpha = (opts.shadowAlpha ?? 0.42) * (opts.shadowLift ?? 1);
    if ('filter' in g) g.filter = `blur(${Math.max(1, heightPx * 0.012).toFixed(1)}px)`;
    g.drawImage(S.canvas, x0 - footX, y0 - footY);
    g.filter = 'none';
    g.globalAlpha = 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  if (opts.blur > 0.6 && 'filter' in g) g.filter = `blur(${opts.blur.toFixed(1)}px)`;
  g.drawImage(F.canvas, x0, y0);
  g.restore();
  return true;
}
