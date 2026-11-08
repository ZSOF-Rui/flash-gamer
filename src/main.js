const { app, BrowserWindow, Menu, ipcMain, dialog, shell, session, webContents } = require('electron');
const fs = require('fs');
const path = require('path');
const Library = require('./lib/library');
const { createServer } = require('./lib/server');
const { inspectPage } = require('./lib/inspector');
const { fetchBinary } = require('./lib/fetcher');
const { ensureDir, newId, sha256, isSwf, safeFileName, titleFromFileName } = require('./lib/util');
const { isBlockedUrl } = require('./lib/blocklist');
const { Updater, updateChannel } = require('./lib/updater');
const { loadSettings, saveSettings, isWritableDir, isInside } = require('./lib/settings');

const APP_NAME = 'Flash Gamer';
app.setName(APP_NAME);

// 4399 的 Flash 控件和统计接口大量是 http://，HTTPS 页面里会被混合内容拦截
app.commandLine.appendSwitch('allow-running-insecure-content');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function writableDir(dir) {
  try {
    ensureDir(dir);
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveDataDir() {
  if (process.env.AP_DATA_DIR) return process.env.AP_DATA_DIR;
  if (!app.isPackaged) return path.join(__dirname, '..', 'data');
  if (process.platform === 'darwin') {
    return path.join(app.getPath('userData'), 'FlashGamerData');
  }
  const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
  if (fs.existsSync(path.join(base, 'installed.marker'))) {
    return path.join(app.getPath('userData'), 'FlashGamerData');
  }
  const beside = path.join(base, 'FlashGamerData');
  // 绿色版放在只读目录时退回用户目录
  return writableDir(beside) ? beside : path.join(app.getPath('userData'), 'FlashGamerData');
}

const DATA_DIR = resolveDataDir();
const SETTINGS = loadSettings(DATA_DIR);
let LIBRARY_DIR = DATA_DIR;
let libraryWarning = '';
if (SETTINGS.libraryDir) {
  const custom = path.resolve(SETTINGS.libraryDir);
  if (isWritableDir(custom)) {
    LIBRARY_DIR = custom;
  } else {
    libraryWarning = `自定义下载目录不可写，已临时使用默认目录：${custom}`;
  }
}
const LEGACY_DATA_DIR = app.isPackaged && !SETTINGS.libraryDir
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
const browserGuestIds = new Set();
let ruffleSourceCache = null;
let browserFlashOk = false;
let updater = null;
let installerPath = null;

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

// Electron 默认不提供右键菜单，输入框里右键没有“粘贴”。给可编辑区域补上系统菜单。
function attachEditMenu(contents, win) {
  contents.on('context-menu', (_event, params) => {
    const template = [];
    if (params.isEditable) {
      template.push(
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      template.push({ role: 'copy', label: '复制' }, { type: 'separator' }, { role: 'selectAll', label: '全选' });
    } else {
      return;
    }
    Menu.buildFromTemplate(template).popup(win && !win.isDestroyed() ? { window: win } : {});
  });
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
  attachEditMenu(mainWindow.webContents, mainWindow);

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

function notifyGameWindow(id, open) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('game:window', { id, open });
  }
}

function closeGameWindows(id) {
  let closed = 0;
  for (const [gid, win] of [...gameWindows]) {
    if (id && gid !== id) continue;
    if (win.isDestroyed()) {
      gameWindows.delete(gid);
      continue;
    }
    win.close();
    closed++;
  }
  return closed;
}

function openGameWindow(id) {
  const item = lib.get(id);
  if (!item) throw new Error('游戏不存在');
  const existing = gameWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    notifyGameWindow(id, true);
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
  attachEditMenu(win.webContents, win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    gameWindows.delete(id);
    notifyGameWindow(id, false);
  });
  gameWindows.set(id, win);
  notifyGameWindow(id, true);
  return true;
}

function loadRuffleSource() {
  if (ruffleSourceCache !== null) return ruffleSourceCache;
  try {
    ruffleSourceCache = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'ruffle', 'ruffle.js'), 'utf8');
  } catch (e) {
    ruffleSourceCache = '';
    console.error('[flashgamer] 读取 ruffle.js 失败:', e.message);
  }
  return ruffleSourceCache;
}

