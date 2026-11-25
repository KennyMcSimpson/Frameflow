// 启动页：欢迎区（新建 / 示例两个主入口，拆片库和导入放次要位置）、三步流程、最近项目（空时给可点的示例卡）。
// 环境只在缺东西时露一行提示；工具名和版本号放在设置里，不占首页位置。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../store.js';
import api from '../api.js';
import { Icon, Button, Modal, Spinner, ProgressBar, fmtTime } from './ui.jsx';
import { Logo } from './TopBar.jsx';
import { createSampleProject } from '../../engine/sample.js';
import { buildFirstCut } from '../../engine/firstcut.js';
import { isLocalOnlyAI } from '../modes/create/createUtils.js';

// 项目文件：.ffproj 就是工程 JSON（契约 C13），旧的 .json 也能导入
const PROJECT_FILTERS = [{ name: '镜流项目文件', extensions: ['ffproj', 'json'] }];

export function relativeTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  if (day < 7) return `${day} 天前`;
  if (day < 30) return `${Math.floor(day / 7)} 周前`;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function safeFileName(name) {
  return String(name || '项目').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || '项目';
}

// ---------------------------------------------------------------------------
// 三步流程
// ---------------------------------------------------------------------------
const STEPS = [
  { n: 1, icon: 'chat', title: '说想法', desc: 'AI 导演用白话和你聊，定下简报和分镜。', demo: '「想给咖啡店拍 30 秒宣传片，温暖一点」', tone: 'accent' },
  { n: 2, icon: 'camera', title: '配实拍画面', desc: '每个镜头自动匹配真人实拍素材，也可以用 AI 生成写实视频或导入自己拍的。', demo: '近景 · 咖啡师拉花 · 免费实拍素材', tone: 'violet' },
  { n: 3, icon: 'wand', title: '白话精修', desc: '一键初剪成片，再用一句话调色、改节奏、换转场。', demo: '「第二段暖一点，节奏再快些」', tone: 'info' },
];

