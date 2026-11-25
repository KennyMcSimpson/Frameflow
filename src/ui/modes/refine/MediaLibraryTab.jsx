// 素材库页签：拆片下载、联网下载到库的素材。可加入项目或直接拖上时间线。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../../store.js';
import { Button, Empty, Icon, Spinner } from '../../components/ui.jsx';
import { AssetThumb } from '../../components/media.jsx';
import { addAssets, insertAssets, setDragAssets } from '../../assetActions.js';
import { queryLibraryAssets, fmtDur } from './SideData.js';

export default function MediaLibraryTab({ query, active }) {
  const project = useStore((s) => s.project);
  const [state, setState] = useState({ loading: false, error: null, items: [], loaded: false });
  const [nonce, setNonce] = useState(0);
  const reqRef = useRef(0);

  useEffect(() => {
    if (!active) return undefined;
    const id = ++reqRef.current;
    const delay = state.loaded ? 300 : 0;
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const items = await queryLibraryAssets(query);
        if (id === reqRef.current) setState({ loading: false, error: null, items, loaded: true });
      } catch (e) {
        if (id === reqRef.current) setState((s) => ({ ...s, loading: false, error: e.message || '读取素材库失败', loaded: true }));
      }
    }, delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, active, nonce]);

  const inProject = useMemo(() => new Set(Object.keys((project && project.assets) || {})), [project && project.assets]);

  const addToProject = (a) => {
    if (addAssets([a], '从素材库加入：' + a.name)) useStore.getState().toast(`已加入项目素材：${a.name}`, 'ok');
  };
  const addToTimeline = (a) => insertAssets([a], undefined, '从素材库添加：' + a.name);

  if (!project) return <Empty icon="folder" title="没有打开的项目" />;

  return (
    <div className="mp-tab">
      <div className="mp-toolbar">
        <span className="xs muted grow">拆片下载的视频、联网保存到库的素材，所有项目共用。</span>
        <Button size="sm" variant="ghost" icon="refresh" title="刷新素材库" onClick={() => setNonce((n) => n + 1)} disabled={state.loading} />
      </div>

      {state.error ? (
        <Empty icon="close" title="素材库读取失败" action={<Button size="sm" icon="refresh" onClick={() => setNonce((n) => n + 1)}>重试</Button>}>{state.error}</Empty>
      ) : !state.loaded || (state.loading && !state.items.length) ? (
        <div className="mp-loading"><Spinner /> 正在读取素材库…</div>
      ) : !state.items.length ? (
        <Empty icon="book" title={query ? '素材库里没有匹配的素材' : '素材库还是空的'}>
          {query ? '试试「联网素材」页签，从免版权图库找。' : '在「拆片库」分析视频，或在联网素材里选择「下载到素材库」，素材会出现在这里。'}
        </Empty>
      ) : (
        <div className="mp-grid">
          {state.items.map((a) => {
            const has = inProject.has(a.id);
            const isStill = a.kind === 'image' || a.kind === 'generated-image';
            return (
              <div
                key={a.id}
                className="mp-card"
                draggable
                onDragStart={(e) => setDragAssets(e.dataTransfer, [a])}
                onDoubleClick={() => addToTimeline(a)}
                title={`${a.name}${a.description ? '\n' + a.description : ''}\n拖到时间线可放到指定位置`}
              >
                <div className="mp-card-media">
                  <AssetThumb asset={a} width={128} height={72} style={{ width: '100%', height: '100%' }} />
                  {has && <span className="mp-badge used"><Icon name="check" size={10} />已在项目</span>}
                  <span className="mp-badge dur">{isStill ? '静帧' : fmtDur(a.duration)}</span>
                  <div className="mp-card-hover">
                    <button type="button" className="mp-round primary" title="添加到时间线末尾" onClick={(e) => { e.stopPropagation(); addToTimeline(a); }}>
                      <Icon name="plus" size={16} />
                    </button>
                  </div>
                </div>
                <div className="mp-card-name ellipsis">{a.name || '未命名素材'}</div>
                {Array.isArray(a.tags) && a.tags.length > 0 && (
                  <div className="mp-tags">{a.tags.slice(0, 3).map((t) => <span key={t} className="mp-tag">{t}</span>)}</div>
                )}
                <div className="mp-card-actions">
                  <Button size="sm" className="grow" disabled={has} onClick={() => addToProject(a)} title={has ? '已在项目素材中' : '加入项目素材（不放上时间线）'}>
                    {has ? '已加入' : '加入项目'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
