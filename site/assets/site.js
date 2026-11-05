(() => {
  const nav = document.getElementById('nav');
  const toggle = document.getElementById('navToggle');

  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });

  const tabs = Array.from(document.querySelectorAll('.platform-tab'));
  const panels = Array.from(document.querySelectorAll('.dl-panel'));

  function selectPlatform(channel) {
    tabs.forEach((tab) => {
      const active = tab.dataset.platform === channel;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.classList.toggle('active', panel.id === `panel-${channel}`);
    });
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectPlatform(tab.dataset.platform));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      selectPlatform(next.dataset.platform);
      next.focus();
    });
  });

  const initialPlatform = location.hash.slice(1);
  if (tabs.some((tab) => tab.dataset.platform === initialPlatform)) {
    selectPlatform(initialPlatform);
  }

  const CHANNELS = ['win-x64', 'win-ia32', 'mac-arm64', 'mac-x64'];
  const SHA256 = /^[a-f0-9]{64}$/i;

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `约 ${(mb / 1024).toFixed(2)} GB`;
    return `约 ${mb.toFixed(1)} MB`;
  }

  function fileName(url) {
    try {
      const clean = String(url).split('?')[0].split('#')[0];
      return decodeURIComponent(clean.slice(clean.lastIndexOf('/') + 1));
    } catch {
      return String(url || '').split('/').pop();
    }
  }

  function compareVersion(a, b) {
    const pa = String(a).replace(/^v/, '').split('.').map(Number);
    const pb = String(b).replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  }

  function paintAsset(key, asset) {
    if (!asset || !asset.url) return;
    document.querySelectorAll(`[data-download="${key}"]`).forEach((a) => {
      a.href = asset.url;
    });
    const file = document.querySelector(`[data-file="${key}"]`);
    if (file) file.textContent = fileName(asset.url);
    document.querySelectorAll(`[data-size="${key}"]`).forEach((el) => {
      const text = formatSize(Number(asset.size));
      if (text) el.textContent = text;
    });
    const hash = document.querySelector(`[data-hash="${key}"]`);
    if (hash) {
      const value = String(asset.sha256 || '').toLowerCase();
      if (SHA256.test(value)) hash.textContent = value;
      else hash.textContent = '暂未提供校验值';
    }
  }

  function paintChannel(channel, manifest) {
    const version = String(manifest.version || '').replace(/^v/, '');
    if (!version) return;
    document.querySelectorAll(`[data-version="${channel}"]`).forEach((el) => {
      el.textContent = `v${version}`;
    });
    const assets = manifest.assets || {};
    Object.keys(assets).forEach((kind) => paintAsset(`${channel}-${kind}`, assets[kind]));
  }

  async function hydrate() {
    const results = await Promise.all(
      CHANNELS.map(async (channel) => {
        try {
          const res = await fetch(`updates/${channel}.json`, { cache: 'no-cache' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return { channel, manifest: await res.json() };
        } catch {
          return { channel, manifest: null };
        }
      })
    );

    let latest = '';
    results.forEach(({ channel, manifest }) => {
      if (!manifest) {
        document.querySelectorAll(`[data-hash^="${channel}-"]`).forEach((el) => {
          el.textContent = '暂时无法读取';
        });
        return;
      }
      paintChannel(channel, manifest);
      if (!latest || compareVersion(manifest.version, latest) > 0) latest = manifest.version;
    });

    if (latest) {
      document.querySelectorAll('[data-latest-version]').forEach((el) => {
        el.textContent = `v${String(latest).replace(/^v/, '')}`;
      });
    }
  }

  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = document.querySelector(`.hash[data-hash="${btn.dataset.copy}"]`);
      if (!code) return;
      const text = code.textContent.trim();
      if (!SHA256.test(text)) return;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '已复制';
        btn.classList.add('done');
        setTimeout(() => {
          btn.textContent = '复制';
          btn.classList.remove('done');
        }, 1800);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  });

  hydrate();
})();
