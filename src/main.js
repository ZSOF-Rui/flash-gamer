const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');
const Library = require('./lib/library');
const { createServer } = require('./lib/server');
const { inspectPage } = require('./lib/inspector');
const { fetchBinary } = require('./lib/fetcher');
const { ensureDir, newId, sha256, isSwf, safeFileName, titleFromFileName } = require('./lib/util');
const { isBlockedUrl } = require('./lib/blocklist');

const APP_NAME = 'Flash Gamer';
app.setName(APP_NAME);

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const DATA_DIR = process.env.AP_DATA_DIR || (app.isPackaged
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')), 'FlashGamerData')
  : path.join(__dirname, '..', 'data'));
const LEGACY_DATA_DIR = app.isPackaged
  ? path.join(path.dirname(DATA_DIR), 'AppProfessorData')
  : null;

const TMP_DIR = path.join(DATA_DIR, 'tmp');
ensureDir(DATA_DIR);
ensureDir(TMP_DIR);

if (LEGACY_DATA_DIR && !fs.existsSync(path.join(DATA_DIR, 'library.json')) && fs.existsSync(path.join(LEGACY_DATA_DIR, 'library.json'))) {
  try {
    fs.cpSync(LEGACY_DATA_DIR, DATA_DIR, { recursive: true });
    console.log('[data] migrated from', LEGACY_DATA_DIR);
  } catch (e) {
    console.error('[data] migration failed', e);
  }
}

let mainWindow = null;
let lib = null;
let srv = null;
const inspectSessions = new Map();
const gameWindows = new Map();
let browserWindow = null;
let browserParsing = false;

function extFromType(ct) {
  if (/png/i.test(ct)) return '.png';
  if (/webp/i.test(ct)) return '.webp';
  if (/gif/i.test(ct)) return '.gif';
  return '.jpg';
}

function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  try {
    new URLSearchParams(qs).forEach((v, k) => { out[k] = v; });
  } catch {}
  return out;
}

function parseFlashvars(raw) {
  const out = {};
  if (!raw) return out;
  String(raw).split(/[&;]/).forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
  });
  return out;
}

async function buildItemFromCandidate({ session, candidate, title }) {
  const id = newId('g');
  const dir = ensureDir(lib.itemDir(id));

  let buf = null;
  if (candidate.tempFile && fs.existsSync(candidate.tempFile)) {
    buf = fs.readFileSync(candidate.tempFile);
  } else {
    const r = await fetchBinary(candidate.url, { referer: candidate.referer || session.pageUrl, cookie: candidate.cookie });
    if (!r.ok) throw new Error(`下载失败：HTTP ${r.status}`);
    buf = r.buf;
  }
  if (!isSwf(buf)) throw new Error('目标不是有效的 SWF 文件');

  let fileName = 'game.swf';
  try {
    const name = decodeURIComponent(new URL(candidate.url).pathname.split('/').pop() || '');
    if (name) fileName = safeFileName(name.endsWith('.swf') ? name : `${name}.swf`);
  } catch {}

  const hash = sha256(buf);
  const dup = lib.list().find((x) => x.sha256 === hash);
  if (dup) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return dup;
  }

  fs.writeFileSync(path.join(dir, fileName), buf);

  let cover = null;
  if (session.coverUrl) {
    try {
      const c = await fetchBinary(session.coverUrl, { referer: session.pageUrl, cookie: candidate.cookie });
      if (c.ok && c.buf.length > 1024 && c.buf.length < 8 * 1024 * 1024) {
        cover = `cover${extFromType(c.contentType)}`;
        fs.writeFileSync(path.join(dir, cover), c.buf);
      }
    } catch {}
  }

  const search = (() => { try { return new URL(candidate.url).search.replace(/^\?/, ''); } catch { return ''; } })();
  const parameters = { ...parseQuery(search), ...parseFlashvars(session.flashvars) };

  const item = {
    id,
    title: (title || session.title || titleFromFileName(fileName)).slice(0, 120),
    pageUrl: session.pageUrl,
    source: (() => { try { return new URL(session.pageUrl).hostname; } catch { return ''; } })(),
    originalUrl: candidate.url,
    fileName,
    size: buf.length,
    sha256: hash,
    width: session.width || 0,
    height: session.height || 0,
    flashvars: parameters,
    referer: candidate.referer || session.pageUrl,
    cookie: candidate.cookie || '',
    cover,
    compat: 'A',
    addedAt: Date.now(),
    playedAt: 0
  };
  lib.add(item);
  return item;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#f4f5f7',
    autoHideMenuBar: true,
    title: APP_NAME,
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      backgroundThrottling: false,
      ...(process.env.AP_SMOKE_OFFSCREEN === '1' ? { offscreen: true } : {})
    }
  });

  mainWindow.loadURL(srv.url);

  if (process.env.AP_SMOKE) {
    mainWindow.webContents.on('console-message', (...args) => {
      const d = args[1] && typeof args[1] === 'object' ? args[1] : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
      console.log('[console]', d.level, d.message, d.sourceId || '', d.lineNumber || '');
    });
    mainWindow.webContents.on('did-fail-load', (e, code, desc, url, isMain) => console.log('[fail-load]', code, desc, url, isMain));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(srv.origin)) e.preventDefault();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function openGameWindow(id) {
  const item = lib.get(id);
  if (!item) throw new Error('游戏不存在');
  const existing = gameWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return true;
  }
  lib.update(id, { playedAt: Date.now() });
  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: item.title,
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  win.loadURL(`${srv.origin}/play/${id}`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => gameWindows.delete(id));
  gameWindows.set(id, win);
  return true;
}

