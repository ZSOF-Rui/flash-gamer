const { BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureDir, sha1, isSwf, humanSize } = require('./util');
const { fetchBinary, UA } = require('./fetcher');

const { AD_HOSTS, isBlockedHost } = require('./blocklist');
const isAdHost = isBlockedHost;


function cleanTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/^[\s,.，、|｜]+/, '')
    .replace(/[,，、_|｜].*$/, '')
    .replace(/\s*[-–—]\s*(4399|7k7k|小游戏).*$/i, '')
    .replace(/小游戏.*$/, '')
    .trim();
}

function decodeMaybe(buf) {
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad > 20) {
    try { return new TextDecoder('gb18030').decode(buf); } catch {}
  }
  return utf8;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const MULTI_SUFFIX = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'com.hk', 'com.tw', 'co.uk', 'co.jp']);

function siteOf(hostname) {
  const labels = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const last2 = labels.slice(-2).join('.');
  return MULTI_SUFFIX.has(last2) ? labels.slice(-3).join('.') : last2;
}

// 4399/7k7k 页面里常夹带对方的广告 SWF，跨站文件直接判负分。
function siteScore(pageSite, candidateUrl) {
  let host;
  try { host = new URL(candidateUrl).hostname.toLowerCase(); } catch { return 0; }
  const candSite = siteOf(host);
  if (pageSite && candSite === pageSite) return 2;
  if (pageSite && host.includes(pageSite.split('.')[0])) return 1;
  if (candSite !== pageSite && (pageSite === '4399.com' || pageSite === '7k7k.com')
    && (candSite === '4399.com' || candSite === '7k7k.com')) return -2;
  return 0;
}

// 4399 每个游戏页都会带一个 3KB 的 cell.swf 广告占位，不能入库
function isAdSwf(url) {
  try {
    const u = new URL(url);
    return /(^|\.)4399\.com$/i.test(u.hostname) && /\/flash\/cell\.swf$/i.test(u.pathname);
  } catch { return false; }
}

function looksHtml(buf, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('xhtml')) return true;
  const head = buf.slice(0, 400).toString('latin1').trim().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || /^<\?xml[^>]*>\s*<html/.test(head);
}

