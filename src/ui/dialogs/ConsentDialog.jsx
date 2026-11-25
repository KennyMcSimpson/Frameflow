// 视频站使用须知的同意框（契约 C4）。App.jsx 里挂载一次 <ConsentHost />。
// 任何会访问视频站的操作遇到主进程 NEED_CONSENT 时，由 ui/consent.js 的 withConsent 唤起这里。
import React, { useEffect, useRef, useState } from 'react';
import { Button, Icon, Modal } from '../components/ui.jsx';
import { answerConsent, subscribeConsent } from '../consent.js';

const POINTS = [
  { icon: 'download', text: '视频站功能使用开源工具 yt-dlp 解析和下载视频，只用于你本人的学习与分析。' },
  { icon: 'info', text: '视频的版权归原作者或平台所有。请确认你已获得授权或属于合理使用（如《著作权法》第二十四条规定的个人学习、研究），并遵守相应网站的用户协议。' },
  { icon: 'lock', text: '本软件不会绕过付费、会员、地区限制或版权保护措施，也不会读取浏览器登录信息或去除水印。' },
  { icon: 'alert', text: '下载的内容会标记为「仅供学习」。公开发布、商用或二次传播产生的法律责任由你自己承担，导出时也会再次提醒。' },
];

const S = {
  lead: { margin: '0 0 var(--space-3, 12px)', color: 'var(--text-1)', lineHeight: 1.6 },
  list: { display: 'flex', flexDirection: 'column', gap: 10, margin: 0, padding: 0, listStyle: 'none' },
  item: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 'var(--radius-s)', background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-0)', lineHeight: 1.6 },
  icon: { flex: 'none', marginTop: 2, color: 'var(--accent)' },
  check: { display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 14, padding: '10px 12px', borderRadius: 'var(--radius-s)', border: '1px solid var(--accent-line)', background: 'var(--accent-soft)', color: 'var(--text-0)', cursor: 'pointer', lineHeight: 1.5 },
  box: { flex: 'none', width: 16, height: 16, marginTop: 2, accentColor: 'var(--accent)', cursor: 'pointer' },
  foot: { display: 'flex', alignItems: 'center', gap: 8, width: '100%' },
  hint: { flex: 1, color: 'var(--text-2)', fontSize: 'var(--fs-xs)' },
};

function ConsentDialog({ onAnswer }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => { boxRef.current?.focus(); }, []);

  const answer = async (agreed) => {
    if (busy) return;
    if (agreed && !checked) return;
    setBusy(true);
    try { await onAnswer(agreed); } finally { setBusy(false); }
  };

  return (
    <Modal
      title='使用"视频站解析"前，请阅读并同意'
      onClose={() => answer(false)}
      className="consent-dialog"
      footer={(
        <div style={S.foot}>
          <span style={S.hint}>{checked ? '同意后本机会记住，不再重复询问' : '勾选上方说明后才能继续'}</span>
          <Button onClick={() => answer(false)} disabled={busy}>取消</Button>
          <Button variant="primary" onClick={() => answer(true)} disabled={!checked || busy}>{busy ? '正在记录…' : '同意并继续'}</Button>
        </div>
      )}
    >
      <p style={S.lead}>B站、YouTube 等视频站上的内容可以用来学习拍法、分析节奏。开始之前，请先了解以下几点：</p>
      <ol style={S.list}>
        {POINTS.map((p, i) => (
          <li key={i} style={S.item}>
            <span style={S.icon}><Icon name={p.icon} size={15} /></span>
            <span>{p.text}</span>
          </li>
        ))}
      </ol>
      <label style={S.check}>
        <input
          ref={boxRef}
          type="checkbox"
          style={S.box}
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          onKeyDown={(e) => { if (e.key === 'Enter' && checked) answer(true); }}
        />
        <span>我已阅读并理解以上说明，承诺只在合法授权的范围内使用</span>
      </label>
    </Modal>
  );
}

export function ConsentHost() {
  const [req, setReq] = useState(null);
  useEffect(() => subscribeConsent(setReq), []);
  if (!req) return null;
  // key 变化时重新挂载，复选框回到未勾选
  return <ConsentDialog key={req.key} onAnswer={answerConsent} />;
}

export default ConsentHost;
