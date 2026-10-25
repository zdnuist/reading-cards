/**
 * 本地数据备份 —— 你写下的所有感悟、收藏、复习记录都在这里，必须能救回来。
 *
 * 用 SQLite 的 VACUUM INTO：
 *   - 可以在数据库正被读写时执行，得到一致性快照（WAL 模式下直接拷文件会有风险）
 *   - 顺带做一次整理，备份文件比原库更小
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, DB_FILE, getDb, now, getMeta, setMeta } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = 7;   // 保留最近 7 份

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const pad = (n) => String(n).padStart(2, '0');
const dayStamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function listBackups() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^reading-\d{4}-\d{2}-\d{2}(-\d{6})?\.db$/.test(f))
    .sort().reverse()
    .map((f) => {
      const s = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: s.size, mtime: Math.floor(s.mtimeMs / 1000) };
    });
}

/** @param force true 时即使当天已有备份也再存一份 */
export function createBackup(force = false) {
  ensureDir();
  const d = new Date();
  const day = dayStamp(d);
  const sameDay = listBackups().filter((b) => b.name.startsWith(`reading-${day}`));

  if (sameDay.length && !force) return { ok: true, skipped: true, ...sameDay[0] };

  const name = sameDay.length
    ? `reading-${day}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.db`
    : `reading-${day}.db`;
  const target = path.join(BACKUP_DIR, name);

  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  setMeta('last_backup_at', now());
  const s = fs.statSync(target);
  return { ok: true, skipped: false, name, size: s.size, mtime: Math.floor(s.mtimeMs / 1000) };
}

export function pruneBackups(keep = KEEP) {
  const list = listBackups();
  const drop = list.slice(keep);
  for (const b of drop) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, b.name)); } catch { /* 已删或无权限 */ }
  }
  return drop.length;
}

/** 每天首次调用时自动备份一次，并清理超出保留数的旧备份 */
export function autoBackup() {
  const last = Number(getMeta('last_backup_at', 0));
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  if (last >= today0.getTime()) return { ok: true, skipped: true };
  const r = createBackup(false);
  const dropped = pruneBackups(KEEP);
  return { ...r, dropped };
}

/**
 * 只导出「你自己写的」数据（不含可从微信读书重新同步的 4000 条划线）。
 * 用于迁移、或将来把存储搬到云端。
 */
export function exportUserData() {
  const db = getDb();
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  return {
    format: 'liudongdeshu.userdata.v1',
    exportedAt: now(),
    books: q("SELECT * FROM books WHERE source='manual'"),
    highlights: q("SELECT * FROM highlights WHERE source='manual'"),
    insights: q('SELECT * FROM insights ORDER BY created_at'),
    favorites: q('SELECT * FROM favorites ORDER BY created_at'),
    likes: q('SELECT * FROM likes'),
    reviews: q('SELECT * FROM reviews'),
    reviewLog: q('SELECT * FROM review_log ORDER BY created_at'),
    checkin: q('SELECT * FROM checkin ORDER BY day'),
    // 收藏/感悟对应的划线原文一并带上，避免迁移后卡片变成孤儿
    referencedHighlights: q(`
      SELECT h.*, b.title AS book_title, b.author, b.cover
      FROM highlights h LEFT JOIN books b ON b.book_id = h.book_id
      WHERE h.id IN (SELECT target_id FROM insights)
         OR h.id IN (SELECT target_id FROM favorites)
         OR h.id IN (SELECT target_id FROM likes)
         OR h.id IN (SELECT target_id FROM reviews)
    `),
  };
}
