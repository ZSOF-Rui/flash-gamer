const $ = (sel) => document.querySelector(sel);

const state = {
  items: [],
  selected: null,
  inspecting: false,
  pending: null,
  candKey: null,
  poll: null
};

function fmt(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function setStatus(text, busy = false) {
  $('#status').innerHTML = busy ? `<span class="spin"></span>${text}` : text;
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return `${x.hostname}${x.pathname}`;
  } catch {
    return u;
  }
}

async function refresh() {
  state.items = await window.api.list();
  $('#count').textContent = String(state.items.length);
  renderList();
}

function renderList() {
  const list = $('#list');
  if (!state.items.length) {
    list.innerHTML = '<div class="empty-tip">游戏库是空的。<br>先在上方解析一个 4399 / 7k7k 链接，<br>或者导入本地 .swf。</div>';
    return;
  }
  list.innerHTML = '';
  for (const it of state.items) {
    const el = document.createElement('button');
    el.className = `item${state.selected && state.selected.id === it.id ? ' active' : ''}`;
    const thumb = it.cover ? `<img src="/cover/${it.id}" alt="">` : (it.title || '?').slice(0, 1);
    el.innerHTML = `<div class="thumb">${thumb}</div><div class="item-text"><strong></strong><span></span></div>`;
    el.querySelector('strong').textContent = it.title;
    el.querySelector('span').textContent = `${fmt(it.size)} · ${it.source || '本地'}`;
    el.onclick = () => select(it.id, false);
    list.appendChild(el);
  }
}

function stopPolling() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
}

async function updateCacheLine() {
  if (!state.selected) {
    $('#cacheLine').textContent = '缓存 0 B';
    $('#cachedInfo').textContent = '';
    return;
  }
  try {
    const s = await window.api.cacheStats(state.selected.id);
    $('#cacheLine').textContent = `缓存 ${fmt(s.bytes)} · ${s.count} 个资源`;
    $('#cachedInfo').textContent = s.count ? `已缓存 ${s.count} 个资源 · ${fmt(s.bytes)}` : '尚未缓存附加资源';
  } catch {}
}

async function select(id, autoplay) {
  state.selected = state.items.find((x) => x.id === id) || null;
  renderList();
  const it = state.selected;
  const on = !!it;
  for (const b of ['#btnPlay', '#btnWindow', '#btnReload', '#btnFolder', '#btnDelete']) $(b).disabled = !on;
  if (!it) return;

  $('#gameTitle').textContent = it.title;
  const bits = [it.source, fmt(it.size), it.originalUrl ? '网页抓取' : '本地文件'];
  $('#gameMeta').textContent = bits.filter(Boolean).join(' · ');
  await updateCacheLine();

  if (autoplay) await play();
}

async function play() {
  const it = state.selected;
  if (!it) return;
  try {
    const url = await window.api.play(it.id);
    const frame = $('#frame');
    frame.src = `${url}?ts=${Date.now()}`;
    document.querySelector('.stage').classList.add('playing');
    setStatus(`运行中：${it.title}`);
    stopPolling();
    state.poll = setInterval(updateCacheLine, 4000);
    updateCacheLine();
  } catch (e) {
    toast(`启动失败：${e.message}`);
  }
}

function enablePlayButtons(on) {
  for (const b of ['#btnPlay', '#btnWindow', '#btnReload', '#btnFolder', '#btnDelete']) $(b).disabled = !on;
}

/* ---------- 解析流程 ---------- */

async function doParse() {
  const url = $('#url').value.trim();
  if (!url) return toast('先粘贴一个游戏页链接');
  if (state.inspecting) return;
  state.inspecting = true;
  $('#btnParse').disabled = true;
  setStatus('正在打开页面并抓取 SWF…', true);
  try {
    const res = await window.api.inspect(url);
    if (!res.candidates.length) {
      setStatus('未发现 SWF');
      toast(res.hasH5 ? '这是 H5 游戏，页面里没有 SWF 可提取' : '没抓到 SWF，可能需要在页面上手动点“开始游戏”');
      return;
    }
    setStatus(`抓到 ${res.candidates.length} 个 Flash 文件`);
    if (res.candidates.length === 1) {
      await addCandidate(res, res.candidates[0].key);
    } else {
      openModal(res);
    }
  } catch (e) {
    const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '');
    setStatus('解析失败');
    toast(`解析失败：${msg}`);
  } finally {
    state.inspecting = false;
    $('#btnParse').disabled = false;
  }
}

