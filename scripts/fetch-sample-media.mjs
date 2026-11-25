#!/usr/bin/env node
// 下载示例项目「晨光咖啡」的真人实拍素材到 build/sample-media/（PLAN-v3 §7）。
// 用法：node scripts/fetch-sample-media.mjs [--force] [--only=shot02-enter.mp4[,…]]
//   设置环境变量 PEXELS_API_KEY 时优先从 Pexels（Pexels License）按关键词搜索；
//   否则 / 失败时使用 Mixkit 公开直链（Mixkit Free License，可商用、免署名），严格校验 Free License 且非 Restricted。
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

// shotIndex 对应 src/engine/sample.js 中的 7 个分镜（1 起）；shotIndex=null 为备用 B-roll
export const PLAN = [
  { shotIndex: 1, file: 'shot01-storefront.mp4', pexels: 'coffee shop storefront morning', mixkit: 'a-calm-street-in-paris-4348', seek: 1, dur: 4.5 },
  { shotIndex: 2, file: 'shot02-enter.mp4', pexels: 'customers walking into cafe', mixkit: 'two-girls-chatting-at-the-counter-of-a-coffee-shop-41222', seek: 1, dur: 4 }, // R2#2：原 4385 俯拍餐厅过曝，换为柜台点单（顾客进店）
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

// 严格判定 Mixkit 页面确为 Free License（禁止出现 Restricted 标记，且必须显式声明 Free License）
export function isMixkitFreeLicenseHtml(html) {
  const s = String(html || '');
  if (/#videoRestricted\b|videoRestricted|Restricted\s+License/i.test(s)) return false;
  return /\/license\/#videoFree\b|Mixkit\s+(?:Stock\s+Video\s+)?Free\s+License/i.test(s);
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.tmp`;
  fs.writeFileSync(tmpFile, content, 'utf8');
  fs.renameSync(tmpFile, filePath);
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
  if (!isMixkitFreeLicenseHtml(html)) {
    throw new Error(`Mixkit 条目未通过 Free License 校验（可能为 Restricted 或页面异常）：${item.mixkit}`);
  }
  const idMatch = item.mixkit.match(/(\d+)$/);
  if (!idMatch) throw new Error(`Mixkit 条目缺少数字 ID：${item.mixkit}`);
  const id = idMatch[1];
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
  const r = spawnSync(ffmpegPath(), args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1048576 });
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
  writeFileAtomic(LICENSE_DOC, md);
}

async function main() {
  const force = process.argv.includes('--force');
  // --only=shot02-enter.mp4[,…]：仅重新下载指定文件，其余条目保留 manifest 原记录
  const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
  const only = onlyArg ? new Set(onlyArg.split(',').filter(Boolean)) : null;

  fs.mkdirSync(OUT, { recursive: true });
  const manifestPath = path.join(OUT, 'manifest.json');
  let prev = [];
  if (fs.existsSync(manifestPath)) {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (Array.isArray(parsed)) prev = parsed;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sample-'));
  const pendingMoves = [];
  const key = process.env.PEXELS_API_KEY || '';
  const usedIds = new Set();
  const entries = [];
  const failures = [];
  let total = 0;
  let downloadedAny = false;

  try {
    for (const item of PLAN) {
      const dest = path.join(OUT, item.file);
      const old = prev.find((e) => e.file === item.file);
      const wantDownload = force || (only ? only.has(item.file) : !(fs.existsSync(dest) && old));

      if (!wantDownload) {
        if (!fs.existsSync(dest) || !old) {
          failures.push(`${item.file}：--only 模式下缺少现有文件或 manifest 署名记录`);
          continue;
        }
        const size = fs.statSync(dest).size;
        if (total + size > MAX_TOTAL) {
          failures.push(`${item.file}：累计体积超出 ${(MAX_TOTAL / 1048576).toFixed(0)}MB 上限`);
          continue;
        }
        total += size;
        entries.push(old);
        continue;
      }

      let meta = null;
      const errors = [];
      const tries = key ? [() => fromPexels(item, key, usedIds), () => fromMixkit(item)] : [() => fromMixkit(item)];
      for (const t of tries) {
        try { meta = await t(); break; } catch (e) {
          errors.push(e.message || String(e));
          console.warn(`  [${item.file}] ${e.message}`);
        }
      }
      if (!meta) {
        failures.push(`${item.file}：元数据获取失败（${errors.join('；')}）`);
        continue;
      }

      const raw = path.join(tmp, `${meta.provider}-${meta.id}.mp4`);
      const stagedOut = path.join(OUT, `${item.file}.tmp`);
      console.log(`下载 ${item.file} ← ${meta.src}`);
      try {
        await download(meta.src, raw);
        transcode(raw, stagedOut, item);
        const size = fs.statSync(stagedOut).size;
        if (total + size > MAX_TOTAL) {
          fs.rmSync(stagedOut, { force: true });
          failures.push(`${item.file}：累计体积超出 ${(MAX_TOTAL / 1048576).toFixed(0)}MB 上限`);
          continue;
        }
        total += size;
        pendingMoves.push({ from: stagedOut, to: dest });
        downloadedAny = true;
        entries.push({
          file: item.file,
          shotIndex: item.shotIndex,
          duration: item.dur,
          width: 1280,
          height: 720,
          credit: meta.credit,
          url: meta.url,
          license: meta.license,
          provider: meta.provider,
        });
      } catch (e) {
        fs.rmSync(stagedOut, { force: true });
        failures.push(`${item.file}：${e.message || e}`);
      }
    }

    if (failures.length || entries.length !== PLAN.length) {
      throw new Error(`素材未完整获取（成功 ${entries.length}/${PLAN.length}），已中止且未改写 manifest.json：\n  - ${failures.join('\n  - ')}`);
    }

    for (const move of pendingMoves) {
      fs.renameSync(move.from, move.to);
    }

    if (!downloadedAny) {
      console.log(`全部 ${entries.length} 段素材已存在且署名完整，未改写 manifest.json 与 docs/licenses/sample-media.md（如需重下请加 --force）`);
      return;
    }

    writeFileAtomic(manifestPath, JSON.stringify(entries, null, 2) + '\n');
    if (!only) writeLicenseDoc(entries);
    else console.log('（--only 模式未改写 docs/licenses/sample-media.md，如需请全量运行）');
    console.log(`完成：${entries.length} 段，共 ${(total / 1048576).toFixed(1)} MB → ${OUT}`);
  } finally {
    for (const move of pendingMoves) {
      if (fs.existsSync(move.from)) fs.rmSync(move.from, { force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
