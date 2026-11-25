// AI 精修 ·「缺少素材」卡片：先在素材库找，再联网（免版权图库）找候选，一键下载并插入到指定镜头位置。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import useStore from '../../store.js';
import api from '../../api.js';
import { Button, Icon, ProgressBar, Spinner } from '../../components/ui.jsx';
import { AssetThumb } from '../../components/media.jsx';
import { insertAssets, addAudioTrack } from '../../assetActions.js';
import { LIMITS } from '../../../engine/model.js';
import { applyOps } from '../../../engine/ops.js';
import { queryLibraryAssets, fmtDur } from './SideData.js';
import { stockSourcesFor, downloadWebResult, remoteThumb, WEB_SOURCE_MAP } from './MediaShared.jsx';

const cache = new Map(); // `${msgId}:${index}` -> state，切换页签后不重复搜索（LRU 上限 100）
const MAX_CACHE = 100;

function setCache(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE) {
    cache.delete(cache.keys().next().value);
  }
}

function useCachedState(key, init) {
  const [state, setState] = useState(() => {
    if (!cache.has(key)) return init;
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  });
  const set = useCallback((upd) => {
    setState((prev) => {
      const next = typeof upd === 'function' ? upd(prev) : upd;
      setCache(key, next);
      return next;
    });
  }, [key]);
  return [state, set];
}

function guessKind(req) {
  const s = `${req.query || ''} ${req.purpose || ''}`;
  if (/音乐|配乐|bgm|音效|背景声|music|sound/i.test(s)) return 'audio';
  if (/图片|照片|静帧|插画|photo|image/i.test(s)) return 'image';
  return 'video';
}

/**
 * 加入项目并插入主轨指定位置；给了目标时长就一并设置（一步历史）。
 * 插入本身走引擎的 insertAsset 操作（统一校验上限、素材长度、联动与首镜修正），不再手写 splice。
 */
function insertWithDuration(asset, atIndex, duration, label) {
  const dur = Number(duration);
  if (!(dur > 0)) return insertAssets([asset], atIndex, label);
  if (asset.path) api.call('media:register', { paths: [asset.path] }).catch(() => {});
  const st = useStore.getState();
  let newId = null;
  const r = st.commit((p) => {
    const withAsset = { ...p, assets: { ...p.assets, [asset.id]: { ...(p.assets[asset.id] || {}), ...asset } } };
    const len = withAsset.tracks.video.length;
    const at = Number.isFinite(atIndex) ? Math.max(1, Math.min(len + 1, Math.round(atIndex))) : len + 1;
    const res = applyOps(withAsset, [{ type: 'insertAsset', assetId: asset.id, atIndex: at, in: 0, duration: Math.max(LIMITS.minClip, dur) }]);
    if (!res.ok) throw new Error((res.errors || []).join('；') || '无法插入这个素材');
    const before = new Set(p.tracks.video.map((c) => c.id));
    const added = res.project.tracks.video.find((c) => !before.has(c.id));
    newId = added ? added.id : null;
    return res.project;
  }, label);
  if (r.ok && newId) st.select([newId]);
  if (!r.ok) st.toast('未添加：' + ((r.errors || []).join('；') || '无法插入这个素材'), 'error', undefined, { key: 'side-insert-fail' });
  return r.ok;
}