async function addCandidate(res, key) {
  setStatus('正在保存游戏文件…', true);
  const item = await window.api.add({ sessionId: res.sessionId, key, title: res.title });
  await refresh();
  await select(item.id, true);
  toast('已加入游戏库');
  setStatus('就绪');
}

function openModal(res) {
  state.pending = res;
  state.candKey = res.candidates[0].key;
  $('#modalHint').textContent = `页面里检测到 ${res.candidates.length} 个 Flash 文件。已按来源和体积排序，第一个通常是游戏本体；标“外站”的多半是广告，不要选。`;
  const box = $('#candList');
  box.innerHTML = '';
  res.candidates.forEach((c, i) => {
    const row = document.createElement('label');
    row.className = `cand${i === 0 ? ' sel' : ''}`;
    row.innerHTML = `
      <input type="radio" name="cand" value="${c.key}" ${i === 0 ? 'checked' : ''}>
      <div class="cand-main">
        <b>${c.sizeText}</b>
        <span class="tag${c.crossSite ? ' warn' : ''}">${c.crossSite ? '外站文件' : c.via === 'declared' ? '页面声明' : '实际加载'}</span>
        <code></code>
      </div>`;
    row.querySelector('code').textContent = shortUrl(c.url);
    row.querySelector('input').onchange = () => {
      state.candKey = c.key;
      [...box.children].forEach((x) => x.classList.remove('sel'));
      row.classList.add('sel');
      $('#btnConfirm').disabled = false;
    };
    box.appendChild(row);
  });
  $('#btnConfirm').disabled = false;
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
  state.pending = null;
  state.candKey = null;
}

/* ---------- 事件绑定 ---------- */

$('#btnParse').onclick = doParse;
$('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') doParse(); });

$('#btnPlay').onclick = play;
$('#btnWindow').onclick = async () => {
  if (!state.selected) return;
  try {
    await window.api.openWindow(state.selected.id);
    toast('已用独立窗口启动，主窗口可以继续操作');
  } catch (e) {
    toast('打开失败：' + e.message);
  }
};
$('#btnReload').onclick = () => {
  if (!state.selected) return;
  const frame = $('#frame');
  frame.src = 'about:blank';
  setTimeout(play, 60);
};
$('#btnFolder').onclick = () => state.selected && window.api.reveal(state.selected.id);
$('#btnDelete').onclick = async () => {
  if (!state.selected) return;
  const ok = await window.api.remove(state.selected.id);
  if (ok) {
    stopPolling();
    state.selected = null;
    $('#frame').src = 'about:blank';
    document.querySelector('.stage').classList.remove('playing');
    $('#gameTitle').textContent = '还没有选择游戏';
    $('#gameMeta').textContent = '解析一个链接，或者导入手头的 .swf';
    enablePlayButtons(false);
    await refresh();
    toast('已删除');
  }
};

$('#btnBrowser').onclick = () => window.api.openBrowser();

$('#btnImport').onclick = async () => {
  const added = await window.api.importSwf();
  if (added && added.length) {
    await refresh();
    await select(added[0].id, true);
    toast(`已导入 ${added.length} 个文件`);
  }
};

$('#btnCancel').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
$('#btnConfirm').onclick = async () => {
  if (!state.pending || !state.candKey) return;
  const res = state.pending;
  const key = state.candKey;
  closeModal();
  try {
    await addCandidate(res, key);
  } catch (e) {
    toast(`保存失败：${e.message}`);
    setStatus('保存失败');
  }
};

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  let count = 0;
  for (const f of files) {
    const p = window.api.pathForFile(f);
    if (p && p.toLowerCase().endsWith('.swf')) {
      const added = await window.api.importPath(p);
      count += added.length;
    }
  }
  if (count) {
    await refresh();
    toast(`已导入 ${count} 个 SWF`);
  } else {
    toast('只接受 .swf 文件');
  }
});

window.api.onProgress((msg) => {
  if (msg.type === 'log') setStatus(msg.text);
});

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || !d.__ap) return;
  if (d.type === 'meta' && d.meta && d.meta.width) {
    $('#cachedInfo').textContent = `画面 ${d.meta.width}×${d.meta.height} · ${d.meta.frameRate || '?'} fps`;
    setTimeout(updateCacheLine, 1200);
  }
  if (d.type === 'error') {
    toast(`播放器：${d.message}`);
  }
});

window.api.onLibraryChanged(async () => { await refresh(); });

/* ---------- 软件更新 ---------- */

const upd = { info: null, downloaded: null, busy: false };

function errText(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '');
}

function setUpdateButton(label, hasUpdate) {
  const b = $('#btnUpdate');
  b.textContent = label;
  b.classList.toggle('has-update', !!hasUpdate);
}

