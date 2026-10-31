const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureDir, sha1, mimeFor } = require('./util');
const { UA } = require('./fetcher');
const { isBlockedUrl } = require('./blocklist');
const { extractInnerSwf } = require('./swf-embed');

const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' http: https:",
  "font-src 'self' data:"
].join('; ');

function listen(server, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onOk);
      reject(err);
    };
    const onOk = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(port, host);
  });
}

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
  res.end(buf);
}

function serveFile(req, res, file, type, extra = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
  if (!st.isFile()) return send(res, 404, 'not found');
  const total = st.size;
  const range = req.headers.range;
  const headers = {
    'Content-Type': type || mimeFor(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    ...extra
  };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start === null) { start = Math.max(0, total - (end ?? 0)); end = total - 1; }
      if (end === null || end >= total) end = total - 1;
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }
  headers['Content-Length'] = total;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function serveBuffer(req, res, buf, type, extra = {}) {
  const total = buf.length;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === '' ? 0 : Number(m[1]);
      let end = m[2] === '' ? total - 1 : Number(m[2]);
      if (end >= total) end = total - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        ...extra
      });
      return res.end(buf.subarray(start, end + 1));
    }
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': total, 'Accept-Ranges': 'bytes', ...extra });
  res.end(buf);
}

const DEFAULT_FLASHVARS = {
  allowScriptAccess: 'always',
  allowNetworking: 'all',
  allowFullScreen: 'true'
};

function mergeFlashvars(item) {
  return { ...DEFAULT_FLASHVARS, ...(item.flashvars || {}) };
}

function buildBoot(item) {
  if (item.originalUrl) {
    const u = new URL(item.originalUrl);
    const dir = `${u.origin}${u.pathname.replace(/[^/]*$/, '')}`;
    const name = decodeURIComponent(u.pathname.split('/').pop() || 'game.swf');
    const b64 = Buffer.from(dir, 'utf8').toString('base64url');
    return {
      swfUrl: `/m/${item.id}/${b64}/${encodeURIComponent(name)}${u.search}`,
      baseUrl: `/m/${item.id}/${b64}/`,
      parameters: mergeFlashvars(item),
      title: item.title,
      originalUrl: item.originalUrl
    };
  }
  return {
    swfUrl: `/file/${item.id}/${encodeURIComponent(item.fileName)}`,
    baseUrl: `/file/${item.id}/`,
    parameters: mergeFlashvars(item),
    title: item.title,
    originalUrl: null
  };
}

