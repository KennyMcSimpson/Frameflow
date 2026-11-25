// 素材相关的共享动作：加入项目、放上时间线、拖放。所有模式共用。
import useStore from './store.js';
import { createAudioClip } from '../engine/model.js';
import { applyOps } from '../engine/ops.js';
import { assetRestriction } from '../engine/license.js';
import api from './api.js';

export const DND_ASSET = 'application/x-ff-asset';

// 受限素材提醒：同一个素材一分钟内只提醒一次，避免反复拖放时刷屏
const warnedAt = new Map();

/**
 * 「仅供学习」的视频站素材、禁止商用的素材放上时间线时提醒一次（不阻止，导出时还会再检查）。
 * 返回需要提醒的素材数（便于测试）。
 */
export function warnRestrictedAssets(assets) {
  let hits = [];
  try {
    hits = (assets || [])
      .map((a) => ({ a, r: a ? assetRestriction(a, { commercial: true }) : null }))
      .filter((x) => x.r && x.r.level === 'block');
  } catch { hits = []; }
  if (!hits.length) return 0;
  const now = Date.now();
  const fresh = hits.filter((x) => !(x.a.id && now - (warnedAt.get(x.a.id) || 0) < 60000));
  for (const x of hits) if (x.a.id) warnedAt.set(x.a.id, now);
  if (!fresh.length) return 0;
  const first = fresh[0];
  const name = String(first.a.name || first.a.title || '这个素材').slice(0, 30);
  const more = fresh.length > 1 ? `等 ${fresh.length} 个素材` : '';
  const msg = first.r.licenseId === 'reference'
    ? `「${name}」${more}来自视频站，仅供学习参考：版权归原作者，成片不能公开发布或商用。`
    : `「${name}」${more}的许可禁止商用，成片只能用于非商业用途，导出时会提醒你。`;
  try { useStore.getState().toast(msg, 'warn', 7000); } catch {}
  return fresh.length;
}

function mergeAssets(project, assets) {
  const next = { ...project.assets };
  for (const a of assets) if (a && a.id) next[a.id] = { ...(next[a.id] || {}), ...a };
  return next;
}

function registerPaths(assets) {
  const paths = assets.map((a) => a && a.path).filter(Boolean);
  if (paths.length) api.call('media:register', { paths }).catch(() => {});
}

/** 把素材加入项目素材箱（可撤销）。返回是否成功 */
export function addAssets(assets, label = '导入素材') {
  const list = (assets || []).filter(Boolean);
  if (!list.length) return false;
  registerPaths(list);
  const r = useStore.getState().commit((p) => ({ ...p, assets: mergeAssets(p, list) }), label);
  return r.ok;
}

/** 加入项目并放到主轨（atIndex 1 起；缺省放末尾）。音频素材放到音频轨。 */
export function insertAssets(assets, atIndex, label = '添加到时间线') {
  const list = (assets || []).filter(Boolean);
  if (!list.length) return false;
  registerPaths(list);
  const st = useStore.getState();
  if (!st.project) return false;
  const before = new Set(st.project.tracks.video.map((c) => c.id));
  // 走引擎的 insertAsset / addAudio：后面的镜头、跟随镜头的字幕和音频一起顺移（联动），
  // 轨道锁、镜头数与总时长上限也在这里统一检查。手工拼数组会绕过这些。
  const r = st.commit((p) => {
    const len = p.tracks.video.length;
    let idx = Number.isFinite(atIndex) ? Math.max(1, Math.min(len + 1, Math.round(atIndex))) : len + 1;
    const ops = [];
    for (const a of list) {
      if (a.kind === 'audio') {
        ops.push({ type: 'addAudio', audio: { assetId: a.id, start: 0, ...(a.duration > 0 ? {} : { out: 10 }) } });
      } else {
        ops.push({ type: 'insertAsset', assetId: a.id, atIndex: idx });
        idx += 1;
      }
    }
    const res = applyOps({ ...p, assets: mergeAssets(p, list) }, ops, {});
    if (!res.ok) throw new Error((res.errors || []).join('；') || '添加失败');
    return res.project;
  }, label);
  if (!r.ok) {
    st.toast(`未添加：${(r.errors || []).join('；') || '操作无效'}`, 'error');
    return false;
  }
  const added = useStore.getState().project.tracks.video.filter((c) => !before.has(c.id)).map((c) => c.id);
  if (added.length) st.select(added);
  warnRestrictedAssets(list);
  return true;
}

