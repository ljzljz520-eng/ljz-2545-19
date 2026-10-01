// 零依赖 JSON 文档存储：写临时文件 + rename 原子替换；所有集合集中在单个 DB 对象。
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(file) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      this.db = JSON.parse(readFileSync(file, 'utf8'));
    } else {
      this.db = {
        persons: [], routes: [], versions: [], markers: [],
        events: [], observations: [], cacheEntries: [], depVersions: [],
        photoFiles: [], attachmentAccess: [],
      };
      this.persist();
    }
  }
  persist() {
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.db));
    renameSync(tmp, this.file);
  }
  all(coll) { return this.db[coll]; }
  find(coll, pred) { return this.db[coll].find(pred); }
  filter(coll, pred) { return this.db[coll].filter(pred); }
  insert(coll, doc) {
    if (!doc.id) doc.id = randomUUID();
    if (!('createdAt' in doc)) doc.createdAt = new Date().toISOString();
    this.db[coll].push(doc);
    this.persist();
    return doc;
  }
  update(coll, id, patch) {
    const doc = this.find(coll, (d) => d.id === id);
    if (!doc) return null;
    Object.assign(doc, patch, { updatedAt: new Date().toISOString() });
    this.persist();
    return doc;
  }
  upsert(coll, pred, doc) {
    const existing = this.find(coll, pred);
    if (existing) return Object.assign(existing, doc);
    this.db[coll].push(doc);
    return doc;
  }
}
