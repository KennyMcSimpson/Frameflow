'use strict';
// URL 安全校验：拦截内网/环回/链路本地地址，防止 SSRF 与凭据泄露到不可信主机。
const dns = require('node:dns');
const path = require('node:path');

const UNC_RE = /^[\\/]{2}/;

/**
 * 判断路径是否为 UNC 网络路径（拦截 \\host、//host、\/host、/\host 及解析后落为 UNC 的路径）。
 */
function isUncPath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (UNC_RE.test(p)) return true;
  const trimmed = p.trim();
  if (!trimmed) return false;
  if (UNC_RE.test(trimmed)) return true;
  try {
    if (UNC_RE.test(path.resolve(trimmed))) return true;
    if (trimmed !== p && UNC_RE.test(path.resolve(p))) return true;
  } catch {
    return true;
  }
  return false;
}

function parseIpv4Part(part) {
  if (!part) return null;
  if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part, 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part, 8);
  if (/^(?:0|[1-9]\d*)$/.test(part)) return parseInt(part, 10);
  return null;
}

/** 解析 IPv4（支持标准点分十进制及 WHATWG 允许的简写/十六进制/八进制/整数形式），返回 [a,b,c,d] 或 null */
function parseIpv4(host) {
  if (!host) return null;
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    const n = parseIpv4Part(p);
    if (n == null || !Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  const last = nums[nums.length - 1];
  const maxLast = 256 ** (5 - nums.length);
  if (last >= maxLast) return null;
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] > 255) return null;
  }
  let val = last;
  for (let i = 0; i < nums.length - 1; i++) {
    val += nums[i] * (256 ** (3 - i));
  }
  return [
    (val >>> 24) & 0xff,
    (val >>> 16) & 0xff,
    (val >>> 8) & 0xff,
    val & 0xff,
  ];
}

function isPrivateIpv4Octets(a, b, c, d) {
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (RFC 6598 / 阿里云元数据 100.100.100.200)
  if (a === 127) return true;                        // 127.0.0.0/8
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true;  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && c === 2) return true;  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && b === 51 && c === 100) return true;  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true;   // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224 && a <= 239) return true;             // 224.0.0.0/4 (Multicast)
  if (a >= 240) return true;                         // 240.0.0.0/4 (Reserved & Broadcast 255.255.255.255)
  return false;
}

/** 展开 IPv6 为 8 个 16-bit 整数数组，失败返回 null */
function parseIpv6(raw) {
  if (!raw || !raw.includes(':')) return null;
  let s = raw.split('%')[0].toLowerCase();
  // 处理末尾内嵌 IPv4，例如 ::ffff:127.0.0.1
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (part) => {
    if (!part) return [];
    const segs = part.split(':');
    const out = [];
    for (const seg of segs) {
      if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
      out.push(parseInt(seg, 16));
    }
    return out;
  };
  const left = parseHalf(halves[0]);
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = parseHalf(halves[1]);
  if (!right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

function isPrivateIpv6Groups(g) {
  // :: (unspecified) 与 ::1 (loopback)
  const prefix6Zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  if (prefix6Zero && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;
  // IPv4-compatible (::a.b.c.d)
  if (prefix6Zero) {
    return isPrivateIpv4Octets(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff);
  }
  // ::ffff:0:0/96 (IPv4-mapped IPv6，WHATWG URL 会把 ::ffff:127.0.0.1 规范成 ::ffff:7f00:1)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isPrivateIpv4Octets(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff);
  }
  // ::ffff:0:0:0/96 (IPv4-translated, RFC 2765)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) return true;
  // 64:ff9b::/96 (Well-Known NAT64, RFC 6052)
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return true;
  // 64:ff9b:1::/48 (Local-Use NAT64, RFC 8215)
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) return true;
  // 100::/64 (Discard-Only, RFC 6666)
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
  // 2001::/32 (Teredo, RFC 4380)
  if (g[0] === 0x2001 && g[1] === 0x0000) return true;
  // 2001:db8::/32 (Documentation, RFC 3849)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  // 2002::/16 (6to4, RFC 3056)
  if (g[0] === 0x2002) return true;
  // fc00::/7 (Unique Local Address: fc00:: - fdff::)
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (Link-Local: fe80:: - febf::)
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // fec0::/10 (Deprecated Site-Local: fec0:: - feff::)
  if ((g[0] & 0xffc0) === 0xfec0) return true;
  // ff00::/8 (Multicast)
  if ((g[0] & 0xff00) === 0xff00) return true;
  return false;
}

function isPrivateIPv4(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.+$/, '');
  const v4 = parseIpv4(h);
  return v4 ? isPrivateIpv4Octets(v4[0], v4[1], v4[2], v4[3]) : false;
}

function isPrivateIPv6(host) {
  let h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/\.+$/, '');
  const g = parseIpv6(h);
  return g ? isPrivateIpv6Groups(g) : false;
}

/**
 * 判断主机名是否为本机 / 内网 / 链路本地 / 保留地址。
 * 支持 localhost、*.localhost、IPv4 私有/环回/链路本地/CGNAT/保留/多播、IPv6 保留/映射/NAT64/本地/多播地址。
 */
function isPrivateHost(hostname) {
  let h = String(hostname || '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/\.+$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.includes(':')) {
    const g = parseIpv6(h);
    return g ? isPrivateIpv6Groups(g) : true;
  }
  const v4 = parseIpv4(h);
  if (v4) return isPrivateIpv4Octets(v4[0], v4[1], v4[2], v4[3]);
  return false;
}

