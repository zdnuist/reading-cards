/**
 * 本地 SQLite 数据层（Node 内置 node:sqlite，零第三方依赖）
 * 数据文件：data/reading.db
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = __dirname;
export const DATA_DIR = path.join(__dirname, 'data');
export const DB_FILE = path.join(DATA_DIR, 'reading.db');

let _db = null;

export function getDb() {
  if (_db) return _db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new DatabaseSync(DB_FILE);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  migrate(_db);
  return _db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    book_id          TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    author           TEXT,
    cover            TEXT,
    category         TEXT,
    finish_reading   INTEGER DEFAULT 0,
    read_update_time INTEGER,
    reader_link      TEXT,
    source           TEXT DEFAULT 'weread',
    note_count       INTEGER DEFAULT 0,
    review_count     INTEGER DEFAULT 0,
    bookmark_count   INTEGER DEFAULT 0,
    synced_at        INTEGER
  );

  CREATE TABLE IF NOT EXISTS highlights (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    bookmark_id  TEXT UNIQUE,
    book_id      TEXT NOT NULL,
    chapter_uid  INTEGER,
    chapter_title TEXT,
    mark_text    TEXT NOT NULL,
    create_time  INTEGER,
    color_style  INTEGER,
    source       TEXT DEFAULT 'my',
    popularity   INTEGER DEFAULT 0,
    synced_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_hl_book ON highlights(book_id);
  CREATE INDEX IF NOT EXISTS idx_hl_src  ON highlights(source);

  CREATE TABLE IF NOT EXISTS thoughts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id   TEXT UNIQUE,
    book_id     TEXT NOT NULL,
    content     TEXT,
    abstract    TEXT,
    chapter_name TEXT,
    chapter_uid INTEGER,
    create_time INTEGER,
    star        INTEGER,
    kind        TEXT,
    synced_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_th_book ON thoughts(book_id);

  -- 用户在网站上新增的感悟 / 行动结果
  CREATE TABLE IF NOT EXISTS insights (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL DEFAULT 'highlight',
    target_id  INTEGER NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'insight',
    content    TEXT NOT NULL,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ins_target ON insights(target_type, target_id);
  CREATE INDEX IF NOT EXISTS idx_ins_time   ON insights(created_at DESC);

  CREATE TABLE IF NOT EXISTS likes (
    target_type TEXT NOT NULL,
    target_id   INTEGER NOT NULL,
    created_at  INTEGER,
    PRIMARY KEY (target_type, target_id)
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,
    target_id   INTEGER NOT NULL,
    note        TEXT,
    created_at  INTEGER,
    UNIQUE (target_type, target_id)
  );
  CREATE INDEX IF NOT EXISTS idx_fav_time ON favorites(created_at DESC);

  -- 间隔复习调度（简化 SM-2）
  CREATE TABLE IF NOT EXISTS reviews (
    target_type   TEXT NOT NULL,
    target_id     INTEGER NOT NULL,
    stage         INTEGER DEFAULT 0,
    due_date      TEXT,
    last_reviewed TEXT,
    review_count  INTEGER DEFAULT 0,
    PRIMARY KEY (target_type, target_id)
  );
  CREATE INDEX IF NOT EXISTS idx_rev_due ON reviews(due_date);

  -- 每一次复习事件（用于统计回忆成功率与留存曲线，reviews 表只存当前状态）
  CREATE TABLE IF NOT EXISTS review_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,
    target_id   INTEGER NOT NULL,
    quality     INTEGER NOT NULL,
    day         TEXT NOT NULL,
    created_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_rl_day ON review_log(day);
  CREATE INDEX IF NOT EXISTS idx_rl_target ON review_log(target_type, target_id);

  -- 每日卡片（按日期确定性生成，保证当天稳定）
  CREATE TABLE IF NOT EXISTS daily_pick (
    day          TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    highlight_id INTEGER NOT NULL,
    PRIMARY KEY (day, seq)
  );

  CREATE TABLE IF NOT EXISTS checkin (
    day        TEXT PRIMARY KEY,
    cards_done INTEGER DEFAULT 0,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
  );

  -- 主题聚类结果（由 topics.js 计算后落库，重建时整表替换）
  CREATE TABLE IF NOT EXISTS topics (
    id         INTEGER PRIMARY KEY,
    label      TEXT,
    words      TEXT,
    card_count INTEGER DEFAULT 0,
    book_count INTEGER DEFAULT 0,
    sample_ids TEXT,
    built_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS highlight_topics (
    highlight_id INTEGER PRIMARY KEY,
    topic_id     INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ht_topic ON highlight_topics(topic_id);
  `);
}

/* ---------------- 通用小工具 ---------------- */

