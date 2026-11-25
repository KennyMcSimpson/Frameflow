// 分镜相关的小对话框：指定素材、AI 修改此镜、通用确认。
import React, { useMemo, useRef, useState, useEffect } from 'react';
import useStore from '../../store.js';
import { Button, Empty, Icon, Modal, fmtTime } from '../../components/ui.jsx';
import { AssetThumb } from '../../components/media.jsx';
import { useCreateUI, answerConfirm } from './createState.js';
import { assignAsset, importForShot, refineShot } from './createActions.js';
import { REFINE_SUGGESTIONS } from './createLabels.js';
import { isComposing } from './bits.jsx';

const PICKABLE_KINDS = new Set(['video', 'image', 'generated-image']);

export function AssetPicker({ shotId, onClose }) {
  const shot = useStore((s) => (s.project ? s.project.storyboard.find((x) => x.id === shotId) : null));
  const assets = useStore((s) => s.project && s.project.assets);
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(assets || {})
      .filter((a) => PICKABLE_KINDS.has(a.kind))
      .filter((a) => !q || [a.name, a.description, ...(a.tags || [])].join(' ').toLowerCase().includes(q));
  }, [assets, query]);

  if (!shot) return null;

  const choose = (assetId) => { if (assignAsset(shotId, assetId)) onClose(); };
  const importNew = async () => {
    setImporting(true);
    const assigned = await importForShot(shotId);
    setImporting(false);
    if (assigned) onClose();
  };

  return (
    <Modal
      title={`为第 ${shot.index} 镜指定素材`}
      wide
      onClose={onClose}
      footer={(
        <>
          {shot.assetId && <Button variant="danger" onClick={() => choose(null)}>移除当前素材</Button>}
          <span className="grow" />
          <Button onClick={onClose}>关闭</Button>
        </>
      )}
    >
      <div className="row cr-picker-bar">
        <input type="search" className="input grow" value={query} placeholder="搜索素材名称或标签" onChange={(e) => setQuery(e.target.value)} />
        <Button variant="primary" icon="upload" disabled={importing} onClick={importNew}>{importing ? '导入中…' : '导入新文件'}</Button>
      </div>
      {list.length ? (
        <div className="cr-picker-grid">
          {list.map((asset) => (
            <button key={asset.id} type="button" className={'cr-picker-item' + (asset.id === shot.assetId ? ' active' : '')} onClick={() => choose(asset.id)}>
              <AssetThumb asset={asset} style={{ width: '100%', height: 'auto', aspectRatio: '16 / 9' }} />
              <span className="ellipsis" title={asset.name}>{asset.name}</span>
              <span className="xs muted mono">{fmtTime(asset.duration, false)}</span>
              {asset.id === shot.assetId && <Icon name="check" size={14} className="cr-picker-check" />}
            </button>
          ))}
        </div>
      ) : (
        <Empty icon="folder" title={query ? '没有匹配的素材' : '项目里还没有素材'}>导入你拍好的视频或图片，也可以在参考结果里下载一段。</Empty>
      )}
    </Modal>
  );
}

export function RefinePrompt({ shotId, onClose }) {
  const shot = useStore((s) => (s.project ? s.project.storyboard.find((x) => x.id === shotId) : null));
  const [text, setText] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

  if (!shot) return null;

  const submit = (value) => {
    const instruction = String(value).trim();
    if (!instruction) return;
    onClose();
    refineShot(shotId, instruction);
  };

  return (
    <Modal
      title={`AI 修改第 ${shot.index} 镜`}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="ai" icon="sparkles" disabled={!text.trim()} onClick={() => submit(text)}>让 AI 修改</Button>
        </>
      )}
    >
      <p className="hint cr-refine-shot">{shot.title}{shot.action ? `：${shot.action}` : ''}</p>
      <textarea
        ref={inputRef}
        className="textarea"
        rows={3}
        value={text}
        placeholder="用一句话说想怎么改"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) { e.preventDefault(); submit(text); }
        }}
      />
      <div className="cr-quick">
        {REFINE_SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="cr-quick-chip" onClick={() => setText(s)}>{s}</button>
        ))}
      </div>
    </Modal>
  );
}

export function ConfirmHost() {
  const confirm = useCreateUI((s) => s.confirm);
  if (!confirm) return null;
  return (
    <Modal
      title={confirm.title}
      onClose={() => answerConfirm(false)}
      footer={(
        <>
          <Button onClick={() => answerConfirm(false)}>取消</Button>
          {confirm.altLabel && <Button onClick={() => answerConfirm('alt')}>{confirm.altLabel}</Button>}
          <Button variant={confirm.danger ? 'danger' : 'primary'} onClick={() => answerConfirm(true)}>{confirm.confirmLabel}</Button>
        </>
      )}
    >
      <p className="cr-confirm-body">{confirm.body}</p>
    </Modal>
  );
}
