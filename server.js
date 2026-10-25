/**
 * 「流动的书」阅读复习助手 —— 本地服务
 * 零第三方依赖：node:http + node:sqlite
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getDb, todayStr, addDays, hashSeed, seededShuffle, INTERVALS, now, getMeta, setMeta,
} from './db.js';
import { runSync, syncState, stats } from './weread.js';
import { buildTopics } from './topics.js';
import { autoBackup, createBackup, pruneBackups, listBackups, exportUserData, BACKUP_DIR } from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// 极简 .env 读取（部署时更方便；已存在的环境变量优先）
(() => {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
})();

const PORT = Number(process.env.PORT || 4321);

const db = () => getDb();

/* ================= 查询构造 ================= */

const CARD_SELECT = `
  SELECT h.id, h.book_id, h.chapter_title, h.mark_text, h.create_time, h.source, h.popularity,
         b.title AS book_title, b.author, b.cover, b.category, b.finish_reading, b.reader_link,
         (SELECT COUNT(*) FROM thoughts t WHERE t.book_id = h.book_id) AS book_thought_count,
         (SELECT COUNT(*) FROM highlights x WHERE x.book_id = h.book_id) AS book_highlight_count,
         EXISTS(SELECT 1 FROM likes l WHERE l.target_type='highlight' AND l.target_id=h.id) AS liked,
         EXISTS(SELECT 1 FROM favorites f WHERE f.target_type='highlight' AND f.target_id=h.id) AS favorited,
         (SELECT COUNT(*) FROM insights i WHERE i.target_type='highlight' AND i.target_id=h.id) AS insight_count,
         (SELECT ht.topic_id FROM highlight_topics ht WHERE ht.highlight_id = h.id) AS topic_id,
         (SELECT tp.label FROM topics tp JOIN highlight_topics ht2 ON ht2.topic_id = tp.id
          WHERE ht2.highlight_id = h.id) AS topic_label,
         r.stage AS review_stage, r.due_date AS review_due, r.review_count
  FROM highlights h
  LEFT JOIN books b ON b.book_id = h.book_id
  LEFT JOIN reviews r ON r.target_type='highlight' AND r.target_id = h.id
`;

function getCards(ids) {
  const out = [];
  for (const id of ids) {
    const row = db().prepare(CARD_SELECT + ' WHERE h.id = ?').get(id);
    if (row) out.push(row);
  }
  return out;
}

/** 可作为卡片素材的池子 */
const POOL_WHERE = `h.source IN ('my','manual') AND LENGTH(h.mark_text) BETWEEN 12 AND 320`;

function poolIds(bookId) {
  let sql = `SELECT h.id FROM highlights h WHERE ${POOL_WHERE}`;
  const p = [];
  if (bookId) { sql += ' AND h.book_id = ?'; p.push(bookId); }
  sql += ' ORDER BY h.id';
  return db().prepare(sql).all(...p).map((r) => r.id);
}

/** 今日卡片：按日期确定性生成并落库，保证当天稳定；优先插入到期复习的卡片 */
function dailyIds(day, n) {
  const exist = db().prepare('SELECT highlight_id id FROM daily_pick WHERE day=? ORDER BY seq').all(day);
  if (exist.length) return exist.map((r) => r.id);

  const picked = [];
  const seen = new Set();

  const due = db()
    .prepare('SELECT target_id id FROM reviews WHERE due_date IS NOT NULL AND due_date <= ? ORDER BY due_date')
    .all(day);
  const dueQuota = Math.max(0, Math.min(due.length, Math.ceil(n / 2)));
  for (let i = 0; i < dueQuota; i++) {
    const id = due[i].id;
    if (!seen.has(id)) { seen.add(id); picked.push(id); }
  }

  const rnd = seededShuffle(poolIds(), hashSeed(day + '::flow::book'));
  for (const id of rnd) {
    if (picked.length >= n) break;
    if (!seen.has(id)) { seen.add(id); picked.push(id); }
  }

  const ins = db().prepare('INSERT OR REPLACE INTO daily_pick(day, seq, highlight_id) VALUES (?,?,?)');
  picked.forEach((id, i) => ins.run(day, i, id));
  return picked;
}

