import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const input = path.join(root, 'scraped');
const output = path.join(root, 'data', 'freewheel.db');
const index = JSON.parse(await fs.readFile(path.join(input, 'index.json'), 'utf8'));

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.rm(output, { force: true });

const db = new DatabaseSync(output);
db.exec(`
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous = OFF;
  CREATE TABLE pages (rowid INTEGER PRIMARY KEY, page_id TEXT UNIQUE, title TEXT, depth INTEGER, url TEXT, file TEXT, version INTEGER, created_at TEXT, bytes_html INTEGER, content TEXT);
  CREATE VIRTUAL TABLE pages_fts USING fts5(page_id, title, file, url, content, tokenize = 'unicode61');
  CREATE INDEX idx_pages_page_id ON pages(page_id);
  CREATE INDEX idx_pages_file ON pages(file);
  CREATE INDEX idx_pages_url ON pages(url);
`);

const insertPage = db.prepare('INSERT INTO pages (rowid, page_id, title, depth, url, file, version, created_at, bytes_html, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const insertFts = db.prepare('INSERT INTO pages_fts (rowid, page_id, title, file, url, content) VALUES (?, ?, ?, ?, ?, ?)');

for (const [rowid, page] of index.pages.entries()) {
  const file = path.join(input, page.file);
  const content = await fs.readFile(file, 'utf8');
  insertPage.run(rowid + 1, page.pageId, page.title, page.depth, page.url ?? null, page.file, page.version ?? null, page.createdAt ?? null, page.bytesHtml ?? null, content);
  insertFts.run(rowid + 1, page.pageId, page.title, page.file, page.url ?? null, content);
}

db.exec(`CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN INSERT INTO pages_fts(rowid, page_id, title, file, url, content) VALUES (new.rowid, new.page_id, new.title, new.file, new.url, new.content); END;`);
db.exec(`CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN DELETE FROM pages_fts WHERE rowid = old.rowid; END;`);
db.exec(`CREATE TRIGGER pages_au AFTER UPDATE ON pages BEGIN UPDATE pages_fts SET page_id = new.page_id, title = new.title, file = new.file, url = new.url, content = new.content WHERE rowid = old.rowid; END;`);

db.close();

console.log(`Wrote ${output} with ${index.pages.length} pages`);