/** 音频素材放到音频轨指定时间 */
export function addAudioTrack(asset, start = 0, role = 'music') {
  if (!asset) return false;
  registerPaths([asset]);
  const r = useStore.getState().commit((p) => ({
    ...p,
    assets: mergeAssets(p, [asset]),
    tracks: { ...p.tracks, audio: [...p.tracks.audio, createAudioClip(asset, { start: Math.max(0, start), role })] },
  }), '添加音频');
  if (r.ok) warnRestrictedAssets([asset]);
  return r.ok;
}

export function setDragAssets(dataTransfer, assets) {
  try {
    dataTransfer.setData(DND_ASSET, JSON.stringify({ assets }));
    dataTransfer.effectAllowed = 'copy';
  } catch {}
}

export function readDroppedAssets(dataTransfer) {
  try {
    const raw = dataTransfer.getData(DND_ASSET);
    if (!raw) return [];
    const { assets } = JSON.parse(raw);
    return Array.isArray(assets) ? assets : [];
  } catch { return []; }
}

/** 选择本地文件导入到当前项目（不上时间线）。返回导入的 Asset[] */
export async function importFilesDialog({ toTimeline = false } = {}) {
  const st = useStore.getState();
  if (!st.project) return [];
  const paths = await api.call('dialog:openFiles', {
    title: '导入素材',
    multi: true,
    filters: [
      { name: '视频/图片/音频', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] },
    ],
  });
  if (!paths || !paths.length) return [];
  return importPaths(paths, { toTimeline });
}

/** 读取素材元数据（失败返回 null，不抛错）。返回 ffprobe 结果 {duration,width,height,fps,hasAudio,...} */
export async function readAssetMeta(asset) {
  const p = asset && (asset.path || asset.originalPath);
  if (!p) return null;
  try { return await api.call('media:probe', { path: p }); } catch { return null; }
}

function assetFps(a) {
  const v = Number((a && (a.fps || (a.meta && a.meta.fps))) || 0);
  return v > 0 ? v : 0;
}

/** 帧率不匹配检测（纯函数，便于测试）：返回不匹配的 [{asset,fps}]，误差 ≤0.5 视为一致 */
export function fpsMismatches(assets, projectFps) {
  const pf = Number(projectFps) || 30;
  return (assets || []).filter((a) => a && a.kind === 'video' && assetFps(a) && Math.abs(assetFps(a) - pf) > 0.5)
    .map((a) => ({ asset: a, fps: assetFps(a) }));
}

/** 导入后补齐元数据（时长/尺寸/帧率），并提示帧率不匹配 */
async function enrichAndCheck(assets) {
  const st = useStore.getState();
  const out = await Promise.all((assets || []).map(async (a) => {
    if (!a || a.kind !== 'video' || (assetFps(a) && a.width && a.duration)) return a;
    const meta = await readAssetMeta(a);
    if (!meta) return a;
    return {
      ...a,
      duration: a.duration || meta.duration, width: a.width || meta.width, height: a.height || meta.height,
      fps: assetFps(a) || meta.fps, hasAudio: a.hasAudio != null ? a.hasAudio : meta.hasAudio,
      meta: { ...(a.meta || {}), fps: assetFps(a) || meta.fps, vcodec: meta.vcodec, size: meta.size },
    };
  }));
  const pf = (st.project && st.project.settings && st.project.settings.fps) || 30;
  const bad = fpsMismatches(out, pf);
  if (bad.length) {
    const list = Array.from(new Set(bad.map((b) => Math.round(b.fps * 100) / 100))).join(' / ');
    st.toast(`有 ${bad.length} 个视频帧率为 ${list} fps，与项目 ${pf} fps 不一致；导出时会自动转换，如需保持原帧率可在「项目设置」修改。`, 'warn', 7000);
  }
  return out;
}

/** 素材是否离线（原文件丢失）。由 checkOfflineAssets 或主进程标记 */
export function isAssetOffline(asset) {
  return !!(asset && (asset.offline || asset.missing));
}

/** 检查项目素材是否丢失，标记 asset.offline（不进撤销历史）。返回离线数量 */
export async function checkOfflineAssets() {
  const st = useStore.getState();
  const p = st.project;
  if (!p) return 0;
  const list = Object.values(p.assets || {}).filter((a) => a && a.path && ['video', 'image', 'audio'].includes(a.kind));
  const flags = await Promise.all(list.map(async (a) => [a.id, !(await readAssetMeta(a))]));
  const changed = flags.filter(([id, off]) => !!(p.assets[id] && p.assets[id].offline) !== off);
  if (changed.length) {
    useStore.getState().update((proj) => {
      const assets = { ...proj.assets };
      for (const [id, off] of changed) if (assets[id]) assets[id] = { ...assets[id], offline: off || undefined };
      return { ...proj, assets };
    });
  }
  return flags.filter(([, off]) => off).length;
}