async function createServer({ dataDir, lib, rendererDir, vendorDir, playerTemplate, cookieProvider }) {
  const token = crypto.randomBytes(16).toString('hex');
  const globalCache = ensureDir(path.join(dataDir, 'cache'));
  const OFFLINE = process.env.AP_OFFLINE === '1';

  let activeGame = null;
  const innerSwfJobs = new Map();
  const innerSwfPath = (item) => path.join(lib.itemDir(item.id), 'play.swf');

  const isMainSwfUrl = (item, targetUrl) => {
    if (!item.originalUrl) return false;
    try {
      const target = new URL(targetUrl);
      const original = new URL(item.originalUrl);
      return target.origin === original.origin && target.pathname === original.pathname;
    } catch { return false; }
  };

  const ensureInnerSwf = (item) => {
    if (innerSwfJobs.has(item.id)) return innerSwfJobs.get(item.id);
    const job = (async () => {
      const play = innerSwfPath(item);
      try {
        if (fs.statSync(play).size > 1024 * 1024) return play;
      } catch {}
      let buf;
      try { buf = fs.readFileSync(path.join(lib.itemDir(item.id), item.fileName || 'main.swf')); } catch { return null; }
      const inner = extractInnerSwf(buf);
      if (!inner) return null;
      try { fs.writeFileSync(play, inner); } catch { return null; }
      console.log(`[flashgamer] unwrapped embedded SWF: ${item.id} (${inner.length} B)`);
      return play;
    })();
    innerSwfJobs.set(item.id, job);
    return job;
  };

  const resolveCookie = async (url, item) => {
    try {
      if (cookieProvider) {
        const c = await cookieProvider(url);
        if (c) return c;
      }
    } catch {}
    return (item && item.cookie) || '';
  };

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*'
  };

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (e) {
      send(res, 500, `server error: ${e.message}`);
    }
  });

  const hasAuth = (req) => {
    const raw = req.headers.cookie || '';
    return raw.split(/;\s*/).includes(`ap_session=${token}`);
  };

  const serveGameAsset = async (req, res, item, targetUrl) => {
    if (isMainSwfUrl(item, targetUrl)) {
      const play = innerSwfPath(item);
      if (fs.existsSync(play)) {
        res.setHeader('X-Ap-Inner', '1');
        return serveFile(req, res, play, 'application/x-shockwave-flash');
      }
    }
    const key = sha1(targetUrl);
    const dir = lib.cacheDir(item.id);
    const bin = path.join(dir, key);
    const metaFile = `${bin}.meta.json`;

    if (fs.existsSync(bin) && fs.existsSync(metaFile)) {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
      res.setHeader('X-Ap-Cache', 'HIT');
      return serveFile(req, res, bin, meta.contentType || 'application/octet-stream');
    }

    if (OFFLINE) {
      return send(res, 504, `离线模式：该资源未缓存 ${targetUrl}`);
    }

    let upstream;
    try {
      const headers = { 'User-Agent': UA, Accept: '*/*' };
      const referer = item.referer || item.pageUrl;
      if (referer) headers.Referer = referer;
      const cookie = await resolveCookie(targetUrl, item);
      if (cookie) headers.Cookie = cookie;
      upstream = await fetch(targetUrl, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(45000)
      });
    } catch (e) {
      return send(res, 502, `无法获取资源（离线且未缓存）：${targetUrl}`);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (!upstream.ok) {
      return send(res, upstream.status, `上游返回 ${upstream.status}: ${targetUrl}`);
    }
    if (buf.length > 200 * 1024 * 1024) {
      return send(res, 413, '资源过大，已跳过缓存');
    }
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    try {
      fs.writeFileSync(bin, buf);
      fs.writeFileSync(metaFile, JSON.stringify({ url: targetUrl, contentType, size: buf.length, at: Date.now() }));
    } catch {}
    res.setHeader('X-Ap-Cache', 'MISS');
    return serveBuffer(req, res, buf, contentType);
  };

  async function handleProxy(req, res, targetUrl) {
    let target;
    try { target = new URL(targetUrl); } catch { return send(res, 400, 'bad proxy target'); }
    if (!/^https?:$/.test(target.protocol)) return send(res, 400, 'bad proxy protocol');
    if (target.hostname === '127.0.0.1' || target.hostname === 'localhost') return send(res, 403, 'forbidden');
    if (isBlockedUrl(target.href)) { res.writeHead(204, CORS); return res.end(); }
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    const item = activeGame;
    const ref = (item && (item.referer || item.pageUrl)) || '';
    let bin = null;
    let metaFile = null;
    if (item) {
      const key = sha1(target.href);
      const dir = lib.cacheDir(item.id);
      bin = path.join(dir, key);
      metaFile = `${bin}.meta.json`;
      if ((req.method === 'GET' || req.method === 'HEAD') && fs.existsSync(bin) && fs.existsSync(metaFile)) {
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
        res.setHeader('X-Ap-Cache', 'HIT');
        return serveFile(req, res, bin, meta.contentType || 'application/octet-stream', CORS);
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        const headers = { 'User-Agent': UA, 'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded' };
        if (ref) headers.Referer = ref;
        const cookie = await resolveCookie(target.href, item);
        if (cookie) headers.Cookie = cookie;
        const upstream = await fetch(target.href, {
          method: req.method,
          headers,
          body: Buffer.concat(chunks),
          redirect: 'follow',
          signal: AbortSignal.timeout(45000)
        });
        const buf = Buffer.from(await upstream.arrayBuffer());
        return serveBuffer(req, res, buf, upstream.headers.get('content-type') || 'application/octet-stream', CORS);
      } catch (e) {
        return send(res, 502, `proxy error: ${e.message}`, 'text/plain; charset=utf-8', CORS);
      }
    }

    let upstream;
    try {
      const headers = { 'User-Agent': UA, Accept: req.headers.accept || '*/*' };
      if (req.headers['accept-language']) headers['Accept-Language'] = req.headers['accept-language'];
      if (ref) headers.Referer = ref;
      const cookie = await resolveCookie(target.href, item);
      if (cookie) headers.Cookie = cookie;
      upstream = await fetch(target.href, { headers, redirect: 'follow', signal: AbortSignal.timeout(45000) });
    } catch (e) {
      return send(res, 502, `proxy error: ${e.message}`, 'text/plain; charset=utf-8', CORS);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    if (bin && upstream.ok && buf.length < 200 * 1024 * 1024) {
      try {
        fs.writeFileSync(bin, buf);
        fs.writeFileSync(metaFile, JSON.stringify({ url: target.href, contentType: type, size: buf.length, at: Date.now() }));
      } catch {}
    }
    res.setHeader('X-Ap-Cache', item && upstream.ok ? 'MISS' : 'BYPASS');
    return serveBuffer(req, res, buf, type, CORS);
  }

  async function route(req, res) {
    if (/^https?:\/\//i.test(req.url)) return handleProxy(req, res, req.url);
    const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = urlObj.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      if (urlObj.searchParams.get('t') === token) {
        res.setHeader('Set-Cookie', `ap_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
      } else if (!hasAuth(req)) {
        return send(res, 403, '需要从 App Professor 主窗口打开');
      }
      const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8', {
        'Content-Security-Policy': HTML_CSP,
        'X-Content-Type-Options': 'nosniff'
      });
    }

    // ctrl_mo_v5.swf 由 Ruffle 以 CORS 方式拉取并重定向到本地，请求本身不带页面 Cookie
    if (!hasAuth(req) && !pathname.startsWith('/vendor/4399/')) return send(res, 403, 'forbidden');

    if (pathname.startsWith('/assets/')) {
      const rel = pathname.slice('/assets/'.length);
      const file = path.join(rendererDir, rel);
      if (!file.startsWith(rendererDir)) return send(res, 403, 'forbidden');
      if (!fs.existsSync(file)) return send(res, 404, 'not found');
      return serveFile(req, res, file);
    }

    if (pathname.startsWith('/vendor/ruffle/')) {
      const rel = pathname.slice('/vendor/ruffle/'.length);
      const file = path.join(vendorDir, rel);
      if (!file.startsWith(vendorDir)) return send(res, 403, 'forbidden');
      if (!fs.existsSync(file)) return send(res, 404, 'not found');
      const type = file.endsWith('.wasm') ? 'application/wasm' : mimeFor(file);
      return serveFile(req, res, file, type);
    }

    if (pathname.startsWith('/vendor/4399/')) {
      const rel = pathname.slice('/vendor/4399/'.length);
      const root = path.join(path.dirname(vendorDir), '4399');
      const file = path.join(root, rel);
      if (!file.startsWith(root)) return send(res, 403, 'forbidden');
      if (!fs.existsSync(file)) return send(res, 404, 'not found');
      return serveFile(req, res, file, file.endsWith('.swf') ? 'application/x-shockwave-flash' : 'application/octet-stream', { 'Access-Control-Allow-Origin': '*' });
    }

    const coverMatch = pathname.match(/^\/cover\/([^/]+)$/);
    if (coverMatch) {
      const item = lib.get(coverMatch[1]);
      if (!item || !item.cover) return send(res, 404, 'no cover');
      return serveFile(req, res, path.join(lib.itemDir(item.id), item.cover));
    }

    const fileMatch = pathname.match(/^\/file\/([^/]+)\/(.+)$/);
    if (fileMatch) {
      const item = lib.get(fileMatch[1]);
      if (!item) return send(res, 404, 'no game');
      const dir = lib.itemDir(item.id);
      let rel;
      try { rel = decodeURIComponent(fileMatch[2]); } catch { rel = fileMatch[2]; }
      const file = path.join(dir, rel);
      if (!file.startsWith(dir)) return send(res, 403, 'forbidden');
      if (rel === (item.fileName || 'main.swf')) {
        const play = innerSwfPath(item);
        if (fs.existsSync(play)) return serveFile(req, res, play);
      }
      if (!fs.existsSync(file)) return send(res, 404, 'not found');
      return serveFile(req, res, file);
    }

    if (pathname === '/browser') {
      const html = fs.readFileSync(path.join(rendererDir, 'browser.html'), 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8', {
        'Content-Security-Policy': HTML_CSP,
        'X-Content-Type-Options': 'nosniff'
      });
    }

    const playMatch = pathname.match(/^\/play\/([^/]+)$/);
    if (playMatch) {
      const item = lib.get(playMatch[1]);
      if (!item) return send(res, 404, 'no game');
      await ensureInnerSwf(item);
      activeGame = item;
      const boot = JSON.stringify(buildBoot(item)).replace(/</g, '\\u003c');
      const nonce = crypto.randomBytes(12).toString('base64');
      let html = fs.readFileSync(playerTemplate, 'utf8').replace('__BOOT__', boot);
      html = html.replace(/<script(?![^>]*\bsrc=)/g, `<script nonce="${nonce}"`);
      const csp = HTML_CSP.replace("script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
        `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: 'nonce-${nonce}'`);
      return send(res, 200, html, 'text/html; charset=utf-8', {
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff'
      });
    }

    const mirrorMatch = pathname.match(/^\/m\/([^/]+)\/([^/]+)\/(.*)$/);
    if (mirrorMatch) {
      const [, gameId, b64, rest] = mirrorMatch;
      const item = lib.get(gameId);
      if (!item) return send(res, 404, 'no game');
      let base;
      try { base = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return send(res, 400, 'bad base'); }
      if (!/^https?:\/\//.test(base)) return send(res, 400, 'bad base');
      const target = base + rest + (urlObj.search || '');
      let host;
      try { host = new URL(target).hostname; } catch { return send(res, 400, 'bad target'); }
      if (host === '127.0.0.1' || host === 'localhost') return send(res, 403, 'forbidden');
      return serveGameAsset(req, res, item, target);
    }

    return send(res, 404, 'not found');
  }

  let port = 0;
  const cfgPath = path.join(dataDir, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  const preferred = Number(cfg.port) || 43199;
  for (let p = preferred; p < preferred + 40; p++) {
    try {
      port = await listen(server, p);
      if (p !== preferred) fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, port: p }, null, 2));
      else if (!cfg.port) fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, port: p }, null, 2));
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  if (!port) port = await listen(server, 0);

  // 4399 外壳用 ExternalInterface 读取 location.hostname 决定是否连远程服务；
  // 只有 hostname 为 localhost 才会跳过 start_remote()，故本地页面统一走 localhost。
  return {
    server,
    port,
    token,
    url: `http://localhost:${port}/?t=${token}`,
    origin: `http://localhost:${port}`,
    getActiveGame: () => activeGame,
    close: () => new Promise((r) => server.close(() => r()))
  };
}

module.exports = { createServer, buildBoot };