function openBrowserWindow() {
  if (browserWindow && !browserWindow.isDestroyed()) {
    if (browserWindow.isMinimized()) browserWindow.restore();
    browserWindow.show();
    browserWindow.focus();
    return true;
  }
  browserWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#f4f5f7',
    autoHideMenuBar: true,
    title: '网页浏览 — Flash Gamer',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'browser-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
      ...(process.env.AP_SMOKE_OFFSCREEN === '1' ? { offscreen: true } : {})
    }
  });
  browserWindow.loadURL(`${srv.origin}/browser`);
  browserWindow.on('closed', () => { browserWindow = null; });
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  browserWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${srv.origin}/browser`)) e.preventDefault();
  });
  return true;
}

function isPlayerContext(details) {
  const id = details.webContentsId;
  if (!id) return false;
  if (mainWindow && !mainWindow.isDestroyed() && id === mainWindow.webContents.id) return true;
  for (const w of gameWindows.values()) {
    if (!w.isDestroyed() && id === w.webContents.id) return true;
  }
  return false;
}

async function registerIpc() {
  ipcMain.handle('library:list', () => lib.list());

  ipcMain.handle('inspect', async (_e, pageUrl) => {
    const result = await inspectPage({
      pageUrl,
      tmpDir: TMP_DIR,
      onProgress: (msg) => { if (mainWindow) mainWindow.webContents.send('inspect:progress', msg); }
    });
    const sessionId = newId('s');
    result.sessionId = sessionId;
    inspectSessions.set(sessionId, result);
    return result;
  });

  ipcMain.handle('library:add', async (_e, { sessionId, key, title }) => {
    const session = inspectSessions.get(sessionId);
    if (!session) throw new Error('解析结果已过期，请重新解析');
    const candidate = session.candidates.find((c) => c.key === key);
    if (!candidate) throw new Error('找不到该候选文件');
    const item = await buildItemFromCandidate({ session, candidate, title });
    if (candidate.tempFile) {
      try { fs.rmSync(path.dirname(candidate.tempFile), { recursive: true, force: true }); } catch {}
    }
    return item;
  });

  ipcMain.handle('library:play', async (_e, id) => {
    const item = lib.get(id);
    if (!item) throw new Error('游戏不存在');
    lib.update(id, { playedAt: Date.now() });
    return `/play/${id}`;
  });

  ipcMain.handle('library:cacheStats', (_e, id) => lib.cacheStats(id));

  ipcMain.handle('library:openWindow', (_e, id) => openGameWindow(id));

  ipcMain.handle('browser:open', () => openBrowserWindow());

  ipcMain.handle('browser:parse', async (_e, pageUrl) => {
    if (!/^https?:/i.test(String(pageUrl || ''))) throw new Error('当前不是网页地址');
    if (browserParsing) throw new Error('正在解析上一个页面，请稍候');
    browserParsing = true;
    const progress = (m) => {
      if (browserWindow && !browserWindow.isDestroyed()) browserWindow.webContents.send('browser:progress', m);
    };
    try {
      const res = await inspectPage({ pageUrl, tmpDir: TMP_DIR, onProgress: progress });
      if (!res.candidates.length) {
        throw new Error(res.hasH5 ? '这是 H5 游戏，页面里没有 SWF' : '没抓到 SWF，先在页面里点一下“开始游戏”再试');
      }
      const item = await buildItemFromCandidate({ session: res, candidate: res.candidates[0] });
      if (mainWindow) mainWindow.webContents.send('library:changed');
      return { item: { id: item.id, title: item.title, size: item.size }, count: res.candidates.length };
    } finally {
      browserParsing = false;
    }
  });

  ipcMain.handle('library:remove', async (_e, id) => {
    const item = lib.get(id);
    if (!item) return false;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '删除游戏',
      message: `确定从库中删除「${item.title}」？`,
      detail: '本地文件与缓存会被一并删除。'
    });
    if (response !== 0) return false;
    return lib.remove(id);
  });

  ipcMain.handle('library:reveal', (_e, id) => {
    const item = lib.get(id);
    if (item) shell.openPath(lib.itemDir(id));
    return true;
  });

  ipcMain.handle('library:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '导入 SWF 文件',
      filters: [{ name: 'Flash 影片', extensions: ['swf'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (canceled) return [];
    return importPaths(filePaths);
  });

  ipcMain.handle('library:importPath', async (_e, filePath) => importPaths([filePath]));

  async function importPaths(filePaths) {
    const added = [];
    for (const p of filePaths) {
      try {
        const buf = fs.readFileSync(p);
        if (!isSwf(buf)) continue;
        const hash = sha256(buf);
        const dup = lib.list().find((x) => x.sha256 === hash);
        if (dup) {
          added.push(dup);
          continue;
        }
        const id = newId('g');
        const dir = ensureDir(lib.itemDir(id));
        const fileName = safeFileName(path.basename(p));
        fs.writeFileSync(path.join(dir, fileName), buf);
        const item = {
          id,
          title: titleFromFileName(fileName),
          pageUrl: null,
          source: '本地文件',
          originalUrl: null,
          fileName,
          size: buf.length,
          sha256: hash,
          width: 0,
          height: 0,
          flashvars: {},
          referer: '',
          cookie: '',
          cover: null,
          compat: 'A',
          addedAt: Date.now(),
          playedAt: 0
        };
        lib.add(item);
        added.push(item);
      } catch (e) {
        console.error('import failed', p, e);
      }
    }
    return added;
  }
}

async function smoke() {
  const mode = process.env.AP_SMOKE;
  if (!mode) return;
  const out = process.env.AP_SMOKE_OUT || path.join(DATA_DIR, 'smoke.json');
  const shots = [];
  const result = { mode, steps: [] };

  const shot = async (name) => {
    try {
      const img = await mainWindow.capturePage();
      const file = path.join(DATA_DIR, `smoke-${name}.png`);
      fs.writeFileSync(file, img.toPNG());
      shots.push(file);
      return file;
    } catch (e) {
      result.shotErrors = (result.shotErrors || []).concat(`${name}: ${e.message}`);
      return null;
    }
  };

  await new Promise((r) => setTimeout(r, 1500));
  await shot('ui');

  const playWait = Number(process.env.AP_SMOKE_WAIT) || 7000;
  const clickStage = async () => {
    const [w, h] = mainWindow.getContentSize();
    const x = Math.round(w * 0.7);
    const y = Math.round(h * 0.55);
    mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };

  if (mode === 'full' && process.env.AP_SMOKE_URL) {
    try {
      const url = process.env.AP_SMOKE_URL;
      const res = await inspectPage({ pageUrl: url, tmpDir: TMP_DIR, onProgress: (m) => console.log('[inspect]', m) });
      result.inspect = {
        title: res.title,
        candidates: res.candidates.map((c) => ({ url: c.url, size: c.size, via: c.via }))
      };
      if (!res.candidates.length) throw new Error('no candidate');
      const sessionId = newId('s');
      res.sessionId = sessionId;
      inspectSessions.set(sessionId, res);
      const item = await buildItemFromCandidate({ session: res, candidate: res.candidates[0] });
      result.item = { id: item.id, title: item.title, size: item.size, originalUrl: item.originalUrl };

      await mainWindow.webContents.executeJavaScript(`window.__apRefresh && window.__apRefresh()`);
      await new Promise((r) => setTimeout(r, 400));
      await mainWindow.webContents.executeJavaScript(`window.__apSelect && window.__apSelect('${item.id}', true)`);
      await new Promise((r) => setTimeout(r, playWait));
      if (process.env.AP_SMOKE_CLICK === '1') {
        await clickStage();
        await new Promise((r) => setTimeout(r, 5000));
      }
      const dbg = await mainWindow.webContents.executeJavaScript(`(() => { const f=document.getElementById('frame'); try { return { href: f.contentWindow.location.href, html: f.contentDocument.body.innerHTML.slice(0,600), errs: f.contentWindow.__apErrors||[] }; } catch(e) { return { err: String(e) }; } })()`);
      result.iframe = dbg;
      const meta = await mainWindow.webContents.executeJavaScript(`(() => {
        const f = document.getElementById('frame');
        try {
          const p = f.contentDocument.querySelector('ruffle-player');
          return p && p.metadata ? {
            width: p.metadata.width, height: p.metadata.height,
            frameRate: p.metadata.frameRate, swfVersion: p.metadata.swfVersion,
            numFrames: p.metadata.numFrames
          } : null;
        } catch (e) { return { err: String(e) }; }
      })()`);
      result.player = meta;
      await shot('play');
      result.cache = lib.cacheStats(item.id);
      await shot('after-cache');
    } catch (e) {
      result.error = String(e.stack || e);
      await shot('error');
    }
  }

  if (mode === 'replay' && process.env.AP_SMOKE_ITEM) {
    try {
      const id = process.env.AP_SMOKE_ITEM;
      result.item = { id };
      await mainWindow.webContents.executeJavaScript(`localStorage.setItem('apDebug','1')`);
      await mainWindow.webContents.executeJavaScript(`window.__apRefresh && window.__apRefresh()`);
      await new Promise((r) => setTimeout(r, 500));
      await mainWindow.webContents.executeJavaScript(`window.__apSelect && window.__apSelect('${id}', true)`);
      await new Promise((r) => setTimeout(r, playWait));
      if (process.env.AP_SMOKE_CLICK === '1') {
        await clickStage();
        await new Promise((r) => setTimeout(r, 5000));
      }
      result.iframe = await mainWindow.webContents.executeJavaScript(`(() => { const f=document.getElementById('frame'); try { const p=f.contentDocument.querySelector('ruffle-player'); return { href: f.contentWindow.location.href, src: f.src, stageClass: document.querySelector('.stage').className, status: document.getElementById('status') && document.getElementById('status').textContent, errs: f.contentWindow.__apErrors||[], allow: p && p.loadedConfig ? p.loadedConfig.allowScriptAccess : null }; } catch(e) { return { err: String(e) }; } })()`);
      result.player = await mainWindow.webContents.executeJavaScript(`(() => {
        const f = document.getElementById('frame');
        try { const p = f.contentDocument.querySelector('ruffle-player'); return p && p.metadata ? { width: p.metadata.width, height: p.metadata.height, frameRate: p.metadata.frameRate, numFrames: p.metadata.numFrames } : null; } catch(e) { return { err: String(e) }; }
      })()`);
      if (process.env.AP_SMOKE_WINDOW === '1') {
        try {
          openGameWindow(id);
          await new Promise((r) => setTimeout(r, 6000));
          const win = gameWindows.get(id);
          if (win) {
            result.gameWindow = await win.webContents.executeJavaScript(`(() => {
              const p = document.querySelector('ruffle-player');
              return { href: location.href, title: document.title, meta: p && p.metadata ? { width: p.metadata.width, height: p.metadata.height, frames: p.metadata.numFrames } : null };
            })()`);
          }
        } catch (e) { result.gameWindowError = String(e.message || e); }
      }
      result.cache = lib.cacheStats(id);
      await shot('replay');
    } catch (e) { result.error = String(e.stack || e); }
  }

  if (process.env.AP_SMOKE_BROWSER === '1') {
    try {
      openBrowserWindow();
      await new Promise((r) => setTimeout(r, 3000));
      await browserWindow.webContents.executeJavaScript(`(() => { const a = document.getElementById('addr'); a.value = 'https://www.4399.com/flash/40779_3.htm'; document.getElementById('go').click(); return true; })()`);
      await new Promise((r) => setTimeout(r, 12000));
      try {
        const img = await browserWindow.capturePage();
        const file = path.join(DATA_DIR, 'smoke-browser.png');
        fs.writeFileSync(file, img.toPNG());
        result.browserShot = file;
      } catch (e) { result.browserShotError = String(e.message || e); }
      result.browser = await browserWindow.webContents.executeJavaScript(`(() => { const v = document.querySelector('#view'); let u = ''; try { u = v.getURL(); } catch (e) { u = 'ERR:' + e.message; } return { url: u, title: document.title, status: document.getElementById('status').textContent }; })()`);
      if (process.env.AP_SMOKE_BROWSER_PARSE === '1') {
        await browserWindow.webContents.executeJavaScript(`document.getElementById('parse').click()`);
        await new Promise((r) => setTimeout(r, 30000));
        result.browserParse = await browserWindow.webContents.executeJavaScript(`(() => ({ toast: document.getElementById('toast').textContent, status: document.getElementById('status').textContent }))()`);
        result.libraryCount = lib.list().length;
      }
    } catch (e) {
      result.browserError = String(e.stack || e);
    }
  }

  result.shots = shots;
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log('SMOKE_RESULT', out);
  setTimeout(() => app.exit(0), 300);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    lib = new Library(DATA_DIR);
    srv = await createServer({
      dataDir: DATA_DIR,
      lib,
      rendererDir: path.join(__dirname, 'renderer'),
      vendorDir: path.join(__dirname, '..', 'vendor', 'ruffle'),
      playerTemplate: path.join(__dirname, 'renderer', 'player.html'),
      cookieProvider: async (url) => {
        try {
          const cks = await session.defaultSession.cookies.get({ url });
          return cks.map((c) => `${c.name}=${c.value}`).join('; ');
        } catch {
          return '';
        }
      }
    });
    await registerIpc();

    await session.defaultSession.setProxy({
      proxyRules: `http=127.0.0.1:${srv.port}`,
      proxyBypassRules: '127.0.0.1,localhost'
    });

    session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      try {
        const u = new URL(details.url);
        if (u.hostname === 'cdn.comment.4399pk.com' && /\/control\/ctrl_mo_v5\.swf$/i.test(u.pathname)) {
          return callback({ redirectURL: `http://127.0.0.1:${srv.port}/vendor/4399/ctrl_mo_v5.swf` });
        }
        const h = u.hostname;
        if (h !== '127.0.0.1' && h !== 'localhost' && isBlockedUrl(details.url)) return callback({ cancel: true });
      } catch {}
      callback({});
    });

    // 4399 CDN 校验来源页；外链请求补上当前游戏的 Referer/Cookie
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, async (details, callback) => {
      const headers = { ...(details.requestHeaders || {}) };
      const item = srv.getActiveGame && srv.getActiveGame();
      try {
        const u = new URL(details.url);
        const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
        if (!local && item && isPlayerContext(details)) {
          const ref = item.referer || item.pageUrl;
          if (ref) headers.Referer = ref;
          if (item.cookie) headers.Cookie = item.cookie;
          const cks = await session.defaultSession.cookies.get({ url: details.url });
          if (cks.length) headers.Cookie = cks.map((c) => `${c.name}=${c.value}`).join('; ');
        }
      } catch {}
      callback({ requestHeaders: headers });
    });

    // Ruffle 用 fetch 取跨域素材，HTTPS 请求不经过本地代理，需要补 CORS 头
    session.defaultSession.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
      const headers = { ...(details.responseHeaders || {}) };
      if (!/^http:\/\/127\.0\.0\.1/i.test(details.url) && isPlayerContext(details)) {
        headers['Access-Control-Allow-Origin'] = ['*'];
        headers['Access-Control-Allow-Headers'] = ['*'];
        headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS'];
      }
      callback({ responseHeaders: headers });
    });

    createWindow();
    mainWindow.webContents.once('did-finish-load', () => { smoke().catch((e) => console.error('smoke failed', e)); });
  });

  app.on('window-all-closed', () => { app.quit(); });
}
