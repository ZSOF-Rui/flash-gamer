const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../package.json');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = path.resolve(arg('dir', 'release'));
const version = String(arg('version', pkg.version)).replace(/^v/, '');
const tag = arg('tag', `v${version}`);
const outDir = path.resolve(arg('out', 'site/updates'));
const repo = arg('repo', 'ZSOF-Rui/flash-gamer');
const baseUrl = arg('base-url', `https://github.com/${repo}/releases/download/${tag}`);
const publishedAt = arg('published-at', new Date().toISOString().slice(0, 10));
const notesFile = arg('notes-file', '');
const requireAll = process.argv.includes('--require-all');

const channels = {
  'win-x64': {},
  'win-ia32': {},
  'mac-x64': {},
  'mac-arm64': {}
};

function classify(file) {
  const m = /^FlashGamer-[\d.]+-(win|mac)-(x64|ia32|arm64)(?:-(setup))?\.(exe|zip|dmg)$/i.exec(file);
  if (!m) return null;
  const channel = `${m[1].toLowerCase()}-${m[2].toLowerCase()}`;
  if (!channels[channel]) return null;
  let key = '';
  if (m[4].toLowerCase() === 'exe' && m[3]) key = 'setup';
  else if (m[4].toLowerCase() === 'zip') key = channel.startsWith('win-') ? 'portable' : 'zip';
  else if (m[4].toLowerCase() === 'dmg') key = 'dmg';
  return key ? { channel, key } : null;
}

function digest(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
    input.on('error', reject);
  });
}

async function main() {
  if (!fs.existsSync(dir)) throw new Error(`产物目录不存在：${dir}`);
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  for (const file of files) {
    const hit = classify(file);
    if (!hit) continue;
    const full = path.join(dir, file);
    const asset = {
      url: `${baseUrl}/${encodeURIComponent(file)}`,
      size: fs.statSync(full).size,
      sha256: await digest(full)
    };
    channels[hit.channel][hit.key] = asset;
    console.log(`${hit.channel} ${hit.key}: ${file} ${asset.size} B ${asset.sha256}`);
  }

  const notesSource = notesFile && fs.existsSync(path.resolve(notesFile))
    ? fs.readFileSync(path.resolve(notesFile), 'utf8').trim()
    : `Flash Gamer v${version} 多平台版本。`;
  const notes = notesSource
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '· ').trim())
    .filter(Boolean)
    .join('\n');

  fs.mkdirSync(outDir, { recursive: true });
  const missing = Object.entries(channels).filter(([, assets]) => !Object.keys(assets).length);
  if (requireAll && missing.length) {
    throw new Error(`缺少产物渠道：${missing.map(([channel]) => channel).join('、')}`);
  }
  let written = 0;
  for (const [channel, assets] of Object.entries(channels)) {
    if (!Object.keys(assets).length) {
      console.warn(`跳过 ${channel}：没有找到产物`);
      continue;
    }
    const manifest = { version, publishedAt, notes, assets };
    fs.writeFileSync(path.join(outDir, `${channel}.json`), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    written++;
  }
  if (!written) throw new Error('没有生成任何更新清单');
  console.log(`写入 ${written} 个清单到 ${outDir}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
