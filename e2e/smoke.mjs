// 端到端冒烟测试：启动真实 Electron 应用，走三大流程 + 精修关键操作，截图到 e2e/shots/。
// 用法：npm run e2e   （或 node e2e/smoke.mjs，需要先 vite build）  --quick 只跑前两步
// 默认 FF_E2E_SHOW=1：窗口以 showInactive 显示（不抢焦点），配合 paintWhenInitiallyHidden + invalidate 保证每张截图都有新帧。
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
for (const f of fs.readdirSync(SHOTS)) if (/\.png$/i.test(f)) { try { fs.unlinkSync(path.join(SHOTS, f)); } catch {} }

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-ud-'));
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-data-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ dataRoot, ui: { onboarded: true } }));

const errors = [];   // 硬错误：会让退出码为 1
const warnings = []; // 软检查点未通过（UI 改版中选择器可能变化）
const results = [];  // 检查点结果
const log = (...a) => console.log('[e2e]', ...a);
const step = process.argv.includes('--quick') ? 'quick' : 'full';
const SHOW = process.env.FF_E2E_SHOW == null ? '1' : process.env.FF_E2E_SHOW;

const app = await electron.launch({
  executablePath: require('electron'),
  args: [ROOT],
  cwd: ROOT,
  env: { ...process.env, FF_E2E: '1', FF_E2E_SHOW: SHOW, FF_USER_DATA: userData },
  timeout: 60000,
});
const IGNORE_MAIN = /DevTools|Autofill|GPU process|gpu_init|cache_util|disk_cache/i;
app.process().stdout.on('data', (d) => {
  const s = String(d);
  if (/error|失败|Error/i.test(s) && !IGNORE_MAIN.test(s)) errors.push('[main] ' + s.trim().slice(0, 500));
  process.stdout.write('[main] ' + s);
});
app.process().stderr.on('data', (d) => process.stderr.write('[main:err] ' + String(d)));

const win = await app.firstWindow();
await win.setViewportSize({ width: 1600, height: 960 }).catch(() => {});
win.on('console', (m) => { if (m.type() === 'error') errors.push('[renderer] ' + m.text().slice(0, 500)); });
win.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

async function repaint() {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed()) w.webContents.invalidate();
  }).catch(() => {});
}

async function shot(name) {
  await win.waitForTimeout(350);
  await repaint();
  await win.waitForTimeout(50);
  const file = path.join(SHOTS, `${name}.png`);
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      await win.screenshot({ path: file, timeout: 15000, animations: 'disabled' });
      log('截图', file);
      return file;
    } catch (e) {
      lastErr = e;
      await repaint();
      await win.waitForTimeout(300);
    }
  }
  // 兜底：主进程 capturePage
  try {
    const b64 = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.webContents.invalidate();
      const img = await w.webContents.capturePage();
      return img.toPNG().toString('base64');
    });
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    warnings.push(`截图 ${name} 走了 capturePage 兜底（${lastErr && lastErr.message.split('\n')[0]}）`);
    log('截图(兜底)', file);
    return file;
  } catch (e) {
    errors.push(`[shot ${name}] ${lastErr && lastErr.message.split('\n')[0]}`);
    return null;
  }
}

async function firstVisible(locators, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const l of locators) {
      const loc = l.first();
      try { if (await loc.count() && await loc.isVisible()) return loc; } catch {}
    }
    await win.waitForTimeout(200);
  }
  return null;
}
const byText = (t, exact = true) => win.getByText(t, { exact });
const byRole = (role, name, exact = false) => win.getByRole(role, { name, exact });
const byLabel = (l) => win.locator(`[aria-label="${l}"]`);

async function clickAny(locators, timeout) {
  const loc = await firstVisible(locators, timeout);
  if (!loc) return false;
  await loc.click();
  return true;
}

