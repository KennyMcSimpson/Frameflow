// 主题学习：输入主题 → 联网搜索 B站 / YouTube → 勾选候选 → 加入拆片队列。
import React, { useState } from 'react';
import api from '../../api.js';
import useStore from '../../store.js';
import { Button, Select, Icon, Spinner, Chip } from '../../components/ui.jsx';
import useLibrary from './libraryActions.js';
import { CATEGORY_OPTIONS, YtdlpNotice } from './AddPanel.jsx';
import { guessCategory, fmtClock, PLATFORM_LABELS } from './libraryUtils.js';

const COUNT_OPTIONS = [{ value: '3', label: '3 个' }, { value: '5', label: '5 个' }, { value: '8', label: '8 个' }];
const SOURCE_OPTIONS = [{ value: 'bilibili', label: 'B站' }, { value: 'youtube', label: 'YouTube' }];
/** 网络缩略图：补协议、http 升级为 https（CSP 只允许 https 图片）；本地路径走 ffmedia */
function thumbUrl(u) {
  const s = String(u || '');
  if (s.startsWith('//')) return 'https:' + s;
  if (/^http:\/\//i.test(s)) return 'https://' + s.slice(7);
  return api.mediaUrl(s);
}

const EXAMPLES =['咖啡产品短视频', '电影感转场教程', '王家卫风格 镜头', 'vlog 开头 钩子', '美食 微距 拍摄技巧'];

export default function TopicLearn() {
  const yt = useLibrary((s) => s.ytdlp);
  const [topic, setTopic] = useState('');
  const [count, setCount] = useState('5');
  const [source, setSource] = useState('bilibili');
  const [category, setCategory] = useState(null); // null = 自动猜测
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null); // WebResult[] | null
  const [errors, setErrors] = useState([]);
  const [checked, setChecked] = useState({});
  const toast = useStore.getState().toast;
  const guessed = guessCategory(topic);
  const effCategory = category || guessed;

  const search = async (q = topic) => {
    const query = String(q || '').trim();
    if (!query) { toast('请先输入想学习的主题', 'warn'); return; }
    if (yt.checked && !yt.installed) { toast('联网搜索视频需要先安装下载组件 yt-dlp', 'warn'); return; }
    setLoading(true); setResults(null); setErrors([]);
    try {
      const r = await api.call('web:search', { query, sources: [source], kind: 'video', limit: Number(count) });
      const list = (r && Array.isArray(r.results) ? r.results : []).filter((x) => x && x.url).slice(0, Number(count));
      setResults(list);
      setErrors(r && Array.isArray(r.errors) ? r.errors : []);
      const c = {};
      list.forEach((x) => { c[x.url] = true; });
      setChecked(c);
    } catch (e) {
      setResults([]);
      setErrors([{ source, error: e.message }]);
    } finally {
      setLoading(false);
    }
  };

  const selected = (results || []).filter((r) => checked[r.url]);

  const addToQueue = () => {
    if (!selected.length) { toast('请至少勾选一个视频', 'warn'); return; }
    const n = useLibrary.getState().enqueue(selected.map((r) => ({ url: r.url, title: r.title, category: effCategory })));
    if (n) {
      toast(`已把 ${n} 个视频加入拆片队列`, 'ok');
      setResults(null); setChecked({});
    } else {
      toast('这些视频已经在队列中', 'info');
    }
  };

  return (
    <div className="lib-topic">
      <div className="hint" style={{ marginBottom: 8 }}>说出你想学的主题，镜流会联网找几个代表性视频，依次下载并拆片。</div>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input grow"
          placeholder="例如：咖啡产品短视频"
          value={topic}
          onChange={(e) => { setTopic(e.target.value); setCategory(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
        />
      </div>
      {!topic && (
        <div className="lib-examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="lib-example" onClick={() => { setTopic(ex); setCategory(null); }}>{ex}</button>
          ))}
        </div>
      )}
      <div className="lib-add-grid" style={{ marginTop: 8 }}>
        <div className="field">
          <label>来源</label>
          <Select value={source} onChange={setSource} options={SOURCE_OPTIONS} />
        </div>
        <div className="field">
          <label>数量</label>
          <Select value={count} onChange={setCount} options={COUNT_OPTIONS} />
        </div>
      </div>
      <div className="field">
        <label>归类为{!category && topic.trim() ? '（根据主题自动判断）' : ''}</label>
        <Select value={effCategory} onChange={setCategory} options={CATEGORY_OPTIONS} />
      </div>
      <YtdlpNotice compact />
      <Button variant="ai" icon="search" className="lib-full" onClick={() => search()} disabled={loading || !topic.trim()}>
        {loading ? '正在搜索…' : '搜索候选视频'}
      </Button>

      {loading && <div className="lib-topic-state"><Spinner ai /> <span className="xs muted">正在 {PLATFORM_LABELS[source]} 搜索「{topic}」…</span></div>}

      {errors.length > 0 && (
        <div className="callout warn" style={{ marginTop: 8 }}>
          {errors.map((e, i) => <div key={i}>{PLATFORM_LABELS[e.source] || e.source}：{e.error}</div>)}
        </div>
      )}

      {results && !loading && (
        <div className="lib-topic-results">
          {!results.length ? (
            <div className="hint" style={{ padding: '8px 0' }}>没有找到相关视频，换个说法或换个来源试试。</div>
          ) : (
            <>
              <div className="row" style={{ margin: '10px 0 6px' }}>
                <span className="xs muted grow">找到 {results.length} 个，已选 {selected.length} 个</span>
                <Button size="sm" variant="ghost" onClick={() => {
                  const all = selected.length < results.length;
                  const c = {}; results.forEach((r) => { c[r.url] = all; }); setChecked(c);
                }}>{selected.length < results.length ? '全选' : '全不选'}</Button>
              </div>
              {results.map((r) => (
                <label key={r.url} className={'lib-cand' + (checked[r.url] ? ' on' : '')}>
                  <input type="checkbox" checked={!!checked[r.url]} onChange={(e) => setChecked({ ...checked, [r.url]: e.target.checked })} />
                  <span className="lib-cand-thumb">
                    {r.thumb ? <img src={thumbUrl(r.thumb)}alt="" loading="lazy" draggable={false} referrerPolicy="no-referrer" /> : <Icon name="film" size={16} />}
                    {Number(r.duration) > 0 && <span className="lib-cand-dur mono">{fmtClock(r.duration)}</span>}
                  </span>
                  <span className="lib-cand-body">
                    <span className="lib-cand-title" title={r.title}>{r.title || r.url}</span>
                    <span className="xs muted ellipsis">{r.author || PLATFORM_LABELS[r.source] || ''}</span>
                  </span>
                  <button type="button" className="btn ghost sm icon" title="打开原网页" onClick={(e) => { e.preventDefault(); api.call('shell:openExternal', { url: r.url }).catch(() => {}); }}>
                    <Icon name="external" size={13} />
                  </button>
                </label>
              ))}
              <div className="hint" style={{ margin: '6px 0' }}>
                <Chip>{(results[0] && results[0].license) || '版权归原作者，仅供学习参考'}</Chip>
              </div>
              <Button variant="primary" icon="plus" className="lib-full" onClick={addToQueue} disabled={!selected.length}>
                加入拆片队列（{selected.length}）
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
