const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', '@ruffle-rs', 'ruffle');
const dst = path.join(__dirname, '..', 'vendor', 'ruffle');

if (!fs.existsSync(src)) {
  console.log('[vendor] @ruffle-rs/ruffle not installed yet, skipping');
  process.exit(0);
}

fs.mkdirSync(dst, { recursive: true });
let copied = 0;
for (const f of fs.readdirSync(src)) {
  if (f.endsWith('.map')) continue;
  const keep = /\.(js|wasm)$/i.test(f) || /^LICENSE/i.test(f) || f === 'README.md';
  if (!keep) continue;
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  copied++;
}
console.log(`[vendor] ruffle -> ${dst} (${copied} files)`);
