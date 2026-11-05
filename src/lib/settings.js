const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./util');

const FILE_NAME = 'settings.json';

function settingsPath(dataDir) {
  return path.join(dataDir, FILE_NAME);
}

function loadSettings(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8'));
    return {
      libraryDir: typeof raw.libraryDir === 'string' ? raw.libraryDir.trim() : ''
    };
  } catch {
    return { libraryDir: '' };
  }
}

function saveSettings(dataDir, settings) {
  const file = settingsPath(dataDir);
  const tmp = `${file}.tmp`;
  ensureDir(dataDir);
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function isWritableDir(dir) {
  try {
    ensureDir(dir);
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function isInside(parent, child) {
  const norm = (p) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const p = norm(parent);
  const c = norm(child);
  return c.startsWith(p.endsWith(path.sep) ? p : `${p}${path.sep}`);
}

module.exports = { settingsPath, loadSettings, saveSettings, isWritableDir, isInside };