function randomIds(n, exclude = [], bookId = null) {
  const ids = poolIds(bookId).filter((id) => !exclude.includes(id));
  const rnd = seededShuffle(ids, hashSeed(String(Date.now()) + '|' + Math.random()));
  return rnd.slice(0, n);
}

/* ================= 主题聚类 ================= */

/** 重新聚类全部卡片并落库（约 1 秒，仅几千条卡片时可直接同步执行） */
function rebuildTopics() {
  const rows = db()
    .prepare(`SELECT h.id, h.mark_text text, h.book_id FROM highlights h WHERE ${POOL_WHERE}`)
    .all();
  const { topics, assign } = buildTopics(rows);
  if (!topics.length) return 0;

  const t = now();
  db().exec('DELETE FROM topics; DELETE FROM highlight_topics;');
  const insT = db().prepare(
    'INSERT INTO topics (id,label,words,card_count,book_count,sample_ids,built_at) VALUES (?,?,?,?,?,?,?)'
  );
  const insH = db().prepare('INSERT OR REPLACE INTO highlight_topics (highlight_id,topic_id) VALUES (?,?)');
  topics.forEach((tp, i) => {
    insT.run(i, tp.label, JSON.stringify(tp.words), tp.size, tp.bookCount, JSON.stringify(tp.sampleIds), t);
  });
  for (const [hid, ti] of assign) insH.run(hid, ti);
  setMeta('topics_built_at', t);
  return topics.length;
}

function ensureTopics() {
  if (!db().prepare('SELECT COUNT(*) c FROM topics').get().c) rebuildTopics();
}