export function now() { return Date.now(); }

export function getMeta(k, dflt = null) {
  const row = getDb().prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return row ? row.v : dflt;
}
export function setMeta(k, v) {
  getDb().prepare('INSERT INTO meta(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
}

export function upsertBook(b) {
  getDb().prepare(`
    INSERT INTO books (book_id,title,author,cover,category,finish_reading,read_update_time,reader_link,source,note_count,review_count,bookmark_count,synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(book_id) DO UPDATE SET
      title=excluded.title, author=excluded.author, cover=excluded.cover, category=excluded.category,
      finish_reading=excluded.finish_reading, read_update_time=excluded.read_update_time,
      reader_link=excluded.reader_link, note_count=excluded.note_count,
      review_count=excluded.review_count, bookmark_count=excluded.bookmark_count, synced_at=excluded.synced_at
  `).run(
    b.bookId, b.title, b.author || '', b.cover || '', b.category || '',
    b.finishReading || 0, b.readUpdateTime || 0, b.readerLink || '', b.source || 'weread',
    b.noteCount || 0, b.reviewCount || 0, b.bookmarkCount || 0, now()
  );
}

export function upsertHighlight(h) {
  getDb().prepare(`
    INSERT INTO highlights (bookmark_id,book_id,chapter_uid,chapter_title,mark_text,create_time,color_style,source,popularity,synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(bookmark_id) DO UPDATE SET
      book_id=excluded.book_id, chapter_uid=excluded.chapter_uid, chapter_title=excluded.chapter_title,
      mark_text=excluded.mark_text, create_time=excluded.create_time, color_style=excluded.color_style,
      popularity=excluded.popularity, synced_at=excluded.synced_at
  `).run(
    h.bookmarkId, h.bookId, h.chapterUid || 0, h.chapterTitle || '',
    h.markText, h.createTime || 0, h.colorStyle || 0, h.source || 'my', h.popularity || 0, now()
  );
}

export function upsertThought(t) {
  getDb().prepare(`
    INSERT INTO thoughts (review_id,book_id,content,abstract,chapter_name,chapter_uid,create_time,star,kind,synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(review_id) DO UPDATE SET
      content=excluded.content, abstract=excluded.abstract, chapter_name=excluded.chapter_name,
      chapter_uid=excluded.chapter_uid, create_time=excluded.create_time, star=excluded.star,
      kind=excluded.kind, synced_at=excluded.synced_at
  `).run(
    t.reviewId, t.bookId, t.content || '', t.abstract || '', t.chapterName || '',
    t.chapterUid || 0, t.createTime || 0, t.star ?? -1, t.kind || '', now()
  );
}

/* ---------------- 日期与随机 ---------------- */

export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return todayStr(d);
}

/** 字符串 -> 32 位整数种子 */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：给定种子的确定性 PRNG */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 确定性洗牌（不改变原数组） */
export function seededShuffle(arr, seed) {
  const a = arr.slice();
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 间隔复习：stage -> 间隔天数 */
export const INTERVALS = [1, 2, 4, 7, 15, 30, 60];