/** 重新链接离线素材：选择新文件，校验类型后替换路径（可撤销） */
export async function relinkAsset(asset) {
  const st = useStore.getState();
  if (!st.project || !asset) return false;
  // 选文件 / 读文件期间切换了项目：不能把路径写进别的项目
  const projectId = st.project.id;
  const sameProject = () => { const cur = useStore.getState().project; return !!cur && cur.id === projectId; };
  let paths = null;
  try {
    paths = await api.call('dialog:openFiles', { title: `重新链接「${asset.name || '素材'}」`, multi: false });
  } catch (e) { st.toast('无法打开文件选择：' + e.message, 'error'); return false; }
  const p = paths && paths[0];
  if (!p) return false;
  if (!sameProject()) return false;
  let meta = null;
  try { meta = await api.call('media:probe', { path: p }); } catch (e) { st.toast('这个文件无法读取：' + e.message, 'error'); return false; }
  if (!sameProject()) { st.toast('已切换到其他项目，没有重新链接', 'warn'); return false; }
  const want = asset.kind === 'generated-image' ? 'image' : asset.kind;
  if (meta && meta.kind && want && meta.kind !== want) { st.toast(`类型不一致：原素材是${want === 'audio' ? '音频' : want === 'image' ? '图片' : '视频'}`, 'warn'); return false; }
  if (meta && asset.duration && meta.duration && meta.duration + 0.05 < asset.duration * 0.9) st.toast('新文件比原素材短，部分片段可能超出范围', 'warn');
  registerPaths([{ path: p }]);
  const r = st.commit((proj) => {
    const cur = proj.assets[asset.id];
    if (!cur) return proj;
    const next = { ...cur, path: p, originalPath: p, offline: undefined, missing: undefined };
    if (meta) Object.assign(next, { width: meta.width || cur.width, height: meta.height || cur.height, fps: meta.fps || cur.fps, duration: meta.duration || cur.duration });
    return { ...proj, assets: { ...proj.assets, [asset.id]: next } };
  }, '重新链接：' + (asset.name || '素材'));
  if (r.ok) st.toast('已重新链接', 'ok');
  return r.ok;
}

/** 放到画中画轨（播放头处）。依赖 W5 的 addOverlay op；不可用时退回主轨插入 */
export function addAssetToOverlay(asset, { start, track = 1 } = {}) {
  const st = useStore.getState();
  if (!st.project || !asset) return false;
  registerPaths([asset]);
  if (!st.project.assets[asset.id]) addAssets([asset], '导入素材');
  const s = useStore.getState();
  const at = Number.isFinite(start) ? start : s.playhead || 0;
  const r = s.commit([{ type: 'addOverlay', assetId: asset.id, start: at, track }], '添加到画中画：' + (asset.name || ''), { silent: true });
  if (r && r.ok) return true;
  s.toast('当前版本暂不支持画中画轨，已添加到主轨', 'warn');
  return insertAssets([asset], undefined, '添加到时间线：' + (asset.name || ''));
}

export async function importPaths(paths, { toTimeline = false } = {}) {
  const st = useStore.getState();
  if (!st.project || !paths || !paths.length) return [];
  // 导入是异步的：完成时如果已经切换到别的项目，结果不能写进那个项目
  const projectId = st.project.id;
  const sameProject = () => { const cur = useStore.getState().project; return !!cur && cur.id === projectId; };
  const switched = () => { st.toast('导入完成前切换了项目，这批素材没有加入当前项目，需要的话请重新导入', 'warn', 6000); return []; };
  try {
    const raw = await st.trackJob('media:import', { paths, projectId }, `导入 ${paths.length} 个文件`);
    if (!sameProject()) return switched();
    const assets = await enrichAndCheck(raw);
    if (!sameProject()) return switched();
    // 放不上时间线（轨道锁、超出上限等）时，素材仍然进素材箱，不让这次导入白做
    if (!toTimeline || !insertAssets(assets, undefined, '导入并添加到时间线')) addAssets(assets);
    st.toast(`已导入 ${assets.length} 个素材`, 'ok');
    return assets;
  } catch (e) {
    if (!e.cancelled) st.toast('导入失败：' + e.message, 'error');
    return [];
  }
}