/** 检查点：核心检查点（01–09）失败记入 errors 触发非零退出；soft: true 时仅记 warning */
async function check(name, fn, { soft = false } = {}) {
  const t0 = Date.now();
  try {
    const r = await fn();
    results.push({ name, ok: r !== false, ms: Date.now() - t0 });
    if (r === false) {
      const msg = `检查点未通过：${name}`;
      if (soft) warnings.push(msg); else errors.push(msg);
    }
  } catch (e) {
    const detail = e.message.split('\n')[0];
    results.push({ name, ok: false, ms: Date.now() - t0, error: detail });
    const msg = `检查点异常：${name}：${detail}`;
    if (soft) warnings.push(msg); else errors.push(msg);
  }
}

async function closeOverlays() {
  for (let i = 0; i < 2; i++) { await win.keyboard.press('Escape').catch(() => {}); await win.waitForTimeout(150); }
}

try {
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(2500);
  await check('01 启动页', async () => !!(await shot('01-start')));

  await check('02 打开示例项目（创作）', async () => {
    const ok = await clickAny([byText('咖啡店', false), win.locator('[data-sample]'), win.locator('.sp-sample, .start-sample')], 15000);
    if (!ok) throw new Error('找不到示例项目入口');
    await win.waitForTimeout(600);
    // 提示框出现期间：不能遮住右下「下一步：进入剪辑」主按钮；创作页只保留一个「进入剪辑」入口
    const layout = await win.evaluate(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      const btn = document.querySelector('[data-testid="go-edit"]');
      const toasts = [...document.querySelectorAll('.toast')].map(rect);
      const entries = [...document.querySelectorAll('button')].filter((b) => b.offsetParent && /进入剪辑/.test(b.textContent || '')).length;
      const b = btn ? rect(btn) : null;
      const hit = b ? toasts.some((t) => t.x < b.x + b.w && b.x < t.x + t.w && t.y < b.y + b.h && b.y < t.y + t.h) : null;
      const top = b ? document.elementFromPoint(b.x + b.w / 2, b.y + b.h / 2) : null;
      return { btn: b, toasts, entries, hit, topIsBtn: !!(top && btn && btn.contains(top)) };
    });
    log('进入剪辑入口', JSON.stringify(layout));
    await shot('02-create');
    await win.waitForTimeout(2400);
    if (!layout.btn) throw new Error('没有「下一步：进入剪辑」按钮');
    if (layout.hit || !layout.topIsBtn) throw new Error('提示框遮住了「进入剪辑」按钮');
    if (layout.entries !== 1) throw new Error(`「进入剪辑」入口数 ${layout.entries}（应为 1）`);
    return true;
  });

  await check('02b 示例项目实拍缩略图', async () => {
    const info = await win.evaluate(() => {
      const imgs = [...document.querySelectorAll('img, video')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 40 && r.height > 24 && /^ffmedia:|^file:|\.(jpe?g|png|webp|mp4)/i.test(el.currentSrc || el.src || '');
      });
      const loaded = imgs.filter((el) => (el.tagName === 'IMG' ? el.complete && el.naturalWidth > 0 : el.readyState >= 2));
      return { total: imgs.length, loaded: loaded.length };
    });
    log('缩略图', JSON.stringify(info));
    await shot('02b-create-thumbs');
    return info.loaded > 0;
  });

  if (step === 'full') {
    await check('03 精修四区', async () => {
      // 真机点击「下一步：进入剪辑」（不走顶部模式切换）
      const go = await firstVisible([win.locator('[data-testid="go-edit"]')], 8000);
      if (!go) throw new Error('找不到「下一步：进入剪辑」按钮');
      await go.click();
      let entered = false;
      for (let i = 0; i < 40 && !entered; i++) {
        await win.waitForTimeout(500);
        entered = (await win.locator('[data-lane="video"] [data-clip-id]').count()) > 0;
        if (!entered) { const ok = await firstVisible([win.getByRole('button', { name: /覆盖|继续|确定|重新生成/ })], 300); if (ok) await ok.click().catch(() => {}); }
      }
      if (!entered) throw new Error('点击「进入剪辑」后没有进入精修时间线');
      log('点击「进入剪辑」→ 已进入精修');
      await win.waitForTimeout(1500);
      await shot('03-refine');
      const zones = await win.evaluate(() => {
        const q = (s) => !!document.querySelector(s);
        return {
          media: q('.rf-media, [data-zone="media"], .media-panel'),
          preview: q('.rf-preview, [data-zone="preview"], video, canvas'),
          inspector: q('.rf-inspector, [data-zone="inspector"], .inspector'),
          timeline: q('.rf-timeline, [data-zone="timeline"], .timeline, .tl, [data-lane="video"]'),
        };
      });
      log('精修四区', JSON.stringify(zones));
      return zones.preview && zones.timeline;
    });

    await check('04 选中片段属性', async () => {
      const block = await firstVisible([win.locator('[data-lane="video"] [data-clip-id]'), win.locator('[data-clip-id]'), win.locator('.tl-clip')], 6000);
      if (!block) throw new Error('时间线上没有片段');
      await block.click();
      await win.waitForTimeout(600);
      await clickAny([byText('检查器'), byText('属性')], 1500);
      await win.waitForTimeout(400);
      await shot('04-refine-inspector');
      // 关键帧菱形：点一下打帧 → 高亮（.on）且提示改为「删除」；再点一下删除
      const kf = await firstVisible([win.locator('.rf-insp .kf-toggle:not([disabled])')], 3000);
      if (!kf) throw new Error('属性面板没有关键帧按钮');
      const box = await kf.boundingBox();
      const tip0 = await kf.getAttribute('title');
      await kf.click();
      await win.waitForTimeout(500);
      const kf2 = win.locator('.rf-insp .kf-toggle').first();
      const on = await kf2.evaluate((b) => b.classList.contains('on'));
      const tip1 = await kf2.getAttribute('title');
      await kf2.hover().catch(() => {});
      await shot('04b-keyframe-on');
      log('关键帧按钮', JSON.stringify({ size: box && [Math.round(box.width), Math.round(box.height)], tip0, tip1, on }));
      await kf2.click();
      await win.waitForTimeout(300);
      return !!(on && box && box.width >= 24 && /删除/.test(tip1 || '') && /添加/.test(tip0 || ''));
    });

    await check('05 播放', async () => {
      await win.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
      const readPlayhead = () => win.evaluate(() => {
        const timeEl = document.querySelector('.tl-head-time, .pv-time');
        const headEl = document.querySelector('.tl-playhead');
        return {
          text: timeEl ? (timeEl.textContent || '').trim() : '',
          x: headEl ? Math.round(headEl.getBoundingClientRect().x * 10) / 10 : null,
        };
      });
      const before = await readPlayhead();
      await win.keyboard.press('Space');
      await win.waitForTimeout(1500);
      await win.keyboard.press('Space');
      const after = await readPlayhead();
      await shot('05-refine-playing');
      log('播放头', JSON.stringify({ before, after }));
      const textMoved = !!(before.text && after.text && before.text !== after.text);
      const xMoved = before.x != null && after.x != null && after.x > before.x + 1;
      if (!textMoved && !xMoved) throw new Error(`按空格播放后播放头未移动（before=${JSON.stringify(before)}，after=${JSON.stringify(after)}）`);
      return true;
    });

    await check('05b 分割 / 定格 / 倒放', async () => {
      const block = await firstVisible([win.locator('[data-lane="video"] [data-clip-id]'), win.locator('[data-clip-id]')], 3000);
      // 把播放头放到第一个片段中间
      if (block) {
        const bb = await block.boundingBox();
        if (bb) {
          await block.click({ position: { x: Math.max(4, bb.width * 0.5), y: Math.max(4, bb.height * 0.5) } });
          const ruler = win.locator('.tl-ruler').first();
          const rb = (await ruler.count()) ? await ruler.boundingBox() : null;
          if (rb) await win.mouse.click(bb.x + bb.width * 0.5, rb.y + rb.height / 2);
          await win.waitForTimeout(300);
        }
      }
      const countClips = () => win.locator('[data-clip-id]').count();
      const before = await countClips();
      const did = [];
      if (await clickAny([byLabel('分割'), byRole('button', '分割')], 2000)) did.push('分割');
      else { await win.keyboard.press('Control+KeyB'); did.push('分割(快捷键)'); }
      await win.waitForTimeout(500);
      const afterSplit = await countClips();
      await shot('05b-split');
      // 播放头挪到第一个片段内部（分割后正好在切点上），再定格
      {
        const c0 = win.locator('[data-clip-id]').first();
        const cb = (await c0.count()) ? await c0.boundingBox() : null;
        const rb = await win.locator('.tl-ruler').first().boundingBox().catch(() => null);
        if (cb && rb) await win.mouse.click(cb.x + cb.width * 0.4, rb.y + rb.height / 2);
        await win.waitForTimeout(300);
      }
      if (await clickAny([win.locator('[aria-label^="定格"]:not([disabled])')], 2000)) did.push('定格');
      else { await win.locator('[data-clip-id]').first().click({ button: 'right' }).catch(() => {}); await win.waitForTimeout(300); if (await clickAny([win.locator('[role="menuitem"]').filter({ hasText: '定格' })], 1500)) did.push('定格(右键)'); else await closeOverlays(); }
      await win.waitForTimeout(400);
      await win.locator('[data-clip-id]').first().click().catch(() => {});
      await win.waitForTimeout(300);
      await win.waitForTimeout(500);
      if (await clickAny([win.locator('[aria-label^="倒放"]:not([disabled])')], 2000)) did.push('倒放');
      else { await win.locator('[data-clip-id]').first().click({ button: 'right' }).catch(() => {}); await win.waitForTimeout(300); if (await clickAny([win.locator('[role="menuitem"]').filter({ hasText: '倒放' })], 1500)) did.push('倒放(右键)'); else await closeOverlays(); }
      await win.waitForTimeout(500);
      await shot('05c-freeze-reverse');
      log('剪辑操作', did.join('、'), `片段数 ${before} → ${afterSplit} → ${await countClips()}`);
      return afterSplit > before && did.length >= 3;
    });

    /** 预览画布签名：能读像素就读像素，否则对画布截图 */
    async function canvasSig() {
      const px = await win.evaluate(() => {
        const c = document.querySelector('.pv-canvas');
        if (!c) return null;
        try {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          const step = 4 * 7; const out = [];
          for (let i = 0; i < d.length; i += step) out.push(d[i], d[i + 1], d[i + 2]);
          return { w: c.width, h: c.height, px: out };
        } catch { return { tainted: true }; }
      });
      return px;
    }
    function sigDiff(a, b) {
      if (!a || !b || a.tainted || b.tainted || a.px.length !== b.px.length) return -1;
      let n = 0;
      for (let i = 0; i < a.px.length; i += 3) if (Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1]) + Math.abs(a.px[i + 2] - b.px[i + 2]) > 60) n++;
      return n / (a.px.length / 3);
    }

    await check('05d 添加贴纸并在画面上渲染', async () => {
      await closeOverlays();
      // 播放头放到 2 秒（避开片头淡入的黑场）：点时间尺上的 00:02 刻度
      {
        const rb = await win.locator('.tl-ruler').first().boundingBox().catch(() => null);
        const tick = win.locator('.tl-ruler').first().getByText('00:02', { exact: true }).first();
        const tb = (await tick.count()) ? await tick.boundingBox().catch(() => null) : null;
        if (rb && tb) await win.mouse.click(tb.x, rb.y + rb.height / 2);
        else { await win.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur()); await win.keyboard.press('Home'); await win.keyboard.press('Shift+ArrowRight'); await win.keyboard.press('Shift+ArrowRight'); }
      }
      await win.waitForTimeout(1200);
      const before = await canvasSig();
      const ovBefore = await win.locator('[data-ov-id]').count();
      const g = await firstVisible([win.locator('[data-group="text"]'), win.locator('.mpx-rail-btn').filter({ hasText: '文字' })], 4000);
      if (g) { await g.click(); await win.waitForTimeout(250); }
      const sub = await firstVisible([win.locator('[data-sub="sticker"]'), win.getByRole('tab', { name: '贴纸', exact: true })], 3000);
      if (!sub) throw new Error('找不到「贴纸」分类');
      await sub.click();
      await win.waitForTimeout(300);
      const stk = await firstVisible([win.locator('.mpx-sticker').filter({ hasText: '★' }), win.locator('.mpx-sticker')], 3000);
      if (!stk) throw new Error('贴纸面板为空');
      await stk.click();
      await win.waitForTimeout(1500);
      const after = await canvasSig();
      const ovAfter = await win.locator('[data-ov-id]').count();
      const diff = sigDiff(before, after);
      await shot('05d-sticker');
      const pc = win.locator('.pv-canvas').first();
      if (await pc.count()) await pc.screenshot({ path: path.join(SHOTS, '05d-sticker-preview.png') }).catch(() => {});
      log('贴纸', `画中画块 ${ovBefore} → ${ovAfter}，画面变化像素比 ${diff < 0 ? '无法读取' : (diff * 100).toFixed(2) + '%'}`);
      if (diff >= 0 && diff < 0.0005) throw new Error('添加贴纸后预览画面没有变化');
      return ovAfter > ovBefore && (diff < 0 || diff >= 0.0005);
    });

    await check('05e 点选文字轨文字并在属性面板编辑', async () => {
      await closeOverlays();
      const t = await firstVisible([win.locator('[data-lane="text"] .tl-text')], 4000);
      if (!t) throw new Error('文字轨上没有文字');
      await t.click();
      await win.waitForTimeout(600);
      const box = await firstVisible([win.locator('.rf-insp textarea.insp-text'), win.locator('textarea.insp-text')], 4000);
      if (!box) throw new Error('属性面板没有出现文字编辑框');
      const NEW = '烟测改字 OK';
      await box.click();
      await box.fill(NEW);
      await win.keyboard.press('Control+Enter');
      await win.waitForTimeout(700);
      const label = await win.locator('[data-lane="text"] .tl-text').filter({ hasText: NEW }).count();
      await shot('05e-text-edit');
      log('文字编辑', `时间线上显示新文字的片段数 ${label}`);
      return label > 0;
    });

    await check('06 AI 助手抽屉', async () => {
      const ok = await clickAny([byLabel('AI 助手'), byText('AI 助手'), byText('AI 精修')], 4000);
      if (!ok) throw new Error('找不到 AI 助手入口');
      await win.waitForTimeout(500);
      const box = await firstVisible([win.locator('textarea.aie-input:visible'), win.locator('textarea:not(.insp-text):visible')], 3000);
      if (box) {
        await box.fill('整体暖一点，转场都改成叠化');
        await box.press('Enter');
        await win.waitForTimeout(1500);
      }
      await shot('06-refine-ai');
      await closeOverlays();
      return true;
    });

    await check('06b 视频生成（mock）', async () => {
      // 设置 → AI 视频生成
      const opened = await clickAny([byLabel('设置'), byRole('button', '设置')], 3000);
      if (opened) {
        await win.waitForTimeout(800);
        await clickAny([byText('AI 视频生成')], 2000);
        await win.waitForTimeout(500);
        await shot('06b-settings-videogen');
        await closeOverlays();
      }
      // 直接走 IPC 生成一段（mock provider），验证主进程链路
      const r = await win.evaluate(async () => {
        const ff = window.ff;
        if (!ff || !ff.videogen) return { skip: 'preload 未暴露 videogen' };
        let providers = [];
        try { providers = await ff.videogen.providers(); } catch (e) { return { skip: '没有 videogen 模块：' + e.message }; }
        if (!providers.some((p) => p.id === 'mock')) return { skip: '没有 mock provider' };
        const list = await ff.invoke('project:list');
        const projectId = list && list[0] && list[0].id;
        let targetJobId = null;
        const buffered = [];
        let replay = () => {};
        const done = new Promise((resolve) => {
          const offs = [];
          let settled = false;
          let timer = null;
          const fin = (v) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            offs.forEach((f) => f());
            resolve(v);
          };
          const onDone = (d) => {
            if (!d) return;
            if (!targetJobId) { buffered.push({ ev: 'done', d }); return; }
            if (d.jobId !== targetJobId) return;
            fin({ ok: true, kind: d.kind, asset: d.result && d.result.asset ? { name: d.result.asset.name, path: d.result.asset.path, source: d.result.asset.source } : null });
          };
          const onErr = (d) => {
            if (!d) return;
            if (!targetJobId) { buffered.push({ ev: 'error', d }); return; }
            if (d.jobId !== targetJobId) return;
            fin({ ok: false, error: d.error });
          };
          offs.push(ff.on('job:done', onDone));
          offs.push(ff.on('job:error', onErr));
          timer = setTimeout(() => fin({ ok: false, error: 'timeout' }), 60000);
          replay = () => {
            for (const item of buffered) {
              if (item.ev === 'done') onDone(item.d);
              else onErr(item.d);
            }
          };
        });
        const { jobId } = await ff.videogen.generate({ projectId, provider: 'mock', prompt: '清晨咖啡店，咖啡师拉花特写，真人实拍', duration: 4, ratio: '16:9', res: '720p' });
        targetJobId = jobId;
        replay();
        return { jobId, ...(await done) };
      });
      log('videogen mock', JSON.stringify(r));
      if (r.skip) { warnings.push('视频生成跳过：' + r.skip); return true; }
      return !!r.ok;
    });

    await check('07 拆片库', async () => {
      await closeOverlays();
      if (!(await clickAny([byText('拆片库'), byRole('tab', '拆片库')], 15000))) throw new Error('找不到「拆片库」模式');
      await win.waitForTimeout(1500);
      return !!(await shot('07-library'));
    });

    await check('08 设置', async () => {
      if (!(await clickAny([byLabel('设置'), byRole('button', '设置')], 3000))) return false;
      await win.waitForTimeout(1000);
      await shot('08-settings');
      await closeOverlays();
      return true;
    });

    await check('09 导出对话框', async () => {
      await clickAny([byText('精修'), byRole('tab', '精修')], 5000);
      await win.waitForTimeout(800);
      if (!(await clickAny([win.locator('[data-tour="export"]'), byRole('button', '导出', true)], 4000))) throw new Error('找不到导出按钮');
      await win.waitForTimeout(900);
      await shot('09-export');
      await closeOverlays();
      return true;
    });
  }
} catch (e) {
  errors.push('[e2e] ' + e.message);
  await shot('99-failure').catch(() => {});
} finally {
  const state = await win.evaluate(() => {
    const el = document.querySelector('#root');
    return { text: el ? el.innerText.slice(0, 300) : '' };
  }).catch(() => ({}));
  log('页面文字片段：', JSON.stringify(state.text || ''));
  await app.close().catch(() => {});
  fs.writeFileSync(path.join(SHOTS, 'errors.json'), JSON.stringify({ errors, warnings, results }, null, 2));
  console.log('\n[e2e] 检查点：');
  for (const r of results) console.log(`  ${r.ok ? '✔' : '✘'} ${r.name} (${r.ms}ms)${r.error ? ' — ' + r.error : ''}`);
  if (warnings.length) { console.log('\n[e2e] 警告：'); for (const w of warnings) console.log('  - ' + w); }
  if (errors.length) { console.log('\n[e2e] 发现错误：'); for (const e of errors) console.log('  - ' + e); process.exitCode = 1; } else log('无错误');
  try { fs.rmSync(userData, { recursive: true, force: true }); fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {}
}
