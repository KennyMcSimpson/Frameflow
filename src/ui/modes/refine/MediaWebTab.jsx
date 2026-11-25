// 联网素材页签：多来源搜索（免版权图库 + 视频站），下载到项目 / 下载并放上时间线，进度可取消。
// 视频站（B站 / YouTube）搜索和下载前需要同意使用须知（ui/consent.js）；卡片上标明许可（engine/license.js）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../../store.js';
import api from '../../api.js';
import { Button, Empty, Icon, ProgressBar, Spinner } from '../../components/ui.jsx';
import { addAssets, insertAssets, addAudioTrack } from '../../assetActions.js';
import {
  WEB_SOURCES, WEB_SOURCE_MAP, WEB_KINDS, VIDEO_SITE_NOTICE,
  getYtdlpStatus, setYtdlpCache, sourceAvailability, runTrackedJob, downloadWebResult, remoteThumb,
} from './MediaShared.jsx';
import { fmtDur, readPref, writePref } from './SideData.js';
import { ensureConsent, isConsentDeclined, withConsent } from '../../consent.js';
import { licenseBadge, normalizeLicense, providerLabel } from '../../../engine/license.js';
import { zhToEnTerms } from '../../../engine/stockFootage.js';

const resultKey = (r) => `${r.source}:${r.id || r.url}`;

