const { net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { ensureDir, safeFileName } = require('./util');

const DEFAULT_SOURCES = [
  'https://flash-gamer-ch09cuq83vg.qoder.website/updates/win-x64.json',
  'https://flash.828696.xyz/updates/win-x64.json',
  'https://zsof-rui.github.io/flash-gamer/updates/win-x64.json'
];

const CHECK_TIMEOUT = 12000;
const MAX_ASSET_SIZE = 400 * 1024 * 1024;

function sourceList() {
  const custom = String(process.env.AP_UPDATE_SOURCES || '').split(/[\s,]+/).filter(Boolean);
  return custom.length ? custom : DEFAULT_SOURCES;
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function normalizeAsset(raw, baseUrl) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url || '').trim();
  const sha = String(raw.sha256 || '').trim().toLowerCase();
  const size = Number(raw.size);
  if (!url || !/^[a-f0-9]{64}$/.test(sha) || !Number.isFinite(size) || size <= 0) return null;
  let abs;
  try { abs = new URL(url, baseUrl); } catch { return null; }
  const local = abs.hostname === '127.0.0.1' || abs.hostname === 'localhost';
  if (abs.protocol !== 'https:' && !(local && abs.protocol === 'http:')) return null;
  return { url: abs.href, size, sha256: sha };
}

function normalizeManifest(raw, baseUrl) {
  if (!raw || typeof raw !== 'object') return null;
  if (!parseVersion(raw.version)) return null;
  const assets = raw.assets && typeof raw.assets === 'object' ? raw.assets : {};
  const setup = normalizeAsset(assets.setup, baseUrl);
  const portable = normalizeAsset(assets.portable, baseUrl);
  if (!setup && !portable) return null;
  let notes = raw.notes;
  if (Array.isArray(notes)) notes = notes.map((s) => String(s)).join('\n');
  return {
    version: String(raw.version).trim(),
    publishedAt: raw.publishedAt ? String(raw.publishedAt) : '',
    notes: String(notes || '').trim(),
    setup,
    portable
  };
}

async function fetchJson(url, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache', 'user-agent': 'FlashGamer-Updater' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (body.length > 256 * 1024) throw new Error('清单过大');
    return JSON.parse(body);
  } finally {
    clearTimeout(timer);
  }
}

class Updater {
  constructor({ dataDir, fetch }) {
    this.dir = path.join(dataDir, 'updates');
    this.pending = null;
    this.downloading = false;
    // 独立 session 的 fetch：走系统代理，避开应用内本地代理
    this.fetch = typeof fetch === 'function' ? fetch : net.fetch.bind(net);
  }

  async check(currentVersion) {
    const sources = sourceList();
    const results = await Promise.all(sources.map(async (base) => {
      const url = `${base}${base.includes('?') ? '&' : '?'}t=${Date.now()}`;
      try {
        const manifest = normalizeManifest(await fetchJson(url, this.fetch), base);
        if (!manifest) throw new Error('清单格式不正确');
        return { base, manifest };
      } catch (e) {
        return { base, error: String(e.message || e) };
      }
    }));

    const ok = results.filter((r) => r.manifest);
    ok.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
    const best = ok[0] || null;
    const available = !!best && compareVersions(best.manifest.version, currentVersion) > 0;

    let chosen = null;
    if (available) {
      const version = best.manifest.version;
      const candidates = ok
        .filter((r) => r.manifest.version === version)
        .map((r) => ({ source: r.base, asset: r.manifest.setup || r.manifest.portable }))
        .filter((c) => c.asset);
      chosen = { version, notes: best.manifest.notes, publishedAt: best.manifest.publishedAt, candidates };
    }
    this.pending = chosen;

    return {
      current: currentVersion,
      available,
      version: chosen ? chosen.version : currentVersion,
      notes: chosen ? chosen.notes : '',
      publishedAt: chosen ? chosen.publishedAt : '',
      size: chosen ? chosen.candidates[0].asset.size : 0,
      sources: results.map((r) => ({
        host: (() => { try { return new URL(r.base).host; } catch { return r.base; } })(),
        ok: !!r.manifest,
        version: r.manifest ? r.manifest.version : '',
        error: r.error || ''
      }))
    };
  }

  async download(onProgress) {
    if (!this.pending) throw new Error('没有可用的更新');
    if (this.downloading) throw new Error('更新正在下载中');
    this.downloading = true;
    try {
      const failures = [];
      for (const c of this.pending.candidates) {
        try {
          const file = await this.fetchAsset(c.asset, onProgress);
          return { path: file, version: this.pending.version };
        } catch (e) {
          failures.push(String(e.message || e));
        }
      }
      throw new Error(failures[0] || '下载失败');
    } finally {
      this.downloading = false;
    }
  }

  async fetchAsset(asset, onProgress) {
    ensureDir(this.dir);
    let name = 'FlashGamer-update.exe';
    try { name = safeFileName(path.basename(new URL(asset.url).pathname)) || name; } catch {}
    if (!/\.exe$/i.test(name)) name += '.exe';
    const file = path.join(this.dir, name);
    const part = `${file}.part`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
    try {
      const res = await this.fetch(asset.url, {
        signal: ctrl.signal,
        cache: 'no-store',
        headers: { 'user-agent': 'FlashGamer-Updater' }
      });
      if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || asset.size;
      if (total > MAX_ASSET_SIZE) throw new Error('更新包过大');

      const hash = crypto.createHash('sha256');
      let received = 0;
      let lastTick = 0;
      const input = Readable.fromWeb(res.body);
      const output = fs.createWriteStream(part);
      input.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        const now = Date.now();
        if (onProgress && (now - lastTick > 200 || received === total)) {
          lastTick = now;
          onProgress({ received, total });
        }
      });
      await new Promise((resolve, reject) => {
        input.on('error', reject);
        output.on('error', reject);
        output.on('finish', resolve);
        input.pipe(output);
      });

      if (asset.size && received !== asset.size) throw new Error(`文件大小不一致（${received}/${asset.size}）`);
      const digest = hash.digest('hex');
      if (digest !== asset.sha256) throw new Error('SHA-256 校验失败');

      try { fs.rmSync(file, { force: true }); } catch {}
      fs.renameSync(part, file);
      return file;
    } finally {
      clearTimeout(timer);
      try { if (fs.existsSync(part)) fs.rmSync(part, { force: true }); } catch {}
    }
  }
}

module.exports = { Updater, compareVersions, parseVersion, DEFAULT_SOURCES };