function buildBrowserInjection(port) {
  const ruffle = loadRuffleSource();
  if (!ruffle) return '';
  const config = {
    publicPath: `http://localhost:${port}/vendor/ruffle/`,
    autoplay: 'on',
    unmuteOverlay: 'visible',
    letterbox: 'on',
    scale: 'showAll',
    quality: 'high',
    warnOnUnsupportedContent: false,
    logLevel: 'error',
    openUrlMode: 'deny',
    allowNetworking: 'all',
    allowScriptAccess: true,
    upgradeToHttps: false,
    allowFullscreen: true,
    contextMenu: 'on',
    backgroundColor: '#000000',
    preloader: true,
    splashScreen: false,
    polyfills: true
  };
  return [
    '(() => {',
    "  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;",
    "  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;",
    '  const host = location.hostname;',
    "  const is4399 = /(^|\\.)4399\\.com$/i.test(host) || /(^|\\.)4399pk\\.com$/i.test(host);",
    '  const apRewrite = function (raw) {',
    '    try {',
    "      const u = new URL(String(raw), location.href);",
    "      if (u.protocol !== 'http:') return raw;",
    "      if (u.hostname === 'cdn.comment.4399pk.com' && /\\/control\\/ctrl_mo_v5\\.swf$/i.test(u.pathname)) {",
    `        return 'http://localhost:${port}/vendor/4399/ctrl_mo_v5.swf';`,
    '      }',
    "      if (/(^|\\.)(4399\\.com|4399pk\\.com|5054399\\.com)$/i.test(u.hostname)) {",
    "        u.protocol = 'https:';",
    '        return u.href;',
    '      }',
    '    } catch (e) {}',
    '    return raw;',
    '  };',
    '  if (!window.__apUrlRewrite) {',
    '    window.__apUrlRewrite = true;',
    '    const origFetch = window.fetch;',
    '    if (origFetch) {',
    '      window.fetch = function (input, init) {',
    '        try {',
    "          if (typeof input === 'string') input = apRewrite(input);",
    '          else if (input && input.url) {',
    '            const next = apRewrite(input.url);',
    '            if (next !== input.url) input = new Request(next, input);',
    '          }',
    '        } catch (e) {}',
    '        return origFetch.call(this, input, init);',
    '      };',
    '    }',
    '    const origOpen = XMLHttpRequest.prototype.open;',
    '    XMLHttpRequest.prototype.open = function (method, url) {',
    '      const args = Array.prototype.slice.call(arguments);',
    '      args[1] = apRewrite(url);',
    '      return origOpen.apply(this, args);',
    '    };',
    '  }',
    '  window.RufflePlayer = window.RufflePlayer || {};',
    `  window.RufflePlayer.config = Object.assign({}, window.RufflePlayer.config, ${JSON.stringify(config)});`,
    '  if (is4399) {',
    '    try {',
    '      const origGet = Document.prototype.getElementById;',
    '      Document.prototype.getElementById = function (id) {',
    "        if (id === 'testplayer1' || id === 'testplayer') {",
    '          const el = origGet.call(this, id);',
    '          if (el) { try { el.checkflash = function () { return 1; }; } catch (e) {} return el; }',
    '          return { checkflash: function () { return 1; } };',
    '        }',
    '        return origGet.call(this, id);',
    '      };',
    '    } catch (e) {}',
    '    const gateIds = ["Anti_open", "Anti_mask", "Anti_dialog"];',
    '    const hideGate = function () {',
    '      for (const id of gateIds) {',
    '        const g = document.getElementById(id);',
    '        if (!g || g === document.documentElement || g === document.body) continue;',
    "        if (g.style.visibility !== 'hidden') g.style.visibility = 'hidden';",
    "        if (g.style.pointerEvents !== 'none') g.style.pointerEvents = 'none';",
    '      }',
    '    };',
    '    const watchGate = function () {',
    '      hideGate();',
    '      setTimeout(hideGate, 1200);',
    '      setTimeout(hideGate, 3500);',
    '      try { new MutationObserver(hideGate).observe(document.documentElement || document, { childList: true, subtree: true }); } catch (e) {}',
    '    };',
    "    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchGate, { once: true });",
    '    else watchGate();',
    '    const isPlayPage = /\\/flash\\/\\d+(_\\d+)?\\.htm/i.test(location.pathname);',
    '    const reveal4399 = function () {',
    '      try {',
    '        if (!document.querySelector("ruffle-embed, ruffle-player")) return false;',
    '        const addiv = document.getElementById("addiv");',
    '        if (addiv) addiv.style.display = "none";',
    '        const loadingdiv = document.getElementById("loadingdiv");',
    '        if (loadingdiv) loadingdiv.style.display = "none";',
    '        const pusher = document.getElementById("pusher");',
    '        if (pusher) { pusher.style.display = "none"; pusher.style.height = "0px"; }',
    '        const swfdiv = document.getElementById("swfdiv");',
    '        if (swfdiv) swfdiv.style.display = "block";',
    '        return true;',
    '      } catch (e) { return false; }',
    '    };',
    '    if (isPlayPage) {',
    '      let tries = 0;',
    '      const timer = setInterval(function () {',
    '        reveal4399();',
    '        if (++tries > 120) clearInterval(timer);',
    '      }, 250);',
    '    }',
    '  }',
    ruffle,
    '})();'
  ].join('\n');
}