// 免 Key 的开放许可来源：MediaShared 还没收录时在这里补上（已收录则以那边为准）
const EXTRA_SOURCES = [
  { id: 'openverse', label: 'Openverse（开放许可图片和音乐）', short: 'Openverse', kinds: ['image', 'audio'], needs: null, videoSite: false },
  { id: 'archive', label: '互联网档案馆（公有领域老影像）', short: '档案馆', kinds: ['video'], needs: null, videoSite: false },
  { id: 'nasa', label: 'NASA 影像库（公共领域的航天、地球影像）', short: 'NASA', kinds: ['video', 'image'], needs: null, videoSite: false },
];
const FREE_IDS = ['commons', 'openverse', 'archive', 'nasa'];
// 排列顺序：免 Key 的在前，需要 Key 的图库其次，视频站最后
const rank = (s) => (s.videoSite ? 2 : FREE_IDS.includes(s.id) ? 0 : 1);
// 视频站只搜视频（服务端也只对视频类型搜索视频站）
const ALL_SOURCES = [
  ...WEB_SOURCES.map((s) => (s.videoSite ? { ...s, kinds: ['video'] } : s)),
  ...EXTRA_SOURCES.filter((s) => !WEB_SOURCE_MAP[s.id]),
].map((s, i) => [s, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([s]) => s);
const SOURCE_MAP = Object.fromEntries(ALL_SOURCES.map((s) => [s.id, s]));
const DEFAULT_PICK = FREE_IDS.slice();
const isVideoSiteId = (id) => !!(SOURCE_MAP[id] && SOURCE_MAP[id].videoSite);
const TONE_COLOR = { ok: 'var(--ok)', info: 'var(--info)', warn: 'var(--warn)', danger: 'var(--danger)' };

/** 来源可用性：MediaShared 已知的来源用它的规则；B站原生搜索不需要 yt-dlp（下载时才需要） */
function availabilityOf(s, kind, ctx) {
  if (!s.kinds.includes(kind)) {
    const what = kind === 'audio' ? '音乐' : kind === 'image' ? '图片' : '视频';
    return { ok: false, reason: `${s.label} 不提供${what}`, fix: null };
  }
  if (!WEB_SOURCE_MAP[s.id]) return { ok: true, reason: '', fix: null };
  const a = sourceAvailability(s.id, kind, ctx) || { ok: false, reason: '暂不可用', fix: null };
  if (s.id === 'bilibili' && !a.ok && a.fix === 'ytdlp') return { ok: true, reason: '', fix: null, downloadNeedsYtdlp: true };
  return a;
}

/** 搜索结果的许可（结构化字段优先，没有就按文字推断） */
function resultLicense(r) {
  if (r && (r.reference || isVideoSiteId(r.source))) return normalizeLicense('reference');
  if (r && r.licenseId) return normalizeLicense({ id: r.licenseId, name: r.license, url: r.licenseUrl });
  return normalizeLicense(r && r.license);
}

/** 读取已选来源：旧版偏好里没有 Openverse 时补上 */
function readPicked(prefKey) {
  const saved = readPref(prefKey, null);
  if (Array.isArray(saved)) return saved;
  const old = readPref('web.sources', null);
  return Array.isArray(old) ? [...new Set([...old, 'openverse'])] : DEFAULT_PICK.slice();
}

export default function MediaWebTab({ query, searchNonce, active, initialKind, fixedKind }) {
  const project = useStore((s) => s.project);
  const settings = useStore((s) => s.settings);
  // 音乐分类里固定为音乐，不显示类型切换
  const lockedKind = fixedKind || (initialKind === 'audio' ? 'audio' : null);
  const prefKey = lockedKind ? `web.picked.${lockedKind}` : 'web.picked';
  const [ytdlp, setYtdlp] = useState(null);
  const [installing, setInstalling] = useState(null); // null | progress 0..1
  const [kindState, setKind] = useState(() => initialKind || readPref('web.kind', 'video'));
  const kind = lockedKind || kindState;
  const [picked, setPicked] = useState(() => readPicked(prefKey));
  const [search, setSearch] = useState({ loading: false, results: [], errors: [], query: '', error: null, done: false });
  const [downloads, setDownloads] = useState({}); // key -> { progress, message, jobId, mode, assetId, error }
  const reqRef = useRef(0);
  const cancelledRef = useRef(new Set());

  useEffect(() => { if (active && !ytdlp) getYtdlpStatus().then(setYtdlp); }, [active, ytdlp]);
  useEffect(() => { if (!lockedKind) writePref('web.kind', kindState); }, [kindState, lockedKind]);
  useEffect(() => writePref(prefKey, picked), [picked, prefKey]);

  const visibleSources = useMemo(() => ALL_SOURCES.filter((s) => s.kinds.includes(kind)), [kind]);
  const avail = useMemo(() => {
    const out = {};
    const ctx = { settings, ytdlpInstalled: !!(ytdlp && ytdlp.installed) };
    for (const s of ALL_SOURCES) out[s.id] = availabilityOf(s, kind, ctx);
    return out;
  }, [kind, settings, ytdlp]);

  const effective = picked.filter((id) => SOURCE_MAP[id] && SOURCE_MAP[id].kinds.includes(kind) && avail[id] && avail[id].ok);
  const needYtdlp = picked.some((id) => SOURCE_MAP[id] && SOURCE_MAP[id].kinds.includes(kind) && avail[id] && avail[id].fix === 'ytdlp');
  const needKeys = picked.some((id) => SOURCE_MAP[id] && SOURCE_MAP[id].kinds.includes(kind) && avail[id] && avail[id].fix === 'settings');

  const toggleSource = async (id) => {
    if (picked.includes(id)) { setPicked((cur) => cur.filter((x) => x !== id)); return; }
    // 勾选视频站时先确认使用须知；不同意就不勾
    if (isVideoSiteId(id)) {
      let ok = false;
      try { ok = await ensureConsent('videoSites'); } catch { ok = false; }
      if (!ok) return;
    }
    setPicked((cur) => (cur.includes(id) ? cur : [...cur, id]));
  };

  const runSearch = useCallback(async () => {
    const q = (query || '').trim();
    const st = useStore.getState();
    if (!q) { st.toast(kind === 'audio' ? '先在上方输入想要的风格或情绪，例如「轻快 咖啡馆 钢琴」' : '先在上方输入要找的内容，例如「城市夜景 延时」', 'warn'); return; }
    if (!effective.length) { st.toast('请至少选择一个可用的来源', 'warn'); return; }
    const id = ++reqRef.current;
    setSearch({ loading: true, results: [], errors: [], query: q, error: null, done: false });
    const call = (sources) => api.call('web:search', { query: q, queryEn: zhToEnTerms(q, 4).join(' '), sources, kind, limit: 8 });
    try {
      let r;
      try {
        r = await withConsent(() => call(effective));
      } catch (e) {
        // 不同意视频站须知：去掉视频站，其余来源照常搜
        if (!isConsentDeclined(e)) throw e;
        const rest = effective.filter((s) => !isVideoSiteId(s));
        setPicked((cur) => cur.filter((s) => !isVideoSiteId(s)));
        if (!rest.length) { if (id === reqRef.current) setSearch({ loading: false, results: [], errors: [], query: q, error: null, done: false }); return; }
        r = await call(rest);
      }
      if (id !== reqRef.current) return;
      const results = Array.isArray(r && r.results) ? r.results.filter((x) => x && (x.url || x.downloadUrl)) : [];
      const errors = Array.isArray(r && r.errors) ? r.errors : [];
      setSearch({ loading: false, results, errors, query: q, error: null, done: true });
    } catch (e) {
      if (id !== reqRef.current) return;
      setSearch({ loading: false, results: [], errors: [], query: q, error: e.message || '搜索失败，请检查网络', done: true });
    }
  }, [query, effective, kind]);

  // 顶部搜索框回车或 ff:open-media 事件 → 搜索
  const lastNonce = useRef(0);
  useEffect(() => {
    if (searchNonce === lastNonce.current) return;
    lastNonce.current = searchNonce;
    if (active) runSearch();
  }, [searchNonce, active, runSearch]);

  const installYtdlp = async () => {
    const st = useStore.getState();
    setInstalling(0);
    try {
      const status = await runTrackedJob('web:ytdlpInstall', {}, '安装 yt-dlp', { onProgress: (p) => setInstalling(p.progress || 0) });
      const value = { installed: !!(status && status.installed), path: status && status.path, version: status && status.version };
      setYtdlpCache(value); setYtdlp(value);
      st.toast(value.installed ? 'yt-dlp 安装完成，现在可以搜索 YouTube、下载 B站 / YouTube 视频' : 'yt-dlp 安装未完成，请稍后再试', value.installed ? 'ok' : 'error');
    } catch (e) {
      if (!e.cancelled) st.toast('安装 yt-dlp 失败：' + e.message, 'error');
    } finally { setInstalling(null); }
  };

  const setDl = (key, patch) => setDownloads((d) => ({ ...d, [key]: patch === null ? undefined : { ...(d[key] || {}), ...patch } }));

  const download = async (r, mode) => {
    const key = resultKey(r);
    const st = useStore.getState();
    if (!st.project) { st.toast('没有打开的项目', 'error'); return; }
    if (downloads[key] && downloads[key].progress != null) return; // 正在下载
    // 视频站的视频要靠 yt-dlp 下载（B站搜索不需要，下载需要）
    if (isVideoSiteId(r.source) && !r.downloadUrl && ytdlp && !ytdlp.installed) {
      st.toast(`下载${(SOURCE_MAP[r.source] && SOURCE_MAP[r.source].short) || '视频站'}视频需要视频下载组件 yt-dlp，请先点上方「一键安装」`, 'warn');
      return;
    }
    const projectId = st.project.id;
    const sameProject = () => { const cur = useStore.getState().project; return !!cur && cur.id === projectId; };
    cancelledRef.current.delete(key);
    setDl(key, { progress: 0, message: '准备下载…', jobId: null, mode, error: null, assetId: null });
    try {
      // 视频站下载前主进程会检查是否已同意使用须知，没同意时弹框，同意后自动重试
      const asset = await withConsent(() => downloadWebResult(r, {
        onStart: (jobId) => setDl(key, { jobId }),
        onProgress: (p) => setDl(key, { progress: p.progress || 0, message: p.message || p.stage || '' }),
      }));
      if (cancelledRef.current.has(key)) return;
      if (!sameProject()) {
        setDl(key, null);
        useStore.getState().toast('下载完成前切换了项目，素材未加入当前项目', 'warn');
        return;
      }
      const ok = mode === 'insert'
        ? (asset.kind === 'audio'
          ? addAudioTrack(asset, 0, 'music')
          : insertAssets([asset], undefined, '联网素材上时间线：' + (asset.name || r.title)))
        : addAssets([asset], '下载素材：' + (asset.name || r.title));
      setDl(key, { progress: null, assetId: asset.id, message: '' });
      if (ok) useStore.getState().toast(mode === 'insert' ? (asset.kind === 'audio' ? `已下载并添加到音频轨：${asset.name || r.title}` : `已下载并放上时间线：${asset.name || r.title}`) : `已下载到项目素材：${asset.name || r.title}`, 'ok');
    } catch (e) {
      if (isConsentDeclined(e)) { setDl(key, null); return; }
      if (e && e.cancelled) { setDl(key, null); useStore.getState().toast('已取消下载'); return; }
      setDl(key, { progress: null, error: e.message || '下载失败' });
      useStore.getState().toast('下载失败：' + (e.message || '未知原因'), 'error');
    }
  };

  const cancelDownload = (key) => {
    const d = downloads[key];
    cancelledRef.current.add(key);
    if (d && d.jobId) api.cancel(d.jobId).catch(() => {});
    setDl(key, null);
  };

  if (!project) return <Empty icon="folder" title="没有打开的项目" />;

  const isAudio = kind === 'audio';
  const sourceName = (id) => (SOURCE_MAP[id] && SOURCE_MAP[id].short) || providerLabel(id) || id;
  // B站：不装 yt-dlp 也能搜，下载时才需要
  const biliNeedsYtdlp = kind === 'video' && picked.includes('bilibili') && !!(avail.bilibili && avail.bilibili.downloadNeedsYtdlp);
  const ytdlpHint = needYtdlp
    ? (biliNeedsYtdlp ? 'YouTube 搜索和 B站下载需要视频下载组件 yt-dlp' : 'YouTube 需要视频下载组件 yt-dlp')
    : 'B站可以直接搜索，下载视频时需要视频下载组件 yt-dlp';
  const failedNames = search.errors.map((er) => sourceName(er.source));

  return (
    <div className="mp-tab">
      <div className="mp-web-opts">
        {!lockedKind && (
          <div className="mp-seg" role="radiogroup" aria-label="素材类型">
            {WEB_KINDS.map((k) => (
              <button key={k.value} type="button" role="radio" aria-checked={kind === k.value} className={'mp-seg-btn' + (kind === k.value ? ' active' : '')} onClick={() => setKind(k.value)}>{k.label}</button>
            ))}
          </div>
        )}
        <div className="mp-sources" role="group" aria-label="搜索来源">
          {visibleSources.map((s) => {
            const a = avail[s.id] || { ok: false, reason: '暂不可用' };
            const on = picked.includes(s.id);
            const tip = a.ok
              ? `${s.label}${s.videoSite ? '（' + VIDEO_SITE_NOTICE + '）' : '（可放心用在成片里）'}`
              : a.reason;
            return (
              <button
                key={s.id}
                type="button"
                className={'mp-source' + (on ? ' on' : '') + (a.ok ? '' : ' off')}
                onClick={() => toggleSource(s.id)}
                title={tip}
                aria-pressed={on}
              >
                <span className="mp-source-box">{on && <Icon name="check" size={10} stroke={2.4} />}</span>
                {s.short}
              </button>
            );
          })}
        </div>
        {(needKeys || needYtdlp || biliNeedsYtdlp) && (
          <div className="mp-web-hint">
            {needKeys && (
              <div className="row">
                <Icon name="settings" size={12} />
                <span className="grow">Pexels / Pixabay 要填 API Key 才能搜；不填也可以，其余来源不用 Key</span>
                <button type="button" className="mp-link" onClick={() => useStore.getState().openDialog('settings', 'media')}>去设置</button>
              </div>
            )}
            {(needYtdlp || biliNeedsYtdlp) && (
              <div className="row">
                <Icon name="download" size={12} />
                <span className="grow">{ytdlpHint}</span>
                {installing != null
                  ? <span className="xs mono">{Math.round(installing * 100)}%</span>
                  : <button type="button" className="mp-link" onClick={installYtdlp}>一键安装</button>}
              </div>
            )}
          </div>
        )}
        <Button size="sm" variant="primary" icon="search" onClick={runSearch} disabled={search.loading || !effective.length}>
          {search.loading ? '搜索中…' : effective.length ? `在 ${effective.length} 个来源中搜索` : '没有可用来源'}
        </Button>
      </div>

      {search.loading ? (
        <div className="mp-loading"><Spinner /> 正在搜索「{search.query}」…</div>
      ) : search.error ? (
        <Empty icon="globe" title="搜索失败" action={<Button size="sm" icon="refresh" onClick={runSearch}>重试</Button>}>{search.error}</Empty>
      ) : !search.done ? (
        isAudio ? (
          <Empty icon="music" title="搜索免版权音乐">输入风格或情绪，如：轻快 咖啡馆 钢琴</Empty>
        ) : (
          <Empty icon="globe" title="从网上找素材">
            输入关键词后回车。维基共享资源、Openverse、互联网档案馆、NASA、Pexels、Pixabay 的素材可以用在成片里（部分需要署名，导出时自动生成）；B站 / YouTube 结果仅供学习参考。
          </Empty>
        )
      ) : (
        <>
          {search.errors.length > 0 && (
            <div className="mp-errors" role="status">
              <div className="xs">
                {search.results.length
                  ? `${failedNames.join('、')} 这次没有返回结果，下面是其他来源找到的内容。`
                  : `${failedNames.join('、')} 没有返回结果，可以稍后重试或换个来源。`}
              </div>
              {search.errors.map((er, i) => (
                <div key={i} className="xs ellipsis" title={er.error}>· {sourceName(er.source)}：{er.error}</div>
              ))}
            </div>
          )}
          {!search.results.length ? (
            isAudio ? (
              <Empty icon="music" title="没有找到合适的音乐">换个风格或情绪词试试，英文关键词结果通常更多（例如 calm piano、upbeat acoustic）。</Empty>
            ) : (
              <Empty icon="search" title="没有找到结果">换个说法试试，英文关键词在免版权图库里通常结果更多（例如 coffee latte art）。</Empty>
            )
          ) : (
            <div className="mp-grid web">
              {search.results.map((r) => {
                const key = resultKey(r);
                const d = downloads[key];
                const src = SOURCE_MAP[r.source];
                const videoSite = (src && src.videoSite) || isVideoSiteId(r.source) || !!r.reference;
                const busy = d && d.progress != null;
                const thumb = remoteThumb(r.thumb);
                const lic = resultLicense(r);
                const badge = licenseBadge(lic);
                const licName = lic.id === 'unknown' ? '' : lic.name;
                const licTitle = [badge.title, lic.id === 'unknown' && lic.text ? '原页面写的是：' + lic.text : '', r.author ? '作者：' + r.author : '', r.provider ? '收录自：' + r.provider : '']
                  .filter(Boolean).join('\n');
                return (
                  <div key={key} className="mp-card web">
                    <div className="mp-card-media">
                      <div className="thumb" style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {thumb ? <img src={thumb} alt="" loading="lazy" draggable={false} referrerPolicy="no-referrer" /> : <Icon name={r.kind === 'audio' ? 'music' : r.kind === 'image' ? 'image' : 'film'} size={22} style={{ opacity: 0.5 }} />}
                      </div>
                      <span className="mp-badge src">{sourceName(r.source)}</span>
                      {Number(r.duration) > 0 && <span className="mp-badge dur">{fmtDur(r.duration)}</span>}
                      {d && d.assetId && <span className="mp-badge used"><Icon name="check" size={10} />已下载</span>}
                      {busy && (
                        <div className="mp-dl-overlay">
                          <div className="xs mono">{Math.round((d.progress || 0) * 100)}%</div>
                          <ProgressBar value={d.progress || 0} indeterminate={!d.progress} />
                          <div className="xs ellipsis mp-dl-msg">{d.message || '下载中…'}</div>
                          <button type="button" className="mp-link" onClick={() => cancelDownload(key)}>取消</button>
                        </div>
                      )}
                    </div>
                    <div className="mp-card-name ellipsis" title={r.title}>{r.title || '未命名'}</div>
                    {videoSite ? (
                      <div className="mp-notice ellipsis" title={'版权归原作者。未经授权，不得用于公开发布或商用。' + (r.author ? '\n作者：' + r.author : '')}>
                        {['仅供学习', '来源：' + sourceName(r.source), r.author].filter(Boolean).join(' · ')}
                      </div>
                    ) : (
                      <div className="mp-license ellipsis" title={licTitle}>
                        <span style={{ color: TONE_COLOR[badge.tone] || 'var(--text-1)', fontWeight: 600 }}>{badge.text}</span>
                        {[licName !== badge.text ? licName : '', r.author].filter(Boolean).map((t) => ' · ' + t).join('')}
                      </div>
                    )}
                    {d && d.error && <div className="mp-error xs" title={d.error}>下载失败：{d.error}</div>}
                    <div className="mp-card-actions">
                      <Button size="sm" className="grow" disabled={busy} onClick={() => download(r, 'project')} title="下载到项目素材">
                        {d && d.assetId && d.mode === 'project' ? '再次下载' : '下载到项目'}
                      </Button>
                      <Button size="sm" variant="ghost" icon="plus" disabled={busy} onClick={() => download(r, 'insert')} title="下载并放上时间线末尾" />
                      {r.url && <Button size="sm" variant="ghost" icon="external" title="打开原网页" onClick={() => api.call('shell:openExternal', { url: r.url }).catch(() => {})} />}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
