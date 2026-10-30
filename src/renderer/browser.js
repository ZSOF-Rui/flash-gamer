(() => {
  const $ = (s) => document.querySelector(s);
  const view = $('#view');
  const addr = $('#addr');
  const status = $('#status');
  let toastTimer = 0;

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
  }

  function setStatus(text) {
    status.textContent = text;
  }

  function normalize(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    if (/^(https?|file):/i.test(s)) return s;
    if (/^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(s)) return `https://${s}`;
    return `https://www.bing.com/search?q=${encodeURIComponent(s)}`;
  }

  function updateNav() {
    try {
      $('#back').disabled = !view.canGoBack();
      $('#fwd').disabled = !view.canGoForward();
    } catch {}
  }

  function syncAddr(url) {
    if (!url || url === 'about:blank') return;
    addr.value = url;
    try {
      localStorage.setItem('flashGamer.lastUrl', url);
    } catch {}
  }

  function go(raw) {
    const url = normalize(raw);
    if (!url) return;
    addr.value = url;
    view.loadURL(url).catch((e) => setStatus(`打开失败：${e.message || e}`));
  }

  $('#go').onclick = () => go(addr.value);
  addr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go(addr.value); }
  });
  addr.addEventListener('focus', () => addr.select());

  $('#back').onclick = () => { try { view.goBack(); } catch {} };
  $('#fwd').onclick = () => { try { view.goForward(); } catch {} };
  $('#reload').onclick = () => { try { view.reload(); } catch {} };

  view.addEventListener('did-navigate', (e) => {
    syncAddr(e.url);
    updateNav();
    setStatus(`当前页面：${e.url}`);
  });
  view.addEventListener('did-navigate-in-page', (e) => {
    if (e.isMainFrame) syncAddr(e.url);
    updateNav();
  });
  view.addEventListener('did-start-loading', () => {
    setStatus('加载中…');
    $('#parse').disabled = true;
  });
  view.addEventListener('did-stop-loading', () => {
    updateNav();
    $('#parse').disabled = false;
    try { setStatus(`当前页面：${view.getURL()}`); } catch {}
  });
  view.addEventListener('page-title-updated', (e) => {
    document.title = `${e.title} — Flash Gamer`;
  });
  view.addEventListener('did-fail-load', (e) => {
    if (e.isMainFrame && e.errorCode !== -3) setStatus(`加载失败（${e.errorCode}）：${e.errorDescription || ''}`);
  });
  view.addEventListener('dom-ready', () => {
    try {
      view.setUserAgent(navigator.userAgent.replace(/\sElectron\/\S+/i, '').replace(/\sFlashGamer\/\S+/i, ''));
    } catch {}
  });

  const parseBtn = $('#parse');
  parseBtn.onclick = async () => {
    let url = '';
    try { url = view.getURL(); } catch (e) { return toast(`读取当前页失败：${e.message}`); }
    if (!/^https?:/i.test(url)) return toast('先打开一个游戏网页，再点“解析此页”');
    parseBtn.disabled = true;
    setStatus('正在抓取页面里的 SWF…');
    try {
      const res = await window.browserApi.parse(url);
      toast(`已加入游戏库：${res.item.title}（${(res.item.size / 1048576).toFixed(1)} MB，共 ${res.count} 个候选）`);
      setStatus('已加入游戏库，可以回到主窗口开始游戏。');
    } catch (e) {
      const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '');
      toast(`解析失败：${msg}`);
      setStatus('解析失败，可先在页面里点“开始游戏”再点“解析此页”。');
    } finally {
      parseBtn.disabled = false;
    }
  };

  window.browserApi.onProgress((msg) => {
    if (msg && msg.type === 'log' && msg.text) setStatus(msg.text);
  });

  try {
    const last = localStorage.getItem('flashGamer.lastUrl');
    if (last && /^https?:/i.test(last)) view.setAttribute('src', last);
  } catch {}

  view.addEventListener('dom-ready', () => {
    try { syncAddr(view.getURL()); } catch {}
    updateNav();
  });
})();
