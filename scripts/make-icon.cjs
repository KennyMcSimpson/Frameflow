// 把 build/icon.svg 渲染为 build/icon.png（512）与 build/icon.ico（多尺寸 PNG 内嵌）。
// 用法一（完整重画）：node_modules\.bin\electron.cmd scripts/make-icon.cjs
// 用法二（不启动 Electron，只补齐尺寸）：node scripts/make-icon.cjs
//   读取现有 build/icon.ico，缺少的尺寸用 vendor/ffmpeg 从 build/icon.png 按预乘透明度缩小生成，其余尺寸原样保留。
// 尺寸覆盖 Windows 各缩放比例下的小图标、任务栏、开始菜单与资源管理器大图标。
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

function readIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('不是 ICO 文件');
  const n = buf.readUInt16LE(4);
  const list = [];
  for (let i = 0; i < n; i += 1) {
    const o = 6 + i * 16;
    const size = buf.readUInt8(o) || 256;
    const len = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    list.push({ size, buf: buf.subarray(off, off + len) });
  }
  return list;
}

function resolveFfmpeg() {
  const vendor = path.join(root, 'vendor', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(vendor)) return vendor;
  try {
    const staticBin = require('ffmpeg-static');
    if (staticBin && fs.existsSync(staticBin)) return staticBin;
  } catch { /* fall through */ }
  throw new Error('缺少 ffmpeg：未找到 vendor/ffmpeg/bin 下的 ffmpeg，且无法回退到 ffmpeg-static（请先运行 npm run fetch:ffmpeg 或 npm install）');
}

function scalePng(src, size) {
  const { spawnSync } = require('node:child_process');
  const ffmpeg = resolveFfmpeg();
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', src, '-vf', `format=rgba,premultiply=inplace=1,scale=${size}:${size}:flags=lanczos,unpremultiply=inplace=1`,
    '-frames:v', '1', '-c:v', 'png', '-pix_fmt', 'rgba', '-f', 'image2pipe', '-'], { maxBuffer: 16 * 1048576, windowsHide: true });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) throw new Error(`缩放 ${size}px 失败：${String(r.stderr || r.error || '').trim()}`);
  return r.stdout;
}

function addMissingSizes() {
  const icoPath = path.join(root, 'build', 'icon.ico');
  const have = readIco(fs.readFileSync(icoPath));
  const bySize = new Map(have.map((e) => [e.size, e.buf]));
  const added = [];
  for (const s of SIZES) {
    if (!bySize.has(s)) {
      bySize.set(s, scalePng(path.join(root, 'build', 'icon.png'), s));
      added.push(s);
    }
  }
  const pngs = [...bySize.entries()].sort((a, b) => a[0] - b[0]).map(([size, buf]) => ({ size, buf }));
  fs.writeFileSync(icoPath, ico(pngs));
  console.log(added.length ? `已补齐尺寸：${added.join('、')}；现有 ${pngs.map((p) => p.size).join('、')}` : '尺寸已齐全，未改动');
}

async function render(win, size) {
  const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
  const html = `<html><body style="margin:0;background:transparent"><img id="i" width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((r,j)=>{const i=document.getElementById('i');const go=()=>{if(!i.naturalWidth)return j(new Error('SVG 渲染失败（${size}px）'));const c=document.createElement('canvas');c.width=c.height=${size};const x=c.getContext('2d');x.drawImage(i,0,0,${size},${size});r(c.toDataURL('image/png'))};i.onerror=()=>j(new Error('SVG 加载失败（${size}px）'));if(i.complete)go();else i.onload=go;})`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

function ico(pngs) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, buf }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3); dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(buf.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.buf)]);
}

if (require.main !== module) {
  // 被测试引用时只导出工具函数
} else if (!process.versions.electron) {
  addMissingSizes();
} else {
  const { app, BrowserWindow } = require('electron');
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 600, height: 600, transparent: true, webPreferences: { offscreen: true } });
    try {
      const big = await render(win, 512);
      fs.writeFileSync(path.join(root, 'build', 'icon.png'), big);
      const pngs = [];
      for (const s of SIZES) pngs.push({ size: s, buf: await render(win, s) });
      fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(pngs));
      console.log('icon ok');
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
    app.quit();
  }).catch((e) => {
    console.error('[make-icon] 失败：', e && e.stack ? e.stack : e);
    app.exit(1);
  });
}

module.exports = { readIco, ico, SIZES };