function FlowSteps() {
  return (
    <ol className="sp-steps">
      {STEPS.map((s, i) => (
        <React.Fragment key={s.n}>
          <li className={'sp-step ' + s.tone}>
            <div className="sp-step-head">
              <span className="sp-step-icon"><Icon name={s.icon} size={16} /></span>
              <span className="sp-step-no mono">0{s.n}</span>
            </div>
            <h3>{s.title}</h3>
            <p>{s.desc}</p>
            <div className="sp-step-demo">{s.demo}</div>
          </li>
          {i < STEPS.length - 1 && <li className="sp-step-arrow" aria-hidden="true"><Icon name="chevronRight" size={16} /></li>}
        </React.Fragment>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// 环境提示：全部就绪时不占位；缺什么只露一行，并给出一键处理的办法
// ---------------------------------------------------------------------------
function EnvNotices() {
  const appInfo = useStore((s) => s.appInfo);
  const aiStatus = useStore((s) => s.aiStatus);
  const openDialog = useStore((s) => s.openDialog);
  const toast = useStore((s) => s.toast);
  const [install, setInstall] = useState(null); // { progress, message }
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const refresh = async () => {
    try {
      const info = await api.call('app:info');
      useStore.setState({ appInfo: info });
      await useStore.getState().refreshAI?.();
    } catch { /* 刷新失败不打扰，下次打开首页再检查 */ }
  };

  const installYtdlp = async () => {
    if (install) return;
    setInstall({ progress: 0, message: '正在连接…' });
    try {
      await useStore.getState().trackJob('web:ytdlpInstall', {}, '开启联网找参考', (p) => {
        if (mounted.current) setInstall({ progress: p.progress || 0, message: p.message || p.stage || '正在下载…' });
      });
      toast('联网找参考已开启，现在可以搜网上的参考视频和拆片了', 'ok');
      await refresh();
    } catch (e) {
      if (!e.cancelled) toast('开启联网找参考失败：' + e.message + '。可以稍后在设置里重试', 'error');
    } finally {
      if (mounted.current) setInstall(null);
    }
  };

  if (!appInfo && !aiStatus) return null;
  const ffmpeg = appInfo && appInfo.ffmpeg;
  const ffprobe = appInfo && appInfo.ffprobe;
  const ytdlp = appInfo && appInfo.ytdlp;
  const rows = [];
  if (appInfo && !(ffmpeg && ffmpeg.ok && ffprobe && ffprobe.ok)) {
    rows.push({ key: 'media', tone: 'bad', text: '视频组件缺失，导入和导出视频会失败。请重新安装应用。' });
  }
  if (isLocalOnlyAI(aiStatus)) {
    rows.push({
      key: 'ai',
      tone: 'idle',
      text: 'AI 未连接（可选）：先用本地模板出分镜',
      action: <button type="button" className="sp-env-act" onClick={() => openDialog('settings', 'ai')}>去连接</button>,
    });
  }
  if (appInfo && !(ytdlp && ytdlp.ok)) {
    rows.push({
      key: 'ytdlp',
      tone: 'idle',
      text: '联网找参考未开启（可选）',
      action: install
        ? <span className="sp-env-busy"><Spinner /> {install.message}</span>
        : <button type="button" className="sp-env-act" onClick={installYtdlp}>一键开启</button>,
      progress: install ? install.progress : null,
    });
  }
  if (!rows.length) return null;
  return (
    <div className="sp-env" role="status">
      {rows.map((r) => (
        <div key={r.key} className={'sp-env-row ' + r.tone}>
          <span className="sp-env-dot" aria-hidden="true" />
          <span className="sp-env-text">{r.text}</span>
          {r.action && <><span className="sp-env-sep" aria-hidden="true">·</span>{r.action}</>}
          {r.progress != null && <span className="sp-env-progress"><ProgressBar value={r.progress} indeterminate={!(r.progress > 0)} /></span>}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 示例卡：还没有项目时放在「最近项目」的位置，点一下就打开带初剪的示例
// ---------------------------------------------------------------------------
// 示例 7 个镜头的时长（秒），卡片上画成一条迷你时间线
const SAMPLE_BARS = [4.5, 3.5, 4, 5, 4, 5, 4];

function SampleCard({ busy, disabled, onOpen }) {
  return (
    <button type="button" className={'sp-sample-card' + (busy ? ' busy' : '')} disabled={disabled} onClick={onOpen} title="打开示例项目">
      <span className="sp-sample-thumb" aria-hidden="true">
        <span className="sp-sample-play"><Icon name="play" size={16} /></span>
        <span className="sp-sample-track">
          {SAMPLE_BARS.map((d, i) => <i key={i} style={{ flexGrow: d }} />)}
        </span>
        <span className="sp-sample-badge">示例</span>
        {busy && <span className="sp-sample-loading"><Spinner ai /></span>}
      </span>
      <span className="sp-sample-info">
        <span className="sp-sample-name">咖啡店宣传片</span>
        <span className="sp-sample-meta">7 个镜头 · 30 秒 · 已配好实拍和初剪</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
    }
    const close = (e) => { if (!ref.current || !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [x, y, onClose]);

  return (
    <div ref={ref} className="ctx-menu" role="menu" style={pos}>
      {items.map((it) => (
        <button key={it.label} type="button" role="menuitem" className={'ctx-item' + (it.danger ? ' danger' : '')} onClick={() => { onClose(); it.onClick(); }}>
          <Icon name={it.icon} size={14} />
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 最近项目卡片
// ---------------------------------------------------------------------------
function ProjectCard({ item, nonce, busy, isLast, onOpen, onMenu }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [item.thumb, nonce]);
  const src = item.thumb && !broken ? `${api.mediaUrl(item.thumb)}?v=${nonce}` : null;
  const clips = Number(item.clipCount) || 0;
  const duration = Number(item.duration) || 0;
  return (
    <div
      className={'proj-card' + (busy ? ' busy' : '')}
      role="button"
      tabIndex={0}
      title={`打开「${item.name}」`}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item); }
        else if (e.key === 'ContextMenu') { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); onMenu(item, r.left + 24, r.top + 24); }
      }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(item, e.clientX, e.clientY); }}
    >
      <div className="proj-thumb">
        {src
          ? <img src={src} alt="" draggable={false} onError={() => setBroken(true)} />
          : <span className="proj-thumb-empty"><Icon name="film" size={26} stroke={1.3} /></span>}
        {duration > 0 && <span className="proj-duration mono">{fmtTime(duration, false)}</span>}
        {isLast && <span className="proj-last">上次打开</span>}
        {busy && <span className="proj-loading"><Spinner /></span>}
      </div>
      <div className="proj-info">
        <div className="proj-text">
          <div className="proj-name ellipsis">{item.name || '未命名项目'}</div>
          <div className="proj-meta ellipsis">
            {clips > 0 ? `${clips} 个片段` : '时间线为空'}
            <span className="proj-meta-sep">·</span>
            {relativeTime(item.updatedAt) || '时间未知'}
          </div>
        </div>
        <button
          type="button"
          className="proj-more"
          title="更多操作"
          aria-label="更多操作"
          onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onMenu(item, r.left, r.bottom + 4); }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Icon name="dots" size={16} stroke={2.6} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 启动页
// ---------------------------------------------------------------------------
export default function StartPage({ onOpenLibrary }) {
  const projectList = useStore((s) => s.projectList);
  const lastProjectId = useStore((s) => (s.settings && s.settings.ui ? s.settings.ui.lastProjectId : ''));
  const openDialog = useStore((s) => s.openDialog);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(null); // 'sample' | 'import' | 项目 id
  const [menu, setMenu] = useState(null); // { item, x, y }
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    useStore.getState().refreshProjects();
    useStore.getState().refreshSettings(); // 「上次打开」标记依赖最新的 ui.lastProjectId
    return () => { mounted.current = false; };
  }, []);

  // 缩略图可能在项目列表刷新前后被覆盖，用列表变化作为缓存击穿参数
  const nonce = useMemo(() => Date.now(), [projectList]);
  const closeMenu = useMemo(() => () => setMenu(null), []);
  const done = () => { if (mounted.current) setBusy(null); };

  const openItem = async (item) => {
    if (busy) return;
    setBusy(item.id);
    try {
      await useStore.getState().openProject(item.id);
    } catch (e) {
      toast(`打开「${item.name}」失败：${e.message}`, 'error');
    } finally {
      done();
    }
  };

  const createSample = async () => {
    if (busy) return;
    setBusy('sample');
    try {
      // 直接把 appInfo 交给示例：创作模式的模块还没加载时，也能找到随安装包附带的实拍素材
      const seed = createSampleProject({ appInfo: useStore.getState().appInfo });
      const st = useStore.getState();
      await st.newProject({ project: seed, name: seed.name || '示例：咖啡店宣传片', aspect: seed.settings && seed.settings.aspect });
      const r = useStore.getState().commit((p) => buildFirstCut(p).project, '示例初剪');
      useStore.getState().setMode('create');
      if (r.ok) toast('示例已就绪，看完分镜点右下角进入剪辑', 'ok', 4000, { key: 'sample-ready' });
      else toast('示例已创建，但初剪没有完成：' + (r.errors || []).join('；'), 'warn');
    } catch (e) {
      toast('创建示例项目失败：' + e.message, 'error');
    } finally {
      done();
    }
  };

  const importJson = async () => {
    if (busy) return;
    setBusy('import');
    try {
      const files = await api.call('dialog:openFiles', { title: '导入项目文件', multi: false, filters: PROJECT_FILTERS });
      if (!files || !files.length) return;
      const imported = await api.call('project:importJson', { path: files[0] });
      if (!imported) throw new Error('文件里没有可用的项目数据');
      const st = useStore.getState();
      await st.refreshProjects();
      const exists = imported.id && useStore.getState().projectList.some((p) => p.id === imported.id);
      if (exists) await st.openProject(imported.id);
      else {
        await st.newProject({ project: imported, name: imported.name });
        // newProject 不登记媒体路径，导入的项目需要手动登记才能读取素材
        const paths = Object.values(imported.assets || {}).map((a) => a && a.path).filter(Boolean);
        if (paths.length) await api.call('media:register', { paths }).catch(() => {});
      }
      toast(`已导入项目「${imported.name || '未命名项目'}」`, 'ok');
    } catch (e) {
      toast('导入项目失败：' + e.message, 'error');
    } finally {
      done();
    }
  };

  const exportJson = async (item) => {
    try {
      const path = await api.call('dialog:saveFile', { title: '导出项目文件', defaultPath: `${safeFileName(item.name)}.ffproj`, filters: [{ name: '镜流项目文件', extensions: ['ffproj'] }] });
      if (!path) return;
      const project = await api.call('project:load', { id: item.id });
      const saved = (await api.call('project:exportJson', { project, path })) || path;
      toast('项目文件已导出（只含工程本身，不含视频素材文件）', 'ok', 6000, {
        key: 'project-export',
        action: { label: '在文件夹中显示', run: () => { api.call('shell:showItem', { path: saved }).catch(() => {}); } },
      });
    } catch (e) {
      toast('导出项目失败：' + e.message, 'error');
    }
  };

  const doDelete = async () => {
    const item = confirmDelete;
    if (!item || deleting) return;
    setDeleting(true);
    try {
      await api.call('project:delete', { id: item.id });
      await useStore.getState().refreshProjects();
      toast(`已删除「${item.name}」`, 'ok');
      setConfirmDelete(null);
    } catch (e) {
      toast('删除失败：' + e.message, 'error');
    } finally {
      setDeleting(false);
    }
  };

  const list = Array.isArray(projectList) ? projectList : [];

  return (
    <div className="start-page">
      <div className="start-inner">
        <header className="sp-brandbar">
          <Logo size={30} />
          <span className="sp-brandname">镜流 <b>Frameflow</b></span>
          <span className="grow" />
          <Button variant="ghost" size="sm" icon="settings" onClick={() => openDialog('settings')}>设置</Button>
          <Button variant="ghost" size="sm" icon="help" onClick={() => openDialog('help')}>帮助</Button>
        </header>

        <section className="sp-hero">
          <div className="sp-hero-main">
            <h1>不会剪辑，也能把想法拍成片</h1>
            <p className="sp-lead">用大白话告诉 AI 导演你想拍什么，它帮你写分镜、配上真人实拍画面，再在时间线上像剪映一样精修成片。</p>
            <div className="sp-actions">
              <Button variant="primary" size="lg" icon="plus" onClick={() => openDialog('newProject')} disabled={!!busy}>新建项目</Button>
              <Button variant="ai" size="lg" icon={busy === 'sample' ? undefined : 'sparkles'} onClick={createSample} disabled={!!busy} data-sample="hero">
                {busy === 'sample' ? <><Spinner ai /> 正在准备示例…</> : '示例：咖啡店宣传片'}
              </Button>
            </div>
            {/* 按钮的 title 会变成无障碍名称，这里不加，保持和看到的文字一致 */}
            <div className="sp-subactions">
              <Button variant="ghost" size="sm" icon="book" onClick={onOpenLibrary} disabled={!!busy}>打开拆片库</Button>
              <Button variant="ghost" size="sm" icon={busy === 'import' ? undefined : 'upload'} onClick={importJson} disabled={!!busy}>
                {busy === 'import' ? <><Spinner /> 导入中…</> : '导入项目文件'}
              </Button>
            </div>
            <EnvNotices />
          </div>
        </section>

        <FlowSteps />
        <p className="sp-honest">
          <Icon name="eye" size={13} /> 画面优先使用你拍的视频和可商用实拍素材；动画预演只在缺素材时临时占位，导出会带「示意」水印。
        </p>

        <section className="sp-recent">
          <div className="sp-section-head">
            <h2>最近项目</h2>
            {list.length > 0 && <span className="muted small">{list.length} 个项目 · 右键查看更多操作</span>}
          </div>
          {list.length === 0 ? (
            <div className="proj-grid sp-empty-grid">
              <SampleCard busy={busy === 'sample'} disabled={!!busy} onOpen={createSample} />
              <button type="button" className="sp-new-card" onClick={() => openDialog('newProject')} disabled={!!busy}>
                <span className="sp-new-icon" aria-hidden="true"><Icon name="plus" size={22} /></span>
                <span className="sp-new-title">新建项目</span>
                <span className="sp-new-desc">从一句话想法开始</span>
              </button>
              <p className="sp-empty-hint">还没有自己的项目。先打开示例看看成片怎么做出来，或者直接新建一个。</p>
            </div>
          ) : (
            <div className="proj-grid">
              {list.map((item) => (
                <ProjectCard
                  key={item.id}
                  item={item}
                  nonce={nonce}
                  busy={busy === item.id}
                  isLast={item.id === lastProjectId}
                  onOpen={openItem}
                  onMenu={(it, x, y) => setMenu({ item: it, x, y })}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            { label: '打开', icon: 'folder', onClick: () => openItem(menu.item) },
            { label: '导出项目文件', icon: 'download', onClick: () => exportJson(menu.item) },
            { label: '删除', icon: 'trash', danger: true, onClick: () => setConfirmDelete(menu.item) },
          ]}
        />
      )}

      {confirmDelete && (
        <Modal
          title="删除项目"
          onClose={deleting ? undefined : () => setConfirmDelete(null)}
          className="confirm-modal"
          footer={(
            <>
              <Button onClick={() => setConfirmDelete(null)} disabled={deleting}>取消</Button>
              <Button variant="danger" icon={deleting ? undefined : 'trash'} onClick={doDelete} disabled={deleting}>
                {deleting ? <><Spinner /> 删除中…</> : '确认删除'}
              </Button>
            </>
          )}
        >
          <p className="confirm-text">确定删除「<b>{confirmDelete.name || '未命名项目'}</b>」吗？</p>
          <p className="hint">项目文件和它的缓存会被删除，且无法恢复。你导入的原始视频文件不受影响。</p>
        </Modal>
      )}
    </div>
  );
}
