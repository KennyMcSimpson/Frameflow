#!/usr/bin/env node
// 下载示例项目「晨光咖啡」的真人实拍素材到 build/sample-media/（PLAN-v3 §7）。
// 用法：node scripts/fetch-sample-media.mjs [--force]
//   设置环境变量 PEXELS_API_KEY 时优先从 Pexels（Pexels License）按关键词搜索；
//   否则 / 失败时使用 Mixkit 公开直链（Mixkit Free License，可商用、免署名），逐条校验许可不是 Restricted。
// 每段用 ffmpeg 裁成 5 秒左右、1280x720、H.264、去音轨，总大小 ≤40MB，并写 manifest.json 与 docs/licenses/sample-media.md。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'sample-media');
const LICENSE_DOC = path.join(ROOT, 'docs', 'licenses', 'sample-media.md');
const MAX_TOTAL = 40 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 Frameflow-sample-fetch';
const force = process.argv.includes('--force');
// --only=shot02-enter.mp4[,…]：仅重新下载指定文件，其余条目保留 manifest 原记录
const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const only = onlyArg ? new Set(onlyArg.split(',')) : null;

// shotIndex 对应 src/engine/sample.js 中的 7 个分镜（1 起）；shotIndex=null 为备用 B-roll
const PLAN = [
  { shotIndex: 1, file: 'shot01-storefront.mp4', pexels: 'coffee shop storefront morning', mixkit: 'a-calm-street-in-paris-4348', seek: 1, dur: 4.5 },
  { shotIndex: 2, file: 'shot02-enter.mp4', pexels: 'customers walking into cafe', mixkit: 'two-girls-chatting-at-the-counter-of-a-coffee-shop-41222', seek: 1, dur: 4 }, // R2#2：原 4385 俯拍餐厅过曝，换为柜台点单（顾客进店）,
  { shotIndex: 3, file: 'shot03-grind.mp4', pexels: 'ground coffee close up', mixkit: 'coffee-powder-being-poured-on-the-coffee-maker-filter-4984', seek: 0.5, dur: 4 },
  { shotIndex: 4, file: 'shot04-latte-art.mp4', pexels: 'latte art barista', mixkit: 'latte-art-810', seek: 1, dur: 5 },
  { shotIndex: 5, file: 'shot05-first-sip.mp4', pexels: 'woman drinking coffee smiling cafe', mixkit: 'woman-sips-from-a-coffee-cup-46568', seek: 0.5, dur: 4 },
  { shotIndex: 6, file: 'shot06-window.mp4', pexels: 'reading book cafe window', mixkit: 'writing-on-a-notebook-at-a-coffee-shop-1741', seek: 1, dur: 5 },
  { shotIndex: 7, file: 'shot07-ending.mp4', pexels: 'cappuccino served cup', mixkit: 'serving-a-sparkling-cappuccino-in-a-cup-41859', seek: 0.5, dur: 4.5 },
  { shotIndex: null, file: 'broll-milk-froth.mp4', pexels: 'barista frothing milk', mixkit: 'frothing-milk-seen-in-detail-3576', seek: 1, dur: 5 },
];

function ffmpegPath() {
  try { return createRequire(import.meta.url)('ffmpeg-static'); } catch { return 'ffmpeg'; }
}