async function ensureBrowserFlash(guest) {
  if (!guest || guest.isDestroyed()) return false;
  browserGuestIds.add(guest.id);
  const injection = buildBrowserInjection(srv.port);
  if (!injection) return false;
  try {
    if (!guest.debugger.isAttached()) {
      guest.debugger.attach('1.3');
      await guest.debugger.sendCommand('Page.enable');
      await guest.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: injection,
        runImmediately: true
      });
    }
    console.log('[flashgamer] 网页 Flash 注入完成:', guest.getURL());
    return true;
  } catch (e) {
    console.error('[flashgamer] 网页 Flash 注入失败:', e.message);
    return false;
  }
}

function notifyBrowserFlash(ok) {
  browserFlashOk = !!ok;
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.webContents.send('browser:flash-ready', { ok: browserFlashOk });
  }
}

function openBrowserWindow() {
  if (browserWindow && !browserWindow.isDestroyed()) {
    if (browserWindow.isMinimized()) browserWindow.restore();
    browserWindow.show();
    browserWindow.focus();
    return true;
  }
  browserFlashOk = false;
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
  attachEditMenu(browserWindow.webContents, browserWindow);
  browserWindow.on('closed', () => { browserWindow = null; });
  browserWindow.webContents.on('did-attach-webview', (_event, guest) => {
    attachEditMenu(guest, browserWindow);
    browserGuestIds.add(guest.id);
    guest.once('destroyed', () => browserGuestIds.delete(guest.id));
    // 弹窗在当前网页视图里打开，保留地址栏和“解析此页”；必须延后一帧再导航，
    // 在 window-open 回调里同步 loadURL 会把宿主窗口一起带崩。
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) {
        setImmediate(() => {
          if (!guest.isDestroyed()) guest.loadURL(url).catch(() => {});
        });
      }
      return { action: 'deny' };
    });
    // 先让 guest 停在 about:blank，再挂调试器。刚创建就 attach 会把网络服务带崩。
    setImmediate(async () => {
      try {
        if (!guest.isDestroyed()) await guest.loadURL('about:blank');
      } catch {}
      await new Promise((r) => setTimeout(r, 120));
      notifyBrowserFlash(await ensureBrowserFlash(guest));
    });
    // 渲染进程崩溃或页面在注入前已跳转时，补挂一次并重载当前页
    guest.on('did-navigate', async () => {
      if (guest.isDestroyed() || guest.debugger.isAttached()) return;
      const url = guest.getURL();
      if (!/^https?:/i.test(url)) return;
      if (await ensureBrowserFlash(guest)) {
        try { guest.reload(); } catch {}
      }
    });
  });
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

function isBrowserGuestContext(details) {
  return !!details.webContentsId && browserGuestIds.has(details.webContentsId);
}

