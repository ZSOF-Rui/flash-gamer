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

  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = document.querySelector(`.hash[data-hash="${btn.dataset.copy}"]`);
      if (!code) return;
      const text = code.textContent.trim();
      if (!text || text === '构建后填写') return;
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
})();