function isIpLiteral(hostname) {
  let h = String(hostname || '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/\.+$/, '');
  if (!h) return false;
  if (h.includes(':')) return parseIpv6(h) !== null;
  return parseIpv4(h) !== null;
}

function normalizeOrigins(allowedOrigins) {
  const out = new Set();
  if (!allowedOrigins) return out;
  for (const item of allowedOrigins) {
    if (!item) continue;
    try {
      const u = new URL(String(item));
      if (u.protocol === 'http:' || u.protocol === 'https:') out.add(u.origin);
    } catch {}
  }
  return out;
}

/**
 * 校验网址是否为安全的公网 http(s) 地址；若精确命中 allowedOrigins（如测试或用户自配本地代理），则放行。
 * 返回解析后的 URL 对象；不安全或格式错误时抛错（err.code = 'UNSAFE_URL' | 'BAD_URL'）。
 */
function assertSafePublicUrl(urlStr, { allowedOrigins = [] } = {}) {
  let u;
  try {
    u = new URL(String(urlStr || ''));
  } catch {
    const err = new Error('网址格式无效');
    err.code = 'BAD_URL';
    throw err;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const err = new Error('仅支持 http 或 https 协议的网址');
    err.code = 'UNSAFE_URL';
    throw err;
  }
  const allowed = normalizeOrigins(allowedOrigins);
  if (allowed.has(u.origin)) return u;
  if (isPrivateHost(u.hostname)) {
    const err = new Error('不允许访问本机或内网地址');
    err.code = 'UNSAFE_URL';
    throw err;
  }
  return u;
}

/**
 * 异步校验网址：先运行 assertSafePublicUrl，再对非 IP、非 allowedOrigins 的域名做 DNS 解析，
 * 只要任一解析结果落在私有/保留网段即拒绝（防止 DNS 重绑定或内网域名 SSRF）。
 */
async function assertSafePublicUrlAsync(urlStr, { allowedOrigins = [], lookup } = {}) {
  const u = assertSafePublicUrl(urlStr, { allowedOrigins });
  const allowed = normalizeOrigins(allowedOrigins);
  if (allowed.has(u.origin)) return u;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host || isIpLiteral(host)) return u;

  const lookupFn = typeof lookup === 'function'
    ? lookup
    : ((h, opts) => dns.promises.lookup(h, opts));
  let records;
  try {
    records = await lookupFn(host, { all: true });
  } catch (e) {
    const err = new Error('无法解析目标主机地址');
    err.code = (e && e.code) || 'DNS_FAILED';
    throw err;
  }
  const list = Array.isArray(records) ? records : (records ? [records] : []);
  if (!list.length) {
    const err = new Error('域名未解析到有效地址，已拒绝访问');
    err.code = 'UNSAFE_URL';
    throw err;
  }
  for (const rec of list) {
    const addr = typeof rec === 'string' ? rec : (rec && rec.address);
    if (!addr || isPrivateHost(addr)) {
      const err = new Error('不允许访问解析到本机或内网地址的域名');
      err.code = 'UNSAFE_URL';
      throw err;
    }
  }
  return u;
}

function effectivePort(parsed) {
  return parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
}

function matchesTrustedHost(host, rawEntry) {
  const entry = String(rawEntry || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!entry || !host) return false;
  if (entry.startsWith('.')) {
    const bare = entry.replace(/^\.+/, '');
    if (!bare) return false;
    return host === bare || host.endsWith('.' + bare);
  }
  return host === entry;
}

/**
 * 判断目标 URL 是否属于某个 baseUrl（或其受信任官方主机/后缀）的可信主机，用于决定是否允许携带鉴权头。
 * - 同源匹配严格要求同协议、同规范主机名、同有效端口（http:80 与 https:443 绝不互认）。
 * - extraTrustedHosts 支持精确主机名（如 'queue.fal.run'）或以 '.' 开头的域名后缀（如 '.fal.run'），
 *   且仅当 baseUrl 自身也是默认 443 端口的 https 官方主机并命中该列表时才生效（防止自定义私有代理把凭据发给第三方）。
 */
function isTrustedHostForBase(urlStr, baseUrl, extraTrustedHosts = []) {
  let u;
  let b;
  try {
    u = new URL(String(urlStr || ''));
    b = new URL(String(baseUrl || ''));
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (b.protocol !== 'http:' && b.protocol !== 'https:') return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  const uh = u.hostname.toLowerCase().replace(/\.+$/, '');
  const bh = b.hostname.toLowerCase().replace(/\.+$/, '');
  if (!uh || !bh) return false;

  const uPort = effectivePort(u);
  const bPort = effectivePort(b);
  if (u.protocol === b.protocol && uh === bh && uPort === bPort) return true;

  const list = Array.isArray(extraTrustedHosts) ? extraTrustedHosts : [];
  if (!list.length) return false;
  if (u.protocol !== 'https:' || b.protocol !== 'https:') return false;
  if (uPort !== '443' || bPort !== '443') return false;
  if (isPrivateHost(uh) || isPrivateHost(bh)) return false;
  if (!list.some((entry) => matchesTrustedHost(bh, entry))) return false;
  return list.some((entry) => matchesTrustedHost(uh, entry));
}

module.exports = {
  isUncPath,
  isPrivateHost,
  isPrivateIPv4,
  isPrivateIPv6,
  assertSafePublicUrl,
  assertSafePublicUrlAsync,
  isTrustedHostForBase,
};
