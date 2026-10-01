'use strict';
// JSON 文件持久化（零依赖）。集合：people/routes/events/attachments/audit/cacheMeta
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.REVISIT_DATA || path.join(__dirname, '..', '..', 'data');

class Store {
  constructor(dir = DATA_DIR) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'originals'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
    this.file = path.join(dir, 'db.json');
    this.db = this._load();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {
        people: [],
        routes: [],
        events: [],
        attachments: [],
        audit: [],
        seq: 1
      };
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 1));
    fs.renameSync(tmp, this.file);
  }

  id(prefix) {
    const n = this.db.seq++;
    return `${prefix}_${String(n).padStart(6, '0')}`;
  }

  insert(coll, doc) {
    this.db[coll].push(doc);
    return doc;
  }

  find(coll, pred) { return this.db[coll].find(pred); }
  filter(coll, pred) { return this.db[coll].filter(pred); }
}

module.exports = new Store();
