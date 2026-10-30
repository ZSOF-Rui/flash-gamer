const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./util');

class Library {
  constructor(root) {
    this.root = ensureDir(root);
    this.itemsDir = ensureDir(path.join(this.root, 'items'));
    this.dbPath = path.join(this.root, 'library.json');
    this.items = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  _save() {
    const tmp = `${this.dbPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8');
    fs.renameSync(tmp, this.dbPath);
  }

  list() {
    return [...this.items].sort((a, b) => (b.playedAt || b.addedAt) - (a.playedAt || a.addedAt));
  }

  get(id) {
    return this.items.find((it) => it.id === id) || null;
  }

  itemDir(id) {
    return path.join(this.itemsDir, id);
  }

  add(item) {
    ensureDir(this.itemDir(item.id));
    this.items.push(item);
    this._save();
    return item;
  }

  update(id, patch) {
    const item = this.get(id);
    if (!item) return null;
    Object.assign(item, patch);
    this._save();
    return item;
  }

  remove(id) {
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    this._save();
    fs.rmSync(this.itemDir(id), { recursive: true, force: true });
    return true;
  }

  cacheDir(id) {
    return ensureDir(path.join(this.itemDir(id), 'cache'));
  }

  cacheStats(id) {
    const dir = path.join(this.itemDir(id), 'cache');
    let bytes = 0;
    let count = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.meta.json')) continue;
        const st = fs.statSync(path.join(dir, f));
        if (st.isFile()) { bytes += st.size; count++; }
      }
    } catch {}
    return { bytes, count };
  }
}

module.exports = Library;