function showUpdate(info) {
  upd.info = info;
  $('#updateTitle').textContent = `发现新版本 v${info.version}`;
  const bits = [`当前 v${info.current}`];
  if (info.size) bits.push(`安装包 ${fmt(info.size)}`);
  if (info.publishedAt) {
    const d = new Date(info.publishedAt);
    if (!Number.isNaN(d.getTime())) bits.push(d.toLocaleDateString('zh-CN'));
  }
  $('#updateMeta').textContent = bits.join(' · ');
  $('#updateNotes').textContent = info.notes || '本次更新暂未附说明。';
  $('#updateProgressWrap').classList.add('hidden');
  $('#updateProgressBar').style.width = '0%';
  $('#updateState').textContent = '';
  const action = $('#btnUpdateAction');
  action.textContent = upd.downloaded ? '立即安装' : '下载并安装';
  action.disabled = false;
  $('#updateModal').classList.remove('hidden');
}

function closeUpdate() { $('#updateModal').classList.add('hidden'); }

async function checkUpdate(silent) {
  if (upd.busy) return;
  upd.busy = true;
  const btn = $('#btnUpdate');
  btn.disabled = true;
  if (!silent) { setUpdateButton('正在检查…', false); setStatus('正在检查更新…', true); }
  try {
    const info = await window.api.checkUpdate();
    upd.info = info;
    const reachable = (info.sources || []).filter((s) => s.ok).length;
    if (info.available) {
      setUpdateButton(`发现 v${info.version}，点击更新`, true);
      if (!silent) { showUpdate(info); setStatus('就绪'); }
    } else if (!reachable) {
      setUpdateButton('检查更新', false);
      if (!silent) { toast('检查更新失败：更新源暂时连不上'); setStatus('检查更新失败'); }
    } else {
      setUpdateButton('检查更新', false);
      if (!silent) { toast(`已是最新版本 v${info.current}`); setStatus('就绪'); }
    }
  } catch (e) {
    setUpdateButton('检查更新', false);
    if (!silent) { toast('检查更新失败：' + errText(e)); setStatus('检查更新失败'); }
  } finally {
    upd.busy = false;
    btn.disabled = false;
  }
}

async function downloadUpdate() {
  const action = $('#btnUpdateAction');
  if (upd.downloaded) {
    action.disabled = true;
    action.textContent = '正在启动…';
    try {
      await window.api.installUpdate();
      $('#updateState').textContent = '安装程序已启动，应用即将退出。';
    } catch (e) {
      action.disabled = false;
      action.textContent = '立即安装';
      $('#updateState').textContent = '启动安装程序失败：' + errText(e);
    }
    return;
  }
  if (!upd.info) return;
  action.disabled = true;
  action.textContent = '正在下载…';
  $('#updateProgressWrap').classList.remove('hidden');
  $('#updateProgressBar').style.width = '0%';
  $('#updateState').textContent = upd.info.size ? `准备下载 ${fmt(upd.info.size)}` : '准备下载';
  try {
    const res = await window.api.downloadUpdate();
    upd.downloaded = res.path;
    $('#updateProgressBar').style.width = '100%';
    $('#updateState').textContent = '下载完成，SHA-256 校验通过';
    action.disabled = false;
    action.textContent = '立即安装';
  } catch (e) {
    action.disabled = false;
    action.textContent = '重试下载';
    $('#updateState').textContent = '下载失败：' + errText(e);
  }
}

$('#btnUpdate').onclick = () => {
  if (upd.info && upd.info.available) showUpdate(upd.info);
  else checkUpdate(false);
};
$('#btnUpdateLater').onclick = closeUpdate;
$('#updateModal').addEventListener('click', (e) => { if (e.target.id === 'updateModal') closeUpdate(); });
$('#btnUpdateAction').onclick = downloadUpdate;

window.api.onUpdateProgress((p) => {
  if (!p || !p.total) return;
  const pct = Math.max(0, Math.min(100, Math.round((p.received / p.total) * 100)));
  $('#updateProgressBar').style.width = pct + '%';
  $('#updateState').textContent = `已下载 ${fmt(p.received)} / ${fmt(p.total)}（${pct}%）`;
});

window.api.onUpdateAvailable((info) => {
  upd.info = info;
  setUpdateButton(`发现 v${info.version}，点击更新`, true);
  toast(`发现新版本 v${info.version}`);
});

window.api.appVersion().then((r) => { $('#appVersion').textContent = `v${r.version}`; }).catch(() => {});

window.__apSelect = select;
window.__apRefresh = refresh;

refresh().then(() => {
  if (state.items.length) select(state.items[0].id, false);
});