export default function SideMaterialCard({ msgId, index, request }) {
  const key = `${msgId}:${index}`;
  const req = request || {};
  const kind = guessKind(req);
  const atIndex = Number.isFinite(Number(req.atIndex)) && Number(req.atIndex) >= 1 ? Math.round(Number(req.atIndex)) : null;
  const where = kind === 'audio' ? '作为背景音乐' : atIndex ? `插入到第${atIndex}镜` : '添加到末尾';
  const [state, setState] = useCachedState(key, { phase: 'idle', lib: [], web: [], webNote: '', error: null, done: {}, dl: {} });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const runSearch = useCallback(async () => {
    const q = String(req.query || '').trim();
    if (!q) { setState((s) => ({ ...s, phase: 'done', error: 'AI 没有给出搜索词' })); return; }
    setState((s) => ({ ...s, phase: 'library', error: null, lib: [], web: [], webNote: '' }));
    let lib = [];
    try {
      lib = (await queryLibraryAssets(q)).filter((a) => kind === 'audio' ? a.kind === 'audio' : a.kind !== 'audio').slice(0, 4);
    } catch { lib = []; }
    if (!alive.current) return;
    setState((s) => ({ ...s, lib, phase: 'web' }));
    const settings = useStore.getState().settings;
    const sources = stockSourcesFor(kind, settings);
    if (!sources.length) { setState((s) => ({ ...s, phase: 'done', webNote: '没有可用的免版权图库来源' })); return; }
    try {
      const r = await api.call('web:search', { query: q, sources, kind, limit: 4 });
      if (!alive.current) return;
      const web = (Array.isArray(r && r.results) ? r.results : []).filter((x) => x && (x.downloadUrl || x.url)).slice(0, 6);
      const errs = Array.isArray(r && r.errors) ? r.errors : [];
      const note = !web.length && errs.length ? `联网搜索失败：${errs.map((e) => e.error).join('；')}` : (!web.length ? '网上也没有找到合适的候选' : '');
      setState((s) => ({ ...s, web, phase: 'done', webNote: note }));
    } catch (e) {
      if (!alive.current) return;
      setState((s) => ({ ...s, phase: 'done', webNote: '联网搜索失败：' + (e.message || '网络错误') }));
    }
  }, [req.query, kind, setState]);

  useEffect(() => { if (state.phase === 'idle') runSearch(); }, [state.phase, runSearch]);

  const label = `补素材：${req.purpose || req.query || ''}`.slice(0, 40);

  const placeAsset = (asset) => {
    if (asset.kind === 'audio') return addAudioTrack(asset, 0, 'music');
    return insertWithDuration(asset, atIndex || undefined, req.duration, label);
  };

  const pickLibrary = (a) => {
    if (placeAsset(a)) {
      setState((s) => ({ ...s, done: { ...s.done, ['lib:' + a.id]: true } }));
      useStore.getState().toast(`已${where}：${a.name}`, 'success');
    }
  };

  const pickWeb = async (r) => {
    const k = `web:${r.source}:${r.id || r.url}`;
    if (state.dl[k] && state.dl[k].progress != null) return;
    const projectId = useStore.getState().project?.id;
    setState((s) => ({ ...s, dl: { ...s.dl, [k]: { progress: 0, jobId: null, message: '准备下载…' } } }));
    try {
      const asset = await downloadWebResult(r, {
        onStart: (jobId) => { if (alive.current) setState((s) => ({ ...s, dl: { ...s.dl, [k]: { ...(s.dl[k] || {}), jobId } } })); },
        onProgress: (p) => { if (alive.current) setState((s) => ({ ...s, dl: { ...s.dl, [k]: { ...(s.dl[k] || {}), progress: p.progress || 0, message: p.message || p.stage || '' } } })); },
      });
      if (!alive.current) return;
      const cur = cache.get(key);
      if (cur && cur.dl[k] && cur.dl[k].cancelled) return;
      const curProj = useStore.getState().project;
      if (!curProj || curProj.id !== projectId) {
        setState((s) => ({ ...s, dl: { ...s.dl, [k]: undefined } }));
        return;
      }
      const ok = placeAsset(asset);
      setState((s) => ({ ...s, dl: { ...s.dl, [k]: undefined }, done: { ...s.done, [k]: ok } }));
      if (ok) useStore.getState().toast(`已下载并${where}：${asset.name || r.title}`, 'success');
    } catch (e) {
      if (alive.current) setState((s) => ({ ...s, dl: { ...s.dl, [k]: undefined } }));
      if (e && e.cancelled) useStore.getState().toast('已取消下载');
      else useStore.getState().toast('下载失败：' + (e.message || '未知原因'), 'error');
    }
  };

  const cancelWeb = (k) => {
    const d = state.dl[k];
    if (d && d.jobId) api.cancel(d.jobId).catch(() => {});
    setState((s) => ({ ...s, dl: { ...s.dl, [k]: { ...(s.dl[k] || {}), cancelled: true, progress: null } } }));
  };

  const searching = state.phase === 'library' || state.phase === 'web';

  return (
    <div className="aie-material">
      <div className="aie-material-head">
        <Icon name="search" size={13} />
        <div className="grow">
          <div className="aie-material-title">缺少素材：{req.purpose || req.query}</div>
          <div className="xs muted">
            搜索词「{req.query}」{atIndex && kind !== 'audio' ? ` · 建议放在第${atIndex}镜` : ''}{Number(req.duration) > 0 ? ` · 约 ${Math.round(Number(req.duration) * 10) / 10} 秒` : ''}
          </div>
        </div>
        <Button size="sm" variant="ghost" icon="refresh" title="重新搜索" disabled={searching} onClick={runSearch} />
      </div>

      {state.error && <div className="xs aie-err">{state.error}</div>}

      <div className="aie-material-sec">
        <div className="aie-material-sub">素材库{state.phase === 'library' && <Spinner />}</div>
        {state.phase !== 'library' && !state.lib.length && <div className="xs muted">素材库里没有匹配的素材</div>}
        {state.lib.map((a) => (
          <div key={a.id} className="aie-cand">
            <AssetThumb asset={a} width={64} height={36} showKind={false} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="small ellipsis" title={a.name}>{a.name}</div>
              <div className="xs muted">{a.kind === 'image' ? '图片' : fmtDur(a.duration)}</div>
            </div>
            {state.done['lib:' + a.id]
              ? <span className="xs aie-ok"><Icon name="check" size={12} />已使用</span>
              : <Button size="sm" onClick={() => pickLibrary(a)}>{where}</Button>}
          </div>
        ))}
      </div>

      <div className="aie-material-sec">
        <div className="aie-material-sub">联网候选（免版权）{state.phase === 'web' && <Spinner />}</div>
        {state.phase === 'done' && !state.web.length && <div className="xs muted">{state.webNote || '没有找到候选'}</div>}
        {state.web.map((r) => {
          const k = `web:${r.source}:${r.id || r.url}`;
          const d = state.dl[k];
          const busy = d && d.progress != null;
          const thumb = remoteThumb(r.thumb);
          return (
            <div key={k} className="aie-cand">
              <div className="thumb" style={{ width: 64, height: 36, flex: 'none' }}>{thumb && <img src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />}</div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="small ellipsis" title={r.title}>{r.title || '未命名'}</div>
                <div className="xs muted ellipsis">{[(WEB_SOURCE_MAP[r.source] || {}).short || r.source, Number(r.duration) > 0 ? fmtDur(r.duration) : null, r.license].filter(Boolean).join(' · ')}</div>
                {busy && <div className="aie-cand-progress"><ProgressBar value={d.progress} indeterminate={!d.progress} /></div>}
              </div>
              {state.done[k]
                ? <span className="xs aie-ok"><Icon name="check" size={12} />已插入</span>
                : busy
                  ? <Button size="sm" variant="ghost" onClick={() => cancelWeb(k)}>取消</Button>
                  : <Button size="sm" variant="ai" icon="download" onClick={() => pickWeb(r)} title={`下载到项目并${where}`}>{where}</Button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