async function applyLibraryDir({ dir, migrate } = {}) {
  const raw = String(dir || '').trim();
  if (!raw) throw new Error('请选择目录');
  const target = path.resolve(raw);
  const current = path.resolve(LIBRARY_DIR);
  if (target === current) return { changed: false };
  if (isInside(current, target)) throw new Error('新目录不能放在当前游戏库目录里面');
  if (!isWritableDir(target)) throw new Error('目录不可写，请换一个位置');

  const targetHasLibrary = fs.existsSync(path.join(target, 'library.json'));
  let copied = 0;
  let usedExisting = false;

  if (targetHasLibrary) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['使用目标目录', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '目标目录已有游戏库',
      message: '新目录里已经有一个游戏库',
      detail: '切换后将显示该目录里的游戏，当前目录的文件不会被删除。'
    });
    if (response !== 0) return { changed: false, canceled: true };
    usedExisting = true;
  } else if (migrate && lib.list().length) {
    await fs.promises.cp(path.join(current, 'items'), path.join(target, 'items'), {
      recursive: true,
      force: false,
      errorOnExist: false
    });
    const db = path.join(current, 'library.json');
    if (fs.existsSync(db)) await fs.promises.copyFile(db, path.join(target, 'library.json'));
    copied = lib.list().length;
  }

  const stored = target === path.resolve(DATA_DIR) ? '' : target;
  SETTINGS.libraryDir = stored;
  saveSettings(DATA_DIR, SETTINGS);
  LIBRARY_DIR = target;
  return { changed: true, restartRequired: true, copied, usedExisting, libraryDir: target };
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

  ipcMain.handle('library:stop', () => closeGameWindows());

  ipcMain.handle('library:windows', () => [...gameWindows]
    .filter(([, win]) => !win.isDestroyed())
    .map(([id]) => id));

  ipcMain.handle('browser:open', () => openBrowserWindow());

  ipcMain.handle('browser:flashState', () => ({ ready: browserFlashOk }));

  ipcMain.handle('update:version', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    channel: updateChannel()
  }));

  ipcMain.handle('update:check', () => updater.check(app.getVersion()));

  ipcMain.handle('update:download', async () => {
    const res = await updater.download((p) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:progress', p);
    });
    installerPath = res.path;
    return res;
  });

  ipcMain.handle('update:install', async () => {
    if (!installerPath || !fs.existsSync(installerPath)) throw new Error('更新包不存在，请重新下载');
    const ext = path.extname(installerPath).toLowerCase();
    if (process.platform === 'darwin') {
      if (ext === '.dmg') {
        const err = await shell.openPath(installerPath);
        if (err) throw new Error(err);
        return { opened: true, message: '已打开 DMG，请把 Flash Gamer 拖进「应用程序」完成更新，然后重新打开。' };
      }
      shell.showItemInFolder(installerPath);
      return { opened: true, message: '更新包已下载。请解压后把 Flash Gamer 拖进「应用程序」。' };
    }
    const err = await shell.openPath(installerPath);
    if (err) throw new Error(err);
    setTimeout(() => { try { app.quit(); } catch {} }, 1200);
    return { opened: true, message: '安装程序已启动，应用即将退出。' };
  });

  ipcMain.handle('settings:get', () => ({
    libraryDir: LIBRARY_DIR,
    defaultDir: DATA_DIR,
    custom: !!SETTINGS.libraryDir,
    warning: libraryWarning,
    itemCount: lib.list().length,
    totalSize: lib.list().reduce((n, it) => n + (Number(it.size) || 0), 0),
    platform: process.platform,
    arch: process.arch,
    channel: updateChannel(),
    version: app.getVersion()
  }));

  ipcMain.handle('settings:chooseLibraryDir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择 SWF 下载目录',
      buttonLabel: '使用此目录',
      defaultPath: LIBRARY_DIR,
      properties: ['openDirectory', 'createDirectory']
    });
    return canceled || !filePaths.length ? '' : filePaths[0];
  });

  ipcMain.handle('settings:setLibraryDir', (_e, payload) => applyLibraryDir(payload));

  ipcMain.handle('settings:openLibraryDir', async () => {
    const err = await shell.openPath(LIBRARY_DIR);
    if (err) throw new Error(err);
    return true;
  });

  ipcMain.handle('app:restart', () => {
    app.relaunch();
    app.exit(0);
    return true;
  });

  ipcMain.handle('browser:parse', async (_e, pageUrl) => {    if (!/^https?:/i.test(String(pageUrl || ''))) throw new Error('当前不是网页地址');
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
    closeGameWindows(id);
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
      if (process.env.AP_SMOKE_STOP === '1') {
        result.stopBefore = await mainWindow.webContents.executeJavaScript(`(() => ({
          stopDisabled: document.getElementById('btnStop').disabled,
          playing: document.querySelector('.stage').classList.contains('playing'),
          status: document.getElementById('status').textContent,
          frame: document.getElementById('frame').src
        }))()`);
        result.stopBeforeWindows = [...gameWindows.keys()];
        await mainWindow.webContents.executeJavaScript(`document.getElementById('btnStop').click()`);
        await new Promise((r) => setTimeout(r, 1500));
        result.stopAfter = await mainWindow.webContents.executeJavaScript(`(() => ({
          stopDisabled: document.getElementById('btnStop').disabled,
          playing: document.querySelector('.stage').classList.contains('playing'),
          status: document.getElementById('status').textContent,
          frame: document.getElementById('frame').src,
          placeholder: document.querySelector('#placeholder p').textContent
        }))()`);
        result.stopAfterWindows = [...gameWindows.keys()];
        await shot('stopped');
        if (process.env.AP_SMOKE_STOP_REPLAY === '1') {
          await mainWindow.webContents.executeJavaScript(`document.getElementById('btnPlay').click()`);
          await new Promise((r) => setTimeout(r, Math.min(playWait, 4000)));
          result.stopReplay = await mainWindow.webContents.executeJavaScript(`(() => ({
            stopDisabled: document.getElementById('btnStop').disabled,
            playing: document.querySelector('.stage').classList.contains('playing'),
            status: document.getElementById('status').textContent,
            frame: document.getElementById('frame').src
          }))()`);
        }
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

  if (process.env.AP_SMOKE_BROWSER_FLASH === '1') {
    try {
      if (!browserWindow || browserWindow.isDestroyed()) openBrowserWindow();
      await new Promise((r) => setTimeout(r, 4500));
      const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview');
      result.browserGuest = guest ? { id: guest.id, url: guest.getURL() } : null;
      if (!guest) throw new Error('webview guest 未创建');
      const guestLogs = [];
      guest.on('console-message', (_e, level, message, line, sourceId) => guestLogs.push({ level, message, line, sourceId }));
      result.flashConsole = guestLogs;
      const target = process.env.AP_SMOKE_BROWSER_FLASH_URL || 'https://www.4399.com/flash/10802_1.htm';
      await guest.loadURL(target);
      await new Promise((r) => setTimeout(r, Number(process.env.AP_SMOKE_FLASH_WAIT) || 22000));
      const readFlash = () => guest.executeJavaScript(`(() => {
        const embeds = [...document.querySelectorAll('ruffle-embed, ruffle-player')];
        const meta = embeds.map((e) => e.metadata ? { w: e.metadata.width, h: e.metadata.height, frames: e.metadata.numFrames, rate: e.metadata.frameRate, swf: e.metadata.swfFileName || '' } : null);
        const gate = document.getElementById('Anti_open');
        return {
          href: location.href,
          title: document.title,
          embeds: embeds.length,
          meta,
          gate: gate ? getComputedStyle(gate).visibility : null,
          ruffle: !!window.RufflePlayer,
          csp: !!document.querySelector('meta[http-equiv="Content-Security-Policy" i]')
        };
      })()`);
      result.flash = await readFlash();
      if (process.env.AP_SMOKE_FLASH_DOM === '1') {
        result.flashDom = await guest.executeJavaScript(`(() => {
          const out = { texts: [], divs: [] };
          document.querySelectorAll('body *').forEach((el) => {
            const t = el.childElementCount === 0 ? (el.textContent || '').trim() : '';
            if (t.includes('健康游戏忠告') || t.includes('适龄')) out.texts.push({ tag: el.tagName, id: el.id, cls: String(el.className || '').slice(0, 40), text: t.slice(0, 60) });
          });
          ['addiv', 'loadingdiv', 'swfdiv', 'gamebox', 'game'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) { out.divs.push({ id, missing: true }); return; }
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            out.divs.push({ id, display: s.display, z: s.zIndex, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], text: (el.innerText || '').slice(0, 60).replace(/\\s+/g, ' '), html: el.innerHTML.slice(0, 160) });
          });
          return out;
        })()`);
      }
      try {
        result.frames = [];
        for (const f of guest.mainFrame.framesInSubtree) {
          try {
            const info = await f.executeJavaScript(`(() => {
              const embeds = [...document.querySelectorAll('ruffle-embed, ruffle-player')];
              return {
                href: location.href,
                embeds: embeds.length,
                meta: embeds.map((e) => e.metadata ? { w: e.metadata.width, h: e.metadata.height, frames: e.metadata.numFrames, rate: e.metadata.frameRate } : null),
                ruffle: !!window.RufflePlayer
              };
            })()`);
            result.frames.push({ url: f.url, name: f.name, info });
          } catch (e) {
            result.frames.push({ url: f.url, name: f.name, error: String(e.message || e).slice(0, 200) });
          }
        }
      } catch (e) { result.framesError = String(e.message || e); }
      try {
        const img = await browserWindow.capturePage();
        const file = path.join(DATA_DIR, 'smoke-browser-flash.png');
        fs.writeFileSync(file, img.toPNG());
        result.browserFlashShot = file;
      } catch (e) { result.browserFlashShotError = String(e.message || e); }
      if (process.env.AP_SMOKE_FLASH_DEBUG === '1') {
        result.overlays = await guest.executeJavaScript(`(() => {
          const out = [];
          document.querySelectorAll('body *').forEach((el) => {
            const s = getComputedStyle(el);
            if ((s.position === 'fixed' || s.position === 'absolute') && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.zIndex) > 500) {
              const r = el.getBoundingClientRect();
              if (r.width * r.height > 40000) out.push({ id: el.id, cls: String(el.className || '').slice(0, 60), z: s.zIndex, pos: s.position, bg: s.backgroundColor, op: s.opacity, text: (el.innerText || '').slice(0, 50).replace(/\\s+/g, ' ') });
            }
          });
          return out.slice(0, 20);
        })()`);
      }
      if (process.env.AP_SMOKE_FLASH_CLICK === '1') {
        const navs = [];
        const navHandler = (_e, url) => navs.push(url);
        guest.on('did-navigate', navHandler);
        if (process.env.AP_SMOKE_FLASH_CLICK_TEXT) {
          const text = JSON.stringify(process.env.AP_SMOKE_FLASH_CLICK_TEXT);
          result.flashClickText = await guest.executeJavaScript(`(() => {
            const want = ${text};
            const els = [...document.querySelectorAll('a, button, div, span')].filter((el) => el.textContent.trim() === want && el.offsetParent);
            const el = els[els.length - 1];
            if (!el) return { clicked: false, count: els.length };
            el.click();
            return { clicked: true, tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 50), count: els.length };
          })()`);
        }
        const xySpec = process.env.AP_SMOKE_FLASH_CLICK_XY;
        let points;
        if (process.env.AP_SMOKE_FLASH_CLICK_IFRAME) {
          // 游戏渲染在跨域 iframe 的 Ruffle 画布里，DOM 取不到按钮；按 iframe 矩形比例定位
          const [fx, fy] = process.env.AP_SMOKE_FLASH_CLICK_IFRAME.split(',').map(Number);
          const rect = await guest.executeJavaScript(`(() => {
            const ifs = [...document.querySelectorAll('iframe')].map((f) => { const r = f.getBoundingClientRect(); return { src: f.src, x: r.x, y: r.y, w: r.width, h: r.height }; }).filter((r) => r.w > 200 && r.h > 200);
            return ifs.find((r) => /sda\\.4399\\.com|4399swf/.test(r.src)) || ifs.sort((a, b) => b.w * b.h - a.w * a.h)[0] || null;
          })()`);
          result.clickIframeRect = rect;
          points = rect ? [[Math.round(rect.x + fx * rect.w), Math.round(rect.y + fy * rect.h)]] : [];
        } else {
          points = (xySpec === undefined ? '560,450;560,690;900,730' : xySpec)
            .split(';')
            .map((p) => p.split(',').map(Number))
            .filter((p) => p.length === 2 && p.every(Number.isFinite));
        }
        for (const [x, y] of points) {
          if (process.env.AP_SMOKE_FLASH_CDP === '1') {
            await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
            await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
          } else {
            guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
            guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        await new Promise((r) => setTimeout(r, Number(process.env.AP_SMOKE_FLASH_CLICK_WAIT) || 10000));
        guest.removeListener('did-navigate', navHandler);
        result.flashNavs = navs;
        result.flashAfterClick = await readFlash();
        result.overlaysAfterClick = await guest.executeJavaScript(`(() => {
          const out = [];
          document.querySelectorAll('body *').forEach((el) => {
            const s = getComputedStyle(el);
            if ((s.position === 'fixed' || s.position === 'absolute') && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.zIndex) > 500) {
              const r = el.getBoundingClientRect();
              if (r.width * r.height > 40000) out.push({ id: el.id, cls: String(el.className || '').slice(0, 60), z: s.zIndex, bg: s.backgroundColor, text: (el.innerText || '').slice(0, 50).replace(/\\s+/g, ' ') });
            }
          });
          return out.slice(0, 20);
        })()`);
      }
      try {
        const img = await browserWindow.capturePage();
        const file = path.join(DATA_DIR, 'smoke-browser-flash-after.png');
        fs.writeFileSync(file, img.toPNG());
        result.browserFlashAfterShot = file;
      } catch (e) { result.browserFlashAfterShotError = String(e.message || e); }
    } catch (e) {
      result.browserFlashError = String(e.stack || e);
    }
  }

  if (process.env.AP_SMOKE_UPDATE === '1') {
    try {
      const waitFor = async (expr, timeout = 20000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (await mainWindow.webContents.executeJavaScript(expr)) return true;
          await new Promise((r) => setTimeout(r, 300));
        }
        return false;
      };
      const readUpdate = () => mainWindow.webContents.executeJavaScript(`(() => ({
        modal: !document.getElementById('updateModal').classList.contains('hidden'),
        title: document.getElementById('updateTitle').textContent,
        meta: document.getElementById('updateMeta').textContent,
        notes: document.getElementById('updateNotes').textContent,
        state: document.getElementById('updateState').textContent,
        action: document.getElementById('btnUpdateAction').textContent,
        button: document.getElementById('btnUpdate').textContent,
        progress: document.getElementById('updateProgressBar').style.width
      }))()`);
      await mainWindow.webContents.executeJavaScript(`document.getElementById('btnUpdate').click()`);
      result.updateModalOpened = await waitFor(`!document.getElementById('updateModal').classList.contains('hidden')`);
      result.updateCheck = await readUpdate();
      await mainWindow.webContents.executeJavaScript(`document.getElementById('btnUpdateAction').click()`);
      result.updateDownloaded = await waitFor(`document.getElementById('btnUpdateAction').textContent === '立即安装' || document.getElementById('updateState').textContent.startsWith('下载失败')`, 60000);
      result.updateAfter = await readUpdate();
      try {
        const img = await mainWindow.capturePage();
        const file = path.join(DATA_DIR, 'smoke-update.png');
        fs.writeFileSync(file, img.toPNG());
        result.updateShot = file;
      } catch (e) { result.updateShotError = String(e.message || e); }
    } catch (e) {
      result.updateError = String(e.stack || e);
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
    lib = new Library(LIBRARY_DIR);
    // 更新检查独立会话：跟随系统代理，不受浏览器代理与请求头注入影响
    const updateSession = session.fromPartition('flash-gamer-updater');
    updater = new Updater({
      dataDir: DATA_DIR,
      fetch: (url, init) => updateSession.fetch(url, init)
    });
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

    // Ruffle 用 fetch 取跨域素材，HTTPS 请求不经过本地代理，需要补 CORS 头。
    // 但 4399 的在线数据接口（save.api/stat.api 等）自己已返回 Access-Control-Allow-Origin
    // 并带 Allow-Credentials，再叠加一个 * 会变成 "https://sda.4399.com, *" 被浏览器判为
    // 非法多值而拦截，造梦西游等在线游戏因此卡在“加载出错”。上游已给 CORS 时原样保留。
    session.defaultSession.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
      const headers = { ...(details.responseHeaders || {}) };
      const webPage = isPlayerContext(details) || isBrowserGuestContext(details);
      const hasACAO = Object.keys(headers).some((k) => k.toLowerCase() === 'access-control-allow-origin');
      if (!/^http:\/\/(127\.0\.0\.1|localhost)/i.test(details.url) && webPage && !hasACAO) {
        for (const k of Object.keys(headers)) {
          if (/^access-control-allow-(headers|methods|private-network)$/i.test(k)) delete headers[k];
        }
        headers['Access-Control-Allow-Origin'] = ['*'];
        headers['Access-Control-Allow-Headers'] = ['*'];
        headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS'];
        headers['Access-Control-Allow-Private-Network'] = ['true'];
      }
      callback({ responseHeaders: headers });
    });

    createWindow();
    mainWindow.webContents.once('did-finish-load', () => {
      smoke().catch((e) => console.error('smoke failed', e));
      if (!process.env.AP_SMOKE && process.env.AP_UPDATE_DISABLE !== '1') {
        setTimeout(async () => {
          try {
            const r = await updater.check(app.getVersion());
            if (r.available && mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('update:available', r);
            }
          } catch (e) {
            console.log('[update] 检查失败', e.message);
          }
        }, 6000);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow && srv) createWindow();
  });
}