// 4399 部分游戏的 _strGamePath 指向一个 HTML 包装页，真正的 SWF 以相对路径嵌在里面
function swfRefsFromHtml(text, baseUrl) {
  const refs = [];
  const add = (raw) => {
    let u = String(raw || '').trim().replace(/&amp;/g, '&');
    if (!u || /^(javascript|data):/i.test(u)) return;
    if (u.startsWith('//')) u = `https:${u}`;
    try { u = new URL(u, baseUrl).href; } catch { return; }
    if (!/\.swf(?:$|[?#])/i.test(u)) return;
    if (!refs.includes(u)) refs.push(u);
  };
  let m;
  const attrRe = /(?:src|value|movie|data|url|file)\s*=\s*["']?([^"'\s>]+\.swf[^"'\s>]*)/gi;
  while ((m = attrRe.exec(text))) add(m[1]);
  const strRe = /["']([^"'\s<>]+?\.swf(?:\?[^"'\s<>]*)?)["']/gi;
  while ((m = strRe.exec(text))) add(m[1]);
  const absRe = /((?:https?:)?\/\/[^"'\s<>()]+?\.swf(?:\?[^"'\s<>()]*)?)/gi;
  while ((m = absRe.exec(text))) add(m[1]);
  return refs;
}

async function inspectPage({ pageUrl, tmpDir, onProgress = () => {}, timeoutMs = 26000 }) {
  const parsed = new URL(pageUrl);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('只支持 http/https 链接');
  parsed.hash = '';

  const started = Date.now();
  const tag = `capture-${Date.now().toString(36)}`;
  const outDir = ensureDir(path.join(tmpDir, tag));

  const ses = session.fromPartition(tag);
  ses.setUserAgent(UA);

  const observed = new Map();
  const reqMeta = new Map();
  let lastActivity = Date.now();
  const bump = () => { lastActivity = Date.now(); };

  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    bump();
    try {
      const h = new URL(details.url).hostname;
      if (isAdHost(h)) return callback({ cancel: true });
    } catch {}
    callback({});
  });

  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const h = details.requestHeaders || {};
    reqMeta.set(details.id, {
      referer: h.Referer || h.referer || '',
      cookie: h.Cookie || h.cookie || '',
      method: details.method
    });
    callback({ requestHeaders: details.requestHeaders });
  });

  ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
    bump();
    const headers = details.responseHeaders || {};
    const get = (k) => {
      const key = Object.keys(headers).find((x) => x.toLowerCase() === k);
      const v = key ? headers[key] : '';
      return Array.isArray(v) ? v[0] : v || '';
    };
    const ct = String(get('content-type'));
    const url = details.url;
    const looksSwf = /\.swf(\.|$|\?)/i.test(url) || /shockwave-flash/i.test(ct);
    if (looksSwf && !observed.has(url)) {
      const meta = reqMeta.get(details.id) || {};
      observed.set(url, {
        url,
        contentType: ct || 'application/x-shockwave-flash',
        contentLength: Number(get('content-length')) || 0,
        status: details.statusCode,
        referer: meta.referer || pageUrl,
        cookie: meta.cookie || '',
        method: meta.method || 'GET',
        via: 'capture'
      });
      onProgress({ type: 'log', text: `发现 SWF：${url.split('/').pop().slice(0, 48)}` });
    }
    callback({ responseHeaders: details.responseHeaders });
  });

  ses.webRequest.onCompleted({ urls: ['*://*/*'] }, bump);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      images: true
    }
  });
  win.webContents.setAudioMuted(true);

  await win.loadURL(parsed.href, { userAgent: UA }).catch((e) => {
    onProgress({ type: 'log', text: `页面加载中断：${e.message}` });
  });

  const waitIdle = async (idleMs, hardMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < hardMs && Date.now() - started < timeoutMs + 12000) {
      if (Date.now() - lastActivity > idleMs) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  await waitIdle(1800, 8000);
  onProgress({ type: 'log', text: '页面已载入，等待游戏初始化…' });

  try {
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const hit = [...document.querySelectorAll('a,button,div,span')].filter((el) => {
        const t = (el.textContent || '').trim();
        const s = getComputedStyle(el);
        return /^(开始游戏|开始|立即游戏|进入游戏|play|start)$/i.test(t) && el.offsetParent && s.visibility !== 'hidden';
      });
      if (hit[0]) { hit[0].click(); return true; }
      return false;
    })()`, true);
    if (clicked) onProgress({ type: 'log', text: '已触发页面上的“开始游戏”' });
  } catch {}

  await waitIdle(2600, 10000);

  let hints = {};
  try {
    hints = await win.webContents.executeJavaScript(`(() => {
      const abs = (u) => { try { return u ? new URL(u, location.href).href : null; } catch { return u || null; } };
      // 4399 页面常先放一个 1x1 的 objtest.swf 探测 Flash，真正的游戏 embed 在其后；
      // 只读第一个 embed 会把探测文件当成游戏。这里收集全部并跳过探测文件。
      const isProbe = (u) => /objtest|checkflash|flashdetect/i.test(u || '');
      const embeds = [...document.querySelectorAll('embed')]
        .map((e) => ({ src: abs(e.getAttribute('src')), fv: e.getAttribute('flashvars') }))
        .filter((x) => x.src);
      const movies = [...document.querySelectorAll('object param[name="movie"]')]
        .map((p) => ({ src: abs(p.getAttribute('value')), fv: (p.parentElement && p.parentElement.querySelector('param[name="FlashVars"]') && p.parentElement.querySelector('param[name="FlashVars"]').getAttribute('value')) || null }))
        .filter((x) => x.src);
      const goodEmbeds = embeds.filter((x) => !isProbe(x.src));
      const goodMovies = movies.filter((x) => !isProbe(x.src));
      const embed = goodEmbeds[0] || embeds[0] || null;
      const movie = goodMovies[0] || movies[0] || null;
      const og = document.querySelector('meta[property="og:image"]');
      const html = document.documentElement.outerHTML;
      let htmlPath = null;
      const gm = html.match(/gamePath\\s*[:=]\\s*["']([^"']+)["']/i);
      if (gm) htmlPath = gm[1];
      const swfUrls = [];
      const re = /(?:https?:)?\\/\\/[^"'\\s<>()]+?\\.swf(?:\\?[^"'\\s<>()]*)?/gi;
      let sm;
      while ((sm = re.exec(html)) && swfUrls.length < 24) {
        if (!swfUrls.includes(sm[0])) swfUrls.push(sm[0]);
      }
      return {
        title: document.title || '',
        declared: {
          strPath: window._strGamePath || null,
          winPath: window._gamePath || null,
          htmlPath
        },
        width: window._w || window._gameW || null,
        height: window._h || window._gameH || null,
        cover: (og && og.getAttribute('content')) || window._strGamePic || null,
        embedSrc: embed ? embed.src : null,
        objectMovie: movie ? movie.src : null,
        embedSrcs: goodEmbeds.map((x) => x.src),
        objectMovies: goodMovies.map((x) => x.src),
        flashvars: (embed && embed.fv) || (movie && movie.fv) || null,
        swfUrls,
        hasH5: !!document.querySelector('script[src*="h5"], iframe[src*="h5"]')
      };
    })()`, true).catch(() => ({}));
  } catch {}

  const observedList = [...observed.values()].filter((c) => c.status >= 200 && c.status < 400);
  try { win.destroy(); } catch {}

  const downloads = [];
  const seen = new Set();

  const pushCandidate = (c) => {
    if (!c.url || seen.has(c.url)) return;
    if (!/^https?:/i.test(c.url)) return;
    if (isAdSwf(c.url)) return;
    if (/objtest|checkflash|flashdetect/i.test(c.url)) return;
    seen.add(c.url);
    downloads.push(c);
  };

  for (const u of hints.embedSrcs || []) pushCandidate({ url: u, via: 'embed', referer: pageUrl, cookie: observedList[0]?.cookie || '' });
  for (const u of hints.objectMovies || []) pushCandidate({ url: u, via: 'object', referer: pageUrl, cookie: observedList[0]?.cookie || '' });
  if (hints.embedSrc) pushCandidate({ url: hints.embedSrc, via: 'embed', referer: pageUrl, cookie: observedList[0]?.cookie || '' });
  if (hints.objectMovie) pushCandidate({ url: hints.objectMovie, via: 'object', referer: pageUrl, cookie: observedList[0]?.cookie || '' });

  const pageSite = siteOf(parsed.hostname);
  const cookie0 = observedList[0]?.cookie || '';

  const pushDeclared = (raw, kind) => {
    let abs = String(raw || '').trim();
    if (!abs) return;
    if (abs.startsWith('//')) abs = `https:${abs}`;
    if (!/^https?:/i.test(abs)) {
      if (abs.startsWith('/') && kind === 'str') {
        // _strGamePath 是 4399 专有变量，站内相对路径要拼 4399 的 SWF CDN
        abs = `https://sxiao.4399.com/4399swf${abs}`;
      } else {
        try { abs = new URL(abs, parsed.href).href; } catch { return; }
      }
    }
    pushCandidate({ url: abs, via: 'declared', referer: pageUrl, cookie: cookie0 });
  };

  const d = hints.declared || {};
  if (pageSite === '4399.com') {
    pushDeclared(d.strPath, 'str');
    pushDeclared(d.winPath, 'win');
    if (!d.strPath && !d.winPath) pushDeclared(d.htmlPath, 'html');
  } else {
    pushDeclared(d.winPath, 'win');
    pushDeclared(d.htmlPath, 'html');
    // 7k7k 页面夹带的 4399 广告脚本也会定义 _strGamePath，收录后由跨站罚分排在末尾
    pushDeclared(d.strPath, 'str');
  }

  for (const raw of hints.swfUrls || []) {
    let abs = String(raw);
    if (abs.startsWith('//')) abs = `https:${abs}`;
    try { abs = new URL(abs, parsed.href).href; } catch { continue; }
    try {
      if (isAdHost(new URL(abs).hostname)) continue;
    } catch { continue; }
    pushCandidate({ url: abs, via: 'html', referer: pageUrl, cookie: observedList[0]?.cookie || '' });
  }

  observedList
    .sort((a, b) => (b.contentLength || 0) - (a.contentLength || 0))
    .slice(0, 10)
    .forEach(pushCandidate);

  onProgress({ type: 'log', text: `共 ${downloads.length} 个候选，开始校验文件…` });

  const saveSwf = (c, buf, contentType) => {
    const file = path.join(outDir, `${sha1(c.url).slice(0, 16)}.swf`);
    fs.writeFileSync(file, buf);
    return {
      ...c,
      ok: true,
      size: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      tempFile: file,
      contentType: contentType || c.contentType
    };
  };

  const results = await mapLimit(downloads.slice(0, 12), 3, async (c) => {
    try {
      const r = await fetchBinary(c.url, { referer: c.referer, cookie: c.cookie, timeout: 50000 });
      if (!r.ok) return { ...c, ok: false, reason: `HTTP ${r.status}` };
      if (isSwf(r.buf)) return saveSwf(c, r.buf, r.contentType);
      if (looksHtml(r.buf, r.contentType)) {
        const refs = swfRefsFromHtml(decodeMaybe(r.buf), c.url).filter((u) => !isAdSwf(u));
        c.wrapperRefs = refs;
        return { ...c, ok: false, reason: refs.length ? 'HTML 包装页' : '不是 SWF' };
      }
      return { ...c, ok: false, reason: '不是 SWF' };
    } catch (e) {
      return { ...c, ok: false, reason: String(e.message || e) };
    }
  });

  // 包装页里的真实 SWF：用包装页地址做 Referer，相对路径已按包装页 URL 展开
  const wrapperJobs = [];
  const wrapperSeen = new Set();
  for (const r of results) {
    for (const ref of r.wrapperRefs || []) {
      if (wrapperSeen.has(ref) || seen.has(ref)) continue;
      wrapperSeen.add(ref);
      wrapperJobs.push({ url: ref, via: 'wrapper', referer: r.url, cookie: r.cookie, wrapper: r.url });
    }
  }
  if (wrapperJobs.length) {
    onProgress({ type: 'log', text: `包装页内发现 ${wrapperJobs.length} 个 SWF，继续解析…` });
  }

  const wrapperResults = await mapLimit(wrapperJobs.slice(0, 8), 3, async (c) => {
    try {
      const r = await fetchBinary(c.url, { referer: c.referer, cookie: c.cookie, timeout: 80000 });
      if (!r.ok) return { ...c, ok: false, reason: `HTTP ${r.status}` };
      if (!isSwf(r.buf)) return { ...c, ok: false, reason: '不是 SWF' };
      return saveSwf(c, r.buf, r.contentType);
    } catch (e) {
      return { ...c, ok: false, reason: String(e.message || e) };
    }
  });

  const allResults = results.concat(wrapperResults);
  const basePrio = (c) => (c.via === 'declared' || c.via === 'wrapper' ? 4
    : c.via === 'embed' || c.via === 'object' ? 3 : c.via === 'capture' ? 2 : 1);
  const rankOf = (c) => {
    const rel = siteScore(pageSite, c.url);
    if (rel === -2) return -8000 + basePrio(c);
    return basePrio(c) * 1000 + rel * 150;
  };
  const okList = allResults.filter((r) => r.ok).sort((a, b) => (rankOf(b) - rankOf(a)) || (b.size - a.size));
  const dedup = [];
  const hashes = new Set();
  for (const r of okList) {
    if (hashes.has(r.sha256)) continue;
    hashes.add(r.sha256);
    dedup.push(r);
  }

  const failed = allResults.filter((r) => !r.ok && r.reason !== 'HTML 包装页');
  if (failed.length) {
    onProgress({ type: 'log', text: `${failed.length} 个候选无法下载（可能需要防盗链或已失效）` });
  }

  const cover = hints.cover || null;
  let coverUrl = cover;
  if (coverUrl && coverUrl.startsWith('//')) coverUrl = `https:${coverUrl}`;
  if (coverUrl && coverUrl.startsWith('/')) {
    try { coverUrl = new URL(coverUrl, parsed.href).href; } catch {}
  }

  return {
    pageUrl: parsed.href,
    rawTitle: hints.title || '',
    title: cleanTitle(hints.title) || parsed.hostname,
    width: Number(hints.width) || 0,
    height: Number(hints.height) || 0,
    coverUrl,
    hasH5: !!hints.hasH5,
    flashvars: hints.flashvars || null,
    candidates: dedup.map((c, i) => ({
      key: `c${i}`,
      url: c.url,
      size: c.size,
      sizeText: humanSize(c.size),
      tempFile: c.tempFile,
      contentType: c.contentType,
      referer: c.referer,
      cookie: c.cookie,
      via: c.via,
      crossSite: siteScore(pageSite, c.url) === -2,
      sha256: c.sha256
    })),
    rejected: failed.map((f) => ({ url: f.url, reason: f.reason })),
    elapsedMs: Date.now() - started
  };
}

module.exports = { inspectPage, AD_HOSTS };
