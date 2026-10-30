const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

function newId(prefix = 'g') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function isSwf(buf) {
  if (!buf || buf.length < 8) return false;
  const sig = buf.subarray(0, 3).toString('latin1');
  return sig === 'FWS' || sig === 'CWS' || sig === 'ZWS';
}

function humanSize(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function safeFileName(name, fallback = 'game.swf') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function titleFromFileName(file) {
  return path.basename(file, path.extname(file))
    .replace(/[_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || '未命名游戏';
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.swf': 'application/x-shockwave-flash',
    '.wasm': 'application/wasm',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.xml': 'application/xml; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  }[ext] || 'application/octet-stream';
}

module.exports = { ensureDir, sha256, sha1, newId, isSwf, humanSize, safeFileName, titleFromFileName, mimeFor };
