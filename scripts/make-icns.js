const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'build');
const entries = [
  ['icp4', path.join(root, 'icons', 'icon-16.png')],
  ['icp5', path.join(root, 'icons', 'icon-32.png')],
  ['icp6', path.join(root, 'icons', 'icon-64.png')],
  ['ic07', path.join(root, 'icons', 'icon-128.png')],
  ['ic08', path.join(root, 'icons', 'icon-256.png')],
  ['ic09', path.join(root, 'icons', 'icon-512.png')],
  ['ic10', path.join(root, 'icon-1024.png')],
  ['ic11', path.join(root, 'icons', 'icon-32.png')],
  ['ic12', path.join(root, 'icons', 'icon-64.png')],
  ['ic13', path.join(root, 'icons', 'icon-256.png')],
  ['ic14', path.join(root, 'icons', 'icon-512.png')]
];

const chunks = entries.map(([type, file]) => {
  const png = fs.readFileSync(file);
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} 不是 PNG`);
  const head = Buffer.alloc(8);
  head.write(type, 0, 4, 'ascii');
  head.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([head, png]);
});

const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write('icns', 0, 4, 'ascii');
header.writeUInt32BE(body.length + 8, 4);
const out = path.join(root, 'icon.icns');
fs.writeFileSync(out, Buffer.concat([header, body]));
console.log(`${out} ${body.length + 8} B`);
