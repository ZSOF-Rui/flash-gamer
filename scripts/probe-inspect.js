const { app } = require('electron');
app.on('window-all-closed', () => {});
const path = require('path');
const { inspectPage } = require('../src/lib/inspector');

app.whenReady().then(async () => {
  const url = process.env.URL || 'https://www.4399.com/flash/10802.htm';
  console.log('PROBE start', url);
  try {
    const r = await inspectPage({
      pageUrl: url,
      tmpDir: path.join(__dirname, '..', 'data', 'tmp'),
      onProgress: (m) => console.log('[progress]', JSON.stringify(m))
    });
    console.log('PROBE result', JSON.stringify({
      title: r.title,
      h5: r.hasH5,
      cover: r.coverUrl,
      w: r.width,
      h: r.height,
      candidates: r.candidates.map((c) => ({ url: c.url, size: c.size, via: c.via, temp: !!c.tempFile }))
    }, null, 2));
  } catch (e) {
    console.error('PROBE error', e && e.stack || e);
  }
  setTimeout(() => app.exit(0), 300);
});
