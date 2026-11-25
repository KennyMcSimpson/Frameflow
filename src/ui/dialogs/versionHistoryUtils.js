// 历史版本对话框用的纯函数（不依赖 React，便于单测）。

const pad2 = (n) => String(n).padStart(2, '0');

/** 毫秒时间戳 → 「刚刚 / 3 分钟前 / 2 小时前 / 5 天前」，超过 30 天返回空串 */
export function fmtAgo(t, now = Date.now()) {
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return '';
}

/**
 * 快照时间 → { main, rel }。
 * main：今天 14:32 / 昨天 09:10 / 11月3日 20:15 / 2025年11月3日 20:15（按本地时区）
 * rel：相对时间，见 fmtAgo
 */
export function fmtSnapshotTime(iso, now = Date.now()) {
  const d = new Date(iso);
  const t = d.getTime();
  if (!iso || !Number.isFinite(t)) return { main: '时间未知', rel: '' };
  const n = new Date(now);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((dayStart(n) - dayStart(d)) / 86400000);
  let main;
  if (dayDiff === 0) main = `今天 ${hm}`;
  else if (dayDiff === 1) main = `昨天 ${hm}`;
  else if (d.getFullYear() === n.getFullYear()) main = `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  else main = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return { main, rel: fmtAgo(t, now) };
}

/** 统一主进程返回的快照列表：丢掉无效项，字段补默认值，按时间新→旧排序 */
export function normalizeSnapshots(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && typeof s.snapshotId === 'string' && s.snapshotId)
    .map((s) => ({
      snapshotId: s.snapshotId,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : '',
      size: Math.max(0, Number(s.size) || 0),
      name: String(s.name || ''),
      clipCount: Math.max(0, Math.round(Number(s.clipCount) || 0)),
      duration: s.duration == null || !Number.isFinite(Number(s.duration)) ? null : Math.max(0, Number(s.duration)),
    }))
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
}

/** 主进程还没有这个接口（旧版本）时 ipc 报的错 */
export function isMissingHandler(err) {
  const msg = String((err && err.message) || err || '');
  return /No handler registered|not\s+registered|未知(的)?\s*(IPC|通道|接口)/i.test(msg);
}

/** 快照按日期分组：[{ label: '今天' | '昨天' | '11月3日', items }]，保持原顺序 */
export function groupSnapshotsByDay(list, now = Date.now()) {
  const groups = [];
  for (const s of list || []) {
    const { main } = fmtSnapshotTime(s.createdAt, now);
    const label = main.includes(' ') ? main.slice(0, main.lastIndexOf(' ')) : main;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(s);
    else groups.push({ label, items: [s] });
  }
  return groups;
}