function topicListPayload() {
  const list = db().prepare('SELECT * FROM topics ORDER BY card_count DESC').all();
  const ids = [];
  for (const t of list) for (const i of JSON.parse(t.sample_ids || '[]').slice(0, 2)) ids.push(i);
  const cards = ids.length
    ? db().prepare(`SELECT h.id, h.mark_text, h.book_id, b.title, b.author FROM highlights h
                    LEFT JOIN books b ON b.book_id = h.book_id
                    WHERE h.id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : [];
  const cmap = new Map(cards.map((c) => [c.id, c]));
  return {
    builtAt: Number(getMeta('topics_built_at', 0)),
    topics: list.map((t) => ({
      id: t.id,
      label: t.label,
      words: JSON.parse(t.words || '[]'),
      cardCount: t.card_count,
      bookCount: t.book_count,
      samples: JSON.parse(t.sample_ids || '[]').slice(0, 2).map((i) => cmap.get(i)).filter(Boolean),
    })),
  };
}

/* ================= 业务操作 ================= */

function applyReview(targetType, targetId, quality) {
  const today = todayStr();
  const row = db().prepare('SELECT stage FROM reviews WHERE target_type=? AND target_id=?').get(targetType, targetId);
  let stage = row ? row.stage : 0;
  if (quality === 0) stage = 0;
  else if (quality === 1) stage = Math.min(stage + 1, INTERVALS.length - 1);
  else stage = Math.min(stage + 2, INTERVALS.length - 1);

  const interval = INTERVALS[stage];
  const due = quality === 0 ? addDays(today, 1) : addDays(today, interval);
  db().prepare(`
    INSERT INTO reviews (target_type,target_id,stage,due_date,last_reviewed,review_count)
    VALUES (?,?,?,?,?,1)
    ON CONFLICT(target_type,target_id) DO UPDATE SET
      stage=?, due_date=?, last_reviewed=?, review_count=review_count+1
  `).run(targetType, targetId, stage, due, today, stage, due, today);
  return { stage, due_date: due, interval };
}

function streakDays() {
  const rows = db().prepare('SELECT day FROM checkin ORDER BY day DESC LIMIT 400').all().map((r) => r.day);
  if (!rows.length) return { streak: 0, total: 0, todayDone: false };
  const set = new Set(rows);
  let streak = 0;
  let cursor = todayStr();
  if (!set.has(cursor)) cursor = addDays(cursor, -1); // 今天还没打卡时，从昨天往前算
  while (set.has(cursor)) { streak++; cursor = addDays(cursor, -1); }
  return { streak, total: rows.length, todayDone: set.has(todayStr()) };
}

/* ================= 路由 ================= */

const routes = {
  /* ---- 概览 ---- */
  'GET /api/stats': async () => {
    const s = stats();
    const st = streakDays();
    const due = db().prepare('SELECT COUNT(*) c FROM reviews WHERE due_date <= ?').get(todayStr()).c || 0;
    return {
      ...s, ...st, due,
      keyConfigured: !!process.env.WEREAD_API_KEY,
      lastBackupAt: Number(getMeta('last_backup_at', 0)),
    };
  },

  /* ---- 同步 ---- */
  // 注意：状态对象里不能出现名为 error 的字段。
  // 前端 api() 把任何 error 字段都当成请求失败而抛错，会导致轮询回调每次抛异常、
  // 定时器永远不清除，同步失败时界面卡在「同步中」。所以这里改名成 syncError。
  'GET /api/sync/status': async () => {
    const { error, ...rest } = syncState;
    return { ...rest, syncError: error };
  },
  'POST /api/sync': async ({ body }) => {
    if (syncState.running) {
      const { error, ...rest } = syncState;
      return { started: false, ...rest, syncError: error };
    }
    const limit = Number(body.limit || 0);
    const includeShelf = body.includeShelf !== false;
    runSync({ limit, includeShelf }); // 后台跑，不阻塞响应
    return { started: true };
  },

  /* ---- 卡片 ---- */
  'GET /api/cards/daily': async ({ q }) => {
    const n = Math.max(1, Math.min(20, Number(q.n || 5)));
    const day = q.day || todayStr();
    const ids = dailyIds(day, n);
    return { day, cards: getCards(ids) };
  },

  'GET /api/cards/random': async ({ q }) => {
    const n = Math.max(1, Math.min(20, Number(q.n || 5)));
    const exclude = (q.exclude || '').split(',').filter(Boolean).map(Number);
    const ids = randomIds(n, exclude, q.book_id || null);
    return { cards: getCards(ids) };
  },

  'GET /api/cards/library': async ({ q }) => {
    const page = Math.max(1, Number(q.page || 1));
    const size = Math.max(1, Math.min(60, Number(q.size || 24)));
    const where = [POOL_WHERE];
    const params = [];
    if (q.book_id) { where.push('h.book_id = ?'); params.push(q.book_id); }
    if (q.q) { where.push('(h.mark_text LIKE ? OR b.title LIKE ? OR b.author LIKE ?)'); const k = `%${q.q}%`; params.push(k, k, k); }
    if (q.favorited === '1') where.push(`EXISTS(SELECT 1 FROM favorites f WHERE f.target_type='highlight' AND f.target_id=h.id)`);
    if (q.liked === '1') where.push(`EXISTS(SELECT 1 FROM likes l WHERE l.target_type='highlight' AND l.target_id=h.id)`);
    const w = where.join(' AND ');
    const total = db().prepare(`SELECT COUNT(*) c FROM highlights h LEFT JOIN books b ON b.book_id=h.book_id WHERE ${w}`).get(...params).c || 0;
    const rows = db()
      .prepare(`${CARD_SELECT} WHERE ${w} ORDER BY h.create_time DESC LIMIT ? OFFSET ?`)
      .all(...params, size, (page - 1) * size);
    return { total, page, size, cards: rows };
  },

  'GET /api/cards/detail': async ({ q }) => {
    const id = Number(q.id);
    const card = db().prepare(CARD_SELECT + ' WHERE h.id = ?').get(id);
    if (!card) return { error: '卡片不存在' };

    const book = db().prepare('SELECT * FROM books WHERE book_id = ?').get(card.book_id) || null;

    // 微信读书里这本书的想法
    const thoughts = db()
      .prepare('SELECT id,content,abstract,chapter_name,chapter_uid,create_time,star,kind FROM thoughts WHERE book_id=? ORDER BY create_time DESC LIMIT 20')
      .all(card.book_id);

    // 与该划线对应的想法：精确匹配 → 片段包含 → 同章节
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    const mark = norm(card.mark_text);
    let matched = null;
    let matchLevel = '';
    for (const t of thoughts) {
      const ab = norm(t.abstract);
      if (ab && (ab === mark || (ab.length > 24 && mark.includes(ab)) || (mark.length > 24 && ab.includes(mark)))) {
        matched = t; matchLevel = 'exact'; break;
      }
    }
    if (!matched && card.chapter_title) {
      const t = thoughts.find((x) => x.chapter_name && x.chapter_name === card.chapter_title);
      if (t) { matched = t; matchLevel = 'chapter'; }
    }

    const insights = db()
      .prepare('SELECT * FROM insights WHERE target_type=? AND target_id=? ORDER BY created_at DESC')
      .all('highlight', id);

    const fav = db().prepare('SELECT note, created_at FROM favorites WHERE target_type=? AND target_id=?').get('highlight', id) || null;

    return { card, book, thoughts, matchedThought: matched, matchLevel, insights, favorite: fav };
  },

  'GET /api/due': async ({ q }) => {
    const day = todayStr();
    const rows = db()
      .prepare('SELECT target_id id, stage, due_date, review_count FROM reviews WHERE due_date <= ? ORDER BY due_date LIMIT ?')
      .all(day, Math.max(1, Math.min(50, Number(q.n || 10))));
    return { cards: getCards(rows.map((r) => r.id)), meta: rows };
  },

  /* ---- 感悟 ---- */
  'POST /api/insights': async ({ body }) => {
    const { target_type = 'highlight', target_id, kind = 'insight', content } = body || {};
    if (!target_id || !content || !String(content).trim()) return { error: '缺少内容' };
    const t = now();
    const r = db()
      .prepare('INSERT INTO insights (target_type,target_id,kind,content,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(target_type, Number(target_id), kind === 'action' ? 'action' : 'insight', String(content).trim(), t, t);
    return { ok: true, id: r.lastInsertRowid };
  },

  'PUT /api/insights': async ({ body }) => {
    if (!body?.id || !body?.content) return { error: '参数不足' };
    db().prepare('UPDATE insights SET content=?, updated_at=? WHERE id=?')
      .run(String(body.content).trim(), now(), Number(body.id));
    return { ok: true };
  },

  'DELETE /api/insights': async ({ body }) => {
    if (!body?.id) return { error: '参数不足' };
    db().prepare('DELETE FROM insights WHERE id=?').run(Number(body.id));
    return { ok: true };
  },

  'GET /api/insights/all': async ({ q }) => {
    const size = Math.max(1, Math.min(200, Number(q.size || 100)));
    const rows = db().prepare(`
      SELECT i.*, h.mark_text, b.title AS book_title, b.author, b.cover
      FROM insights i
      LEFT JOIN highlights h ON h.id = i.target_id
      LEFT JOIN books b ON b.book_id = h.book_id
      ORDER BY i.created_at DESC LIMIT ?
    `).all(size);
    return { items: rows };
  },

  /* ---- 点赞 / 收藏 ---- */
  'POST /api/likes': async ({ body }) => {
    const { target_type = 'highlight', target_id, liked } = body || {};
    const tid = Number(target_id);
    if (liked) {
      db().prepare('INSERT OR IGNORE INTO likes (target_type,target_id,created_at) VALUES (?,?,?)').run(target_type, tid, now());
    } else {
      db().prepare('DELETE FROM likes WHERE target_type=? AND target_id=?').run(target_type, tid);
    }
    const c = db().prepare('SELECT COUNT(*) c FROM likes WHERE target_type=? AND target_id=?').get(target_type, tid).c;
    return { ok: true, liked: !!liked, count: c };
  },

  'POST /api/favorites': async ({ body }) => {
    const { target_type = 'highlight', target_id, favorited, note } = body || {};
    const tid = Number(target_id);
    if (favorited) {
      db().prepare(`
        INSERT INTO favorites (target_type,target_id,note,created_at) VALUES (?,?,?,?)
        ON CONFLICT(target_type,target_id) DO UPDATE SET note=COALESCE(excluded.note, favorites.note)
      `).run(target_type, tid, note ? String(note).trim() : null, now());
    } else {
      db().prepare('DELETE FROM favorites WHERE target_type=? AND target_id=?').run(target_type, tid);
    }
    return { ok: true, favorited: !!favorited };
  },

  'GET /api/favorites': async ({ q }) => {
    const size = Math.max(1, Math.min(200, Number(q.size || 100)));
    const rows = db().prepare(`
      SELECT f.note AS fav_note, f.created_at AS fav_at, h.mark_text, h.chapter_title, h.id AS highlight_id,
             b.title AS book_title, b.author, b.cover, b.category
      FROM favorites f
      LEFT JOIN highlights h ON h.id = f.target_id
      LEFT JOIN books b ON b.book_id = h.book_id
      WHERE f.target_type='highlight'
      ORDER BY f.created_at DESC LIMIT ?
    `).all(size);
    return { items: rows };
  },

  /* ---- 数据备份 ---- */
  'GET /api/backups': async () => {
    const list = listBackups();
    return {
      list,
      lastAt: Number(getMeta('last_backup_at', 0)),
      totalSize: list.reduce((a, b) => a + b.size, 0),
      dir: BACKUP_DIR,
    };
  },

  'POST /api/backup': async () => {
    const r = createBackup(true);          // 手动备份总是再存一份
    const dropped = pruneBackups();
    return { ok: true, ...r, dropped };
  },

  'GET /api/export': async () => exportUserData(),

  /* ---- 主题 ---- */
  'GET /api/topics': async () => {
    ensureTopics();
    return topicListPayload();
  },

  'POST /api/topics/build': async () => {
    const n = rebuildTopics();
    return { ok: true, count: n, ...topicListPayload() };
  },

  'GET /api/topics/cards': async ({ q }) => {
    const tid = Number(q.topic);
    const page = Math.max(1, Number(q.page || 1));
    const size = Math.max(1, Math.min(60, Number(q.size || 24)));
    const total = db().prepare('SELECT COUNT(*) c FROM highlight_topics WHERE topic_id=?').get(tid).c || 0;
    const ids = db().prepare(`
      SELECT ht.highlight_id id FROM highlight_topics ht
      JOIN highlights h ON h.id = ht.highlight_id
      WHERE ht.topic_id = ? ORDER BY h.create_time DESC LIMIT ? OFFSET ?
    `).all(tid, size, (page - 1) * size);
    const label = db().prepare('SELECT label FROM topics WHERE id=?').get(tid)?.label || '';
    return { total, page, size, label, cards: getCards(ids.map((r) => r.id)) };
  },

  /* ---- 间隔复习 ---- */
  'POST /api/reviews': async ({ body }) => {
    const { target_type = 'highlight', target_id, quality = 1 } = body || {};
    const tid = Number(target_id), qy = Number(quality);
    const r = applyReview(target_type, tid, qy);
    db().prepare('INSERT INTO review_log (target_type,target_id,quality,day,created_at) VALUES (?,?,?,?,?)')
      .run(target_type, tid, qy, todayStr(), now());
    return { ok: true, ...r };
  },

  /* ---- 成长看板 ---- */
  'GET /api/dashboard': async ({ q }) => {
    const today = todayStr();
    const days = Math.max(7, Math.min(90, Number(q.days || 30)));
    const since = addDays(today, -(days - 1));

    const poolTotal = db().prepare(`SELECT COUNT(*) c FROM highlights h WHERE ${POOL_WHERE}`).get().c || 0;

    const ev = db().prepare('SELECT COUNT(*) n, SUM(CASE WHEN quality>0 THEN 1 ELSE 0 END) ok FROM review_log').get() || {};
    // 首回忆成功率：每张卡片第一次被复习时的表现，最能反映"读完之后还记得多少"
    const first = db().prepare(`
      SELECT COUNT(*) n, SUM(CASE WHEN quality>0 THEN 1 ELSE 0 END) ok FROM review_log l
      WHERE l.created_at = (SELECT MIN(x.created_at) FROM review_log x
                            WHERE x.target_type=l.target_type AND x.target_id=l.target_id)
    `).get() || {};

    const rows = db().prepare('SELECT day, COUNT(*) n, SUM(CASE WHEN quality>0 THEN 1 ELSE 0 END) ok FROM review_log WHERE day>=? GROUP BY day').all(since);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const daily = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(since, i);
      const r = byDay.get(d);
      daily.push({ day: d, n: r ? r.n : 0, ok: r ? (r.ok || 0) : 0 });
    }

    const stageRows = db().prepare('SELECT stage, COUNT(*) c FROM reviews GROUP BY stage').all();
    const stageMap = new Map(stageRows.map((r) => [r.stage, r.c]));
    const reviewed = db().prepare('SELECT COUNT(*) c FROM reviews').get().c || 0;
    const stages = INTERVALS.map((iv, i) => ({
      stage: i, interval: iv, count: stageMap.get(i) || 0, label: `${iv} 天后`,
    })).reverse();

    const mastered = db().prepare('SELECT COUNT(*) c FROM reviews WHERE stage>=?').get(4).c || 0;
    const due = db().prepare('SELECT COUNT(*) c FROM reviews WHERE due_date<=?').get(today).c || 0;
    const todayDone = db().prepare('SELECT COUNT(*) c FROM review_log WHERE day=?').get(today).c || 0;

    const insRows = db().prepare('SELECT kind, COUNT(*) c FROM insights GROUP BY kind').all();
    const insights = insRows.find((r) => r.kind === 'insight')?.c || 0;
    const actions = insRows.find((r) => r.kind === 'action')?.c || 0;
    const insightDays = db().prepare('SELECT COUNT(DISTINCT day) c FROM (SELECT date(created_at/1000,\'unixepoch\',\'localtime\') day FROM insights)').get().c || 0;

    const books = db().prepare(`
      SELECT b.book_id, b.title, b.author, COUNT(*) reviewed,
             SUM(CASE WHEN r.stage>=3 THEN 1 ELSE 0 END) solid
      FROM reviews r
      JOIN highlights h ON h.id = r.target_id
      JOIN books b ON b.book_id = h.book_id
      GROUP BY b.book_id ORDER BY reviewed DESC LIMIT 10
    `).all();

    const dueCards = db()
      .prepare('SELECT target_id id FROM reviews WHERE due_date<=? ORDER BY due_date, review_count DESC LIMIT 6')
      .all(today);

    const st = streakDays();

    return {
      today,
      poolTotal, reviewed, mastered, due, todayDone,
      untouched: Math.max(0, poolTotal - reviewed),
      events: { n: ev.n || 0, ok: ev.ok || 0 },
      firstRecall: { n: first.n || 0, ok: first.ok || 0 },
      daily, stages,
      insights, actions, insightDays,
      books, dueCards: getCards(dueCards.map((r) => r.id)),
      streak: st.streak,
    };
  },

  /* ---- 打卡 ---- */
  'POST /api/checkin': async () => {
    const day = todayStr();
    db().prepare('INSERT INTO checkin (day, cards_done, created_at) VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET cards_done=cards_done+1')
      .run(day, 1, now());
    return { ok: true, ...streakDays() };
  },

  /* ---- 书籍 ---- */
  'GET /api/books': async ({ q }) => {
    const size = Math.max(1, Math.min(200, Number(q.size || 60)));
    const where = [];
    const params = [];
    if (q.q) { where.push('(title LIKE ? OR author LIKE ?)'); const k = `%${q.q}%`; params.push(k, k); }
    if (q.with_notes === '1') where.push('EXISTS(SELECT 1 FROM highlights h WHERE h.book_id = b.book_id)');
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db().prepare(`
      SELECT b.*, (SELECT COUNT(*) FROM highlights h WHERE h.book_id=b.book_id) AS highlight_count,
                  (SELECT COUNT(*) FROM thoughts t WHERE t.book_id=b.book_id) AS thought_count
      FROM books b ${w}
      ORDER BY highlight_count DESC, b.read_update_time DESC LIMIT ?
    `).all(...params, size);
    return { items: rows };
  },

  'POST /api/books': async ({ body }) => {
    const { title, author = '', cover = '', category = '' } = body || {};
    if (!title || !String(title).trim()) return { error: '缺少书名' };
    const bookId = 'manual-' + now() + '-' + Math.random().toString(36).slice(2, 7);
    db().prepare('INSERT INTO books (book_id,title,author,cover,category,source,finish_reading,synced_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(bookId, String(title).trim(), author, cover, category, 'manual', 0, now());
    return { ok: true, book_id: bookId };
  },

  'POST /api/highlights': async ({ body }) => {
    const { book_id, mark_text, chapter_title = '' } = body || {};
    if (!book_id || !mark_text || !String(mark_text).trim()) return { error: '缺少书籍或内容' };
    const bmId = 'manual-' + now() + '-' + Math.random().toString(36).slice(2, 7);
    const r = db()
      .prepare('INSERT INTO highlights (bookmark_id,book_id,chapter_title,mark_text,create_time,source,synced_at) VALUES (?,?,?,?,?,?,?)')
      .run(bmId, book_id, chapter_title, String(mark_text).trim(), now(), 'manual', now());
    return { ok: true, id: r.lastInsertRowid };
  },
};

/* ================= HTTP ================= */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, data) {
  const buf = Buffer.from(JSON.stringify(data), 'utf-8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' });
      return res.end();
    }
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      const q = Object.fromEntries(url.searchParams.entries());

      let key = `${req.method} ${pathname}`;
      let handler = routes[key];

      // 兼容 /api/cards/detail?id=1 之外的路径参数形式
      if (!handler) {
        const m = pathname.match(/^\/api\/insights\/(\d+)$/);
        if (m && req.method === 'DELETE') { handler = routes['DELETE /api/insights']; body.id = Number(m[1]); }
      }
      if (!handler) return sendJSON(res, 404, { error: '接口不存在: ' + key });

      const out = await handler({ body, q, req });
      return sendJSON(res, 200, out);
    } catch (e) {
      return sendJSON(res, 500, { error: String(e && e.message ? e.message : e) });
    }
  }

  // 静态资源
  let file = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  const ext = path.extname(full).toLowerCase();
  const buf = fs.readFileSync(full);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(buf);
});

// 部署时建议 HOST=127.0.0.1，只让反代访问，不把应用端口暴露到公网
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`\n  流动的书 · 阅读复习助手\n  http://localhost:${PORT}\n  数据文件: ${path.join(__dirname, 'data/reading.db')}\n`);
  // 每天启动时自动备份一次：感悟和收藏一旦丢了就找不回来
  try {
    const r = autoBackup();
    if (r.skipped) console.log('  备份：今天已有，跳过\n');
    else console.log(`  备份：${r.name}（${(r.size / 1048576).toFixed(1)} MB）\n`);
  } catch (e) {
    console.log(`  备份失败：${e.message}\n`);
  }
});
