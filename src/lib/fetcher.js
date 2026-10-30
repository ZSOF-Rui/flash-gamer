const { ensureDir, sha256 } = require('./util');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchBinary(url, opts = {}) {
  const headers = {
    'User-Agent': opts.ua || UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  };
  if (opts.referer) headers.Referer = opts.referer;
  if (opts.cookie) headers.Cookie = opts.cookie;

  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeout || 60000)
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    ok: res.ok,
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    finalUrl: res.url || url,
    buf
  };
}

async function saveTo(dir, name, buf) {
  ensureDir(dir);
  const file = require('path').join(dir, name);
  require('fs').writeFileSync(file, buf);
  return file;
}

module.exports = { fetchBinary, saveTo, UA, sha256 };