async function getText(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

async function download(url, dest) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

async function fromPexels(item, key, usedIds) {
  const q = new URLSearchParams({ query: item.pexels, orientation: 'landscape', size: 'medium', per_page: '15' });
  const data = JSON.parse(await getText(`https://api.pexels.com/videos/search?${q}`, { Authorization: key }));
  const v = (data.videos || []).find((x) => !usedIds.has(x.id) && x.duration >= item.dur);
  if (!v) throw new Error('Pexels 无合适结果');
  const f = (v.video_files || []).filter((x) => x.width >= 1280 && x.file_type === 'video/mp4').sort((a, b) => a.width - b.width)[0];
  if (!f) throw new Error('Pexels 无 720p 文件');
  usedIds.add(v.id);
  return {
    src: f.link,
    url: v.url,
    credit: `${v.user && v.user.name ? v.user.name : 'Pexels 摄影师'} / Pexels`,
    license: 'Pexels License（可免费商用，无需署名；https://www.pexels.com/license/）',
    provider: 'pexels',
    id: String(v.id),
  };
}

async function fromMixkit(item) {
  const page = `https://mixkit.co/free-stock-video/${item.mixkit}/`;
  const html = await getText(page);
  if (/videoRestricted|Restricted License/i.test(html) && !/#videoFree/.test(html)) throw new Error(`Mixkit 条目为 Restricted 许可：${item.mixkit}`);
  const id = item.mixkit.match(/(\d+)$/)[1];
  const slug = item.mixkit.replace(/-\d+$/, '').replace(/-/g, ' ');
  const name = slug.charAt(0).toUpperCase() + slug.slice(1);
  return {
    src: `https://assets.mixkit.co/videos/${id}/${id}-720.mp4`,
    url: page,
    credit: `Mixkit · ${name}`,
    license: 'Mixkit Free License（可免费商用，无需署名；https://mixkit.co/license/#videoFree）',
    provider: 'mixkit',
    id,
  };
}

function transcode(input, output, { seek, dur }) {
  const args = ['-y', '-loglevel', 'error', '-ss', String(seek), '-i', input, '-t', String(dur), '-an',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=25,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-maxrate', '3M', '-bufsize', '6M', '-movflags', '+faststart', output];
  const r = spawnSync(ffmpegPath(), args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 失败：${r.stderr || r.error}`);
}

function writeLicenseDoc(entries) {
  const rows = entries.map((e) => `| ${e.file} | ${e.shotIndex == null ? '备用' : `第 ${e.shotIndex} 镜`} | ${e.credit} | ${e.url} | ${e.license} |`).join('\n');
  const md = `# 示例项目实拍素材许可

示例项目「晨光咖啡」使用的视频片段位于 \`build/sample-media/\`，随安装包放在 \`resources/sample-media/\`。
全部为真人实拍素材，由 \`scripts/fetch-sample-media.mjs\` 下载并裁剪为约 4–5 秒、1280×720、H.264、无音轨。

- Pexels License：https://www.pexels.com/license/ —— 可免费用于商业与非商业用途，无需署名（我们仍保留摄影师署名）；不得原样转售、不得暗示被摄人物/品牌背书。
- Mixkit Free License：https://mixkit.co/license/#videoFree —— 可免费用于商业与个人项目，无需署名；不得将素材单独再分发/转售。脚本会拒绝 Restricted License 条目。

| 文件 | 用途 | 署名 | 来源页 | 许可 |
| --- | --- | --- | --- | --- |
${rows}

更新素材：\`node scripts/fetch-sample-media.mjs --force\`（可设置 \`PEXELS_API_KEY\` 优先使用 Pexels）。
`;
  fs.mkdirSync(path.dirname(LICENSE_DOC), { recursive: true });
  fs.writeFileSync(LICENSE_DOC, md, 'utf8');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sample-'));
  const key = process.env.PEXELS_API_KEY || '';
  const usedIds = new Set();
  const entries = [];
  let total = 0;
  const prev = only && fs.existsSync(path.join(OUT, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')) : [];
  for (const item of PLAN) {
    const dest = path.join(OUT, item.file);
    const old = prev.find((e) => e.file === item.file);
    if (only && !only.has(item.file) && old && fs.existsSync(dest)) { total += fs.statSync(dest).size; entries.push(old); continue; }
    let meta = null;
    const tries = key ? [() => fromPexels(item, key, usedIds), () => fromMixkit(item)] : [() => fromMixkit(item)];
    for (const t of tries) {
      try { meta = await t(); break; } catch (e) { console.warn(`  [${item.file}] ${e.message}`); }
    }
    if (!meta) { console.warn(`跳过 ${item.file}`); continue; }
    if (force || (only && only.has(item.file)) || !fs.existsSync(dest)) {
      const raw = path.join(tmp, `${meta.provider}-${meta.id}.mp4`);
      console.log(`下载 ${item.file} ← ${meta.src}`);
      try {
        await download(meta.src, raw);
        transcode(raw, dest, item);
      } catch (e) { console.warn(`跳过 ${item.file}：${e.message}`); continue; }
    }
    const size = fs.statSync(dest).size;
    if (total + size > MAX_TOTAL) { fs.rmSync(dest); console.warn(`超出 40MB 上限，舍弃 ${item.file}`); continue; }
    total += size;
    entries.push({ file: item.file, shotIndex: item.shotIndex, duration: item.dur, width: 1280, height: 720, credit: meta.credit, url: meta.url, license: meta.license, provider: meta.provider });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!entries.length) throw new Error('没有下载到任何素材，请检查网络');
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(entries, null, 2) + '\n', 'utf8');
  if (!only) writeLicenseDoc(entries); else console.log('（--only 模式未改写 docs/licenses/sample-media.md，如需请全量运行）');
  console.log(`完成：${entries.length} 段，共 ${(total / 1048576).toFixed(1)} MB → ${OUT}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
